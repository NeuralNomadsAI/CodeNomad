//! Parity tests for `POST /workspaces/:id/instance/api/session/:session/background`.
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
struct RecordedBackground {
    path: String,
    query: Option<String>,
    content_type: Option<String>,
    body: Vec<u8>,
}

struct FakeNative {
    root: PathBuf,
    root_sub: PathBuf,
    linked: PathBuf,
    foreign: PathBuf,
    backgrounds: Mutex<Vec<RecordedBackground>>,
    error_override: Mutex<Option<(Status, Value)>>,
    stall_carrier_read: Mutex<Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
}

async fn git_fixture(path: &Path, args: &[&str]) {
    let output = crate::git::command(path, args).output().await.unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

async fn fake_native(State(f): State<Arc<FakeNative>>, request: Request) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().map(str::to_owned);
    let content_type = request.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let body = axum::body::to_bytes(request.into_body(), 64 * 1024).await.unwrap().to_vec();
    let ok = |v: Value| Json(v).into_response();

    match (method, path.as_str()) {
        (Method::GET, "/api/location") => ok(json!({
            "directory": f.root,
            "project": {"id": "project_bg", "directory": f.root, "canonical": f.root}
        })),
        (Method::GET, "/api/worktree") => ok(json!([
            {"directory": f.root},
            {"directory": f.linked}
        ])),
        (Method::POST, "/api/worktree/refresh") => Status::NO_CONTENT.into_response(),
        (Method::POST, "/api/rpc/codenomad.missions/scheduleCarrierRead") => {
            let stall = f.stall_carrier_read.lock().unwrap().clone();
            if let Some((entered, release)) = stall {
                entered.notify_one();
                release.notified().await;
            }
            let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let owned = parsed["input"]["sessionID"].as_str() == Some("ses_bg_carrier_rpc");
            ok(json!({"output": {"owned": owned}}))
        }
        (Method::GET, p) if p.starts_with("/api/session/") => {
            let id = p.trim_start_matches("/api/session/");
            let session = |dir: &Path, extra_meta: Option<Value>| {
                let mut data = json!({
                    "id": id,
                    "projectID": "project_bg",
                    "location": {"directory": dir},
                    "title": id,
                    "time": {"created": 1}
                });
                if let Some(meta) = extra_meta {
                    data["metadata"] = meta;
                }
                ok(json!({"data": data}))
            };
            match id {
                "ses_bg_owned" => session(&f.root, None),
                "ses_bg_sub" => session(&f.root_sub, None),
                "ses_bg_linked" => session(&f.linked, None),
                "ses_bg_foreign" => session(&f.foreign, None),
                "ses_bg_carrier_marker" => session(&f.root, Some(json!({"codenomad.schedule-carrier": true}))),
                "ses_bg_carrier_rpc" => session(&f.root, None),
                "ses_cn_schedule_1" => session(&f.root, None),
                _ => (
                    Status::NOT_FOUND,
                    Json(json!({"_tag": "SessionNotFoundError", "sessionID": id, "message": "Session not found"})),
                )
                    .into_response(),
            }
        }
        (Method::POST, p) if p.starts_with("/api/session/") && p.ends_with("/background") => {
            f.backgrounds.lock().unwrap().push(RecordedBackground { path, query, content_type, body });
            if let Some((status, payload)) = f.error_override.lock().unwrap().clone() {
                return (status, Json(payload)).into_response();
            }
            Status::NO_CONTENT.into_response()
        }
        _ => Status::NOT_IMPLEMENTED.into_response(),
    }
}

