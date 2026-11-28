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
        "history-search",
        "config-files",
        "sidecars",
        "service-usage",
        "provider-usage",
        "plugin-controls",
        "integrations",
        "websearch-settings",
        "image-settings",
        "remote-control",
        "opencode-admin",
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
    use std::collections::HashSet;

    const CONTRACT_CAPABILITIES: &[&str] = &[
        "workspaces",
        "workspace-files",
        "workspace-git",
        "events",
        "linked-worktrees",
        "force-worktree-delete",
        "workspace-clone",
        "temporary-workspaces",
        "missions",
        "conversation-permissions",
        "session-goals",
        "history-search",
        "background-shells",
        "plugin-controls",
        "integrations",
        "websearch-settings",
        "image-settings",
        "provider-usage",
        "service-usage",
        "speech",
        "previews",
        "sidecars",
        "remote-control",
        "opencode-admin",
        "config-files",
        "settings-atomic-patches",
    ];

    #[test]
    fn document_omits_server_id_when_unavailable() {
        let root = std::env::temp_dir();
        let without = document(None, 9899, &root, None, json!({})).unwrap();
        assert!(without.get("serverId").is_none());

        let id = Uuid::new_v4();
        let with = document(Some(id), 9899, &root, None, json!({})).unwrap();
        assert_eq!(with["serverId"], json!(id));
    }

    #[tokio::test]
    async fn declared_capabilities_match_contract_and_mounted_routes() {
        let dir = dunce::canonicalize(crate::shared::test_dir("meta-capabilities")).unwrap();
        let doc = document(Some(Uuid::new_v4()), 9899, &dir, None, json!({})).unwrap();
        let caps: Vec<&str> = doc["capabilities"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();

        // No duplicates, every capability belongs to `CODENOMAD_CAPABILITIES`.
        let unique: HashSet<&str> = caps.iter().copied().collect();
        assert_eq!(unique.len(), caps.len(), "duplicate capabilities: {caps:?}");
        for cap in &caps {
            assert!(CONTRACT_CAPABILITIES.contains(cap), "undeclared contract capability: {cap}");
        }

        // Required ported route families are declared; `speech` stays undeclared (no live conversation route).
        for required in ["integrations", "history-search", "opencode-admin"] {
            assert!(unique.contains(required), "missing capability {required} in {caps:?}");
        }
        assert!(!unique.contains("speech"), "speech must remain undeclared while live conversation is unported");

        // Build the real route tree mounted in `main.rs` with a sentinel 418 fallback so any
        // unmounted route returns 418 while mounted route families execute their real handlers.
        let auth = crate::auth::Auth::new(crate::auth::Settings {
            username: "opencode".into(),
            password: None,
            file: None,
            cookie: "cn".into(),
            token: false,
            skip: true,
            managed_local: false,
            idle: std::time::Duration::from_secs(60),
            absolute: std::time::Duration::from_secs(60),
        })
        .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
            dir.join("config.yaml").to_str().unwrap(),
        ));
        let app = std::sync::Arc::new(crate::App::new(
            auth,
            0,
            dir.clone(),
            dir.clone(),
            false,
            settings,
            doc.clone(),
            crate::opencode::Native::connect("opencode").unwrap(),
            std::path::PathBuf::new(),
            None,
            crate::files::watch::Watches::new(tx),
            None,
        ));
        let shutdown = tokio_util::sync::CancellationToken::new();
        let router = Router::new()
            .merge(routes())
            .merge(crate::workspaces::routes())
            .merge(crate::files::routes())
            .merge(crate::git::routes())
            .merge(crate::worktrees::routes())
            .merge(crate::settings::routes())
            .merge(crate::opencode_settings::routes())
            .merge(crate::plugin_controls::routes())
            .merge(crate::integrations::routes())
            .merge(crate::sessions::routes(shutdown))
            .merge(crate::events::routes())
            .merge(crate::sidecars::routes())
            .merge(crate::speech::routes())
            .merge(crate::usage::routes())
            .merge(crate::provider_usage::routes())
            .merge(crate::opencode::routes())
            .merge(crate::opencode::install::routes())
            .merge(crate::auth::local_routes())
            .merge(crate::auth::remote_routes())
            .fallback(|| async { axum::http::StatusCode::IM_A_TEAPOT })
            .layer(axum::Extension(crate::auth::Principal(tokio_util::sync::CancellationToken::new())))
            .with_state(app);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let base = format!("http://{addr}");

        // Each declared capability must map to a mounted route (status != 418).
        let probes: &[(&str, reqwest::Method, &str)] = &[
            ("workspaces", reqwest::Method::GET, "/api/workspaces"),
            ("events", reqwest::Method::POST, "/api/events"),
            ("workspace-files", reqwest::Method::GET, "/api/workspaces/missing/files"),
            ("workspace-git", reqwest::Method::GET, "/api/workspaces/missing/git-branches"),
            ("linked-worktrees", reqwest::Method::GET, "/api/workspaces/missing/worktrees"),
            ("history-search", reqwest::Method::POST, "/api/workspaces/missing/session-history/query"),
            ("config-files", reqwest::Method::GET, "/api/config-files"),
            ("sidecars", reqwest::Method::GET, "/api/sidecars"),
            ("service-usage", reqwest::Method::GET, "/api/workspaces/missing/service-usage"),
            ("provider-usage", reqwest::Method::GET, "/api/usage/openai"),
            ("plugin-controls", reqwest::Method::GET, "/api/workspaces/missing/plugin-controls"),
            ("integrations", reqwest::Method::GET, "/api/workspaces/missing/integrations"),
            ("websearch-settings", reqwest::Method::GET, "/api/workspaces/missing/websearch-settings"),
            ("image-settings", reqwest::Method::GET, "/api/workspaces/missing/image-settings"),
            ("remote-control", reqwest::Method::GET, "/api/remote-control/devices"),
            ("opencode-admin", reqwest::Method::POST, "/api/opencode/service"),
            ("settings-atomic-patches", reqwest::Method::GET, "/api/storage/config/ui"),
            (
                "conversation-permissions",
                reqwest::Method::GET,
                "/api/workspaces/missing/sessions/ses_1/permission-mode",
            ),
        ];
        let probed: HashSet<&str> = probes.iter().map(|(cap, _, _)| *cap).collect();
        for cap in &unique {
            if *cap != "missions" {
                assert!(probed.contains(cap), "declared capability {cap} has no route probe");
            }
        }
        for (capability, method, path) in probes {
            assert!(unique.contains(capability), "probe capability {capability} not declared");
            let resp = client.request(method.clone(), format!("{base}{path}")).send().await.unwrap();
            assert_ne!(
                resp.status(),
                reqwest::StatusCode::IM_A_TEAPOT,
                "declared capability {capability} has unmounted route {method} {path}"
            );
        }
        // Confirm `POST /api/opencode/update` is also mounted (invalid media type -> 415 without touching npm).
        let update_probe = client
            .post(format!("{base}/api/opencode/update"))
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(update_probe.status(), reqwest::StatusCode::UNSUPPORTED_MEDIA_TYPE);

        // Confirm unported live speech route hits the sentinel fallback (explaining why `speech` is undeclared).
        let live_speech = client.post(format!("{base}/api/speech/conversation/live")).send().await.unwrap();
        assert_eq!(live_speech.status(), reqwest::StatusCode::IM_A_TEAPOT);

        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
