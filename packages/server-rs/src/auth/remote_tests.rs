use super::*;
use crate::{App, Workspace, auth, files, memory, opencode, settings};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{Method, StatusCode as Status, header},
    middleware::{Next, from_fn, from_fn_with_state},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct NativeState {
    root: PathBuf,
    foreign: PathBuf,
    calls: Mutex<Vec<String>>,
    global_form_scopes: Mutex<Vec<(String, Option<String>, Option<String>)>>,
}

async fn fake_native(State(state): State<Arc<NativeState>>, req: Request) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let query_dir = req.uri().query().and_then(|q| {
        reqwest::Url::parse(&format!("http://localhost/?{q}"))
            .ok()?
            .query_pairs()
            .find(|(k, _)| k == "location[directory]")
            .map(|(_, v)| v.into_owned())
    });
    let header_dir = req.headers().get("x-opencode-directory").and_then(|v| v.to_str().ok()).map(str::to_owned);
    state.calls.lock().unwrap().push(format!("{method} {path}"));
    match (method, path.as_str()) {
        (Method::GET, "/api/config") => Json(json!([{"type": "directory", "path": state.root}])).into_response(),
        (Method::GET, "/api/location") => Json(json!({
            "directory": state.root,
            "project": {"id": "prj_remote_test", "directory": state.root, "canonical": state.root}
        }))
        .into_response(),
        (Method::GET, "/api/worktree") => Json(json!([{"directory": state.root}])).into_response(),
        (Method::POST, "/api/worktree/refresh") => Status::NO_CONTENT.into_response(),
        (Method::POST, "/api/rpc/codenomad.missions/scheduleCarrierRead") => {
            Json(json!({"output": {"owned": false}})).into_response()
        }
        (Method::GET, "/api/session/ses_owned") => Json(json!({
            "data": {
                "id": "ses_owned",
                "projectID": "prj_remote_test",
                "location": {"directory": state.root},
                "time": {"created": 1}
            }
        }))
        .into_response(),
        (Method::GET, "/api/session/ses_foreign") => Json(json!({
            "data": {
                "id": "ses_foreign",
                "projectID": "prj_foreign",
                "location": {"directory": state.foreign},
                "time": {"created": 1}
            }
        }))
        .into_response(),
        (Method::GET, "/api/session/ses_owned/permission/per_1") => Json(json!({
            "data": {
                "id": "per_1",
                "sessionID": "ses_owned",
                "tool": "bash",
                "action": "bash",
                "resources": ["echo hi"]
            }
        }))
        .into_response(),
        (Method::POST, "/api/session/ses_owned/permission/per_1/reply") => Status::NO_CONTENT.into_response(),
        (Method::GET, "/api/session/ses_owned/form/frm_1") => Json(json!({
            "data": {
                "id": "frm_1",
                "sessionID": "ses_owned",
                "title": "Confirm",
                "fields": [],
                "state": {"status": "pending"}
            }
        }))
        .into_response(),
        (Method::POST, "/api/session/ses_owned/form/frm_1/reply") => Status::NO_CONTENT.into_response(),
        (Method::DELETE, "/api/session/ses_owned/form/frm_1") => Status::NO_CONTENT.into_response(),
        (Method::POST, "/api/session/global/form/frm_g1/reply") => {
            state.global_form_scopes.lock().unwrap().push(("reply".into(), query_dir, header_dir));
            Status::NO_CONTENT.into_response()
        }
        (Method::DELETE, "/api/session/global/form/frm_g1") => {
            state.global_form_scopes.lock().unwrap().push(("cancel".into(), query_dir, header_dir));
            Status::NO_CONTENT.into_response()
        }
        (Method::POST, "/api/session/ses_owned/revert/stage") => Json(json!({"staged": true})).into_response(),
        (Method::DELETE, "/api/session/ses_owned/revert") => Status::NO_CONTENT.into_response(),
        (Method::GET, "/api/session/ses_owned/inbox") => {
            Json(json!([{"id": "inb_1", "delivery": "queue"}])).into_response()
        }
        (Method::PATCH, "/api/session/ses_owned/inbox/inb_1") => {
            let body = axum::body::to_bytes(req.into_body(), 4096).await.ok();
            let parsed: Option<Value> = body.and_then(|b| serde_json::from_slice(&b).ok());
            if parsed == Some(json!({"delivery": "steer"})) {
                Status::NO_CONTENT.into_response()
            } else {
                Status::BAD_REQUEST.into_response()
            }
        }
        (Method::DELETE, "/api/session/ses_owned/inbox/inb_1") => Status::NO_CONTENT.into_response(),
        (Method::POST, "/api/session/ses_owned/fork") => Json(json!({
            "data": {
                "id": "ses_forked",
                "projectID": "prj_remote_test",
                "fork": {"sessionID": "ses_owned"},
                "location": {"directory": state.root},
                "time": {"created": 2}
            }
        }))
        .into_response(),
        (Method::DELETE, "/api/session/ses_owned") => Status::NO_CONTENT.into_response(),
        (Method::GET, "/api/integration/openai") => Json(json!({
            "location": {"directory": state.root},
            "data": {
                "id": "openai",
                "name": "OpenAI",
                "methods": [],
                "connections": [
                    {"type": "credential", "id": "cre_1", "label": "default", "method": "oauth"},
                    {"type": "credential", "id": "cre_2", "label": "Work", "method": "oauth"}
                ]
            }
        }))
        .into_response(),
        (Method::GET, "/api/credential") => {
            let exp = crate::shared::now_ms() + 3_600_000;
            Json(json!({
                "data": [
                    {
                        "id": "cre_1",
                        "integrationID": "openai",
                        "label": "default",
                        "active": true,
                        "value": {
                            "type": "oauth",
                            "methodID": "chatgpt-browser",
                            "access": "secret-remote-1",
                            "expires": exp,
                            "metadata": {"accountID": "acct-1", "email": "one@example.com"}
                        }
                    },
                    {
                        "id": "cre_2",
                        "integrationID": "openai",
                        "label": "Work",
                        "active": false,
                        "value": {
                            "type": "oauth",
                            "methodID": "chatgpt-browser",
                            "access": "secret-remote-2",
                            "expires": exp,
                            "metadata": {"accountID": "acct-2", "email": "two@example.com"}
                        }
                    }
                ]
            }))
            .into_response()
        }
        (Method::POST, "/api/credential/cre_1/activate") => Status::NO_CONTENT.into_response(),
        (Method::PATCH, "/api/credential/cre_1") => Status::NO_CONTENT.into_response(),
        (Method::DELETE, "/api/credential/cre_1") => Status::NO_CONTENT.into_response(),
        (Method::POST, p) if p.starts_with("/api/integration/") && p.contains("/connect/") => {
            Json(json!({"data": {"attemptID": "att_remote", "mode": "code", "url": "https://example.test/oauth"}}))
                .into_response()
        }
        (Method::DELETE, p) if p.starts_with("/api/integration/") && p.contains("/connect/") => {
            Status::NO_CONTENT.into_response()
        }
        _ => Status::NOT_IMPLEMENTED.into_response(),
    }
}

