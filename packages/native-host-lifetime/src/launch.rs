use crate::handle::{identity, in_job, require_outside, Handle, Job, Process};
use crate::pipe;
use crate::{Command, Error, Result};
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::time::Duration;
use windows_sys::Win32::Foundation::GENERIC_WRITE;
use windows_sys::Win32::Security::{
    Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG},
    SECURITY_ATTRIBUTES,
};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::JobObjects::{
    JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
};
use windows_sys::Win32::System::Threading::*;

struct Attributes {
    buffer: Vec<usize>,
    initialized: bool,
}
impl Attributes {
    fn new(handles: &mut [windows_sys::Win32::Foundation::HANDLE]) -> Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 4096 {
            return Err(Error("native-handle-allowlist-unknown"));
        }
        let mut result = Self {
            buffer: vec![0; bytes.div_ceil(size_of::<usize>())],
            initialized: false,
        };
        if unsafe { InitializeProcThreadAttributeList(result.raw(), 1, 0, &mut bytes) } == 0 {
            return Err(Error("native-handle-allowlist-failed"));
        }
        result.initialized = true;
        if unsafe {
            UpdateProcThreadAttribute(
                result.raw(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr() as _,
                size_of_val(handles),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(Error("native-handle-allowlist-failed"));
        }
        Ok(result)
    }
    fn raw(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr() as _
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.raw());
            }
        }
    }
}

