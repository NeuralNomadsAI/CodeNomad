//! Native Windows ownership primitives. Serialized identities are NOT authority.
//! Desktop/Node transport integration and packaged parity remain separate gates.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Error(pub &'static str);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(windows)]
mod addon;
#[cfg(windows)]
mod addon_api;
#[cfg(windows)]
mod addon_service;
#[cfg(windows)]
mod bootstrap;
#[cfg(windows)]
mod bound_channel;
#[cfg(all(windows, feature = "fixtures"))]
mod channel_fixture;
#[cfg(windows)]
mod channel_wire;
#[cfg(windows)]
mod command;
#[cfg(windows)]
mod handle;
#[cfg(windows)]
mod launch;
#[cfg(windows)]
mod mission_channel;
#[cfg(windows)]
mod mission_channel_addon;
#[cfg(windows)]
mod mission_channel_wire;
#[cfg(windows)]
mod named_channel;
#[cfg(windows)]
mod native_client;
#[cfg(windows)]
mod owner;
#[cfg(windows)]
mod pipe;
#[cfg(windows)]
mod runtime_core;
#[cfg(all(windows, feature = "fixtures"))]
mod runtime_fixture;
#[cfg(windows)]
mod runtime_session;
#[cfg(windows)]
mod runtime_wire;
#[cfg(windows)]
mod security;
#[cfg(all(windows, feature = "fixtures"))]
mod service_addon_fixture;
#[cfg(windows)]
mod service_channel;
#[cfg(windows)]
mod service_control;
#[cfg(all(windows, feature = "fixtures"))]
mod service_dispatch_fixture;
#[cfg(windows)]
mod service_permit;
#[cfg(windows)]
mod service_reply;
#[cfg(windows)]
mod service_response;
#[cfg(windows)]
mod service_starter;
#[cfg(windows)]
mod session;
#[cfg(windows)]
mod supervised_runtime;
#[cfg(windows)]
mod supervisor_config;
#[cfg(windows)]
mod supervisor_dispatch;
#[cfg(windows)]
pub use bootstrap::OwnerBootstrap;
#[cfg(windows)]
pub use channel_wire::{ServicePolicy, ServiceRequest};
#[cfg(windows)]
pub use command::Command;
#[cfg(windows)]
pub use handle::{Identity, Process};
#[cfg(windows)]
pub use launch::{launch_independent, AuthenticatedManager, Child};
#[cfg(windows)]
pub use runtime_core::RuntimeMember;
#[cfg(windows)]
pub use runtime_session::RuntimeSession;
#[cfg(windows)]
pub use supervised_runtime::{launch_supervisor, SupervisedRuntime};
#[cfg(windows)]
pub use supervisor_config::{BrokerConfig, NodeProgram, SupervisorConfig};

#[cfg(windows)]
pub fn run_supervisor_stdio() -> Result<()> {
    use std::os::windows::io::AsRawHandle;
    use std::time::Duration;
    if std::env::args_os().count() != 1 {
        return Err(Error("native-supervisor-argv-refused"));
    }
    let bootstrap = OwnerBootstrap::accept_stdio(Duration::from_secs(5))?;
    let input = std::io::stdin().as_raw_handle();
    let length = pipe::read_exact(input, 4, Duration::from_secs(5))?;
    let size = u32::from_le_bytes(length.try_into().unwrap()) as usize;
    if size == 0 || size > 4000 {
        return Err(Error("native-supervisor-config-bound"));
    }
    let config = serde_json::from_slice(&pipe::read_exact(input, size, Duration::from_secs(5))?)
        .map_err(|_| Error("native-supervisor-config-invalid"))?;
    SupervisedRuntime::start(bootstrap, config)?.serve()
}
#[cfg(windows)]
pub use session::{Backend, ManagerSession};
#[cfg(all(windows, feature = "fixtures"))]
pub mod fixture;
#[cfg(all(windows, test))]
mod launch_regression;
