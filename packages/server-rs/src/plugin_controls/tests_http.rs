//! End-to-end HTTP integration tests for `/api/workspaces/:id/plugin-controls` and
//! `/api/workspaces/:id/plugin-sources` (Fastify parity, JSONC preservation, activation toggles,
//! source add/remove, dependent-rule refusal, stale revision conflict, add timeout, Remote Control,
//! local auth, and `/api/meta` capabilities).

use std::{
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    http::{Method, StatusCode as Status, header},
    middleware,
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{App, Workspace, auth, files, meta, opencode::Native, settings, subagent_depth::jsonc, worktrees::fence};

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct MockState {
    global_dir: PathBuf,
    global_file: PathBuf,
    project_file: PathBuf,
    extra_docs: Vec<Value>,
    runtime: Vec<Value>,
    versions_rpc: Vec<Value>,
    config_delay: Duration,
}

fn parse_jsonc_file(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    let text = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    let (v, err) = jsonc::parse(&jsonc::utf16(text), true);
    if err {
        return None;
    }
    Some(super::doc::j_to_json(&v?))
}

async fn fake_native(
    State(state): State<Arc<Mutex<MockState>>>,
    method: Method,
    uri: axum::http::Uri,
    Query(_q): Query<Vec<(String, String)>>,
) -> Response {
    let delay = state.lock().unwrap().config_delay;
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    let path = uri.path();
    if method == Method::GET && path == "/api/config" {
        let s = state.lock().unwrap();
        let mut entries = vec![json!({ "type": "directory", "path": s.global_dir.to_string_lossy() })];
        if let Some(v) = parse_jsonc_file(&s.global_file) {
            entries.push(json!({ "type": "document", "path": s.global_file.to_string_lossy(), "info": v }));
        }
        entries.extend(s.extra_docs.clone());
        if let Some(v) = parse_jsonc_file(&s.project_file) {
            entries.push(json!({ "type": "document", "path": s.project_file.to_string_lossy(), "info": v }));
        }
        return (Status::OK, Json(Value::Array(entries))).into_response();
    }
    if method == Method::GET && path == "/api/plugin" {
        let s = state.lock().unwrap();
        return (Status::OK, Json(json!({ "data": s.runtime }))).into_response();
    }
    if method == Method::POST && path == "/api/rpc/codenomad.plugin-versions/list" {
        let s = state.lock().unwrap();
        return (Status::OK, Json(json!({ "output": s.versions_rpc }))).into_response();
    }
    Status::NOT_FOUND.into_response()
}

struct Harness {
    _dir: TempDir,
    app: Arc<App>,
    mock: Arc<Mutex<MockState>>,
    client: reqwest::Client,
    base: String,
    server_addr: SocketAddr,
    native_addr: SocketAddr,
    workspace_id: String,
    _global_dir: PathBuf,
    global_file: PathBuf,
    project_dir: PathBuf,
    project_file: PathBuf,
    native_task: tokio::task::JoinHandle<()>,
    server_task: tokio::task::JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.native_task.abort();
        self.server_task.abort();
    }
}

