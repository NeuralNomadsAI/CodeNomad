use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed},
    },
    time::Duration,
};

use axum::{
    Extension, Json, Router,
    extract::{Request, State},
    http::{Method, StatusCode as Status, header},
    middleware::from_fn_with_state,
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Notify,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{App, Shared, Workspace, auth, extensions, files, opencode::Native, sessions, settings, worktrees::fence};

struct TempDir(PathBuf);
impl TempDir {
    fn new(prefix: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        Self(dunce::canonicalize(&dir).unwrap())
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone)]
struct RpcCall {
    method: String,
    directory: String,
    input: Value,
}

struct NativeMock {
    workspace_root: String,
    linked_dir: Option<String>,
    session_dir: String,
    session_location_null: bool,
    session_workspace_id: Option<Value>,
    session_content_type: String,
    session_metadata: Value,
    session_model: Value,
    session_title: String,
    last_session_path: Option<String>,
    /// When set, switches `session_dir` on the N-th `GET /api/session/:id` call (1-based).
    move_on_get: Option<(usize, String)>,
    session_gets: usize,
    plugin_status: String,
    plugin_polls: usize,
    carrier_owned: Option<bool>,
    carrier_status: Status,
    carrier_content_type: String,
    carrier_raw_body: Option<String>,
    rpc_status: Status,
    rpc_content_type: String,
    rpc_output: Option<Value>,
    pause_rpc: bool,
    rpc_started: Arc<Notify>,
    rpc_release: Arc<Notify>,
    calls: Vec<RpcCall>,
}

impl NativeMock {
    fn new(dir: &str) -> Self {
        Self {
            workspace_root: dir.to_owned(),
            linked_dir: None,
            session_dir: dir.to_owned(),
            session_location_null: false,
            session_workspace_id: None,
            session_content_type: "application/json".into(),
            session_metadata: json!({}),
            session_model: json!({ "providerID": "openai", "id": "gpt" }),
            session_title: "Ordinary".into(),
            last_session_path: None,
            move_on_get: None,
            session_gets: 0,
            plugin_status: "active".into(),
            plugin_polls: 0,
            carrier_owned: Some(false),
            carrier_status: Status::OK,
            carrier_content_type: "application/json".into(),
            carrier_raw_body: None,
            rpc_status: Status::OK,
            rpc_content_type: "application/json".into(),
            rpc_output: None,
            pause_rpc: false,
            rpc_started: Arc::new(Notify::new()),
            rpc_release: Arc::new(Notify::new()),
            calls: Vec::new(),
        }
    }
}

fn raw_response(status: Status, content_type: &str, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, content_type.to_owned())], body).into_response()
}

fn percent_decode(raw: &str) -> String {
    reqwest::Url::parse(&format!("http://127.0.0.1/?v={raw}"))
        .ok()
        .and_then(|u| u.query_pairs().next().map(|(_, v)| v.into_owned()))
        .unwrap_or_else(|| raw.to_owned())
}

async fn fake_native(State(mock): State<Arc<Mutex<NativeMock>>>, req: Request) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let query = req.uri().query().unwrap_or_default().to_owned();
    let body = axum::body::to_bytes(req.into_body(), 2 * 1024 * 1024).await.unwrap_or_default();
    let dir_param = reqwest::Url::parse(&format!("http://127.0.0.1/?{query}"))
        .ok()
        .and_then(|u| u.query_pairs().find(|(k, _)| k == "location[directory]").map(|(_, v)| v.into_owned()))
        .unwrap_or_default();

    if method == Method::GET && path == "/api/location" {
        let root = mock.lock().unwrap().workspace_root.clone();
        let dir = if dir_param.is_empty() { root.clone() } else { dir_param };
        return Json(json!({
            "directory": dir,
            "project": { "id": "prj_1", "directory": root, "canonical": root }
        }))
        .into_response();
    }
    if method == Method::GET && path == "/api/worktree" {
        let (root, linked) = {
            let g = mock.lock().unwrap();
            (g.workspace_root.clone(), g.linked_dir.clone())
        };
        let mut rows = vec![json!({ "directory": root })];
        if let Some(linked) = linked {
            rows.push(json!({ "directory": linked }));
        }
        return Json(json!(rows)).into_response();
    }
    if method == Method::POST && path == "/api/worktree/refresh" {
        return Status::NO_CONTENT.into_response();
    }
    if method == Method::GET && path == "/api/plugin" {
        let status = {
            let mut g = mock.lock().unwrap();
            g.plugin_polls += 1;
            g.plugin_status.clone()
        };
        return Json(json!({
            "location": { "directory": dir_param },
            "data": [{ "id": "codenomad-session-pruning", "state": { "status": status } }]
        }))
        .into_response();
    }
    if method == Method::GET
        && let Some(raw_sid) = path.strip_prefix("/api/session/")
    {
        let sid = percent_decode(raw_sid);
        let (ct, payload) = {
            let mut g = mock.lock().unwrap();
            g.last_session_path = Some(path.clone());
            g.session_gets += 1;
            if let Some((at, next_dir)) = g.move_on_get.clone()
                && g.session_gets >= at
            {
                g.session_dir = next_dir;
            }
            let loc = if g.session_location_null {
                Value::Null
            } else {
                let mut l = json!({ "directory": g.session_dir });
                if let Some(ws) = &g.session_workspace_id {
                    l["workspaceID"] = ws.clone();
                }
                l
            };
            let p = json!({
                "data": {
                    "id": sid,
                    "projectID": "prj_1",
                    "location": loc,
                    "metadata": g.session_metadata,
                    "model": g.session_model,
                    "title": g.session_title,
                }
            });
            (g.session_content_type.clone(), p.to_string())
        };
        return raw_response(Status::OK, &ct, payload);
    }
    if method == Method::POST && path == "/api/rpc/codenomad.missions/scheduleCarrierRead" {
        let (owned, status, ct, raw_body) = {
            let g = mock.lock().unwrap();
            (g.carrier_owned, g.carrier_status, g.carrier_content_type.clone(), g.carrier_raw_body.clone())
        };
        if let Some(raw) = raw_body {
            return raw_response(status, &ct, raw);
        }
        return match owned {
            Some(flag) => raw_response(status, &ct, json!({ "output": { "owned": flag } }).to_string()),
            None => raw_response(Status::INTERNAL_SERVER_ERROR, &ct, json!({ "error": "boom" }).to_string()),
        };
    }
    if method == Method::POST
        && let Some(rpc_method) = path.strip_prefix("/api/rpc/codenomad.session-pruning/")
    {
        let parsed: Value = serde_json::from_slice(&body).unwrap_or_default();
        let (status, ct, out, pause, started, release) = {
            let mut g = mock.lock().unwrap();
            g.calls.push(RpcCall {
                method: rpc_method.to_owned(),
                directory: dir_param,
                input: parsed["input"].clone(),
            });
            (
                g.rpc_status,
                g.rpc_content_type.clone(),
                g.rpc_output.clone(),
                g.pause_rpc,
                g.rpc_started.clone(),
                g.rpc_release.clone(),
            )
        };
        if pause {
            started.notify_one();
            release.notified().await;
        }
        if !status.is_success() {
            return raw_response(status, &ct, json!({ "error": "rpc failure" }).to_string());
        }
        let output = out.unwrap_or_else(|| json!({ "status": "blocked", "reason": "maintenance_required" }));
        return raw_response(status, &ct, json!({ "output": output }).to_string());
    }
    (Status::NOT_FOUND, Json(json!({ "error": format!("unhandled {method} {path}") }))).into_response()
}

