//! Shared containment implementation. This alone does NOT attest independence.
use crate::handle::{identity, in_job, Handle, Job};
use crate::launch::{challenge_for, spawn_suspended, Suspended};
use crate::owner::Containment;
use crate::{Child, Command, Error, Identity, Result};
use std::time::Duration;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
use windows_sys::Win32::System::Threading::*;

/// Query/wait-only retained native member. A candidate PID is never kill authority.
pub struct RuntimeMember {
    handle: Handle,
    birth: Identity,
}
impl RuntimeMember {
    pub(crate) fn locate(candidate_pid: u32) -> Result<Self> {
        if candidate_pid == 0 {
            return Err(Error("native-runtime-member-unknown"));
        }
        let handle = unsafe {
            Handle::take(OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                candidate_pid,
            ))?
        };
        let birth = identity(handle.raw())?;
        Ok(Self { handle, birth })
    }
    pub(crate) fn raw(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.handle.raw()
    }
    pub(crate) fn revalidate(&self) -> Result<()> {
        if identity(self.handle.raw())? != self.birth {
            return Err(Error("native-runtime-member-identity-changed"));
        }
        Ok(())
    }
    pub(crate) fn exited(&self) -> Result<bool> {
        self.wait_exit(0)
    }
    pub fn exit_code(&self) -> Result<Option<u32>> {
        if !self.wait_exit(0)? {
            return Ok(None);
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(self.handle.raw(), &mut code) } == 0 {
            return Err(Error("native-runtime-member-exit-unknown"));
        }
        Ok(Some(code))
    }
    pub fn identity(&self) -> Identity {
        self.birth
    }
    pub fn wait_exit(&self, milliseconds: u32) -> Result<bool> {
        if identity(self.handle.raw())? != self.birth {
            return Err(Error("native-runtime-member-identity-changed"));
        }
        match unsafe { WaitForSingleObject(self.handle.raw(), milliseconds) } {
            0 => Ok(true),
            258 => Ok(false),
            _ => Err(Error("native-runtime-member-wait-unknown")),
        }
    }
}

pub(crate) struct PendingRuntime {
    // Drop the sole Job BEFORE potentially blocking suspended-child cleanup.
    owner: Containment,
    suspended: Suspended,
    watched: crate::Process,
}
impl PendingRuntime {
    pub(crate) fn prepare(command: &Command) -> Result<Self> {
        let suspended = spawn_suspended(command, 0)?;
        let watched = crate::Process {
            handle: suspended.process().handle.duplicate()?,
            birth: suspended.process().identity(),
        };
        // Watch this exact manager even while suspended. No Job handle duplication.
        let owner = Containment::new(&watched)?;
        Ok(Self {
            owner,
            suspended,
            watched,
        })
    }
    pub(crate) fn manager(&self) -> &crate::Process {
        self.suspended.process()
    }
    pub(crate) fn resume(mut self) -> Result<RuntimeCore> {
        let result = {
            let mut assigned = self.owner.assign(&self.watched, &mut self.suspended)?;
            assigned.resume()
        };
        result?; // Borrow/lock gone before ANY cleanup or child extraction.
        Ok(RuntimeCore {
            owner: self.owner,
            manager: self.suspended.into_child()?,
            channel_published: std::sync::atomic::AtomicBool::new(false),
        })
    }
}

