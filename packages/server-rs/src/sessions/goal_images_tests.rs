//! Parity tests for `GET /api/workspaces/:id/sessions/:sessionId/goal`,
//! `POST /api/workspaces/:id/images-conversation`, `.codenomad/design/` Git exclusion,
//! and Remote Control admission.
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering::Relaxed},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{Method, StatusCode as Status, header},
    middleware::from_fn_with_state,
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::design_git_exclude::{
    GitExclusion, design_exclude_rule, exclude_design_folder, exclude_design_folder_cancellable, git_exclude_patterns,
};
use crate::{
    App, Shared, Workspace,
    auth::{self, Principal, devices, remote, tls},
    extensions, files,
    opencode::Native,
    sessions, settings,
    worktrees::fence,
};

struct TempDir(PathBuf);
impl TempDir {
    fn new(prefix: &str) -> Self {
        let dir = crate::shared::test_dir(prefix);
        Self(dunce::canonicalize(&dir).unwrap())
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct DropSignal(Option<Arc<Notify>>);
impl Drop for DropSignal {
    fn drop(&mut self) {
        if let Some(n) = self.0.take() {
            n.notify_one();
        }
    }
}

#[derive(Clone)]
struct RpcCall {
    rpc_id: String,
    method: String,
    directory: String,
    input: Value,
}

struct NativeMock {
    workspace_root: String,
    session_dir: String,
    session_project_id: String,
    session_missing: bool,
    session_workspace_id: Option<Value>,
    session_gets: usize,
    move_session_on_get: Option<(usize, String)>,
    change_project_on_get: Option<(usize, String)>,
    location_override: Option<String>,
    location_fail: bool,
    location_calls: usize,
    goal_plugin_sequence: Vec<Option<String>>,
    goal_plugin_polls: usize,
    pruning_plugin_status: String,
    rpc_status: Status,
    rpc_content_type: String,
    rpc_raw_body: Option<String>,
    rpc_output: Option<Value>,
    pause_rpc: bool,
    rpc_started: Arc<Notify>,
    rpc_release: Arc<Notify>,
    rpc_dropped: Option<Arc<Notify>>,
    calls: Vec<RpcCall>,
}

impl NativeMock {
    fn new(dir: &str) -> Self {
        Self {
            workspace_root: dir.to_owned(),
            session_dir: dir.to_owned(),
            session_project_id: "prj_1".into(),
            session_missing: false,
            session_workspace_id: None,
            session_gets: 0,
            move_session_on_get: None,
            change_project_on_get: None,
            location_override: None,
            location_fail: false,
            location_calls: 0,
            goal_plugin_sequence: vec![Some("active".into())],
            goal_plugin_polls: 0,
            pruning_plugin_status: "active".into(),
            rpc_status: Status::OK,
            rpc_content_type: "application/json".into(),
            rpc_raw_body: None,
            rpc_output: None,
            pause_rpc: false,
            rpc_started: Arc::new(Notify::new()),
            rpc_release: Arc::new(Notify::new()),
            rpc_dropped: None,
            calls: Vec::new(),
        }
    }
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
    let body = axum::body::to_bytes(req.into_body(), 256 * 1024).await.unwrap_or_default();
    let dir_param = reqwest::Url::parse(&format!("http://127.0.0.1/?{query}"))
        .ok()
        .and_then(|u| u.query_pairs().find(|(k, _)| k == "location[directory]").map(|(_, v)| v.into_owned()))
        .unwrap_or_default();

    if method == Method::GET && path == "/api/location" {
        let (root, override_dir, fail) = {
            let mut g = mock.lock().unwrap();
            g.location_calls += 1;
            (g.workspace_root.clone(), g.location_override.clone(), g.location_fail)
        };
        if fail {
            return Status::NOT_FOUND.into_response();
        }
        let dir = override_dir.unwrap_or_else(|| if dir_param.is_empty() { root.clone() } else { dir_param });
        return Json(json!({
            "directory": dir,
            "project": { "id": "prj_1", "directory": root, "canonical": root }
        }))
        .into_response();
    }
    if method == Method::GET && path == "/api/worktree" {
        let root = mock.lock().unwrap().workspace_root.clone();
        return Json(json!([{ "directory": root }])).into_response();
    }
    if method == Method::GET && path == "/api/config" {
        return Json(json!([])).into_response();
    }
    if method == Method::GET && path == "/api/plugin" {
        let (goal_status, pruning_status) = {
            let mut g = mock.lock().unwrap();
            let idx = g.goal_plugin_polls.min(g.goal_plugin_sequence.len().saturating_sub(1));
            g.goal_plugin_polls += 1;
            let goal_status = g.goal_plugin_sequence.get(idx).cloned().flatten();
            (goal_status, g.pruning_plugin_status.clone())
        };
        let mut rows = vec![json!({ "id": "codenomad-session-pruning", "state": { "status": pruning_status } })];
        if let Some(st) = goal_status {
            rows.push(json!({ "id": "opencode.goal", "state": { "status": st } }));
        }
        return Json(json!({ "location": { "directory": dir_param }, "data": rows })).into_response();
    }
    if method == Method::GET
        && let Some(raw_sid) = path.strip_prefix("/api/session/")
    {
        let sid = percent_decode(raw_sid);
        let mut g = mock.lock().unwrap();
        if g.session_missing {
            return Status::NOT_FOUND.into_response();
        }
        g.session_gets += 1;
        if let Some((at, next_dir)) = g.move_session_on_get.clone()
            && g.session_gets >= at
        {
            g.session_dir = next_dir;
        }
        if let Some((at, next_proj)) = g.change_project_on_get.clone()
            && g.session_gets >= at
        {
            g.session_project_id = next_proj;
        }
        let mut loc = json!({ "directory": g.session_dir });
        if let Some(ws) = &g.session_workspace_id {
            loc["workspaceID"] = ws.clone();
        }
        let permissions = g.calls.last().and_then(|c| c.input.get("permissions")).cloned().unwrap_or_else(|| json!([]));
        return Json(json!({
            "data": {
                "id": sid,
                "projectID": g.session_project_id,
                "location": loc,
                "time": { "created": 100 },
                "permissions": permissions,
            }
        }))
        .into_response();
    }
    if method == Method::POST
        && let Some(rest) = path.strip_prefix("/api/rpc/")
        && let Some((rpc_id, rpc_method)) = rest.split_once('/')
    {
        let parsed: Value = serde_json::from_slice(&body).unwrap_or_default();
        let (status, ct, raw_body, out, pause, started, release, dropped) = {
            let mut g = mock.lock().unwrap();
            g.calls.push(RpcCall {
                rpc_id: rpc_id.to_owned(),
                method: rpc_method.to_owned(),
                directory: dir_param,
                input: parsed["input"].clone(),
            });
            (
                g.rpc_status,
                g.rpc_content_type.clone(),
                g.rpc_raw_body.clone(),
                g.rpc_output.clone(),
                g.pause_rpc,
                g.rpc_started.clone(),
                g.rpc_release.clone(),
                g.rpc_dropped.clone(),
            )
        };
        let _drop_guard = DropSignal(dropped);
        if pause {
            started.notify_one();
            release.notified().await;
        }
        if let Some(raw) = raw_body {
            return (status, [(header::CONTENT_TYPE, ct)], raw).into_response();
        }
        let payload = json!({ "output": out.unwrap_or(Value::Null) }).to_string();
        return (status, [(header::CONTENT_TYPE, ct)], payload).into_response();
    }
    (Status::NOT_FOUND, Json(json!({ "error": format!("unhandled {method} {path}") }))).into_response()
}

fn spawn_readiness_follower(lease: PathBuf, acks: Arc<AtomicUsize>) -> tokio::task::JoinHandle<()> {
    let incarnation = Uuid::new_v4().to_string();
    let prepare_dir = PathBuf::from(format!("{}.prepare", lease.display()));
    let scope_file = lease.with_file_name(format!("{incarnation}.scope"));
    tokio::spawn(async move {
        loop {
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
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
}

fn init_git_repo(dir: &Path) {
    let ok = Command::new("git").arg("init").arg("-q").current_dir(dir).status().unwrap().success();
    assert!(ok, "git init failed in {}", dir.display());
}

struct Harness {
    _dir: TempDir,
    workspace_dir: PathBuf,
    workspace_id: String,
    app: Shared,
    mock: Arc<Mutex<NativeMock>>,
    base: String,
    client: reqwest::Client,
    readiness_acks: Arc<AtomicUsize>,
    _readiness: extensions::lifecycle::TestReadinessGuard,
    follower_task: tokio::task::JoinHandle<()>,
    native_task: tokio::task::JoinHandle<()>,
    server_task: tokio::task::JoinHandle<()>,
}

impl Harness {
    async fn new(
        label: &str,
        init_git: bool,
        ingress: bool,
        principal_cancel: CancellationToken,
        config_yaml: Option<&str>,
    ) -> Self {
        let dir = TempDir::new(label);
        let workspace_dir = dir.0.join("repo");
        let config_dir = dir.0.join("config");
        let leases_dir = dir.0.join("leases");
        fs::create_dir_all(&workspace_dir).unwrap();
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&leases_dir).unwrap();
        if init_git {
            init_git_repo(&workspace_dir);
        }
        let workspace_dir = dunce::canonicalize(&workspace_dir).unwrap();
        if let Some(yaml) = config_yaml {
            fs::write(config_dir.join("config.yaml"), yaml).unwrap();
        }
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

        let auth = auth::Auth::new(auth::Settings {
            username: "fixture".into(),
            password: None,
            file: None,
            cookie: "fixture".into(),
            token: false,
            managed_local: false,
            skip: true,
            idle: Duration::from_secs(60),
            absolute: Duration::from_secs(60),
        })
        .unwrap();
        let remote_origin = "https://10.0.0.5:9898".to_owned();
        let dev = if ingress {
            devices::open_ingress_for_test(&config_dir, remote_origin)
        } else {
            devices::open_for_test(&config_dir, remote_origin.clone(), vec![remote_origin])
        };
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let settings = settings::Settings::new(settings::document::Location::resolve(
            config_dir.join("config.yaml").to_str().unwrap(),
        ));
        let app = Arc::new(App::new(
            auth,
            0,
            dir.0.clone(),
            dir.0.clone(),
            false,
            settings,
            json!({}),
            native,
            PathBuf::new(),
            Some(dev),
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

        let readiness =
            extensions::lifecycle::install_test_readiness_lease(app.native.endpoint().unwrap(), lease_path.clone());
        let readiness_acks = Arc::new(AtomicUsize::new(0));
        let follower_task = spawn_readiness_follower(lease_path, readiness_acks.clone());

        let router = sessions::routes(CancellationToken::new())
            .layer(axum::middleware::from_fn(move |mut req: Request, next: axum::middleware::Next| {
                let c = principal_cancel.clone();
                async move {
                    req.extensions_mut().insert(Principal(c));
                    next.run(req).await
                }
            }))
            .with_state(app.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();

        Self {
            _dir: dir,
            workspace_dir,
            workspace_id: ws_id.to_string(),
            app,
            mock,
            base: format!("http://{addr}"),
            client,
            readiness_acks,
            _readiness: readiness,
            follower_task,
            native_task,
            server_task,
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.follower_task.abort();
        self.server_task.abort();
        self.native_task.abort();
    }
}

#[tokio::test]
async fn session_goal_reads_validates_maps_rpc_errors_and_cancels() {
    let cancel = CancellationToken::new();
    let h = Harness::new("goal-route", false, false, cancel.clone(), None).await;
    let url = |sid: &str| format!("{}/api/workspaces/{}/sessions/{sid}/goal", h.base, h.workspace_id);

    // 1. Happy path projects only the 7 displayed fields and sets Cache-Control: no-store.
    let goal = json!({
        "id": "g1", "objective": "Ship it", "status": "paused", "reason": "Paused by user",
        "rounds": 3, "maxRounds": 50, "stalls": 1, "boot": "process", "updatedAt": 10
    });
    h.mock.lock().unwrap().rpc_output = Some(goal.clone());
    let resp = h.client.get(url("ses_a")).send().await.unwrap();
    assert_eq!(resp.status(), Status::OK);
    assert_eq!(resp.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        resp.json::<Value>().await.unwrap(),
        json!({
            "status": "goal",
            "goal": {
                "id": "g1", "objective": "Ship it", "status": "paused", "reason": "Paused by user",
                "rounds": 3, "maxRounds": 50, "updatedAt": 10
            }
        })
    );
    {
        let g = h.mock.lock().unwrap();
        assert_eq!(g.calls.len(), 1);
        assert_eq!(g.calls[0].rpc_id, "opencode.goal");
        assert_eq!(g.calls[0].method, "get");
        assert_eq!(g.calls[0].input, json!({ "sessionID": "ses_a" }));
        assert_eq!(g.calls[0].directory, h.workspace_dir.to_string_lossy());
    }

    // Null goal is valid.
    h.mock.lock().unwrap().rpc_output = Some(Value::Null);
    assert_eq!(
        h.client.get(url("ses_a")).send().await.unwrap().json::<Value>().await.unwrap(),
        json!({ "status": "goal", "goal": null })
    );

    // 2. Validation (400), unknown workspace (403), missing session (404), foreign session (403), all with no-store.
    h.mock.lock().unwrap().calls.clear();
    let too_long = format!("ses_{}", "x".repeat(510));
    for bad in ["abc", "ses", "ses%20a", &too_long] {
        let r = h.client.get(url(bad)).send().await.unwrap();
        assert_eq!(r.status(), Status::BAD_REQUEST, "{bad}");
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
    }
    let unknown_ws =
        h.client.get(format!("{}/api/workspaces/{}/sessions/ses_a/goal", h.base, Uuid::new_v4())).send().await.unwrap();
    assert_eq!(unknown_ws.status(), Status::FORBIDDEN);
    assert_eq!(unknown_ws.headers()[header::CACHE_CONTROL], "no-store");

    h.mock.lock().unwrap().session_missing = true;
    let missing = h.client.get(url("ses_a")).send().await.unwrap();
    assert_eq!(missing.status(), Status::NOT_FOUND);
    assert_eq!(missing.headers()[header::CACHE_CONTROL], "no-store");
    h.mock.lock().unwrap().session_missing = false;

    h.mock.lock().unwrap().session_workspace_id = Some(json!("wrk_foreign"));
    let foreign = h.client.get(url("ses_a")).send().await.unwrap();
    assert_eq!(foreign.status(), Status::FORBIDDEN);
    assert_eq!(foreign.headers()[header::CACHE_CONTROL], "no-store");
    h.mock.lock().unwrap().session_workspace_id = None;
    assert_eq!(h.mock.lock().unwrap().calls.len(), 0, "rejected requests must not dispatch RPC");

    // 3. Cold plugin activation polls until active; failed plugin returns unavailable.
    {
        let mut g = h.mock.lock().unwrap();
        g.goal_plugin_polls = 0;
        g.goal_plugin_sequence = vec![None, Some("active".into())];
        g.rpc_output = Some(goal.clone());
    }
    assert_eq!(h.client.get(url("ses_a")).send().await.unwrap().json::<Value>().await.unwrap()["status"], "goal");
    assert_eq!(h.mock.lock().unwrap().goal_plugin_polls, 2);

    {
        let mut g = h.mock.lock().unwrap();
        g.goal_plugin_polls = 0;
        g.goal_plugin_sequence = vec![Some("failed".into())];
    }
    assert_eq!(
        h.client.get(url("ses_a")).send().await.unwrap().json::<Value>().await.unwrap(),
        json!({ "status": "unavailable" })
    );
    {
        let mut g = h.mock.lock().unwrap();
        g.goal_plugin_polls = 0;
        g.goal_plugin_sequence = vec![Some("active".into())];
    }

    // 4. rpc.method_not_found -> unsupported; rpc.unavailable, rpc.internal, malformed output -> unavailable.
    {
        let mut g = h.mock.lock().unwrap();
        g.rpc_status = Status::BAD_REQUEST;
        g.rpc_raw_body =
            Some(json!({"_tag": "RpcError", "type": "rpc.method_not_found", "message": "Unknown method"}).to_string());
    }
    assert_eq!(
        h.client.get(url("ses_a")).send().await.unwrap().json::<Value>().await.unwrap(),
        json!({ "status": "unsupported" })
    );
    for (status, body) in [
        (
            Status::BAD_REQUEST,
            json!({"_tag": "RpcError", "type": "rpc.unavailable", "message": "down"}).to_string(),
        ),
        (Status::BAD_REQUEST, json!({"_tag": "RpcError", "type": "rpc.internal", "message": "err"}).to_string()),
        (Status::OK, json!({"output": {"id": "g1", "objective": "x", "status": "blocked", "rounds": 1, "maxRounds": 2, "updatedAt": 1}}).to_string()),
        (Status::OK, json!({"output": {"id": "g1", "objective": "x", "status": "active", "rounds": "3", "maxRounds": 2, "updatedAt": 1}}).to_string()),
        (Status::OK, json!({}).to_string()),
    ] {
        {
            let mut g = h.mock.lock().unwrap();
            g.rpc_status = status;
            g.rpc_raw_body = Some(body);
        }
        let r = h.client.get(url("ses_a")).send().await.unwrap();
        assert_eq!(r.status(), Status::OK);
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "status": "unavailable" }));
    }
    {
        let mut g = h.mock.lock().unwrap();
        g.rpc_status = Status::OK;
        g.rpc_raw_body = None;
        g.rpc_output = Some(goal);
    }

    // 5. Session move or projectID change between plugin check and RPC dispatches no RPC.
    {
        let mut g = h.mock.lock().unwrap();
        g.calls.clear();
        g.session_gets = 0;
        g.change_project_on_get = Some((2, "prj_other".into()));
    }
    assert_eq!(
        h.client.get(url("ses_a")).send().await.unwrap().json::<Value>().await.unwrap(),
        json!({ "status": "unavailable" })
    );
    assert_eq!(h.mock.lock().unwrap().calls.len(), 0);
    {
        let mut g = h.mock.lock().unwrap();
        g.change_project_on_get = None;
        g.session_project_id = "prj_1".into();
        g.session_gets = 0;
        g.move_session_on_get = Some((2, "/elsewhere/moved".into()));
    }
    assert_eq!(
        h.client.get(url("ses_a")).send().await.unwrap().json::<Value>().await.unwrap(),
        json!({ "status": "unavailable" })
    );
    assert_eq!(h.mock.lock().unwrap().calls.len(), 0);
    {
        let mut g = h.mock.lock().unwrap();
        g.move_session_on_get = None;
        g.session_dir = h.workspace_dir.to_string_lossy().into_owned();
    }

    // 5b. Session move/project change during rpc.method_not_found returns unavailable (not stale unsupported).
    {
        let mut g = h.mock.lock().unwrap();
        g.session_gets = 0;
        g.change_project_on_get = Some((3, "prj_other".into()));
        g.rpc_status = Status::BAD_REQUEST;
        g.rpc_raw_body =
            Some(json!({"_tag": "RpcError", "type": "rpc.method_not_found", "message": "missing"}).to_string());
    }
    let stale_unsup = h.client.get(url("ses_a")).send().await.unwrap();
    assert_eq!(stale_unsup.status(), Status::OK);
    assert_eq!(stale_unsup.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(stale_unsup.json::<Value>().await.unwrap(), json!({ "status": "unavailable" }));
    {
        let mut g = h.mock.lock().unwrap();
        g.change_project_on_get = None;
        g.session_project_id = "prj_1".into();
        g.rpc_status = Status::OK;
        g.rpc_raw_body = None;
        g.rpc_output = Some(Value::Null);
    }

    // 6. Client HTTP disconnect aborts the in-flight upstream RPC promptly.
    let dropped = Arc::new(Notify::new());
    let started = {
        let mut g = h.mock.lock().unwrap();
        g.pause_rpc = true;
        g.rpc_dropped = Some(dropped.clone());
        g.rpc_started.clone()
    };
    let dc_client = h.client.clone();
    let dc_url = url("ses_a");
    let dc_task = tokio::spawn(async move {
        let _ = dc_client.get(dc_url).send().await;
    });
    tokio::time::timeout(Duration::from_secs(10), started.notified()).await.unwrap();
    dc_task.abort();
    tokio::time::timeout(Duration::from_secs(10), dropped.notified()).await.unwrap();

    // 7. Workspace close cancels in-flight RPC immediately with unavailable.
    let started_ws = {
        let mut g = h.mock.lock().unwrap();
        g.rpc_dropped = None;
        g.rpc_started = Arc::new(Notify::new());
        g.rpc_started.clone()
    };
    let ws_client = h.client.clone();
    let ws_url = url("ses_a");
    let ws_task = tokio::spawn(async move { ws_client.get(ws_url).send().await.unwrap() });
    tokio::time::timeout(Duration::from_secs(10), started_ws.notified()).await.unwrap();
    h.app.inner.lock().unwrap().workspaces.clear();
    h.app.workspace_closed.notify_waiters();
    let ws_resp = tokio::time::timeout(Duration::from_secs(10), ws_task).await.unwrap().unwrap();
    assert_eq!(ws_resp.status(), Status::OK);
    assert_eq!(ws_resp.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(ws_resp.json::<Value>().await.unwrap(), json!({ "status": "unavailable" }));

    // 8. Revoked principal returns 401 with Cache-Control: no-store.
    cancel.cancel();
    let rev = h.client.get(url("ses_a")).send().await.unwrap();
    assert_eq!(rev.status(), Status::UNAUTHORIZED);
    assert_eq!(rev.headers()[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn design_git_exclude_formats_rules_and_updates_real_git_repos_safely() {
    assert_eq!(design_exclude_rule(""), ".codenomad/design/");
    assert_eq!(design_exclude_rule("apps/web/"), "/apps/web/.codenomad/design/");
    assert_eq!(design_exclude_rule("a*b?c[1]/"), r"/a\*b\?c\[1]/.codenomad/design/");

    let patterns = git_exclude_patterns(b".codenomad/design/   \r\n  leading/ \nfoo\\ \n");
    assert!(patterns.contains(".codenomad/design/"));
    assert!(patterns.contains("  leading/"));
    assert!(patterns.contains("foo\\ "));

    let tmp = TempDir::new("design-git-exclude");
    let non_git = tmp.0.join("plain");
    fs::create_dir_all(&non_git).unwrap();
    assert_eq!(exclude_design_folder(&non_git, Duration::from_secs(10)).await, GitExclusion::NotRepository);

    let broken = tmp.0.join("broken");
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join(".git"), "gitdir: /nonexistent/invalid/gitdir\n").unwrap();
    assert_eq!(exclude_design_folder(&broken, Duration::from_secs(10)).await, GitExclusion::Unavailable);

    let repo = tmp.0.join("repo");
    let sub = repo.join("apps/ui");
    fs::create_dir_all(&sub).unwrap();
    init_git_repo(&repo);
    let exclude_file = repo.join(".git").join("info").join("exclude");
    fs::write(&exclude_file, "# user rule\n*.tmp").unwrap();

    assert_eq!(exclude_design_folder(&repo, Duration::from_secs(10)).await, GitExclusion::Excluded);
    let after_root = fs::read_to_string(&exclude_file).unwrap();
    assert_eq!(after_root, "# user rule\n*.tmp\n\n# codenomad\n.codenomad/design/\n");
    // Idempotent second call does not duplicate.
    assert_eq!(exclude_design_folder(&repo, Duration::from_secs(10)).await, GitExclusion::Excluded);
    assert_eq!(fs::read_to_string(&exclude_file).unwrap(), after_root);
    // Nested Location appends anchored rule without repeating header.
    assert_eq!(exclude_design_folder(&sub, Duration::from_secs(10)).await, GitExclusion::Excluded);
    assert_eq!(
        fs::read_to_string(&exclude_file).unwrap(),
        "# user rule\n*.tmp\n\n# codenomad\n.codenomad/design/\n/apps/ui/.codenomad/design/\n"
    );
    assert!(!repo.join(".gitignore").exists());

    // Cancelled caller never mutates .git/info/exclude.
    let cancel_sub = repo.join("apps/cancelled");
    fs::create_dir_all(&cancel_sub).unwrap();
    let before_cancel = fs::read_to_string(&exclude_file).unwrap();
    assert_eq!(
        exclude_design_folder_cancellable(
            &cancel_sub,
            &repo,
            tokio::time::Instant::now() + Duration::from_secs(10),
            Arc::new(|| false),
        )
        .await,
        GitExclusion::Unavailable
    );
    assert_eq!(fs::read_to_string(&exclude_file).unwrap(), before_cancel);

    // Hard-linked info/exclude is refused without modifying the linked victim file.
    let hl_repo = tmp.0.join("hardlink-repo");
    fs::create_dir_all(&hl_repo).unwrap();
    init_git_repo(&hl_repo);
    let hl_exclude = hl_repo.join(".git").join("info").join("exclude");
    let victim = tmp.0.join("victim.txt");
    fs::write(&victim, "untouched\n").unwrap();
    let _ = fs::remove_file(&hl_exclude);
    fs::hard_link(&victim, &hl_exclude).unwrap();
    assert_eq!(exclude_design_folder(&hl_repo, Duration::from_secs(10)).await, GitExclusion::Unavailable);
    assert_eq!(fs::read_to_string(&victim).unwrap(), "untouched\n");
}

#[tokio::test]
async fn images_conversation_enforces_ownership_fence_permissions_git_exclude_and_release() {
    let cancel = CancellationToken::new();
    let h = Harness::new(
        "images-conv",
        true,
        false,
        cancel.clone(),
        Some("ui:\n  settings:\n    newConversationPermissions: supervised\n"),
    )
    .await;
    let url = format!("{}/api/workspaces/{}/images-conversation", h.base, h.workspace_id);
    let dir_str = h.workspace_dir.to_string_lossy().into_owned();

    // 1. Schema validation (400) and 8192-byte body limit (413) touch neither OpenCode nor Git.
    for bad in [
        json!({}),
        json!({ "directory": dir_str, "mode": "delete" }),
        json!({ "directory": dir_str, "mode": "open", "permissions": [] }),
        json!({ "directory": dir_str, "mode": "open", "metadata": {} }),
        json!({ "directory": dir_str, "mode": "open", "rpcID": "other" }),
        json!({ "directory": dir_str, "mode": "open", "model": { "providerID": "p", "id": "m", "extra": 1 } }),
    ] {
        assert_eq!(h.client.post(&url).json(&bad).send().await.unwrap().status(), Status::BAD_REQUEST, "{bad}");
    }
    let oversized = format!(r#"{{"directory":"{}","mode":"open"}}"#, "a".repeat(8200));
    assert_eq!(
        h.client
            .post(&url)
            .header(header::CONTENT_TYPE, "application/json")
            .body(oversized)
            .send()
            .await
            .unwrap()
            .status(),
        Status::PAYLOAD_TOO_LARGE
    );

    // 2. Unowned existing/missing directory, .git admin dir (outer or nested), or unknown workspace returns 403 with 0 OpenCode requests.
    let foreign = TempDir::new("images-foreign");
    let nested_repo = h.workspace_dir.join("nested-repo");
    fs::create_dir_all(&nested_repo).unwrap();
    init_git_repo(&nested_repo);
    for (target_url, target_dir) in [
        (url.clone(), foreign.0.to_string_lossy().into_owned()),
        (url.clone(), foreign.0.join("does-not-exist").to_string_lossy().into_owned()),
        (url.clone(), h.workspace_dir.join(".git").to_string_lossy().into_owned()),
        (url.clone(), nested_repo.join(".git").to_string_lossy().into_owned()),
        (format!("{}/api/workspaces/{}/images-conversation", h.base, Uuid::new_v4()), dir_str.clone()),
    ] {
        assert_eq!(
            h.client
                .post(target_url)
                .json(&json!({ "directory": target_dir, "mode": "open" }))
                .send()
                .await
                .unwrap()
                .status(),
            Status::FORBIDDEN
        );
    }
    assert_eq!(h.mock.lock().unwrap().location_calls, 0);
    assert_eq!(h.mock.lock().unwrap().calls.len(), 0);

    // 3. Active WorktreeDeletionFence (root or cold-cache subfolder) returns 409 before reaching OpenCode.
    let identity = fence::identity(&h.workspace_dir);
    let sub_dir = h.workspace_dir.join("sub");
    fs::create_dir_all(&sub_dir).unwrap();
    {
        let _blocked = fence::block(std::slice::from_ref(&identity)).await.unwrap();
        for dir in [&dir_str, &sub_dir.to_string_lossy().into_owned()] {
            let blocked_res =
                h.client.post(&url).json(&json!({ "directory": dir, "mode": "open" })).send().await.unwrap();
            assert_eq!(blocked_res.status(), Status::CONFLICT);
        }
    }
    assert_eq!(h.mock.lock().unwrap().location_calls, 0);

    // 4. Native GET /api/location mismatch or failure returns 403 with 0 RPC calls.
    h.mock.lock().unwrap().location_override = Some("/elsewhere".into());
    assert_eq!(
        h.client.post(&url).json(&json!({ "directory": dir_str, "mode": "open" })).send().await.unwrap().status(),
        Status::FORBIDDEN
    );
    assert_eq!(h.mock.lock().unwrap().calls.len(), 0);
    h.mock.lock().unwrap().location_override = None;

    // 5. Lookup / absent / unknown / malformed RPC never write .git/info/exclude and omit gitExclusion.
    let exclude_file = h.workspace_dir.join(".git").join("info").join("exclude");
    let before_exclude = fs::read_to_string(&exclude_file).unwrap_or_default();
    for (mode, output, expected) in [
        (
            "lookup",
            json!({ "status": "found", "sessionID": "ses_img", "created": false }),
            json!({ "status": "found", "sessionID": "ses_img", "created": false }),
        ),
        ("open", json!({ "status": "absent" }), json!({ "status": "absent" })),
        ("open", json!({ "status": "unknown" }), json!({ "status": "unknown" })),
        (
            "open",
            json!({ "status": "found", "sessionID": "ses_bad" }),
            json!({ "status": "blocked", "reason": "unavailable" }),
        ),
    ] {
        h.mock.lock().unwrap().rpc_output = Some(output);
        let r = h.client.post(&url).json(&json!({ "directory": dir_str, "mode": mode })).send().await.unwrap();
        assert_eq!(r.status(), Status::OK);
        assert_eq!(r.json::<Value>().await.unwrap(), expected);
        assert_eq!(fs::read_to_string(&exclude_file).unwrap_or_default(), before_exclude);
    }

    // 6. Full happy path (mode: "open", created: true) waits for readiness, passes supervised permissions,
    //    confirms root permission ownership, and appends .codenomad/design/ to .git/info/exclude.
    h.mock.lock().unwrap().calls.clear();
    h.mock.lock().unwrap().rpc_output = Some(json!({ "status": "found", "sessionID": "ses_img_new", "created": true }));
    let ok = h
        .client
        .post(&url)
        .json(&json!({
            "directory": dir_str,
            "mode": "open",
            "title": "Images",
            "agent": "design",
            "model": { "providerID": "fixture", "id": "chosen" }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), Status::OK);
    assert_eq!(
        ok.json::<Value>().await.unwrap(),
        json!({ "status": "found", "sessionID": "ses_img_new", "created": true, "gitExclusion": "excluded" })
    );
    assert!(h.readiness_acks.load(Relaxed) >= 1, "must wait for desktopPluginsReady");
    {
        let g = h.mock.lock().unwrap();
        assert_eq!(g.calls.len(), 1);
        assert_eq!(g.calls[0].rpc_id, "codenomad.session-pruning");
        assert_eq!(g.calls[0].method, "imagesConversation");
        assert_eq!(g.calls[0].input["mode"], "open");
        assert_eq!(g.calls[0].input["title"], "Images");
        assert_eq!(g.calls[0].input["agent"], "design");
        assert!(g.calls[0].input["permissions"].is_array(), "supervised default must pass permissions block");
    }
    assert!(fs::read_to_string(&exclude_file).unwrap().contains(".codenomad/design/"));

    // 7. Revoking principal while stalled inside RPC releases the WorktreeDeletionFence immediately.
    let started = {
        let mut g = h.mock.lock().unwrap();
        g.pause_rpc = true;
        g.rpc_started = Arc::new(Notify::new());
        g.rpc_started.clone()
    };
    let req_client = h.client.clone();
    let req_url = url.clone();
    let req_dir = dir_str.clone();
    let req_task = tokio::spawn(async move {
        req_client
            .post(req_url)
            .json(&json!({ "directory": req_dir, "mode": "new", "title": "Images" }))
            .send()
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(10), started.notified()).await.unwrap();
    // While in-flight, deletion fence is held -> a concurrent deletion waits until release.
    let del_identity = identity.clone();
    let mut del_task = tokio::spawn(async move {
        let _guard = fence::block(std::slice::from_ref(&del_identity)).await.unwrap();
        true
    });
    tokio::task::yield_now().await;
    assert!(!del_task.is_finished(), "fence must be held while images-conversation RPC is active");
    cancel.cancel();
    let rev_resp = tokio::time::timeout(Duration::from_secs(10), req_task).await.unwrap().unwrap();
    assert_eq!(rev_resp.status(), Status::UNAUTHORIZED);
    // Fence must be released immediately after revocation (no 60s drain).
    let acquired = tokio::time::timeout(Duration::from_secs(2), &mut del_task)
        .await
        .expect("WorktreeDeletionFence must release immediately on cancellation")
        .unwrap();
    assert!(acquired);
}

async fn pair_remote_cookie(
    client: &reqwest::Client,
    app: &Shared,
    base: &str,
    host: &str,
    origin: &str,
    ingress: bool,
    as_server: bool,
) -> String {
    let payload =
        if ingress { axum::body::Bytes::new() } else { axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#)) };
    let issued = devices::issue(State(app.clone()), payload).await;
    assert_eq!(issued.status(), Status::OK);
    let body = axum::body::to_bytes(issued.into_body(), 4096).await.unwrap();
    let link: Value = serde_json::from_slice(&body).unwrap();
    let code = link["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();
    if as_server {
        let paired = client
            .post(format!("{base}/api/remote-control/server-pair"))
            .header(header::HOST, host)
            .header("x-codenomad-server-pairing", "1")
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({"code": code, "hostName": "peer-host"}).to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(paired.status(), Status::OK);
        let cred = paired.json::<Value>().await.unwrap()["credential"].as_str().unwrap().to_owned();
        format!("{}={cred}", devices::COOKIE)
    } else {
        let paired = client
            .post(format!("{base}/api/remote-control/pair"))
            .header(header::HOST, host)
            .header(header::ORIGIN, origin)
            .json(&json!({"code": code}))
            .send()
            .await
            .unwrap();
        assert_eq!(paired.status(), Status::OK);
        paired.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned()
    }
}

#[tokio::test]
async fn remote_control_admits_goal_and_images_conversation_routes() {
    let origin = "https://10.0.0.5:9898";
    let host = "10.0.0.5:9898";

    for ingress in [false, true] {
        let label = if ingress { "goal-images-remote-ingress" } else { "goal-images-remote-direct" };
        let h = Harness::new(label, false, ingress, CancellationToken::new(), None).await;
        let dir_str = h.workspace_dir.to_string_lossy().into_owned();
        let origins: Arc<[String]> = Arc::from(vec![origin.to_owned()]);
        let router = auth::remote_routes()
            .merge(sessions::routes(CancellationToken::new()))
            .layer(from_fn_with_state((h.app.clone(), None), remote::admit))
            .layer(axum::middleware::from_fn(move |mut req: Request, next: axum::middleware::Next| {
                let origins = origins.clone();
                async move {
                    req.extensions_mut().insert(tls::Channel {
                        origin: origin.to_owned(),
                        origins,
                        ingress,
                        socket: CancellationToken::new(),
                        principal: Arc::new(Mutex::new(None)),
                    });
                    next.run(req).await
                }
            }))
            .with_state(h.app.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let base = format!("http://{addr}");

        // Unpaired remote GET goal returns 401 with Cache-Control: no-store.
        let unauth_goal = h
            .client
            .get(format!("{base}/api/workspaces/{}/sessions/ses_a/goal", h.workspace_id))
            .header(header::HOST, host)
            .send()
            .await
            .unwrap();
        assert_eq!(unauth_goal.status(), Status::UNAUTHORIZED);
        assert_eq!(unauth_goal.headers()[header::CACHE_CONTROL], "no-store");

        let browser_cookie = pair_remote_cookie(&h.client, &h.app, &base, host, origin, ingress, false).await;
        let server_cookie = pair_remote_cookie(&h.client, &h.app, &base, host, origin, ingress, true).await;

        for (as_server, cookie_header) in [(false, &browser_cookie), (true, &server_cookie)] {
            let apply = |mut req: reqwest::RequestBuilder, is_post: bool| {
                req = req.header(header::HOST, host).header(header::COOKIE, cookie_header.as_str());
                if as_server {
                    req = req.header("x-codenomad-server-request", "1");
                } else if is_post {
                    req = req.header(header::ORIGIN, origin);
                }
                req
            };
            // GET goal admitted.
            h.mock.lock().unwrap().rpc_output = Some(Value::Null);
            let g = apply(h.client.get(format!("{base}/api/workspaces/{}/sessions/ses_a/goal", h.workspace_id)), false)
                .send()
                .await
                .unwrap();
            assert_eq!(g.status(), Status::OK, "ingress={ingress} server={as_server}");

            // POST images-conversation admitted.
            h.mock.lock().unwrap().rpc_output = Some(json!({ "status": "absent" }));
            let p = apply(h.client.post(format!("{base}/api/workspaces/{}/images-conversation", h.workspace_id)), true)
                .json(&json!({ "directory": dir_str, "mode": "lookup" }))
                .send()
                .await
                .unwrap();
            assert_eq!(p.status(), Status::OK, "ingress={ingress} server={as_server}");

            // Wrong HTTP methods rejected by catalog with 404.
            let bad_goal =
                apply(h.client.post(format!("{base}/api/workspaces/{}/sessions/ses_a/goal", h.workspace_id)), true)
                    .send()
                    .await
                    .unwrap();
            assert_eq!(bad_goal.status(), Status::NOT_FOUND, "POST goal must be 404");
            let bad_img =
                apply(h.client.get(format!("{base}/api/workspaces/{}/images-conversation", h.workspace_id)), false)
                    .send()
                    .await
                    .unwrap();
            assert_eq!(bad_img.status(), Status::NOT_FOUND, "GET images-conversation must be 404");
        }

        // Cross-origin browser POST rejected with 403.
        let csrf = h
            .client
            .post(format!("{base}/api/workspaces/{}/images-conversation", h.workspace_id))
            .header(header::HOST, host)
            .header(header::COOKIE, browser_cookie.as_str())
            .header(header::ORIGIN, "https://evil.invalid")
            .json(&json!({ "directory": dir_str, "mode": "lookup" }))
            .send()
            .await
            .unwrap();
        assert_eq!(csrf.status(), Status::FORBIDDEN);

        srv.abort();
    }
}
