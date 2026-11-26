//! The loopback bridge the bundled OpenCode plugins call (`routes/automation-plugin.ts`): its
//! registration, token, session ownership and the desktop host's browser and window requests.
//! Memory and Missions modes are answered by their domains.
pub mod actions;
mod browser;
mod developer;
pub mod diagnostics;
mod registry;

pub use developer::Pins;
pub use registry::Record;

use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Request, State},
    http::{HeaderMap, StatusCode as Status, request::Parts},
    middleware::from_fn,
    response::{IntoResponse, Response},
    routing::post,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;

use crate::{Shared, host::native_parent, shared::fastify};

pub const PATH: &str = "/api/opencode-plugin/automation";
const LIMIT: usize = 512 * 1024;
const NATIVE: Duration = native_parent::DEFAULT_DEADLINE;
static PUBLISHED: AtomicBool = AtomicBool::new(false);

/// 32 random bytes, base64url (`createAutomationBridgeRegistration`).
pub fn new_token() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(URL_SAFE_NO_PAD.encode(bytes))
}

/// The Missions and memory plugins are provisioned only once the bridge is advertised.
pub fn published() -> bool {
    PUBLISHED.load(Ordering::Relaxed)
}

/// Binds the private IPv4 loopback listener and writes its registration before the plugins are
/// provisioned, as `publishAutomationBridge` does; returns the server task and registration
/// record so shutdown removes the registration only after all listeners finish draining.
pub async fn publish(
    app: &Shared,
    stop: CancellationToken,
) -> Option<(tokio::task::JoinHandle<std::io::Result<()>>, Record)> {
    let token = app.bridge_token.clone()?;
    let opened = async {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let url = format!("http://127.0.0.1:{}{PATH}", listener.local_addr()?.port());
        let dir = crate::config::automation_bridges().ok_or_else(|| std::io::Error::other("No home directory"))?;
        if !crate::bench::private_registry(&dir) {
            return Err(std::io::Error::other("Fixture bridge registry outside the private home"));
        }
        Ok::<_, std::io::Error>((listener, registry::publish(&dir, &url, &token)?))
    };
    let (listener, record) = match opened.await {
        Ok(opened) => opened,
        Err(e) => {
            eprintln!("Failed to publish the local automation bridge; Missions are unavailable: {e}");
            return None;
        }
    };
    PUBLISHED.store(true, Ordering::Relaxed);
    let router =
        Router::new().route(PATH, post(handle)).layer(from_fn(crate::panic_guard::catch)).with_state(app.clone());
    Some((tokio::spawn(async move { crate::shared::serve_local(listener, router, stop, || {}).await }), record))
}

fn refuse(status: Status, message: &str) -> Response {
    crate::error(status, message).into_response()
}
fn invalid() -> Response {
    refuse(Status::BAD_REQUEST, "Invalid automation bridge request")
}
fn result(value: Value) -> Response {
    Json(json!({ "result": value })).into_response()
}

/// The private token, and no browser-origin, cookie or forwarding header.
fn authorized(app: &Shared, headers: &HeaderMap) -> bool {
    let Some(secret) = app.bridge_token.as_deref() else { return false };
    let got = headers.get("x-codenomad-automation-token").map_or(&[][..], |v| v.as_bytes());
    got.len() == secret.len()
        && bool::from(secret.as_bytes().ct_eq(got))
        && !headers.keys().any(|k| {
            matches!(k.as_str(), "origin" | "referer" | "cookie" | "forwarded" | "x-forwarded-for")
                || k.as_str().starts_with("sec-")
        })
}