impl Harness {
    async fn new(with_auth: bool) -> Self {
        let raw_root = std::env::temp_dir().join(format!("cn-pc-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&raw_root).unwrap();
        let root = dunce::canonicalize(&raw_root).unwrap();
        let data = root.join("data");
        let global_dir = root.join("global-config");
        let project_dir = root.join("project");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&global_dir).unwrap();
        fs::create_dir_all(&project_dir).unwrap();

        let global_file = global_dir.join("opencode.jsonc");
        let project_file = project_dir.join("opencode.jsonc");

        let mock = Arc::new(Mutex::new(MockState {
            global_dir: global_dir.clone(),
            global_file: global_file.clone(),
            project_file: project_file.clone(),
            extra_docs: Vec::new(),
            runtime: Vec::new(),
            versions_rpc: Vec::new(),
            config_delay: Duration::ZERO,
        }));

        let native_router = Router::new().fallback(any(fake_native)).with_state(mock.clone());
        let native_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native_addr = native_listener.local_addr().unwrap();
        let native_task = tokio::spawn(async move {
            axum::serve(native_listener, native_router).await.unwrap();
        });

        let auth_mgr = auth::Auth::new(auth::Settings {
            username: "codenomad".into(),
            password: Some("test-secret".into()),
            file: None,
            cookie: "cn_test".into(),
            token: false,
            managed_local: false,
            skip: !with_auth,
            idle: Duration::from_secs(600),
            absolute: Duration::from_secs(3600),
        })
        .unwrap();
        let remote_origin = "https://192.168.1.30:4443".to_owned();
        let devices = Some(auth::devices::open_for_test(&data, remote_origin.clone(), vec![remote_origin]));
        let (watch_tx, _watch_rx) = tokio::sync::mpsc::channel(8);
        let settings_mgr =
            settings::Settings::new(settings::document::Location::resolve(data.join("config.yaml").to_str().unwrap()));
        let server_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server_addr = server_listener.local_addr().unwrap();
        let app = Arc::new(App::new(
            auth_mgr,
            server_addr.port(),
            data,
            root.clone(),
            true,
            settings_mgr,
            json!({}),
            Native::test_connection(native_addr),
            "opencode".into(),
            devices,
            files::watch::Watches::new(watch_tx),
            None,
        ));

        let workspace_uuid = Uuid::new_v4();
        let workspace_id = workspace_uuid.to_string();
        app.inner.lock().unwrap().workspaces.push(Workspace {
            id: workspace_uuid,
            request_id: None,
            path: project_dir.clone(),
            name: None,
            status: "ready",
            proxy_path: format!("/workspaces/{workspace_id}/instance"),
            binary_id: PathBuf::from("opencode"),
            binary_label: "opencode".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            location: json!({ "directory": project_dir.to_string_lossy() }),
        });

        let router =
            super::routes().layer(middleware::from_fn_with_state(app.clone(), auth::admit)).with_state(app.clone());
        let server_task = tokio::spawn(async move {
            axum::serve(server_listener, router).await.unwrap();
        });

        Self {
            _dir: TempDir(root),
            app,
            mock,
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            base: format!("http://{server_addr}"),
            server_addr,
            native_addr,
            workspace_id,
            _global_dir: global_dir,
            global_file,
            project_dir,
            project_file,
            native_task,
            server_task,
        }
    }

    fn url(&self, suffix: &str) -> String {
        format!("{}/api/workspaces/{}{}", self.base, self.workspace_id, suffix)
    }

    fn path(&self, suffix: &str) -> String {
        format!("/api/workspaces/{}{}", self.workspace_id, suffix)
    }

    fn project_str(&self) -> String {
        self.project_dir.to_string_lossy().into_owned()
    }
}

fn encode_q(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

async fn send_raw_http(addr: SocketAddr, raw: &str, half_close: bool) -> String {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream.write_all(raw.as_bytes()).await.unwrap();
    if half_close {
        let _ = stream.shutdown().await;
    }
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut buf)).await;
    String::from_utf8_lossy(&buf).into_owned()
}