fn per_request_channel(
    origin: String,
    origins: Arc<[String]>,
    ingress: bool,
) -> impl Fn(Request, Next) -> std::pin::Pin<Box<dyn std::future::Future<Output = Response> + Send>> + Clone {
    move |mut req: Request, next: Next| {
        let channel = tls::Channel {
            origin: origin.clone(),
            origins: origins.clone(),
            ingress,
            socket: CancellationToken::new(),
            principal: Arc::new(Mutex::new(None)),
        };
        req.extensions_mut().insert(channel);
        Box::pin(next.run(req))
    }
}

fn build_app(
    dir: &std::path::Path,
    native: opencode::Native,
    devices: crate::shared::panic_guard::Lock<devices::Devices>,
) -> Shared {
    let auth = auth::Auth::new(auth::Settings {
        username: "codenomad".into(),
        password: None,
        file: None,
        cookie: auth::DEFAULT_COOKIE.into(),
        token: false,
        managed_local: false,
        skip: true,
        idle: Duration::from_secs(60),
        absolute: Duration::from_secs(60),
    })
    .unwrap();
    let (tx, _rx) = tokio::sync::mpsc::channel(4);
    let root = dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let settings =
        settings::Settings::new(settings::document::Location::resolve(root.join("config.yaml").to_str().unwrap()));
    Arc::new(App::new(
        auth,
        0,
        root.clone(),
        root,
        false,
        settings,
        Value::Null,
        native,
        PathBuf::new(),
        Some(devices),
        files::watch::Watches::new(tx),
        None,
    ))
}

