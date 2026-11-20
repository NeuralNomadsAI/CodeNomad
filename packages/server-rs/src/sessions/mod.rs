//! Session-scoped reads beside the relay: pending requests, permission receipts,
//! favorites and history navigation, each checked against the workspace's locations.
pub mod contracts;
pub mod favorites;
pub mod history;
pub mod pending;
pub mod receipts;

use axum::{
    Router,
    routing::{get, post, put},
};

use crate::Shared;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/workspaces/{id}/pending-requests", get(pending::snapshot))
        .route("/api/workspaces/{id}/session-favorites", get(favorites::list))
        .route("/api/workspaces/{id}/session-favorites/{session}", put(favorites::update))
        .route("/api/workspaces/{id}/sessions/{session}/permission-receipts", get(receipts::list))
        .route("/api/workspaces/{id}/session-history/{action}", post(history::handle))
}
