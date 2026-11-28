//! Parity tests for M7 (MCP connect/disconnect, plugin check/update) and `POST /api/session/:id/shell`.
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{Method, StatusCode as Status, header},
    middleware::from_fn_with_state,
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    App, Shared, Workspace,
    auth::{Principal, devices, remote, tls},
    opencode::{Native, SESSION_LOCATED_ELSEWHERE, proxy},
    worktrees::fence,
};

#[derive(Clone, Debug)]
struct RecordedCall {
    method: String,
    path: String,
    query: Option<String>,
    dir_header: Option<String>,
    content_type: Option<String>,
    body: Vec<u8>,
}

struct FakeNative {
    root: PathBuf,
    root_sub: PathBuf,
    linked: PathBuf,
    foreign: PathBuf,
    calls: Mutex<Vec<RecordedCall>>,
    fail_environment: Mutex<bool>,
    upstream_error: Mutex<Option<(Status, Value)>>,
    stall_route: Mutex<Option<(String, Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
}

async fn git_fixture(path: &Path, args: &[&str]) {
    let output = crate::git::command(path, args).output().await.unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

async fn fake_native(State(f): State<Arc<FakeNative>>, request: Request) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().map(str::to_owned);
    let dir_header = request.headers().get("x-opencode-directory").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let content_type = request.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let body = axum::body::to_bytes(request.into_body(), 256 * 1024).await.unwrap().to_vec();
    let ok = |v: Value| Json(v).into_response();

    match (method.clone(), path.as_str()) {
        (Method::GET, "/api/location") => ok(json!({
            "directory": f.root,
            "project": {"id": "project_m7_shell", "directory": f.root, "canonical": f.root}
        })),
        (Method::GET, "/api/worktree") => ok(json!([
            {"directory": f.root},
            {"directory": f.linked}
        ])),
        (Method::POST, "/api/worktree/refresh") => Status::NO_CONTENT.into_response(),
        (Method::POST, "/api/rpc/codenomad.missions/scheduleCarrierRead") => {
            let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let owned = parsed["input"]["sessionID"].as_str() == Some("ses_shell_carrier_rpc");
            ok(json!({"output": {"owned": owned}}))
        }
        (Method::GET, p) if p.starts_with("/api/session/") => {
            let id = p.trim_start_matches("/api/session/");
            let session = |dir: &Path, extra_meta: Option<Value>| {
                let mut data = json!({
                    "id": id,
                    "projectID": "project_m7_shell",
                    "location": {"directory": dir},
                    "model": {"providerID": "openai", "id": "gpt-5"},
                    "title": id,
                    "time": {"created": 1}
                });
                if let Some(meta) = extra_meta {
                    data["metadata"] = meta;
                }
                ok(json!({"data": data}))
            };
            match id {
                "ses_shell_owned" => session(&f.root, None),
                "ses_shell_sub" => session(&f.root_sub, None),
                "ses_shell_linked" => session(&f.linked, None),
                "ses_shell_foreign" => session(&f.foreign, None),
                "ses_shell_carrier_marker" => session(&f.root, Some(json!({"codenomad.schedule-carrier": true}))),
                "ses_shell_carrier_rpc" => session(&f.root, None),
                "ses_cn_schedule_1" => session(&f.root, None),
                _ => (
                    Status::NOT_FOUND,
                    Json(json!({"_tag": "SessionNotFoundError", "sessionID": id, "message": "Session not found"})),
                )
                    .into_response(),
            }
        }
        (Method::PUT, p) if p.starts_with("/api/session/") && p.ends_with("/environment") => {
            f.calls.lock().unwrap().push(RecordedCall {
                method: method.to_string(),
                path,
                query,
                dir_header,
                content_type,
                body,
            });
            if *f.fail_environment.lock().unwrap() {
                Status::INTERNAL_SERVER_ERROR.into_response()
            } else {
                Status::NO_CONTENT.into_response()
            }
        }
        (Method::POST, p)
            if (p.starts_with("/api/session/") && p.ends_with("/shell"))
                || (p.starts_with("/api/experimental/mcp/")
                    && (p.ends_with("/connect") || p.ends_with("/disconnect")))
                || matches!(p, "/api/plugin/check" | "/api/plugin/update") =>
        {
            let stall = f.stall_route.lock().unwrap().clone();
            if let Some((target_path, entered, release)) = stall
                && target_path == p
            {
                entered.notify_one();
                release.notified().await;
            }
            f.calls.lock().unwrap().push(RecordedCall {
                method: method.to_string(),
                path: path.clone(),
                query,
                dir_header,
                content_type,
                body,
            });
            if let Some((status, payload)) = f.upstream_error.lock().unwrap().clone() {
                return (status, Json(payload)).into_response();
            }
            if p.ends_with("/shell") { Status::NO_CONTENT.into_response() } else { ok(json!({"ok": true})) }
        }
        (Method::GET | Method::POST, p)
            if p.starts_with("/api/provider")
                || p.starts_with("/api/integration")
                || p.starts_with("/api/credential") =>
        {
            f.calls.lock().unwrap().push(RecordedCall {
                method: method.to_string(),
                path,
                query,
                dir_header,
                content_type,
                body,
            });
            Status::INTERNAL_SERVER_ERROR.into_response()
        }
        _ => Status::NOT_IMPLEMENTED.into_response(),
    }
}

struct Harness {
    dir: PathBuf,
    root: PathBuf,
    root_sub: PathBuf,
    linked: PathBuf,
    foreign: PathBuf,
    native: Arc<FakeNative>,
    app: Shared,
    ws_id: Uuid,
    http: tokio::task::JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.http.abort();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Harness {
    async fn new(label: &str) -> Self {
        Self::new_with_ingress(label, false).await
    }

    async fn new_with_ingress(label: &str, ingress: bool) -> Self {
        let dir = crate::shared::test_dir(label);
        let root = dir.join("project");
        let linked = dir.join("linked");
        let foreign = dir.join("foreign");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&foreign).unwrap();
        git_fixture(&root, &["init", "--quiet"]).await;
        git_fixture(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        )
        .await;
        git_fixture(&root, &["worktree", "add", "--quiet", "--detach", linked.to_str().unwrap()]).await;
        let root = dunce::canonicalize(&root).unwrap();
        let root_sub = root.join("packages").join("app");
        std::fs::create_dir_all(&root_sub).unwrap();
        let root_sub = dunce::canonicalize(&root_sub).unwrap();
        let linked = dunce::canonicalize(&linked).unwrap();
        let foreign = dunce::canonicalize(&foreign).unwrap();

        let native = Arc::new(FakeNative {
            root: root.clone(),
            root_sub: root_sub.clone(),
            linked: linked.clone(),
            foreign: foreign.clone(),
            calls: Mutex::new(Vec::new()),
            fail_environment: Mutex::new(false),
            upstream_error: Mutex::new(None),
            stall_route: Mutex::new(None),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native_conn = Native::test_connection(listener.local_addr().unwrap());
        let state = native.clone();
        let http = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(any(fake_native)).with_state(state)).await.unwrap()
        });
        let auth = crate::auth::Auth::new(crate::auth::Settings {
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
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
            dir.join("config.yaml").to_str().unwrap(),
        ));
        let devices = if ingress {
            devices::open_ingress_for_test(&dir, "https://10.0.0.5:9898".into())
        } else {
            devices::open_for_test(&dir, "https://10.0.0.5:9898".into(), vec!["https://10.0.0.5:9898".into()])
        };
        let app = Arc::new(App::new(
            auth,
            0,
            dir.clone(),
            dir.clone(),
            false,
            settings,
            Value::Null,
            native_conn,
            PathBuf::new(),
            Some(devices),
            crate::files::watch::Watches::new(tx),
            None,
        ));
        let ws_id = Uuid::new_v4();
        let ws = Workspace {
            id: ws_id,
            request_id: None,
            path: root.clone(),
            name: None,
            status: "running",
            proxy_path: format!("/workspaces/{ws_id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            location: json!({"directory": root}),
            temporary: None,
        };
        app.inner.lock().unwrap().workspaces.push(ws);
        Self { dir, root, root_sub, linked, foreign, native, app, ws_id, http }
    }

