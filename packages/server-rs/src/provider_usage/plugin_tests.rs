use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Extension, Router,
    body::{Body, Bytes, to_bytes},
    extract::{Request, State as AxumState},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    parse::{MAX_WINDOWS, parse_output_raw, to_hundredths},
    *,
};
use crate::{
    App, Workspace,
    auth::Principal,
    opencode::Native,
    provider_usage::{
        Query, owned_read_with_deadlines, query, routes,
        shared::{Fields, Usage, window},
    },
};

fn parse_output(raw: &Value, req: &str, id: &str, model: Option<&str>, now: u64) -> Option<Value> {
    let raw_out = parse_output_raw(&raw.to_string(), req, id, model, now)?;
    serde_json::from_str(raw_out.get()).ok()
}

#[test]
fn rpc_id_accepts_safe_ids_and_rejects_traversal_or_excess_length() {
    assert_eq!(rpc_id("my-plugin"), Some("provider-usage.my-plugin".into()));
    assert_eq!(rpc_id("  acme_v2.beta-1  "), Some("provider-usage.acme_v2.beta-1".into()));
    assert_eq!(rpc_id(&"a".repeat(100)), Some(format!("provider-usage.{}", "a".repeat(100))));

    for invalid in ["", "   ", "some..provider", "..", "a/b", "a\\b", "a:b", "a b", "a%2fb", &"a".repeat(101)] {
        assert_eq!(rpc_id(invalid), None, "expected None for {invalid:?}");
    }
}

#[test]
fn query_enforces_utf16_code_unit_limit_256() {
    let ok_astral = "😀".repeat(128); // 256 UTF-16 code units
    let too_long_astral = "😀".repeat(129); // 258 UTF-16 code units
    let ok_q = format!("instanceId=w&sessionId=s&modelId={ok_astral}");
    let bad_q = format!("instanceId=w&sessionId=s&modelId={too_long_astral}");
    assert!(query(Some(&ok_q)).is_some());
    assert!(query(Some(&bad_q)).is_none());
    assert!(query(Some(&format!("instanceId={ok_astral}&sessionId=s"))).is_some());
    assert!(query(Some(&format!("instanceId={too_long_astral}&sessionId=s"))).is_none());
    assert!(query(Some(&format!("instanceId=w&sessionId={ok_astral}"))).is_some());
    assert!(query(Some(&format!("instanceId=w&sessionId={too_long_astral}"))).is_none());
}

#[test]
fn to_hundredths_uses_shortest_decimal_without_double_rounding() {
    assert_eq!(to_hundredths(0.0), 0);
    assert_eq!(to_hundredths(-0.0), 0);
    assert_eq!(to_hundredths(0.0049999), 0);
    assert_eq!(to_hundredths(0.005), 1);
    assert_eq!(to_hundredths(1.005), 101);
    assert_eq!(to_hundredths(99.0549), 9905);
    assert_eq!(to_hundredths(99.0449), 9904);
    assert_eq!(to_hundredths(99.9949999), 9999);
    assert_eq!(to_hundredths(99.995), 10_000);
    assert_eq!(to_hundredths(100.0), 10_000);
}

#[test]
fn parse_output_normalizes_valid_payload_preserves_window_order_and_ignores_extra_1e400() {
    let raw_json = r#"{
        "providerName": "  Acme Cloud  ",
        "configured": true,
        "ok": true,
        "fetchedAt": 1700000000000,
        "extraField": 1e400,
        "unavailableReason": "must-not-leak",
        "windows": {
            "weekly": {
                "usedPercent": 1.005,
                "remainingPercent": 98.995,
                "windowSeconds": 18000,
                "resetAt": 1700018000000,
                "valueLabel": "  5h window  "
            },
            "daily:sonnet": {
                "remainingPercent": 99.9949999
            },
            "credits": {
                "balanceUSD": { "remaining": -2.5, "total": 10 }
            },
            "spend": {
                "limitUSD": 50
            },
            "requests": {
                "consumption": { "used": 12, "limit": 100 }
            },
            "tokens": {
                "consumption": { "creditsUsed": 42.5 }
            },
            "plan": {
                "consumption": { "unlimited": true }
            }
        }
    }"#;
    let raw_out = parse_output_raw(raw_json, "acme", "acme", Some("acme-pro"), 9_999).expect("valid output");
    let serialized = raw_out.get();
    let weekly_pos = serialized.find("\"weekly\":").expect("weekly key");
    let daily_pos = serialized.find("\"daily:sonnet\":").expect("daily key");
    assert!(weekly_pos < daily_pos, "expected weekly before daily in {serialized}");

    let parsed: Value = serde_json::from_str(serialized).unwrap();
    assert_eq!(parsed["requestedProviderId"], "acme");
    assert_eq!(parsed["providerId"], "acme");
    assert_eq!(parsed["providerName"], "Acme Cloud");
    assert_eq!(parsed["modelId"], "acme-pro");
    assert_eq!(parsed["supported"], true);
    assert_eq!(parsed["configured"], true);
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["fetchedAt"], 1_700_000_000_000_u64);
    assert!(parsed.get("extraField").is_none());
    assert!(parsed.get("unavailableReason").is_none());
    assert_eq!(
        parsed["windows"]["weekly"],
        json!({
            "usedPercent": 1.01,
            "remainingPercent": 98.99,
            "windowSeconds": 18000,
            "resetAt": 1_700_018_000_000_u64,
            "valueLabel": "5h window"
        })
    );
    assert_eq!(
        parsed["windows"]["daily:sonnet"],
        json!({
            "usedPercent": 0.01,
            "remainingPercent": 99.99,
            "windowSeconds": null,
            "resetAt": null
        })
    );
    assert_eq!(parsed["windows"]["credits"]["balanceUSD"], json!({ "remaining": -2.5, "total": 10 }));
    assert_eq!(parsed["windows"]["spend"]["limitUSD"], json!(50));
    assert_eq!(parsed["windows"]["requests"]["consumption"], json!({ "used": 12, "limit": 100 }));
    assert_eq!(parsed["windows"]["tokens"]["consumption"], json!({ "creditsUsed": 42.5 }));
    assert_eq!(parsed["windows"]["plan"]["consumption"], json!({ "unlimited": true }));
}