async fn handle(State(app): State<Shared>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    if !authorized(&app, &parts.headers) {
        // The reference's session guard answers before its route sees the request.
        return refuse(Status::UNAUTHORIZED, "Unauthorized");
    }
    let Ok(bytes) = axum::body::to_bytes(body, LIMIT).await else {
        return fastify::error(Status::PAYLOAD_TOO_LARGE, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large")
            .into_response();
    };
    let body = match fastify::body(&parts.headers, &bytes) {
        Ok(Some(fastify::Body::Json(value))) => value,
        Ok(_) => return invalid(),
        Err(refusal) => return refusal.into_response(),
    };
    match body["mode"].as_str().unwrap_or_default() {
        "human-answer-verify" => match crate::missions::human_answer::verify(&app, &body).await {
            Some(()) => result(json!({ "admitted": true })),
            None => refuse(Status::FORBIDDEN, "Human answer admission unavailable"),
        },
        "recurrence-control-verify" => missions(app, parts, bytes).await,
        mode @ ("memory-probe" | "memory-input" | "memory-context") => match body["sessionID"].as_str() {
            Some(session) => {
                crate::memory::bridge(&app, mode, session, body.get("command").cloned()).await.into_response()
            }
            None => invalid(),
        },
        _ => session(app, parts, bytes, body).await,
    }
}

/// The Missions bridge, unchanged while its contract is revised.
async fn missions(app: Shared, parts: Parts, bytes: Bytes) -> Response {
    crate::missions::run::dispatch(State(app), Request::from_parts(parts, Body::from(bytes))).await.into_response()
}

/// Modes of one OpenCode session owned by an open workspace.
async fn session(app: Shared, parts: Parts, bytes: Bytes, body: Value) -> Response {
    const MODES: [&str; 8] = [
        "developer-probe",
        "developer-execute",
        "developer-restart",
        "developer-reconnect",
        "browser-claim",
        "browser-probe",
        "browser-execute",
        "mission-input",
    ];
    let mode = body["mode"].as_str().unwrap_or_default();
    let Some(id) = body["sessionID"].as_str().filter(|s| s.encode_utf16().count() <= 256 && MODES.contains(&mode))
    else {
        return invalid();
    };
    // The host can confirm the relaunch even before the session's project has been restored.
    let reconnect = if mode == "developer-reconnect" {
        match developer::restart::Reconnect::read(&body).await {
            Ok(reconnect) => Some(reconnect),
            Err(response) => return response,
        }
    } else {
        None
    };
    let inspection = if mode == "developer-execute" && developer::selects_window(&body["command"]) {
        let Some(ticket) = app.automation_pins.begin(id, body["order"].as_str()) else {
            return developer::stale_inspection();
        };
        Some(ticket)
    } else {
        None
    };
    let (purpose, kind) = (body["purpose"].as_str(), body["command"]["kind"].as_str());
    let mission_claim =
        mode == "browser-claim" && matches!(purpose, Some("mission" | "mission-preferences" | "mission-prepare"));
    if mode.starts_with("browser-") && !mission_claim {
        return browser::handle(&app, mode, id, &body).await;
    }
    // A Missions preference read distinguishes "not this backend" from "cannot tell".
    let preference = mode == "browser-claim" && matches!(purpose, Some("mission-preferences" | "mission-prepare"))
        || mode == "mission-input" && matches!(kind, Some("profile-defaults" | "configurations" | "settings"));
    let not_owner = |message: &str| {
        if let Some(reconnect) = &reconnect {
            return reconnect.pending();
        }
        let mut refusal = json!({ "error": message });
        if preference {
            refusal["code"] = json!("mission-not-owner");
        }
        (Status::NOT_FOUND, Json(refusal)).into_response()
    };
    let record = match crate::opencode::session_record(&app, id).await {
        Ok(record) => record,
        Err((status, Json(e)))
            if preference && !(status == Status::NOT_FOUND && e["_tag"] == "SessionNotFoundError") =>
        {
            return preferences_unavailable();
        }
        Err(_) => return not_owner("Session not found"),
    };
    match owned(&app, &record["location"], preference).await {
        Some(true) => {}
        Some(false) => return not_owner("Session is not owned by this CodeNomad instance"),
        None => return preferences_unavailable(),
    }
    if mode == "mission-input" || mission_claim {
        return missions(app, parts, bytes).await;
    }
    if let Some(reconnect) = reconnect {
        return reconnect.inspect(&app.automation_pins, id, &body).await;
    }
    if mode == "developer-restart" {
        return developer::restart::dispatch(&app.automation_pins, id, &body).await;
    }
    developer::handle(&app.automation_pins, id, mode, &body, inspection).await
}

fn preferences_unavailable() -> Response {
    let refusal = json!({ "error": "CodeNomad backend discovery, ownership or preference reading failed; restore the backend and reload Missions preferences", "code": "mission-preferences-unavailable" });
    (Status::SERVICE_UNAVAILABLE, Json(refusal)).into_response()
}

/// `ownsLocation` of any open workspace: linked worktrees and subfolders included, or the strict
/// read of a preference probe, where an unreadable location answers `None` instead of "not owned".
async fn owned(app: &Shared, location: &Value, strict: bool) -> Option<bool> {
    let Some(directory) = location["directory"].as_str().filter(|_| location.get("workspaceID").is_none()) else {
        return Some(false);
    };
    let workspaces = app.inner.lock().unwrap().workspaces.clone();
    let mut unreadable = false;
    for w in workspaces {
        if !strict && crate::worktrees::ownership::resolve(app, &w, directory).await.is_some() {
            return Some(true);
        }
        if strict {
            match crate::worktrees::placement(app, &w, location).await {
                Ok(_) => return Some(true),
                Err(proven_foreign) => unreadable |= !proven_foreign,
            }
        }
    }
    (!unreadable).then_some(false)
}
