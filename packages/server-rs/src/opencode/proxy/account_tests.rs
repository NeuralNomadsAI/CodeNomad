use super::relay;
use crate::{App, Workspace, auth::Principal, opencode::Native};
use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
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

struct MockCall {
    method: String,
    path: String,
    query: Option<String>,
    dir_header: Option<String>,
    body: Option<Value>,
}

enum UpstreamErrorMode {
    None,
    NonJsonServerError,
    JsonEchoSecret,
}

struct MockUpstream {
    root: PathBuf,
    linked: PathBuf,
    calls: Vec<MockCall>,
    order: Vec<String>,
    entries: Vec<Value>,
    fail_activate: bool,
    connect_error: UpstreamErrorMode,
    events: Vec<String>,
}

async fn git_run(path: &Path, args: &[&str]) {
    let output = crate::git::command(path, args).output().await.unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

async fn fake_opencode(State(state): State<Arc<Mutex<MockUpstream>>>, req: Request) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let query = req.uri().query().map(str::to_owned);
    let dir_header = req.headers().get("x-opencode-directory").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024).await.unwrap_or_default();
    let body: Option<Value> = if bytes.is_empty() { None } else { serde_json::from_slice(&bytes).ok() };
    let mut s = state.lock().unwrap();
    if path.starts_with("/api/credential") || path.starts_with("/api/integration") {
        s.calls.push(MockCall {
            method: method.to_string(),
            path: path.clone(),
            query: query.clone(),
            dir_header,
            body: body.clone(),
        });
    }
    match (method, path.as_str()) {
        (Method::GET, "/api/location") => Json(json!({
            "directory": s.root,
            "project": {"id": "prj_acct_proxy", "directory": s.root, "canonical": s.root}
        }))
        .into_response(),
        (Method::GET, "/api/worktree") => Json(json!([{"directory": s.root}, {"directory": s.linked}])).into_response(),
        (Method::POST, "/api/worktree/refresh") => Status::NO_CONTENT.into_response(),
        (Method::POST, "/api/rpc/codenomad.missions/scheduleCarrierRead") => {
            Json(json!({"output": {"owned": false}})).into_response()
        }
        (Method::GET, "/api/session/ses_owned") => Json(json!({
            "data": {
                "id": "ses_owned",
                "projectID": "prj_acct_proxy",
                "location": {"directory": s.root},
                "model": {"providerID": "openai", "id": "gpt-5"},
                "time": {"created": 1}
            }
        }))
        .into_response(),
        (Method::PUT, "/api/session/ses_owned/environment") => {
            s.events.push("environment".into());
            Status::NO_CONTENT.into_response()
        }
        (Method::POST, "/api/session/ses_owned/prompt") => {
            s.events.push("prompt".into());
            Json(json!({"ok": true})).into_response()
        }
        (Method::POST, "/api/session/ses_owned/command") => {
            s.events.push("command".into());
            Json(json!({"ok": true})).into_response()
        }
        (Method::GET, "/api/provider/openai") => Json(json!({
            "location": {"directory": s.root},
            "data": {"id": "openai", "integrationID": "openai", "name": "OpenAI"}
        }))
        .into_response(),
        (Method::GET, "/api/integration/openai") => {
            let connections: Vec<Value> = s
                .order
                .iter()
                .filter_map(|id| {
                    let entry = s.entries.iter().find(|e| e["id"] == *id)?;
                    Some(json!({"type": "credential", "id": id, "label": entry["label"], "method": "oauth"}))
                })
                .collect();
            Json(json!({
                "location": {"directory": s.root},
                "data": {"id": "openai", "name": "OpenAI", "methods": [], "connections": connections}
            }))
            .into_response()
        }
        (Method::GET, "/api/credential") => Json(json!({"data": s.entries})).into_response(),
        (Method::POST, p) if p.starts_with("/api/credential/") && p.ends_with("/activate") => {
            if query.as_deref().is_some_and(|q| q.contains("directory"))
                || s.calls.last().and_then(|c| c.dir_header.as_ref()).is_some()
                || body.is_some()
            {
                return (Status::BAD_REQUEST, Json(json!({"error": "unexpected location on global credential"})))
                    .into_response();
            }
            s.events.push("activate".into());
            if s.fail_activate {
                return (Status::INTERNAL_SERVER_ERROR, Json(json!({"error": "secret-upstream-token"})))
                    .into_response();
            }
            let id = p.trim_start_matches("/api/credential/").trim_end_matches("/activate").to_owned();
            s.order.retain(|x| x != &id);
            s.order.insert(0, id.clone());
            for entry in &mut s.entries {
                entry["active"] = json!(entry["id"] == id);
            }
            Status::NO_CONTENT.into_response()
        }
        (Method::PATCH, p) if p.starts_with("/api/credential/") => {
            if query.as_deref().is_some_and(|q| q.contains("directory"))
                || s.calls.last().and_then(|c| c.dir_header.as_ref()).is_some()
                || body.as_ref().and_then(Value::as_object).is_some_and(|m| m.contains_key("location"))
            {
                return (Status::BAD_REQUEST, Json(json!({"error": "unexpected location on global credential"})))
                    .into_response();
            }
            Status::NO_CONTENT.into_response()
        }
        (Method::DELETE, p) if p.starts_with("/api/credential/") => {
            if query.as_deref().is_some_and(|q| q.contains("directory"))
                || s.calls.last().and_then(|c| c.dir_header.as_ref()).is_some()
                || body.is_some()
            {
                return (Status::BAD_REQUEST, Json(json!({"error": "unexpected location on global credential"})))
                    .into_response();
            }
            Status::NO_CONTENT.into_response()
        }
        (Method::POST, p) if p.starts_with("/api/integration/") && p.contains("/connect/") => {
            match s.connect_error {
                UpstreamErrorMode::NonJsonServerError => {
                    return (
                        Status::INTERNAL_SERVER_ERROR,
                        [(header::CONTENT_TYPE, "text/plain")],
                        "raw upstream stack trace with sk-raw-leak-777",
                    )
                        .into_response();
                }
                UpstreamErrorMode::JsonEchoSecret => {
                    let echoed = body
                        .as_ref()
                        .and_then(|b| b.get("key").or_else(|| b.get("code")))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    return (
                        Status::BAD_REQUEST,
                        Json(json!({
                            "code": "INVALID_CREDENTIAL",
                            "message": format!("Rejected secret {echoed}"),
                            "request": {"body": body},
                            "stack": "internal trace",
                        })),
                    )
                        .into_response();
                }
                UpstreamErrorMode::None => {}
            }
            let parsed_query: Vec<(String, String)> = query
                .as_deref()
                .and_then(|q| reqwest::Url::parse(&format!("http://localhost/?{q}")).ok())
                .map(|u| u.query_pairs().into_owned().collect())
                .unwrap_or_default();
            let has_raw_dir = parsed_query.iter().any(|(k, _)| k == "directory");
            let loc_dirs: Vec<&str> =
                parsed_query.iter().filter(|(k, _)| k == "location[directory]").map(|(_, v)| v.as_str()).collect();
            let has_body_loc = body.as_ref().and_then(Value::as_object).is_some_and(|m| m.contains_key("location"));
            let has_header_dir = s.calls.last().and_then(|c| c.dir_header.as_ref()).is_some();
            if has_raw_dir || has_body_loc || loc_dirs.len() > 1 || (loc_dirs.is_empty() && !has_header_dir) {
                return (Status::BAD_REQUEST, Json(json!({"error": "invalid native location carrier"})))
                    .into_response();
            }
            if p.ends_with("/connect/oauth") || p.ends_with("/connect/command") {
                Json(json!({"data": {"attemptID": "att_1", "mode": "code", "url": "https://example.test/auth"}}))
                    .into_response()
            } else {
                Status::NO_CONTENT.into_response()
            }
        }
        (Method::GET, p) if p.starts_with("/api/integration/") && p.contains("/connect/") => {
            let parsed_query: Vec<(String, String)> = query
                .as_deref()
                .and_then(|q| reqwest::Url::parse(&format!("http://localhost/?{q}")).ok())
                .map(|u| u.query_pairs().into_owned().collect())
                .unwrap_or_default();
            let has_raw_dir = parsed_query.iter().any(|(k, _)| k == "directory");
            let loc_dirs: Vec<&str> =
                parsed_query.iter().filter(|(k, _)| k == "location[directory]").map(|(_, v)| v.as_str()).collect();
            let has_header_dir = s.calls.last().and_then(|c| c.dir_header.as_ref()).is_some();
            if has_raw_dir || loc_dirs.len() > 1 || (loc_dirs.is_empty() && !has_header_dir) {
                return (Status::BAD_REQUEST, Json(json!({"error": "invalid native location carrier"})))
                    .into_response();
            }
            Json(json!({"data": {"attemptID": "att_1", "status": "pending"}})).into_response()
        }
        (Method::DELETE, p) if p.starts_with("/api/integration/") && p.contains("/connect/") => {
            let parsed_query: Vec<(String, String)> = query
                .as_deref()
                .and_then(|q| reqwest::Url::parse(&format!("http://localhost/?{q}")).ok())
                .map(|u| u.query_pairs().into_owned().collect())
                .unwrap_or_default();
            let has_raw_dir = parsed_query.iter().any(|(k, _)| k == "directory");
            let loc_dirs: Vec<&str> =
                parsed_query.iter().filter(|(k, _)| k == "location[directory]").map(|(_, v)| v.as_str()).collect();
            let has_header_dir = s.calls.last().and_then(|c| c.dir_header.as_ref()).is_some();
            if has_raw_dir || body.is_some() || loc_dirs.len() > 1 || (loc_dirs.is_empty() && !has_header_dir) {
                return (Status::BAD_REQUEST, Json(json!({"error": "invalid native location carrier"})))
                    .into_response();
            }
            Status::NO_CONTENT.into_response()
        }
        _ => Status::NOT_FOUND.into_response(),
    }
}