#[test]
fn parse_output_handles_unconfigured_and_boundary_percent_refinements() {
    let unconfigured = json!({
        "configured": false,
        "ok": true,
        "windows": { "primary": { "usedPercent": 25 } }
    });
    let parsed = parse_output(&unconfigured, "acme", "acme", None, 12345).expect("valid unconfigured");
    assert_eq!(parsed["configured"], false);
    assert_eq!(parsed["ok"], false);
    assert_eq!(parsed["providerName"], "acme");
    assert_eq!(parsed["fetchedAt"], 12345);
    assert_eq!(parsed["windows"], json!({}));
    assert!(parsed.get("modelId").is_none());

    let bad_unconfigured = json!({
        "configured": false,
        "ok": false,
        "windows": { "primary": { "usedPercent": 120 } }
    });
    assert!(parse_output(&bad_unconfigured, "acme", "acme", None, 12345).is_none());

    let within_tolerance = json!({
        "configured": true,
        "ok": true,
        "windows": { "primary": { "usedPercent": 1, "remainingPercent": 99.0549 } }
    });
    let ok = parse_output(&within_tolerance, "acme", "acme", None, 1).expect("within tolerance");
    assert_eq!(ok["windows"]["primary"]["usedPercent"], 1);
    assert_eq!(ok["windows"]["primary"]["remainingPercent"], 99);

    let outside_tolerance = json!({
        "configured": true,
        "ok": true,
        "windows": { "primary": { "usedPercent": 1, "remainingPercent": 99.055 } }
    });
    assert!(parse_output(&outside_tolerance, "acme", "acme", None, 1).is_none());
}

#[test]
fn parse_output_rejects_forbidden_keys_control_chars_and_invalid_windows() {
    let cases = vec![
        json!({ "configured": true, "ok": true, "windows": { "__proto__": { "usedPercent": 10 } } }),
        json!({ "configured": true, "ok": true, "windows": { "constructor:model": { "usedPercent": 10 } } }),
        json!({ "configured": true, "ok": true, "windows": { "toString": { "usedPercent": 10 } } }),
        json!({ "configured": true, "ok": true, "windows": { " primary": { "usedPercent": 10 } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary: detail": { "usedPercent": 10 } } }),
        json!({ "configured": true, "ok": true, "windows": { ":detail": { "usedPercent": 10 } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary:": { "usedPercent": 10 } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary\n": { "usedPercent": 10 } } }),
        json!({ "providerName": "\tAcme", "configured": true, "ok": true, "windows": {} }),
        json!({ "providerName": "Acme\u{0085}", "configured": true, "ok": true, "windows": {} }),
        json!({ "providerName": "   ", "configured": true, "ok": true, "windows": {} }),
        json!({ "providerName": null, "configured": true, "ok": true, "windows": {} }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "valueLabel": "bad\x1f" } } }),
        json!({ "configured": true, "ok": true, "fetchedAt": 0, "windows": {} }),
        json!({ "configured": true, "ok": true, "fetchedAt": 8_640_000_000_000_001_u64, "windows": {} }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "resetAt": 0 } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "resetAt": 8_640_000_000_000_001_u64 } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "usedPercent": 10, "extra": true } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "usedPercent": 0, "consumption": { "unlimited": true } } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "consumption": { "unlimited": false } } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "limitUSD": 10, "balanceUSD": { "remaining": 5 } } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "limitUSD": 10, "consumption": { "used": 1 } } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "balanceUSD": { "remaining": 1, "total": -1 } } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "limitUSD": -1 } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "windowSeconds": -1 } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "consumption": { "used": -1 } } } }),
        json!({ "configured": true, "ok": true, "windows": { "primary": { "consumption": { "creditsUsed": -1 } } } }),
    ];
    for (idx, case) in cases.iter().enumerate() {
        assert!(parse_output(case, "acme", "acme", None, 1).is_none(), "case {idx} should fail");
    }

    let mut too_many = Fields::new();
    for i in 0..=MAX_WINDOWS {
        too_many.insert(format!("w{i}"), json!({ "usedPercent": 10 }));
    }
    let over_limit = json!({ "configured": true, "ok": true, "windows": Value::Object(too_many) });
    assert!(parse_output(&over_limit, "acme", "acme", None, 1).is_none());
}

