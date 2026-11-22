use std::{
    io,
    mem::{size_of, zeroed},
    os::windows::io::AsRawHandle,
    os::windows::process::CommandExt,
    process::{Child, Command},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{JobObjects::*, Threading::CREATE_SUSPENDED},
};

pub(super) struct Family {
    handle: HANDLE,
}
// SAFETY: a job handle is an owned kernel-object reference, usable from any thread.
unsafe impl Send for Family {}
// SAFETY: the APIs used here synchronize access to the referenced kernel object.
unsafe impl Sync for Family {}
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtResumeProcess(process: HANDLE) -> i32;
}
impl Family {
    pub fn prepare(command: &mut Command) {
        command.creation_flags(CREATE_SUSPENDED | 0x0800_0000);
    }
    pub fn adopt(child: &mut Child) -> io::Result<Self> {
        // SAFETY: pointers name owned handles and correctly sized initialized
        // Win32 structures. The child remains suspended through assignment.
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
            let process = child.as_raw_handle() as HANDLE;
            if AssignProcessToJobObject(handle, process) == 0 {
                return Err(io::Error::last_os_error());
            }
            if NtResumeProcess(process) < 0 {
                return Err(io::Error::other("Cannot resume the contained backend"));
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