fn spawn_readiness_follower(
    lease: PathBuf,
    enabled: Arc<AtomicBool>,
    acks: Arc<AtomicUsize>,
) -> tokio::task::JoinHandle<()> {
    let incarnation = Uuid::new_v4().to_string();
    let prepare_dir = PathBuf::from(format!("{}.prepare", lease.display()));
    let scope_file = lease.with_file_name(format!("{incarnation}.scope"));
    tokio::spawn(async move {
        let mut last_touch = tokio::time::Instant::now();
        loop {
            if enabled.load(Relaxed) {
                if last_touch.elapsed() >= Duration::from_secs(1) {
                    if let Ok(f) = fs::OpenOptions::new().write(true).open(&lease) {
                        let _ = f.set_modified(std::time::SystemTime::now());
                    }
                    last_touch = tokio::time::Instant::now();
                }
                if let Ok(entries) = fs::read_dir(&prepare_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|e| e.to_str()) != Some("json") {
                            continue;
                        }
                        let ack_path = path.with_extension("ack");
                        if ack_path.exists() {
                            continue;
                        }
                        if let Ok(raw) = fs::read(&path)
                            && let Ok(mut req) = serde_json::from_slice::<Value>(&raw)
                            && let Some(dir) = req["directory"].as_str().map(str::to_owned)
                        {
                            let scope = json!({ "version": 1, "directory": dir, "incarnation": incarnation });
                            let _ = fs::write(&scope_file, scope.to_string());
                            req["incarnation"] = json!(incarnation);
                            let _ = fs::write(&ack_path, req.to_string());
                            acks.fetch_add(1, Relaxed);
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
}

struct Harness {
    dir: TempDir,
    workspace_dir: PathBuf,
    workspace_id: String,
    app: Shared,
    mock: Arc<Mutex<NativeMock>>,
    server_addr: SocketAddr,
    base: String,
    client: reqwest::Client,
    lease_path: PathBuf,
    follower_enabled: Arc<AtomicBool>,
    readiness_acks: Arc<AtomicUsize>,
    _readiness: Option<extensions::lifecycle::TestReadinessGuard>,
    follower_task: tokio::task::JoinHandle<()>,
    native_task: tokio::task::JoinHandle<()>,
    server_task: tokio::task::JoinHandle<()>,
}

impl Harness {
    async fn new(skip_auth: bool) -> Self {
        let dir = TempDir::new("cn-pruning");
        let workspace_dir = dir.0.join("repo");
        let config_dir = dir.0.join("config");
        let leases_dir = dir.0.join("leases");
        fs::create_dir_all(&workspace_dir).unwrap();
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&leases_dir).unwrap();
        let workspace_dir = dunce::canonicalize(&workspace_dir).unwrap();
        let lease_path = leases_dir.join(format!("{}.lease", Uuid::new_v4()));
        fs::write(&lease_path, "{}").unwrap();

        let mock = Arc::new(Mutex::new(NativeMock::new(&workspace_dir.to_string_lossy())));
        let native_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native = Native::test_connection(native_listener.local_addr().unwrap());
        let mock_clone = mock.clone();
        let native_task = tokio::spawn(async move {
            axum::serve(native_listener, Router::new().fallback(any(fake_native)).with_state(mock_clone))
                .await
                .unwrap();
        });

        let server_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server_addr = server_listener.local_addr().unwrap();

        let auth = auth::Auth::new(auth::Settings {
            username: "fixture".into(),
            password: Some("secret-pass".into()),
            file: None,
            cookie: "codenomad_session".into(),
            token: false,
            managed_local: false,
            skip: skip_auth,
            idle: Duration::from_secs(60),
            absolute: Duration::from_secs(60),
        })
        .unwrap();
        let remote_origin = "https://192.168.1.20:4443".to_owned();
        let devices = auth::devices::open_for_test(&config_dir, remote_origin.clone(), vec![remote_origin]);
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let settings = settings::Settings::new(settings::document::Location::resolve(
            config_dir.join("config.yaml").to_str().unwrap(),
        ));
        let app = Arc::new(App::new(
            auth,
            server_addr.port(),
            dir.0.clone(),
            dir.0.clone(),
            false,
            settings,
            json!({}),
            native,
            PathBuf::new(),
            Some(devices),
            files::watch::Watches::new(tx),
            None,
        ));
        let ws_id = Uuid::new_v4();
        let now = crate::now();
        app.inner.lock().unwrap().workspaces.push(Workspace {
            id: ws_id,
            request_id: None,
            path: workspace_dir.clone(),
            name: None,
            status: "ready",
            proxy_path: format!("/workspaces/{ws_id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: now.clone(),
            updated_at: now,
            location: json!({ "directory": workspace_dir.to_string_lossy() }),
            temporary: None,
        });
        let workspace_id = ws_id.to_string();

        let readiness =
            extensions::lifecycle::install_test_readiness_lease(app.native.endpoint().unwrap(), lease_path.clone());
        let follower_enabled = Arc::new(AtomicBool::new(true));
        let readiness_acks = Arc::new(AtomicUsize::new(0));
        let follower_task =
            spawn_readiness_follower(lease_path.clone(), follower_enabled.clone(), readiness_acks.clone());

        let router = Router::new()
            .merge(sessions::routes(CancellationToken::new()))
            .layer(from_fn_with_state(app.clone(), auth::admit))
            .with_state(app.clone());
        let server_task = tokio::spawn(async move {
            axum::serve(server_listener, router).await.unwrap();
        });

        Self {
            dir,
            workspace_dir,
            workspace_id,
            app,
            mock,
            server_addr,
            base: format!("http://{server_addr}"),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            lease_path,
            follower_enabled,
            readiness_acks,
            _readiness: Some(readiness),
            follower_task,
            native_task,
            server_task,
        }
    }

    fn url(&self, suffix: &str) -> String {
        format!("{}/api/workspaces/{}{suffix}", self.base, self.workspace_id)
    }

    fn path(&self, suffix: &str) -> String {
        format!("/api/workspaces/{}{suffix}", self.workspace_id)
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.follower_task.abort();
        self.server_task.abort();
        self.native_task.abort();
    }
}

fn rev(ch: char) -> String {
    std::iter::repeat_n(ch, 64).collect()
}

async fn send_raw_http(addr: SocketAddr, req: &str, half_close: bool) -> String {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    stream.write_all(req.as_bytes()).await.unwrap();
    if half_close {
        let _ = stream.shutdown().await;
    }
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut buf)).await;
    String::from_utf8_lossy(&buf).into_owned()
}

#[tokio::test]
async fn preview_and_prune_pin_rpc_method_location_and_validate_inputs_and_outputs() {
    let h = Harness::new(true).await;
    let rev_a = rev('a');
    let rev_b = rev('b');

    // 1. Preview accepts IDs only, uses fixed "preview" method, strips extra part fields,
    //    exercises the real readiness nonce/ACK handshake, and accepts up to 100,001 parts.
    h.mock.lock().unwrap().rpc_output = Some(json!({
        "status": "preview",
        "revision": rev_a,
        "liveMutation": false,
        "parts": [{ "index": 0, "type": "tool", "bytes": 128, "extra": "dropped" }]
    }));
    let resp = h
        .client
        .post(h.url("/session-pruning/preview"))
        .json(&json!({ "sessionID": "ses a/b#c", "messageID": "m" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), Status::OK);
    assert_eq!(
        resp.json::<Value>().await.unwrap(),
        json!({
            "status": "preview",
            "revision": rev_a,
            "liveMutation": false,
            "parts": [{ "index": 0, "type": "tool", "bytes": 128 }]
        })
    );
    assert!(h.readiness_acks.load(Relaxed) >= 1, "real readiness nonce/ACK handshake must run");
    {
        let g = h.mock.lock().unwrap();
        assert_eq!(g.last_session_path.as_deref(), Some("/api/session/ses%20a%2Fb%23c"));
        assert_eq!(g.calls.len(), 1);
        assert_eq!(g.calls[0].method, "preview");
        assert_eq!(g.calls[0].directory, h.workspace_dir.to_string_lossy());
        assert_eq!(g.calls[0].input, json!({ "sessionID": "ses a/b#c", "messageID": "m" }));
    }

    // Large valid preview (100,001 parts, matching TS planner.ts max) must succeed.
    let large_parts: Vec<Value> = (0..100_001u64).map(|i| json!({ "index": i, "type": "tool", "bytes": 32 })).collect();
    h.mock.lock().unwrap().rpc_output = Some(json!({
        "status": "preview",
        "revision": rev_a,
        "liveMutation": false,
        "parts": large_parts,
    }));
    let big_resp = h
        .client
        .post(h.url("/session-pruning/preview"))
        .json(&json!({ "sessionID": "ses_single", "messageID": "m" }))
        .send()
        .await
        .unwrap();
    assert_eq!(big_resp.status(), Status::OK);
    let big_json: Value = big_resp.json().await.unwrap();
    assert_eq!(big_json["status"], "preview");
    assert_eq!(big_json["parts"].as_array().unwrap().len(), 100_001);

    // UTF-16 ID boundaries: 128 astral chars (256 UTF-16 code units) pass; 129 (258 units) -> 400.
    let astral_256 = "😀".repeat(128);
    let astral_258 = "😀".repeat(129);
    h.mock.lock().unwrap().rpc_output =
        Some(json!({ "status": "preview", "revision": rev_a, "liveMutation": false, "parts": [] }));
    let ok_u16 = h
        .client
        .post(h.url("/session-pruning/preview"))
        .json(&json!({ "sessionID": astral_256, "messageID": astral_256 }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok_u16.status(), Status::OK);
    assert_eq!(ok_u16.json::<Value>().await.unwrap()["status"], "preview");
    let bad_u16 = h
        .client
        .post(h.url("/session-pruning/preview"))
        .json(&json!({ "sessionID": astral_258, "messageID": "m" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_u16.status(), Status::BAD_REQUEST);

    // 2. Prune forwards exact schema-checked body and returns pruned receipt or blocked reason.
    h.mock.lock().unwrap().calls.clear();
    h.mock.lock().unwrap().rpc_output = Some(json!({
        "status": "pruned",
        "messageID": "m",
        "revision": rev_b,
        "removedCount": 2
    }));
    let prune_payload = json!({ "sessionID": "ses_single", "messageID": "m", "revision": rev_a, "indexes": [0, 2] });
    let resp = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(resp.status(), Status::OK);
    assert_eq!(
        resp.json::<Value>().await.unwrap(),
        json!({ "status": "pruned", "messageID": "m", "revision": rev_b, "removedCount": 2 })
    );
    assert_eq!(h.mock.lock().unwrap().calls[0].method, "prune");

    for reason in ["conflict", "maintenance_required", "not_deletable", "unsupported_storage"] {
        h.mock.lock().unwrap().rpc_output = Some(json!({ "status": "blocked", "reason": reason }));
        let resp = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
        assert_eq!(resp.status(), Status::OK);
        assert_eq!(resp.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": reason }));
    }

    // 3. Rejects caller-selected extra keys, bad revision/indexes, non-JSON types, empty/oversized bodies.
    h.mock.lock().unwrap().calls.clear();
    for bad in [
        json!({ "sessionID": "ses_single", "messageID": "m", "revision": rev_a, "indexes": [0], "location": { "directory": "/other" } }),
        json!({ "sessionID": "ses_single", "messageID": "m", "revision": rev_a, "indexes": [0], "rpcID": "other" }),
        json!({ "sessionID": "ses_single", "messageID": "m", "revision": rev_a, "indexes": [0], "databasePath": "live.db" }),
        json!({ "sessionID": "ses_single", "messageID": "m", "revision": rev_a, "indexes": [0], "content": [] }),
        json!({ "sessionID": "ses_single", "messageID": "m", "revision": "A".repeat(64), "indexes": [0] }),
        json!({ "sessionID": "ses_single", "messageID": "m", "revision": rev_a, "indexes": [] }),
        json!({ "sessionID": "ses_single", "messageID": "m", "revision": rev_a, "indexes": [0, 0] }),
        json!({ "sessionID": "ses_single", "messageID": "m", "revision": rev_a, "indexes": [-1] }),
        json!({ "sessionID": "ses_single", "messageID": "m", "revision": rev_a, "indexes": [100_001] }),
        json!({ "sessionID": "ses_single", "messageID": "m", "revision": rev_a, "indexes": [1.5] }),
    ] {
        let r = h.client.post(h.url("/session-pruning/prune")).json(&bad).send().await.unwrap();
        assert_eq!(r.status(), Status::BAD_REQUEST, "expected 400 for {bad}");
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "error": "Invalid pruning request" }));
    }

    let text_res = h
        .client
        .post(h.url("/session-pruning/preview"))
        .header(header::CONTENT_TYPE, "text/plain")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(text_res.status(), Status::BAD_REQUEST);

    let empty_json = h
        .client
        .post(h.url("/session-pruning/preview"))
        .header(header::CONTENT_TYPE, "application/json")
        .body("")
        .send()
        .await
        .unwrap();
    assert_eq!(empty_json.status(), Status::BAD_REQUEST);
    assert_eq!(empty_json.headers().get(header::CONNECTION).and_then(|v| v.to_str().ok()), Some("close"));
    assert_eq!(empty_json.json::<Value>().await.unwrap()["code"], "FST_ERR_CTP_EMPTY_JSON_BODY");

    let invalid_json = h
        .client
        .post(h.url("/session-pruning/preview"))
        .header(header::CONTENT_TYPE, "application/json")
        .body("{not-json")
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_json.status(), Status::BAD_REQUEST);
    assert_eq!(invalid_json.headers().get(header::CONNECTION).and_then(|v| v.to_str().ok()), Some("close"));
    assert_eq!(invalid_json.json::<Value>().await.unwrap()["code"], "FST_ERR_CTP_INVALID_JSON_BODY");

    let bad_ct = h
        .client
        .post(h.url("/session-pruning/preview"))
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(bad_ct.status(), Status::UNSUPPORTED_MEDIA_TYPE);

    let oversized = send_raw_http(
        h.server_addr,
        &format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            h.path("/session-pruning/preview"),
            h.server_addr,
            1024 * 1024 + 16
        ),
        false,
    )
    .await;
    assert!(oversized.starts_with("HTTP/1.1 413 "), "got: {oversized}");
    assert!(oversized.to_ascii_lowercase().contains("\r\nconnection: close\r\n"), "got: {oversized}");
    assert!(oversized.contains("FST_ERR_CTP_BODY_TOO_LARGE"), "got: {oversized}");
    assert!(h.mock.lock().unwrap().calls.is_empty());

    // Truncated body stream (EOF before Content-Length) must never be misclassified as 413.
    let truncated = send_raw_http(
        h.server_addr,
        &format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{{\"a\":",
            h.path("/session-pruning/preview"),
            h.server_addr
        ),
        true,
    )
    .await;
    assert!(!truncated.starts_with("HTTP/1.1 413 "), "truncated stream must not be 413, got: {truncated}");

    // Fastify HTTP edge parity:
    // - No Content-Type + Transfer-Encoding: chunked (empty body) -> 415.
    // - No Content-Type + Content-Length: 0 -> 400 Invalid pruning request.
    // - Local authenticated GET on pruning/history routes -> 404 (not 405).
    let chunked_empty = send_raw_http(
        h.server_addr,
        &format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n",
            h.path("/session-pruning/preview"),
            h.server_addr
        ),
        false,
    )
    .await;
    assert!(chunked_empty.starts_with("HTTP/1.1 415 "), "got: {chunked_empty}");

    let no_ct_empty = send_raw_http(
        h.server_addr,
        &format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            h.path("/session-pruning/preview"),
            h.server_addr
        ),
        false,
    )
    .await;
    assert!(no_ct_empty.starts_with("HTTP/1.1 400 "), "got: {no_ct_empty}");

    for suffix in ["/session-pruning/preview", "/session-pruning/prune", "/session-history/prune"] {
        let r = h.client.get(h.url(suffix)).send().await.unwrap();
        assert_eq!(r.status(), Status::NOT_FOUND, "local GET {suffix} must return 404");
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "message": "Not Found" }));
    }

    // 4. Non-200 / non-JSON native RPC or session responses, malformed outputs, or mismatched
    //    receipts never report success.
    for (rpc_status, rpc_ct, output) in [
        (Status::INTERNAL_SERVER_ERROR, "application/json", json!({})),
        (
            Status::CREATED,
            "application/json",
            json!({ "status": "pruned", "messageID": "m", "revision": rev_a, "removedCount": 2 }),
        ),
        (
            Status::OK,
            "text/plain",
            json!({ "status": "pruned", "messageID": "m", "revision": rev_a, "removedCount": 2 }),
        ),
        (Status::OK, "application/json", json!({})),
        (Status::OK, "application/json", json!({ "status": "blocked", "reason": "unknown_reason" })),
        (
            Status::OK,
            "application/json",
            json!({ "status": "pruned", "messageID": "other", "revision": rev_a, "removedCount": 2 }),
        ),
        (
            Status::OK,
            "application/json",
            json!({ "status": "pruned", "messageID": "m", "revision": rev_a, "removedCount": 1 }),
        ),
        (
            Status::OK,
            "application/json",
            json!({ "status": "pruned", "messageID": "m", "revision": rev_a, "removedCount": 2, "extra": 1 }),
        ),
    ] {
        {
            let mut g = h.mock.lock().unwrap();
            g.rpc_status = rpc_status;
            g.rpc_content_type = rpc_ct.into();
            g.rpc_output = Some(output);
        }
        let resp = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
        assert_eq!(resp.status(), Status::OK);
        assert_eq!(resp.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));
    }
    {
        let mut g = h.mock.lock().unwrap();
        g.rpc_status = Status::OK;
        g.rpc_content_type = "application/json".into();
        g.session_content_type = "text/plain".into();
        g.rpc_output = Some(json!({ "status": "pruned", "messageID": "m", "revision": rev_a, "removedCount": 2 }));
    }
    let bad_sess_ct = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(bad_sess_ct.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));
}

