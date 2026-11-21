//! `GET /api/meta`: the server identity, its listeners and capabilities.
use std::path::Path;

use axum::{Extension, Json, Router, extract::State, routing::get};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{Shared, auth::tls, bench, config, settings::Kind};

/// CodeNomad, feat/multi-backend 03743cd51c093bd2bcc391e84b3e09697c4694bf
const API_CONTRACT: u32 = 1;

pub fn routes() -> Router<Shared> {
    Router::new().route("/api/meta", get(read))
}

async fn read(State(app): State<Shared>, channel: Option<Extension<tls::Channel>>) -> Json<Value> {
    let mut meta = app.meta.clone();
    meta["updateFeed"] = json!(update_feed(&app.settings.owner(Kind::Config, "server")));
    if channel.is_some() {
        // SideCar content stays host-only: the direct HTTPS opt-in is not served here.
        (meta["localRequest"], meta["sidecarsAllowed"]) = (json!(false), json!(false));
        if app.devices.as_ref().is_none_or(|devices| !devices.lock().unwrap().previews_allowed()) {
            meta["previewsUnavailable"] = json!(true);
        }
    }
    Json(meta)
}

pub fn document(
    server_id: Uuid,
    port: u16,
    root: &Path,
    tls: Option<&tls::Listener>,
    ui: Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    let mut capabilities = vec![
        "workspaces",
        "events",
        "workspace-files",
        "workspace-git",
        "linked-worktrees",
        "config-files",
        "sidecars",
        "service-usage",
        "provider-usage",
    ];
    if bench::missions_run() {
        capabilities.push("missions");
    }
    let mut meta = json!({
        "serverId": server_id, "apiContract": API_CONTRACT, "capabilities": capabilities,
        "localUrl": format!("http://127.0.0.1:{port}"), "localPort": port, "host": "127.0.0.1",
        "listeningMode": "local", "hostLabel": "127.0.0.1", "eventsUrl": "/api/events", "workspaceRoot": root,
        "addresses": [], "localRequest": true, "sidecarsAllowed": true,
        "serversUsable": false, "serversManageable": false, "secretEntryAllowed": false,
        "system": { "platform": if cfg!(windows) { "win32" } else { std::env::consts::OS },
            "arch": if cfg!(target_arch = "x86_64") { "x64" } else { std::env::consts::ARCH } },
        "serverVersion": config::VERSION, "ui": ui
    });
    if let Some(tls) = tls {
        let address = tls.socket.local_addr()?;
        meta["remoteUrl"] = json!(tls.origin);
        meta["remotePort"] = json!(address.port());
        meta["tlsFingerprint"] = json!(tls.fingerprint);
        // The remote listener's interface, as `serverMeta.host` and `listeningMode` follow it.
        if !address.ip().is_loopback() {
            (meta["host"], meta["hostLabel"], meta["listeningMode"]) =
                (json!(address.ip()), json!(address.ip()), json!("all"));
        }
    }
    Ok(meta)
}

/// `resolveUpdateFeed`: the saved feed, else the installed build's label.
fn update_feed(server: &crate::settings::document::Doc) -> &'static str {
    match server.get("updateFeed").and_then(Value::as_str) {
        Some("preview") => "preview",
        Some("stable") => "stable",
        _ if regex::Regex::new(r"(?i)-dev[.-]").unwrap().is_match(config::VERSION) => "preview",
        _ => "stable",
    }
}
