//! Session composer view and input ownership.
mod actions;
#[cfg(not(target_arch = "wasm32"))]
mod clipboard;
pub(crate) mod command_receipts;
pub(crate) mod device;
pub(crate) mod draft;
pub(crate) mod draft_storage;
pub(crate) mod literal;
mod long_paste;
pub(crate) mod menu;
mod picker;
pub(crate) mod recall;
#[cfg(test)]
mod shell_mode_tests;
mod shortcuts;
mod tokens;
pub(crate) mod view;
#[cfg(any(target_arch = "wasm32", test))]
mod web_bang;
#[cfg(any(test, all(not(target_arch = "wasm32"), feature = "test-support")))]
pub(crate) use actions::command_held;
pub(crate) use actions::{
    Owner, UnconfirmedPrompt, acknowledge, can_send, confirm_unconfirmed_id, reconcile, send,
    settle_pending,
};
