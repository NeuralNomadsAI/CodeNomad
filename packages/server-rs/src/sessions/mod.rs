//! Session-scoped reads beside the relay: pending requests, permission receipts,
//! favorites and history navigation, each checked against the workspace's locations.
pub mod contracts;
pub mod favorites;
pub mod history;
pub mod pending;
pub mod permission_mode;
pub mod receipts;

use axum::{
    Extension, Router,
    routing::{get, post, put},
};
use tokio_util::sync::CancellationToken;

use crate::Shared;

pub fn routes(shutdown: CancellationToken) -> Router<Shared> {
    Router::new()
        .route("/api/workspaces/{id}/pending-requests", get(pending::snapshot).layer(Extension(shutdown)))
        .route("/api/workspaces/{id}/session-favorites", get(favorites::list))
        .route("/api/workspaces/{id}/session-favorites/{session}", put(favorites::update))
        .route("/api/workspaces/{id}/sessions/{session}/permission-receipts", get(receipts::list))
        .route(
            "/api/workspaces/{id}/sessions/{session}/permission-mode",
            get(permission_mode::routes::handle).put(permission_mode::routes::handle),
        )
        .route("/api/workspaces/{id}/session-history/{action}", post(history::handle))
}
