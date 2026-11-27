//! `GET /api/meta`: the server identity, its listeners and capabilities.
pub(crate) mod releases;
use std::path::Path;

use axum::{Extension, Json, Router, extract::State, routing::get};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{Shared, auth::tls, bench, config};

/// CodeNomad `meta-contract.ts`.
const API_CONTRACT: u32 = 1;

pub fn routes() -> Router<Shared> {
    Router::new().route("/api/meta", get(read))
}

async fn read(State(app): State<Shared>, channel: Option<Extension<tls::Channel>>) -> Json<Value> {
    let mut meta = app.meta.clone();
    app.releases.update_feed(&app.settings);
    let (feed, update, latest_stable) = app.releases.snapshot();
    meta["updateFeed"] = json!(feed);
    if let Some(update) = update {
        meta["update"] = update;
    }
    if let Some((version, url)) = latest_stable {
        meta["support"] = json!({
            "supported": true,
            "latestServerVersion": version,
            "latestServerUrl": url,
        });
    }
    if app.temporary_workspaces.is_some()
        && let Some(caps) = meta.get_mut("capabilities").and_then(Value::as_array_mut)
        && !caps.iter().any(|c| c == "temporary-workspaces")
    {
        caps.push(json!("temporary-workspaces"));
    }
    if channel.is_some() {
        // SideCar content stays host-only: the direct HTTPS opt-in is not served here.
        (meta["localRequest"], meta["sidecarsAllowed"]) = (json!(false), json!(false));
        if app.devices.as_ref().is_none_or(|devices| !devices.lock().unwrap().previews_allowed_for_remote()) {
            meta["previewsUnavailable"] = json!(true);
        }
    }
    Json(meta)
}

pub fn document(
    server_id: Option<Uuid>,
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
        "plugin-controls",
        "websearch-settings",
        "image-settings",
        "remote-control",
        "settings-atomic-patches",
        "conversation-permissions",
    ];
    if config::serve() || bench::missions_run() {
        capabilities.push("missions");
    }
    let mut meta = json!({
        "apiContract": API_CONTRACT, "capabilities": capabilities,
        "localUrl": format!("http://127.0.0.1:{port}"), "localPort": port, "host": "127.0.0.1",
        "listeningMode": "local", "hostLabel": "127.0.0.1", "eventsUrl": "/api/events", "workspaceRoot": root,
        "addresses": [], "localRequest": true, "sidecarsAllowed": true,
        "serversUsable": false, "serversManageable": false, "secretEntryAllowed": false,
        "system": { "platform": if cfg!(windows) { "win32" } else { std::env::consts::OS },
            "arch": if cfg!(target_arch = "x86_64") { "x64" } else { std::env::consts::ARCH } },
        "serverVersion": config::VERSION, "ui": ui
    });
    if let Some(server_id) = server_id {
        meta["serverId"] = json!(server_id);
    }
    if let Some(tls) = tls {
        let address = tls.socket.local_addr()?;
        meta["remoteUrl"] = json!(tls.origin);
        meta["remotePort"] = json!(address.port());
        meta["tlsFingerprint"] = json!(tls.fingerprint);
        meta["addresses"] = json!(tls.addresses);
        // The remote listener's interface, as `serverMeta.host` and `listeningMode` follow it.
        if !address.ip().is_loopback() {
            (meta["host"], meta["hostLabel"], meta["listeningMode"]) =
                (json!(address.ip()), json!(address.ip()), json!("all"));
        }
    }
    Ok(meta)
}

/// `resolveUpdateFeed`: the saved feed, else the installed build's label.
pub(crate) fn update_feed(server: &crate::settings::document::Doc) -> &'static str {
    match server.get("updateFeed").and_then(Value::as_str) {
        Some("preview") => "preview",
        Some("stable") => "stable",
        _ if {
            let label = config::VERSION.to_ascii_lowercase();
            label.contains("-dev-") || label.contains("-dev.")
        } =>
        {
            "preview"
        }
        _ => "stable",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_omits_server_id_when_unavailable() {
        let root = std::env::temp_dir();
        let without = document(None, 9899, &root, None, json!({})).unwrap();
        assert!(without.get("serverId").is_none());

        let id = Uuid::new_v4();
        let with = document(Some(id), 9899, &root, None, json!({})).unwrap();
        assert_eq!(with["serverId"], json!(id));
    }
}