async fn fake_codex_quota(req: Request) -> Response {
    let account = req.headers().get("chatgpt-account-id").and_then(|v| v.to_str().ok()).unwrap_or("");
    let used = if account == "acct-one" { 100.0 } else { 15.0 };
    let reset = ((crate::shared::now_ms() + 3_600_000) / 1000) as f64;
    Json(json!({
        "rate_limit": {
            "allowed": used < 100.0,
            "limit_reached": used >= 100.0,
            "primary_window": {"used_percent": used, "limit_window_seconds": 18000, "reset_at": reset}
        }
    }))
    .into_response()
}

async fn setup_proxy_fixture() -> (TempDir, Arc<App>, String, PathBuf, PathBuf, Arc<Mutex<MockUpstream>>) {
    let dir = TempDir(crate::shared::test_dir("proxy-accounts"));
    let root = dir.0.join("project");
    let linked = dir.0.join("linked");
    std::fs::create_dir(&root).unwrap();
    git_run(&root, &["init", "--quiet"]).await;
    git_run(
        &root,
        &["-c", "user.name=Fix", "-c", "user.email=fix@invalid", "commit", "--quiet", "--allow-empty", "-m", "init"],
    )
    .await;
    git_run(&root, &["worktree", "add", "--quiet", "--detach", linked.to_str().unwrap()]).await;
    let root = dunce::canonicalize(&root).unwrap();
    let linked = dunce::canonicalize(&linked).unwrap();

    let mk_entry = |id: &str, active: bool| {
        json!({
            "id": id,
            "integrationID": "openai",
            "label": "default",
            "active": active,
            "value": {
                "type": "oauth",
                "methodID": "chatgpt-browser",
                "access": format!("secret-{id}"),
                "refresh": "secret-refresh",
                "expires": crate::shared::now_ms() + 3_600_000,
                "metadata": {"accountID": format!("acct-{id}"), "email": format!("{id}@example.com")}
            }
        })
    };
    let mock = Arc::new(Mutex::new(MockUpstream {
        root: root.clone(),
        linked: linked.clone(),
        calls: Vec::new(),
        order: vec!["one".into(), "two".into()],
        entries: vec![mk_entry("one", true), mk_entry("two", false)],
        fail_activate: false,
        connect_error: UpstreamErrorMode::None,
        events: Vec::new(),
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = Router::new().fallback(any(fake_opencode)).with_state(Arc::clone(&mock));
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    let quota_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let quota_addr = quota_listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(quota_listener, Router::new().fallback(any(fake_codex_quota))).await;
    });

    let auth = crate::auth::Auth::new(crate::auth::Settings {
        username: "codenomad".into(),
        password: None,
        file: None,
        cookie: crate::auth::DEFAULT_COOKIE.into(),
        token: false,
        managed_local: false,
        skip: true,
        idle: Duration::from_secs(60),
        absolute: Duration::from_secs(60),
    })
    .unwrap();
    let (tx, _rx) = tokio::sync::mpsc::channel(4);
    let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
        dir.0.join("config.yaml").to_str().unwrap(),
    ));
    let native = Native::test_connection(addr);
    let mut app = App::new(
        auth,
        0,
        dir.0.clone(),
        root.clone(),
        true,
        settings,
        Value::Null,
        native,
        PathBuf::new(),
        None,
        crate::files::watch::Watches::new(tx),
        None,
    );
    app.provider_usage = Arc::new(crate::provider_usage::State::with_test_accounts(
        reqwest::Url::parse(&format!("http://{quota_addr}/")).unwrap(),
        Duration::ZERO,
    ));
    let ws_id = Uuid::new_v4();
    app.inner.lock().unwrap().workspaces.push(Workspace {
        id: ws_id,
        request_id: None,
        path: root.clone(),
        name: Some("project".into()),
        status: "ready",
        proxy_path: format!("/workspaces/{ws_id}/instance"),
        binary_id: PathBuf::new(),
        binary_label: "opencode".into(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: "2026-01-01T00:00:00.000Z".into(),
        location: json!({"directory": root}),
        temporary: None,
    });
    (dir, Arc::new(app), ws_id.to_string(), root, linked, mock)
}