    fn post_req(
        &self,
        api_path: &str,
        query: Option<&str>,
        content_type: Option<&str>,
        body: Option<Vec<u8>>,
        location_header: Option<&Path>,
    ) -> Request {
        let mut uri = format!("/workspaces/{}/instance{api_path}", self.ws_id);
        if let Some(q) = query {
            uri.push('?');
            uri.push_str(q);
        }
        let mut builder = Request::builder().method(Method::POST).uri(uri);
        if let Some(ct) = content_type {
            builder = builder.header(header::CONTENT_TYPE, ct);
        }
        if let Some(dir) = location_header {
            let encoded = percent_encoding::utf8_percent_encode(
                &json!({"directory": dir}).to_string(),
                percent_encoding::NON_ALPHANUMERIC,
            )
            .to_string();
            builder = builder.header("x-codenomad-location", encoded);
        }
        let mut req = builder.body(body.map(Body::from).unwrap_or_else(Body::empty)).unwrap();
        req.extensions_mut().insert(Principal(CancellationToken::new()));
        req
    }

    fn calls(&self) -> Vec<RecordedCall> {
        self.native.calls.lock().unwrap().clone()
    }

    fn clear_calls(&self) {
        self.native.calls.lock().unwrap().clear();
    }
}

fn enc(path: &Path) -> String {
    percent_encoding::utf8_percent_encode(path.to_string_lossy().as_ref(), percent_encoding::NON_ALPHANUMERIC)
        .to_string()
}

#[tokio::test]
async fn m7_mcp_toggles_and_plugin_actions_enforce_ownership_validation_and_fences() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("m7-mcp-plugin").await;

