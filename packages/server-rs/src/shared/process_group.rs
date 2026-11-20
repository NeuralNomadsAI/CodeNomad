//! A child process and every descendant it starts, stopped together: on Windows a kill-on-close
//! Job Object the child joins before it runs (created suspended), on POSIX its own process group.
use tokio::process::{Child, Command};

/// Before `spawn`: suspended (Windows) or leading a new process group (POSIX).
pub fn prepare(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_SUSPENDED | 0x0800_0000);
    #[cfg(unix)]
    command.process_group(0);
}

/// The family of a child spawned after `prepare`; dropping it on Windows ends any member left.
pub struct Group {
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(unix)]
    leader: i32,
}

// SAFETY: a job handle is a kernel object reference, usable from any thread.
#[cfg(windows)]
unsafe impl Send for Group {}
#[cfg(windows)]
unsafe impl Sync for Group {}

#[cfg(windows)]
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtResumeProcess(process: windows_sys::Win32::Foundation::HANDLE) -> i32;
}

impl Group {
    /// Joins the suspended child to a new job, then lets it run. `None` (the child is killed) when
    /// the job cannot hold it: nothing runs outside the family.
    #[cfg(windows)]
    pub fn adopt(child: &mut Child) -> Option<Self> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        let process = child.raw_handle()?;
        // SAFETY: plain Win32 calls on a live process handle and a job handle owned here; the
        // limit structure is zero-initialised and correctly sized.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            let mut limit: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            let held = !job.is_null()
                && SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&raw const limit).cast(), size)
                    != 0
                && AssignProcessToJobObject(job, process as _) != 0;
            if !held || NtResumeProcess(process as _) < 0 {
                if !job.is_null() {
                    CloseHandle(job);
                }
                let _ = child.start_kill();
                return None;
            }
            Some(Self { job })
        }
    }
    #[cfg(unix)]
    pub fn adopt(child: &mut Child) -> Option<Self> {
        child.id().map(|pid| Self { leader: pid as i32 })
    }

    /// Ends the whole family. POSIX: call it before the leader is reaped, so its group ID cannot
    /// belong to anyone else.
    pub fn kill(&self) {
        #[cfg(windows)]
        // SAFETY: live job handle owned by self.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
        #[cfg(unix)]
        // SAFETY: signalling the group this child leads.
        unsafe {
            libc::kill(-self.leader, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
impl Drop for Group {
    fn drop(&mut self) {
        // SAFETY: closing our own handle; kill-on-close ends any remaining member.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.job) };
    }
}
