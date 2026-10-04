use crate::{Error, Result};
use std::mem::{size_of, zeroed};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS, FILETIME, HANDLE};
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Threading::*;

pub(crate) struct Handle(pub OwnedHandle);
impl Handle {
    pub(crate) unsafe fn take(raw: HANDLE) -> Result<Self> {
        if raw.is_null() || raw as isize == -1 {
            return Err(Error("native-handle-unavailable"));
        }
        Ok(Self(OwnedHandle::from_raw_handle(raw)))
    }
    pub(crate) fn raw(&self) -> HANDLE {
        self.0.as_raw_handle()
    }
    pub(crate) fn duplicate(&self) -> Result<Self> {
        let mut raw = null_mut();
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                self.raw(),
                GetCurrentProcess(),
                &mut raw,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(Error("native-handle-duplicate-failed"));
        }
        unsafe { Self::take(raw) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub pid: u32,
    pub creation_filetime: u64,
}
pub(crate) fn identity(handle: HANDLE) -> Result<Identity> {
    let (mut created, mut exited, mut kernel, mut user): (FILETIME, FILETIME, FILETIME, FILETIME) =
        unsafe { zeroed() };
    let pid = unsafe { GetProcessId(handle) };
    if pid == 0
        || unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
    {
        return Err(Error("native-process-identity-unknown"));
    }
    let creation_filetime = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
    if creation_filetime == 0 {
        return Err(Error("native-process-identity-unknown"));
    }
    Ok(Identity {
        pid,
        creation_filetime,
    })
}
pub(crate) fn in_job(process: HANDLE, job: HANDLE) -> Result<bool> {
    let mut result = 0;
    if unsafe { IsProcessInJob(process, job, &mut result) } == 0 {
        return Err(Error("native-job-membership-unknown"));
    }
    Ok(result != 0)
}
pub(crate) fn require_outside(process: HANDLE) -> Result<()> {
    if in_job(process, null_mut())? {
        return Err(Error("native-process-still-contained"));
    }
    Ok(())
}

/// Retained native handle; PID/FILETIME values alone cannot authorize termination.
pub struct Process {
    pub(crate) handle: Handle,
    pub(crate) birth: Identity,
}
impl Process {
    pub fn identity(&self) -> Identity {
        self.birth
    }
    pub fn revalidate(&self) -> Result<()> {
        if identity(self.handle.raw())? != self.birth {
            return Err(Error("native-process-identity-changed"));
        }
        Ok(())
    }
    pub fn exited(&self) -> Result<bool> {
        self.wait_exit(0)
    }
    pub fn wait_exit(&self, milliseconds: u32) -> Result<bool> {
        self.revalidate()?;
        match unsafe { WaitForSingleObject(self.handle.raw(), milliseconds) } {
            0 => Ok(true),
            258 => Ok(false),
            _ => Err(Error("native-process-wait-unknown")),
        }
    }
    // Only CreateProcess-owned handles (not identities opened by PID) reach this API.
    pub fn terminate_owned(&self) -> Result<()> {
        self.revalidate()?;
        if self.exited()? {
            return Ok(());
        }
        if unsafe { TerminateProcess(self.handle.raw(), 1) } == 0 {
            return Err(Error("native-owned-stop-failed"));
        }
        if !self.wait_exit(5000)? {
            return Err(Error("native-owned-stop-unconfirmed"));
        }
        Ok(())
    }
}

pub(crate) struct Job {
    pub(crate) handle: Handle,
}
impl Job {
    pub(crate) fn new() -> Result<Self> {
        Self::with_limits(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
    }
    pub(crate) fn with_limits(flags: u32) -> Result<Self> {
        let handle = unsafe { Handle::take(CreateJobObjectW(null_mut(), std::ptr::null()))? };
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        info.BasicLimitInformation.LimitFlags = flags;
        if unsafe {
            SetInformationJobObject(
                handle.raw(),
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(Error("native-job-configuration-failed"));
        }
        let actual = Self::limits(handle.raw())?;
        if actual != flags {
            return Err(Error("native-job-limits-unproven"));
        }
        Ok(Self { handle })
    }
    pub(crate) fn limits(handle: HANDLE) -> Result<u32> {
        let mut flags = 0;
        // NULL is Win32's read-only current-parent-Job query, not an owned Job
        // handle. Every actual runtime owner still requires a non-inherited handle.
        if !handle.is_null()
            && (unsafe { windows_sys::Win32::Foundation::GetHandleInformation(handle, &mut flags) }
                == 0
                || flags & windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT != 0)
        {
            return Err(Error("native-job-handle-inheritance-unproven"));
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        if unsafe {
            QueryInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(Error("native-job-limits-unknown"));
        }
        Ok(info.BasicLimitInformation.LimitFlags)
    }
    pub(crate) fn assign(&self, process: &Process) -> Result<()> {
        process.revalidate()?;
        if unsafe { AssignProcessToJobObject(self.handle.raw(), process.handle.raw()) } == 0
            || !in_job(process.handle.raw(), self.handle.raw())?
        {
            return Err(Error("native-job-assignment-unproven"));
        }
        Ok(())
    }
}