async fn call_relay(
    app: &Arc<App>,
    method: Method,
    uri: &str,
    content_type: Option<&str>,
    body: Option<&str>,
    extra_headers: &[(&str, &str)],
) -> (Status, String, String) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(ct) = content_type {
        builder = builder.header(header::CONTENT_TYPE, ct);
    }
    for (k, v) in extra_headers {
        builder = builder.header(*k, *v);
    }
    let mut req = builder.body(Body::from(body.unwrap_or("").to_owned())).unwrap();
    req.extensions_mut().insert(Principal(CancellationToken::new()));
    let resp = match relay(State(Arc::clone(app)), req).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    };
    let status = resp.status();
    let cc = resp.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    (status, cc, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn integration_connect_and_credential_mutations_relay_with_strict_validation_and_no_store() {
    let (_dir, app, ws, root, linked, mock) = setup_proxy_fixture().await;
    let base = format!("/workspaces/{ws}/instance/api");
    let linked_str = linked.to_string_lossy().into_owned();
    let root_str = root.to_string_lossy().into_owned();

    // 1. Happy paths for all integration connect & credential route families with exact native statuses.
    for (method, path, body, expected_status) in [
        (
            Method::POST,
            format!("{base}/integration/openai/connect/key"),
            Some(json!({"key": "sk-secret-value", "label": "Work"}).to_string()),
            Status::NO_CONTENT,
        ),
        (
            Method::POST,
            format!("{base}/integration/openai/connect/oauth"),
            Some(json!({"methodID": "chatgpt-browser", "answer": {"org": "a"}}).to_string()),
            Status::OK,
        ),
        (
            Method::POST,
            format!("{base}/integration/openai/connect/command"),
            Some(json!({"methodID": "cli-login"}).to_string()),
            Status::OK,
        ),
        (
            Method::POST,
            format!("{base}/integration/azure/connect/external"),
            Some(json!({"methodID": "azure-cli", "location": {"directory": linked_str}}).to_string()),
            Status::NO_CONTENT,
        ),
        (
            Method::POST,
            format!("{base}/integration/openai/connect/oauth/att_1/complete"),
            Some(json!({"code": "123456"}).to_string()),
            Status::NO_CONTENT,
        ),
        (Method::DELETE, format!("{base}/integration/openai/connect/oauth/att_1"), None, Status::NO_CONTENT),
        (Method::DELETE, format!("{base}/integration/openai/connect/command/att_1"), None, Status::NO_CONTENT),
        (Method::POST, format!("{base}/credential/cre_1/activate"), None, Status::NO_CONTENT),
        (
            Method::PATCH,
            format!("{base}/credential/cre_1"),
            Some(json!({"label": "Renamed"}).to_string()),
            Status::NO_CONTENT,
        ),
        (Method::DELETE, format!("{base}/credential/cre_1"), None, Status::NO_CONTENT),
    ] {
        let ct = body.as_ref().map(|_| "application/json");
        let (status, cc, _) = call_relay(&app, method.clone(), &path, ct, body.as_deref(), &[]).await;
        assert_eq!(status, expected_status, "{method} {path} -> {status}");
        assert_eq!(cc, "no-store", "{method} {path} must return no-store");
    }

    // Verify credential routes never inject default location[directory], while integration routes do unless body supplied it.
    {
        let calls = &mock.lock().unwrap().calls;
        let activate = calls.iter().find(|c| c.method == "POST" && c.path == "/api/credential/cre_1/activate").unwrap();
        assert!(activate.query.is_none(), "credential activate must not inject default location[directory]");
        assert!(activate.body.is_none(), "empty activate body must stay empty");
        let patch = calls.iter().find(|c| c.method == "PATCH" && c.path == "/api/credential/cre_1").unwrap();
        assert!(patch.query.is_none());
        assert_eq!(patch.body, Some(json!({"label": "Renamed"})));
        let connect_key =
            calls.iter().find(|c| c.method == "POST" && c.path == "/api/integration/openai/connect/key").unwrap();
        assert!(connect_key.query.as_deref().is_some_and(|q| q.contains("location%5Bdirectory%5D=")));
        let connect_ext =
            calls.iter().find(|c| c.method == "POST" && c.path == "/api/integration/azure/connect/external").unwrap();
        let parsed =
            reqwest::Url::parse(&format!("http://localhost/?{}", connect_ext.query.as_deref().unwrap_or(""))).unwrap();
        let loc_dir = parsed.query_pairs().find(|(k, _)| k == "location[directory]").map(|(_, v)| v.into_owned());
        assert_eq!(
            loc_dir.as_deref(),
            Some(linked_str.as_str()),
            "body.location must translate to location[directory]"
        );
        assert_eq!(connect_ext.body, Some(json!({"methodID": "azure-cli"})), "body.location must be stripped");
    }

    // x-codenomad-location alone injects x-opencode-directory and suppresses default query location.
    let linked_ctx = percent_encoding::utf8_percent_encode(
        &json!({"directory": linked_str}).to_string(),
        percent_encoding::NON_ALPHANUMERIC,
    )
    .to_string();
    let (status, cc, _) = call_relay(
        &app,
        Method::POST,
        &format!("{base}/integration/openai/connect/key"),
        Some("application/json"),
        Some(&json!({"key": "sk-ctx"}).to_string()),
        &[("x-codenomad-location", &linked_ctx)],
    )
    .await;
    assert_eq!(status, Status::NO_CONTENT);
    assert_eq!(cc, "no-store");
    {
        let calls = &mock.lock().unwrap().calls;
        let last = calls.last().unwrap();
        assert!(last.query.is_none(), "x-codenomad-location suppresses default query injection");
        let decoded_header = last
            .dir_header
            .as_deref()
            .and_then(|v| percent_encoding::percent_decode_str(v).decode_utf8().ok())
            .map(|s| s.into_owned());
        assert_eq!(decoded_header.as_deref(), Some(linked_str.as_str()));
    }

    // DELETE with body-only location forwards translated location[directory] query upstream.
    let (status, cc, _) = call_relay(
        &app,
        Method::DELETE,
        &format!("{base}/integration/openai/connect/oauth/att_2"),
        Some("application/json"),
        Some(&json!({"location": {"directory": linked_str}}).to_string()),
        &[],
    )
    .await;
    assert_eq!(status, Status::NO_CONTENT);
    assert_eq!(cc, "no-store");
    {
        let calls = &mock.lock().unwrap().calls;
        let last = calls.last().unwrap();
        assert_eq!(last.path, "/api/integration/openai/connect/oauth/att_2");
        assert!(last.body.is_none());
        let parsed =
            reqwest::Url::parse(&format!("http://localhost/?{}", last.query.as_deref().unwrap_or(""))).unwrap();
        let loc_dir = parsed.query_pairs().find(|(k, _)| k == "location[directory]").map(|(_, v)| v.into_owned());
        assert_eq!(loc_dir.as_deref(), Some(linked_str.as_str()));
    }

    // POST integration connect with `location: null` strips `location` and uses default location[directory].
    let (status, cc, _) = call_relay(
        &app,
        Method::POST,
        &format!("{base}/integration/azure/connect/external"),
        Some("application/json"),
        Some(&json!({"methodID": "azure-cli", "location": null}).to_string()),
        &[],
    )
    .await;
    assert_eq!(status, Status::NO_CONTENT);
    assert_eq!(cc, "no-store");
    {
        let calls = &mock.lock().unwrap().calls;
        let last = calls.last().unwrap();
        assert_eq!(last.body, Some(json!({"methodID": "azure-cli"})));
    }

    // Credential mutations consume query, header, and body location for authority/fence only,
    // never forwarding location in query, x-opencode-directory, or JSON body (and keeping activate empty).
    let (status, cc, _) = call_relay(
        &app,
        Method::POST,
        &format!(
            "{base}/credential/cre_1/activate?location[directory]={}",
            percent_encoding::utf8_percent_encode(&linked_str, percent_encoding::NON_ALPHANUMERIC)
        ),
        Some("application/json"),
        Some(&json!({"location": {"directory": linked_str}}).to_string()),
        &[("x-codenomad-location", &linked_ctx)],
    )
    .await;
    assert_eq!(status, Status::NO_CONTENT);
    assert_eq!(cc, "no-store");
    {
        let calls = &mock.lock().unwrap().calls;
        let last = calls.last().unwrap();
        assert_eq!(last.path, "/api/credential/cre_1/activate");
        assert!(last.query.is_none(), "credential activate must not forward query location");
        assert!(last.dir_header.is_none(), "credential activate must not forward x-opencode-directory");
        assert!(last.body.is_none(), "credential activate must drop body.location and forward empty body");
    }
    let (status, cc, _) = call_relay(
        &app,
        Method::PATCH,
        &format!("{base}/credential/cre_1"),
        Some("application/json"),
        Some(&json!({"label": "WithLoc", "location": {"directory": linked_str}}).to_string()),
        &[("x-codenomad-location", &linked_ctx)],
    )
    .await;
    assert_eq!(status, Status::NO_CONTENT);
    assert_eq!(cc, "no-store");
    {
        let calls = &mock.lock().unwrap().calls;
        let last = calls.last().unwrap();
        assert_eq!(last.path, "/api/credential/cre_1");
        assert!(last.query.is_none());
        assert!(last.dir_header.is_none());
        assert_eq!(last.body, Some(json!({"label": "WithLoc"})));
    }
    let (status, cc, _) = call_relay(
        &app,
        Method::DELETE,
        &format!("{base}/credential/cre_1"),
        Some("application/json"),
        Some(&json!({"location": {"directory": linked_str}}).to_string()),
        &[],
    )
    .await;
    assert_eq!(status, Status::NO_CONTENT);
    assert_eq!(cc, "no-store");
    {
        let calls = &mock.lock().unwrap().calls;
        let last = calls.last().unwrap();
        assert_eq!(last.path, "/api/credential/cre_1");
        assert!(last.query.is_none());
        assert!(last.dir_header.is_none());
        assert!(last.body.is_none());
    }

    // GET integration connect status polling validates and forwards canonical location[directory].
    let (status, cc, _) =
        call_relay(&app, Method::GET, &format!("{base}/integration/openai/connect/oauth/att_1"), None, None, &[]).await;
    assert_eq!(status, Status::OK);
    assert_eq!(cc, "no-store");

    // Equivalent canonical query selectors (directory + location[directory] pointing to same path)
    // and standalone ?directory= are normalized to a single native location[directory] query param.
    let root_encoded = percent_encoding::utf8_percent_encode(&root_str, percent_encoding::NON_ALPHANUMERIC).to_string();
    for query in
        [format!("directory={root_encoded}&location[directory]={root_encoded}"), format!("directory={root_encoded}")]
    {
        let (status, cc, _) = call_relay(
            &app,
            Method::POST,
            &format!("{base}/integration/openai/connect/key?{query}"),
            Some("application/json"),
            Some(&json!({"key": "sk-eq"}).to_string()),
            &[],
        )
        .await;
        assert_eq!(status, Status::NO_CONTENT);
        assert_eq!(cc, "no-store");
        let calls = &mock.lock().unwrap().calls;
        let last = calls.last().unwrap();
        let parsed =
            reqwest::Url::parse(&format!("http://localhost/?{}", last.query.as_deref().unwrap_or(""))).unwrap();
        let pairs: Vec<(String, String)> = parsed.query_pairs().into_owned().collect();
        assert_eq!(pairs, vec![("location[directory]".into(), root_str.clone())]);
    }

    let before_refusals = mock.lock().unwrap().calls.len();

    // 2. Refusals: foreign query/body locations, conflicting query/header/body locations, invalid bodies, disallowed routes, traversal.
    let linked_encoded =
        percent_encoding::utf8_percent_encode(&linked_str, percent_encoding::NON_ALPHANUMERIC).to_string();
    // Query vs body location conflict -> 400
    let (status, cc, _) = call_relay(
        &app,
        Method::POST,
        &format!("{base}/integration/azure/connect/external?location[directory]={root_encoded}"),
        Some("application/json"),
        Some(&json!({"methodID": "azure-cli", "location": {"directory": linked_str}}).to_string()),
        &[],
    )
    .await;
    assert_eq!(status, Status::BAD_REQUEST);
    assert_eq!(cc, "no-store");
    // directory vs location[directory] conflicting query selectors -> 400
    let (status, cc, _) = call_relay(
        &app,
        Method::POST,
        &format!("{base}/integration/openai/connect/key?directory={root_encoded}&location[directory]={linked_encoded}"),
        Some("application/json"),
        Some(&json!({"key": "sk-1"}).to_string()),
        &[],
    )
    .await;
    assert_eq!(status, Status::BAD_REQUEST);
    assert_eq!(cc, "no-store");
    let (status, cc, _) = call_relay(
        &app,
        Method::POST,
        &format!("{base}/credential/cre_1/activate?location[directory]=/foreign-nowhere"),
        None,
        None,
        &[],
    )
    .await;
    assert_eq!(status, Status::FORBIDDEN);
    assert_eq!(cc, "no-store");

    let (status, cc, _) = call_relay(
        &app,
        Method::POST,
        &format!("{base}/integration/openai/connect/key"),
        Some("application/json"),
        Some(&json!({"key": "sk-1", "location": {"directory": "/foreign-nowhere"}}).to_string()),
        &[],
    )
    .await;
    assert_eq!(status, Status::FORBIDDEN);
    assert_eq!(cc, "no-store");

    let ctx_header = percent_encoding::utf8_percent_encode(
        &json!({"directory": root_str}).to_string(),
        percent_encoding::NON_ALPHANUMERIC,
    )
    .to_string();
    let (status, cc, _) = call_relay(
        &app,
        Method::POST,
        &format!("{base}/integration/openai/connect/external"),
        Some("application/json"),
        Some(&json!({"methodID": "azure-cli", "location": {"directory": linked_str}}).to_string()),
        &[("x-codenomad-location", &ctx_header)],
    )
    .await;
    assert_eq!(status, Status::BAD_REQUEST);
    assert_eq!(cc, "no-store");

    // Malformed JSON carrying a secret sentinel must return 400 without echoing the sentinel.
    let (status, cc, body_text) = call_relay(
        &app,
        Method::POST,
        &format!("{base}/integration/openai/connect/key"),
        Some("application/json"),
        Some("{\"key\":\"super-secret-sentinel-999\""),
        &[],
    )
    .await;
    assert_eq!(status, Status::BAD_REQUEST);
    assert_eq!(cc, "no-store");
    assert!(!body_text.contains("super-secret-sentinel-999"));

    // Unknown body field, empty label, missing required key, wrong content-type.
    for (method, path, ct, body) in [
        (
            Method::POST,
            format!("{base}/integration/openai/connect/key"),
            Some("application/json"),
            Some("{\"key\":\"sk-1\",\"extra\":true}"),
        ),
        (Method::PATCH, format!("{base}/credential/cre_1"), Some("application/json"), Some("{\"label\":\"   \"}")),
        (Method::POST, format!("{base}/integration/openai/connect/key"), None, None),
        (
            Method::POST,
            format!("{base}/integration/openai/connect/key"),
            Some("text/plain"),
            Some("{\"key\":\"sk-1\"}"),
        ),
        (
            Method::POST,
            format!("{base}/integration/openai/connect/oauth/att_1/complete"),
            Some("application/json"),
            Some("{\"code\":\"\"}"),
        ),
    ] {
        let (status, cc, _) = call_relay(&app, method, &path, ct, body, &[]).await;
        assert_eq!(status, Status::BAD_REQUEST, "{path}");
        assert_eq!(cc, "no-store");
    }

    // Disallowed credential export / creation routes stay 403 with no-store.
    for (method, path) in [
        (Method::GET, format!("{base}/credential")),
        (Method::POST, format!("{base}/credential")),
        (Method::POST, format!("{base}/credential/cre_1/export")),
        (Method::POST, format!("{base}/integration/azure/connect/external/export")),
    ] {
        let (status, cc, _) = call_relay(&app, method.clone(), &path, None, None, &[]).await;
        assert_eq!(status, Status::FORBIDDEN, "{method} {path}");
        assert_eq!(cc, "no-store");
    }

    // Traversal and overlong segments rejected with 400.
    let overlong = "a".repeat(300);
    for path in [format!("{base}/credential/%2e%2e/activate"), format!("{base}/credential/{overlong}/activate")] {
        let (status, cc, _) = call_relay(&app, Method::POST, &path, None, None, &[]).await;
        assert_eq!(status, Status::BAD_REQUEST, "{path}");
        assert_eq!(cc, "no-store");
    }

    assert_eq!(mock.lock().unwrap().calls.len(), before_refusals, "no refusal may reach OpenCode");

    // 3. Upstream non-2xx responses (non-JSON and JSON echoing secrets) are redacted with no-store.
    mock.lock().unwrap().connect_error = UpstreamErrorMode::NonJsonServerError;
    let (status, cc, body_text) = call_relay(
        &app,
        Method::POST,
        &format!("{base}/integration/openai/connect/key"),
        Some("application/json"),
        Some(&json!({"key": "sk-nonjson-secret"}).to_string()),
        &[],
    )
    .await;
    assert_eq!(status, Status::INTERNAL_SERVER_ERROR);
    assert_eq!(cc, "no-store");
    assert!(body_text.contains("OpenCodeContractError"));
    assert!(!body_text.contains("sk-raw-leak-777"));
    assert!(!body_text.contains("sk-nonjson-secret"));

    mock.lock().unwrap().connect_error = UpstreamErrorMode::JsonEchoSecret;
    let (status, cc, body_text) = call_relay(
        &app,
        Method::POST,
        &format!("{base}/integration/openai/connect/key"),
        Some("application/json"),
        Some(&json!({"key": "sk-json-echo-secret-42"}).to_string()),
        &[],
    )
    .await;
    assert_eq!(status, Status::BAD_REQUEST);
    assert_eq!(cc, "no-store");
    assert!(body_text.contains("OpenCodeContractError"));
    assert!(!body_text.contains("INVALID_CREDENTIAL"));
    assert!(!body_text.contains("sk-json-echo-secret-42"));
    assert!(!body_text.contains("internal trace"));
    mock.lock().unwrap().connect_error = UpstreamErrorMode::None;
}

#[tokio::test]
async fn prompt_and_command_admission_rotates_exhausted_account_and_blocks_on_ambiguous_failure() {
    let (_dir, app, ws, _root, _linked, mock) = setup_proxy_fixture().await;
    crate::settings::patch_owner(
        &app,
        crate::settings::Kind::Config,
        "providerAccounts",
        json!({"autoSelect": {"openai": true}}),
    )
    .map_err(|e| e.message())
    .unwrap();

    // Prompt rotates from exhausted "one" to available "two" before forwarding.
    let (status, _, _) = call_relay(
        &app,
        Method::POST,
        &format!("/workspaces/{ws}/instance/api/session/ses_owned/prompt"),
        Some("application/json"),
        Some(&json!({"text": "hello"}).to_string()),
        &[],
    )
    .await;
    assert_eq!(status, Status::OK);
    {
        let s = mock.lock().unwrap();
        assert_eq!(s.order[0], "two");
        assert_eq!(s.events, vec!["environment", "activate", "prompt"]);
    }

    // Reset to exhausted "one" and simulate ambiguous activation failure on /command: blocks with 502.
    {
        let mut s = mock.lock().unwrap();
        s.order = vec!["one".into(), "two".into()];
        for e in &mut s.entries {
            e["active"] = json!(e["id"] == "one");
        }
        s.fail_activate = true;
        s.events.clear();
    }
    let (status, _, body) = call_relay(
        &app,
        Method::POST,
        &format!("/workspaces/{ws}/instance/api/session/ses_owned/command"),
        Some("application/json"),
        Some(&json!({"name": "review"}).to_string()),
        &[],
    )
    .await;
    assert_eq!(status, Status::BAD_GATEWAY);
    assert!(body.contains("PROVIDER_ACCOUNT_SELECTION_FAILED"));
    assert!(!body.contains("secret-upstream-token"));
    assert_eq!(mock.lock().unwrap().events, vec!["environment", "activate"]);
}
