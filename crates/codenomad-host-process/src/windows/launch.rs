use super::Family;
use crate::OwnedProcess;
use std::{
    ffi::{OsStr, c_void},
    io::{self, PipeReader, PipeWriter},
    marker::PhantomData,
    mem::{size_of, size_of_val, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
        process::ExitStatusExt,
    },
    path::{Path, PathBuf},
    process::{Command, ExitStatus},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::{
        DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    },
    System::{
        Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
        Threading::*,
    },
};

pub(crate) struct Process {
    handle: OwnedHandle,
    pid: u32,
    pub stdin: Option<PipeWriter>,
    pub stdout: Option<PipeReader>,
    pub stderr: Option<PipeReader>,
}

impl Process {
    pub fn id(&self) -> u32 {
        self.pid
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.wait_for(0)
    }
    #[cfg(test)]
    pub fn wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.wait_for(INFINITE)
    }

    fn wait_for(&self, timeout: u32) -> io::Result<Option<ExitStatus>> {
        let handle = self.handle.as_raw_handle();
        // SAFETY: the process handle is owned; the exit code is read after the handle signals.
        unsafe {
            match WaitForSingleObject(handle, timeout) {
                WAIT_TIMEOUT => Ok(None),
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    check(GetExitCodeProcess(handle, &mut code))?;
                    Ok(Some(ExitStatus::from_raw(code)))
                }
                _ => Err(io::Error::last_os_error()),
            }
        }
    }
}

pub(crate) fn launch(
    command: &Command,
    started: Option<Box<dyn FnOnce(u32) + '_>>,
    inherit_console: bool,
) -> io::Result<OwnedProcess> {
    let family = Family::new()?;
    let inherit = started.is_some();
    let (stdin, stdout, stderr, handles) = if inherit {
        // SAFETY: duplicate the launcher's live stdio handles without taking ownership of them.
        let handles = unsafe {
            [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE].map(|id| GetStdHandle(id))
        };
        (None, None, None, duplicate_stdio(handles)?)
    } else {
        let (input, stdin) = io::pipe()?;
        let (stdout, output) = io::pipe()?;
        let (stderr, error) = io::pipe()?;
        let handles = duplicate_stdio([
            input.as_raw_handle(),
            output.as_raw_handle(),
            error.as_raw_handle(),
        ])?;
        (Some(stdin), Some(stdout), Some(stderr), handles)
    };
    let flags = (if inherit_console { 0 } else { CREATE_NO_WINDOW })
        | if inherit { CREATE_SUSPENDED } else { 0 };
    let (mut child, thread) = create(command, inherit, &family, &handles, flags)?;
    if let Some(started) = started {
        started(child.id());
        // SAFETY: this is the initial thread of the already job-owned child.
        if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
            return Err(io::Error::last_os_error());
        }
    }
    drop(thread);
    (child.stdin, child.stdout, child.stderr) = (stdin, stdout, stderr);
    Ok(OwnedProcess { child, family })
}

fn duplicate_stdio(handles: [RawHandle; 3]) -> io::Result<[OwnedHandle; 3]> {
    let duplicate = |handle: RawHandle| {
        let null_file = if handle == INVALID_HANDLE_VALUE || handle.is_null() {
            Some(
                std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open("NUL")?,
            )
        } else {
            None
        };
        let handle = null_file
            .as_ref()
            .map_or(handle, AsRawHandle::as_raw_handle);
        // SAFETY: duplicate into the current process and take ownership of the duplicate only.
        unsafe {
            let process = GetCurrentProcess();
            let mut copy = null_mut();
            check(DuplicateHandle(
                process,
                handle,
                process,
                &mut copy,
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            ))?;
            Ok::<_, io::Error>(OwnedHandle::from_raw_handle(copy))
        }
    };
    let [input, output, error] = handles;
    Ok([duplicate(input)?, duplicate(output)?, duplicate(error)?])
}

