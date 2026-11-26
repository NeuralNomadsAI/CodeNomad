use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Extension, Json, Router,
    extract::{Request, State},
    http::{StatusCode as Status, header},
    middleware::from_fn_with_state,
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{images, websearch};
use crate::{App, Shared, Workspace, auth, files, opencode::Native, settings, subagent_depth::jsonc, worktrees::fence};

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

fn parse_jsonc_file(path: &PathBuf) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    let trimmed = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let parsed = jsonc::parse(&jsonc::utf16(trimmed), true).0?;
    serde_json::from_str(&jsonc::string(&jsonc::stringify(&parsed, None))).ok()
}

struct NativeMock {
    global_dir: PathBuf,
    global_file: PathBuf,
    lower_file: PathBuf,
    ancestor_file: PathBuf,
    project_file: PathBuf,
    include_lower: bool,
    include_ancestor: bool,
    stale_global: Option<Value>,
    schema: Value,
    model_status: Status,
    model_reads: usize,
    config_reads: usize,
    /// Optional hook triggered when `/api/model` is called (e.g. close workspace to simulate stale connection).
    on_model: Option<Box<dyn FnMut() + Send>>,
    /// Optional hook triggered on the N-th `/api/config` call (1-based).
    on_config: Option<(usize, Box<dyn FnMut() + Send>)>,
}

fn contract_with(experimental: Value) -> Value {
    json!({
        "components": {
            "schemas": {
                "Config.InfoEncoded": {
                    "properties": {
                        "experimental": {
                            "properties": experimental
                        }
                    }
                }
            }
        }
    })
}

fn both_capabilities() -> Value {
    json!({
        "image_generate": { "anyOf": [] },
        "media_blob": { "type": "boolean" }
    })
}

async fn fake_native(State(mock): State<Arc<Mutex<NativeMock>>>, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let query = req.uri().query().unwrap_or_default().to_owned();
    let mut g = mock.lock().unwrap();

    if path == "/api/config" {
        g.config_reads += 1;
        let read_no = g.config_reads;
        if let Some((target_no, _)) = &g.on_config
            && *target_no == read_no
            && let Some((_, mut hook)) = g.on_config.take()
        {
            hook();
        }
        let mut entries = vec![json!({ "type": "directory", "path": g.global_dir.to_string_lossy() })];
        if g.include_lower
            && let Some(info) = parse_jsonc_file(&g.lower_file)
        {
            entries.push(json!({ "type": "document", "path": g.lower_file.to_string_lossy(), "info": info }));
        }
        if let Some(stale) = g.stale_global.clone() {
            entries.push(json!({ "type": "document", "path": g.global_file.to_string_lossy(), "info": stale }));
        } else if let Some(info) = parse_jsonc_file(&g.global_file) {
            entries.push(json!({ "type": "document", "path": g.global_file.to_string_lossy(), "info": info }));
        }
        if g.include_ancestor
            && let Some(info) = parse_jsonc_file(&g.ancestor_file)
        {
            entries.push(json!({ "type": "document", "path": g.ancestor_file.to_string_lossy(), "info": info }));
        }
        if let Some(info) = parse_jsonc_file(&g.project_file) {
            entries.push(json!({ "type": "document", "path": g.project_file.to_string_lossy(), "info": info }));
        }
        return Json(Value::Array(entries)).into_response();
    }

    if path == "/api/plugin" {
        return Json(json!({ "data": [] })).into_response();
    }

    if path == "/openapi.json" {
        return Json(contract_with(g.schema.clone())).into_response();
    }

    if path == "/api/model" {
        g.model_reads += 1;
        if let Some(mut hook) = g.on_model.take() {
            hook();
        }
        let params: Vec<(String, String)> = reqwest::Url::parse(&format!("http://127.0.0.1/?{query}"))
            .ok()
            .map(|u| u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect())
            .unwrap_or_default();
        assert!(params.iter().any(|(k, v)| k == "types" && v == "image"));
        if g.model_status != Status::OK {
            return (g.model_status, "unavailable").into_response();
        }
        return Json(json!({
            "data": [
                { "providerID": "openai", "id": "gpt-image-2", "name": "GPT Image 2" },
                { "providerID": "google", "id": "imagen" },
                { "bad": true }
            ]
        }))
        .into_response();
    }

    (Status::NOT_FOUND, Json(json!({ "error": "unexpected native path", "path": path }))).into_response()
}

fn encode_q(raw: &str) -> String {
    percent_encoding::utf8_percent_encode(raw, percent_encoding::NON_ALPHANUMERIC).to_string()
}

struct Harness {
    _dir: TempDir,
    global_file: PathBuf,
    lower_file: PathBuf,
    ancestor_file: PathBuf,
    project_dir: PathBuf,
    project_file: PathBuf,
    workspace_id: String,
    app: Shared,
    mock: Arc<Mutex<NativeMock>>,
    native_addr: SocketAddr,
    server_addr: SocketAddr,
    base: String,
    client: reqwest::Client,
    native_task: tokio::task::JoinHandle<()>,
    server_task: tokio::task::JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server_task.abort();
        self.native_task.abort();
    }
}

