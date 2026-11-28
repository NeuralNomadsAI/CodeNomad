//! CodeNomad's bounded HTTP/SSE client and native session contracts.
//!
//! The application owns rendering, editors and environment/profile selection. This
//! crate owns the consumed API data, scoped requests and authoritative recovery.
#![forbid(unsafe_code)]

pub mod agent_api;
pub mod attachments;
pub mod backend;
pub mod blank_session_cleanup;
pub mod catalog;
pub mod content;
pub mod files;
pub mod folders;
pub mod git;
pub mod history;
pub mod http;
pub mod inbox;
pub mod interruption_receipts;
pub mod message_actions;
pub mod missions;
pub mod permission_mode;
pub mod plugins;
pub mod prompt;
pub mod prompt_catalogue;
mod prompt_command;
pub mod prompt_history;
mod prompt_receipt;
pub mod prompt_shell;
pub mod provider_usage;
pub mod recovery;
pub mod runtime;
pub mod search;
mod server_path;
pub mod session_cleanup;
pub mod settings;
pub use server_path::absolute as absolute_server_path;
pub use server_path::basename as server_path_basename;
pub use server_path::file_uri as server_file_uri;
pub use server_path::same as same_server_path;
pub mod stream;
pub mod temporary_workspaces;
pub mod timeline;
pub mod transport;
pub mod wire;
pub use async_channel::{Receiver, Sender, TryRecvError, bounded};

/// Notify an owner's event loop after publishing data, without depending on its UI framework.
pub type Wake = std::sync::Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub completed: bool,
    pub body: String,
    pub usage: Option<content::Usage>,
    pub parts: Vec<content::Part>,
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod catalog_tests;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod files_tests;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod files_write_tests;
#[cfg(test)]
mod folders_tests;
#[cfg(test)]
mod fragment_tests;
#[cfg(test)]
mod history_tests;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod inbox_tests;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod prompt_tests;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod transport_tests;