fn create(
    command: &Command,
    inherit: bool,
    family: &Family,
    handles: &[OwnedHandle; 3],
    flags: u32,
) -> io::Result<(Process, OwnedHandle)> {
    let executable = program(command.get_program(), inherit)?;
    let program = wide(executable.as_os_str())?;
    let cwd = command
        .get_current_dir()
        .map(|p| wide(p.as_os_str()))
        .transpose()?;
    let mut args = Vec::new();
    for arg in std::iter::once(executable.as_os_str()).chain(command.get_args()) {
        if !args.is_empty() {
            args.push(b' '.into());
        }
        quote(&mut args, arg)?;
    }
    args.push(0);
    let env = (!inherit).then(|| environment(command)).transpose()?;
    let streams = handles.each_ref().map(AsRawHandle::as_raw_handle);
    let jobs = [family.handle];
    let mut attrs = Attributes::new()?;
    attrs.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
    attrs.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &streams)?;
    // SAFETY: storage, strings and both attribute values live through CreateProcessW. The job
    // handle is never inherited. Win32 assigns the child before allowing it to execute.
    unsafe {
        let mut startup: STARTUPINFOEXW = zeroed();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        [
            startup.StartupInfo.hStdInput,
            startup.StartupInfo.hStdOutput,
            startup.StartupInfo.hStdError,
        ] = streams;
        startup.lpAttributeList = attrs.ptr();
        let mut info: PROCESS_INFORMATION = zeroed();
        check(CreateProcessW(
            program.as_ptr(),
            args.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | flags,
            env.as_ref().map_or(null(), |env| env.as_ptr().cast()),
            cwd.as_ref().map_or(null(), |cwd| cwd.as_ptr()),
            (&raw const startup).cast::<STARTUPINFOW>(),
            &mut info,
        ))?;
        let child = Process {
            handle: OwnedHandle::from_raw_handle(info.hProcess),
            pid: info.dwProcessId,
            stdin: None,
            stdout: None,
            stderr: None,
        };
        Ok((child, OwnedHandle::from_raw_handle(info.hThread)))
    }
}

struct Attributes<'a> {
    storage: Vec<usize>,
    _values: PhantomData<&'a [HANDLE]>,
}
impl<'a> Attributes<'a> {
    fn new() -> io::Result<Self> {
        let mut bytes = 0;
        // SAFETY: the null call obtains the required size. usize storage provides native alignment.
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
            let mut storage = vec![0; bytes.div_ceil(size_of::<usize>())];
            check(InitializeProcThreadAttributeList(
                storage.as_mut_ptr().cast(),
                2,
                0,
                &mut bytes,
            ))?;
            Ok(Self {
                storage,
                _values: PhantomData,
            })
        }
    }
    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
    fn set(&mut self, key: u32, values: &'a [HANDLE]) -> io::Result<()> {
        // SAFETY: `'a` keeps `values` live for the lifetime of this attribute list; Win32 reads only.
        unsafe {
            check(UpdateProcThreadAttribute(
                self.ptr(),
                0,
                key as usize,
                values.as_ptr().cast_mut().cast::<c_void>(),
                size_of_val(values),
                null_mut(),
                null(),
            ))
        }
    }
}
impl Drop for Attributes<'_> {
    fn drop(&mut self) {
        // SAFETY: successful initialization owns exactly one attribute list in this storage.
        unsafe { DeleteProcThreadAttributeList(self.ptr()) }
    }
}

fn check(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn program(name: &OsStr, search: bool) -> io::Result<PathBuf> {
    let candidate = Path::new(name);
    if candidate.is_absolute() {
        return Ok(candidate.into());
    }
    if search
        && candidate.components().count() == 1
        && let Some(path) = std::env::var_os("PATH")
    {
        for dir in std::env::split_paths(&path).filter(|dir| dir.is_absolute()) {
            let mut file = dir.join(candidate);
            if file.extension().is_none() {
                file.set_extension("exe");
            }
            if file.is_file() {
                return Ok(file);
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "Expected an executable path or fixture command on PATH",
    ))
}

fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut value: Vec<_> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Embedded NUL"));
    }
    value.push(0);
    Ok(value)
}

fn quote(line: &mut Vec<u16>, arg: &OsStr) -> io::Result<()> {
    let value = wide(arg)?;
    const QUOTE: u16 = b'"' as u16;
    const SLASH: u16 = b'\\' as u16;
    line.push(QUOTE);
    let mut slashes = 0;
    for &ch in &value[..value.len() - 1] {
        if ch == SLASH {
            slashes += 1;
            continue;
        }
        line.extend(std::iter::repeat_n(
            SLASH,
            if ch == QUOTE {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        line.push(ch);
        slashes = 0;
    }
    line.extend(std::iter::repeat_n(SLASH, slashes * 2));
    line.push(QUOTE);
    Ok(())
}

fn environment(command: &Command) -> io::Result<Vec<u16>> {
    let mut entries: Vec<_> = command
        .get_envs()
        .filter_map(|(key, value)| Some((key, value?)))
        .collect();
    entries.sort_unstable_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut env = Vec::new();
    for (key, value) in entries {
        let mut pair = key.to_os_string();
        pair.push("=");
        pair.push(value);
        env.extend(wide(&pair)?);
    }
    if env.is_empty() {
        env.push(0);
    }
    env.push(0);
    Ok(env)
}

#[cfg(test)]
mod tests;