impl Harness {
    async fn new(with_auth: bool) -> Self {
        let dir = TempDir::new("cn-opencode-settings");
        let root = dir.0.clone();
        let data = root.join("data");
        let global_dir = root.join("global");
        let project_dir = root.join("project");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&global_dir).unwrap();
        fs::create_dir_all(&project_dir).unwrap();

        let global_file = global_dir.join("opencode.jsonc");
        let lower_file = global_dir.join("opencode.json");
        let ancestor_file = root.join("opencode.json");
        let project_file = project_dir.join("opencode.jsonc");

        let mock = Arc::new(Mutex::new(NativeMock {
            global_dir: global_dir.clone(),
            global_file: global_file.clone(),
            lower_file: lower_file.clone(),
            ancestor_file: ancestor_file.clone(),
            project_file: project_file.clone(),
            include_lower: false,
            include_ancestor: false,
            stale_global: None,
            schema: both_capabilities(),
            model_status: Status::OK,
            model_reads: 0,
            config_reads: 0,
            on_model: None,
            on_config: None,
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
            temporary: None,
        });

        let router = if with_auth {
            super::routes().layer(from_fn_with_state(app.clone(), auth::admit)).with_state(app.clone())
        } else {
            super::routes().with_state(app.clone())
        };
        let server_task = tokio::spawn(async move {
            axum::serve(server_listener, router).await.unwrap();
        });

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        Self {
            _dir: dir,
            global_file,
            lower_file,
            ancestor_file,
            project_dir,
            project_file,
            workspace_id,
            app,
            mock,
            native_addr,
            server_addr,
            base: format!("http://{server_addr}"),
            client,
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

    fn project_str(&self) -> String {
        self.project_dir.to_string_lossy().into_owned()
    }
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

#[test]
fn pure_contracts_match_typescript_capabilities_selection_and_validation() {
    assert_eq!(
        images::capability(&contract_with(both_capabilities())),
        images::Capability { generation: true, media_storage: true }
    );
    assert_eq!(
        images::capability(&contract_with(json!({ "media_blob": { "type": "boolean" } }))),
        images::Capability { generation: false, media_storage: true }
    );
    assert_eq!(images::capability(&json!({})), images::Capability { generation: false, media_storage: false });

    assert_eq!(images::generation_selection_json(Some(&json!(false))), json!(false));
    for v in [None, Some(json!(true)), Some(json!(null)), Some(json!("x")), Some(json!([])), Some(json!(1))] {
        assert_eq!(images::generation_selection_json(v.as_ref()), json!(true));
    }
    assert_eq!(images::generation_selection_json(Some(&json!({}))), json!(true));
    assert_eq!(
        images::generation_selection_json(Some(&json!({ "model": "openai/gpt-image-2" }))),
        json!("openai/gpt-image-2")
    );
    assert_eq!(
        images::generation_selection_json(Some(&json!({
            "model": { "providerID": "google", "model": "imagen", "variant": "hd" }
        }))),
        json!("google/imagen#hd")
    );
    assert_eq!(images::generation_selection_json(Some(&json!({ "model": "not a ref" }))), json!(true));

    assert!(images::is_image_model_ref("openai/gpt-image-2"));
    assert!(images::is_image_model_ref("google/imagen#hd"));
    assert!(images::is_image_model_ref("a/b/c#v1"));
    for bad in ["no-slash", "/model", "prov/", "a#b/c", "a/b#", "a/#v", "a/b#c#d"] {
        assert!(!images::is_image_model_ref(bad), "should reject {bad}");
    }

    // UTF-16 length boundaries: 128 astral chars = 256 UTF-16 units (ok), 129 = 258 (rejected).
    let astral_256 = "😀".repeat(128);
    let astral_258 = "😀".repeat(129);
    assert!(
        websearch::parse_mutation(&json!({
            "location": { "directory": "/owned" },
            "scope": "global",
            "provider": astral_256
        }))
        .is_some()
    );
    assert!(
        websearch::parse_mutation(&json!({
            "location": { "directory": "/owned" },
            "scope": "global",
            "provider": astral_258
        }))
        .is_none()
    );
    for bad_provider in [json!(""), json!("a\0b"), json!("a\nb"), json!("a\x7fb"), json!(true), json!(123)] {
        assert!(
            websearch::parse_mutation(&json!({
                "location": { "directory": "/owned" },
                "scope": "global",
                "provider": bad_provider
            }))
            .is_none(),
            "should reject provider {bad_provider}"
        );
    }

    assert_eq!(super::query_directory(Some("directory=%20C%3A%5Cx%20")), Some("C:\\x".into()));
    for bad in [
        None,
        Some(""),
        Some("directory="),
        Some("directory=%20"),
        Some("directory=a&directory=b"),
        Some("directory=a&x=1"),
    ] {
        assert_eq!(super::query_directory(bad), None, "{bad:?}");
    }
}

#[tokio::test]
async fn websearch_settings_preserves_jsonc_enforces_scopes_fences_and_fastify_parity() {
    let h = Harness::new(false).await;
    fs::write(
        &h.global_file,
        "{\n  // keep me\n  \"websearch\": {\"provider\":\"alpha\", \"future\":42},\n  \"plugins\":[], \"shell\":\"foreign-shell\"\n}\n",
    )
    .unwrap();
    fs::write(&h.project_file, "{\"websearch\":false, \"mcp\":{\"servers\":{\"foreign\":{\"codemode\":false}}}}")
        .unwrap();

    let project = h.project_str();
    let get_url = format!("{}?directory={}", h.url("/websearch-settings"), encode_q(&project));

    // 1. Read reflects effective (false from project) and per-scope selections.
    let resp = h.client.get(&get_url).send().await.unwrap();
    assert_eq!(resp.status(), Status::OK);
    let snap: Value = resp.json().await.unwrap();
    assert_eq!(snap["effective"], json!(false));
    assert_eq!(snap["scopes"].as_array().unwrap().len(), 2);
    assert_eq!(snap["scopes"][0]["scope"], "global");
    assert_eq!(snap["scopes"][0]["selection"], "alpha");
    assert_eq!(snap["scopes"][1]["scope"], "project");
    assert_eq!(snap["scopes"][1]["selection"], false);

    // 2. Updating global provider keeps comments, sibling `future: 42`, foreign `shell`, and leaves project untouched.
    let put_global = h
        .client
        .put(h.url("/websearch-settings"))
        .json(&json!({ "location": { "directory": project }, "scope": "global", "provider": "beta" }))
        .send()
        .await
        .unwrap();
    assert_eq!(put_global.status(), Status::NO_CONTENT);
    let updated_global = fs::read_to_string(&h.global_file).unwrap();
    assert!(updated_global.contains("// keep me"));
    let parsed_global = parse_jsonc_file(&h.global_file).unwrap();
    assert_eq!(parsed_global["websearch"], json!({ "provider": "beta", "future": 42 }));
    assert_eq!(parsed_global["shell"], "foreign-shell");
    assert_eq!(parse_jsonc_file(&h.project_file).unwrap()["websearch"], false);

    // 3. Resetting project to `null` removes the key so global ("beta") becomes effective while keeping foreign keys.
    let reset_project = h
        .client
        .put(h.url("/websearch-settings"))
        .json(&json!({ "location": { "directory": project }, "scope": "project", "provider": null }))
        .send()
        .await
        .unwrap();
    assert_eq!(reset_project.status(), Status::NO_CONTENT);
    let after_reset: Value = h.client.get(&get_url).send().await.unwrap().json().await.unwrap();
    assert_eq!(after_reset["effective"], "beta");
    assert_eq!(parse_jsonc_file(&h.project_file).unwrap()["mcp"]["servers"]["foreign"]["codemode"], false);

    // 4. Concurrent writes on the same scope serialize cleanly without conflict.
    let (r1, r2) = tokio::join!(
        h.client
            .put(h.url("/websearch-settings"))
            .json(&json!({ "location": { "directory": project }, "scope": "project", "provider": "random" }))
            .send(),
        h.client
            .put(h.url("/websearch-settings"))
            .json(&json!({ "location": { "directory": project }, "scope": "project", "provider": false }))
            .send(),
    );
    assert_eq!(r1.unwrap().status(), Status::NO_CONTENT);
    assert_eq!(r2.unwrap().status(), Status::NO_CONTENT);

    // 5. BOM + CRLF + tab indentation preserved across edits.
    fs::write(&h.project_file, "\u{feff}{\r\n\t\"websearch\":false,\r\n\t\"shell\":\"keep\"\r\n}\r\n").unwrap();
    let bom_resp = h
        .client
        .put(h.url("/websearch-settings"))
        .json(&json!({ "location": { "directory": project }, "scope": "project", "provider": "random" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bom_resp.status(), Status::NO_CONTENT);
    let bom_text = fs::read_to_string(&h.project_file).unwrap();
    assert!(bom_text.starts_with('\u{feff}'));
    assert!(bom_text.contains("\r\n\t"));
    assert_eq!(parse_jsonc_file(&h.project_file).unwrap()["shell"], "keep");

    // 6. Duplicate keys fail closed with 422 on PUT and generic 503 on GET.
    fs::write(&h.project_file, "{\"websearch\":false,\"websearch\":{\"provider\":\"alpha\"}}").unwrap();
    let dup_put = h
        .client
        .put(h.url("/websearch-settings"))
        .json(&json!({ "location": { "directory": project }, "scope": "project", "provider": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(dup_put.status(), Status::UNPROCESSABLE_ENTITY);
    let dup_get = h.client.get(&get_url).send().await.unwrap();
    assert_eq!(dup_get.status(), Status::SERVICE_UNAVAILABLE);
    fs::write(&h.project_file, "{}").unwrap();

    // 7. Unknown workspace -> 404; foreign directory -> 403; active worktree deletion fence -> 409.
    let missing = h
        .client
        .get(format!("{}/api/workspaces/unknown/websearch-settings?directory={}", h.base, encode_q(&project)))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), Status::NOT_FOUND);

    let foreign_dir = h._dir.0.join("foreign");
    fs::create_dir_all(&foreign_dir).unwrap();
    let foreign_resp = h
        .client
        .put(h.url("/websearch-settings"))
        .json(
            &json!({ "location": { "directory": foreign_dir.to_string_lossy() }, "scope": "global", "provider": null }),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_resp.status(), Status::FORBIDDEN);

    let ws_fence = fence::identity(&h.project_dir);
    let _blocked = fence::block(&[ws_fence]).await.unwrap();
    let fenced = h
        .client
        .put(h.url("/websearch-settings"))
        .json(&json!({ "location": { "directory": project }, "scope": "project", "provider": null }))
        .send()
        .await
        .unwrap();
    assert_eq!(fenced.status(), Status::CONFLICT);
    assert_eq!(fenced.json::<Value>().await.unwrap(), json!({ "error": "Worktree deletion is in progress" }));
    drop(_blocked);

    // 8. Validation rejections (400) & Fastify HTTP parity (400 empty/invalid JSON, 415, 413 Connection: close, 404 POST).
    for bad in [
        json!({ "provider": false }),
        json!({ "location": { "directory": project, "workspaceID": "legacy" }, "scope": "project", "provider": false }),
        json!({ "location": { "directory": project }, "scope": "global", "provider": "alpha", "path": "/arbitrary" }),
    ] {
        let r = h.client.put(h.url("/websearch-settings")).json(&bad).send().await.unwrap();
        assert_eq!(r.status(), Status::BAD_REQUEST);
        assert!(r.headers().get(header::CONNECTION).is_none(), "route validation 400 must not force Connection: close");
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "error": "Invalid web search settings request" }));
    }

    let empty_json = h
        .client
        .put(h.url("/websearch-settings"))
        .header(header::CONTENT_TYPE, "application/json")
        .body("")
        .send()
        .await
        .unwrap();
    assert_eq!(empty_json.status(), Status::BAD_REQUEST);
    assert_eq!(
        empty_json.headers().get(header::CONNECTION).and_then(|v| v.to_str().ok()),
        Some("close"),
        "Fastify JSON parser 400 must set Connection: close"
    );
    assert_eq!(empty_json.json::<Value>().await.unwrap()["code"], "FST_ERR_CTP_EMPTY_JSON_BODY");

    // Subfolder inside a non-Git workspace root is owned when Git is installed (TS native-worktrees.ts:66).
    let sub_dir = h.project_dir.join("sub");
    fs::create_dir_all(&sub_dir).unwrap();
    let sub_str = sub_dir.to_string_lossy().into_owned();
    let sub_get = h
        .client
        .get(format!("{}?directory={}", h.url("/websearch-settings"), encode_q(&sub_str)))
        .send()
        .await
        .unwrap();
    assert_eq!(sub_get.status(), Status::OK);
    let sub_put = h
        .client
        .put(h.url("/websearch-settings"))
        .json(&json!({ "location": { "directory": sub_str }, "scope": "project", "provider": "exa" }))
        .send()
        .await
        .unwrap();
    assert_eq!(sub_put.status(), Status::NO_CONTENT);
    assert_eq!(
        parse_jsonc_file(&sub_dir.join(".opencode").join("opencode.jsonc")).unwrap()["websearch"],
        json!({ "provider": "exa" })
    );

    let bad_ct = h
        .client
        .put(h.url("/websearch-settings"))
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(bad_ct.status(), Status::UNSUPPORTED_MEDIA_TYPE);
    assert!(bad_ct.headers().get(header::CONNECTION).is_none(), "415 must not force Connection: close");

    // Without Content-Type, Content-Length: 00 is not literally "0" and must return 415 like Fastify 5.
    let zero_zero_no_ct = send_raw_http(
        h.server_addr,
        &format!(
            "PUT {} HTTP/1.1\r\nHost: {}\r\nContent-Length: 00\r\nConnection: close\r\n\r\n",
            h.path("/websearch-settings"),
            h.server_addr
        ),
        false,
    )
    .await;
    assert!(zero_zero_no_ct.starts_with("HTTP/1.1 415 "), "got: {zero_zero_no_ct}");
    assert!(zero_zero_no_ct.contains("FST_ERR_CTP_INVALID_MEDIA_TYPE"), "got: {zero_zero_no_ct}");

    // Unsupported Content-Type with Content-Length > 1 MiB must return 415 immediately (not 413).
    let bad_ct_large = send_raw_http(
        h.server_addr,
        &format!(
            "PUT {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
            h.path("/websearch-settings"),
            h.server_addr,
            1024 * 1024 + 16
        ),
        false,
    )
    .await;
    assert!(bad_ct_large.starts_with("HTTP/1.1 415 "), "got: {bad_ct_large}");

    // Chunked PUT without Content-Type must return 415 immediately without waiting for the terminal chunk.
    let chunked_no_ct = send_raw_http(
        h.server_addr,
        &format!(
            "PUT {} HTTP/1.1\r\nHost: {}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            h.path("/websearch-settings"),
            h.server_addr
        ),
        false,
    )
    .await;
    assert!(chunked_no_ct.starts_with("HTTP/1.1 415 "), "got: {chunked_no_ct}");

    // Truncated body stream (premature EOF) returns empty transport 400 with Connection: close.
    let truncated = send_raw_http(
        h.server_addr,
        &format!(
            "PUT {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{{\"a\":",
            h.path("/websearch-settings"),
            h.server_addr
        ),
        true,
    )
    .await;
    assert!(truncated.starts_with("HTTP/1.1 400 "), "got: {truncated}");
    assert!(truncated.to_ascii_lowercase().contains("\r\nconnection: close\r\n"), "got: {truncated}");
    let (_, truncated_body) = truncated.split_once("\r\n\r\n").unwrap();
    assert!(truncated_body.is_empty(), "truncated EOF 400 body must be empty, got: {truncated}");

    let oversized = send_raw_http(
        h.server_addr,
        &format!(
            "PUT {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            h.path("/websearch-settings"),
            h.server_addr,
            1024 * 1024 + 16
        ),
        false,
    )
    .await;
    assert!(oversized.starts_with("HTTP/1.1 413 "), "got: {oversized}");
    assert!(oversized.to_ascii_lowercase().contains("\r\nconnection: close\r\n"), "got: {oversized}");
    assert!(oversized.contains("FST_ERR_CTP_BODY_TOO_LARGE"), "got: {oversized}");

    let post_404 = h.client.post(h.url("/websearch-settings")).send().await.unwrap();
    assert_eq!(post_404.status(), Status::NOT_FOUND);
    assert_eq!(post_404.json::<Value>().await.unwrap(), json!({ "message": "Not Found" }));

    // 9. Cached NonGit root replaced by a link/junction to another folder under app.scope must be refused.
    let redirected_target = h._dir.0.join("redirected_target");
    fs::create_dir_all(&redirected_target).unwrap();
    fs::remove_dir_all(&h.project_dir).unwrap();
    #[cfg(windows)]
    {
        let out = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&h.project_dir)
            .arg(&redirected_target)
            .output()
            .unwrap();
        assert!(out.status.success(), "mklink /J failed: {:?}", out);
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&redirected_target, &h.project_dir).unwrap();
    }
    let missing_sub = redirected_target.join("missing_sub");
    let redirected_put = h
        .client
        .put(h.url("/websearch-settings"))
        .json(&json!({
            "location": { "directory": missing_sub.to_string_lossy() },
            "scope": "project",
            "provider": "exa"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(redirected_put.status(), Status::FORBIDDEN);
    assert!(!missing_sub.exists(), "redirected NonGit root must never admit external writes");
}

#[tokio::test]
async fn image_settings_edits_jsonc_handles_overrides_masking_retarget_and_catalog_fences() {
    let h = Harness::new(false).await;
    fs::write(
        &h.global_file,
        "{\n  // preserved\n  \"experimental\": { \"subagent_depth\": 2 },\n  \"shell\": \"keep\"\n}\n",
    )
    .unwrap();
    fs::write(&h.project_file, "{}").unwrap();

    let project = h.project_str();
    let get_url = format!("{}?directory={}", h.url("/image-settings"), encode_q(&project));
    let put_url = h.url("/image-settings");

    // 1. Initial read with both capabilities and image models.
    let snap: Value = h.client.get(&get_url).send().await.unwrap().json().await.unwrap();
    assert_eq!(
        snap["generation"],
        json!({
            "global": true,
            "effective": true,
            "models": [
                { "ref": "openai/gpt-image-2", "name": "GPT Image 2" },
                { "ref": "google/imagen", "name": "imagen" }
            ]
        })
    );
    assert_eq!(snap["mediaStorage"], json!({ "global": false, "effective": false }));
    assert!(snap.get("blockedBy").is_none());

    // 2. Edit generation and mediaStorage in Global while preserving comments and sibling keys.
    assert_eq!(
        h.client
            .put(&put_url)
            .json(&json!({ "location": { "directory": project }, "generation": "openai/gpt-image-2" }))
            .send()
            .await
            .unwrap()
            .status(),
        Status::NO_CONTENT
    );
    assert_eq!(
        h.client
            .put(&put_url)
            .json(&json!({ "location": { "directory": project }, "mediaStorage": true }))
            .send()
            .await
            .unwrap()
            .status(),
        Status::NO_CONTENT
    );
    let saved_global = fs::read_to_string(&h.global_file).unwrap();
    assert!(saved_global.contains("// preserved"));
    assert_eq!(
        parse_jsonc_file(&h.global_file).unwrap(),
        json!({
            "experimental": {
                "subagent_depth": 2,
                "image_generate": { "model": "openai/gpt-image-2" },
                "media_blob": true
            },
            "shell": "keep"
        })
    );

    // 3. Project `experimental` block hides global mediaStorage (but not per-field generation);
    //    saving mediaStorage writes both Global and Project, while generation never touches Project.
    fs::write(&h.project_file, "{\n  // project comment\n  \"experimental\": { \"subagent_depth\": 1 }\n}\n").unwrap();
    let snap: Value = h.client.get(&get_url).send().await.unwrap().json().await.unwrap();
    assert_eq!(snap["generation"]["effective"], "openai/gpt-image-2");
    assert!(snap["generation"].get("override").is_none());
    assert_eq!(
        snap["mediaStorage"],
        json!({ "global": true, "effective": false, "project": { "path": h.project_file.to_string_lossy() } })
    );

    assert_eq!(
        h.client
            .put(&put_url)
            .json(&json!({ "location": { "directory": project }, "mediaStorage": true }))
            .send()
            .await
            .unwrap()
            .status(),
        Status::NO_CONTENT
    );
    let project_saved = fs::read_to_string(&h.project_file).unwrap();
    assert!(project_saved.contains("// project comment"));
    assert_eq!(
        parse_jsonc_file(&h.project_file).unwrap()["experimental"],
        json!({ "subagent_depth": 1, "media_blob": true })
    );

    assert_eq!(
        h.client
            .put(&put_url)
            .json(&json!({ "location": { "directory": project }, "generation": "openai/gpt-image-2" }))
            .send()
            .await
            .unwrap()
            .status(),
        Status::NO_CONTENT
    );
    assert_eq!(fs::read_to_string(&h.project_file).unwrap(), project_saved);

    // 4. Project block removed between acquisition and project edit -> 409 conflict, never recreated.
    {
        let mut g = h.mock.lock().unwrap();
        g.config_reads = 0;
        let project_file_clone = h.project_file.clone();
        // 1st config read = context(), 2nd = Global edit, 3rd = Project edit.
        g.on_config = Some((
            3,
            Box::new(move || {
                fs::write(&project_file_clone, "{}").unwrap();
            }),
        ));
    }
    let removed_block = h
        .client
        .put(&put_url)
        .json(&json!({ "location": { "directory": project }, "mediaStorage": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(removed_block.status(), Status::CONFLICT);
    assert_eq!(fs::read_to_string(&h.project_file).unwrap(), "{}");

    // 5. Ancestor override reported on both generation and mediaStorage.
    fs::write(&h.ancestor_file, "{ \"experimental\": { \"image_generate\": false } }").unwrap();
    h.mock.lock().unwrap().include_ancestor = true;
    let snap: Value = h.client.get(&get_url).send().await.unwrap().json().await.unwrap();
    assert_eq!(snap["generation"]["effective"], false);
    assert_eq!(snap["generation"]["override"], json!({ "path": h.ancestor_file.to_string_lossy() }));
    assert_eq!(
        snap["mediaStorage"],
        json!({ "global": false, "effective": false, "override": { "path": h.ancestor_file.to_string_lossy() } })
    );
    h.mock.lock().unwrap().include_ancestor = false;
    let _ = fs::remove_file(&h.ancestor_file);

    // 6. Failed model catalog leaves both choices readable with `models: null`.
    h.mock.lock().unwrap().model_status = Status::SERVICE_UNAVAILABLE;
    let snap: Value = h.client.get(&get_url).send().await.unwrap().json().await.unwrap();
    assert_eq!(snap["generation"]["models"], Value::Null);
    assert_eq!(snap["generation"]["global"], "openai/gpt-image-2");
    h.mock.lock().unwrap().model_status = Status::OK;

    // 7. Lower-priority `experimental` object makes Global write fail with 409 `blockedBy`,
    //    even with a project block or stale native Global entry.
    fs::write(&h.global_file, "{ \"shell\": \"keep\" }").unwrap();
    fs::write(&h.lower_file, "{ \"experimental\": { \"subagent_depth\": 7, \"todo\": true } }").unwrap();
    h.mock.lock().unwrap().include_lower = true;
    let snap: Value = h.client.get(&get_url).send().await.unwrap().json().await.unwrap();
    assert_eq!(snap["blockedBy"], json!({ "path": h.lower_file.to_string_lossy() }));

    fs::write(&h.project_file, "{ \"experimental\": { \"subagent_depth\": 1 } }").unwrap();
    h.mock.lock().unwrap().stale_global = Some(json!({ "experimental": { "subagent_depth": 3 } }));
    for payload in [
        json!({ "location": { "directory": project }, "generation": true }),
        json!({ "location": { "directory": project }, "mediaStorage": true }),
    ] {
        let r = h.client.put(&put_url).json(&payload).send().await.unwrap();
        assert_eq!(r.status(), Status::CONFLICT);
        assert!(r.json::<Value>().await.unwrap()["error"].as_str().unwrap().contains("hide inherited experimental"));
    }
    assert_eq!(fs::read_to_string(&h.global_file).unwrap(), "{ \"shell\": \"keep\" }");
    assert_eq!(fs::read_to_string(&h.project_file).unwrap(), "{ \"experimental\": { \"subagent_depth\": 1 } }");
    h.mock.lock().unwrap().stale_global = None;
    fs::write(&h.project_file, "{}").unwrap();

    // 8. Retarget race: opencode.json acquired, then another writer creates opencode.jsonc before edit -> 409.
    fs::remove_file(&h.global_file).unwrap();
    {
        let mut g = h.mock.lock().unwrap();
        g.config_reads = 0;
        let global_file_clone = h.global_file.clone();
        g.on_config = Some((
            2,
            Box::new(move || {
                fs::write(&global_file_clone, "{}").unwrap();
            }),
        ));
    }
    let retarget = h
        .client
        .put(&put_url)
        .json(&json!({ "location": { "directory": project }, "mediaStorage": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(retarget.status(), Status::CONFLICT);
    assert_eq!(fs::read_to_string(&h.global_file).unwrap(), "{}");
    h.mock.lock().unwrap().include_lower = false;
    let _ = fs::remove_file(&h.lower_file);

    // 9. Missing capabilities in OpenAPI contract: null groups, 0 model reads, PUT -> 503.
    h.mock.lock().unwrap().schema = json!({});
    let reads_before = h.mock.lock().unwrap().model_reads;
    let snap: Value = h.client.get(&get_url).send().await.unwrap().json().await.unwrap();
    assert_eq!(snap["generation"], Value::Null);
    assert_eq!(snap["mediaStorage"], Value::Null);
    assert_eq!(h.mock.lock().unwrap().model_reads, reads_before);
    let no_cap = h
        .client
        .put(&put_url)
        .json(&json!({ "location": { "directory": project }, "generation": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(no_cap.status(), Status::SERVICE_UNAVAILABLE);
    h.mock.lock().unwrap().schema = both_capabilities();

    // 10. Strict mutation schema rejects combined fields, scope, bad model refs, control chars.
    for bad in [
        json!({ "location": { "directory": project }, "generation": true, "mediaStorage": true }),
        json!({ "location": { "directory": project }, "scope": "project", "mediaStorage": true }),
        json!({ "location": { "directory": project }, "generation": "bad" }),
        json!({ "location": { "directory": project }, "generation": "a/b\u{0000}" }),
        json!({ "location": { "directory": project } }),
    ] {
        let r = h.client.put(&put_url).json(&bad).send().await.unwrap();
        assert_eq!(r.status(), Status::BAD_REQUEST, "expected 400 for {bad}");
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "error": "Invalid image settings request" }));
    }

    // 11. Project target retargeted to a file with duplicate `experimental` keys must return 409 (not 422).
    fs::write(&h.global_file, "{ \"experimental\": { \"subagent_depth\": 2 } }").unwrap();
    let project_json = h.project_dir.join("opencode.json");
    fs::remove_file(&h.project_file).unwrap();
    fs::write(&project_json, "{ \"experimental\": { \"subagent_depth\": 1 } }").unwrap();
    {
        let mut g = h.mock.lock().unwrap();
        g.project_file = project_json.clone();
        g.config_reads = 0;
        let project_jsonc = h.project_file.clone();
        // 1st config read = context(), 2nd = Global edit, 3rd = Project edit.
        g.on_config = Some((
            3,
            Box::new(move || {
                fs::write(&project_jsonc, "{ \"experimental\": {}, \"experimental\": {} }").unwrap();
            }),
        ));
    }
    let project_retarget = h
        .client
        .put(&put_url)
        .json(&json!({ "location": { "directory": project }, "mediaStorage": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        project_retarget.status(),
        Status::CONFLICT,
        "retargeted project file must return 409 before reading keys"
    );
    let _ = fs::remove_file(&project_json);
    fs::write(&h.project_file, "{}").unwrap();
    h.mock.lock().unwrap().project_file = h.project_file.clone();

    // 12. Connection invalidation or replacement AFTER `fs::prepare` aborts `commit_checked`
    // before `std::fs::rename`, leaves the target file intact, and cleans up the temp file.
    let before_replace = fs::read_to_string(&h.global_file).unwrap();
    let workspace_snap = h.app.workspace(&h.workspace_id).unwrap();
    let live_endpoint = h.app.native.endpoint().unwrap();
    let loaded_doc = crate::subagent_depth::fs::load(&h.global_file.to_string_lossy()).unwrap();
    let prepared_inv =
        crate::subagent_depth::fs::prepare(&loaded_doc, &jsonc::utf16("{\"invalidated\":true}\n")).unwrap();
    h.app.native.invalidate_test_endpoint(&live_endpoint);
    let inv_err = prepared_inv
        .commit_checked(super::mapped, || super::guard_current(&h.app, &live_endpoint, None, &workspace_snap, None));
    assert_eq!(inv_err, Err(super::fail(Status::SERVICE_UNAVAILABLE, "OpenCode service connection changed")));
    assert_eq!(fs::read_to_string(&h.global_file).unwrap(), before_replace);

    h.app.native.replace_test_endpoint(h.native_addr);
    let second_endpoint = h.app.native.endpoint().unwrap();
    let loaded_doc2 = crate::subagent_depth::fs::load(&h.global_file.to_string_lossy()).unwrap();
    let prepared_rep =
        crate::subagent_depth::fs::prepare(&loaded_doc2, &jsonc::utf16("{\"replaced\":true}\n")).unwrap();
    h.app.native.replace_test_endpoint(h.native_addr);
    let rep_err = prepared_rep
        .commit_checked(super::mapped, || super::guard_current(&h.app, &second_endpoint, None, &workspace_snap, None));
    assert_eq!(rep_err, Err(super::fail(Status::SERVICE_UNAVAILABLE, "OpenCode service connection changed")));
    assert_eq!(fs::read_to_string(&h.global_file).unwrap(), before_replace);
    let leftover_tmps: Vec<_> = fs::read_dir(h.global_file.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftover_tmps.is_empty(), "aborted commit_checked must remove temp files: {leftover_tmps:?}");

    // 13. Endpoint replaced while model catalog fails still fences the entire read with 503.
    {
        let app_clone = h.app.clone();
        let addr = h.native_addr;
        let mut g = h.mock.lock().unwrap();
        g.model_status = Status::SERVICE_UNAVAILABLE;
        g.on_model = Some(Box::new(move || {
            app_clone.native.replace_test_endpoint(addr);
        }));
    }
    let fenced_read = h.client.get(&get_url).send().await.unwrap();
    assert_eq!(fenced_read.status(), Status::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn remote_control_origin_csrf_method_and_local_auth_guards() {
    let h = Harness::new(true).await;
    fs::write(&h.global_file, "{}").unwrap();
    fs::write(&h.project_file, "{}").unwrap();
    let project = h.project_str();

    // 1. Local unauthenticated GET/PUT -> 401.
    for suffix in ["/websearch-settings", "/image-settings"] {
        let r = h.client.get(format!("{}?directory={}", h.url(suffix), encode_q(&project))).send().await.unwrap();
        assert_eq!(r.status(), Status::UNAUTHORIZED);
    }

    // 2. Pair a browser device over direct HTTPS and exercise `auth::remote::admit`.
    let origin = "https://192.168.1.30:4443";
    let host = "192.168.1.30:4443";
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
    let remote_router = super::routes()
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

    // 3. Admitted GET + PUT on both routes with matching Origin and paired cookie.
    let ws_get = h
        .client
        .get(format!("{}?directory={}", remote_url("/websearch-settings"), encode_q(&project)))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(ws_get.status(), Status::OK);

    let ws_put = h
        .client
        .put(remote_url("/websearch-settings"))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .json(&json!({ "location": { "directory": project }, "scope": "project", "provider": "exa" }))
        .send()
        .await
        .unwrap();
    assert_eq!(ws_put.status(), Status::NO_CONTENT);

    let img_get = h
        .client
        .get(format!("{}?directory={}", remote_url("/image-settings"), encode_q(&project)))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(img_get.status(), Status::OK);

    let img_put = h
        .client
        .put(remote_url("/image-settings"))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .json(&json!({ "location": { "directory": project }, "mediaStorage": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(img_put.status(), Status::NO_CONTENT);

    // 4. Missing or foreign Origin on PUT -> 403 CSRF rejection.
    for (suffix, body) in [
        ("/websearch-settings", json!({ "location": { "directory": project }, "scope": "project", "provider": null })),
        ("/image-settings", json!({ "location": { "directory": project }, "mediaStorage": false })),
    ] {
        for bad_origin in [None, Some("https://evil.example")] {
            let mut req =
                h.client.put(remote_url(suffix)).header(header::HOST, host).header(header::COOKIE, &cookie).json(&body);
            if let Some(o) = bad_origin {
                req = req.header(header::ORIGIN, o);
            }
            let r = req.send().await.unwrap();
            assert_eq!(r.status(), Status::FORBIDDEN);
        }
    }

    // 5. Unsupported HTTP methods (POST/DELETE) -> 404 from remote catalog.
    for suffix in ["/websearch-settings", "/image-settings"] {
        let post_r = h
            .client
            .post(remote_url(suffix))
            .header(header::HOST, host)
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(post_r.status(), Status::NOT_FOUND);
        let del_r = h
            .client
            .delete(remote_url(suffix))
            .header(header::HOST, host)
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(del_r.status(), Status::NOT_FOUND);
    }

    // 6. Unpaired remote GET -> 401.
    let unauth = h
        .client
        .get(format!("{}?directory={}", remote_url("/image-settings"), encode_q(&project)))
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), Status::UNAUTHORIZED);

    remote_task.abort();
}

#[test]
fn meta_declares_websearch_and_image_settings_capabilities() {
    let dir = TempDir::new("cn-meta-caps");
    let doc = crate::meta::document(Some(Uuid::new_v4()), 3000, &dir.0, None, json!({})).unwrap();
    let caps: Vec<&str> = doc["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(caps.contains(&"websearch-settings"));
    assert!(caps.contains(&"image-settings"));
}