#[tokio::test]
async fn ownership_carrier_guard_fences_plugin_readiness_and_session_move() {
    let h = Harness::new(true).await;
    let rev_a = rev('a');
    let prune_payload = json!({ "sessionID": "ses_guard", "messageID": "m", "revision": rev_a, "indexes": [0] });
    let preview_payload = json!({ "sessionID": "ses_guard", "messageID": "m" });

    // 1. Unknown workspace returns blocked/unavailable (matching TS).
    let missing_ws = h
        .client
        .post(format!("{}/api/workspaces/unknown/session-pruning/preview", h.base))
        .json(&preview_payload)
        .send()
        .await
        .unwrap();
    assert_eq!(missing_ws.status(), Status::OK);
    assert_eq!(missing_ws.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));

    // 2. Unowned session directory -> 403 before plugin readiness or RPC.
    let foreign_dir = h.dir.0.join("foreign");
    fs::create_dir_all(&foreign_dir).unwrap();
    h.mock.lock().unwrap().session_dir = foreign_dir.to_string_lossy().into_owned();
    let r = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(r.status(), Status::FORBIDDEN);
    assert_eq!(r.json::<Value>().await.unwrap(), json!({ "error": "Session does not belong to workspace" }));
    assert_eq!(h.mock.lock().unwrap().plugin_polls, 0);
    assert!(h.mock.lock().unwrap().calls.is_empty());

    // 3. Per-route workspaceID classification:
    //    preview/prune: valid foreign workspaceID -> 403; null or NUL workspaceID -> 200 blocked.
    {
        let mut g = h.mock.lock().unwrap();
        g.session_dir = h.workspace_dir.to_string_lossy().into_owned();
        g.session_workspace_id = Some(json!("foreign-ws"));
    }
    let r = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(r.status(), Status::FORBIDDEN);

    for malformed_ws in [Value::Null, json!("bad\0id"), json!("   ")] {
        h.mock.lock().unwrap().session_workspace_id = Some(malformed_ws);
        let r = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
        assert_eq!(r.status(), Status::OK);
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));
    }
    h.mock.lock().unwrap().session_workspace_id = None;

    // 4. Schedule carrier blocks prune (0 pruning RPC calls) while read-only preview stays available.
    {
        let mut g = h.mock.lock().unwrap();
        g.carrier_owned = Some(true);
        g.rpc_output = Some(json!({ "status": "preview", "revision": rev_a, "liveMutation": false, "parts": [] }));
    }
    let blocked_prune = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(blocked_prune.status(), Status::OK);
    assert_eq!(blocked_prune.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));
    assert!(h.mock.lock().unwrap().calls.is_empty());

    let ok_preview = h.client.post(h.url("/session-pruning/preview")).json(&preview_payload).send().await.unwrap();
    assert_eq!(ok_preview.status(), Status::OK);
    assert_eq!(ok_preview.json::<Value>().await.unwrap()["status"], "preview");
    assert_eq!(h.mock.lock().unwrap().calls.len(), 1);

    // Non-JSON or 201 carrier response with `owned: false` must fail closed (0 pruning RPC calls).
    for (st, ct) in [(Status::OK, "text/plain"), (Status::CREATED, "application/json")] {
        {
            let mut g = h.mock.lock().unwrap();
            g.calls.clear();
            g.carrier_owned = Some(false);
            g.carrier_status = st;
            g.carrier_content_type = ct.into();
            g.carrier_raw_body = None;
            g.rpc_output = Some(json!({ "status": "pruned", "messageID": "m", "revision": rev_a, "removedCount": 1 }));
        }
        let r = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));
        assert!(h.mock.lock().unwrap().calls.is_empty());
    }

    // Absent scheduleCarrierRead RPC in 400 or 404 (UTF-16 message length up to 4096) allows
    // ordinary sessions, rejects carrier title, >4096 UTF-16 message, and plain 404.
    let utf16_4096: String = "é".repeat(4096); // 8192 UTF-8 bytes, 4096 UTF-16 code units
    let utf16_4097: String = "é".repeat(4097);
    {
        let mut g = h.mock.lock().unwrap();
        g.calls.clear();
        g.carrier_owned = None;
        g.carrier_status = Status::NOT_FOUND;
        g.carrier_content_type = "application/json".into();
        g.carrier_raw_body =
            Some(json!({ "_tag": "RpcError", "type": "rpc.unavailable", "message": utf16_4096 }).to_string());
        g.session_title = "Mission schedule carrier".into();
    }
    let blocked_title = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(blocked_title.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));
    assert!(h.mock.lock().unwrap().calls.is_empty());

    h.mock.lock().unwrap().session_title = "Ordinary".into();
    let ok_404_u16 = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(ok_404_u16.json::<Value>().await.unwrap()["status"], "pruned");

    for (ct, bad_absent) in [
        (
            "application/json",
            json!({ "_tag": "RpcError", "type": "rpc.unavailable", "message": utf16_4097 }).to_string(),
        ),
        (
            "application/json",
            json!({ "_tag": "RpcError", "type": "rpc.method_not_found", "message": utf16_4097 }).to_string(),
        ),
        (
            "application/problem+json",
            json!({ "_tag": "RpcError", "type": "rpc.method_not_found", "message": "missing" }).to_string(),
        ),
        ("application/json", json!({ "error": "Not found" }).to_string()),
    ] {
        {
            let mut g = h.mock.lock().unwrap();
            g.calls.clear();
            g.carrier_content_type = ct.into();
            g.carrier_raw_body = Some(bad_absent);
        }
        let r = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));
        assert!(h.mock.lock().unwrap().calls.is_empty());
    }
    {
        let mut g = h.mock.lock().unwrap();
        g.carrier_status = Status::OK;
        g.carrier_content_type = "application/json".into();
        g.carrier_raw_body = None;
        g.carrier_owned = Some(false);
        g.calls.clear();
    }

    // 5. Failed plugin readiness refuses RPC; inactive lifecycle or foreign-endpoint lease also fails closed.
    h.mock.lock().unwrap().plugin_status = "failed".into();
    let failed_plugin = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(failed_plugin.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));
    assert!(h.mock.lock().unwrap().calls.is_empty());
    h.mock.lock().unwrap().plugin_status = "active".into();

    // Drop the active lease -> inactive lifecycle must fail closed even though `/api/plugin` is active.
    let mut h = h;
    h._readiness = None;
    let no_lease = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(no_lease.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));
    assert!(h.mock.lock().unwrap().calls.is_empty());

    // Lease bound to a different endpoint must fail closed.
    let other_ep = Native::test_connection(h.server_addr).endpoint().unwrap();
    let wrong_ep_guard = extensions::lifecycle::install_test_readiness_lease(other_ep, h.lease_path.clone());
    let wrong_ep = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(wrong_ep.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));
    assert!(h.mock.lock().unwrap().calls.is_empty());
    drop(wrong_ep_guard);

    // Restore valid lease bound to this endpoint; silence follower -> challenge times out (0 RPCs).
    h._readiness = Some(extensions::lifecycle::install_test_readiness_lease(
        h.app.native.endpoint().unwrap(),
        h.lease_path.clone(),
    ));
    h.follower_enabled.store(false, Relaxed);
    let no_ack = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(no_ack.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));
    assert!(h.mock.lock().unwrap().calls.is_empty());
    h.follower_enabled.store(true, Relaxed);

    // 6. Active worktree deletion fence (base AND linked worktree checkout) + session reservation return 409.
    let ws_fence = fence::identity(&h.workspace_dir);
    let _blocked = fence::block(&[ws_fence]).await.unwrap();
    for (suffix, body) in [("/session-pruning/preview", &preview_payload), ("/session-pruning/prune", &prune_payload)] {
        let r = h.client.post(h.url(suffix)).json(body).send().await.unwrap();
        assert_eq!(r.status(), Status::CONFLICT);
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "error": "Worktree deletion is in progress" }));
    }
    assert!(h.mock.lock().unwrap().calls.is_empty());
    drop(_blocked);

    // Session move reservation (`fence::session`) blocks mutating prune with 409 before RPC.
    let _moving = fence::try_block(&[fence::session("ses_guard")]).unwrap();
    let moving_res = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(moving_res.status(), Status::CONFLICT);
    assert!(h.mock.lock().unwrap().calls.is_empty());
    drop(_moving);

    // Linked worktree checkout blocked while base workspace stays unblocked -> 409 (not 200 blocked).
    let git_ok = Command::new("git").args(["init", "-q"]).current_dir(&h.workspace_dir).status().unwrap().success();
    assert!(git_ok);
    assert!(
        Command::new("git")
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@e",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init"
            ])
            .current_dir(&h.workspace_dir)
            .status()
            .unwrap()
            .success()
    );
    let linked_raw = h.dir.0.join("linked-wt");
    assert!(
        Command::new("git")
            .args(["worktree", "add", "-q", "-b", "linked", linked_raw.to_str().unwrap()])
            .current_dir(&h.workspace_dir)
            .status()
            .unwrap()
            .success()
    );
    let linked_dir = dunce::canonicalize(&linked_raw).unwrap();
    {
        let mut g = h.mock.lock().unwrap();
        g.linked_dir = Some(linked_dir.to_string_lossy().into_owned());
        g.session_dir = linked_dir.to_string_lossy().into_owned();
    }
    let linked_fence = fence::identity(&linked_dir);
    let _linked_blocked = fence::block(&[linked_fence]).await.unwrap();
    for (suffix, body) in [
        ("/session-pruning/preview", &preview_payload),
        ("/session-pruning/prune", &prune_payload),
        (
            "/session-history/prune",
            &json!({ "sessionID": "ses_guard", "candidates": [{ "messageID": "m", "revision": rev_a, "toolCount": 1, "reasoningCount": 0 }] }),
        ),
    ] {
        let r = h.client.post(h.url(suffix)).json(body).send().await.unwrap();
        assert_eq!(r.status(), Status::CONFLICT, "blocked linked checkout on {suffix} must return 409");
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "error": "Worktree deletion is in progress" }));
    }
    assert!(h.mock.lock().unwrap().calls.is_empty());
    drop(_linked_blocked);
    h.mock.lock().unwrap().session_dir = h.workspace_dir.to_string_lossy().into_owned();

    // 7. Session moving during carrier guard (3rd GET, BEFORE RPC) refuses without calling RPC,
    //    and moving after RPC (4th GET) never reports success.
    {
        let mut g = h.mock.lock().unwrap();
        g.calls.clear();
        g.session_gets = 0;
        g.move_on_get = Some((3, foreign_dir.to_string_lossy().into_owned()));
        g.rpc_output = Some(json!({ "status": "pruned", "messageID": "m", "revision": rev_a, "removedCount": 1 }));
    }
    let moved_before_rpc = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(
        moved_before_rpc.json::<Value>().await.unwrap(),
        json!({ "status": "blocked", "reason": "unavailable" })
    );
    assert!(h.mock.lock().unwrap().calls.is_empty(), "must not dispatch RPC if session moved during carrier guard");

    {
        let mut g = h.mock.lock().unwrap();
        g.session_dir = h.workspace_dir.to_string_lossy().into_owned();
        g.session_gets = 0;
        g.move_on_get = Some((4, foreign_dir.to_string_lossy().into_owned()));
    }
    let moved_after_rpc = h.client.post(h.url("/session-pruning/prune")).json(&prune_payload).send().await.unwrap();
    assert_eq!(moved_after_rpc.json::<Value>().await.unwrap(), json!({ "status": "blocked", "reason": "unavailable" }));
    assert_eq!(h.mock.lock().unwrap().calls.len(), 1);

    // 8. Dispatched prune RPC holds both checkout deletion fence and session fence until the native
    //    RPC finishes, both after client disconnect AND after the route deadline expires mid-RPC.
    {
        let mut g = h.mock.lock().unwrap();
        g.session_dir = h.workspace_dir.to_string_lossy().into_owned();
        g.move_on_get = None;
        g.pause_rpc = true;
    }
    let started = h.mock.lock().unwrap().rpc_started.clone();
    let release = h.mock.lock().unwrap().rpc_release.clone();
    let in_flight = tokio::spawn({
        let client = h.client.clone();
        let url = h.url("/session-pruning/prune");
        let body = prune_payload.clone();
        async move { client.post(url).json(&body).send().await }
    });
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();
    assert!(fence::try_block(&[fence::session("ses_guard")]).is_none(), "in-flight prune must hold fence::session");
    in_flight.abort();
    let _ = in_flight.await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let ws_fence_keys = [fence::identity(&h.workspace_dir)];
    let deletion = fence::block(&ws_fence_keys);
    tokio::pin!(deletion);
    assert!(futures_util::poll!(&mut deletion).is_pending(), "deletion fence must wait for dispatched RPC");
    release.notify_one();
    assert!(tokio::time::timeout(Duration::from_secs(2), deletion).await.unwrap().is_ok());

    // Route deadline expiration while a dispatched RPC is suspended must still keep the fence held
    // until the native RPC completes (matching `opencode::proxy_write::forward`).
    let ws = h.app.workspace(&h.workspace_id).unwrap();
    let ep = h.app.native.endpoint().unwrap();
    let parsed_direct = super::contract::ParsedInput {
        session_id: "ses_guard".into(),
        rpc_input: prune_payload.clone(),
        kind: super::contract::ParsedKind::Prune { message_id: "m".into(), expected_removed: 1 },
    };
    let short_deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    let principal_direct = auth::Principal(CancellationToken::new());
    let (rpc_hit, timed_out_err) = {
        let timed_out_exec = tokio::time::timeout_at(
            short_deadline,
            super::execute(
                &h.app,
                &principal_direct,
                &ws,
                &ep,
                &parsed_direct,
                super::contract::Action::Prune,
                Vec::new(),
                short_deadline,
            ),
        );
        tokio::pin!(timed_out_exec);
        let wait_started = started.notified();
        tokio::pin!(wait_started);
        let mut hit = false;
        let res = loop {
            tokio::select! {
                _ = &mut wait_started, if !hit => { hit = true; }
                res = &mut timed_out_exec => break res,
            }
        };
        (hit, res.is_err())
    };
    assert!(rpc_hit, "prune RPC must have been dispatched before deadline fired");
    assert!(timed_out_err, "caller must time out at route deadline");
    let deletion_after_timeout = fence::block(&ws_fence_keys);
    tokio::pin!(deletion_after_timeout);
    assert!(
        futures_util::poll!(&mut deletion_after_timeout).is_pending(),
        "deletion fence must stay held past route deadline until suspended RPC finishes"
    );
    release.notify_one();
    assert!(tokio::time::timeout(Duration::from_secs(2), deletion_after_timeout).await.unwrap().is_ok());

    // Read-only preview must NOT hold the worktree deletion fence past client disconnect.
    let preview_in_flight = tokio::spawn({
        let client = h.client.clone();
        let url = h.url("/session-pruning/preview");
        let body = preview_payload.clone();
        async move { client.post(url).json(&body).send().await }
    });
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();
    preview_in_flight.abort();
    let _ = preview_in_flight.await;
    assert!(
        tokio::time::timeout(Duration::from_secs(2), fence::block(&ws_fence_keys)).await.unwrap().is_ok(),
        "aborted read-only preview must release deletion fence immediately while mock RPC is still paused"
    );
    release.notify_one();
}

