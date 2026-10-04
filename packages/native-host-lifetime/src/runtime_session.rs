//! Alternative topology: supervisor outside Jobs, manager AND backend contained.
use crate::handle::require_outside;
use crate::runtime_core::{PendingRuntime, RuntimeCore};
use crate::{Command, OwnerBootstrap, Process, Result, RuntimeMember};
use std::time::Duration;
use windows_sys::Win32::System::Threading::GetCurrentProcess;

/// Only a natively bootstrapped independent supervisor can construct this facade.
/// Node's real spawn/IPC remains unchanged: all manager descendants inherit the
/// runtime Job, with neither explicit nor silent breakaway enabled.
pub struct RuntimeSession {
    bootstrap: OwnerBootstrap,
    pub(crate) core: RuntimeCore,
}
impl RuntimeSession {
    pub fn start(bootstrap: OwnerBootstrap, command: &Command, timeout: Duration) -> Result<Self> {
        bootstrap.revalidate()?;
        require_outside(unsafe { GetCurrentProcess() })?;
        let pending = PendingRuntime::prepare(command)?;
        // The new manager is still suspended and outside every Job here.
        bootstrap.revalidate()?;
        require_outside(pending.manager().handle.raw())?;
        let mut core = pending.resume()?; // Mandatory native assignment BEFORE resume.
        bootstrap.revalidate()?;
        core.authenticate(timeout)?; // Actual inherited-pipe CNG challenge + exact handle.
        Ok(Self { bootstrap, core })
    }
    pub fn manager(&self) -> &Process {
        self.core.manager()
    }
    pub fn revalidate(&self) -> Result<()> {
        self.bootstrap.revalidate()?;
        self.core.revalidate()
    }
    /// PID is only a candidate locator. Native exact Job/liveness checks produce
    /// the immutable query/wait handle; no kill/Job authority is handed to callers.
    pub fn observe_member(&self, candidate_pid: u32) -> Result<RuntimeMember> {
        self.revalidate()?;
        self.core.observe(candidate_pid)
    }
    pub fn read_manager(&mut self, bytes: usize, timeout: Duration) -> Result<Vec<u8>> {
        self.bootstrap.revalidate()?;
        self.core.read(bytes, timeout)
    }
    /// Initial bounded setup only, NOT an unbounded streaming/service RPC shim.
    pub fn write_manager_bootstrap(&mut self, bytes: &[u8]) -> Result<()> {
        self.revalidate()?;
        self.core.write_bootstrap(bytes)
    }
    pub fn wait_manager_exit(&self, milliseconds: u32) -> Result<bool> {
        self.bootstrap.revalidate()?;
        self.manager().wait_exit(milliseconds) // Native watcher owns Job closure.
    }
    // No public arbitrary service-exec API. Service execution belongs to the
    // outside supervisor's authenticated, separately authorized official starter.
}