struct TempDir(PathBuf);
impl TempDir {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("cn-plugin-usage-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dunce::canonicalize(&dir).unwrap())
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

type MockHandler = Arc<dyn Fn(MockRequest) -> futures_util::future::BoxFuture<'static, Response> + Send + Sync>;

struct MockRequest {
    method: String,
    path: String,
    query: String,
    body: String,
}

#[derive(Clone)]
struct MockDaemonState {
    calls: Arc<Mutex<Vec<String>>>,
    handler: MockHandler,
}

async fn mock_daemon_entry(AxumState(state): AxumState<MockDaemonState>, req: Request) -> Response {
    let method = req.method().as_str().to_owned();
    let path = req.uri().path().to_owned();
    let query = req.uri().query().unwrap_or("").to_owned();
    let bytes = to_bytes(req.into_body(), 1024 * 1024).await.unwrap_or_default();
    let body = String::from_utf8_lossy(&bytes).into_owned();
    state.calls.lock().unwrap().push(format!("{method} {path}"));
    (state.handler)(MockRequest { method, path, query, body }).await
}

struct Harness {
    app: Arc<App>,
    app_addr: std::net::SocketAddr,
    daemon_addr: std::net::SocketAddr,
    workspace_id: Uuid,
    directory: String,
    calls: Arc<Mutex<Vec<String>>>,
    _dir: TempDir,
    server: tokio::task::JoinHandle<()>,
    app_server: tokio::task::JoinHandle<()>,
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
        self.app_server.abort();
    }
}

impl Harness {
    async fn start<F, Fut>(handler: F) -> Self
    where
        F: Fn(MockRequest) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Response> + Send + 'static,
    {
        let dir = TempDir::new("ws");
        let root_raw = dir.0.join("repo");
        std::fs::create_dir_all(&root_raw).unwrap();
        let root = dunce::canonicalize(&root_raw).unwrap();
        let directory = root.to_string_lossy().into_owned();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let state = MockDaemonState { calls: calls.clone(), handler: Arc::new(move |req| Box::pin(handler(req))) };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let daemon_addr = listener.local_addr().unwrap();
        let native = Native::test_connection(daemon_addr);
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, Router::new().fallback(any(mock_daemon_entry)).with_state(state)).await;
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
            dir.0.join("config.yaml").to_str().unwrap(),
        ));
        let app = Arc::new(App::new(
            auth,
            0,
            dir.0.clone(),
            dir.0.clone(),
            false,
            settings,
            Value::Null,
            native,
            PathBuf::new(),
            None,
            crate::files::watch::Watches::new(tx),
            None,
        ));
        let workspace_id = Uuid::new_v4();
        let ws = Workspace {
            id: workspace_id,
            request_id: None,
            path: root,
            name: None,
            status: "running",
            proxy_path: format!("/workspaces/{workspace_id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            location: json!({ "directory": directory }),
        };
        app.inner.lock().unwrap().workspaces.push(ws);
        let app_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let app_addr = app_listener.local_addr().unwrap();
        let router = routes().layer(Extension(Principal(CancellationToken::new()))).with_state(app.clone());
        let app_server = tokio::spawn(async move {
            let _ = axum::serve(app_listener, router).await;
        });
        Self { app, app_addr, daemon_addr, workspace_id, directory, calls, _dir: dir, server, app_server }
    }

    async fn get_usage_text(&self, provider: &str, model: Option<&str>) -> (StatusCode, String) {
        let mut uri =
            format!("http://{}/api/usage/{provider}?instanceId={}&sessionId=ses_1", self.app_addr, self.workspace_id);
        if let Some(m) = model {
            uri.push_str(&format!("&modelId={m}"));
        }
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let resp = client.get(&uri).send().await.unwrap();
        let status = StatusCode::from_u16(resp.status().as_u16()).unwrap();
        let text = resp.text().await.unwrap_or_default();
        (status, text)
    }

    async fn get_usage(&self, provider: &str, model: Option<&str>) -> (StatusCode, Value) {
        let (status, text) = self.get_usage_text(provider, model).await;
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        (status, body)
    }

    fn query(&self, model: Option<&str>) -> Query {
        Query { instance: self.workspace_id.to_string(), session: "ses_1".into(), model: model.map(str::to_owned) }
    }
}

fn json_resp(status: StatusCode, value: Value) -> Response {
    (status, [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], value.to_string()).into_response()
}

fn chunked_overflow_resp(status: StatusCode) -> Response {
    let chunks: Vec<Result<Bytes, std::io::Error>> = (0..17).map(|_| Ok(Bytes::from(vec![b'a'; 16 * 1024]))).collect();
    let stream = futures_util::stream::iter(chunks);
    (status, [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], Body::from_stream(stream))
        .into_response()
}

fn session_resp(directory: &str) -> Response {
    json_resp(StatusCode::OK, json!({ "data": { "id": "ses_1", "location": { "directory": directory } } }))
}

