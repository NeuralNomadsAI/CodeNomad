//! Agent memory (`dev-docs/AGENT_MEMORY.md` of the reference): local Markdown entries in a
//! private Git repository under the backend's data folder, the `server.memoryEnabled`
//! preference, the Preferences routes, the native `codenomad_memory` bridge modes and
//! the `codenomad.memory` session instruction entry.

mod git;
mod identity;
mod lock;
mod model;
mod routes;
mod rules;
mod service;
mod store;
#[cfg(test)]
mod tests;
mod text;
mod yaml;

pub use routes::{bridge, lease_requested, sync};

pub fn routes() -> axum::Router<crate::Shared> {
    use axum::{
        Json,
        extract::State,
        routing::{get, post},
    };
    let unavailable = || async { crate::unavailable() };
    axum::Router::new()
        .route(
            "/api/storage/config/server",
            get(|State(app): State<crate::Shared>| async move { Json(routes::server_config(&app)) })
                .fallback(unavailable),
        )
        .route("/api/memory", post(routes::operation).fallback(unavailable))
        .route("/api/memory/settings", get(routes::settings).put(routes::settings).fallback(unavailable))
}