async fn pair_browser(
    client: &reqwest::Client,
    app: &Shared,
    base: &str,
    host: &str,
    origin: &str,
    ingress: bool,
) -> String {
    let payload =
        if ingress { axum::body::Bytes::new() } else { axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#)) };
    let issued = devices::issue(State(app.clone()), payload).await;
    assert_eq!(issued.status(), Status::OK);
    let body = axum::body::to_bytes(issued.into_body(), 4096).await.unwrap();
    let link: Value = serde_json::from_slice(&body).unwrap();
    let code = link["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();
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

async fn pair_server_device(
    client: &reqwest::Client,
    app: &Shared,
    base: &str,
    host: &str,
    origin: &str,
    ingress: bool,
) -> String {
    let payload =
        if ingress { axum::body::Bytes::new() } else { axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#)) };
    let issued = devices::issue(State(app.clone()), payload).await;
    assert_eq!(issued.status(), Status::OK);
    let body = axum::body::to_bytes(issued.into_body(), 4096).await.unwrap();
    let link: Value = serde_json::from_slice(&body).unwrap();
    let code = link["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();
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
    let payload: Value = paired.json().await.unwrap();
    let cred = payload["credential"].as_str().unwrap();
    format!("{}={cred}", devices::COOKIE)
}

#[tokio::test]
async fn paired_browser_and_server_device_admit_session_controls_and_reject_out_of_scope() {
    let dir = TempDir(crate::shared::test_dir("remote-b1-session-controls"));
    let root = dir.0.join("project");
    let foreign = dir.0.join("other");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&foreign).unwrap();
    let root = dunce::canonicalize(&root).unwrap();
    let foreign = dunce::canonicalize(&foreign).unwrap();
    let foreign_encoded =
        percent_encoding::utf8_percent_encode(foreign.to_str().unwrap(), percent_encoding::NON_ALPHANUMERIC)
            .to_string();

    let native_state = Arc::new(NativeState {
        root: root.clone(),
        foreign,
        calls: Mutex::new(Vec::new()),
        global_form_scopes: Mutex::new(Vec::new()),
    });
    let native_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let native_addr = native_listener.local_addr().unwrap();
    let native_for_task = Arc::clone(&native_state);
    let native_task = tokio::spawn(async move {
        axum::serve(native_listener, Router::new().fallback(any(fake_native)).with_state(native_for_task))
            .await
            .unwrap();
    });

    let host = "192.168.1.40:9898";
    let origin = format!("https://{host}");
    let origins = vec![origin.clone()];
    let devices = devices::open_for_test(&dir.0, origin.clone(), origins.clone());
    let app = build_app(&dir.0, opencode::Native::test_connection(native_addr), devices);
    let ws_id = Uuid::new_v4();
    let ws = Workspace {
        id: ws_id,
        request_id: None,
        path: root.clone(),
        name: None,
        status: "ready",
        proxy_path: format!("/workspaces/{ws_id}/instance"),
        binary_id: PathBuf::new(),
        binary_label: String::new(),
        created_at: String::new(),
        updated_at: String::new(),
        location: json!({"directory": root}),
        temporary: None,
    };
    app.inner.lock().unwrap().workspaces.push(ws.clone());

    let router = auth::remote_routes()
        .route("/workspaces/{id}/instance/{*route}", any(opencode::proxy::relay))
        .layer(from_fn_with_state((app.clone(), None), admit))
        .layer(from_fn(per_request_channel(origin.clone(), Arc::from(origins), false)))
        .with_state(app.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server_task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let browser_cookie = pair_browser(&client, &app, &base, host, &origin, false).await;
    let server_cookie = pair_server_device(&client, &app, &base, host, &origin, false).await;

    let prefix = format!("{base}/workspaces/{ws_id}/instance/api/session/ses_owned");
    for (label, is_server, cookie) in [("browser", false, &browser_cookie), ("server-device", true, &server_cookie)] {
        let send = |method: Method, url: String, body: Option<Value>| {
            let mut req = client.request(method, url).header(header::HOST, host).header(header::COOKIE, cookie);
            if is_server {
                req = req.header("x-codenomad-server-request", "1");
            } else {
                req = req.header(header::ORIGIN, &origin);
            }
            if let Some(body) = body {
                req = req.json(&body);
            }
            req.send()
        };

        // Permission reply (B1 headline scenario)
        let perm = send(Method::POST, format!("{prefix}/permission/per_1/reply"), Some(json!({"decision": "once"})))
            .await
            .unwrap();
        assert_eq!(perm.status(), Status::NO_CONTENT, "{label} permission reply");

        // Question reply and reject (form cancel)
        let form_reply =
            send(Method::POST, format!("{prefix}/form/frm_1/reply"), Some(json!({"answer": {"q0": "yes"}})))
                .await
                .unwrap();
        assert_eq!(form_reply.status(), Status::NO_CONTENT, "{label} form reply");
        let form_cancel = send(Method::DELETE, format!("{prefix}/form/frm_1"), None).await.unwrap();
        assert_eq!(form_cancel.status(), Status::NO_CONTENT, "{label} form cancel");

        // Undo / redo (revert/stage + DELETE /revert)
        let undo = send(
            Method::POST,
            format!("{prefix}/revert/stage"),
            Some(json!({"messageID": "msg_1", "partID": "prt_1"})),
        )
        .await
        .unwrap();
        assert_eq!(undo.status(), Status::OK, "{label} revert/stage");
        let undo_bad_field =
            send(Method::POST, format!("{prefix}/revert/stage"), Some(json!({"messageID": "msg_1", "extra": 1})))
                .await
                .unwrap();
        assert_eq!(undo_bad_field.status(), Status::NOT_IMPLEMENTED, "{label} revert/stage rejects extra field");
        let redo = send(Method::DELETE, format!("{prefix}/revert"), None).await.unwrap();
        assert_eq!(redo.status(), Status::NO_CONTENT, "{label} delete revert");

        // Inbox list, delivery toggle (PATCH) and cancel (DELETE)
        let inbox_list = send(Method::GET, format!("{prefix}/inbox"), None).await.unwrap();
        assert_eq!(inbox_list.status(), Status::OK, "{label} inbox list");
        let inbox_steer =
            send(Method::PATCH, format!("{prefix}/inbox/inb_1"), Some(json!({"delivery": "steer"}))).await.unwrap();
        assert_eq!(inbox_steer.status(), Status::NO_CONTENT, "{label} inbox patch steer");
        let inbox_bad_delivery =
            send(Method::PATCH, format!("{prefix}/inbox/inb_1"), Some(json!({"delivery": "bogus"}))).await.unwrap();
        assert_eq!(inbox_bad_delivery.status(), Status::BAD_REQUEST, "{label} inbox patch invalid delivery");
        let inbox_extra_field =
            send(Method::PATCH, format!("{prefix}/inbox/inb_1"), Some(json!({"delivery": "queue", "extra": 1})))
                .await
                .unwrap();
        assert_eq!(inbox_extra_field.status(), Status::NOT_IMPLEMENTED, "{label} inbox patch extra field");
        let inbox_cancel = send(Method::DELETE, format!("{prefix}/inbox/inb_1"), None).await.unwrap();
        assert_eq!(inbox_cancel.status(), Status::NO_CONTENT, "{label} inbox cancel");
        let inbox_cancel_meta =
            send(Method::DELETE, format!("{prefix}/inbox/inb_1"), Some(json!({"metadata": {"schedule": true}})))
                .await
                .unwrap();
        assert_eq!(inbox_cancel_meta.status(), Status::FORBIDDEN, "{label} inbox cancel reserved metadata");

        // Fork and session delete
        let forked = send(Method::POST, format!("{prefix}/fork"), Some(json!({}))).await.unwrap();
        assert_eq!(forked.status(), Status::OK, "{label} fork");
        let deleted = send(Method::DELETE, prefix.clone(), None).await.unwrap();
        assert_eq!(deleted.status(), Status::NO_CONTENT, "{label} session delete");

        // DELETE with reserved Missions metadata is refused (403)
        let del_carrier_meta =
            send(Method::DELETE, prefix.clone(), Some(json!({"metadata": {"schedule": true}}))).await.unwrap();
        assert_eq!(del_carrier_meta.status(), Status::FORBIDDEN, "{label} session delete reserved metadata");
        let redo_carrier_meta =
            send(Method::DELETE, format!("{prefix}/revert"), Some(json!({"metadata": {"schedule": true}})))
                .await
                .unwrap();
        assert_eq!(redo_carrier_meta.status(), Status::FORBIDDEN, "{label} revert delete reserved metadata");

        // Global form reply and cancel (unscoped adds location[directory]; explicit header forwards without duplicating query; foreign refused)
        native_state.global_form_scopes.lock().unwrap().clear();
        let global_prefix = format!("{base}/workspaces/{ws_id}/instance/api/session/global/form/frm_g1");
        let global_reply =
            send(Method::POST, format!("{global_prefix}/reply"), Some(json!({"answer": {"ok": true}}))).await.unwrap();
        assert_eq!(global_reply.status(), Status::NO_CONTENT, "{label} global form reply");
        let global_cancel = send(Method::DELETE, global_prefix.clone(), None).await.unwrap();
        assert_eq!(global_cancel.status(), Status::NO_CONTENT, "{label} global form cancel");
        let owned_encoded =
            percent_encoding::utf8_percent_encode(root.to_str().unwrap(), percent_encoding::NON_ALPHANUMERIC)
                .to_string();
        let mut global_scoped = client
            .post(format!("{global_prefix}/reply"))
            .header(header::HOST, host)
            .header(header::COOKIE, cookie)
            .header("x-opencode-directory", owned_encoded.as_str())
            .json(&json!({"answer": {"ok": true}}));
        if is_server {
            global_scoped = global_scoped.header("x-codenomad-server-request", "1");
        } else {
            global_scoped = global_scoped.header(header::ORIGIN, &origin);
        }
        assert_eq!(
            global_scoped.send().await.unwrap().status(),
            Status::NO_CONTENT,
            "{label} global form owned header"
        );
        let root_str = root.to_string_lossy().into_owned();
        assert_eq!(
            *native_state.global_form_scopes.lock().unwrap(),
            vec![
                ("reply".into(), Some(root_str.clone()), None),
                ("cancel".into(), Some(root_str), None),
                ("reply".into(), None, Some(owned_encoded)),
            ],
            "{label} global form upstream location scopes"
        );
        let mut global_foreign = client
            .post(format!("{global_prefix}/reply"))
            .header(header::HOST, host)
            .header(header::COOKIE, cookie)
            .header("x-opencode-directory", foreign_encoded.as_str())
            .json(&json!({"answer": {"ok": true}}));
        if is_server {
            global_foreign = global_foreign.header("x-codenomad-server-request", "1");
        } else {
            global_foreign = global_foreign.header(header::ORIGIN, &origin);
        }
        assert_eq!(global_foreign.send().await.unwrap().status(), Status::FORBIDDEN, "{label} global form foreign dir");

        // Out-of-scope refusals: foreign session (403), unallowlisted native route (403), host management (404)
        let foreign_prefix = format!("{base}/workspaces/{ws_id}/instance/api/session/ses_foreign");
        let foreign_perm =
            send(Method::POST, format!("{foreign_prefix}/permission/per_1/reply"), Some(json!({"decision": "once"})))
                .await
                .unwrap();
        assert_eq!(foreign_perm.status(), Status::FORBIDDEN, "{label} foreign permission reply");
        let foreign_redo = send(Method::DELETE, format!("{foreign_prefix}/revert"), None).await.unwrap();
        assert_eq!(foreign_redo.status(), Status::FORBIDDEN, "{label} foreign delete revert");
        let foreign_inbox_list = send(Method::GET, format!("{foreign_prefix}/inbox"), None).await.unwrap();
        assert_eq!(foreign_inbox_list.status(), Status::FORBIDDEN, "{label} foreign inbox list");
        let foreign_inbox_patch =
            send(Method::PATCH, format!("{foreign_prefix}/inbox/inb_1"), Some(json!({"delivery": "steer"})))
                .await
                .unwrap();
        assert_eq!(foreign_inbox_patch.status(), Status::FORBIDDEN, "{label} foreign inbox patch");
        let foreign_inbox_cancel = send(Method::DELETE, format!("{foreign_prefix}/inbox/inb_1"), None).await.unwrap();
        assert_eq!(foreign_inbox_cancel.status(), Status::FORBIDDEN, "{label} foreign inbox cancel");
        let unallowlisted =
            send(Method::POST, format!("{base}/workspaces/{ws_id}/instance/api/not-allowed"), Some(json!({})))
                .await
                .unwrap();
        assert_eq!(unallowlisted.status(), Status::FORBIDDEN, "{label} unallowlisted native route");
        let host_admin =
            send(Method::POST, format!("{base}/api/remote-control/pairings"), Some(json!({}))).await.unwrap();
        assert_eq!(host_admin.status(), Status::NOT_FOUND, "{label} host-only route");
    }

    // Unpaired client is refused with 401 on admitted session control routes.
    let unpaired = client
        .post(format!("{prefix}/permission/per_1/reply"))
        .header(header::HOST, host)
        .header(header::ORIGIN, &origin)
        .json(&json!({"decision": "once"}))
        .send()
        .await
        .unwrap();
    assert_eq!(unpaired.status(), Status::UNAUTHORIZED);

    server_task.abort();
    native_task.abort();
}

#[tokio::test]
async fn remote_memory_requires_multi_backend_for_browsers_and_preserves_local_and_direct_server_device() {
    let dir = TempDir(crate::shared::test_dir("remote-m2-memory-gate"));
    let direct_host = "192.168.1.41:9898";
    let direct_origin = format!("https://{direct_host}");
    let ingress_host = "remote.example.test";
    let ingress_origin = format!("https://{ingress_host}");

    let direct_devices = devices::open_for_test(&dir.0, direct_origin.clone(), vec![direct_origin.clone()]);
    let direct_app = build_app(&dir.0, opencode::Native::test_connection(([127, 0, 0, 1], 9).into()), direct_devices);
    let ingress_dir = TempDir(crate::shared::test_dir("remote-m2-memory-ingress"));
    let ingress_devices = devices::open_ingress_for_test(&ingress_dir.0, ingress_origin.clone());
    let ingress_app =
        build_app(&ingress_dir.0, opencode::Native::test_connection(([127, 0, 0, 1], 9).into()), ingress_devices);

    // Local router (no remote admit middleware): memory works even when multiBackend is disabled.
    let local_router = memory::routes()
        .layer(from_fn(|mut req: Request, next: Next| async move {
            req.extensions_mut().insert(Principal(CancellationToken::new()));
            next.run(req).await
        }))
        .with_state(direct_app.clone());
    let local_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local_base = format!("http://{}", local_listener.local_addr().unwrap());
    let local_task = tokio::spawn(async move { axum::serve(local_listener, local_router).await.unwrap() });

    // Direct HTTPS remote router.
    let direct_router = auth::remote_routes()
        .merge(memory::routes())
        .layer(from_fn_with_state((direct_app.clone(), None), admit))
        .layer(from_fn(per_request_channel(direct_origin.clone(), Arc::from(vec![direct_origin.clone()]), false)))
        .with_state(direct_app.clone());
    let direct_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let direct_base = format!("http://{}", direct_listener.local_addr().unwrap());
    let direct_task = tokio::spawn(async move { axum::serve(direct_listener, direct_router).await.unwrap() });

    // Ingress remote router.
    let ingress_router = auth::remote_routes()
        .merge(memory::routes())
        .layer(from_fn_with_state((ingress_app.clone(), None), admit))
        .layer(from_fn(per_request_channel(ingress_origin.clone(), Arc::from(vec![ingress_origin.clone()]), true)))
        .with_state(ingress_app.clone());
    let ingress_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ingress_base = format!("http://{}", ingress_listener.local_addr().unwrap());
    let ingress_task = tokio::spawn(async move { axum::serve(ingress_listener, ingress_router).await.unwrap() });

    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let direct_browser = pair_browser(&client, &direct_app, &direct_base, direct_host, &direct_origin, false).await;
    let direct_server =
        pair_server_device(&client, &direct_app, &direct_base, direct_host, &direct_origin, false).await;
    let ingress_browser = pair_browser(&client, &ingress_app, &ingress_base, ingress_host, &ingress_origin, true).await;
    let ingress_server =
        pair_server_device(&client, &ingress_app, &ingress_base, ingress_host, &ingress_origin, true).await;

    // 1. Local access works with multiBackend disabled.
    assert_eq!(client.get(format!("{local_base}/api/memory/settings")).send().await.unwrap().status(), Status::OK);
    assert_eq!(
        client
            .post(format!("{local_base}/api/memory"))
            .json(&json!({"operation": {"action": "list", "scope": "global"}}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::OK
    );

    // 2. With multiBackend disabled: paired browsers get 404 on BOTH direct HTTPS and ingress.
    for (label, base, host, origin, cookie) in [
        ("direct-browser-off", &direct_base, direct_host, &direct_origin, &direct_browser),
        ("ingress-browser-off", &ingress_base, ingress_host, &ingress_origin, &ingress_browser),
    ] {
        for (method, path, body) in [
            (Method::GET, "/api/memory/settings", None),
            (Method::PUT, "/api/memory/settings", Some(json!({"enabled": true}))),
            (Method::POST, "/api/memory", Some(json!({"operation": {"action": "list", "scope": "global"}}))),
            (Method::GET, "/api/memory/extra", None),
        ] {
            let mut req = client
                .request(method.clone(), format!("{base}{path}"))
                .header(header::HOST, host)
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie);
            if let Some(body) = body {
                req = req.json(&body);
            }
            assert_eq!(req.send().await.unwrap().status(), Status::NOT_FOUND, "{label} {method} {path}");
        }
    }

    // 2b. Refusal ordering parity (TS gate.ts):
    //     - Ingress browser POST /api/memory without Origin returns 403 even when multiBackend is off.
    //     - Ingress unauthenticated server-header POST /api/memory without Origin returns 403 (not 404).
    //     - Direct HTTPS unauthenticated server-device on an unlisted memory method returns 401 (paired gets 404).
    assert_eq!(
        client
            .post(format!("{ingress_base}/api/memory"))
            .header(header::HOST, ingress_host)
            .header(header::COOKIE, &ingress_browser)
            .json(&json!({"operation": {"action": "list", "scope": "global"}}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::FORBIDDEN
    );
    assert_eq!(
        client
            .post(format!("{ingress_base}/api/memory"))
            .header(header::HOST, ingress_host)
            .header("x-codenomad-server-request", "1")
            .json(&json!({"operation": {"action": "list", "scope": "global"}}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::FORBIDDEN
    );
    assert_eq!(
        client
            .delete(format!("{direct_base}/api/memory"))
            .header(header::HOST, direct_host)
            .header("x-codenomad-server-request", "1")
            .send()
            .await
            .unwrap()
            .status(),
        Status::UNAUTHORIZED
    );
    assert_eq!(
        client
            .delete(format!("{direct_base}/api/memory"))
            .header(header::HOST, direct_host)
            .header(header::COOKIE, &direct_server)
            .header("x-codenomad-server-request", "1")
            .send()
            .await
            .unwrap()
            .status(),
        Status::NOT_FOUND
    );

    // 3. Server-device on direct HTTPS retains authenticated memory transport; ingress stays 404.
    assert_eq!(
        client
            .get(format!("{direct_base}/api/memory/settings"))
            .header(header::HOST, direct_host)
            .header(header::COOKIE, &direct_server)
            .header("x-codenomad-server-request", "1")
            .send()
            .await
            .unwrap()
            .status(),
        Status::OK
    );
    assert_eq!(
        client
            .post(format!("{direct_base}/api/memory"))
            .header(header::HOST, direct_host)
            .header(header::COOKIE, &direct_server)
            .header("x-codenomad-server-request", "1")
            .json(&json!({"operation": {"action": "list", "scope": "global"}}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::OK
    );
    assert_eq!(
        client
            .get(format!("{ingress_base}/api/memory/settings"))
            .header(header::HOST, ingress_host)
            .header(header::COOKIE, &ingress_server)
            .header("x-codenomad-server-request", "1")
            .send()
            .await
            .unwrap()
            .status(),
        Status::NOT_FOUND
    );

    // 4. Enable multiBackend on both hosts: paired browsers are admitted on direct and ingress,
    //    unlisted methods/bogus server headers stay 404, and ingress server-device stays 404.
    for config_root in [&dir.0, &ingress_dir.0] {
        std::fs::write(config_root.join("config.yaml"), "ui:\n  settings:\n    multiBackend: true\n").unwrap();
    }
    for (label, base, host, origin, cookie) in [
        ("direct-browser-on", &direct_base, direct_host, &direct_origin, &direct_browser),
        ("ingress-browser-on", &ingress_base, ingress_host, &ingress_origin, &ingress_browser),
    ] {
        let get_settings = client
            .get(format!("{base}/api/memory/settings"))
            .header(header::HOST, host)
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(get_settings.status(), Status::OK, "{label} GET /api/memory/settings");
        let list_op = client
            .post(format!("{base}/api/memory"))
            .header(header::HOST, host)
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie)
            .json(&json!({"operation": {"action": "list", "scope": "global"}}))
            .send()
            .await
            .unwrap();
        assert_eq!(list_op.status(), Status::OK, "{label} POST /api/memory");
        let bad_method = client
            .delete(format!("{base}/api/memory"))
            .header(header::HOST, host)
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(bad_method.status(), Status::NOT_FOUND, "{label} DELETE /api/memory");
        let bogus_server_header = client
            .get(format!("{base}/api/memory/settings"))
            .header(header::HOST, host)
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie)
            .header("x-codenomad-server-request", "0")
            .send()
            .await
            .unwrap();
        assert_eq!(bogus_server_header.status(), Status::NOT_FOUND, "{label} bogus server header");
    }
    assert_eq!(
        client
            .post(format!("{ingress_base}/api/memory"))
            .header(header::HOST, ingress_host)
            .header(header::COOKIE, &ingress_server)
            .header("x-codenomad-server-request", "1")
            .json(&json!({"operation": {"action": "list", "scope": "global"}}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::NOT_FOUND
    );
    // Unpaired ingress GET /api/memory/settings stays 404 (not 401) even when multiBackend is on.
    assert_eq!(
        client
            .get(format!("{ingress_base}/api/memory/settings"))
            .header(header::HOST, ingress_host)
            .header(header::ORIGIN, &ingress_origin)
            .send()
            .await
            .unwrap()
            .status(),
        Status::NOT_FOUND
    );
    // Paired ingress browser sending valid Origin + x-codenomad-server-request: 1 loses backend UI
    // admission and gets 404 (not 403), matching TS gate.ts:175-198.
    assert_eq!(
        client
            .get(format!("{ingress_base}/api/memory/settings"))
            .header(header::HOST, ingress_host)
            .header(header::ORIGIN, &ingress_origin)
            .header(header::COOKIE, &ingress_browser)
            .header("x-codenomad-server-request", "1")
            .send()
            .await
            .unwrap()
            .status(),
        Status::NOT_FOUND
    );
    assert_eq!(
        client
            .post(format!("{ingress_base}/api/memory"))
            .header(header::HOST, ingress_host)
            .header(header::ORIGIN, &ingress_origin)
            .header(header::COOKIE, &ingress_browser)
            .header("x-codenomad-server-request", "1")
            .json(&json!({"operation": {"action": "list", "scope": "global"}}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::NOT_FOUND
    );
    // Paired ingress mutation with browser metadata (no Origin) + server header stays 403.
    assert_eq!(
        client
            .post(format!("{ingress_base}/api/memory"))
            .header(header::HOST, ingress_host)
            .header("sec-fetch-site", "same-origin")
            .header(header::COOKIE, &ingress_server)
            .header("x-codenomad-server-request", "1")
            .json(&json!({"operation": {"action": "list", "scope": "global"}}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::FORBIDDEN
    );

    local_task.abort();
    direct_task.abort();
    ingress_task.abort();
}

#[tokio::test]
async fn paired_browser_and_server_device_admit_provider_accounts_and_connect_routes() {
    let dir = TempDir(crate::shared::test_dir("remote-provider-accounts"));
    let root = dir.0.join("project");
    let foreign = dir.0.join("other");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&foreign).unwrap();
    let root = dunce::canonicalize(&root).unwrap();
    let foreign = dunce::canonicalize(&foreign).unwrap();
    let root_str = root.to_string_lossy().into_owned();
    let root_encoded = percent_encoding::utf8_percent_encode(&root_str, percent_encoding::NON_ALPHANUMERIC).to_string();

    let native_state = Arc::new(NativeState {
        root: root.clone(),
        foreign,
        calls: Mutex::new(Vec::new()),
        global_form_scopes: Mutex::new(Vec::new()),
    });
    let native_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let native_addr = native_listener.local_addr().unwrap();
    let native_task = tokio::spawn(async move {
        axum::serve(native_listener, Router::new().fallback(any(fake_native)).with_state(native_state)).await.unwrap();
    });

    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for ingress in [false, true] {
        let mode = if ingress { "ingress" } else { "direct" };
        let host = if ingress { "remote.example.test" } else { "192.168.1.44:9898" };
        let origin = format!("https://{host}");
        let origins = vec![origin.clone()];
        let mode_dir = dir.0.join(mode);
        std::fs::create_dir_all(&mode_dir).unwrap();
        let devices = if ingress {
            devices::open_ingress_for_test(&mode_dir, origin.clone())
        } else {
            devices::open_for_test(&mode_dir, origin.clone(), origins.clone())
        };
        let app = build_app(&dir.0, opencode::Native::test_connection(native_addr), devices);
        let ws_id = Uuid::new_v4();
        app.inner.lock().unwrap().workspaces.push(Workspace {
            id: ws_id,
            request_id: None,
            path: root.clone(),
            name: None,
            status: "ready",
            proxy_path: format!("/workspaces/{ws_id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            location: json!({"directory": root}),
            temporary: None,
        });
        let router = auth::remote_routes()
            .merge(crate::provider_usage::routes())
            .route("/workspaces/{id}/instance/{*route}", any(opencode::proxy::relay))
            .layer(from_fn_with_state((app.clone(), None), admit))
            .layer(from_fn(per_request_channel(origin.clone(), Arc::from(origins), ingress)))
            .with_state(app.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server_task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let browser_cookie = pair_browser(&client, &app, &base, host, &origin, ingress).await;
        let server_cookie = pair_server_device(&client, &app, &base, host, &origin, ingress).await;

        let accounts_url = format!("{base}/api/workspaces/{ws_id}/provider-accounts/openai");
        let instance = format!("{base}/workspaces/{ws_id}/instance/api");

        for (label, is_server, cookie) in [("browser", false, &browser_cookie), ("server-device", true, &server_cookie)]
        {
            let send = |method: Method, url: String, body: Option<Value>| {
                let mut req = client.request(method, url).header(header::HOST, host).header(header::COOKIE, cookie);
                if is_server {
                    req = req.header("x-codenomad-server-request", "1");
                } else {
                    req = req.header(header::ORIGIN, &origin);
                }
                if let Some(body) = body {
                    req = req.json(&body);
                }
                req.send()
            };

            // GET & PUT provider-accounts
            let get_res = send(Method::GET, format!("{accounts_url}?directory={root_encoded}"), None).await.unwrap();
            assert_eq!(get_res.status(), Status::OK, "{mode} {label} GET provider-accounts");
            assert_eq!(get_res.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));

            let put_res =
                send(Method::PUT, accounts_url.clone(), Some(json!({"directory": root_str, "enabled": true})))
                    .await
                    .unwrap();
            assert_eq!(put_res.status(), Status::OK, "{mode} {label} PUT provider-accounts");
            assert_eq!(put_res.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));
            let put_json: Value = put_res.json().await.unwrap();
            assert_eq!(put_json["enabled"], true);
            assert!(!put_json.to_string().contains("secret-remote"));

            // Integration connect & credential proxy mutations
            for (method, url, body) in [
                (Method::POST, format!("{instance}/integration/openai/connect/key"), Some(json!({"key": "sk-remote"}))),
                (
                    Method::POST,
                    format!("{instance}/integration/openai/connect/oauth"),
                    Some(json!({"methodID": "chatgpt-browser"})),
                ),
                (
                    Method::POST,
                    format!("{instance}/integration/openai/connect/command"),
                    Some(json!({"methodID": "cli"})),
                ),
                (
                    Method::POST,
                    format!("{instance}/integration/azure/connect/external"),
                    Some(json!({"methodID": "azure-cli"})),
                ),
                (
                    Method::POST,
                    format!("{instance}/integration/openai/connect/oauth/att_remote/complete"),
                    Some(json!({"code": "123"})),
                ),
                (Method::DELETE, format!("{instance}/integration/openai/connect/oauth/att_remote"), None),
                (Method::DELETE, format!("{instance}/integration/openai/connect/command/att_remote"), None),
                (Method::POST, format!("{instance}/credential/cre_1/activate"), None),
                (Method::PATCH, format!("{instance}/credential/cre_1"), Some(json!({"label": "Remote"}))),
                (Method::DELETE, format!("{instance}/credential/cre_1"), None),
            ] {
                let res = send(method.clone(), url.clone(), body).await.unwrap();
                assert!(res.status().is_success(), "{mode} {label} {method} {url} -> {}", res.status());
                assert_eq!(res.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));
            }

            // Disallowed native credential export stays 403 with no-store
            let export = send(Method::GET, format!("{instance}/credential"), None).await.unwrap();
            assert_eq!(export.status(), Status::FORBIDDEN, "{mode} {label} GET /api/credential");
            assert_eq!(export.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));
        }

        // Unpaired PUT provider-accounts is rejected with 401 and Cache-Control: no-store.
        let unpaired = client
            .put(&accounts_url)
            .header(header::HOST, host)
            .header(header::ORIGIN, &origin)
            .json(&json!({"directory": root_str, "enabled": true}))
            .send()
            .await
            .unwrap();
        assert_eq!(unpaired.status(), Status::UNAUTHORIZED, "{mode} unpaired PUT");
        assert_eq!(unpaired.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));

        // Cross-origin paired browser mutation is rejected with 403 and Cache-Control: no-store.
        let cross_origin = client
            .post(format!("{instance}/credential/cre_1/activate"))
            .header(header::HOST, host)
            .header(header::ORIGIN, "https://evil.example")
            .header(header::COOKIE, &browser_cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(cross_origin.status(), Status::FORBIDDEN, "{mode} cross-origin activate");
        assert_eq!(cross_origin.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));

        server_task.abort();
    }

    // Local auth middleware also returns Cache-Control: no-store on unauthenticated account refusals.
    let local_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local_addr = local_listener.local_addr().unwrap();
    let local_auth = auth::Auth::new(auth::Settings {
        username: "codenomad".into(),
        password: Some("secret-pass".into()),
        file: None,
        cookie: auth::DEFAULT_COOKIE.into(),
        token: false,
        managed_local: false,
        skip: false,
        idle: Duration::from_secs(60),
        absolute: Duration::from_secs(60),
    })
    .unwrap();
    let (tx, _rx) = tokio::sync::mpsc::channel(4);
    let local_app = Arc::new(App::new(
        local_auth,
        local_addr.port(),
        dir.0.clone(),
        dir.0.clone(),
        false,
        settings::Settings::new(settings::document::Location::resolve(dir.0.join("local.yaml").to_str().unwrap())),
        Value::Null,
        opencode::Native::test_connection(native_addr),
        PathBuf::new(),
        None,
        files::watch::Watches::new(tx),
        None,
    ));
    let local_ws = Uuid::new_v4();
    let local_router = crate::provider_usage::routes()
        .route("/workspaces/{id}/instance/{*route}", any(opencode::proxy::relay))
        .layer(from_fn_with_state(local_app.clone(), auth::admit))
        .with_state(local_app);
    let local_base = format!("http://{local_addr}");
    let local_task = tokio::spawn(async move { axum::serve(local_listener, local_router).await.unwrap() });
    for (method, url) in [
        (Method::PUT, format!("{local_base}/api/workspaces/{local_ws}/provider-accounts/openai")),
        (Method::POST, format!("{local_base}/workspaces/{local_ws}/instance/api/credential/cre_1/activate")),
    ] {
        let res = client.request(method.clone(), &url).send().await.unwrap();
        assert_eq!(res.status(), Status::UNAUTHORIZED, "local unauth {method} {url}");
        assert_eq!(res.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));
    }
    local_task.abort();
    native_task.abort();
}
