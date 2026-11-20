//! `GET /api/meta`: the server identity, its listeners and capabilities.
use std::{
    fs,
    io::{ErrorKind, Write},
    path::Path,
    time::Duration,
};

use axum::{Extension, Json, Router, extract::State, routing::get};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{Shared, auth::tls, bench, config};

/// CodeNomad, feat/multi-backend 03743cd51c093bd2bcc391e84b3e09697c4694bf
const API_CONTRACT: u32 = 1;

pub fn routes() -> Router<Shared> {
    Router::new().route("/api/meta", get(read))
}

async fn read(State(app): State<Shared>, channel: Option<Extension<tls::Channel>>) -> Json<Value> {
    let mut meta = app.meta.clone();
    if channel.is_some() {
        meta["localRequest"] = json!(false);
        meta["previewsUnavailable"] = json!(true);
    }
    Json(meta)
}

pub fn document(
    identity: &Path,
    port: u16,
    root: &Path,
    tls: Option<&tls::Listener>,
    ui: Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    let mut capabilities = vec!["workspaces", "events", "workspace-files", "workspace-git", "linked-worktrees"];
    if bench::missions_run() {
        capabilities.push("missions");
    }
    let mut meta = json!({
        "serverId": server_id(identity)?, "apiContract": API_CONTRACT, "capabilities": capabilities,
        "localUrl": format!("http://127.0.0.1:{port}"), "localPort": port, "host": "127.0.0.1",
        "listeningMode": "local", "hostLabel": "127.0.0.1", "eventsUrl": "/api/events", "workspaceRoot": root,
        "addresses": [], "localRequest": true, "sidecarsAllowed": false,
        "serversUsable": false, "serversManageable": false, "secretEntryAllowed": false,
        "system": { "platform": if cfg!(windows) { "win32" } else { std::env::consts::OS },
            "arch": if cfg!(target_arch = "x86_64") { "x64" } else { std::env::consts::ARCH } },
        "serverVersion": config::VERSION, "ui": ui, "updateFeed": "stable"
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

/// `{"serverId"}` in a `.json` file (bench), else the reference's bare UUID (`config.yaml.server-id`).
fn server_id(path: &Path) -> Result<Uuid, Box<dyn std::error::Error>> {
    let json = path.extension().is_some_and(|e| e == "json");
    if let Some(parent) = path.parent().filter(|_| !json) {
        fs::create_dir_all(parent)?;
    }
    match fs::OpenOptions::new().create_new(true).write(true).open(path) {
        Ok(mut file) => {
            let id = Uuid::new_v4();
            let text = if json { json!({"serverId": id}).to_string() } else { id.to_string() };
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            Ok(id)
        }
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            // An independent boot may still be writing its exclusive claim.
            for _ in 0..50 {
                let text = fs::read_to_string(path)?;
                let id = if json {
                    serde_json::from_str::<Value>(&text)
                        .ok()
                        .and_then(|v| serde_json::from_value(v["serverId"].clone()).ok())
                } else {
                    Uuid::parse_str(text.trim()).ok()
                };
                if let Some(id) = id {
                    return Ok(id);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err("Invalid server identity file (left untouched)".into())
        }
        Err(e) => Err(e.into()),
    }
}
