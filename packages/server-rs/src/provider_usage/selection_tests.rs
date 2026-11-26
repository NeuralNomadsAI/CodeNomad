use super::{
    State as UsageState,
    quota_marks::{QuotaFailure, parse_quota_failure, quota_mark_ttl},
    selection::{
        ReadState, adapter, adapter_for_provider, before_send, build_credential, definite_rejection,
        parse_codex_selection_quota, quota_state,
    },
    shared::{Fields, window},
};
use crate::{App, Workspace, auth::Principal, opencode::Native};
use axum::{
    Extension, Json, Router,
    extract::{Request, State},
    http::{Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
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

struct MockState {
    directory: String,
    provider: String,
    integration: String,
    order: Vec<String>,
    entries: Vec<Value>,
    needs_auth: HashSet<String>,
    fail_activation: bool,
    fail_native: bool,
    calls: Vec<String>,
    quota_calls: Vec<String>,
    quota_responses: HashMap<String, (u16, Value)>,
}

fn codex_entry(id: &str, active: bool, label: &str) -> Value {
    json!({
        "id": id,
        "integrationID": "openai",
        "label": label,
        "active": active,
        "value": {
            "type": "oauth",
            "methodID": "chatgpt-browser",
            "access": format!("secret-access-{id}"),
            "refresh": format!("secret-refresh-{id}"),
            "expires": crate::shared::now_ms() + 3_600_000,
            "metadata": {
                "accountID": format!("acct-{id}"),
                "email": format!("{id}@example.com"),
            }
        }
    })
}

fn go_key_entry(integration: &str, id: &str, active: bool) -> Value {
    json!({
        "id": id,
        "integrationID": integration,
        "label": id,
        "active": active,
        "value": {
            "type": "key",
            "key": format!("secret-{id}"),
        }
    })
}

fn codex_usage_payload(used: f64, reset_offset_ms: i64) -> Value {
    let reset_sec = ((crate::shared::now_ms() as i64 + reset_offset_ms) / 1000) as f64;
    json!({
        "rate_limit": {
            "allowed": used < 100.0,
            "limit_reached": used >= 100.0,
            "primary_window": {
                "used_percent": used,
                "limit_window_seconds": 18000,
                "reset_at": reset_sec
            }
        }
    })
}

fn go_usage_payload(used: f64) -> Value {
    json!({
        "usage": {
            "rolling": {
                "status": if used >= 100.0 { "rate-limited" } else { "ok" },
                "percent": used,
                "resetInSec": 3600
            }
        }
    })
}

async fn fake_native(State(state): State<Arc<Mutex<MockState>>>, req: Request) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let mut s = state.lock().unwrap();
    s.calls.push(format!("{method} {path}"));
    if s.fail_native && path != "/api/location" && path != "/api/worktree" {
        return (Status::INTERNAL_SERVER_ERROR, Json(json!({"error": "secret-upstream-detail"}))).into_response();
    }
    match (method, path.as_str()) {
        (Method::GET, "/api/location") => Json(json!({
            "directory": s.directory,
            "project": {"id": "prj_test", "directory": s.directory, "canonical": s.directory}
        }))
        .into_response(),
        (Method::GET, "/api/worktree") => Json(json!([{"directory": s.directory}])).into_response(),
        (Method::GET, p) if p.starts_with("/api/session/") => Json(json!({
            "data": {
                "id": p.trim_start_matches("/api/session/"),
                "projectID": "prj_test",
                "location": {"directory": s.directory},
                "model": {"providerID": s.provider, "id": "model-1"},
                "time": {"created": 1}
            }
        }))
        .into_response(),
        (Method::GET, p) if p.starts_with("/api/provider/") => {
            let pid = p.trim_start_matches("/api/provider/");
            Json(json!({
                "location": {"directory": s.directory},
                "data": {"id": pid, "integrationID": s.integration, "name": "Fixture"}
            }))
            .into_response()
        }
        (Method::GET, p) if p.starts_with("/api/integration/") => {
            let iid = p.trim_start_matches("/api/integration/");
            let connections: Vec<Value> = s
                .order
                .iter()
                .filter_map(|id| {
                    let entry = s.entries.iter().find(|e| e["id"] == *id && e["integrationID"] == iid)?;
                    let mut conn = json!({
                        "type": "credential",
                        "id": id,
                        "label": entry["label"],
                        "method": if entry["value"]["type"] == "key" { "key" } else { "oauth" },
                    });
                    if s.needs_auth.contains(id) {
                        conn["status"] = json!({"status": "needs_auth", "message": "private-auth-error"});
                    }
                    Some(conn)
                })
                .collect();
            Json(json!({
                "location": {"directory": s.directory},
                "data": {"id": iid, "name": "Fixture", "methods": [], "connections": connections}
            }))
            .into_response()
        }
        (Method::GET, "/api/credential") => Json(json!({"data": s.entries})).into_response(),
        (Method::POST, p) if p.starts_with("/api/credential/") && p.ends_with("/activate") => {
            if s.fail_activation {
                return (Status::INTERNAL_SERVER_ERROR, Json(json!({"error": "secret-provider-error"})))
                    .into_response();
            }
            let id = p.trim_start_matches("/api/credential/").trim_end_matches("/activate").to_owned();
            s.order.retain(|item| item != &id);
            s.order.insert(0, id.clone());
            for entry in &mut s.entries {
                entry["active"] = json!(entry["id"] == id);
            }
            Status::NO_CONTENT.into_response()
        }
        _ => Status::NOT_FOUND.into_response(),
    }
}

async fn fake_quota_upstream(State(state): State<Arc<Mutex<MockState>>>, req: Request) -> Response {
    let auth = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let account = req.headers().get("chatgpt-account-id").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let key = if !account.is_empty() { account } else { auth.strip_prefix("Bearer ").unwrap_or(&auth).to_owned() };
    let mut s = state.lock().unwrap();
    s.quota_calls.push(key.clone());
    match s.quota_responses.get(&key).cloned() {
        Some((status, body)) => (Status::from_u16(status).unwrap(), Json(body)).into_response(),
        None => (Status::SERVICE_UNAVAILABLE, Json(json!({"error": "unavailable"}))).into_response(),
    }
}

struct TestHarness {
    _dir: TempDir,
    app: Arc<App>,
    workspace_id: String,
    directory: String,
    state: Arc<Mutex<MockState>>,
    endpoint: Arc<crate::opencode::Endpoint>,
    principal: Principal,
}

async fn setup_harness(integration: &str, provider: &str, entries: Vec<Value>) -> TestHarness {
    let dir = TempDir(crate::shared::test_dir("provider-accounts-selection"));
    let project = dir.0.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let root = dunce::canonicalize(&project).unwrap();
    let directory = root.to_string_lossy().into_owned();
    let order = entries.iter().filter_map(|e| e["id"].as_str().map(str::to_owned)).collect();
    let state = Arc::new(Mutex::new(MockState {
        directory: directory.clone(),
        provider: provider.into(),
        integration: integration.into(),
        order,
        entries,
        needs_auth: HashSet::new(),
        fail_activation: false,
        fail_native: false,
        calls: Vec::new(),
        quota_calls: Vec::new(),
        quota_responses: HashMap::new(),
    }));
    let native_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let native_addr = native_listener.local_addr().unwrap();
    let native_router = Router::new().fallback(any(fake_native)).with_state(Arc::clone(&state));
    tokio::spawn(async move {
        let _ = axum::serve(native_listener, native_router).await;
    });

    let quota_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let quota_addr = quota_listener.local_addr().unwrap();
    let quota_router = Router::new().fallback(any(fake_quota_upstream)).with_state(Arc::clone(&state));
    tokio::spawn(async move {
        let _ = axum::serve(quota_listener, quota_router).await;
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
    let native = Native::test_connection(native_addr);
    let endpoint = native.endpoint().unwrap();
    let mut app = App::new(
        auth,
        0,
        dir.0.clone(),
        root.clone(),
        false,
        settings,
        Value::Null,
        native,
        PathBuf::new(),
        None,
        crate::files::watch::Watches::new(tx),
        None,
    );
    app.provider_usage = Arc::new(UsageState::with_test_accounts(
        reqwest::Url::parse(&format!("http://{quota_addr}/")).unwrap(),
        Duration::ZERO,
    ));
    let ws_id = Uuid::new_v4();
    app.inner.lock().unwrap().workspaces.push(Workspace {
        id: ws_id,
        request_id: None,
        path: root,
        name: Some("project".into()),
        status: "ready",
        proxy_path: format!("/workspaces/{ws_id}/instance"),
        binary_id: PathBuf::new(),
        binary_label: "opencode".into(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: "2026-01-01T00:00:00.000Z".into(),
        location: json!({"directory": directory}),
        temporary: None,
    });
    TestHarness {
        _dir: dir,
        app: Arc::new(app),
        workspace_id: ws_id.to_string(),
        directory,
        state,
        endpoint,
        principal: Principal(CancellationToken::new()),
    }
}

async fn send_route(
    app: Arc<App>,
    principal: Principal,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (Status, String, Value) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = super::routes().layer(Extension(principal)).with_state(app);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut req = client.request(method, format!("http://{addr}{uri}"));
    if let Some(payload) = body {
        req = req.header(header::CONTENT_TYPE, "application/json").body(payload.to_string());
    }
    let response = req.send().await.unwrap();
    let status = response.status();
    let cc = response.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let bytes = response.bytes().await.unwrap();
    task.abort();
    let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, cc, json)
}

#[tokio::test]
async fn provider_accounts_get_and_put_enforce_ownership_policy_fence_and_redaction() {
    let h = setup_harness(
        "openai",
        "openai",
        vec![codex_entry("one", true, "default"), codex_entry("two", false, "Team alias")],
    )
    .await;
    let base = format!("/api/workspaces/{}/provider-accounts", h.workspace_id);
    let encoded_dir = super::plans::encode(&h.directory);

    // 1. Foreign directory rejected with 403 and zero native reads.
    let (status, cc, _) = send_route(
        Arc::clone(&h.app),
        h.principal.clone(),
        Method::GET,
        &format!("{base}/openai?directory=%2Fforeign-nowhere"),
        None,
    )
    .await;
    assert_eq!(status, Status::FORBIDDEN);
    assert_eq!(cc, "no-store");
    assert!(h.state.lock().unwrap().calls.iter().all(|c| !c.contains("/api/credential")));

    // 2. GET returns redacted logins (default enriched, alias preserved, no secrets).
    let (status, cc, body) = send_route(
        Arc::clone(&h.app),
        h.principal.clone(),
        Method::GET,
        &format!("{base}/openai?directory={encoded_dir}"),
        None,
    )
    .await;
    assert_eq!(status, Status::OK);
    assert_eq!(cc, "no-store");
    assert_eq!(body, json!({"supported": true, "enabled": false, "logins": {"one": "one@example.com"}}));
    let raw = body.to_string();
    for forbidden in ["secret-", "acct-", "refresh", "expires"] {
        assert!(!raw.contains(forbidden), "leaked {forbidden}");
    }

    // 3. Invalid PUT body returns 400 with no-store.
    let (status, cc, _) = send_route(
        Arc::clone(&h.app),
        h.principal.clone(),
        Method::PUT,
        &format!("{base}/openai"),
        Some(json!({"directory": h.directory, "enabled": "yes"})),
    )
    .await;
    assert_eq!(status, Status::BAD_REQUEST);
    assert_eq!(cc, "no-store");

    // 4. PUT persists {providerAccounts.autoSelect.openai = true} in config.yaml.
    let (status, cc, body) = send_route(
        Arc::clone(&h.app),
        h.principal.clone(),
        Method::PUT,
        &format!("{base}/openai"),
        Some(json!({"directory": h.directory, "enabled": true})),
    )
    .await;
    assert_eq!(status, Status::OK);
    assert_eq!(cc, "no-store");
    assert_eq!(body["enabled"], true);
    let stored = h.app.settings.owner(crate::settings::Kind::Config, "providerAccounts");
    assert_eq!(stored["autoSelect"]["openai"], true);

    // 5. Unregistered integration refuses PUT (both true and false) with 409 without touching config.
    for enabled in [true, false] {
        let (status, cc, _) = send_route(
            Arc::clone(&h.app),
            h.principal.clone(),
            Method::PUT,
            &format!("{base}/deepinfra"),
            Some(json!({"directory": h.directory, "enabled": enabled})),
        )
        .await;
        assert_eq!(status, Status::CONFLICT);
        assert_eq!(cc, "no-store");
    }
    assert!(
        h.app.settings.owner(crate::settings::Kind::Config, "providerAccounts")["autoSelect"]
            .get("deepinfra")
            .is_none()
    );

    // 6. Single eligible account refuses enabled:true with 409, allows enabled:false with 200.
    h.state.lock().unwrap().entries.truncate(1);
    let (status, _, _) = send_route(
        Arc::clone(&h.app),
        h.principal.clone(),
        Method::PUT,
        &format!("{base}/openai"),
        Some(json!({"directory": h.directory, "enabled": true})),
    )
    .await;
    assert_eq!(status, Status::CONFLICT);
    let (status, _, body) = send_route(
        Arc::clone(&h.app),
        h.principal.clone(),
        Method::PUT,
        &format!("{base}/openai"),
        Some(json!({"directory": h.directory, "enabled": false})),
    )
    .await;
    assert_eq!(status, Status::OK);
    assert_eq!(body["enabled"], false);

    // 7. Worktree deletion fence returns 409 on PUT.
    let key = crate::worktrees::fence::identity(&dunce::canonicalize(&h.directory).unwrap());
    let delete_guard = crate::worktrees::fence::block(&[key]).await.unwrap();
    let (status, cc, _) = send_route(
        Arc::clone(&h.app),
        h.principal.clone(),
        Method::PUT,
        &format!("{base}/openai"),
        Some(json!({"directory": h.directory, "enabled": false})),
    )
    .await;
    assert_eq!(status, Status::CONFLICT);
    assert_eq!(cc, "no-store");
    drop(delete_guard);

    // 8. Native failure returns 503 with redacted error and does not mutate policy.
    h.state.lock().unwrap().fail_native = true;
    let (status, cc, body) = send_route(
        Arc::clone(&h.app),
        h.principal.clone(),
        Method::PUT,
        &format!("{base}/openai"),
        Some(json!({"directory": h.directory, "enabled": true})),
    )
    .await;
    assert_eq!(status, Status::SERVICE_UNAVAILABLE);
    assert_eq!(cc, "no-store");
    assert!(!body.to_string().contains("secret-upstream-detail"));
}

#[tokio::test]
async fn before_send_rotates_exhausted_codex_serializes_and_fences_manual_and_policy_changes() {
    let h = setup_harness(
        "openai",
        "openai",
        vec![
            codex_entry("one", true, "default"),
            codex_entry("two", false, "default"),
            codex_entry("three", false, "default"),
        ],
    )
    .await;
    {
        let mut s = h.state.lock().unwrap();
        s.quota_responses.insert("acct-one".into(), (200, codex_usage_payload(100.0, 3_600_000)));
        s.quota_responses.insert("acct-two".into(), (200, codex_usage_payload(20.0, 3_600_000)));
        s.quota_responses.insert("acct-three".into(), (200, codex_usage_payload(30.0, 3_600_000)));
    }

    // Disabled policy never reads credentials or activates.
    before_send(&h.app, &h.endpoint, &h.principal, "ses_1", |_| async { true }).await.unwrap();
    assert!(h.state.lock().unwrap().calls.is_empty());

    // Enable policy: concurrent sends serialize so only one activation runs.
    crate::settings::patch_owner(
        &h.app,
        crate::settings::Kind::Config,
        "providerAccounts",
        json!({"autoSelect": {"openai": true}}),
    )
    .map_err(|e| e.message())
    .unwrap();
    let (r1, r2) = tokio::join!(
        before_send(&h.app, &h.endpoint, &h.principal, "ses_1", |_| async { true }),
        before_send(&h.app, &h.endpoint, &h.principal, "ses_1", |_| async { true }),
    );
    r1.unwrap();
    r2.unwrap();
    assert_eq!(h.state.lock().unwrap().order, vec!["two", "one", "three"]);
    assert_eq!(h.state.lock().unwrap().calls.iter().filter(|c| c.ends_with("/activate")).count(), 1);

    // Reset back to "one" active; manual fence blocks activation.
    {
        let mut s = h.state.lock().unwrap();
        s.order = vec!["one".into(), "two".into(), "three".into()];
        for e in &mut s.entries {
            e["active"] = json!(e["id"] == "one");
        }
    }
    let guard = h.app.provider_usage.accounts.manual_fence(&h.endpoint);
    before_send(&h.app, &h.endpoint, &h.principal, "ses_1", |_| async { true }).await.unwrap();
    drop(guard);
    assert_eq!(h.state.lock().unwrap().order[0], "one");

    // Policy revision change mid-flight fences activation.
    let checks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let app_clone = Arc::clone(&h.app);
    let checks_clone = Arc::clone(&checks);
    before_send(&h.app, &h.endpoint, &h.principal, "ses_1", move |_| {
        let app = Arc::clone(&app_clone);
        let checks = Arc::clone(&checks_clone);
        async move {
            if checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                app.provider_usage.accounts.note_policy_change();
            }
            true
        }
    })
    .await
    .unwrap();
    assert_eq!(h.state.lock().unwrap().order[0], "one");

    // Ambiguous activation failure returns 502 PROVIDER_ACCOUNT_SELECTION_FAILED without secret or retry.
    h.state.lock().unwrap().fail_activation = true;
    let err = before_send(&h.app, &h.endpoint, &h.principal, "ses_1", |_| async { true }).await.unwrap_err();
    assert_eq!(err.0, Status::BAD_GATEWAY);
    assert_eq!(err.1.0["error"], "PROVIDER_ACCOUNT_SELECTION_FAILED");
    assert!(!err.1.0.to_string().contains("secret-provider-error"));
    assert_eq!(h.state.lock().unwrap().calls.iter().filter(|c| c.ends_with("/activate")).count(), 2);
}

#[tokio::test]
async fn reactive_go_rotation_respects_marks_definite_4xx_and_console_scope() {
    let h = setup_harness(
        "opencode-go",
        "opencode-go",
        vec![
            go_key_entry("opencode-go", "one", true),
            go_key_entry("opencode-go", "two", false),
            go_key_entry("opencode-go", "three", false),
        ],
    )
    .await;
    crate::settings::patch_owner(
        &h.app,
        crate::settings::Kind::Config,
        "providerAccounts",
        json!({"autoSelect": {"opencode-go": true}}),
    )
    .map_err(|e| e.message())
    .unwrap();

    // Unknown current quota does not rotate without a mark.
    before_send(&h.app, &h.endpoint, &h.principal, "ses_go", |_| async { true }).await.unwrap();
    assert_eq!(h.state.lock().unwrap().order[0], "one");

    // Definite 402 on "two" rules it out; "three" stays unknown (503) so reactive adapter picks "three".
    {
        let mut s = h.state.lock().unwrap();
        s.quota_responses.insert("secret-one".into(), (200, go_usage_payload(100.0)));
        s.quota_responses.insert("secret-two".into(), (402, json!({"error": "no go plan"})));
        s.quota_responses.insert("secret-three".into(), (503, json!({"error": "retry"})));
    }
    before_send(&h.app, &h.endpoint, &h.principal, "ses_go", |_| async { true }).await.unwrap();
    assert_eq!(h.state.lock().unwrap().order[0], "three");

    // Reactive failure mark rotates unknown "three" back to unmarked "one" (once "one" is unknown too).
    {
        let mut s = h.state.lock().unwrap();
        s.quota_responses.remove("secret-one");
    }
    let started = crate::shared::now_ms() as f64 + 10.0;
    h.app.provider_usage.accounts.observe_event(
        &h.app,
        &h.endpoint,
        &json!({
            "id": "evt_step_1",
            "type": "session.step.started",
            "created": started,
            "data": {"sessionID": "ses_go", "model": {"providerID": "opencode-go", "id": "m"}}
        }),
    );
    let failure = QuotaFailure {
        session_id: "ses_go".into(),
        failed_at: started + 5.0,
        limit_name: Some("5 hour".into()),
        watermark: None,
    };
    assert!(h.app.provider_usage.accounts.mark_quota_failure(&h.app, &h.endpoint, &failure).await);
    before_send(&h.app, &h.endpoint, &h.principal, "ses_go", |_| async { true }).await.unwrap();
    assert_eq!(h.state.lock().unwrap().order[0], "one");

    // Manual change clears marks.
    let _g = h.app.provider_usage.accounts.manual_fence(&h.endpoint);
    drop(_g);
    let failure2 = QuotaFailure {
        session_id: "ses_go".into(),
        failed_at: started + 6.0,
        limit_name: Some("weekly".into()),
        watermark: None,
    };
    assert!(
        !h.app.provider_usage.accounts.mark_quota_failure(&h.app, &h.endpoint, &failure2).await,
        "manual change since step start fences attribution"
    );
}

#[test]
fn selection_registry_parsers_and_quota_marks_match_ts_contracts() {
    // Registry scope: 10 subscription integrations; Console rotates only opencode-go.
    for pay_as_you_go in ["openrouter", "deepinfra", "zai", "minimax", "deepseek", "cursor", "google"] {
        assert!(adapter_for_provider(&json!({"id": pay_as_you_go})).is_none());
    }
    assert_eq!(
        adapter_for_provider(&json!({"id": "opencode-go", "integrationID": "opencode"})).map(|a| a.integration_id),
        Some("opencode")
    );
    assert!(adapter_for_provider(&json!({"id": "opencode", "integrationID": "opencode"})).is_none());
    assert!(adapter_for_provider(&json!({"id": "opencode-free", "integrationID": "opencode"})).is_none());
    assert_eq!(
        adapter_for_provider(&json!({"id": "alias", "integrationID": "opencode", "canonical": "opencode-go"}))
            .map(|a| a.integration_id),
        Some("opencode")
    );
    assert!(adapter("kimi").is_none());
    assert!(adapter("kimi-for-coding").is_some());

    // Strict Codex parser rejects malformed/contradictory payloads.
    let now = crate::shared::now_ms();
    assert!(parse_codex_selection_quota(&json!({}), now).is_err());
    assert!(parse_codex_selection_quota(&json!({"rate_limit": {"allowed": "yes", "primary_window": {"used_percent": 10, "limit_window_seconds": 18000, "reset_at": (now + 60_000) / 1000}}}), now).is_err());
    assert!(parse_codex_selection_quota(&json!({"rate_limit": {"allowed": false, "primary_window": {"used_percent": 10, "limit_window_seconds": 18000, "reset_at": (now + 60_000) / 1000}}}), now).is_err());
    assert!(parse_codex_selection_quota(&json!({"rate_limit": {"primary_window": {"used_percent": 10, "limit_window_seconds": 18000, "reset_at": (now - 1_000) / 1000}}}), now).is_err());
    assert!(parse_codex_selection_quota(&codex_usage_payload(40.0, 60_000), now).is_ok());

    // quota_state: monthly & monthly-code decisive, past resets unknown.
    let mut monthly = Fields::new();
    monthly.insert("monthly".into(), window(Some(100.0), None, None, None));
    assert_eq!(quota_state(&monthly, now), ReadState::Exhausted);
    let mut past = Fields::new();
    past.insert("5h".into(), window(Some(100.0), Some(18000.0), Some(1.0), None));
    assert_eq!(quota_state(&past, now), ReadState::Unknown);

    // Definite rejection statuses.
    for s in [400, 401, 402, 404, 451] {
        assert!(definite_rejection(s), "{s}");
    }
    for s in [408, 429, 500, 503] {
        assert!(!definite_rejection(s), "{s}");
    }

    // Quota failure parser & TTLs.
    let body = json!({"metadata": {"limitName": "5 hour"}}).to_string();
    let parsed = parse_quota_failure(&json!({
        "type": "session.step.failed",
        "created": 42,
        "data": {"sessionID": "ses_1", "error": {"type": "provider.quota", "response": {"body": body}}}
    }))
    .unwrap();
    assert_eq!(parsed.session_id, "ses_1");
    assert_eq!(parsed.limit_name.as_deref(), Some("5 hour"));
    assert_eq!(quota_mark_ttl(Some("5 hour")), 5 * 3_600_000);
    assert_eq!(quota_mark_ttl(Some("weekly")), 24 * 3_600_000);
    assert_eq!(quota_mark_ttl(None), 24 * 3_600_000);

    // Enterprise Copilot credential builds (eligible) but stays unread; Codex rejects token-sharing.
    let token_sharing = json!({
        "id": "ts",
        "integrationID": "openai",
        "value": {"type": "oauth", "methodID": "chatgpt-token-sharing", "access": "tok", "expires": now + 3_600_000, "metadata": {"accountID": "a"}}
    });
    assert!(build_credential(adapter("openai").unwrap(), &token_sharing, now).is_none());
}