#[tokio::test]
async fn batch_prune_route_validates_candidates_fences_carriers_and_receipts() {
    let h = Harness::new(true).await;
    let rev_a = rev('a');
    let rev_b = rev('b');
    let batch_url = h.url("/session-history/prune");
    let valid_batch = json!({
        "sessionID": "ses_batch",
        "candidates": [
            { "messageID": "m1", "revision": rev_a, "toolCount": 1, "reasoningCount": 1 },
            { "messageID": "m2", "revision": rev_a, "toolCount": 0, "reasoningCount": 1 },
        ]
    });

    // 1. Valid batch prune returns per-message results and invokes pruneBatch RPC.
    h.mock.lock().unwrap().rpc_output = Some(json!({
        "results": [
            { "messageID": "m1", "result": { "status": "pruned", "messageID": "m1", "revision": rev_b, "removedCount": 2 } },
            { "messageID": "m2", "result": { "status": "blocked", "reason": "conflict" } },
        ]
    }));
    let ok = h.client.post(&batch_url).json(&valid_batch).send().await.unwrap();
    assert_eq!(ok.status(), Status::OK);
    let body = ok.json::<Value>().await.unwrap();
    assert_eq!(body["results"][0]["result"]["status"], "pruned");
    assert_eq!(body["results"][1]["result"], json!({ "status": "blocked", "reason": "conflict" }));
    assert_eq!(h.mock.lock().unwrap().calls[0].method, "pruneBatch");

    // 2. Rejects invalid batch bodies (0 or >16 candidates, duplicates, extra fields, >16 KiB).
    h.mock.lock().unwrap().calls.clear();
    let too_many: Vec<Value> = (0..17)
        .map(|i| json!({ "messageID": format!("m{i}"), "revision": rev_a, "toolCount": 1, "reasoningCount": 0 }))
        .collect();
    for bad in [
        json!({ "sessionID": "ses_batch", "candidates": [] }),
        json!({ "sessionID": "ses_batch", "candidates": too_many }),
        json!({
            "sessionID": "ses_batch",
            "candidates": [
                { "messageID": "m1", "revision": rev_a, "toolCount": 1, "reasoningCount": 0 },
                { "messageID": "m1", "revision": rev_a, "toolCount": 1, "reasoningCount": 0 },
            ]
        }),
        json!({ "sessionID": "ses_batch", "candidates": [{ "messageID": "m1", "revision": rev_a, "toolCount": 1, "reasoningCount": 0, "extra": true }] }),
    ] {
        let r = h.client.post(&batch_url).json(&bad).send().await.unwrap();
        assert_eq!(r.status(), Status::BAD_REQUEST);
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "error": "Invalid pruning batch" }));
    }
    let too_large = h
        .client
        .post(&batch_url)
        .header(header::CONTENT_TYPE, "application/json")
        .body(vec![b' '; 16_385])
        .send()
        .await
        .unwrap();
    assert_eq!(too_large.status(), Status::PAYLOAD_TOO_LARGE);
    assert!(h.mock.lock().unwrap().calls.is_empty());

    // 3. Invalid per-message receipt (missing row, wrong count, or reordered) maps every candidate to blocked.
    for bad_out in [
        json!({ "results": [] }),
        json!({
            "results": [
                { "messageID": "m1", "result": { "status": "pruned", "messageID": "m1", "revision": rev_b, "removedCount": 1 } },
                { "messageID": "m2", "result": { "status": "blocked", "reason": "conflict" } },
            ]
        }),
        json!({
            "results": [
                { "messageID": "m2", "result": { "status": "blocked", "reason": "conflict" } },
                { "messageID": "m1", "result": { "status": "pruned", "messageID": "m1", "revision": rev_b, "removedCount": 2 } },
            ]
        }),
    ] {
        h.mock.lock().unwrap().rpc_output = Some(bad_out);
        let resp = h.client.post(&batch_url).json(&valid_batch).send().await.unwrap();
        assert_eq!(resp.status(), Status::OK);
        assert_eq!(
            resp.json::<Value>().await.unwrap(),
            json!({
                "results": [
                    { "messageID": "m1", "result": { "status": "blocked", "reason": "unavailable" } },
                    { "messageID": "m2", "result": { "status": "blocked", "reason": "unavailable" } },
                ]
            })
        );
    }

    // Batch route checks ownership before readLocationRef: workspaceID: null / NUL -> 403, location: null -> 200 blocked.
    for ws_val in [Value::Null, json!("bad\0id")] {
        h.mock.lock().unwrap().session_workspace_id = Some(ws_val);
        let r = h.client.post(&batch_url).json(&valid_batch).send().await.unwrap();
        assert_eq!(r.status(), Status::FORBIDDEN);
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "error": "Session does not belong to workspace" }));
    }
    {
        let mut g = h.mock.lock().unwrap();
        g.session_workspace_id = None;
        g.session_location_null = true;
    }
    let null_loc = h.client.post(&batch_url).json(&valid_batch).send().await.unwrap();
    assert_eq!(null_loc.status(), Status::OK);
    assert_eq!(null_loc.json::<Value>().await.unwrap()["results"][0]["result"]["reason"], "unavailable");
    h.mock.lock().unwrap().session_location_null = false;

    // 4. Schedule carrier refuses batch before RPC; deletion fence returns 409.
    {
        let mut g = h.mock.lock().unwrap();
        g.calls.clear();
        g.carrier_owned = Some(true);
    }
    let carrier_resp = h.client.post(&batch_url).json(&valid_batch).send().await.unwrap();
    assert_eq!(carrier_resp.status(), Status::OK);
    assert_eq!(carrier_resp.json::<Value>().await.unwrap()["results"][0]["result"]["reason"], "unavailable");
    assert!(h.mock.lock().unwrap().calls.is_empty());

    let ws_fence = fence::identity(&h.workspace_dir);
    let _blocked = fence::block(&[ws_fence]).await.unwrap();
    let fenced = h.client.post(&batch_url).json(&valid_batch).send().await.unwrap();
    assert_eq!(fenced.status(), Status::CONFLICT);
    assert_eq!(fenced.json::<Value>().await.unwrap(), json!({ "error": "Worktree deletion is in progress" }));
}

