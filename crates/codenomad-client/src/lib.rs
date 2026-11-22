//! CodeNomad's bounded HTTP/SSE client and native session contracts.
//!
//! The application owns rendering, editors and environment/profile selection. This
//! crate owns the consumed API data, scoped requests and authoritative recovery.
#![forbid(unsafe_code)]

pub mod agent_api;
pub mod backend;
pub mod catalog;
pub mod content;
pub mod history;
pub mod http;
pub mod recovery;
pub mod runtime;
mod server_path;
pub mod stream;
pub mod transport;
pub mod wire;
pub use async_channel::{Receiver, Sender, bounded};

/// Notify an owner's event loop after publishing data, without depending on its UI framework.
pub type Wake = std::sync::Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub body: String,
    pub parts: Vec<content::Part>,
}

#[cfg(test)]
mod history_tests;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod transport_tests;