#[tokio::test]
async fn plugin_controls_read_and_patch_preserve_jsonc_and_enforce_rules() {
    let h = Harness::new(false).await;
    let project = h.project_str();
    let git_rev = "0123456789abcdef0123456789abcdef01234567";
    fs::write(
        &h.global_file,
        "\u{feff}{\r\n  // keep global\r\n  \"plugins\": [\r\n    \"acme-pkg@1.0.0\",\r\n    \"github:org/gitplug#main\"\r\n  ]\r\n}\r\n",
    )
    .unwrap();
    fs::write(&h.project_file, "{\n  \"plugins\": [\n    \"-orphan.id\"\n  ]\n}\n").unwrap();
    {
        let mut s = h.mock.lock().unwrap();
        s.runtime = vec![
            json!({
                "id": "acme.plugin",
                "source": { "type": "package", "target": "acme-pkg@1.0.0", "version": "1.0.0" },
                "features": { "server": true, "rpc": true },
                "state": { "status": "active" }
            }),
            json!({
                "id": "org.gitplug",
                "source": { "type": "package", "target": "github:org/gitplug#main", "version": git_rev },
                "features": { "gui": true },
                "state": { "status": "active" }
            }),
            json!({
                "id": "opencode.builtin",
                "source": { "type": "builtin" },
                "features": { "server": true },
                "state": { "status": "active" }
            }),
        ];
        s.versions_rpc = vec![json!({
            "target": "github:org/gitplug#main",
            "revision": git_rev,
            "version": "2.4.1"
        })];
    }

    // 1. GET snapshot returns runtime (with Git manifest version), configured sources/rules,
    // controls (including orphan), and expectedRevision for both consistent targets.
    let get_url = format!("{}?directory={}", h.url("/plugin-controls"), encode_q(&project));
    let snap: Value = h.client.get(&get_url).send().await.unwrap().json().await.unwrap();
    let git_rt = snap["runtime"].as_array().unwrap().iter().find(|r| r["id"] == "org.gitplug").unwrap();
    assert_eq!(git_rt["source"]["version"], "2.4.1");
    assert_eq!(git_rt["source"]["revision"], git_rev);
    assert_eq!(git_rt["features"]["gui"], true);

    let orphan = snap["controls"].as_array().unwrap().iter().find(|c| c["id"] == "orphan.id").unwrap();
    assert_eq!(orphan["orphan"], true);
    let global_target = snap["targets"].as_array().unwrap().iter().find(|t| t["scope"] == "global").unwrap();
    let project_target = snap["targets"].as_array().unwrap().iter().find(|t| t["scope"] == "project").unwrap();
    assert_eq!(global_target["expectedRevision"].as_str().unwrap().len(), 64);
    assert_eq!(project_target["expectedRevision"].as_str().unwrap().len(), 64);

    // 2. PATCH disables acme.plugin in global, preserving BOM, CRLF, and comments.
    let disable: Value = h
        .client
        .patch(h.url("/plugin-controls"))
        .json(&json!({
            "location": { "directory": project },
            "pluginId": "acme.plugin",
            "scope": "global",
            "enabled": false
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(disable["changed"], true);
    assert_eq!(disable["reloadPending"], true);
    assert_eq!(disable["rule"], "-acme.plugin");
    let raw_global = fs::read_to_string(&h.global_file).unwrap();
    assert!(raw_global.starts_with('\u{feff}'));
    assert!(raw_global.contains("// keep global"));
    assert!(!raw_global.replace("\r\n", "").contains('\n'));
    assert_eq!(
        parse_jsonc_file(&h.global_file).unwrap()["plugins"],
        json!(["acme-pkg@1.0.0", "github:org/gitplug#main", "-acme.plugin"])
    );

    // 3. Repeating the exact same disable is a no-op (`changed: false`).
    let noop: Value = h
        .client
        .patch(h.url("/plugin-controls"))
        .json(&json!({
            "location": { "directory": project },
            "pluginId": "acme.plugin",
            "scope": "global",
            "enabled": false
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(noop["changed"], false);
    assert_eq!(noop["reloadPending"], false);

    // 4. Re-enabling in global removes `-acme.plugin` without growing the plugins array.
    let reenable: Value = h
        .client
        .patch(h.url("/plugin-controls"))
        .json(&json!({
            "location": { "directory": project },
            "pluginId": "acme.plugin",
            "scope": "global",
            "enabled": true
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reenable["changed"], true);
    assert_eq!(
        parse_jsonc_file(&h.global_file).unwrap()["plugins"],
        json!(["acme-pkg@1.0.0", "github:org/gitplug#main"])
    );

    // 5. Enabling orphan.id (no preceding verified definition) is refused with 403 before any write.
    let refuse_orphan = h
        .client
        .patch(h.url("/plugin-controls"))
        .json(&json!({
            "location": { "directory": project },
            "pluginId": "orphan.id",
            "scope": "global",
            "enabled": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(refuse_orphan.status(), Status::FORBIDDEN);

    // 6. Retired `workspaceID` passes Zod validation but fails ownership with 403; empty fails with 400.
    let retired_ws = h
        .client
        .get(format!("{}?directory={}&workspaceID=legacy-ws", h.url("/plugin-controls"), encode_q(&project)))
        .send()
        .await
        .unwrap();
    assert_eq!(retired_ws.status(), Status::FORBIDDEN);

    let empty_ws = h
        .client
        .get(format!("{}?directory={}&workspaceID=", h.url("/plugin-controls"), encode_q(&project)))
        .send()
        .await
        .unwrap();
    assert_eq!(empty_ws.status(), Status::BAD_REQUEST);
    assert_eq!(empty_ws.json::<Value>().await.unwrap(), json!({ "error": "Invalid plugin activation request" }));

    // 7. Unknown plugin ID -> 403; worktree deletion fence -> 409; unsupported POST -> 404.
    let unknown_id = h
        .client
        .patch(h.url("/plugin-controls"))
        .json(&json!({
            "location": { "directory": project },
            "pluginId": "unknown.plugin",
            "scope": "global",
            "enabled": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown_id.status(), Status::FORBIDDEN);

    let _blocked = fence::block(&[fence::identity(&h.project_dir)]).await.unwrap();
    let fenced = h
        .client
        .patch(h.url("/plugin-controls"))
        .json(&json!({
            "location": { "directory": project },
            "pluginId": "acme.plugin",
            "scope": "global",
            "enabled": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(fenced.status(), Status::CONFLICT);
    drop(_blocked);

    let bad_method = h.client.post(h.url("/plugin-controls")).send().await.unwrap();
    assert_eq!(bad_method.status(), Status::NOT_FOUND);
    assert_eq!(bad_method.json::<Value>().await.unwrap(), json!({ "message": "Not Found" }));
}

#[tokio::test]
async fn plugin_sources_add_remove_dependent_rules_stale_and_timeout() {
    let h = Harness::new(false).await;
    let project = h.project_str();
    fs::write(&h.global_file, "{\n  \"plugins\": [\n    \"acme-pkg@1.0.0\",\n    \"-acme.plugin\"\n  ]\n}\n").unwrap();
    fs::write(&h.project_file, "{\n  \"plugins\": [\n    \"acme.plugin\",\n    \"-orphan.id\"\n  ]\n}\n").unwrap();
    {
        let mut s = h.mock.lock().unwrap();
        s.runtime = vec![json!({
            "id": "acme.plugin",
            "source": { "type": "package", "target": "acme-pkg@1.0.0", "version": "1.0.0" },
            "features": { "server": true },
            "state": { "status": "active" }
        })];
    }

    // 1. POST rejects invalid spec / local path / selector / duplicate / known plugin ID with stable codes.
    let local_err = h
        .client
        .post(h.url("/plugin-sources"))
        .json(&json!({ "location": { "directory": project }, "scope": "global", "spec": "./local-plugin" }))
        .send()
        .await
        .unwrap();
    assert_eq!(local_err.status(), Status::UNPROCESSABLE_ENTITY);
    assert_eq!(
        local_err.json::<Value>().await.unwrap(),
        json!({ "error": "Plugin source update refused", "code": "local-path" })
    );

    let dup_err = h
        .client
        .post(h.url("/plugin-sources"))
        .json(&json!({ "location": { "directory": project }, "scope": "project", "spec": "ACME-PKG@2.0.0" }))
        .send()
        .await
        .unwrap();
    assert_eq!(dup_err.status(), Status::CONFLICT);
    assert_eq!(
        dup_err.json::<Value>().await.unwrap(),
        json!({ "error": "Plugin source update refused", "code": "duplicate" })
    );

    let id_err = h
        .client
        .post(h.url("/plugin-sources"))
        .json(&json!({ "location": { "directory": project }, "scope": "global", "spec": "acme.plugin" }))
        .send()
        .await
        .unwrap();
    assert_eq!(id_err.status(), Status::UNPROCESSABLE_ENTITY);
    assert_eq!(
        id_err.json::<Value>().await.unwrap(),
        json!({ "error": "Plugin source update refused", "code": "plugin-id" })
    );

    // 2. POST adds a valid registry spec to Project.
    let added = h
        .client
        .post(h.url("/plugin-sources"))
        .json(&json!({ "location": { "directory": project }, "scope": "project", "spec": "@scope/new-pkg@^1.0.0" }))
        .send()
        .await
        .unwrap();
    assert_eq!(added.status(), Status::OK);
    assert_eq!(
        added.json::<Value>().await.unwrap(),
        json!({ "scope": "project", "spec": "@scope/new-pkg@^1.0.0", "reloadPending": true })
    );
    assert_eq!(
        parse_jsonc_file(&h.project_file).unwrap()["plugins"],
        json!(["acme.plugin", "-orphan.id", "@scope/new-pkg@^1.0.0"])
    );

    // 3. DELETE with stale/wrong expectedRevision returns 409 { code: "stale" }.
    let stale_del = h
        .client
        .delete(h.url("/plugin-sources"))
        .json(&json!({
            "location": { "directory": project },
            "scope": "global",
            "target": "acme-pkg@1.0.0",
            "entryIndex": 0,
            "expectedRevision": "0".repeat(64)
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(stale_del.status(), Status::CONFLICT);
    assert_eq!(
        stale_del.json::<Value>().await.unwrap(),
        json!({ "error": "Plugin source update refused", "code": "stale" })
    );

    // 4. Dependent bare `acme.plugin` in a non-writable virtual/inline document refuses removal with 422 `dependent-rule`.
    let get_url = format!("{}?directory={}", h.url("/plugin-controls"), encode_q(&project));
    let snap: Value = h.client.get(&get_url).send().await.unwrap().json().await.unwrap();
    let global_rev =
        snap["targets"].as_array().unwrap().iter().find(|t| t["scope"] == "global").unwrap()["expectedRevision"]
            .as_str()
            .unwrap()
            .to_owned();
    h.mock.lock().unwrap().extra_docs = vec![json!({ "type": "document", "info": { "plugins": ["acme.plugin"] } })];
    let dep_refused = h
        .client
        .delete(h.url("/plugin-sources"))
        .json(&json!({
            "location": { "directory": project },
            "scope": "global",
            "target": "acme-pkg@1.0.0",
            "entryIndex": 0,
            "expectedRevision": global_rev
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(dep_refused.status(), Status::UNPROCESSABLE_ENTITY);
    assert_eq!(
        dep_refused.json::<Value>().await.unwrap(),
        json!({ "error": "Plugin source update refused", "code": "dependent-rule" })
    );
    h.mock.lock().unwrap().extra_docs.clear();

    // 5. Once `@scope/new-pkg@^1.0.0` has a reported runtime ID, no unidentified declaration remains:
    // removing Global `acme-pkg@1.0.0` removes its `-acme.plugin` in Global AND the dependent bare
    // `acme.plugin` in Project atomically (leaving Project's other entries intact).
    h.mock.lock().unwrap().runtime.push(json!({
        "id": "scope.new",
        "source": { "type": "package", "target": "@scope/new-pkg@^1.0.0", "version": "1.0.0" },
        "features": { "server": true },
        "state": { "status": "active" }
    }));
    let del_ok = h
        .client
        .delete(h.url("/plugin-sources"))
        .json(&json!({
            "location": { "directory": project },
            "scope": "global",
            "target": "acme-pkg@1.0.0",
            "entryIndex": 0,
            "expectedRevision": global_rev
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(del_ok.status(), Status::OK);
    assert_eq!(
        del_ok.json::<Value>().await.unwrap(),
        json!({ "scope": "global", "spec": "acme-pkg@1.0.0", "reloadPending": true })
    );
    assert_eq!(parse_jsonc_file(&h.global_file).unwrap()["plugins"], json!([]));
    assert_eq!(parse_jsonc_file(&h.project_file).unwrap()["plugins"], json!(["-orphan.id", "@scope/new-pkg@^1.0.0"]));

    // 6. Removing orphan `orphan.id` rules from Project succeeds with fresh expectedRevision
    // (only the runtime entry for `@scope/new-pkg@^1.0.0` remains active, so every declaration has an ID).
    h.mock.lock().unwrap().runtime.retain(|r| r["id"] == "scope.new");
    let snap2: Value = h.client.get(&get_url).send().await.unwrap().json().await.unwrap();
    let project_rev =
        snap2["targets"].as_array().unwrap().iter().find(|t| t["scope"] == "project").unwrap()["expectedRevision"]
            .as_str()
            .unwrap()
            .to_owned();
    let del_orphan = h
        .client
        .delete(h.url("/plugin-sources"))
        .json(&json!({
            "location": { "directory": project },
            "scope": "project",
            "pluginId": "orphan.id",
            "expectedRevision": project_rev
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(del_orphan.status(), Status::OK);
    assert_eq!(
        del_orphan.json::<Value>().await.unwrap(),
        json!({ "scope": "project", "spec": "orphan.id", "reloadPending": true })
    );
    assert_eq!(parse_jsonc_file(&h.project_file).unwrap()["plugins"], json!(["@scope/new-pkg@^1.0.0"]));

    // 7. Fastify 5 framing parity: 415 without Connection: close, 400 on float entryIndex, 404 on GET.
    let bad_float = h
        .client
        .delete(h.url("/plugin-sources"))
        .json(&json!({
            "location": { "directory": project },
            "scope": "project",
            "target": "@scope/new-pkg@^1.0.0",
            "entryIndex": 0.5,
            "expectedRevision": project_rev
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_float.status(), Status::BAD_REQUEST);
    assert_eq!(bad_float.json::<Value>().await.unwrap(), json!({ "error": "Invalid plugin source request" }));

    let bad_ct = send_raw_http(
        h.server_addr,
        &format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/octet-stream\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}",
            h.path("/plugin-sources"),
            h.server_addr
        ),
        false,
    )
    .await;
    assert!(bad_ct.starts_with("HTTP/1.1 415 "), "got: {bad_ct}");

    let get_404 = h.client.get(h.url("/plugin-sources")).send().await.unwrap();
    assert_eq!(get_404.status(), Status::NOT_FOUND);

    // 8. Add timeout returns 503 { code: "timeout" } and writes nothing.
    h.mock.lock().unwrap().config_delay = Duration::from_millis(300);
    let timed_out = super::sources::add_with_timeouts(
        &h.app,
        &h.workspace_id,
        super::sources::SourceAddRequest {
            location: super::snapshot::ControlLocation { directory: project.clone(), workspace_id: None },
            scope: crate::opencode_settings::Scope::Global,
            spec: "slow-pkg@1.0.0".into(),
        },
        None,
        Duration::from_millis(40),
        Duration::from_millis(40),
    )
    .await;
    let err = timed_out.err().expect("must time out");
    assert_eq!(err.status, Status::SERVICE_UNAVAILABLE);
    assert_eq!(err.code, Some("timeout"));
    assert_eq!(parse_jsonc_file(&h.global_file).unwrap()["plugins"], json!([]));
    h.mock.lock().unwrap().config_delay = Duration::ZERO;

    // 9. Endpoint replacement invalidates previously issued expectedRevision (409 stale).
    h.app.native.replace_test_endpoint(h.native_addr);
    let after_swap = h
        .client
        .delete(h.url("/plugin-sources"))
        .json(&json!({
            "location": { "directory": project },
            "scope": "project",
            "target": "@scope/new-pkg@^1.0.0",
            "entryIndex": 0,
            "expectedRevision": project_rev
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(after_swap.status(), Status::CONFLICT);
    assert_eq!(after_swap.json::<Value>().await.unwrap()["code"], "stale");
}

#[tokio::test]
async fn remote_control_local_auth_and_meta_capabilities_cover_plugin_controls() {
    let h = Harness::new(true).await;
    fs::write(&h.global_file, "{}").unwrap();
    let project = h.project_str();

    // 1. Local unauthenticated GET -> 401.
    let unauth =
        h.client.get(format!("{}?directory={}", h.url("/plugin-controls"), encode_q(&project))).send().await.unwrap();
    assert_eq!(unauth.status(), Status::UNAUTHORIZED);

    // 2. Pair a browser device over direct HTTPS and exercise `auth::remote::admit`.
    let origin = "https://192.168.1.30:4443";
    let host = "192.168.1.30:4443";
    let issued =
        auth::devices::issue(State(h.app.clone()), axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#)))
            .await;
    assert_eq!(issued.status(), Status::OK);
    let body_bytes = axum::body::to_bytes(issued.into_body(), 16 * 1024).await.unwrap();
    let link = serde_json::from_slice::<Value>(&body_bytes).unwrap();
    let code = link["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();

    let channel = auth::tls::Channel {
        origin: origin.to_owned(),
        origins: Arc::from(vec![origin.to_owned()]),
        ingress: false,
        socket: CancellationToken::new(),
        principal: Arc::new(Mutex::new(None)),
    };
    let remote_router = super::routes()
        .merge(auth::remote_routes())
        .layer(middleware::from_fn_with_state((h.app.clone(), None), auth::remote::admit))
        .layer(Extension(channel))
        .with_state(h.app.clone());
    let remote_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let remote_base = format!("http://{}", remote_listener.local_addr().unwrap());
    let remote_task = tokio::spawn(async move {
        axum::serve(remote_listener, remote_router).await.unwrap();
    });

    let paired = h
        .client
        .post(format!("{remote_base}/api/remote-control/pair"))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .json(&json!({ "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(paired.status(), Status::OK);
    let cookie = paired.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    let remote_url = |suffix: &str| format!("{remote_base}/api/workspaces/{}{suffix}", h.workspace_id);

    let get_ok = h
        .client
        .get(format!("{}?directory={}", remote_url("/plugin-controls"), encode_q(&project)))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(get_ok.status(), Status::OK);

    // Cross-origin CSRF on PATCH without Origin refused with 403.
    let csrf_patch = h
        .client
        .patch(remote_url("/plugin-controls"))
        .header(header::HOST, host)
        .header(header::COOKIE, &cookie)
        .json(&json!({ "location": { "directory": project }, "pluginId": "x", "scope": "global", "enabled": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(csrf_patch.status(), Status::FORBIDDEN);

    let post_ok = h
        .client
        .post(remote_url("/plugin-sources"))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .json(&json!({ "location": { "directory": project }, "scope": "global", "spec": "remote-pkg@1.0.0" }))
        .send()
        .await
        .unwrap();
    assert_eq!(post_ok.status(), Status::OK);

    // Unsupported methods on Remote Control catalog return 404.
    let get_sources = h
        .client
        .get(remote_url("/plugin-sources"))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(get_sources.status(), Status::NOT_FOUND);
    let put_controls = h
        .client
        .put(remote_url("/plugin-controls"))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(put_controls.status(), Status::NOT_FOUND);
    remote_task.abort();

    // 3. `/api/meta` advertises `"plugin-controls"`.
    let doc = meta::document(Uuid::new_v4(), 9898, Path::new("."), None, json!({})).unwrap();
    let caps = doc["capabilities"].as_array().unwrap();
    assert!(caps.iter().any(|c| c == "plugin-controls"), "missing plugin-controls capability: {caps:?}");
}
