//! Parity tests for session inbox proxy routes:
//! - `GET /workspaces/:id/instance/api/session/:session/inbox`
//! - `PATCH /workspaces/:id/instance/api/session/:session/inbox/:inboxID`
//! - `DELETE /workspaces/:id/instance/api/session/:session/inbox/:inboxID`
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
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    App, Shared, Workspace,
    auth::{Principal, devices, remote, tls},
    opencode::{Native, SESSION_LOCATED_ELSEWHERE, proxy},
    worktrees::fence,
};

#[derive(Clone, Debug)]
struct RecordedInbox {
    method: Method,
    path: String,
    query: Option<String>,
    content_type: Option<String>,
    body: Vec<u8>,
}

struct FakeNative {
    root: PathBuf,
    root_sub: PathBuf,
    linked: PathBuf,
    linked_sub: PathBuf,
    foreign: PathBuf,
    calls: Mutex<Vec<RecordedInbox>>,
    error_override: Mutex<Option<(Status, Value)>>,
    stall_session_get: Mutex<Option<(Arc<Notify>, Arc<Notify>)>>,
    stall_session_get_nth: Mutex<Option<(usize, usize, Arc<Notify>, Arc<Notify>)>>,
    stall_carrier_read: Mutex<Option<(Arc<Notify>, Arc<Notify>)>>,
    stall_inbox_get: Mutex<Option<(Arc<Notify>, Arc<Notify>)>>,
    stall_inbox_write: Mutex<Option<(Arc<Notify>, Arc<Notify>)>>,
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