pub(crate) struct RuntimeCore {
    owner: Containment,
    manager: Child,
    channel_published: std::sync::atomic::AtomicBool,
}
impl RuntimeCore {
    #[cfg(feature = "fixtures")]
    pub(crate) fn contains_member(&self, member: &RuntimeMember) -> Result<bool> {
        self.revalidate()?;
        member.revalidate()?;
        let shared = self.owner.lock()?;
        let job = shared.as_ref().ok_or(Error("native-containment-closed"))?;
        in_job(member.raw(), job.handle.raw())
    }
    pub(crate) fn publish_channel(&self, bytes: &[u8]) -> Result<()> {
        self.revalidate()?;
        if bytes.len() > 4000
            || self
                .channel_published
                .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return Err(Error("native-channel-bootstrap-once"));
        }
        crate::pipe::write_bootstrap(self.manager.input.raw(), bytes)
    }
    #[cfg(feature = "fixtures")]
    pub(crate) fn diagnostic(&self) -> Result<Vec<u8>> {
        if !self.manager().wait_exit(500)? {
            return Err(Error("native-fixture-diagnostic-unavailable"));
        }
        let mut data = vec![0u8; 1];
        let mut read = 0;
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::ReadFile(
                self.manager.output.raw(),
                data.as_mut_ptr(),
                1,
                &mut read,
                std::ptr::null_mut(),
            )
        } == 0
            || read == 0
        {
            return Err(Error("native-fixture-diagnostic-unavailable"));
        }
        Ok(data)
    }
    pub(crate) fn close(&self) {
        self.owner.close();
    }
    #[cfg(feature = "fixtures")]
    pub(crate) fn contains(&self, process: &crate::Process) -> Result<bool> {
        process.revalidate()?;
        let shared = self.owner.lock()?;
        let job = shared.as_ref().ok_or(Error("native-containment-closed"))?;
        in_job(process.handle.raw(), job.handle.raw())
    }
    pub(crate) fn manager(&self) -> &crate::Process {
        self.manager.process()
    }
    pub(crate) fn revalidate(&self) -> Result<()> {
        self.manager().revalidate()?;
        if self.manager().exited()? {
            return Err(Error("native-runtime-manager-not-live"));
        }
        let shared = self.owner.lock()?;
        let job = shared.as_ref().ok_or(Error("native-containment-closed"))?;
        if Job::limits(job.handle.raw())? != JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            || !in_job(self.manager().handle.raw(), job.handle.raw())?
        {
            return Err(Error("native-runtime-manager-containment-unproven"));
        }
        Ok(())
    }
    pub(crate) fn authenticate(&mut self, timeout: Duration) -> Result<()> {
        self.revalidate()?;
        let frame = challenge_for(self.manager())?;
        self.manager.write_bootstrap(&frame)?;
        let reply = self.manager.read_private(frame.len(), timeout)?;
        let different = frame
            .iter()
            .zip(reply.iter())
            .fold(0u8, |all, (a, b)| all | (a ^ b));
        if different != 0 {
            return Err(Error("native-runtime-manager-challenge-mismatch"));
        }
        self.revalidate()
    }
    pub(crate) fn read(&mut self, size: usize, timeout: Duration) -> Result<Vec<u8>> {
        self.manager.read_private(size, timeout)
    }
    pub(crate) fn write_bootstrap(&mut self, bytes: &[u8]) -> Result<()> {
        self.revalidate()?;
        self.manager.write_bootstrap(bytes)
    }
    pub(crate) fn observe(&self, candidate_pid: u32) -> Result<RuntimeMember> {
        self.revalidate()?;
        let member = RuntimeMember::locate(candidate_pid)?;
        let shared = self.owner.lock()?;
        let job = shared.as_ref().ok_or(Error("native-containment-closed"))?;
        if member.wait_exit(0)? || !in_job(member.handle.raw(), job.handle.raw())? {
            return Err(Error("native-runtime-member-not-contained"));
        }
        // Fresh native liveness/membership facts before returning a query-only loan.
        if Job::limits(job.handle.raw())? != JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            || self.manager().exited()?
        {
            return Err(Error("native-runtime-containment-unproven"));
        }
        Ok(member)
    }
}
impl Drop for RuntimeCore {
    fn drop(&mut self) {
        self.owner.close();
    } // No process-tree/PID termination.
}

#[cfg(test)]
mod tests {
    use super::*;
    fn command() -> Command {
        Command {
            executable: "C:/Program Files/nodejs/node.exe".into(),
            args: vec!["-e".into(), "setTimeout(()=>process.exit(0),60000)".into()],
            directory: std::env::current_dir().unwrap(),
            environment: std::env::vars().collect(),
        }
    }
    #[test]
    fn runtime_job_is_noninherited_and_other_runtime_job_is_not_a_member() {
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
        let first = PendingRuntime::prepare(&command())
            .unwrap()
            .resume()
            .unwrap();
        let second = PendingRuntime::prepare(&command())
            .unwrap()
            .resume()
            .unwrap();
        {
            let loan = first.owner.lock().unwrap();
            let job = loan.as_ref().unwrap();
            let mut flags = 0;
            assert_ne!(
                unsafe { GetHandleInformation(job.handle.raw(), &mut flags) },
                0
            );
            assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
            assert_eq!(
                Job::limits(job.handle.raw()).unwrap(),
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            );
        }
        let own = first.observe(first.manager().identity().pid).unwrap();
        assert_eq!(own.identity(), first.manager().identity());
        assert!(matches!(
            first.observe(second.manager().identity().pid),
            Err(Error("native-runtime-member-not-contained"))
        ));
        assert!(matches!(
            first.observe(0),
            Err(Error("native-runtime-member-unknown"))
        ));
        let a = first.manager().handle.duplicate().unwrap();
        let b = second.manager().handle.duplicate().unwrap();
        drop(first);
        drop(second);
        assert_eq!(unsafe { WaitForSingleObject(a.raw(), 5000) }, 0);
        assert_eq!(unsafe { WaitForSingleObject(b.raw(), 5000) }, 0);
    }
    #[test]
    fn poison_closed_job_and_dead_suspended_manager_never_resume() {
        for mode in 0..3 {
            let pending = PendingRuntime::prepare(&command()).unwrap();
            let observed = pending.manager().handle.duplicate().unwrap();
            if mode == 0 {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _loan = pending.owner.lock().unwrap();
                    panic!("private runtime poison");
                }));
            } else if mode == 1 {
                pending.owner.close();
            } else {
                pending.manager().terminate_owned().unwrap();
            }
            assert!(pending.resume().is_err());
            assert_eq!(unsafe { WaitForSingleObject(observed.raw(), 5000) }, 0);
        }
    }
    #[test]
    fn forged_private_manager_challenge_closes_exact_runtime_job() {
        let mut launch = command();
        launch.args = vec!["-e".into(),
            "process.stdin.once('data',d=>process.stdout.write(Buffer.alloc(d.length)));setTimeout(()=>process.exit(0),60000)".into()];
        let mut runtime = PendingRuntime::prepare(&launch).unwrap().resume().unwrap();
        let observed = runtime.manager().handle.duplicate().unwrap();
        assert!(matches!(
            runtime.authenticate(Duration::from_secs(5)),
            Err(Error("native-runtime-manager-challenge-mismatch"))
        ));
        drop(runtime);
        assert_eq!(unsafe { WaitForSingleObject(observed.raw(), 5000) }, 0);
    }
}