pub struct Child {
    pub(crate) process: Process,
    pub(crate) input: Handle,
    pub(crate) output: Handle,
    bootstrap_written: usize,
}
pub(crate) fn challenge_for(process: &Process) -> Result<Vec<u8>> {
    process.revalidate()?;
    if process.exited()? {
        return Err(Error("native-manager-not-live"));
    }
    let mut frame = Vec::from(*b"CNHLv001");
    let mut nonce = [0u8; 32];
    if unsafe {
        BCryptGenRandom(
            null_mut(),
            nonce.as_mut_ptr(),
            nonce.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } < 0
    {
        return Err(Error("native-challenge-unavailable"));
    }
    frame.extend(nonce);
    frame.extend(process.birth.pid.to_le_bytes());
    frame.extend(process.birth.creation_filetime.to_le_bytes());
    let parent = identity(unsafe { GetCurrentProcess() })?;
    frame.extend(parent.pid.to_le_bytes());
    frame.extend(parent.creation_filetime.to_le_bytes());
    Ok(frame)
}
impl Child {
    pub fn process(&self) -> &Process {
        &self.process
    }
    pub fn read_private(&mut self, bytes: usize, timeout: Duration) -> Result<Vec<u8>> {
        pipe::read_exact(self.output.raw(), bytes, timeout)
    }
    /// Fresh-process bootstrap only; streaming stdin needs the eventual adapter.
    pub fn write_bootstrap(&mut self, bytes: &[u8]) -> Result<()> {
        if self.bootstrap_written + bytes.len() > 8192 {
            return Err(Error("native-bootstrap-budget-exceeded"));
        }
        pipe::write_bootstrap(self.input.raw(), bytes)?;
        self.bootstrap_written += bytes.len();
        Ok(())
    }
    pub fn authenticate(mut self, timeout: Duration) -> Result<AuthenticatedManager> {
        let result = (|| {
            self.process.revalidate()?;
            require_outside(self.process.handle.raw())?;
            if self.process.exited()? {
                return Err(Error("native-manager-not-live"));
            }
            let frame = challenge_for(&self.process)?;
            self.write_bootstrap(&frame)?;
            let reply = self.read_private(frame.len(), timeout)?;
            let difference = frame
                .iter()
                .zip(reply.iter())
                .fold(0u8, |all, (a, b)| all | (a ^ b));
            if difference != 0 {
                return Err(Error("native-manager-challenge-mismatch"));
            }
            self.process.revalidate()?;
            require_outside(self.process.handle.raw())?;
            if self.process.exited()? {
                return Err(Error("native-manager-not-live"));
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.process.terminate_owned()?;
            return Err(error);
        }
        Ok(AuthenticatedManager { child: self })
    }
}
/// Cannot be constructed/deserialized from a PID, JSON flag, nonce or environment.
pub struct AuthenticatedManager {
    pub(crate) child: Child,
}

pub(crate) struct Suspended {
    process: Option<Process>,
    thread: Handle,
    input: Option<Handle>,
    output: Option<Handle>,
    resumed: bool,
    #[cfg(test)]
    pub(crate) cleanup_pause: Option<crate::launch_regression::Pause>,
}
impl Suspended {
    pub(crate) fn process(&self) -> &Process {
        self.process.as_ref().unwrap()
    }
    // Borrow only: an error cannot run this child's blocking Drop under a Job lock.
    pub(crate) fn resume_thread(&mut self) -> Result<()> {
        if self.resumed {
            return Err(Error("native-resume-unproven"));
        }
        if unsafe { ResumeThread(self.thread.raw()) } != 1 {
            return Err(Error("native-resume-unproven"));
        }
        self.resumed = true;
        Ok(())
    }
    pub(crate) fn into_child(mut self) -> Result<Child> {
        if !self.resumed {
            return Err(Error("native-resume-unproven"));
        }
        Ok(Child {
            process: self.process.take().unwrap(),
            input: self.input.take().unwrap(),
            output: self.output.take().unwrap(),
            bootstrap_written: 0,
        })
    }
    pub(crate) fn resume(mut self) -> Result<Child> {
        self.resume_thread()?;
        self.into_child()
    }
    #[cfg(test)]
    pub(crate) fn was_resumed(&self) -> bool {
        self.resumed
    }
    #[cfg(test)]
    pub(crate) fn fail_resume(&mut self) -> Result<()> {
        // Remove this exact native thread handle, without closing a reused handle.
        // ResumeThread then fails on a private, signaled event (not a thread).
        self.thread = unsafe { Handle::take(CreateEventW(null(), 1, 1, null()))? };
        Ok(())
    }
}
impl Drop for Suspended {
    fn drop(&mut self) {
        if let Some(process) = &self.process {
            #[cfg(test)]
            if let Some(pause) = self.cleanup_pause.take() {
                pause.wait();
            }
            // Exact just-created native handle, including preflight failure. No PID lookup.
            unsafe {
                TerminateProcess(process.handle.raw(), 1);
                WaitForSingleObject(process.handle.raw(), 5000);
            }
        }
    }
}

pub(crate) fn spawn_suspended(command: &Command, flags: u32) -> Result<Suspended> {
    Ok(spawn_stdio(command, flags, None)?.0)
}
pub(crate) fn spawn_service_suspended(
    command: &Command,
    verbatim: bool,
) -> Result<(Suspended, Handle)> {
    let (pending, stderr) = spawn_stdio(
        command,
        windows_sys::Win32::System::Threading::CREATE_NO_WINDOW,
        Some(verbatim),
    )?;
    Ok((
        pending,
        stderr.ok_or(Error("native-service-stderr-unavailable"))?,
    ))
}
fn spawn_stdio(
    command: &Command,
    flags: u32,
    service: Option<bool>,
) -> Result<(Suspended, Option<Handle>)> {
    let mut prepared = if let Some(verbatim) = service {
        command.prepare_mode(verbatim)?
    } else {
        command.prepare()?
    };
    #[cfg(test)]
    crate::launch_regression::before_create();
    let (child_input, input) = pipe::pair()?;
    let (output, child_output) = pipe::pair()?;
    pipe::no_inherit(&input)?;
    pipe::no_inherit(&output)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let nul: Vec<u16> = "NUL\0".encode_utf16().collect();
    let discard = unsafe {
        Handle::take(CreateFileW(
            nul.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        ))?
    };
    let stderr = if service.is_some() {
        Some(pipe::pair()?)
    } else {
        None
    };
    if let Some((parent, _)) = &stderr {
        pipe::no_inherit(parent)?;
    }
    let stdin_nul = if service.is_some() {
        Some(unsafe {
            Handle::take(CreateFileW(
                nul.as_ptr(),
                windows_sys::Win32::Foundation::GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &attributes,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            ))?
        })
    } else {
        None
    };
    let stdin = stdin_nul.as_ref().unwrap_or(&child_input).raw();
    let err = stderr
        .as_ref()
        .map(|(_, child)| child.raw())
        .unwrap_or(discard.raw());
    let mut inherited = [stdin, child_output.raw(), err];
    let mut list = Attributes::new(&mut inherited)?;
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin;
    startup.StartupInfo.hStdOutput = child_output.raw();
    startup.StartupInfo.hStdError = err;
    startup.lpAttributeList = list.raw();
    let mut result: PROCESS_INFORMATION = unsafe { zeroed() };
    if unsafe {
        CreateProcessW(
            prepared.executable.as_ptr(),
            prepared.line.as_mut_ptr(),
            null(),
            null(),
            1,
            flags
                | CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            prepared.env.as_ptr() as _,
            prepared.directory.as_ptr(),
            &startup.StartupInfo,
            &mut result,
        )
    } == 0
    {
        return Err(Error("native-create-process-failed"));
    }
    let handle = unsafe { Handle::take(result.hProcess)? };
    let thread = match unsafe { Handle::take(result.hThread) } {
        Ok(thread) => thread,
        Err(error) => {
            unsafe {
                TerminateProcess(handle.raw(), 1);
                WaitForSingleObject(handle.raw(), 5000);
            }
            return Err(error);
        }
    };
    let birth = match identity(handle.raw()) {
        Ok(birth) if birth.pid == result.dwProcessId => birth,
        _ => {
            unsafe {
                TerminateProcess(handle.raw(), 1);
                WaitForSingleObject(handle.raw(), 5000);
            }
            return Err(Error("native-process-identity-unknown"));
        }
    };
    Ok((
        Suspended {
            process: Some(Process { handle, birth }),
            thread,
            input: Some(input),
            output: Some(output),
            resumed: false,
            #[cfg(test)]
            cleanup_pause: None,
        },
        stderr.map(|(parent, _)| parent),
    ))
}

pub fn launch_independent(command: &Command) -> Result<Child> {
    let parent = unsafe { GetCurrentProcess() };
    let mut flags = 0;
    if in_job(parent, null_mut())? {
        let limits = Job::limits(null_mut())?;
        if limits & JOB_OBJECT_LIMIT_BREAKAWAY_OK != 0 {
            flags = CREATE_BREAKAWAY_FROM_JOB;
        } else if limits & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK == 0 {
            return Err(Error("native-parent-job-forbids-breakaway"));
        }
    }
    let suspended = spawn_suspended(command, flags)?;
    // Stricter than merely escaping one Job: require NO Job while still suspended.
    // Nested Job unknown/restrictions never trigger retry with weaker flags.
    require_outside(suspended.process().handle.raw())?;
    suspended.resume()
}