#[tokio::test]
async fn remote_control_origin_csrf_method_and_local_auth_guards() {
    let h = Harness::new(false).await;
    let rev_a = rev('a');

    // Local unauthenticated POST -> 401.
    let unauth = h
        .client
        .post(h.url("/session-pruning/preview"))
        .json(&json!({ "sessionID": "ses_remote", "messageID": "m" }))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), Status::UNAUTHORIZED);

    // Pair a browser device on a direct HTTPS origin and exercise `auth::remote::admit`.
    let origin = "https://192.168.1.20:4443";
    let host = "192.168.1.20:4443";
    let issued =
        auth::devices::issue(State(h.app.clone()), axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#)))
            .await;
    assert_eq!(issued.status(), Status::OK);
    let link: Value = serde_json::from_slice(&axum::body::to_bytes(issued.into_body(), 4096).await.unwrap()).unwrap();
    let code = link["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();

    let channel = auth::tls::Channel {
        origin: origin.to_owned(),
        origins: Arc::from(vec![origin.to_owned()]),
        ingress: false,
        socket: CancellationToken::new(),
        principal: Arc::new(Mutex::new(None)),
    };
    let remote_router = sessions::routes(CancellationToken::new())
        .merge(auth::remote_routes())
        .layer(from_fn_with_state((h.app.clone(), None), auth::remote::admit))
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

    // Admitted paired browser POST with matching Origin on all 3 pruning routes: verify receipts & RPC count.
    h.mock.lock().unwrap().calls.clear();
    h.mock.lock().unwrap().rpc_output =
        Some(json!({ "status": "preview", "revision": rev_a, "liveMutation": false, "parts": [] }));
    let r = h
        .client
        .post(remote_url("/session-pruning/preview"))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .json(&json!({ "sessionID": "ses_remote", "messageID": "m" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), Status::OK);
    assert_eq!(r.json::<Value>().await.unwrap()["status"], "preview");

    h.mock.lock().unwrap().rpc_output =
        Some(json!({ "status": "pruned", "messageID": "m", "revision": rev_a, "removedCount": 1 }));
    let r = h
        .client
        .post(remote_url("/session-pruning/prune"))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .json(&json!({ "sessionID": "ses_remote", "messageID": "m", "revision": rev_a, "indexes": [0] }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), Status::OK);
    assert_eq!(r.json::<Value>().await.unwrap()["status"], "pruned");

    h.mock.lock().unwrap().rpc_output = Some(json!({
        "results": [{ "messageID": "m", "result": { "status": "pruned", "messageID": "m", "revision": rev_a, "removedCount": 1 } }]
    }));
    let r = h
        .client
        .post(remote_url("/session-history/prune"))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .json(&json!({ "sessionID": "ses_remote", "candidates": [{ "messageID": "m", "revision": rev_a, "toolCount": 1, "reasoningCount": 0 }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), Status::OK);
    assert_eq!(r.json::<Value>().await.unwrap()["results"][0]["result"]["status"], "pruned");
    assert_eq!(h.mock.lock().unwrap().calls.len(), 3);

    // Missing or foreign Origin -> 403 CSRF rejection.
    for bad_origin in [None, Some("https://evil.example")] {
        let mut req = h
            .client
            .post(remote_url("/session-pruning/prune"))
            .header(header::HOST, host)
            .header(header::COOKIE, &cookie)
            .json(&json!({ "sessionID": "ses_remote", "messageID": "m", "revision": rev_a, "indexes": [0] }));
        if let Some(o) = bad_origin {
            req = req.header(header::ORIGIN, o);
        }
        let r = req.send().await.unwrap();
        assert_eq!(r.status(), Status::FORBIDDEN);
    }

    // Wrong HTTP method (GET) -> 404 from remote catalog.
    for suffix in ["/session-pruning/preview", "/session-pruning/prune", "/session-history/prune"] {
        let r = h
            .client
            .get(remote_url(suffix))
            .header(header::HOST, host)
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), Status::NOT_FOUND);
    }

    // Unpaired remote device -> 401.
    let r = h
        .client
        .post(remote_url("/session-pruning/preview"))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .json(&json!({ "sessionID": "ses_remote", "messageID": "m" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), Status::UNAUTHORIZED);

    remote_task.abort();
}