    match (method.clone(), path.as_str()) {
        (Method::GET, "/api/location") => ok(json!({
            "directory": f.root,
            "project": {"id": "project_inb", "directory": f.root, "canonical": f.root}
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
            let owned = parsed["input"]["sessionID"].as_str() == Some("ses_inb_carrier_rpc");
            ok(json!({"output": {"owned": owned}}))
        }
        (Method::GET, p) if p.starts_with("/api/session/") && p.ends_with("/inbox") => {
            let stall = f.stall_inbox_get.lock().unwrap().clone();
            if let Some((entered, release)) = stall {
                entered.notify_one();
                release.notified().await;
            }
            f.calls.lock().unwrap().push(RecordedInbox { method, path, query, content_type, body });
            if let Some((status, payload)) = f.error_override.lock().unwrap().clone() {
                return (status, Json(payload)).into_response();
            }
            ok(json!({
                "data": [{
                    "id": "inb_1",
                    "type": "user",
                    "delivery": "queue",
                    "payload": {"text": "Queued follow-up"}
                }]
            }))
        }
        (Method::PATCH | Method::DELETE, p) if p.starts_with("/api/session/") && p.contains("/inbox/") => {
            let stall = f.stall_inbox_write.lock().unwrap().clone();
            if let Some((entered, release)) = stall {
                entered.notify_one();
                release.notified().await;
            }
            f.calls.lock().unwrap().push(RecordedInbox { method, path, query, content_type, body });
            if let Some((status, payload)) = f.error_override.lock().unwrap().clone() {
                return (status, Json(payload)).into_response();
            }
            Status::NO_CONTENT.into_response()
        }
        (Method::GET, p) if p.starts_with("/api/session/") && !p[13..].contains('/') => {
            let stall = f.stall_session_get.lock().unwrap().clone();
            if let Some((entered, release)) = stall {
                entered.notify_one();
                release.notified().await;
            }
            let nth_stall = {
                let mut guard = f.stall_session_get_nth.lock().unwrap();
                if let Some((target, seen, entered, release)) = guard.as_mut() {
                    *seen += 1;
                    if *seen == *target { Some((entered.clone(), release.clone())) } else { None }
                } else {
                    None
                }
            };
            if let Some((entered, release)) = nth_stall {
                entered.notify_one();
                release.notified().await;
            }
            let id = &p[13..];
            let session = |dir: &Path, extra_meta: Option<Value>| {
                let mut data = json!({
                    "id": id,
                    "projectID": "project_inb",
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
                "ses_inb_owned" => session(&f.root, None),
                "ses_inb_sub" => session(&f.root_sub, None),
                "ses_inb_linked" => session(&f.linked, None),
                "ses_inb_linked_sub" => session(&f.linked_sub, None),
                "ses_inb_foreign" => session(&f.foreign, None),
                "ses_inb_carrier_marker" => session(&f.root, Some(json!({"codenomad.schedule-carrier": true}))),
                "ses_inb_carrier_rpc" => session(&f.root, None),
                "ses_cn_schedule_1" => session(&f.root, None),
                _ => (
                    Status::NOT_FOUND,
                    Json(json!({"_tag": "SessionNotFoundError", "sessionID": id, "message": "Session not found"})),
                )
                    .into_response(),
            }
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
        let root_sub = root.join("sub");
        std::fs::create_dir_all(&root_sub).unwrap();
        let root_sub = dunce::canonicalize(&root_sub).unwrap();
        let linked = dunce::canonicalize(&linked).unwrap();
        let linked_sub = linked.join("sub");
        std::fs::create_dir_all(&linked_sub).unwrap();
        let linked_sub = dunce::canonicalize(&linked_sub).unwrap();
        let foreign = dunce::canonicalize(&foreign).unwrap();

        let native = Arc::new(FakeNative {
            root: root.clone(),
            root_sub,
            linked: linked.clone(),
            linked_sub,
            foreign: foreign.clone(),
            calls: Mutex::new(Vec::new()),
            error_override: Mutex::new(None),
            stall_session_get: Mutex::new(None),
            stall_session_get_nth: Mutex::new(None),
            stall_carrier_read: Mutex::new(None),
            stall_inbox_get: Mutex::new(None),
            stall_inbox_write: Mutex::new(None),
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

    fn req(
        &self,
        method: Method,
        route: &str,
        content_type: Option<&str>,
        body: Option<Vec<u8>>,
        location_header: Option<&Path>,
        cancel: CancellationToken,
    ) -> Request {
        let uri = format!("/workspaces/{}/instance{route}", self.ws_id);
        let mut builder = Request::builder().method(method).uri(uri);
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
        req.extensions_mut().insert(Principal(cancel));
        req
    }

    fn recorded(&self) -> Vec<RecordedInbox> {
        self.native.calls.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn inbox_relays_get_patch_delete_and_preserves_bodies_and_errors() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("inbox-relay").await;

    // 1. GET /inbox on root & linked worktree (with ambient workspace root header).
    let list_res = proxy::relay(
        State(h.app.clone()),
        h.req(Method::GET, "/api/session/ses_inb_owned/inbox", None, None, None, CancellationToken::new()),
    )
    .await
    .unwrap();
    assert_eq!(list_res.status(), Status::OK);
    let list_json: Value =
        serde_json::from_slice(&axum::body::to_bytes(list_res.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(list_json["data"][0]["id"], "inb_1");
    assert_eq!(list_json["data"][0]["delivery"], "queue");

    let linked_list = proxy::relay(
        State(h.app.clone()),
        h.req(Method::GET, "/api/session/ses_inb_linked/inbox", None, None, Some(&h.root), CancellationToken::new()),
    )
    .await
    .unwrap();
    assert_eq!(linked_list.status(), Status::OK);

    // 2. PATCH /inbox/:inboxID with uppercase Content-Type, queue toggle, and empty body preservation.
    let patch_steer = proxy::relay(
        State(h.app.clone()),
        h.req(
            Method::PATCH,
            "/api/session/ses_inb_owned/inbox/inb_1",
            Some("Application/JSON; charset=utf-8"),
            Some(br#"{"delivery":"steer"}"#.to_vec()),
            None,
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(patch_steer.status(), Status::NO_CONTENT);

    let patch_empty = proxy::relay(
        State(h.app.clone()),
        h.req(
            Method::PATCH,
            "/api/session/ses_inb_linked/inbox/inb_1",
            None,
            None,
            Some(&h.root),
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(patch_empty.status(), Status::NO_CONTENT);

    // 3. DELETE /inbox/:inboxID with empty body (no synthesized Content-Type or JSON).
    let del_res = proxy::relay(
        State(h.app.clone()),
        h.req(Method::DELETE, "/api/session/ses_inb_owned/inbox/inb_1", None, None, None, CancellationToken::new()),
    )
    .await
    .unwrap();
    assert_eq!(del_res.status(), Status::NO_CONTENT);

    // 4. Upstream error status & JSON payload preservation across GET, PATCH, DELETE.
    *h.native.error_override.lock().unwrap() = Some((
        Status::NOT_FOUND,
        json!({"_tag": "InboxItemNotFoundError", "inboxID": "inb_missing", "message": "Not queued"}),
    ));
    for (method, route, ct, body) in [
        (Method::GET, "/api/session/ses_inb_owned/inbox", None, None),
        (
            Method::PATCH,
            "/api/session/ses_inb_owned/inbox/inb_missing",
            Some("application/json"),
            Some(br#"{"delivery":"queue"}"#.to_vec()),
        ),
        (Method::DELETE, "/api/session/ses_inb_owned/inbox/inb_missing", None, None),
    ] {
        let resp =
            proxy::relay(State(h.app.clone()), h.req(method.clone(), route, ct, body, None, CancellationToken::new()))
                .await
                .unwrap();
        assert_eq!(resp.status(), Status::NOT_FOUND, "{method} {route}");
        let err_json: Value =
            serde_json::from_slice(&axum::body::to_bytes(resp.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(err_json["_tag"], "InboxItemNotFoundError");
    }

    let recorded = h.recorded();
    assert_eq!(recorded.len(), 8);
    assert_eq!(recorded[0].method, Method::GET);
    assert_eq!(recorded[0].path, "/api/session/ses_inb_owned/inbox");
    assert_eq!(recorded[0].query, None);
    assert_eq!(recorded[2].method, Method::PATCH);
    assert_eq!(recorded[2].path, "/api/session/ses_inb_owned/inbox/inb_1");
    assert_eq!(recorded[2].content_type.as_deref(), Some("application/json"));
    assert_eq!(serde_json::from_slice::<Value>(&recorded[2].body).unwrap(), json!({"delivery": "steer"}));
    assert_eq!(recorded[3].method, Method::PATCH);
    assert_eq!(recorded[3].content_type, None, "empty PATCH must not synthesize Content-Type");
    assert!(recorded[3].body.is_empty(), "empty PATCH must not synthesize JSON body");
    assert_eq!(recorded[4].method, Method::DELETE);
    assert_eq!(recorded[4].content_type, None);
    assert!(recorded[4].body.is_empty());

    // 5. Cross-worktree owned query (`location[directory]=<root>` for linked session) and subfolder sessions.
    *h.native.error_override.lock().unwrap() = None;
    let root_q = format!(
        "location[directory]={}",
        percent_encoding::utf8_percent_encode(h.root.to_string_lossy().as_ref(), percent_encoding::NON_ALPHANUMERIC)
    );
    let cross_get = proxy::relay(
        State(h.app.clone()),
        h.req(
            Method::GET,
            &format!("/api/session/ses_inb_linked/inbox?{root_q}"),
            None,
            None,
            None,
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(cross_get.status(), Status::OK);

    let cross_patch = proxy::relay(
        State(h.app.clone()),
        h.req(
            Method::PATCH,
            &format!("/api/session/ses_inb_linked/inbox/inb_1?{root_q}"),
            Some("application/json"),
            Some(br#"{"delivery":"queue"}"#.to_vec()),
            None,
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(cross_patch.status(), Status::NO_CONTENT);

    // Sending both `directory` and `location[directory]` for owned workspace locations is admitted like TS.
    let root_enc =
        percent_encoding::utf8_percent_encode(h.root.to_string_lossy().as_ref(), percent_encoding::NON_ALPHANUMERIC)
            .to_string();
    let dual_q = format!("directory={root_enc}&location[directory]={root_enc}");
    let dual_get = proxy::relay(
        State(h.app.clone()),
        h.req(
            Method::GET,
            &format!("/api/session/ses_inb_linked/inbox?{dual_q}"),
            None,
            None,
            None,
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(dual_get.status(), Status::OK);

    for (method, route, ctx) in [
        (Method::GET, "/api/session/ses_inb_sub/inbox", Some(h.native.root_sub.as_path())),
        (Method::PATCH, "/api/session/ses_inb_sub/inbox/inb_1", Some(h.native.root_sub.as_path())),
        (Method::GET, "/api/session/ses_inb_linked_sub/inbox", Some(h.root.as_path())),
        (Method::DELETE, "/api/session/ses_inb_linked_sub/inbox/inb_1", Some(h.root.as_path())),
    ] {
        let resp =
            proxy::relay(State(h.app.clone()), h.req(method.clone(), route, None, None, ctx, CancellationToken::new()))
                .await
                .unwrap();
        let expected = if method == Method::GET { Status::OK } else { Status::NO_CONTENT };
        assert_eq!(resp.status(), expected, "{method} {route}");
    }
}

#[tokio::test]
async fn inbox_enforces_allowlist_ownership_carriers_validation_fences_and_revocation() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("inbox-guards").await;

    // 1. Disallowed methods and paths fail closed with 403 (unallowlisted) or 400 (dot traversal).
    for (method, route) in [
        (Method::POST, "/api/session/ses_inb_owned/inbox"),
        (Method::POST, "/api/session/ses_inb_owned/inbox/inb_1"),
        (Method::GET, "/api/session/ses_inb_owned/inbox/inb_1"),
        (Method::PUT, "/api/session/ses_inb_owned/inbox/inb_1"),
        (Method::PATCH, "/api/session/ses_inb_owned/inbox"),
        (Method::DELETE, "/api/session/ses_inb_owned/inbox"),
        (Method::DELETE, "/api/session/ses_inb_owned/inbox/inb_1/extra"),
    ] {
        let err = proxy::relay(
            State(h.app.clone()),
            h.req(method.clone(), route, None, None, None, CancellationToken::new()),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, Status::FORBIDDEN, "{method} {route}");
    }
    let dot_err = proxy::relay(
        State(h.app.clone()),
        h.req(
            Method::GET,
            "/api/session/ses_inb_owned/%2e%2e/ses_inb_foreign/inbox",
            None,
            None,
            None,
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(dot_err.0, Status::BAD_REQUEST);

    // 2. Pseudo-session segments (`active`, `global`) fail closed on GET, PATCH, and DELETE.
    for pseudo in ["active", "global"] {
        for (method, suffix) in
            [(Method::GET, "/inbox"), (Method::PATCH, "/inbox/inb_1"), (Method::DELETE, "/inbox/inb_1")]
        {
            let res = proxy::relay(
                State(h.app.clone()),
                h.req(
                    method.clone(),
                    &format!("/api/session/{pseudo}{suffix}"),
                    None,
                    None,
                    None,
                    CancellationToken::new(),
                ),
            )
            .await
            .unwrap();
            assert_eq!(res.status(), Status::NOT_IMPLEMENTED, "{method} {pseudo}{suffix}");
        }
    }

    // 3. Ownership, foreign ambient location, missing session, and schedule carriers.
    let foreign = proxy::relay(
        State(h.app.clone()),
        h.req(Method::GET, "/api/session/ses_inb_foreign/inbox", None, None, None, CancellationToken::new()),
    )
    .await
    .unwrap_err();
    assert_eq!(foreign.0, Status::FORBIDDEN);
    assert_eq!(foreign.1.0["reason"], SESSION_LOCATED_ELSEWHERE);

    let foreign_hdr = proxy::relay(
        State(h.app.clone()),
        h.req(
            Method::DELETE,
            "/api/session/ses_inb_owned/inbox/inb_1",
            None,
            None,
            Some(&h.foreign),
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(foreign_hdr.0, Status::FORBIDDEN);

    let missing = proxy::relay(
        State(h.app.clone()),
        h.req(Method::GET, "/api/session/ses_missing/inbox", None, None, None, CancellationToken::new()),
    )
    .await
    .unwrap_err();
    assert_eq!(missing.0, Status::NOT_FOUND);

    for carrier_id in ["ses_cn_schedule_1", "ses_inb_carrier_marker", "ses_inb_carrier_rpc"] {
        let err = proxy::relay(
            State(h.app.clone()),
            h.req(
                Method::PATCH,
                &format!("/api/session/{carrier_id}/inbox/inb_1"),
                Some("application/json"),
                Some(br#"{"delivery":"steer"}"#.to_vec()),
                None,
                CancellationToken::new(),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, Status::FORBIDDEN, "carrier {carrier_id}");
    }

    // 4. Body validation: bad Content-Type (including `application/jsonp`), invalid delivery, parentID, extra field.
    for (ct, payload) in [
        (Some("application/jsonp"), br#"{"delivery":"steer"}"#.to_vec()),
        (Some("text/plain"), br#"{"delivery":"steer"}"#.to_vec()),
        (Some("application/json"), br#"{"delivery":"bogus"}"#.to_vec()),
        (Some("application/json"), b"[]".to_vec()),
    ] {
        let err = proxy::relay(
            State(h.app.clone()),
            h.req(
                Method::PATCH,
                "/api/session/ses_inb_owned/inbox/inb_1",
                ct,
                Some(payload),
                None,
                CancellationToken::new(),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, Status::BAD_REQUEST);
    }
    let parent_err = proxy::relay(
        State(h.app.clone()),
        h.req(
            Method::PATCH,
            "/api/session/ses_inb_owned/inbox/inb_1",
            Some("application/json"),
            Some(br#"{"parentID":"ses_1"}"#.to_vec()),
            None,
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(parent_err.0, Status::FORBIDDEN);

    // 5. Worktree deletion fence & per-session fence block PATCH/DELETE with 409 Conflict.
    let wt_key = fence::identity(&fence::checkout_root(&h.app.scope, &h.linked));
    let _wt_lock = fence::block(std::slice::from_ref(&wt_key)).await.unwrap();
    let err = proxy::relay(
        State(h.app.clone()),
        h.req(Method::DELETE, "/api/session/ses_inb_linked/inbox/inb_1", None, None, None, CancellationToken::new()),
    )
    .await
    .unwrap_err();
    assert_eq!(err.0, Status::CONFLICT);
    drop(_wt_lock);

    let ses_key = fence::session("ses_inb_owned");
    let _ses_lock = fence::block(std::slice::from_ref(&ses_key)).await.unwrap();
    let err = proxy::relay(
        State(h.app.clone()),
        h.req(
            Method::PATCH,
            "/api/session/ses_inb_owned/inbox/inb_1",
            Some("application/json"),
            Some(br#"{"delivery":"steer"}"#.to_vec()),
            None,
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(err.0, Status::CONFLICT);
    drop(_ses_lock);

    // 6. Principal revocation aborts immediately during admission (`session.get`), carrier check, and GET headers.
    let (entered, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *h.native.stall_session_get.lock().unwrap() = Some((entered.clone(), release.clone()));
    let cancel = CancellationToken::new();
    let req = h.req(Method::GET, "/api/session/ses_inb_owned/inbox", None, None, None, cancel.clone());
    let app = h.app.clone();
    let mut task = tokio::spawn(async move { proxy::relay(State(app), req).await });
    tokio::select! {
        res = &mut task => panic!("relay exited before session.get stall: {res:?}"),
        waited = tokio::time::timeout(Duration::from_secs(15), entered.notified()) => {
            waited.expect("timed out waiting for session.get stall");
        }
    }
    cancel.cancel();
    let err = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(err.0, Status::UNAUTHORIZED, "revocation during session.get admission must abort with 401");
    release.notify_waiters();
    *h.native.stall_session_get.lock().unwrap() = None;

    let (entered, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *h.native.stall_carrier_read.lock().unwrap() = Some((entered.clone(), release.clone()));
    let cancel = CancellationToken::new();
    let req = h.req(
        Method::PATCH,
        "/api/session/ses_inb_owned/inbox/inb_1",
        Some("application/json"),
        Some(br#"{"delivery":"steer"}"#.to_vec()),
        None,
        cancel.clone(),
    );
    let app = h.app.clone();
    let mut task = tokio::spawn(async move { proxy::relay(State(app), req).await });
    tokio::select! {
        res = &mut task => panic!("relay exited before scheduleCarrierRead stall: {res:?}"),
        waited = tokio::time::timeout(Duration::from_secs(15), entered.notified()) => {
            waited.expect("timed out waiting for scheduleCarrierRead stall");
        }
    }
    cancel.cancel();
    let err = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(err.0, Status::UNAUTHORIZED, "revocation during scheduleCarrierRead must abort with 401");
    release.notify_waiters();
    *h.native.stall_carrier_read.lock().unwrap() = None;

    // 7. Principal revocation during the final under-fence `session_record_at` (#3) aborts immediately with 401.
    let (entered, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *h.native.stall_session_get_nth.lock().unwrap() = Some((3, 0, entered.clone(), release.clone()));
    let cancel = CancellationToken::new();
    let req = h.req(
        Method::PATCH,
        "/api/session/ses_inb_owned/inbox/inb_1",
        Some("application/json"),
        Some(br#"{"delivery":"steer"}"#.to_vec()),
        None,
        cancel.clone(),
    );
    let app = h.app.clone();
    let mut task = tokio::spawn(async move { proxy::relay(State(app), req).await });
    tokio::select! {
        res = &mut task => panic!("relay exited before under-fence session.get stall: {res:?}"),
        waited = tokio::time::timeout(Duration::from_secs(15), entered.notified()) => {
            waited.expect("timed out waiting for under-fence session.get stall");
        }
    }
    cancel.cancel();
    let err = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(err.0, Status::UNAUTHORIZED, "revocation during under-fence session.get must abort with 401");
    release.notify_waiters();
    *h.native.stall_session_get_nth.lock().unwrap() = None;

    // 7b. Principal revocation while reading an incomplete PATCH body aborts immediately with 401.
    let (body_started, body_waiting) = tokio::sync::oneshot::channel::<()>();
    let stalled_body = Body::from_stream(async_stream::stream! {
        let _ = body_started.send(());
        std::future::pending::<()>().await;
        yield Ok::<axum::body::Bytes, std::io::Error>(axum::body::Bytes::new());
    });
    let cancel = CancellationToken::new();
    let mut body_req = Request::builder()
        .method(Method::PATCH)
        .uri(format!("/workspaces/{}/instance/api/session/ses_inb_owned/inbox/inb_1", h.ws_id))
        .header(header::CONTENT_TYPE, "application/json")
        .body(stalled_body)
        .unwrap();
    body_req.extensions_mut().insert(Principal(cancel.clone()));
    let app = h.app.clone();
    let mut task = tokio::spawn(async move { proxy::relay(State(app), body_req).await });
    tokio::select! {
        res = &mut task => panic!("relay exited before stalled PATCH body read: {res:?}"),
        waited = tokio::time::timeout(Duration::from_secs(15), body_waiting) => {
            waited.expect("timed out waiting for stalled PATCH body read").unwrap();
        }
    }
    cancel.cancel();
    let err = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(err.0, Status::UNAUTHORIZED, "revocation during incomplete PATCH body read must abort with 401");

    // 7c. Principal revocation during early oversized Content-Length drain aborts immediately with 401 (not 413).
    let (over_started, over_waiting) = tokio::sync::oneshot::channel::<()>();
    let stalled_oversized = Body::from_stream(async_stream::stream! {
        let _ = over_started.send(());
        std::future::pending::<()>().await;
        yield Ok::<axum::body::Bytes, std::io::Error>(axum::body::Bytes::new());
    });
    let cancel = CancellationToken::new();
    let mut over_req = Request::builder()
        .method(Method::PATCH)
        .uri(format!("/workspaces/{}/instance/api/session/ses_inb_owned/inbox/inb_1", h.ws_id))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, "2097152")
        .body(stalled_oversized)
        .unwrap();
    over_req.extensions_mut().insert(Principal(cancel.clone()));
    let app = h.app.clone();
    let mut task = tokio::spawn(async move { proxy::relay(State(app), over_req).await });
    tokio::select! {
        res = &mut task => panic!("relay exited before oversized PATCH body drain: {res:?}"),
        waited = tokio::time::timeout(Duration::from_secs(15), over_waiting) => {
            waited.expect("timed out waiting for oversized PATCH body drain").unwrap();
        }
    }
    cancel.cancel();
    let err = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(err.0, Status::UNAUTHORIZED, "revocation during oversized body drain must abort with 401");

    // 8. Replacing the session checkout at the same path before under-fence recheck fails closed with 403.
    let (entered, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *h.native.stall_carrier_read.lock().unwrap() = Some((entered.clone(), release.clone()));
    let req = h.req(
        Method::PATCH,
        "/api/session/ses_inb_linked/inbox/inb_1",
        Some("application/json"),
        Some(br#"{"delivery":"steer"}"#.to_vec()),
        None,
        CancellationToken::new(),
    );
    let app = h.app.clone();
    let mut task = tokio::spawn(async move { proxy::relay(State(app), req).await });
    tokio::select! {
        res = &mut task => panic!("relay exited before checkout-replacement carrier stall: {res:?}"),
        waited = tokio::time::timeout(Duration::from_secs(15), entered.notified()) => {
            waited.expect("timed out waiting for checkout-replacement carrier stall");
        }
    }
    let linked_backup = h.dir.join("linked_replaced_backup");
    std::fs::rename(&h.linked, &linked_backup).unwrap();
    std::fs::create_dir(&h.linked).unwrap();
    release.notify_waiters();
    let err = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    let _ = std::fs::remove_dir(&h.linked);
    std::fs::rename(&linked_backup, &h.linked).unwrap();
    *h.native.stall_carrier_read.lock().unwrap() = None;
    assert_eq!(err.0, Status::FORBIDDEN, "replaced checkout at same path must be rejected under fence");

    assert!(h.recorded().is_empty(), "none of the rejected or pre-dispatch revoked calls may reach native inbox");

    let (entered, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *h.native.stall_inbox_get.lock().unwrap() = Some((entered.clone(), release.clone()));
    let cancel = CancellationToken::new();
    let req = h.req(Method::GET, "/api/session/ses_inb_owned/inbox", None, None, None, cancel.clone());
    let app = h.app.clone();
    let mut task = tokio::spawn(async move { proxy::relay(State(app), req).await });
    tokio::select! {
        res = &mut task => panic!("relay exited before GET /inbox stall: {res:?}"),
        waited = tokio::time::timeout(Duration::from_secs(15), entered.notified()) => {
            waited.expect("timed out waiting for GET /inbox stall");
        }
    }
    cancel.cancel();
    let err = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(err.0, Status::UNAUTHORIZED, "revocation while awaiting GET /inbox headers must abort with 401");
    release.notify_waiters();
    *h.native.stall_inbox_get.lock().unwrap() = None;

    // 9. Closing workspace while awaiting PATCH /inbox headers returns 404 immediately while holding fences until native finishes.
    let (entered, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *h.native.stall_inbox_write.lock().unwrap() = Some((entered.clone(), release.clone()));
    let req = h.req(
        Method::PATCH,
        "/api/session/ses_inb_owned/inbox/inb_1",
        Some("application/json"),
        Some(br#"{"delivery":"steer"}"#.to_vec()),
        None,
        CancellationToken::new(),
    );
    let app = h.app.clone();
    let mut task = tokio::spawn(async move { proxy::relay(State(app), req).await });
    tokio::select! {
        res = &mut task => panic!("relay exited before PATCH /inbox stall: {res:?}"),
        waited = tokio::time::timeout(Duration::from_secs(15), entered.notified()) => {
            waited.expect("timed out waiting for PATCH /inbox stall");
        }
    }
    h.app.inner.lock().unwrap().workspaces.retain(|w| w.id != h.ws_id);
    h.app.workspace_closed.notify_waiters();
    let err = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    assert_eq!(err.0, Status::NOT_FOUND, "workspace close while awaiting mutation headers must return 404");
    let ses_keys = [fence::session("ses_inb_owned")];
    let ses_lock = fence::block(&ses_keys);
    tokio::pin!(ses_lock);
    assert!(futures_util::poll!(&mut ses_lock).is_pending(), "mutation fence must remain held until native drains");
    release.notify_waiters();
    assert!(tokio::time::timeout(Duration::from_secs(10), ses_lock).await.unwrap().is_ok());
    *h.native.stall_inbox_write.lock().unwrap() = None;
}

#[tokio::test]
async fn remote_control_admits_inbox_for_browser_ingress_and_server_device_and_rejects_post() {
    let _git = crate::git::test_git_serial().await;
    let direct = Harness::new("inbox-remote").await;
    let ingress_h = Harness::new_with_ingress("inbox-remote-ingress", true).await;
    let origin = "https://10.0.0.5:9898";
    let host = "10.0.0.5:9898";

    for (ingress, is_server) in [(false, false), (false, true), (true, false), (true, true)] {
        let h = if ingress { &ingress_h } else { &direct };
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

        let payload = if ingress {
            axum::body::Bytes::new()
        } else {
            axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#))
        };
        let issued = devices::issue(State(h.app.clone()), payload).await;
        assert_eq!(issued.status(), Status::OK);
        let link: Value =
            serde_json::from_slice(&axum::body::to_bytes(issued.into_body(), 4096).await.unwrap()).unwrap();
        let code = link["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();

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

        let send = |method: Method, path: String, body: Option<Value>| {
            let mut req = client
                .request(method, format!("{base}{path}"))
                .header(header::HOST, host)
                .header(header::COOKIE, &cookie);
            if is_server {
                req = req.header("x-codenomad-server-request", "1");
            } else {
                req = req.header(header::ORIGIN, origin);
            }
            if let Some(b) = body {
                req = req.json(&b);
            }
            req.send()
        };

        let prefix = format!("/workspaces/{}/instance/api/session/ses_inb_owned/inbox", h.ws_id);
        assert_eq!(send(Method::GET, prefix.clone(), None).await.unwrap().status(), Status::OK);
        assert_eq!(
            send(Method::PATCH, format!("{prefix}/inb_1"), Some(json!({"delivery": "steer"}))).await.unwrap().status(),
            Status::NO_CONTENT
        );
        assert_eq!(send(Method::DELETE, format!("{prefix}/inb_1"), None).await.unwrap().status(), Status::NO_CONTENT);
        assert_eq!(send(Method::POST, prefix, Some(json!({}))).await.unwrap().status(), Status::FORBIDDEN);
        server.abort();
    }
}