    // 1. MCP connect & disconnect: empty body without Content-Type (codenomad-client shape) on linked worktree & subfolder.
    let linked_q = format!("location[directory]={}", enc(&h.linked));
    let sub_q = format!("location[directory]={}", enc(&h.root_sub));
    let res = proxy::relay(
        State(h.app.clone()),
        h.post_req("/api/experimental/mcp/my-server/connect", Some(&linked_q), None, None, None),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), Status::OK);

    let res = proxy::relay(
        State(h.app.clone()),
        h.post_req("/api/experimental/mcp/my-server/disconnect", Some(&sub_q), None, None, None),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), Status::OK);

    // Default location (no query/body/header) resolves to workspace root and omits empty JSON body.
    let res = proxy::relay(
        State(h.app.clone()),
        h.post_req("/api/experimental/mcp/my-server/connect", None, None, None, None),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), Status::OK);

    // 2. Plugin check & update: query, body location (stripped & promoted to query), and x-codenomad-location header.
    let check_body = serde_json::to_vec(&json!({"target": "fixture@latest"})).unwrap();
    let res = proxy::relay(
        State(h.app.clone()),
        h.post_req("/api/plugin/check", Some(&linked_q), Some("application/json"), Some(check_body), None),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), Status::OK);

    let update_with_body_loc =
        serde_json::to_vec(&json!({"targets": ["fixture@latest"], "location": {"directory": h.linked}})).unwrap();
    let res = proxy::relay(
        State(h.app.clone()),
        h.post_req("/api/plugin/update", None, Some("application/json"), Some(update_with_body_loc), None),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), Status::OK);

    // Ambient header x-codenomad-location translates to x-opencode-directory.
    let check_hdr_body = serde_json::to_vec(&json!({"target": "hdr@1.0.0"})).unwrap();
    let res = proxy::relay(
        State(h.app.clone()),
        h.post_req("/api/plugin/check", None, Some("application/json"), Some(check_hdr_body), Some(&h.linked)),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), Status::OK);

    let calls = h.calls();
    assert_eq!(calls.len(), 6);
    assert_eq!(calls[0].path, "/api/experimental/mcp/my-server/connect");
    assert!(calls[0].body.is_empty());
    assert!(calls[0].content_type.is_none());
    assert!(
        calls[0]
            .query
            .as_deref()
            .is_some_and(|q| q.contains("location%5Bdirectory%5D=") || q.contains("location[directory]="))
    );
    assert_eq!(calls[4].path, "/api/plugin/update");
    assert_eq!(calls[4].content_type.as_deref(), Some("application/json"));
    assert_eq!(serde_json::from_slice::<Value>(&calls[4].body).unwrap(), json!({"targets": ["fixture@latest"]}));
    let promoted: Vec<(String, String)> =
        reqwest::Url::parse(&format!("http://localhost/?{}", calls[4].query.as_deref().unwrap_or("")))
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
    assert_eq!(
        promoted,
        vec![("location[directory]".to_owned(), h.linked.to_string_lossy().into_owned())],
        "body location must promote exact linked directory to query"
    );
    assert_eq!(calls[5].path, "/api/plugin/check");
    assert!(calls[5].dir_header.is_some(), "x-codenomad-location must forward x-opencode-directory");

    // 3. Upstream error passes through untouched (not rewritten as account contract error).
    h.clear_calls();
    *h.native.upstream_error.lock().unwrap() =
        Some((Status::UNPROCESSABLE_ENTITY, json!({"error": "plugin_check_failed"})));
    let res = proxy::relay(
        State(h.app.clone()),
        h.post_req(
            "/api/plugin/check",
            None,
            Some("application/json"),
            Some(serde_json::to_vec(&json!({"target": "bad@1"})).unwrap()),
            None,
        ),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), Status::UNPROCESSABLE_ENTITY);
    let err_body: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(err_body, json!({"error": "plugin_check_failed"}));
    *h.native.upstream_error.lock().unwrap() = None;

    // 4. Refusals: foreign query/body/top-level directory/header, workspaceID, conflicting locations, invalid bodies, carrier metadata.
    h.clear_calls();
    let foreign_q = format!("location[directory]={}", enc(&h.foreign));
    assert_eq!(
        proxy::relay(
            State(h.app.clone()),
            h.post_req("/api/experimental/mcp/my-server/connect", Some(&foreign_q), None, None, None),
        )
        .await
        .unwrap_err()
        .0,
        Status::FORBIDDEN
    );
    assert_eq!(
        proxy::relay(
            State(h.app.clone()),
            h.post_req("/api/plugin/check", Some(&foreign_q), Some("application/json"), Some(b"{}".to_vec()), None),
        )
        .await
        .unwrap_err()
        .0,
        Status::FORBIDDEN
    );
    assert_eq!(
        proxy::relay(
            State(h.app.clone()),
            h.post_req(
                "/api/plugin/update",
                None,
                Some("application/json"),
                Some(serde_json::to_vec(&json!({"targets":["x"],"location":{"directory": h.foreign}})).unwrap()),
                None,
            ),
        )
        .await
        .unwrap_err()
        .0,
        Status::FORBIDDEN
    );
    assert_eq!(
        proxy::relay(
            State(h.app.clone()),
            h.post_req(
                "/api/plugin/check",
                None,
                Some("application/json"),
                Some(serde_json::to_vec(&json!({"directory": h.foreign})).unwrap()),
                None,
            ),
        )
        .await
        .unwrap_err()
        .0,
        Status::FORBIDDEN
    );
    // Conflicting query vs header -> 400
    assert_eq!(
        proxy::relay(
            State(h.app.clone()),
            h.post_req("/api/experimental/mcp/my-server/connect", Some(&linked_q), None, None, Some(&h.root)),
        )
        .await
        .unwrap_err()
        .0,
        Status::BAD_REQUEST
    );
    // Unknown body key / invalid target / schedule carrier metadata
    assert_eq!(
        proxy::relay(
            State(h.app.clone()),
            h.post_req(
                "/api/experimental/mcp/my-server/connect",
                None,
                Some("application/json"),
                Some(b"{\"extra\":true}".to_vec()),
                None,
            ),
        )
        .await
        .unwrap_err()
        .0,
        Status::BAD_REQUEST
    );
    assert_eq!(
        proxy::relay(
            State(h.app.clone()),
            h.post_req(
                "/api/plugin/check",
                None,
                Some("application/json"),
                Some(serde_json::to_vec(&json!({"target": "   "})).unwrap()),
                None,
            ),
        )
        .await
        .unwrap_err()
        .0,
        Status::BAD_REQUEST
    );
    assert_eq!(
        proxy::relay(
            State(h.app.clone()),
            h.post_req(
                "/api/plugin/update",
                None,
                Some("application/json"),
                Some(serde_json::to_vec(&json!({"targets": [123]})).unwrap()),
                None,
            ),
        )
        .await
        .unwrap_err()
        .0,
        Status::BAD_REQUEST
    );
    assert_eq!(
        proxy::relay(
            State(h.app.clone()),
            h.post_req(
                "/api/plugin/check",
                None,
                Some("application/json"),
                Some(serde_json::to_vec(&json!({"metadata":{"schedule":true}})).unwrap()),
                None,
            ),
        )
        .await
        .unwrap_err()
        .0,
        Status::FORBIDDEN
    );
    // Worktree deletion fence blocks M7 mutations with 409.
    let key = fence::identity(&h.linked);
    let _block = fence::try_block(std::slice::from_ref(&key)).unwrap();
    assert_eq!(
        proxy::relay(
            State(h.app.clone()),
            h.post_req("/api/experimental/mcp/my-server/connect", Some(&linked_q), None, None, None),
        )
        .await
        .unwrap_err()
        .0,
        Status::CONFLICT
    );
    assert_eq!(
        proxy::relay(
            State(h.app.clone()),
            h.post_req("/api/plugin/check", Some(&linked_q), Some("application/json"), Some(b"{}".to_vec()), None),
        )
        .await
        .unwrap_err()
        .0,
        Status::CONFLICT
    );
    drop(_block);

    assert!(h.calls().is_empty(), "none of the refused M7 requests may reach native upstream");
}