#[tokio::test]
async fn route_serves_valid_plugin_quota_with_bom_and_key_order_without_credentials() {
    let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let seen_rpc: Arc<Mutex<Option<(String, String)>>> = Arc::new(Mutex::new(None));
    let dir_ref = dir_holder.clone();
    let rpc_ref = seen_rpc.clone();
    let h = Harness::start(move |req| {
        let dir = dir_ref.clone();
        let rpc = rpc_ref.clone();
        async move {
            if req.path == "/api/session/ses_1" {
                return session_resp(&dir.lock().unwrap());
            }
            if req.path == "/api/rpc/provider-usage.my-plugin/read" {
                *rpc.lock().unwrap() = Some((req.query, req.body));
                let raw = "\u{feff}{\"output\":{\"providerName\":\"My Plugin\",\"configured\":true,\"ok\":true,\"fetchedAt\":1700000000000,\"extra\":1e400,\"windows\":{\"weekly\":{\"usedPercent\":12},\"daily\":{\"usedPercent\":35,\"windowSeconds\":3600}}}}";
                return (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"))],
                    raw,
                )
                    .into_response();
            }
            panic!("unexpected daemon path: {} {}", req.method, req.path);
        }
    })
    .await;
    *dir_holder.lock().unwrap() = h.directory.clone();

    let (status, text) = h.get_usage_text("my-plugin", Some("fast-1")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(text.find("\"weekly\":").unwrap() < text.find("\"daily\":").unwrap(), "order lost: {text}");
    let body: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(body["supported"], true);
    assert_eq!(body["configured"], true);
    assert_eq!(body["ok"], true);
    assert_eq!(body["providerId"], "my-plugin");
    assert_eq!(body["providerName"], "My Plugin");
    assert_eq!(body["modelId"], "fast-1");
    assert_eq!(body["windows"]["daily"]["usedPercent"], 35);
    assert_eq!(body["windows"]["daily"]["remainingPercent"], 65);

    let (query, req_body) = seen_rpc.lock().unwrap().clone().expect("rpc called");
    let mut expected_url = reqwest::Url::parse("http://example.invalid/").unwrap();
    expected_url.query_pairs_mut().append_pair("location[directory]", &h.directory);
    assert_eq!(query, expected_url.query().unwrap());
    assert_eq!(serde_json::from_str::<Value>(&req_body).unwrap(), json!({ "input": { "modelId": "fast-1" } }));

    let calls = h.calls.lock().unwrap().clone();
    assert!(!calls.iter().any(|c| c.contains("/api/credential") || c.contains("/api/provider/")));
    assert_eq!(calls.iter().filter(|c| *c == "GET /api/session/ses_1").count(), 3);
}

#[tokio::test]
async fn route_falls_back_to_unsupported_on_absent_rpc_400_and_404() {
    for (label, rpc_response_kind) in
        [("400-unavailable", 0_u8), ("400-method-not-found", 1), ("404-plain", 2), ("404-generic-json", 3)]
    {
        let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let dir_ref = dir_holder.clone();
        let h = Harness::start(move |req| {
            let dir = dir_ref.clone();
            async move {
                if req.path == "/api/session/ses_1" {
                    return session_resp(&dir.lock().unwrap());
                }
                if req.path == "/api/rpc/provider-usage.unknown-plugin/read" {
                    return match rpc_response_kind {
                        0 => json_resp(
                            StatusCode::BAD_REQUEST,
                            json!({ "_tag": "RpcError", "type": "rpc.unavailable", "message": "not registered" }),
                        ),
                        1 => json_resp(
                            StatusCode::BAD_REQUEST,
                            json!({ "_tag": "RpcError", "type": "rpc.method_not_found", "message": "no read" }),
                        ),
                        2 => (
                            StatusCode::NOT_FOUND,
                            [(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"))],
                            "Not Found",
                        )
                            .into_response(),
                        _ => json_resp(StatusCode::NOT_FOUND, json!({ "error": "Not found" })),
                    };
                }
                if req.path == "/api/provider/unknown-plugin" {
                    return json_resp(StatusCode::NOT_FOUND, json!({ "error": "not found" }));
                }
                panic!("unexpected path in {label}: {}", req.path);
            }
        })
        .await;
        *dir_holder.lock().unwrap() = h.directory.clone();

        let (status, body) = h.get_usage("unknown-plugin", None).await;
        assert_eq!(status, StatusCode::OK, "case {label}");
        assert_eq!(body["supported"], false, "case {label}");
        assert_eq!(body["configured"], false, "case {label}");
        assert_eq!(body["ok"], false, "case {label}");
    }
}

#[tokio::test]
async fn route_classifies_rpc_errors_status_mismatches_redirects_and_streaming_overflow() {
    let cases: Vec<(&str, StatusCode, Box<dyn Fn(std::net::SocketAddr) -> Response + Send + Sync>)> = vec![
        (
            "registered-custom-rpc-error-with-raw-data",
            StatusCode::OK,
            Box::new(|_| {
                (
                    StatusCode::BAD_REQUEST,
                    [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))],
                    r#"{"_tag":"RpcError","type":"quota_failed","message":"secret upstream detail","data":{"big":1e400}}"#,
                )
                    .into_response()
            }),
        ),
        (
            "registered-system-invalid-output",
            StatusCode::OK,
            Box::new(|_| {
                json_resp(
                    StatusCode::BAD_REQUEST,
                    json!({ "_tag": "RpcError", "type": "rpc.invalid_output", "message": "" }),
                )
            }),
        ),
        (
            "registered-500-rpc-internal",
            StatusCode::OK,
            Box::new(|_| {
                json_resp(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "_tag": "RpcInternalError", "type": "rpc.internal", "message": "boom" }),
                )
            }),
        ),
        (
            "200-malformed-plugin-output",
            StatusCode::OK,
            Box::new(|_| {
                json_resp(
                    StatusCode::OK,
                    json!({ "output": { "configured": true, "ok": true, "windows": { "bad": { "usedPercent": 999 } } } }),
                )
            }),
        ),
        (
            "200-invalid-utf8",
            StatusCode::OK,
            Box::new(|_| {
                (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))],
                    vec![0xff_u8, 0xfe, 0xfd],
                )
                    .into_response()
            }),
        ),
        ("200-streaming-chunked-overflow", StatusCode::OK, Box::new(|_| chunked_overflow_resp(StatusCode::OK))),
        (
            "404-streaming-chunked-overflow-is-503",
            StatusCode::SERVICE_UNAVAILABLE,
            Box::new(|_| chunked_overflow_resp(StatusCode::NOT_FOUND)),
        ),
        (
            "400-absent-with-extra-data-is-503",
            StatusCode::SERVICE_UNAVAILABLE,
            Box::new(|_| {
                json_resp(
                    StatusCode::BAD_REQUEST,
                    json!({ "_tag": "RpcError", "type": "rpc.unavailable", "message": "x", "data": {} }),
                )
            }),
        ),
        (
            "400-unknown-reserved-rpc-code-is-503",
            StatusCode::SERVICE_UNAVAILABLE,
            Box::new(|_| {
                json_resp(
                    StatusCode::BAD_REQUEST,
                    json!({ "_tag": "RpcError", "type": "rpc.future_code", "message": "x" }),
                )
            }),
        ),
        (
            "404-location-not-found-is-503",
            StatusCode::SERVICE_UNAVAILABLE,
            Box::new(|_| {
                json_resp(StatusCode::NOT_FOUND, json!({ "_tag": "LocationNotFoundError", "message": "gone" }))
            }),
        ),
        (
            "404-problem-json-location-not-found-is-503",
            StatusCode::SERVICE_UNAVAILABLE,
            Box::new(|_| {
                (
                    StatusCode::NOT_FOUND,
                    [(header::CONTENT_TYPE, HeaderValue::from_static("application/problem+json"))],
                    json!({ "_tag": "LocationNotFoundError", "message": "gone" }).to_string(),
                )
                    .into_response()
            }),
        ),
        (
            "404-session-not-found-is-503",
            StatusCode::SERVICE_UNAVAILABLE,
            Box::new(|_| {
                json_resp(StatusCode::NOT_FOUND, json!({ "_tag": "SessionNotFoundError", "message": "gone" }))
            }),
        ),
        (
            "404-rpc-error-envelope-is-503",
            StatusCode::SERVICE_UNAVAILABLE,
            Box::new(|_| {
                json_resp(
                    StatusCode::NOT_FOUND,
                    json!({ "_tag": "RpcError", "type": "rpc.unavailable", "message": "misrouted" }),
                )
            }),
        ),
        (
            "404-rpc-internal-envelope-is-503",
            StatusCode::SERVICE_UNAVAILABLE,
            Box::new(|_| {
                json_resp(
                    StatusCode::NOT_FOUND,
                    json!({ "_tag": "RpcInternalError", "type": "rpc.internal", "message": "misrouted" }),
                )
            }),
        ),
        (
            "404-malformed-json-is-503",
            StatusCode::SERVICE_UNAVAILABLE,
            Box::new(|_| {
                (
                    StatusCode::NOT_FOUND,
                    [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))],
                    "{not-json",
                )
                    .into_response()
            }),
        ),
        (
            "404-lone-surrogate-key-with-rpc-error-tag-is-503",
            StatusCode::SERVICE_UNAVAILABLE,
            Box::new(|_| {
                (
                    StatusCode::NOT_FOUND,
                    [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))],
                    r#"{"\ud800":1,"_tag":"RpcError","type":"rpc.unavailable","message":"masked"}"#,
                )
                    .into_response()
            }),
        ),
        (
            "500-non-rpc-error-is-503",
            StatusCode::SERVICE_UNAVAILABLE,
            Box::new(|_| json_resp(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "daemon crash" }))),
        ),
        (
            "302-redirect-to-same-fixture-never-followed",
            StatusCode::SERVICE_UNAVAILABLE,
            Box::new(|addr| {
                let target = format!("http://{addr}/redirected-target");
                (StatusCode::FOUND, [(header::LOCATION, HeaderValue::from_str(&target).unwrap())]).into_response()
            }),
        ),
    ];

    for (label, expected_status, make_response) in cases {
        let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let addr_holder: Arc<Mutex<Option<std::net::SocketAddr>>> = Arc::new(Mutex::new(None));
        let dir_ref = dir_holder.clone();
        let addr_ref = addr_holder.clone();
        let maker = Arc::new(Mutex::new(Some(make_response)));
        let h = Harness::start(move |req| {
            let dir = dir_ref.clone();
            let addr = addr_ref.clone();
            let maker = maker.clone();
            async move {
                if req.path == "/api/session/ses_1" {
                    return session_resp(&dir.lock().unwrap());
                }
                if req.path == "/api/rpc/provider-usage.edge/read" {
                    let f = maker.lock().unwrap().take().expect("one rpc call");
                    return f(addr.lock().unwrap().expect("daemon addr"));
                }
                panic!("unexpected path in {label}: {}", req.path);
            }
        })
        .await;
        *dir_holder.lock().unwrap() = h.directory.clone();
        *addr_holder.lock().unwrap() = Some(h.daemon_addr);

        let (status, body) = h.get_usage("edge", None).await;
        assert_eq!(status, expected_status, "case {label}: {body}");
        assert!(
            !h.calls.lock().unwrap().iter().any(|c| c.contains("/redirected-target")),
            "redirect followed in {label}"
        );
        if expected_status == StatusCode::OK {
            assert_eq!(body["supported"], true, "case {label}");
            assert_eq!(body["configured"], true, "case {label}");
            assert_eq!(body["ok"], false, "case {label}");
            assert_eq!(body["windows"], json!({}), "case {label}");
            assert!(!body.to_string().contains("secret upstream detail"), "leaked upstream text in {label}");
        }
    }
}

