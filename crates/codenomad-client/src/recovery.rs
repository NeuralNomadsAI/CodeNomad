//! One serialized HTTP lane. SSE hints and generation-fenced reads keep session recovery ordered.
mod authentication;
pub mod demand;
mod reader;
pub(crate) mod receipts;
mod transport;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod wake_tests;

pub use reader::ReadingLane;
pub(crate) use transport::run_with_reading;

use crate::{
    Receiver, Sender,
    backend::Backend,
    history,
    transport::{Command, Event},
};
use serde_json::Value;

pub enum Input {
    Command(Command),
    Opened(u64),
    Native(u64, u64, u64, Value),
    Workspace(u64, crate::transport::WorkspaceEvent),
    Preferences(crate::settings::Owner),
    Hint(u64, u64, u64),
    Available(u64, u64, u64),
    Unavailable(u64, u64),
    AuthenticationRequired(u64),
    Closed(u64),
}

pub async fn run(
    backend: Backend,
    out: Sender<Event>,
    commands: Receiver<Command>,
    wake: crate::Wake,
) -> history::Result<()> {
    run_with_reading(backend, out, commands, wake, None).await
}