#[tokio::test]
async fn session_shell_relays_with_environment_fences_and_skips_account_rotation() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("session-shell-relay").await;

    // 1. Owned root, linked worktree, and subfolder sessions succeed with 204 (both Rune {id,command} and Solid {command} shapes).
    let rune_body = serde_json::to_vec(&json!({"id": "msg_sh_1", "command": "echo hi"})).unwrap();
    let dir_q = format!("directory={}", enc(&h.root));
    let res = proxy::relay(
        State(h.app.clone()),
        h.post_req("/api/session/ses_shell_owned/shell", Some(&dir_q), Some("application/json"), Some(rune_body), None),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), Status::NO_CONTENT);

    let solid_body = serde_json::to_vec(&json!({"command": "pwd"})).unwrap();
    let res = proxy::relay(
        State(h.app.clone()),
        h.post_req(
            "/api/session/ses_shell_linked/shell",
            None,
            Some("application/json"),
            Some(solid_body.clone()),
            None,
        ),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), Status::NO_CONTENT);

    let res = proxy::relay(
        State(h.app.clone()),
        h.post_req("/api/session/ses_shell_sub/shell", None, Some("application/json"), Some(solid_body.clone()), None),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), Status::NO_CONTENT);

    let calls = h.calls();
    // Each shell call runs PUT /environment then POST /shell, and NEVER touches /api/provider or /api/credential.
    assert_eq!(calls.len(), 6);
    assert_eq!((calls[0].method.as_str(), calls[0].path.as_str()), ("PUT", "/api/session/ses_shell_owned/environment"));
    assert_eq!((calls[1].method.as_str(), calls[1].path.as_str()), ("POST", "/api/session/ses_shell_owned/shell"));
    assert_eq!(
        serde_json::from_slice::<Value>(&calls[1].body).unwrap(),
        json!({"id": "msg_sh_1", "command": "echo hi"})
    );
    assert_eq!(
        (calls[2].method.as_str(), calls[2].path.as_str()),
        ("PUT", "/api/session/ses_shell_linked/environment")
    );
    assert_eq!((calls[3].method.as_str(), calls[3].path.as_str()), ("POST", "/api/session/ses_shell_linked/shell"));
    assert_eq!((calls[4].method.as_str(), calls[4].path.as_str()), ("PUT", "/api/session/ses_shell_sub/environment"));
    assert_eq!((calls[5].method.as_str(), calls[5].path.as_str()), ("POST", "/api/session/ses_shell_sub/shell"));

    // 2. Environment sync failure returns 502 session_environment_failed with x-codenomad-before-dispatch: 1 and never dispatches /shell.
    h.clear_calls();
    *h.native.fail_environment.lock().unwrap() = true;
    let res = proxy::relay(
        State(h.app.clone()),
        h.post_req(
            "/api/session/ses_shell_owned/shell",
            None,
            Some("application/json"),
            Some(solid_body.clone()),
            None,
        ),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), Status::BAD_GATEWAY);
    assert_eq!(res.headers().get("x-codenomad-before-dispatch").and_then(|v| v.to_str().ok()), Some("1"));
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body["error"], "session_environment_failed");
    assert_eq!(h.calls().len(), 1, "only environment PUT ran; /shell was not dispatched");
    *h.native.fail_environment.lock().unwrap() = false;

    // 3. Refusals carry x-codenomad-before-dispatch: 1 and never reach native /shell.
    h.clear_calls();
    let assert_pre_dispatch = |res: Response, expected: Status| {
        assert_eq!(res.status(), expected);
        assert_eq!(res.headers().get("x-codenomad-before-dispatch").and_then(|v| v.to_str().ok()), Some("1"));
        res
    };

    // Foreign session -> 403 SESSION_LOCATED_ELSEWHERE
    let res = assert_pre_dispatch(
        proxy::relay(
            State(h.app.clone()),
            h.post_req(
                "/api/session/ses_shell_foreign/shell",
                None,
                Some("application/json"),
                Some(solid_body.clone()),
                None,
            ),
        )
        .await
        .unwrap(),
        Status::FORBIDDEN,
    );
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body["reason"], SESSION_LOCATED_ELSEWHERE);

    // Foreign ?directory -> 403
    let foreign_q = format!("directory={}", enc(&h.foreign));
    assert_pre_dispatch(
        proxy::relay(
            State(h.app.clone()),
            h.post_req(
                "/api/session/ses_shell_owned/shell",
                Some(&foreign_q),
                Some("application/json"),
                Some(solid_body.clone()),
                None,
            ),
        )
        .await
        .unwrap(),
        Status::FORBIDDEN,
    );

    // Schedule carriers (id prefix, marker, RPC owned=true) + carrier metadata in body -> 403
    for carrier_sid in ["ses_cn_schedule_1", "ses_shell_carrier_marker", "ses_shell_carrier_rpc"] {
        assert_pre_dispatch(
            proxy::relay(
                State(h.app.clone()),
                h.post_req(
                    &format!("/api/session/{carrier_sid}/shell"),
                    None,
                    Some("application/json"),
                    Some(solid_body.clone()),
                    None,
                ),
            )
            .await
            .unwrap(),
            Status::FORBIDDEN,
        );
    }
    assert_pre_dispatch(
        proxy::relay(
            State(h.app.clone()),
            h.post_req(
                "/api/session/ses_shell_owned/shell",
                None,
                Some("application/json"),
                Some(serde_json::to_vec(&json!({"command":"echo","metadata":{"automation":true}})).unwrap()),
                None,
            ),
        )
        .await
        .unwrap(),
        Status::FORBIDDEN,
    );

    // Non-JSON / non-object body -> 400
    assert_pre_dispatch(
        proxy::relay(
            State(h.app.clone()),
            h.post_req("/api/session/ses_shell_owned/shell", None, Some("text/plain"), Some(b"echo hi".to_vec()), None),
        )
        .await
        .unwrap(),
        Status::BAD_REQUEST,
    );

    // Worktree deletion fence -> 409
    let key = fence::identity(&h.linked);
    let _block = fence::try_block(std::slice::from_ref(&key)).unwrap();
    assert_pre_dispatch(
        proxy::relay(
            State(h.app.clone()),
            h.post_req(
                "/api/session/ses_shell_linked/shell",
                None,
                Some("application/json"),
                Some(solid_body.clone()),
                None,
            ),
        )
        .await
        .unwrap(),
        Status::CONFLICT,
    );
    drop(_block);

    // Blank-session cleanup fence -> 409
    let _cleanup = h.app.session_cleanup.enter_cleanup("ses_shell_owned").unwrap();
    assert_pre_dispatch(
        proxy::relay(
            State(h.app.clone()),
            h.post_req(
                "/api/session/ses_shell_owned/shell",
                None,
                Some("application/json"),
                Some(solid_body.clone()),
                None,
            ),
        )
        .await
        .unwrap(),
        Status::CONFLICT,
    );
    drop(_cleanup);

    // Cancelled principal before dispatch -> 401 with x-codenomad-before-dispatch: 1
    let mut cancelled_req = h.post_req(
        "/api/session/ses_shell_owned/shell",
        None,
        Some("application/json"),
        Some(solid_body.clone()),
        None,
    );
    let tok = CancellationToken::new();
    tok.cancel();
    cancelled_req.extensions_mut().insert(Principal(tok));
    assert_pre_dispatch(proxy::relay(State(h.app.clone()), cancelled_req).await.unwrap(), Status::UNAUTHORIZED);

    assert!(h.calls().is_empty(), "none of the rejected shell requests may reach native upstream");

    // 4. In-flight /shell holds worktree deletion fence and session_cleanup guard even after observer detaches.
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    *h.native.stall_route.lock().unwrap() =
        Some(("/api/session/ses_shell_owned/shell".into(), entered.clone(), release.clone()));
    let app = h.app.clone();
    let req = h.post_req("/api/session/ses_shell_owned/shell", None, Some("application/json"), Some(solid_body), None);
    let handle = tokio::spawn(async move { proxy::relay(State(app), req).await });
    tokio::time::timeout(Duration::from_secs(2), entered.notified()).await.unwrap();
    handle.abort();
    let _ = handle.await;
    assert!(h.app.session_cleanup.enter_cleanup("ses_shell_owned").is_none(), "cleanup guard must stay held");
    let root_key = fence::identity(&h.root);
    let deletion = fence::block(std::slice::from_ref(&root_key));
    tokio::pin!(deletion);
    assert!(futures_util::poll!(&mut deletion).is_pending(), "worktree deletion fence must stay held");
    release.notify_waiters();
    assert!(tokio::time::timeout(Duration::from_secs(2), deletion).await.unwrap().is_ok());
    assert!(h.app.session_cleanup.enter_cleanup("ses_shell_owned").is_some());
    *h.native.stall_route.lock().unwrap() = None;
}

