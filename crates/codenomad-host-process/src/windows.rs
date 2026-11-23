mod launch;
pub(super) use launch::{Process, launch};

use std::{
    io,
    mem::{size_of, zeroed},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::*,
};

pub(super) struct Family {
    handle: HANDLE,
}
// SAFETY: a job handle is an owned kernel-object reference, usable from any thread.
unsafe impl Send for Family {}
// SAFETY: the APIs used here synchronize access to the referenced kernel object.
unsafe impl Sync for Family {}
impl Family {
    fn new() -> io::Result<Self> {
        // SAFETY: pointers name correctly sized Win32 structures; the job is not inheritable.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let family = Self { handle };
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(family)
        }
    }
    pub fn empty(&self) -> io::Result<bool> {
        // SAFETY: the job handle is live and this correctly sized result is
        // writable for the duration of the query.
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
            if QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(info.ActiveProcesses == 0)
        }
    }
    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: only this spawn's owned job handle is terminated.
        if unsafe { TerminateJobObject(self.handle, 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}
impl Drop for Family {
    fn drop(&mut self) {
        // SAFETY: this owner closes its one live job handle exactly once.
        unsafe {
            CloseHandle(self.handle);
        }
    }
}
