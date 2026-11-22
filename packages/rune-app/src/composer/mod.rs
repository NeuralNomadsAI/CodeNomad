//! Session composer view and input ownership.
mod actions;
pub(crate) mod draft;
mod tokens;
pub(crate) mod view;
pub(crate) use actions::{Owner, acknowledge, can_send, send};
