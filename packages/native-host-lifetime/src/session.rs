use crate::handle::{require_outside, Handle};
use crate::launch::spawn_suspended;
use crate::owner::Containment;
use crate::{
    AuthenticatedManager, Child, Command, Error, Identity, OwnerBootstrap, Process, Result,
};
use std::time::Duration;
use windows_sys::Win32::System::Threading::*;

/// Only this native owner process holds the backend Job handle. It must itself
/// have been independently launched; no inheritable Job or breakaway allowance.
pub struct ManagerSession {
    bootstrap: OwnerBootstrap,
    manager: AuthenticatedManager,
    owner: Containment,
}
pub struct Backend {
    child: Child,
}
impl Backend {
    pub fn process(&self) -> &Process {
        self.child.process()
    }
    pub fn read_private(&mut self, bytes: usize, timeout: Duration) -> Result<Vec<u8>> {
        self.child.read_private(bytes, timeout)
    }
}
impl ManagerSession {
    pub fn new(bootstrap: OwnerBootstrap, manager: AuthenticatedManager) -> Result<Self> {
        let result = (|| {
            bootstrap.revalidate()?;
            require_outside(unsafe { GetCurrentProcess() })?;
            manager.child.process.revalidate()?;
            require_outside(manager.child.process.handle.raw())?;
            Containment::new(&manager.child.process)
        })();
        match result {
            Ok(owner) => Ok(Self {
                bootstrap,
                manager,
                owner,
            }),
            Err(error) => {
                manager.child.process.terminate_owned()?;
                Err(error)
            }
        }
    }
    pub fn manager(&self) -> &Process {
        self.manager.child.process()
    }
    pub fn read_manager(&mut self, bytes: usize, timeout: Duration) -> Result<Vec<u8>> {
        self.manager.child.read_private(bytes, timeout)
    }
    /// Initial private setup only, before handing streaming transport to an adapter.
    pub fn write_manager_bootstrap(&mut self, bytes: &[u8]) -> Result<()> {
        self.manager.child.write_bootstrap(bytes)
    }
    pub fn spawn_backend(&self, command: &Command) -> Result<Backend> {
        self.bootstrap.revalidate()?;
        require_outside(unsafe { GetCurrentProcess() })?;
        self.manager().revalidate()?;
        require_outside(self.manager().handle.raw())?;
        if self.manager().exited()? {
            return Err(Error("native-manager-not-live"));
        }
        // Preparation, pipes, CreateProcess and failure cleanup hold NO Job loan.
        let mut suspended = spawn_suspended(command, 0)?;
        self.bootstrap.revalidate()?;
        self.manager().revalidate()?;
        require_outside(self.manager().handle.raw())?;
        require_outside(suspended.process().handle.raw())?;
        let result = (|| {
            let mut assigned = self.owner.assign(self.manager(), &mut suspended)?;
            // Fresh native/immutable proof facts only while the Job is loaned.
            self.bootstrap.revalidate()?;
            require_outside(self.manager().handle.raw())?;
            assigned.resume()
        })();
        // The loan is gone on EVERY outcome, including ResumeThread failure.
        result?;
        Ok(Backend {
            child: suspended.into_child()?,
        })
    }
    /// Official service starter belongs here, not in spawn_backend. This does NOT
    /// itself authorize a service request or start any OpenCode daemon.
    pub fn spawn_external(&self, command: &Command) -> Result<Child> {
        self.bootstrap.revalidate()?;
        self.manager().revalidate()?;
        require_outside(self.manager().handle.raw())?;
        if self.manager().exited()? {
            return Err(Error("native-manager-not-live"));
        }
        require_outside(unsafe { GetCurrentProcess() })?;
        crate::launch_independent(command)
    }
    /// No PID-tree traversal. A descendant is observed only through the actual
    /// private backend Job; the returned identity is diagnostic, not kill authority.
    pub fn observe_backend_member(&self, pid: u32) -> Result<Identity> {
        if pid == 0 {
            return Err(Error("native-descendant-unknown"));
        }
        let handle = unsafe {
            Handle::take(OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            ))?
        };
        let shared = self.owner.lock()?;
        let job = shared.as_ref().ok_or(Error("native-containment-closed"))?;
        if !crate::handle::in_job(handle.raw(), job.handle.raw())? {
            return Err(Error("native-descendant-not-contained"));
        }
        crate::handle::identity(handle.raw())
    }
    pub fn wait_manager_exit(&self, milliseconds: u32) -> Result<bool> {
        if !self.manager().wait_exit(milliseconds)? {
            return Ok(false);
        }
        // Closing the sole Job handle triggers native termination of descendants.
        self.owner.close();
        Ok(true)
    }
}
