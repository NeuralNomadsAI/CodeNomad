use crate::handle::{Handle, Job};
use crate::launch::Suspended;
use crate::{Error, Process, Result};
use std::ptr::null;
use std::sync::{Arc, Mutex, MutexGuard};
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
use windows_sys::Win32::System::Threading::*;

/// Borrowed assignment proof: owns the lock, NEVER the child or its cleanup.
/// All process creation and all consuming/drop operations stay outside this loan.
pub(crate) struct AssignedBackend<'owner, 'child> {
    shared: MutexGuard<'owner, Option<Job>>,
    manager: &'child Process,
    child: &'child mut Suspended,
}
impl AssignedBackend<'_, '_> {
    pub(crate) fn resume(&mut self) -> Result<()> {
        self.manager.revalidate()?;
        if self.manager.exited()? {
            return Err(Error("native-manager-not-live"));
        }
        let job = self
            .shared
            .as_ref()
            .ok_or(Error("native-containment-closed"))?;
        self.child.process().revalidate()?;
        if self.child.process().exited()? {
            return Err(Error("native-backend-not-live"));
        }
        if !crate::handle::in_job(self.child.process().handle.raw(), job.handle.raw())? {
            return Err(Error("native-job-assignment-unproven"));
        }
        self.child.resume_thread()
    }
}

/// Private native lifetime primitive. It does not attest independent launch;
/// ManagerSession supplies that separate handle/challenge gate before construction.
pub(crate) struct Containment {
    job: Arc<Mutex<Option<Job>>>,
    cancel: Handle,
    watcher: Option<std::thread::JoinHandle<()>>,
}
fn close(shared: &Mutex<Option<Job>>) {
    // Poison/unknown cannot retain a live backend Job after manager loss.
    shared
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .take();
}
impl Containment {
    pub(crate) fn new(manager: &Process) -> Result<Self> {
        manager.revalidate()?;
        if manager.exited()? {
            return Err(Error("native-manager-not-live"));
        }
        let job = Arc::new(Mutex::new(Some(Job::new()?)));
        let cancel = unsafe { Handle::take(CreateEventW(null(), 1, 0, null()))? };
        let watched = manager.handle.duplicate()?;
        let canceled = cancel.duplicate()?;
        let shared = job.clone();
        let watcher = std::thread::Builder::new()
            .name("native-manager-job-owner".into())
            .spawn(move || {
                let handles = [watched.raw(), canceled.raw()];
                // Exact native creation handle; failed/unknown wait is also fatal.
                unsafe {
                    WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, u32::MAX);
                }
                close(&shared);
            })
            .map_err(|_| Error("native-manager-watch-unavailable"))?;
        Ok(Self {
            job,
            cancel,
            watcher: Some(watcher),
        })
    }
    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, Option<Job>>> {
        self.job
            .lock()
            .map_err(|_| Error("native-containment-unknown"))
    }
    pub(crate) fn assign<'owner, 'child>(
        &'owner self,
        manager: &'child Process,
        child: &'child mut Suspended,
    ) -> Result<AssignedBackend<'owner, 'child>> {
        // No CreateProcess, callbacks, consuming resume, Terminate or wait here.
        let shared = self.lock()?;
        let job = shared.as_ref().ok_or(Error("native-containment-closed"))?;
        if Job::limits(job.handle.raw())? != JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE {
            return Err(Error("native-containment-limits-unproven"));
        }
        manager.revalidate()?;
        if manager.exited()? {
            return Err(Error("native-manager-not-live"));
        }
        if child.process().exited()? {
            return Err(Error("native-backend-not-live"));
        }
        job.assign(child.process())?;
        Ok(AssignedBackend {
            shared,
            manager,
            child,
        })
    }
    pub(crate) fn close(&self) {
        close(&self.job);
    }
}
impl Drop for Containment {
    fn drop(&mut self) {
        self.close();
        // A failed cancellation must not hang disposal; the Job is already closed.
        if unsafe { SetEvent(self.cancel.raw()) } != 0 {
            if let Some(watcher) = self.watcher.take() {
                let _ = watcher.join();
            }
        }
    }
}