#[tokio::test]
async fn remote_control_admits_m7_and_session_shell_for_paired_devices_and_refuses_unpaired() {
    let _git = crate::git::test_git_serial().await;
    let direct = Harness::new("m7-shell-remote").await;
    let ingress_h = Harness::new_with_ingress("m7-shell-remote-ingress", true).await;

    let origin = "https://10.0.0.5:9898";
    let host = "10.0.0.5:9898";
    for (ingress, is_server) in [(false, false), (false, true), (true, false), (true, true)] {
        let h = if ingress { &ingress_h } else { &direct };
        let payload = if ingress {
            axum::body::Bytes::new()
        } else {
            axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#))
        };
        let issued = devices::issue(State(h.app.clone()), payload).await;
        assert_eq!(issued.status(), Status::OK);
        let body = axum::body::to_bytes(issued.into_body(), 4096).await.unwrap();
        let link: Value = serde_json::from_slice(&body).unwrap();
        let code = link["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();

        let channel = tls::Channel {
            origin: origin.to_owned(),
            origins: Arc::from([origin.to_owned()]),
            ingress,
            socket: CancellationToken::new(),
            principal: Arc::new(Mutex::new(None)),
        };
        let router = crate::auth::remote_routes()
            .route("/workspaces/{id}/instance/{*route}", any(proxy::relay))
            .layer(from_fn_with_state((h.app.clone(), None), remote::admit))
            .layer(axum::Extension(channel))
            .with_state(h.app.clone());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let base = format!("http://{addr}");

        // Unpaired browser calls to M7 routes and /shell are rejected with 401; /shell carries before-dispatch header.
        if !is_server {
            let unauth_mcp = client
                .post(format!("{base}/workspaces/{}/instance/api/experimental/mcp/srv/connect", h.ws_id))
                .header(header::HOST, host)
                .header(header::ORIGIN, origin)
                .send()
                .await
                .unwrap();
            assert_eq!(unauth_mcp.status(), Status::UNAUTHORIZED);

            let unauth_plug = client
                .post(format!("{base}/workspaces/{}/instance/api/plugin/check", h.ws_id))
                .header(header::HOST, host)
                .header(header::ORIGIN, origin)
                .json(&json!({"target": "pkg@1"}))
                .send()
                .await
                .unwrap();
            assert_eq!(unauth_plug.status(), Status::UNAUTHORIZED);

            let unauth = client
                .post(format!("{base}/workspaces/{}/instance/api/session/ses_shell_owned/shell", h.ws_id))
                .header(header::HOST, host)
                .header(header::ORIGIN, origin)
                .json(&json!({"command": "echo no"}))
                .send()
                .await
                .unwrap();
            assert_eq!(unauth.status(), Status::UNAUTHORIZED);
            assert_eq!(unauth.headers().get("x-codenomad-before-dispatch").and_then(|v| v.to_str().ok()), Some("1"));
        }

        let cookie = if is_server {
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
        };

        let send = |builder: reqwest::RequestBuilder| {
            let b = builder.header(header::HOST, host).header(header::COOKIE, cookie.as_str());
            if is_server { b.header("x-codenomad-server-request", "1") } else { b.header(header::ORIGIN, origin) }
        };

        let mcp_res =
            send(client.post(format!("{base}/workspaces/{}/instance/api/experimental/mcp/srv/connect", h.ws_id)))
                .send()
                .await
                .unwrap();
        assert_eq!(mcp_res.status(), Status::OK);

        let plug_res = send(client.post(format!("{base}/workspaces/{}/instance/api/plugin/check", h.ws_id)))
            .json(&json!({"target": "pkg@1"}))
            .send()
            .await
            .unwrap();
        assert_eq!(plug_res.status(), Status::OK);

        let shell_res =
            send(client.post(format!("{base}/workspaces/{}/instance/api/session/ses_shell_owned/shell", h.ws_id)))
                .json(&json!({"id": "msg_remote_1", "command": "echo ok"}))
                .send()
                .await
                .unwrap();
        assert_eq!(shell_res.status(), Status::NO_CONTENT);

        server.abort();
    }
}
