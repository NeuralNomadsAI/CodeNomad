//! Session-scoped reads beside the relay: pending requests, permission receipts,
//! favorites and history navigation, each checked against the workspace's locations.
pub mod contracts;
pub mod favorites;
pub mod history;
mod history_search;
pub(crate) mod media;
pub(crate) mod media_stream;
pub mod pending;
pub mod permission_mode;
pub mod pruning;
pub mod receipts;
pub(crate) mod user_files;

use axum::{
    Extension, Json, Router,
    http::StatusCode as Status,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::Shared;

async fn api_not_found() -> Response {
    (Status::NOT_FOUND, Json(json!({ "message": "Not Found" }))).into_response()
}

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
        .route("/api/workspaces/{id}/session-history/{action}", post(history::handle).fallback(api_not_found))
        .route("/api/workspaces/{id}/session-pruning/preview", post(pruning::preview).fallback(api_not_found))
        .route("/api/workspaces/{id}/session-pruning/prune", post(pruning::prune).fallback(api_not_found))
        .route("/api/workspaces/{id}/session-media/{session}/{message}/{part}/{index}/{sha}", get(media::route))
        .route("/api/workspaces/{id}/session-attachment/{session}/{message}/{index}/{sha}", get(history::attachment))
}