struct Harness {
    dir: PathBuf,
    root: PathBuf,
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
            root_sub,
            linked: linked.clone(),
            foreign: foreign.clone(),
            backgrounds: Mutex::new(Vec::new()),
            error_override: Mutex::new(None),
            stall_carrier_read: Mutex::new(None),
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
        Self { dir, root, linked, foreign, native, app, ws_id, http }
    }

    fn background_req(
        &self,
        session: &str,
        query: Option<&str>,
        content_type: Option<&str>,
        body: Option<Vec<u8>>,
        location_header: Option<&Path>,
    ) -> Request {
        let mut uri = format!("/workspaces/{}/instance/api/session/{session}/background", self.ws_id);
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

    fn recorded(&self) -> Vec<RecordedBackground> {
        self.native.backgrounds.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn background_relays_empty_post_without_content_type_and_preserves_204() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("bg-relay").await;

    // 1. Standard codenomad-client / @opencode/client call: empty POST body, no Content-Type.
    let res =
        proxy::relay(State(h.app.clone()), h.background_req("ses_bg_owned", None, None, None, None)).await.unwrap();
    assert_eq!(res.status(), Status::NO_CONTENT);
    let body = axum::body::to_bytes(res.into_body(), 1024).await.unwrap();
    assert!(body.is_empty());

    // 2. Linked worktree session with ambient workspace root `x-codenomad-location` header.
    let res = proxy::relay(State(h.app.clone()), h.background_req("ses_bg_linked", None, None, None, Some(&h.root)))
        .await
        .unwrap();
    assert_eq!(res.status(), Status::NO_CONTENT);

    // 3. Explicit empty JSON object `{}` with case-insensitive `Application/JSON; charset=utf-8`.
    let res = proxy::relay(
        State(h.app.clone()),
        h.background_req("ses_bg_owned", None, Some("Application/JSON; charset=utf-8"), Some(b"{}".to_vec()), None),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), Status::NO_CONTENT);

    // 4. Positive owned `location[directory]` query (including separate workspace root for linked session) and subfolder session.
    let owned_q = format!(
        "location[directory]={}",
        percent_encoding::utf8_percent_encode(h.root.to_string_lossy().as_ref(), percent_encoding::NON_ALPHANUMERIC)
    );
    let res = proxy::relay(State(h.app.clone()), h.background_req("ses_bg_owned", Some(&owned_q), None, None, None))
        .await
        .unwrap();
    assert_eq!(res.status(), Status::NO_CONTENT);

    let res = proxy::relay(State(h.app.clone()), h.background_req("ses_bg_linked", Some(&owned_q), None, None, None))
        .await
        .unwrap();
    assert_eq!(res.status(), Status::NO_CONTENT);

    let res = proxy::relay(State(h.app.clone()), h.background_req("ses_bg_sub", None, None, None, None)).await.unwrap();
    assert_eq!(res.status(), Status::NO_CONTENT);

    // 5. Upstream error status & body passthrough.
    *h.native.error_override.lock().unwrap() =
        Some((Status::CONFLICT, json!({"_tag": "SessionBusyError", "message": "Cannot background"})));
    let err_resp =
        proxy::relay(State(h.app.clone()), h.background_req("ses_bg_owned", None, None, None, None)).await.unwrap();
    assert_eq!(err_resp.status(), Status::CONFLICT);
    let err_json: Value =
        serde_json::from_slice(&axum::body::to_bytes(err_resp.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(err_json["_tag"], "SessionBusyError");
    *h.native.error_override.lock().unwrap() = None;

    let recorded = h.recorded();
    assert_eq!(recorded.len(), 7);
    assert_eq!(recorded[0].path, "/api/session/ses_bg_owned/background");
    assert_eq!(recorded[0].query, None);
    assert_eq!(recorded[0].content_type, None, "empty POST must not synthesize Content-Type");
    assert!(recorded[0].body.is_empty(), "empty POST must not synthesize {{}} body");

    assert_eq!(recorded[1].path, "/api/session/ses_bg_linked/background");
    assert_eq!(recorded[1].query, None);
    assert_eq!(recorded[1].content_type, None);
    assert!(recorded[1].body.is_empty());

    assert_eq!(recorded[2].path, "/api/session/ses_bg_owned/background");
    assert_eq!(recorded[2].content_type.as_deref(), Some("application/json"));
    assert_eq!(recorded[2].body, b"{}");

    assert_eq!(recorded[3].path, "/api/session/ses_bg_owned/background");
    assert_eq!(recorded[3].content_type, None);
    assert!(recorded[3].body.is_empty());
}

#[tokio::test]
async fn background_enforces_ownership_carrier_body_validation_and_deletion_fence() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("bg-guards").await;

    // Foreign session -> 403 with session_located_elsewhere.
    let err = proxy::relay(State(h.app.clone()), h.background_req("ses_bg_foreign", None, None, None, None))
        .await
        .unwrap_err();
    assert_eq!(err.0, Status::FORBIDDEN);
    assert_eq!(err.1.0["reason"], SESSION_LOCATED_ELSEWHERE);

    // Missing session -> 404 relayed.
    let err =
        proxy::relay(State(h.app.clone()), h.background_req("ses_missing", None, None, None, None)).await.unwrap_err();
    assert_eq!(err.0, Status::NOT_FOUND);

    // Foreign query directory & foreign ambient location header -> 403.
    let foreign_q = format!(
        "location[directory]={}",
        percent_encoding::utf8_percent_encode(h.foreign.to_string_lossy().as_ref(), percent_encoding::NON_ALPHANUMERIC)
    );
    let err = proxy::relay(State(h.app.clone()), h.background_req("ses_bg_owned", Some(&foreign_q), None, None, None))
        .await
        .unwrap_err();
    assert_eq!(err.0, Status::FORBIDDEN);
    let err = proxy::relay(State(h.app.clone()), h.background_req("ses_bg_owned", None, None, None, Some(&h.foreign)))
        .await
        .unwrap_err();
    assert_eq!(err.0, Status::FORBIDDEN);

    // Mission schedule carriers -> 403.
    for carrier_id in ["ses_cn_schedule_1", "ses_bg_carrier_marker", "ses_bg_carrier_rpc"] {
        let err =
            proxy::relay(State(h.app.clone()), h.background_req(carrier_id, None, None, None, None)).await.unwrap_err();
        assert_eq!(err.0, Status::FORBIDDEN, "carrier {carrier_id} must be refused");
    }
    let err = proxy::relay(
        State(h.app.clone()),
        h.background_req(
            "ses_bg_owned",
            None,
            Some("application/json"),
            Some(br#"{"metadata":{"schedule":true}}"#.to_vec()),
            None,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(err.0, Status::FORBIDDEN);

    // Body validation: parentID (403), non-object/invalid JSON/non-JSON (400), unknown field (501).
    let err = proxy::relay(
        State(h.app.clone()),
        h.background_req(
            "ses_bg_owned",
            None,
            Some("application/json"),
            Some(br#"{"parentID":"ses_1"}"#.to_vec()),
            None,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(err.0, Status::FORBIDDEN);

    for (ct, payload) in [
        (Some("application/json"), b"[]".to_vec()),
        (Some("application/json"), b"{bad".to_vec()),
        (Some("application/jsonp"), b"{}".to_vec()),
        (Some("text/plain"), b"{}".to_vec()),
    ] {
        let err = proxy::relay(State(h.app.clone()), h.background_req("ses_bg_owned", None, ct, Some(payload), None))
            .await
            .unwrap_err();
        assert_eq!(err.0, Status::BAD_REQUEST);
    }

    let unknown = proxy::relay(
        State(h.app.clone()),
        h.background_req("ses_bg_owned", None, Some("application/json"), Some(br#"{"extra":true}"#.to_vec()), None),
    )
    .await
    .unwrap();
    assert_eq!(unknown.status(), Status::NOT_IMPLEMENTED);

    // Pseudo-session segments (`active`, `global`) must fail closed locally without relaying.
    for pseudo in ["active", "global"] {
        let res = proxy::relay(State(h.app.clone()), h.background_req(pseudo, None, None, None, None)).await.unwrap();
        assert_eq!(res.status(), Status::NOT_IMPLEMENTED, "pseudo-session {pseudo}/background must not relay");
    }

    // Active worktree deletion fence -> 409 Conflict.
    let key = fence::identity(&fence::checkout_root(&h.app.scope, &h.linked));
    let _deletion = fence::block(std::slice::from_ref(&key)).await.unwrap();
    let err = proxy::relay(State(h.app.clone()), h.background_req("ses_bg_linked", None, None, None, None))
        .await
        .unwrap_err();
    assert_eq!(err.0, Status::CONFLICT);
    drop(_deletion);

    // Active per-session fence -> 409 Conflict.
    let session_key = fence::session("ses_bg_owned");
    let _session_lock = fence::block(std::slice::from_ref(&session_key)).await.unwrap();
    let err =
        proxy::relay(State(h.app.clone()), h.background_req("ses_bg_owned", None, None, None, None)).await.unwrap_err();
    assert_eq!(err.0, Status::CONFLICT);
    drop(_session_lock);

    // Principal revocation during `scheduleCarrierRead` aborts with 401 before dispatching `/background`.
    let (entered, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    *h.native.stall_carrier_read.lock().unwrap() = Some((entered.clone(), release.clone()));
    let cancel = CancellationToken::new();
    let mut req = h.background_req("ses_bg_owned", None, None, None, None);
    req.extensions_mut().insert(Principal(cancel.clone()));
    let app_bg = h.app.clone();
    let mut task = tokio::spawn(async move { proxy::relay(State(app_bg), req).await });
    tokio::select! {
        res = &mut task => panic!("relay exited before scheduleCarrierRead stall: {res:?}"),
        waited = tokio::time::timeout(Duration::from_secs(15), entered.notified()) => {
            waited.expect("timed out waiting for scheduleCarrierRead stall");
        }
    }
    cancel.cancel();
    let err = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(err.0, Status::UNAUTHORIZED);
    release.notify_waiters();
    *h.native.stall_carrier_read.lock().unwrap() = None;

    assert!(h.recorded().is_empty(), "none of the rejected requests may reach native /background");
}

#[tokio::test]
async fn remote_control_catalog_admits_session_background() {
    let _git = crate::git::test_git_serial().await;
    let direct = Harness::new("bg-remote").await;
    let ingress_h = Harness::new_with_ingress("bg-remote-ingress", true).await;

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

        let mut req = client
            .post(format!("{base}/workspaces/{}/instance/api/session/ses_bg_owned/background", h.ws_id))
            .header(header::HOST, host)
            .header(header::COOKIE, cookie);
        if is_server {
            req = req.header("x-codenomad-server-request", "1");
        } else {
            req = req.header(header::ORIGIN, origin);
        }
        let res = req.send().await.unwrap();
        assert_eq!(res.status(), Status::NO_CONTENT);
        server.abort();
    }

    for h in [&direct, &ingress_h] {
        let recorded = h.recorded();
        assert_eq!(recorded.len(), 2);
        for rec in recorded {
            assert_eq!(rec.path, "/api/session/ses_bg_owned/background");
            assert_eq!(rec.content_type, None);
            assert!(rec.body.is_empty());
        }
    }
}