#[tokio::test]
async fn route_fences_session_move_workspace_eviction_and_live_daemon_retirement() {
    // 1. Session moves before pre-dispatch re-read -> 403, RPC never dispatched.
    {
        let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let dir_ref = dir_holder.clone();
        let count = Arc::new(Mutex::new(0_usize));
        let count_ref = count.clone();
        let h = Harness::start(move |req| {
            let dir = dir_ref.clone();
            let count = count_ref.clone();
            async move {
                if req.path == "/api/session/ses_1" {
                    let mut n = count.lock().unwrap();
                    *n += 1;
                    return if *n == 1 { session_resp(&dir.lock().unwrap()) } else { session_resp("/elsewhere") };
                }
                panic!("RPC must not dispatch after session move: {}", req.path);
            }
        })
        .await;
        *dir_holder.lock().unwrap() = h.directory.clone();
        let (status, _) = h.get_usage("my-plugin", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    // 2. Session moves after RPC succeeds -> 403 at publication fence.
    {
        let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let dir_ref = dir_holder.clone();
        let count = Arc::new(Mutex::new(0_usize));
        let count_ref = count.clone();
        let h = Harness::start(move |req| {
            let dir = dir_ref.clone();
            let count = count_ref.clone();
            async move {
                if req.path == "/api/session/ses_1" {
                    let mut n = count.lock().unwrap();
                    *n += 1;
                    return if *n <= 2 { session_resp(&dir.lock().unwrap()) } else { session_resp("/moved") };
                }
                if req.path == "/api/rpc/provider-usage.my-plugin/read" {
                    return json_resp(
                        StatusCode::OK,
                        json!({ "output": { "configured": true, "ok": true, "windows": {} } }),
                    );
                }
                panic!("unexpected path: {}", req.path);
            }
        })
        .await;
        *dir_holder.lock().unwrap() = h.directory.clone();
        let (status, _) = h.get_usage("my-plugin", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    // 3. Daemon retires while plugin RPC hangs forever -> aborts immediately with 503 well before quota_until.
    {
        let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let dir_ref = dir_holder.clone();
        let rpc_entered = Arc::new(tokio::sync::Notify::new());
        let entered_ref = rpc_entered.clone();
        let h = Harness::start(move |req| {
            let dir = dir_ref.clone();
            let entered = entered_ref.clone();
            async move {
                if req.path == "/api/session/ses_1" {
                    return session_resp(&dir.lock().unwrap());
                }
                if req.path == "/api/rpc/provider-usage.hung-plugin/read" {
                    entered.notify_one();
                    std::future::pending::<()>().await;
                }
                panic!("unexpected path: {}", req.path);
            }
        })
        .await;
        *dir_holder.lock().unwrap() = h.directory.clone();
        let retire_app = h.app.clone();
        tokio::spawn(async move {
            rpc_entered.notified().await;
            retire_app.native.retire_test_endpoint();
        });
        let started = Instant::now();
        let (status, _) = h.get_usage("hung-plugin", None).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(started.elapsed() < Duration::from_secs(2), "retired RPC hung for {:?}", started.elapsed());
        assert_eq!(h.calls.lock().unwrap().iter().filter(|c| *c == "GET /api/session/ses_1").count(), 2);
    }

    // 3b. Daemon retires while pre-dispatch session_location() hangs -> aborts immediately with 503.
    {
        let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let dir_ref = dir_holder.clone();
        let count = Arc::new(Mutex::new(0_usize));
        let count_ref = count.clone();
        let entered = Arc::new(tokio::sync::Notify::new());
        let entered_ref = entered.clone();
        let h = Harness::start(move |req| {
            let dir = dir_ref.clone();
            let count = count_ref.clone();
            let entered = entered_ref.clone();
            async move {
                if req.path == "/api/session/ses_1" {
                    let n = {
                        let mut g = count.lock().unwrap();
                        *g += 1;
                        *g
                    };
                    if n == 2 {
                        entered.notify_one();
                        std::future::pending::<()>().await;
                    }
                    return session_resp(&dir.lock().unwrap());
                }
                panic!("RPC must not dispatch when retired during session_location: {}", req.path);
            }
        })
        .await;
        *dir_holder.lock().unwrap() = h.directory.clone();
        let retire_app = h.app.clone();
        tokio::spawn(async move {
            entered.notified().await;
            retire_app.native.retire_test_endpoint();
        });
        let started = Instant::now();
        let (status, _) = h.get_usage("hung-reread", None).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "retired session_location hung for {:?}",
            started.elapsed()
        );
    }

    // 3c. Daemon retires while streaming a 200 RPC body after headers arrive -> aborts immediately with 503.
    {
        let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let dir_ref = dir_holder.clone();
        let body_started = Arc::new(tokio::sync::Notify::new());
        let body_started_ref = body_started.clone();
        let h = Harness::start(move |req| {
            let dir = dir_ref.clone();
            let body_started = body_started_ref.clone();
            async move {
                if req.path == "/api/session/ses_1" {
                    return session_resp(&dir.lock().unwrap());
                }
                if req.path == "/api/rpc/provider-usage.hung-body/read" {
                    let stream = async_stream::stream! {
                        yield Ok::<Bytes, std::io::Error>(Bytes::from_static(b"{\"output\":"));
                        body_started.notify_one();
                        std::future::pending::<()>().await;
                    };
                    return (
                        StatusCode::OK,
                        [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))],
                        Body::from_stream(stream),
                    )
                        .into_response();
                }
                panic!("unexpected path: {}", req.path);
            }
        })
        .await;
        *dir_holder.lock().unwrap() = h.directory.clone();
        let retire_app = h.app.clone();
        tokio::spawn(async move {
            body_started.notified().await;
            tokio::time::sleep(Duration::from_millis(15)).await;
            retire_app.native.retire_test_endpoint();
        });
        let started = Instant::now();
        let (status, _) = h.get_usage("hung-body", None).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(started.elapsed() < Duration::from_secs(2), "retired RPC body hung for {:?}", started.elapsed());
    }

    // 4. Workspace evicted during absent-RPC 404 -> 403 before Codex fallback.
    {
        let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let dir_ref = dir_holder.clone();
        let evict_slot: Arc<Mutex<Option<(Arc<App>, Uuid)>>> = Arc::new(Mutex::new(None));
        let evict_ref = evict_slot.clone();
        let h = Harness::start(move |req| {
            let dir = dir_ref.clone();
            let evict = evict_ref.clone();
            async move {
                if req.path == "/api/session/ses_1" {
                    return session_resp(&dir.lock().unwrap());
                }
                if req.path == "/api/rpc/provider-usage.my-plugin/read" {
                    if let Some((app, id)) = evict.lock().unwrap().as_ref() {
                        app.inner.lock().unwrap().workspaces.retain(|w| w.id != *id);
                    }
                    return json_resp(StatusCode::NOT_FOUND, json!({ "error": "missing" }));
                }
                panic!("fallback must not run after workspace eviction: {}", req.path);
            }
        })
        .await;
        *dir_holder.lock().unwrap() = h.directory.clone();
        *evict_slot.lock().unwrap() = Some((h.app.clone(), h.workspace_id));
        let (status, _) = h.get_usage("my-plugin", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn quota_deadline_bounds_reread_and_rpc_without_starting_fallback() {
    // 1. Initial ownership check consumes the entire quota budget -> pre-dispatch re-read is NOT polled!
    {
        let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let dir_ref = dir_holder.clone();
        let count = Arc::new(Mutex::new(0_usize));
        let count_ref = count.clone();
        let h = Harness::start(move |req| {
            let dir = dir_ref.clone();
            let count = count_ref.clone();
            async move {
                if req.path == "/api/session/ses_1" {
                    let n = {
                        let mut g = count.lock().unwrap();
                        *g += 1;
                        *g
                    };
                    if n == 1 {
                        tokio::time::sleep(Duration::from_millis(60)).await;
                    }
                    return session_resp(&dir.lock().unwrap());
                }
                panic!("RPC must not dispatch when quota expired during initial auth: {}", req.path);
            }
        })
        .await;
        *dir_holder.lock().unwrap() = h.directory.clone();
        let now = Instant::now();
        let raw = owned_read_with_deadlines(
            &h.app,
            &h.query(None),
            "my-plugin",
            now + Duration::from_secs(3),
            now + Duration::from_millis(20),
        )
        .await
        .expect("should publish unavailable quota");
        let body: Value = serde_json::from_str(raw.get()).unwrap();
        assert_eq!(body["supported"], true);
        assert_eq!(body["ok"], false);
        assert_eq!(h.calls.lock().unwrap().iter().filter(|c| *c == "GET /api/session/ses_1").count(), 2);
        assert!(!h.calls.lock().unwrap().iter().any(|c| c.contains("/api/rpc/")));
    }

    // 2. Pre-dispatch re-read times out past quota_until -> 200 unavailable, RPC never called.
    {
        let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let dir_ref = dir_holder.clone();
        let count = Arc::new(Mutex::new(0_usize));
        let count_ref = count.clone();
        let h = Harness::start(move |req| {
            let dir = dir_ref.clone();
            let count = count_ref.clone();
            async move {
                if req.path == "/api/session/ses_1" {
                    let n = {
                        let mut g = count.lock().unwrap();
                        *g += 1;
                        *g
                    };
                    if n == 2 {
                        tokio::time::sleep(Duration::from_millis(120)).await;
                    }
                    return session_resp(&dir.lock().unwrap());
                }
                panic!("RPC must not dispatch when re-read exceeds quota deadline: {}", req.path);
            }
        })
        .await;
        *dir_holder.lock().unwrap() = h.directory.clone();
        let now = Instant::now();
        let raw = owned_read_with_deadlines(
            &h.app,
            &h.query(None),
            "my-plugin",
            now + Duration::from_secs(3),
            now + Duration::from_millis(40),
        )
        .await
        .expect("should publish unavailable quota");
        let body: Value = serde_json::from_str(raw.get()).unwrap();
        assert_eq!(body["supported"], true);
        assert_eq!(body["ok"], false);
        assert!(!h.calls.lock().unwrap().iter().any(|c| c.contains("/api/rpc/")));
    }

    // 3. Slow RPC exceeds quota_until -> 200 unavailable, no fallback read.
    {
        let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let dir_ref = dir_holder.clone();
        let h = Harness::start(move |req| {
            let dir = dir_ref.clone();
            async move {
                if req.path == "/api/session/ses_1" {
                    return session_resp(&dir.lock().unwrap());
                }
                if req.path == "/api/rpc/provider-usage.slow-plugin/read" {
                    tokio::time::sleep(Duration::from_millis(120)).await;
                    return json_resp(StatusCode::NOT_FOUND, json!({ "error": "late 404" }));
                }
                panic!("fallback must not run after quota deadline: {}", req.path);
            }
        })
        .await;
        *dir_holder.lock().unwrap() = h.directory.clone();
        let now = Instant::now();
        let raw = owned_read_with_deadlines(
            &h.app,
            &h.query(None),
            "slow-plugin",
            now + Duration::from_secs(3),
            now + Duration::from_millis(40),
        )
        .await
        .expect("should publish unavailable quota");
        let body: Value = serde_json::from_str(raw.get()).unwrap();
        assert_eq!(body["supported"], true);
        assert_eq!(body["ok"], false);
    }

    // 4. Quota timer expires AFTER a fast 404 (absent RPC) while outer `until` is live -> supported=false (matches TS).
    {
        let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let dir_ref = dir_holder.clone();
        let h = Harness::start(move |req| {
            let dir = dir_ref.clone();
            async move {
                if req.path == "/api/session/ses_1" {
                    return session_resp(&dir.lock().unwrap());
                }
                if req.path == "/api/rpc/provider-usage.absent-then-slow/read" {
                    return json_resp(StatusCode::NOT_FOUND, json!({}));
                }
                if req.path == "/api/provider/absent-then-slow" {
                    tokio::time::sleep(Duration::from_millis(80)).await;
                    return json_resp(StatusCode::NOT_FOUND, json!({ "error": "missing" }));
                }
                panic!("unexpected path: {}", req.path);
            }
        })
        .await;
        *dir_holder.lock().unwrap() = h.directory.clone();
        let now = Instant::now();
        let raw = owned_read_with_deadlines(
            &h.app,
            &h.query(None),
            "absent-then-slow",
            now + Duration::from_secs(3),
            now + Duration::from_millis(40),
        )
        .await
        .expect("outer deadline still live");
        let body: Value = serde_json::from_str(raw.get()).unwrap();
        assert_eq!(body["supported"], false);
        assert_eq!(body["ok"], false);
    }
}

#[tokio::test]
async fn client_disconnect_during_codex_fallback_preserves_shared_read_for_peer() {
    let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let dir_ref = dir_holder.clone();
    let expires = crate::shared::now_ms() + 3_600_000;
    let h = Harness::start(move |req| {
        let dir = dir_ref.clone();
        async move {
            let directory = dir.lock().unwrap().clone();
            match req.path.as_str() {
                "/api/session/ses_1" => session_resp(&directory),
                "/api/rpc/provider-usage.my-openai/read" => json_resp(
                    StatusCode::BAD_REQUEST,
                    json!({ "_tag": "RpcError", "type": "rpc.unavailable", "message": "not registered" }),
                ),
                "/api/provider/my-openai" => json_resp(
                    StatusCode::OK,
                    json!({
                        "location": { "directory": directory },
                        "data": { "id": "my-openai", "integrationID": "openai" }
                    }),
                ),
                "/api/integration/openai" => json_resp(
                    StatusCode::OK,
                    json!({
                        "location": { "directory": directory },
                        "data": {
                            "id": "openai",
                            "connections": [{ "id": "cred_1", "type": "credential", "method": "oauth", "status": { "status": "connected" } }]
                        }
                    }),
                ),
                "/api/credential" => json_resp(
                    StatusCode::OK,
                    json!({
                        "data": [{
                            "id": "cred_1",
                            "active": true,
                            "integrationID": "openai",
                            "value": {
                                "type": "oauth",
                                "methodID": "chatgpt-browser",
                                "access": "synthetic-token",
                                "expires": expires,
                                "metadata": { "accountID": "acct_1" }
                            }
                        }]
                    }),
                ),
                other => panic!("unexpected path: {other}"),
            }
        }
    })
    .await;
    *dir_holder.lock().unwrap() = h.directory.clone();

    let upstream_calls = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    {
        let upstream_calls = upstream_calls.clone();
        let started = started.clone();
        let release = release.clone();
        *h.app.provider_usage.codex_override.lock().unwrap() = Some(Arc::new(move |_key, _account| {
            let upstream_calls = upstream_calls.clone();
            let started = started.clone();
            let release = release.clone();
            Box::pin(async move {
                upstream_calls.fetch_add(1, Ordering::SeqCst);
                started.notify_one();
                release.notified().await;
                let mut windows = Fields::new();
                windows.insert("5h".into(), window(Some(20.0), Some(18_000.0), None, None));
                Ok(Usage::from(windows))
            })
        }));
    }

    let uri = format!("http://{}/api/usage/my-openai?instanceId={}&sessionId=ses_1", h.app_addr, h.workspace_id);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let first_task = tokio::spawn({
        let client = client.clone();
        let uri = uri.clone();
        async move { client.get(&uri).send().await }
    });
    started.notified().await;

    let second_task = tokio::spawn({
        let client = client.clone();
        let uri = uri.clone();
        async move {
            let resp = client.get(&uri).send().await.unwrap();
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap();
            let body: Value = resp.json().await.unwrap();
            (status, body)
        }
    });

    // Wait until the second client has read `/api/credential` and joined the shared Codex flight.
    for _ in 0..200 {
        if h.calls.lock().unwrap().iter().filter(|c| *c == "GET /api/credential").count() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(h.calls.lock().unwrap().iter().filter(|c| *c == "GET /api/credential").count() >= 2);
    tokio::time::sleep(Duration::from_millis(20)).await;

    // Disconnect the first client; the shared upstream Codex read must continue for the second client.
    first_task.abort();
    tokio::time::sleep(Duration::from_millis(30)).await;
    release.notify_one();

    let (status, body) = second_task.await.unwrap();
    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["providerId"], "codex");
    assert_eq!(body["supported"], true);
    assert_eq!(body["ok"], true);
    assert_eq!(body["windows"]["5h"]["usedPercent"].as_f64(), Some(20.0));
    assert_eq!(upstream_calls.load(Ordering::SeqCst), 1, "both clients must share one upstream Codex read");
}

#[tokio::test]
async fn invalid_provider_id_skips_plugin_phase_entirely() {
    let dir_holder: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let dir_ref = dir_holder.clone();
    let h = Harness::start(move |req| {
        let dir = dir_ref.clone();
        async move {
            if req.path == "/api/session/ses_1" {
                return session_resp(&dir.lock().unwrap());
            }
            if req.path == "/api/provider/some..provider" {
                return json_resp(StatusCode::NOT_FOUND, json!({ "error": "missing" }));
            }
            panic!("plugin RPC must not be called for invalid provider id: {}", req.path);
        }
    })
    .await;
    *dir_holder.lock().unwrap() = h.directory.clone();

    let (status, body) = h.get_usage("some..provider", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["supported"], false);
    assert_eq!(h.calls.lock().unwrap().iter().filter(|c| *c == "GET /api/session/ses_1").count(), 2);
}
