use std::{
    collections::{BTreeMap, HashMap},
    fs,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode as Status, header},
    middleware::{Next, from_fn, from_fn_with_state},
    response::{IntoResponse, Response},
    routing::any,
};
use reqwest::Client;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    App, Shared, Workspace,
    auth::{self, devices, remote, tls},
    files,
    opencode::Native,
    plugin_controls::{
        catalog::{
            CatalogAvailability, IntegrationCatalog, IntegrationCatalogApp, IntegrationCatalogEntry,
            IntegrationCatalogSources,
        },
        snapshot::{ConfigScope, ControlLocation},
    },
    settings,
};

use super::{
    attachments::{self, AttachmentError, HostPolicy},
    contract::{
        BindingReadOutput, INTEGRATION_ATTACHMENT_METADATA_KEY, is_integration_docs_url, looks_like_path,
        parse_binding_read_output, parse_hosts_output, parse_install_host_output, parse_status_output,
    },
    reader,
    recognition::recognize_integrations,
};

const SECRET: &str = "SECRET_SENTINEL_TOKEN_SCRIPT_BINDING_PORT";
const GIT_PREFIX: &str = "github:NeuralNomadsAI/opencode-integrations#";

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn entry(id: &str, family: &str) -> IntegrationCatalogEntry {
    IntegrationCatalogEntry {
        id: id.into(),
        family: family.into(),
        package: format!("@neuralnomads/opencode-{id}"),
        range: "^0.1".into(),
        display_name: format!("OpenCode for {id}"),
        plugin: format!("neuralnomads.{id}"),
        rpc: format!("neuralnomads.{id}"),
        summary: BTreeMap::from([("en".into(), format!("{id} summary"))]),
        app: IntegrationCatalogApp { name: id.into(), versions: Some(">=4.2".into()) },
        docs: format!("https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/{id}"),
        status: "preview".into(),
        sources: Some(IntegrationCatalogSources { git: vec![GIT_PREFIX.into()] }),
    }
}

fn ok_status(id: &str, family: &str) -> Value {
    json!({
        "contract": 1,
        "integration": { "id": id, "version": "0.1.0", "family": family, "spec": 0 },
        "host": { "state": "ok" },
        "connection": { "state": "available", "offers": 1, "attachedSessions": 2 },
        "extraSecret": SECRET
    })
}

fn ok_offer() -> Value {
    json!({
        "offerID": "offer_fixture",
        "label": "Blender window",
        "document": "Scene.blend",
        "appVersion": "5.2.0",
        "protocol": "ok",
        "token": SECRET,
        "port": 9999,
        "script_handle": SECRET
    })
}

fn binding_authority() -> Value {
    json!({
        "serviceGeneration": "service_gen_1",
        "registryGeneration": "registry_gen_1",
        "revision": 1
    })
}

#[derive(Clone)]
struct SessionMock {
    id: String,
    directory: String,
    workspace_id: Option<String>,
    metadata: Value,
    missing: bool,
}

#[allow(clippy::type_complexity)]
struct MockNative {
    global_dir: PathBuf,
    project_dir: PathBuf,
    global_file: PathBuf,
    project_file: PathBuf,
    runtime: Vec<Value>,
    rpc_outputs: HashMap<(String, String), (Status, Value)>,
    rpc_calls: Vec<(String, String, Value)>,
    sessions: HashMap<String, SessionMock>,
    metadata_writes: Vec<(String, Value)>,
    update_fail: bool,
    patch_status: Option<Status>,
    raw_session: bool,
    plain_session: bool,
    plain_rpc: bool,
    stall_rpc_body: Option<(String, Arc<Notify>, Arc<Notify>)>,
    hide_project_doc: bool,
    on_config_read: Option<Arc<dyn Fn() + Send + Sync>>,
    on_rpc: Option<Arc<dyn Fn(&str, &str) + Send + Sync>>,
    hang_rpc: Option<(String, Arc<Notify>, Arc<Notify>)>,
}

async fn mock_native_handler(State(state): State<Arc<Mutex<MockNative>>>, req: Request) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let body_bytes = axum::body::to_bytes(req.into_body(), 1024 * 1024).await.unwrap_or_default();
    let body: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);

    if method == Method::GET && path == "/api/config" {
        let on_cfg = state.lock().unwrap().on_config_read.clone();
        if let Some(cb) = on_cfg {
            cb();
        }
        let g = state.lock().unwrap();
        let mut docs = vec![json!({ "type": "directory", "path": g.global_dir })];
        if let Ok(text) = fs::read_to_string(&g.global_file)
            && let Ok(info) = serde_json::from_str::<Value>(&text)
        {
            docs.push(json!({ "type": "document", "path": g.global_file, "info": info }));
        }
        if !g.hide_project_doc
            && let Ok(text) = fs::read_to_string(&g.project_file)
            && let Ok(info) = serde_json::from_str::<Value>(&text)
        {
            docs.push(json!({ "type": "document", "path": g.project_file, "info": info }));
        }
        return Json(Value::Array(docs)).into_response();
    }
    if method == Method::GET && path == "/api/plugin" {
        let rt = state.lock().unwrap().runtime.clone();
        return Json(json!({ "data": rt })).into_response();
    }
    if method == Method::GET && path == "/api/location" {
        let dir = state.lock().unwrap().project_dir.clone();
        return Json(json!({ "directory": dir, "project": { "id": "prj_int", "directory": dir, "canonical": dir } }))
            .into_response();
    }
    if method == Method::GET && path == "/api/worktree" {
        let dir = state.lock().unwrap().project_dir.clone();
        return Json(json!([{ "directory": dir }])).into_response();
    }
    if method == Method::POST && path == "/api/worktree/refresh" {
        return Status::NO_CONTENT.into_response();
    }
    if method == Method::GET
        && let Some(sid) = path.strip_prefix("/api/session/")
    {
        let (sess, raw_session, plain_session) = {
            let g = state.lock().unwrap();
            (g.sessions.get(sid).cloned(), g.raw_session, g.plain_session)
        };
        let Some(sess) = sess else {
            return (Status::NOT_FOUND, Json(json!({ "_tag": "SessionNotFoundError", "sessionID": sid })))
                .into_response();
        };
        if sess.missing {
            return (Status::NOT_FOUND, Json(json!({ "_tag": "SessionNotFoundError", "sessionID": sid })))
                .into_response();
        }
        let mut loc = json!({ "directory": sess.directory });
        if let Some(ws) = sess.workspace_id {
            loc["workspaceID"] = Value::String(ws);
        }
        let inner = json!({
            "id": sess.id,
            "location": loc,
            "metadata": sess.metadata,
        });
        let payload = if raw_session { inner } else { json!({ "data": inner }) };
        if plain_session {
            return (Status::OK, [(header::CONTENT_TYPE, "text/plain")], payload.to_string()).into_response();
        }
        return Json(payload).into_response();
    }
    if method == Method::PATCH
        && let Some(sid) = path.strip_prefix("/api/session/")
    {
        let mut g = state.lock().unwrap();
        if g.update_fail {
            return (Status::INTERNAL_SERVER_ERROR, Json(json!({ "error": SECRET }))).into_response();
        }
        let meta = body.get("metadata").cloned().unwrap_or(json!({}));
        g.metadata_writes.push((sid.to_owned(), meta.clone()));
        if let Some(s) = g.sessions.get_mut(sid) {
            s.metadata = meta;
        }
        return g.patch_status.unwrap_or(Status::NO_CONTENT).into_response();
    }
    if method == Method::POST
        && let Some(rest) = path.strip_prefix("/api/rpc/")
        && let Some((rpc_id, rpc_method)) = rest.split_once('/')
    {
        let (hook, hang, stall_body) = {
            let mut g = state.lock().unwrap();
            g.rpc_calls.push((rpc_id.to_owned(), rpc_method.to_owned(), body.clone()));
            let hang = g
                .hang_rpc
                .as_ref()
                .filter(|(m, _, _)| m == rpc_method)
                .map(|(_, entered, release)| (entered.clone(), release.clone()));
            let stall_body = g
                .stall_rpc_body
                .as_ref()
                .filter(|(m, _, _)| m == rpc_method)
                .map(|(_, entered, release)| (entered.clone(), release.clone()));
            (g.on_rpc.clone(), hang, stall_body)
        };
        if let Some((entered, release)) = stall_body {
            entered.notify_one();
            let stream = futures_util::stream::once(async move {
                release.notified().await;
                Ok::<axum::body::Bytes, std::io::Error>(axum::body::Bytes::from_static(b"{}"))
            });
            return (Status::OK, [(header::CONTENT_TYPE, "application/json")], axum::body::Body::from_stream(stream))
                .into_response();
        }
        if let Some((entered, release)) = hang {
            entered.notify_one();
            release.notified().await;
        }
        if let Some(hook) = hook {
            hook(rpc_id, rpc_method);
        }
        let g = state.lock().unwrap();
        if let Some((status, val)) = g.rpc_outputs.get(&(rpc_id.to_owned(), rpc_method.to_owned())) {
            if g.plain_rpc {
                return (*status, [(header::CONTENT_TYPE, "text/plain")], val.to_string()).into_response();
            }
            return (*status, Json(val.clone())).into_response();
        }
        let default = match rpc_method {
            "status" => json!({ "output": ok_status("fixture", "native") }),
            "hosts" => json!({ "output": { "offers": [ok_offer()] } }),
            "attachHost" => json!({ "output": { "outcome": "attached" } }),
            "detachHost" => json!({ "output": { "outcome": "detached" } }),
            "installHost" => json!({ "output": { "outcome": "installed", "detail": "Installed add-on" } }),
            "bindingRead" => json!({
                "output": {
                    "state": "attached",
                    "authority": binding_authority(),
                    "binding": { "offerID": "offer_fixture", "label": "Blender window" }
                }
            }),
            _ => json!({ "output": {} }),
        };
        if g.plain_rpc {
            return (Status::OK, [(header::CONTENT_TYPE, "text/plain")], default.to_string()).into_response();
        }
        return Json(default).into_response();
    }
    Status::NOT_FOUND.into_response()
}

struct Harness {
    _tmp: TempDir,
    root: PathBuf,
    project_dir: PathBuf,
    global_file: PathBuf,
    project_file: PathBuf,
    ws_id: Uuid,
    app: Shared,
    mock: Arc<Mutex<MockNative>>,
    base: String,
    client: Client,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl Harness {
    async fn new() -> Self {
        let tmp = TempDir(crate::shared::test_dir("integrations-http"));
        let root = dunce::canonicalize(&tmp.0).unwrap();
        let data = root.join("data");
        let global_dir = root.join("global");
        let project_dir = root.join("project");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&global_dir).unwrap();
        fs::create_dir_all(project_dir.join(".opencode")).unwrap();
        let global_file = global_dir.join("opencode.jsonc");
        let project_file = project_dir.join(".opencode").join("opencode.jsonc");

        let mut sessions = HashMap::new();
        sessions.insert(
            "ses_1".into(),
            SessionMock {
                id: "ses_1".into(),
                directory: project_dir.to_string_lossy().into_owned(),
                workspace_id: None,
                metadata: json!({ "codenomad.other": "keep", "nested": { "ok": true } }),
                missing: false,
            },
        );
        let mock = Arc::new(Mutex::new(MockNative {
            global_dir,
            project_dir: project_dir.clone(),
            global_file: global_file.clone(),
            project_file: project_file.clone(),
            runtime: Vec::new(),
            rpc_outputs: HashMap::new(),
            rpc_calls: Vec::new(),
            sessions,
            metadata_writes: Vec::new(),
            update_fail: false,
            patch_status: None,
            raw_session: false,
            plain_session: false,
            plain_rpc: false,
            stall_rpc_body: None,
            hide_project_doc: false,
            on_config_read: None,
            on_rpc: None,
            hang_rpc: None,
        }));

        let native_router = Router::new().fallback(any(mock_native_handler)).with_state(mock.clone());
        let native_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native_addr = native_listener.local_addr().unwrap();
        let native_task = tokio::spawn(async move { axum::serve(native_listener, native_router).await.unwrap() });

        let auth = auth::Auth::new(auth::Settings {
            username: auth::DEFAULT_USERNAME.into(),
            password: Some("test-pass".into()),
            file: None,
            cookie: auth::DEFAULT_COOKIE.into(),
            token: false,
            managed_local: false,
            skip: true,
            idle: Duration::from_secs(3600),
            absolute: Duration::from_secs(7200),
        })
        .unwrap();
        let settings = settings::Settings::new(settings::document::Location::resolve(&data.to_string_lossy()));
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let app = Arc::new(App::new(
            auth,
            0,
            data,
            root.clone(),
            false,
            settings,
            json!({}),
            Native::test_connection(native_addr),
            PathBuf::new(),
            None,
            files::watch::Watches::new(tx),
            None,
        ));
        let ws_id = Uuid::new_v4();
        app.inner.lock().unwrap().workspaces.push(Workspace {
            id: ws_id,
            request_id: None,
            path: project_dir.clone(),
            name: Some("test".into()),
            status: "ready",
            proxy_path: format!("/workspaces/{ws_id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: "opencode".into(),
            created_at: crate::now(),
            updated_at: crate::now(),
            location: json!({ "directory": project_dir }),
            temporary: None,
        });

        let router = super::routes().with_state(app.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        Self {
            _tmp: tmp,
            root,
            project_dir,
            global_file,
            project_file,
            ws_id,
            app,
            mock,
            base: format!("http://{addr}"),
            client: Client::builder().no_proxy().build().unwrap(),
            tasks: vec![native_task, server_task],
        }
    }

    fn dir(&self) -> String {
        self.project_dir.to_string_lossy().into_owned()
    }

    fn url(&self, suffix: &str) -> String {
        format!("{}/api/workspaces/{}/integrations{suffix}", self.base, self.ws_id)
    }

    async fn seed_loaded_fixture(&self) {
        self.app
            .integration_catalog
            .seed_for_test(IntegrationCatalog { integrations: vec![entry("fixture", "native"), entry("mail", "api")] })
            .await;
        fs::write(&self.global_file, r#"{"plugins":["@neuralnomads/opencode-fixture@0.1.0"]}"#).unwrap();
        self.mock.lock().unwrap().runtime = vec![json!({
            "id": "neuralnomads.fixture",
            "features": { "rpc": true },
            "source": { "type": "package", "target": "@neuralnomads/opencode-fixture@0.1.0", "version": "0.1.0" },
            "state": { "status": "active" }
        })];
    }
}

#[test]
fn contract_validators_and_docs_url_match_specification() {
    assert!(looks_like_path("/etc/passwd"));
    assert!(looks_like_path("C:\\secret"));
    assert!(looks_like_path("C:secret"));
    assert!(looks_like_path("~private"));
    assert!(looks_like_path("in ~home"));
    assert!(!looks_like_path("Blender 5.2 (scene.blend)"));
    assert!(!looks_like_path("foo:bar"));

    let tree = "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/blender";
    let blob =
        "https://github.com/NeuralNomadsAI/opencode-integrations/blob/main/integrations/blender/plugin/README.md";
    assert!(is_integration_docs_url(tree, Some("blender")));
    assert!(is_integration_docs_url(blob, Some("blender")));
    assert!(!is_integration_docs_url(tree, Some("other")));
    assert!(!is_integration_docs_url(&format!("{tree}?x=1"), Some("blender")));
    assert!(!is_integration_docs_url(&tree.replace("https:", "http:"), Some("blender")));
    assert!(!is_integration_docs_url(&tree.replace("github.com", "u@github.com"), Some("blender")));
    assert!(!is_integration_docs_url(
        "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/blender/plugin/README.md",
        Some("blender")
    ));

    // `hosts.output` strips secrets and rejects invalid offerIDs.
    let hosts = parse_hosts_output(&json!({ "offers": [ok_offer()], "secret": SECRET })).unwrap();
    assert_eq!(hosts.offers.len(), 1);
    assert!(!serde_json::to_string(&hosts).unwrap().contains(SECRET));
    assert!(
        parse_hosts_output(&json!({ "offers": [{ "offerID": "short", "label": "ok", "protocol": "ok" }] })).is_none()
    );

    // `status.output` accepts open fields and rejects duplicate notices or null optional fields.
    assert!(parse_status_output(&ok_status("blender", "native")).is_some());
    assert!(
        parse_status_output(&json!({
            "contract": 1,
            "integration": { "id": "blender", "version": "0.1.0", "family": "native", "spec": 0 },
            "notices": ["dup_notice", "dup_notice"]
        }))
        .is_none()
    );
    assert!(
        parse_status_output(&json!({
            "contract": 1,
            "integration": { "id": "blender", "version": "0.1.0", "family": "native", "spec": 0 },
            "host": null
        }))
        .is_none()
    );

    // `installHost.output` validates detail length and control chars.
    assert!(parse_install_host_output(&json!({ "outcome": "installed", "detail": "ok" })).is_some());
    assert!(parse_install_host_output(&json!({ "outcome": "installed", "detail": "bad\nline" })).is_none());

    // `bindingRead.output` is closed at every level.
    assert_eq!(
        parse_binding_read_output(&json!({
            "state": "attached",
            "authority": binding_authority(),
            "binding": { "offerID": "offer_123456", "label": "Scene" }
        })),
        Some(BindingReadOutput::Attached { label: "Scene".into() })
    );
    assert!(
        parse_binding_read_output(&json!({
            "state": "none",
            "authority": binding_authority(),
            "extra": true
        }))
        .is_none()
    );
    assert!(
        parse_binding_read_output(&json!({
            "state": "attached",
            "authority": { "serviceGeneration": "g1\n", "registryGeneration": "g2", "revision": 1 },
            "binding": { "offerID": "offer_123456", "label": "Scene" }
        }))
        .is_none()
    );
}

#[tokio::test]
async fn get_integrations_reads_catalog_states_recognition_projection_and_ownership() {
    let h = Harness::new().await;
    let dir = h.dir();

    // 1. Unavailable catalog returns empty list and `no-store`.
    h.app
        .integration_catalog
        .seed_view_for_test(CatalogAvailability::Unavailable, None, IntegrationCatalog::default())
        .await;
    let unavail = h.client.get(h.url("")).query(&[("directory", &dir)]).send().await.unwrap();
    assert_eq!(unavail.status(), Status::OK);
    assert_eq!(unavail.headers()[header::CACHE_CONTROL], "no-store");
    let body: Value = unavail.json().await.unwrap();
    assert_eq!(body["catalog"], json!({ "state": "unavailable" }));
    assert_eq!(body["integrations"], json!([]));
    assert_eq!(body["ambiguousSources"], json!([]));

    // 2. Loaded native + API + absent + non-conforming + unsupported + failed + ambiguous.
    let mut bad_docs_entry = entry("mail", "api");
    bad_docs_entry.docs = "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/other".into();
    h.app
        .integration_catalog
        .seed_view_for_test(
            CatalogAvailability::Fresh,
            Some("2026-10-31T00:00:00.000Z".into()),
            IntegrationCatalog {
                integrations: vec![entry("fixture", "native"), bad_docs_entry, entry("other", "api")],
            },
        )
        .await;
    fs::write(&h.global_file, r#"{"plugins":["@neuralnomads/opencode-fixture@0.1.0","@neuralnomads/opencode-mail"]}"#)
        .unwrap();
    {
        let mut m = h.mock.lock().unwrap();
        m.runtime = vec![
            json!({
                "id": "neuralnomads.fixture",
                "features": { "rpc": true },
                "source": { "type": "package", "target": "@neuralnomads/opencode-fixture@0.1.0", "version": "0.1.0", "outdated": true },
                "state": { "status": "active" }
            }),
            json!({
                "id": "neuralnomads.mail",
                "features": { "rpc": true },
                "source": { "type": "package", "target": "@neuralnomads/opencode-mail", "version": "0.2.0" },
                "state": { "status": "active" }
            }),
        ];
        m.rpc_outputs.insert(
            ("neuralnomads.mail".into(), "status".into()),
            (
                Status::OK,
                json!({
                    "output": {
                        "contract": 1,
                        "integration": { "id": "mail", "version": "0.2.0", "family": "api", "spec": 0 },
                        "connection": { "state": "connected", "offers": 2, "attachedSessions": 3 }
                    }
                }),
            ),
        );
    }

    let resp = h.client.get(h.url("")).query(&[("directory", &dir)]).send().await.unwrap();
    assert_eq!(resp.status(), Status::OK);
    assert_eq!(resp.headers()[header::CACHE_CONTROL], "no-store");
    let text = resp.text().await.unwrap();
    assert!(!text.contains("attachedSessions"));
    assert!(!text.contains(SECRET));
    let val: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(val["catalog"], json!({ "state": "fresh", "fetchedAt": "2026-10-31T00:00:00.000Z" }));

    let items = val["integrations"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    // Native `fixture`: `offers` preserved, `state` omitted from connection; `docs` kept; `outdated: true`.
    assert_eq!(items[0]["id"], "fixture");
    assert_eq!(items[0]["state"], "ok");
    assert_eq!(items[0]["outdated"], true);
    assert_eq!(items[0]["status"]["connection"], json!({ "offers": 1 }));
    assert!(items[0].get("docs").is_some());
    assert_eq!(items[0]["configuredSources"].as_array().unwrap().len(), 1);
    // API `mail`: `state: "connected"` preserved, `offers` omitted; mismatched `docs` omitted.
    assert_eq!(items[1]["id"], "mail");
    assert_eq!(items[1]["state"], "ok");
    assert_eq!(items[1]["status"]["connection"], json!({ "state": "connected" }));
    assert!(items[1].get("docs").is_none());
    // Absent `other`.
    assert_eq!(items[2]["id"], "other");
    assert_eq!(items[2]["state"], "absent");
    assert_eq!(items[2]["configured"], false);

    // 3. Shared/ambiguous source: neither integration is attributed, `ambiguousSources` lists the row once, no RPC.
    fs::write(&h.global_file, r#"{"plugins":["@neuralnomads/opencode-mail"]}"#).unwrap();
    {
        let mut m = h.mock.lock().unwrap();
        m.rpc_calls.clear();
        m.runtime = vec![json!({
            "id": "neuralnomads.fixture",
            "features": { "rpc": true },
            "source": { "type": "package", "target": "@neuralnomads/opencode-mail", "version": "0.1.0" },
            "state": { "status": "active" }
        })];
    }
    let amb: Value = h.client.get(h.url("")).query(&[("directory", &dir)]).send().await.unwrap().json().await.unwrap();
    assert_eq!(amb["ambiguousSources"], json!([{ "scope": "global", "entryIndex": 0 }]));
    assert_eq!(amb["integrations"][0]["ambiguous"], true);
    assert_eq!(amb["integrations"][0]["state"], "non-conforming");
    assert_eq!(amb["integrations"][0]["plugin"], json!({ "declared": false }));
    assert_eq!(amb["integrations"][1]["ambiguous"], true);
    assert_eq!(amb["integrations"][1]["state"], "non-conforming");
    assert!(h.mock.lock().unwrap().rpc_calls.is_empty());

    // 4. Foreign Location refused with 403 and no-store; bad query -> 400 and no-store.
    let foreign = h.root.join("outside");
    fs::create_dir_all(&foreign).unwrap();
    let r403 = h.client.get(h.url("")).query(&[("directory", foreign.to_str().unwrap())]).send().await.unwrap();
    assert_eq!(r403.status(), Status::FORBIDDEN);
    assert_eq!(r403.headers()[header::CACHE_CONTROL], "no-store");

    let r400 = h.client.get(h.url("")).query(&[("directory", dir.as_str()), ("extra", "1")]).send().await.unwrap();
    assert_eq!(r400.status(), Status::BAD_REQUEST);
    assert_eq!(r400.headers()[header::CACHE_CONTROL], "no-store");

    // 5. Connection replaced during RPC fails with 503 after RPC.
    h.seed_loaded_fixture().await;
    let app_clone = h.app.clone();
    let other_addr: SocketAddr = ([127, 0, 0, 1], 9).into();
    h.mock.lock().unwrap().on_rpc = Some(Arc::new(move |_, _| {
        app_clone.native.replace_test_endpoint(other_addr);
    }));
    let r503 = h.client.get(h.url("")).query(&[("directory", &dir)]).send().await.unwrap();
    assert_eq!(r503.status(), Status::SERVICE_UNAVAILABLE);
    assert_eq!(r503.headers()[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn post_install_enforces_catalog_scope_duplicates_validation_and_post_write_uncertainty() {
    let h = Harness::new().await;
    let dir = h.dir();

    // 1. Unavailable catalog -> 503 unavailable.
    h.app
        .integration_catalog
        .seed_view_for_test(CatalogAvailability::Unavailable, None, IntegrationCatalog::default())
        .await;
    let r = h
        .client
        .post(h.url("/fixture/install"))
        .query(&[("directory", &dir)])
        .json(&json!({ "scope": "global" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), Status::SERVICE_UNAVAILABLE);
    assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(r.json::<Value>().await.unwrap()["code"], "unavailable");

    // 2. Valid stale catalog allows install, rejects unknown (404) and native-in-project (422 global-only).
    h.app
        .integration_catalog
        .seed_view_for_test(
            CatalogAvailability::Stale,
            Some("2026-10-01T00:00:00.000Z".into()),
            IntegrationCatalog { integrations: vec![entry("fixture", "native"), entry("mail", "api")] },
        )
        .await;

    let unknown = h
        .client
        .post(h.url("/houdini/install"))
        .query(&[("directory", &dir)])
        .json(&json!({ "scope": "global" }))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), Status::NOT_FOUND);
    assert_eq!(unknown.json::<Value>().await.unwrap()["code"], "not-found");

    let global_only = h
        .client
        .post(h.url("/fixture/install"))
        .query(&[("directory", &dir)])
        .json(&json!({ "scope": "project" }))
        .send()
        .await
        .unwrap();
    assert_eq!(global_only.status(), Status::UNPROCESSABLE_ENTITY);
    assert_eq!(global_only.json::<Value>().await.unwrap()["code"], "global-only");
    assert!(!h.project_file.exists());

    // 3. Reinstall after removal preserving retained `id`/`-id` rules succeeds.
    fs::write(&h.global_file, r#"{"plugins":["-neuralnomads.fixture","neuralnomads.fixture"],"keep":true}"#).unwrap();
    let ok = h
        .client
        .post(h.url("/fixture/install"))
        .query(&[("directory", &dir)])
        .json(&json!({ "scope": "global" }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), Status::OK);
    assert_eq!(ok.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        ok.json::<Value>().await.unwrap(),
        json!({ "scope": "global", "spec": "@neuralnomads/opencode-fixture@^0.1", "reloadPending": true })
    );
    let written: Value = serde_json::from_str(&fs::read_to_string(&h.global_file).unwrap()).unwrap();
    assert_eq!(
        written["plugins"],
        json!(["-neuralnomads.fixture", "neuralnomads.fixture", "@neuralnomads/opencode-fixture@^0.1"])
    );

    // 4. Duplicate install refused with 409 duplicate.
    let dup = h
        .client
        .post(h.url("/fixture/install"))
        .query(&[("directory", &dir)])
        .json(&json!({ "scope": "global" }))
        .send()
        .await
        .unwrap();
    assert_eq!(dup.status(), Status::CONFLICT);
    assert_eq!(dup.json::<Value>().await.unwrap()["code"], "duplicate");

    // 5. Concurrent API installs serialize: one 200, one 409 duplicate.
    let (a, b) = tokio::join!(
        h.client.post(h.url("/mail/install")).query(&[("directory", &dir)]).json(&json!({ "scope": "global" })).send(),
        h.client.post(h.url("/mail/install")).query(&[("directory", &dir)]).json(&json!({ "scope": "project" })).send(),
    );
    let mut codes = [a.unwrap().status(), b.unwrap().status()];
    codes.sort();
    assert_eq!(codes, [Status::OK, Status::CONFLICT]);

    // 6. Strict 400 validation: extra fields, missing body, workspaceID, invalid integrationId.
    for (path_suffix, query, body_opt) in [
        ("/fixture/install", vec![("directory", dir.as_str())], Some(json!({ "scope": "global", "spec": "evil@1" }))),
        ("/fixture/install", vec![("directory", dir.as_str())], Some(json!({ "scope": "inline" }))),
        ("/fixture/install", vec![("directory", dir.as_str())], None),
        (
            "/fixture/install",
            vec![("directory", dir.as_str()), ("workspaceID", "x")],
            Some(json!({ "scope": "global" })),
        ),
        ("/Fixture/install", vec![("directory", dir.as_str())], Some(json!({ "scope": "global" }))),
    ] {
        let mut req = h.client.post(h.url(path_suffix)).query(&query);
        if let Some(b) = body_opt {
            req = req.json(&b);
        }
        let resp = req.send().await.unwrap();
        assert_eq!(resp.status(), Status::BAD_REQUEST, "{path_suffix} {query:?}");
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            resp.json::<Value>().await.unwrap(),
            json!({ "error": "Invalid integration install request", "code": "invalid" })
        );
    }

    // 7. Ownership is checked before any catalog-derived refusal.
    let foreign = h.root.join("foreign");
    fs::create_dir_all(&foreign).unwrap();
    let f403 = h
        .client
        .post(h.url("/houdini/install"))
        .query(&[("directory", foreign.to_str().unwrap())])
        .json(&json!({ "scope": "global" }))
        .send()
        .await
        .unwrap();
    assert_eq!(f403.status(), Status::FORBIDDEN);
    assert_eq!(f403.json::<Value>().await.unwrap()["code"], "forbidden");

    // 8. Uncoded write conflict (e.g. worktree deletion fence) maps to `409 stale`, not `duplicate`.
    let h_stale = Harness::new().await;
    let dir_stale = h_stale.dir();
    h_stale
        .app
        .integration_catalog
        .seed_for_test(IntegrationCatalog { integrations: vec![entry("mail", "api")] })
        .await;
    let _fence =
        crate::worktrees::fence::block(&[crate::worktrees::fence::identity(&h_stale.project_dir)]).await.unwrap();
    let stale_resp = h_stale
        .client
        .post(h_stale.url("/mail/install"))
        .query(&[("directory", &dir_stale)])
        .json(&json!({ "scope": "project" }))
        .send()
        .await
        .unwrap();
    assert_eq!(stale_resp.status(), Status::CONFLICT);
    assert_eq!(stale_resp.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(stale_resp.json::<Value>().await.unwrap()["code"], "stale");

    // 9. Post-write authority loss (principal revoked or directory replaced) maps to `503 uncertain`.
    let h_uncertain = Harness::new().await;
    let dir_uncertain = h_uncertain.dir();
    h_uncertain
        .app
        .integration_catalog
        .seed_for_test(IntegrationCatalog { integrations: vec![entry("mail", "api")] })
        .await;
    let principal = tokio_util::sync::CancellationToken::new();
    let revoke = principal.clone();
    let uncertain_err = super::install::install_with_after_write(
        &h_uncertain.app,
        &h_uncertain.ws_id.to_string(),
        "mail",
        &dir_uncertain,
        crate::opencode_settings::Scope::Global,
        Some(principal),
        Box::new(move || revoke.cancel()),
    )
    .await
    .err();
    assert_eq!(uncertain_err, Some(super::install::InstallError::Uncertain));
    assert!(
        fs::read_to_string(&h_uncertain.global_file).unwrap().contains("@neuralnomads/opencode-mail@^0.1"),
        "write occurred before post-write refusal"
    );

    // Post-write directory identity swap (directory replaced on disk after commit) -> `503 uncertain`.
    let h_swap = Harness::new().await;
    let dir_swap = h_swap.dir();
    h_swap.app.integration_catalog.seed_for_test(IntegrationCatalog { integrations: vec![entry("mail", "api")] }).await;
    let swapped_dir = h_swap.project_dir.clone();
    let moved_dir = h_swap.root.join("project-moved");
    let swap_err = super::install::install_with_after_write(
        &h_swap.app,
        &h_swap.ws_id.to_string(),
        "mail",
        &dir_swap,
        crate::opencode_settings::Scope::Global,
        None,
        Box::new(move || {
            fs::rename(&swapped_dir, &moved_dir).unwrap();
            fs::create_dir_all(&swapped_dir).unwrap();
        }),
    )
    .await
    .err();
    assert_eq!(swap_err, Some(super::install::InstallError::Uncertain));

    // Pre-write directory identity swap during `sources::add_pinned` -> `403 forbidden`, nothing written!
    let h_pre = Harness::new().await;
    let dir_pre = h_pre.dir();
    h_pre.app.integration_catalog.seed_for_test(IntegrationCatalog { integrations: vec![entry("mail", "api")] }).await;
    let cfg_reads = Arc::new(AtomicUsize::new(0));
    let cfg_reads_cb = cfg_reads.clone();
    let pre_dir = h_pre.project_dir.clone();
    let pre_moved = h_pre.root.join("project-pre-moved");
    h_pre.mock.lock().unwrap().on_config_read = Some(Arc::new(move || {
        // 1st config read is initial `install::read_bound`; 2nd is inside `sources::add_pinned`.
        if cfg_reads_cb.fetch_add(1, Ordering::SeqCst) == 1 {
            fs::rename(&pre_dir, &pre_moved).unwrap();
            fs::create_dir_all(&pre_dir).unwrap();
        }
    }));
    let pre_resp = h_pre
        .client
        .post(h_pre.url("/mail/install"))
        .query(&[("directory", &dir_pre)])
        .json(&json!({ "scope": "global" }))
        .send()
        .await
        .unwrap();
    assert_eq!(pre_resp.status(), Status::FORBIDDEN);
    assert_eq!(pre_resp.json::<Value>().await.unwrap()["code"], "forbidden");
    assert!(!h_pre.global_file.exists(), "swapped location must not be written before commit");
}

#[tokio::test]
async fn hosts_binding_install_host_attach_and_detach_enforce_security_and_serialization() {
    let h = Harness::new().await;
    let dir = h.dir();
    h.seed_loaded_fixture().await;

    // 1. `GET /hosts` strips secret fields and sets `no-store`.
    let hosts_resp = h.client.get(h.url("/fixture/hosts")).query(&[("directory", &dir)]).send().await.unwrap();
    assert_eq!(hosts_resp.status(), Status::OK);
    assert_eq!(hosts_resp.headers()[header::CACHE_CONTROL], "no-store");
    let hosts_text = hosts_resp.text().await.unwrap();
    assert!(!hosts_text.contains(SECRET));
    let hosts_val: Value = serde_json::from_str(&hosts_text).unwrap();
    assert_eq!(
        hosts_val,
        json!({ "offers": [{ "offerID": "offer_fixture", "label": "Blender window", "document": "Scene.blend", "appVersion": "5.2.0", "protocol": "ok" }] })
    );

    // 2. `GET /binding` returns projected attached label, isolates Locations (403), degrades errors to `unknown`.
    let bind_ok = h
        .client
        .get(h.url("/fixture/binding"))
        .query(&[("directory", dir.as_str()), ("sessionID", "ses_1")])
        .send()
        .await
        .unwrap();
    assert_eq!(bind_ok.status(), Status::OK);
    assert_eq!(bind_ok.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(bind_ok.json::<Value>().await.unwrap(), json!({ "state": "attached", "label": "Blender window" }));

    // Bad sessionID prefix -> 400 invalid.
    let bad_sid = h
        .client
        .get(h.url("/fixture/binding"))
        .query(&[("directory", dir.as_str()), ("sessionID", "bad_1")])
        .send()
        .await
        .unwrap();
    assert_eq!(bad_sid.status(), Status::BAD_REQUEST);
    assert_eq!(bad_sid.json::<Value>().await.unwrap()["code"], "invalid");

    // Session moved to another Location -> 403 forbidden without calling `bindingRead`.
    h.mock.lock().unwrap().sessions.insert(
        "ses_moved".into(),
        SessionMock {
            id: "ses_moved".into(),
            directory: "/elsewhere".into(),
            workspace_id: None,
            metadata: json!({}),
            missing: false,
        },
    );
    let moved = h
        .client
        .get(h.url("/fixture/binding"))
        .query(&[("directory", dir.as_str()), ("sessionID", "ses_moved")])
        .send()
        .await
        .unwrap();
    assert_eq!(moved.status(), Status::FORBIDDEN);

    // Missing session -> degrades to `{ state: "unknown" }`.
    let missing = h
        .client
        .get(h.url("/fixture/binding"))
        .query(&[("directory", dir.as_str()), ("sessionID", "ses_absent")])
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), Status::OK);
    assert_eq!(missing.json::<Value>().await.unwrap(), json!({ "state": "unknown" }));

    // 3. `POST /install-host`: rejects missing body or `{"target":"default"}`, strips `detail`, returns `{ outcome }`.
    let missing_body =
        h.client.post(h.url("/fixture/install-host")).query(&[("directory", &dir)]).send().await.unwrap();
    assert_eq!(missing_body.status(), Status::BAD_REQUEST);
    let extra_body = h
        .client
        .post(h.url("/fixture/install-host"))
        .query(&[("directory", &dir)])
        .json(&json!({ "target": "default" }))
        .send()
        .await
        .unwrap();
    assert_eq!(extra_body.status(), Status::BAD_REQUEST);
    let ih_ok = h
        .client
        .post(h.url("/fixture/install-host"))
        .query(&[("directory", &dir)])
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(ih_ok.status(), Status::OK);
    assert_eq!(ih_ok.json::<Value>().await.unwrap(), json!({ "outcome": "installed" }));

    // Path-like detail -> 502 non-conforming.
    h.mock.lock().unwrap().rpc_outputs.insert(
        ("neuralnomads.fixture".into(), "installHost".into()),
        (Status::OK, json!({ "output": { "outcome": "failed", "detail": "in /private/path" } })),
    );
    let ih_bad = h
        .client
        .post(h.url("/fixture/install-host"))
        .query(&[("directory", &dir)])
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(ih_bad.status(), Status::BAD_GATEWAY);
    h.mock.lock().unwrap().rpc_outputs.remove(&("neuralnomads.fixture".into(), "installHost".into()));

    // WSL policies refuse BEFORE catalog refresh or RPC calls.
    let catalog_hits = Arc::new(AtomicUsize::new(0));
    let hits_clone = catalog_hits.clone();
    let cat_router = Router::new().fallback(any(move || {
        let hits = hits_clone.clone();
        async move {
            hits.fetch_add(1, Ordering::SeqCst);
            Json(json!([]))
        }
    }));
    let cat_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cat_addr = cat_listener.local_addr().unwrap();
    let cat_task = tokio::spawn(async move { axum::serve(cat_listener, cat_router).await.unwrap() });
    h.app.integration_catalog.set_releases_url(Some(format!("http://{cat_addr}/releases"))).await;
    h.mock.lock().unwrap().rpc_calls.clear();

    for policy in [
        HostPolicy { is_linux: true, wsl_env_set: true, kernel_version: None },
        HostPolicy {
            is_linux: true,
            wsl_env_set: false,
            kernel_version: Some(Ok("Linux version 6.6.0-microsoft-standard-WSL2".into())),
        },
    ] {
        let err = attachments::install_host_with(
            &h.app,
            &h.ws_id.to_string(),
            "fixture",
            &dir,
            None,
            Duration::from_secs(2),
            &policy,
        )
        .await
        .err();
        assert_eq!(err, Some(AttachmentError::Unsupported));
    }
    let kernel_err = attachments::install_host_with(
        &h.app,
        &h.ws_id.to_string(),
        "fixture",
        &dir,
        None,
        Duration::from_secs(2),
        &HostPolicy { is_linux: true, wsl_env_set: false, kernel_version: Some(Err(())) },
    )
    .await
    .err();
    assert_eq!(kernel_err, Some(AttachmentError::Unavailable));
    assert_eq!(catalog_hits.load(Ordering::SeqCst), 0, "WSL check must refuse before catalog refresh");
    assert!(h.mock.lock().unwrap().rpc_calls.is_empty(), "WSL check must refuse before RPCs");

    // Non-WSL `install_host` still uses read-only catalog (`refresh: false`) -> zero catalog hits!
    let ok_ro = attachments::install_host_with(
        &h.app,
        &h.ws_id.to_string(),
        "fixture",
        &dir,
        None,
        attachments::INTEGRATION_ATTACHMENT_TIMEOUT,
        &HostPolicy { is_linux: false, wsl_env_set: false, kernel_version: None },
    )
    .await
    .unwrap();
    assert_eq!(ok_ro.outcome, "installed");
    assert_eq!(catalog_hits.load(Ordering::SeqCst), 0, "install-host must not refresh catalog");
    cat_task.abort();
    h.app.integration_catalog.set_releases_url(None).await;

    // 4. `POST /attach` writes hint preserving unrelated metadata; `POST /detach` removes hint preserving unrelated.
    let attach_resp = h
        .client
        .post(h.url("/fixture/attach"))
        .query(&[("directory", &dir)])
        .json(&json!({ "offerID": "offer_fixture", "sessionID": "ses_1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(attach_resp.status(), Status::OK);
    assert_eq!(attach_resp.json::<Value>().await.unwrap(), json!({ "outcome": "attached" }));
    {
        let m = h.mock.lock().unwrap();
        let meta = &m.sessions["ses_1"].metadata;
        assert_eq!(meta["codenomad.other"], "keep");
        assert_eq!(meta[INTEGRATION_ATTACHMENT_METADATA_KEY]["integration"], "fixture");
        assert_eq!(meta[INTEGRATION_ATTACHMENT_METADATA_KEY]["label"], "Blender window");
    }

    let detach_resp = h
        .client
        .post(h.url("/fixture/detach"))
        .query(&[("directory", &dir)])
        .json(&json!({ "sessionID": "ses_1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(detach_resp.status(), Status::OK);
    assert_eq!(detach_resp.json::<Value>().await.unwrap(), json!({ "outcome": "detached" }));
    {
        let m = h.mock.lock().unwrap();
        let meta = &m.sessions["ses_1"].metadata;
        assert_eq!(meta["codenomad.other"], "keep");
        assert!(meta.get(INTEGRATION_ATTACHMENT_METADATA_KEY).is_none());
    }

    // 5. Missing offer -> `gone`; incompatible offer -> `refused` without calling `attachHost`.
    h.mock.lock().unwrap().rpc_calls.clear();
    let gone = h
        .client
        .post(h.url("/fixture/attach"))
        .query(&[("directory", &dir)])
        .json(&json!({ "offerID": "offer_missing", "sessionID": "ses_1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), Status::OK);
    assert_eq!(gone.json::<Value>().await.unwrap(), json!({ "outcome": "gone" }));
    assert!(!h.mock.lock().unwrap().rpc_calls.iter().any(|(_, m, _)| m == "attachHost"));

    // 6. Timed-out attach releases the session lock and fences the cancelled RPC before metadata write.
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    {
        let mut m = h.mock.lock().unwrap();
        m.metadata_writes.clear();
        m.hang_rpc = Some(("attachHost".into(), entered.clone(), release.clone()));
    }
    let timed_out = attachments::attach_with_timeout(
        &h.app,
        &h.ws_id.to_string(),
        "fixture",
        &dir,
        "offer_fixture",
        "ses_1",
        None,
        Duration::from_millis(500),
    )
    .await;
    assert_eq!(timed_out.err(), Some(AttachmentError::Unavailable));
    assert!(
        h.mock.lock().unwrap().rpc_calls.iter().any(|(_, m, _)| m == "attachHost"),
        "attachHost must have been entered before timing out"
    );
    {
        let mut m = h.mock.lock().unwrap();
        m.hang_rpc = None;
    }
    let detach_after = attachments::detach_with_timeout(
        &h.app,
        &h.ws_id.to_string(),
        "fixture",
        &dir,
        "ses_1",
        None,
        attachments::INTEGRATION_ATTACHMENT_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(detach_after.outcome, "detached");
    release.notify_waiters();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(h.mock.lock().unwrap().metadata_writes.len(), 1, "timed-out attach must not write metadata");

    // 7. Non-native integration refused with 409 unsupported.
    let api_refused = h.client.get(h.url("/mail/hosts")).query(&[("directory", &dir)]).send().await.unwrap();
    assert_eq!(api_refused.status(), Status::CONFLICT);
    assert_eq!(api_refused.json::<Value>().await.unwrap()["code"], "unsupported");

    // 8. RPC errors sanitize upstream errors and map to 409 / 502 / 503.
    for (rpc_type, expected_status) in [
        ("rpc.unavailable", Status::CONFLICT),
        ("rpc.method_not_found", Status::CONFLICT),
        ("rpc.invalid_output", Status::BAD_GATEWAY),
        ("rpc.internal", Status::SERVICE_UNAVAILABLE),
    ] {
        h.mock.lock().unwrap().rpc_outputs.insert(
            ("neuralnomads.fixture".into(), "hosts".into()),
            (Status::BAD_REQUEST, json!({ "_tag": "RpcError", "type": rpc_type, "message": SECRET })),
        );
        let r = h.client.get(h.url("/fixture/hosts")).query(&[("directory", &dir)]).send().await.unwrap();
        assert_eq!(r.status(), expected_status, "{rpc_type}");
        assert!(!r.text().await.unwrap().contains(SECRET));
    }
    h.mock.lock().unwrap().rpc_outputs.remove(&("neuralnomads.fixture".into(), "hosts".into()));
}

#[tokio::test]
async fn remote_control_admits_all_seven_integration_routes_for_direct_and_ingress() {
    for ingress in [false, true] {
        let h = Harness::new().await;
        h.seed_loaded_fixture().await;
        let dir = h.dir();
        let host = if ingress { "remote.example.test" } else { "192.168.1.44:9898" };
        let origin = format!("https://{host}");
        let dev_dir =
            TempDir(crate::shared::test_dir(if ingress { "int-remote-ingress" } else { "int-remote-direct" }));
        let devs = if ingress {
            devices::open_ingress_for_test(&dev_dir.0, origin.clone())
        } else {
            devices::open_for_test(&dev_dir.0, origin.clone(), vec![origin.clone()])
        };

        let auth = auth::Auth::new(auth::Settings {
            username: auth::DEFAULT_USERNAME.into(),
            password: Some("test-pass".into()),
            file: None,
            cookie: auth::DEFAULT_COOKIE.into(),
            token: false,
            managed_local: false,
            skip: false,
            idle: Duration::from_secs(3600),
            absolute: Duration::from_secs(7200),
        })
        .unwrap();
        let settings = settings::Settings::new(settings::document::Location::resolve(&h.app.data.to_string_lossy()));
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let native_url = h.app.native.endpoint().unwrap().url.clone();
        let native_addr = SocketAddr::new(native_url.host_str().unwrap().parse().unwrap(), native_url.port().unwrap());
        let app = Arc::new(App::new(
            auth,
            0,
            h.app.data.clone(),
            h.root.clone(),
            false,
            settings,
            json!({}),
            Native::test_connection(native_addr),
            PathBuf::new(),
            Some(devs),
            files::watch::Watches::new(tx),
            None,
        ));
        app.inner.lock().unwrap().workspaces.push(h.app.workspace(&h.ws_id.to_string()).unwrap());
        app.integration_catalog
            .seed_for_test(IntegrationCatalog { integrations: vec![entry("fixture", "native"), entry("mail", "api")] })
            .await;

        let origins: Arc<[String]> = Arc::from([origin.clone()]);
        let origin_for_mw = origin.clone();
        let router = super::routes()
            .merge(auth::remote_routes())
            .layer(from_fn_with_state((app.clone(), None), remote::admit))
            .layer(from_fn(move |mut req: Request, next: Next| {
                let channel = tls::Channel {
                    origin: origin_for_mw.clone(),
                    origins: origins.clone(),
                    ingress,
                    socket: CancellationToken::new(),
                    principal: Arc::new(Mutex::new(None)),
                };
                req.extensions_mut().insert(channel);
                async move { next.run(req).await }
            }))
            .with_state(app.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let server_base = format!("http://{addr}");
        let base = format!("{server_base}/api/workspaces/{}/integrations", h.ws_id);

        // Pair a browser device via the real pairing endpoints.
        let issue_payload = if ingress {
            axum::body::Bytes::new()
        } else {
            axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#))
        };
        let issued = devices::issue(State(app.clone()), issue_payload).await;
        assert_eq!(issued.status(), Status::OK);
        let issued_body = axum::body::to_bytes(issued.into_body(), 4096).await.unwrap();
        let link: Value = serde_json::from_slice(&issued_body).unwrap();
        let code = link["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();
        let paired = h
            .client
            .post(format!("{server_base}/api/remote-control/pair"))
            .header(header::HOST, host)
            .header(header::ORIGIN, &origin)
            .json(&json!({ "code": code }))
            .send()
            .await
            .unwrap();
        assert_eq!(paired.status(), Status::OK);
        let cookie = paired.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();

        // Unpaired request -> 401 with Cache-Control: no-store.
        let unpaired =
            h.client.get(&base).query(&[("directory", dir.as_str())]).header(header::HOST, host).send().await.unwrap();
        assert_eq!(unpaired.status(), Status::UNAUTHORIZED);
        assert_eq!(unpaired.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));

        // Cross-origin POST -> 403 with Cache-Control: no-store.
        let cross = h
            .client
            .post(format!("{base}/fixture/detach"))
            .query(&[("directory", dir.as_str())])
            .header(header::HOST, host)
            .header(header::COOKIE, &cookie)
            .header(header::ORIGIN, "https://evil.invalid")
            .json(&json!({ "sessionID": "ses_1" }))
            .send()
            .await
            .unwrap();
        assert_eq!(cross.status(), Status::FORBIDDEN);
        assert_eq!(cross.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));

        // Unmatched remote integration subpath -> 404 with Cache-Control: no-store.
        let unmatched_remote = h
            .client
            .get(format!("{base}/fixture/unknown"))
            .query(&[("directory", dir.as_str())])
            .header(header::HOST, host)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(unmatched_remote.status(), Status::NOT_FOUND);
        assert_eq!(
            unmatched_remote.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()),
            Some("no-store")
        );

        // Paired browser device accesses all 7 routes.
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, host.parse().unwrap());
        headers.insert(header::COOKIE, cookie.parse().unwrap());
        headers.insert(header::ORIGIN, origin.parse().unwrap());

        assert_eq!(
            h.client
                .get(&base)
                .query(&[("directory", dir.as_str())])
                .headers(headers.clone())
                .send()
                .await
                .unwrap()
                .status(),
            Status::OK
        );
        assert_eq!(
            h.client
                .get(format!("{base}/fixture/hosts"))
                .query(&[("directory", dir.as_str())])
                .headers(headers.clone())
                .send()
                .await
                .unwrap()
                .status(),
            Status::OK
        );
        assert_eq!(
            h.client
                .get(format!("{base}/fixture/binding"))
                .query(&[("directory", dir.as_str()), ("sessionID", "ses_1")])
                .headers(headers.clone())
                .send()
                .await
                .unwrap()
                .status(),
            Status::OK
        );
        assert_eq!(
            h.client
                .post(format!("{base}/mail/install"))
                .query(&[("directory", &dir)])
                .headers(headers.clone())
                .json(&json!({ "scope": "project" }))
                .send()
                .await
                .unwrap()
                .status(),
            Status::OK
        );
        assert_eq!(
            h.client
                .post(format!("{base}/fixture/install-host"))
                .query(&[("directory", &dir)])
                .headers(headers.clone())
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            Status::OK
        );
        assert_eq!(
            h.client
                .post(format!("{base}/fixture/attach"))
                .query(&[("directory", &dir)])
                .headers(headers.clone())
                .json(&json!({ "offerID": "offer_fixture", "sessionID": "ses_1" }))
                .send()
                .await
                .unwrap()
                .status(),
            Status::OK
        );
        assert_eq!(
            h.client
                .post(format!("{base}/fixture/detach"))
                .query(&[("directory", &dir)])
                .headers(headers.clone())
                .json(&json!({ "sessionID": "ses_1" }))
                .send()
                .await
                .unwrap()
                .status(),
            Status::OK
        );

        task.abort();
    }
}

#[tokio::test]
async fn recognition_handles_alias_git_and_timeout_status() {
    let h = Harness::new().await;
    let dir = h.dir();
    h.app
        .integration_catalog
        .seed_for_test(IntegrationCatalog { integrations: vec![entry("fixture", "native")] })
        .await;
    fs::write(&h.global_file, r#"{"plugins":["fx@npm:@neuralnomads/opencode-fixture@0.1.0"]}"#).unwrap();
    h.mock.lock().unwrap().runtime = vec![json!({
        "id": "neuralnomads.fixture",
        "features": { "rpc": true },
        "source": { "type": "package", "target": "fx@npm:@neuralnomads/opencode-fixture@0.1.0", "version": "0.1.0" },
        "state": { "status": "active" }
    })];
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    h.mock.lock().unwrap().hang_rpc = Some(("status".into(), entered, release.clone()));

    let res = reader::read_with_timeout(
        &h.app,
        &h.ws_id.to_string(),
        &ControlLocation::new(dir.clone(), None),
        None,
        Duration::from_millis(40),
    )
    .await
    .unwrap();
    release.notify_waiters();
    assert_eq!(res.integrations.len(), 1);
    assert_eq!(res.integrations[0].state, reader::IntegrationRuntimeState::Unknown);
    assert!(res.integrations[0].configured);
    assert_eq!(res.integrations[0].scopes, vec!["global"]);

    // Sanity check `recognize_integrations` directly on a failed single-source package.
    let snap = crate::plugin_controls::engine::read(
        &h.app,
        &h.ws_id.to_string(),
        &ControlLocation::new(dir, None),
        None,
        None,
    )
    .await
    .unwrap();
    let rec = recognize_integrations(&IntegrationCatalog { integrations: vec![entry("fixture", "native")] }, &snap);
    assert_eq!(rec.len(), 1);
    assert_eq!(rec[0].scopes, vec![ConfigScope::Global]);
}

#[tokio::test]
async fn fastify_parsing_strict_native_contracts_unmatched_404_and_revoked_status_queue() {
    let h = Harness::new().await;
    h.seed_loaded_fixture().await;
    let dir = h.dir();

    // 1. Fastify/Zod parity: `text/plain` -> 400 invalid (not 415); empty/malformed JSON -> FST_ERR_CTP_*.
    let text_install = h
        .client
        .post(h.url("/mail/install"))
        .query(&[("directory", &dir)])
        .header(header::CONTENT_TYPE, "text/plain")
        .body(r#"{"scope":"global"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(text_install.status(), Status::BAD_REQUEST);
    assert_eq!(text_install.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(text_install.json::<Value>().await.unwrap()["code"], "invalid");

    let empty_json = h
        .client
        .post(h.url("/mail/install"))
        .query(&[("directory", &dir)])
        .header(header::CONTENT_TYPE, "application/json")
        .body("")
        .send()
        .await
        .unwrap();
    assert_eq!(empty_json.status(), Status::BAD_REQUEST);
    assert_eq!(empty_json.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(empty_json.json::<Value>().await.unwrap()["code"], "FST_ERR_CTP_EMPTY_JSON_BODY");

    let bad_json = h
        .client
        .post(h.url("/fixture/attach"))
        .query(&[("directory", &dir)])
        .header(header::CONTENT_TYPE, "application/json")
        .body("{not-json")
        .send()
        .await
        .unwrap();
    assert_eq!(bad_json.status(), Status::BAD_REQUEST);
    assert_eq!(bad_json.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(bad_json.json::<Value>().await.unwrap()["code"], "FST_ERR_CTP_INVALID_JSON_BODY");

    // GET `hosts` and `binding` ignore request bodies like Fastify.
    let get_hosts_with_body = h
        .client
        .get(h.url("/fixture/hosts"))
        .query(&[("directory", &dir)])
        .body("ignored-get-body")
        .send()
        .await
        .unwrap();
    assert_eq!(get_hosts_with_body.status(), Status::OK);

    let get_binding_with_body = h
        .client
        .get(h.url("/fixture/binding"))
        .query(&[("directory", dir.as_str()), ("sessionID", "ses_1")])
        .body("ignored-get-body")
        .send()
        .await
        .unwrap();
    assert_eq!(get_binding_with_body.status(), Status::OK);

    // 2. Unmatched integration subpaths return 404 with `Cache-Control: no-store`.
    for (method, suffix) in [
        (Method::GET, "/"),
        (Method::GET, "/fixture"),
        (Method::GET, "/fixture/unknown"),
        (Method::POST, "/fixture/install/extra"),
    ] {
        let resp = h.client.request(method, h.url(suffix)).send().await.unwrap();
        assert_eq!(resp.status(), Status::NOT_FOUND, "{suffix}");
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "no-store", "{suffix}");
    }

    // 3. Strict native response contracts:
    // (a) Session response without `{ "data": ... }` envelope is refused (`503 unavailable`).
    h.mock.lock().unwrap().raw_session = true;
    h.mock.lock().unwrap().rpc_calls.clear();
    let bare_attach = h
        .client
        .post(h.url("/fixture/attach"))
        .query(&[("directory", &dir)])
        .json(&json!({ "offerID": "offer_fixture", "sessionID": "ses_1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bare_attach.status(), Status::SERVICE_UNAVAILABLE);
    assert!(h.mock.lock().unwrap().rpc_calls.is_empty(), "bare session object must not authorize RPCs");
    h.mock.lock().unwrap().raw_session = false;

    // (b) `201 Created` on `bindingRead` RPC degrades to `{ "state": "unknown" }`, and `201` on `status` -> `unknown`.
    h.mock.lock().unwrap().rpc_outputs.insert(
        ("neuralnomads.fixture".into(), "bindingRead".into()),
        (
            Status::CREATED,
            json!({
                "output": {
                    "state": "attached",
                    "authority": binding_authority(),
                    "binding": { "offerID": "offer_fixture", "label": "Blender window" }
                }
            }),
        ),
    );
    let b201 = h
        .client
        .get(h.url("/fixture/binding"))
        .query(&[("directory", dir.as_str()), ("sessionID", "ses_1")])
        .send()
        .await
        .unwrap();
    assert_eq!(b201.status(), Status::OK);
    assert_eq!(b201.json::<Value>().await.unwrap(), json!({ "state": "unknown" }));
    h.mock.lock().unwrap().rpc_outputs.remove(&("neuralnomads.fixture".into(), "bindingRead".into()));

    h.mock.lock().unwrap().rpc_outputs.insert(
        ("neuralnomads.fixture".into(), "status".into()),
        (Status::CREATED, json!({ "output": ok_status("fixture", "native") })),
    );
    let s201 = h.client.get(h.url("")).query(&[("directory", &dir)]).send().await.unwrap();
    assert_eq!(s201.status(), Status::OK);
    let s201_body: Value = s201.json().await.unwrap();
    assert_eq!(s201_body["integrations"][0]["state"], "unknown");
    h.mock.lock().unwrap().rpc_outputs.remove(&("neuralnomads.fixture".into(), "status".into()));

    // (c) `200 OK` (instead of `204 No Content`) on `PATCH /api/session/:id` fails with `503 unavailable`.
    h.mock.lock().unwrap().patch_status = Some(Status::OK);
    let p200 = h
        .client
        .post(h.url("/fixture/attach"))
        .query(&[("directory", &dir)])
        .json(&json!({ "offerID": "offer_fixture", "sessionID": "ses_1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(p200.status(), Status::SERVICE_UNAVAILABLE);
    h.mock.lock().unwrap().patch_status = None;

    // 4. Queued status RPCs in `reader::read` do not dispatch after principal revocation.
    let h_rev = Harness::new().await;
    let dir_rev = h_rev.dir();
    let mut entries = Vec::new();
    let mut plugins = Vec::new();
    let mut rt = Vec::new();
    for idx in 1..=6 {
        let id = format!("int{idx}");
        let mut e = entry(&id, "api");
        e.rpc = format!("neuralnomads.{id}");
        e.plugin = format!("neuralnomads.{id}");
        e.package = format!("@neuralnomads/opencode-{id}");
        plugins.push(format!("{}@0.1.0", e.package));
        rt.push(json!({
            "id": e.plugin,
            "features": { "rpc": true },
            "source": { "type": "package", "target": format!("{}@0.1.0", e.package), "version": "0.1.0" },
            "state": { "status": "active" }
        }));
        entries.push(e);
    }
    h_rev.app.integration_catalog.seed_for_test(IntegrationCatalog { integrations: entries }).await;
    fs::write(&h_rev.global_file, serde_json::to_string(&json!({ "plugins": plugins })).unwrap()).unwrap();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    {
        let mut m = h_rev.mock.lock().unwrap();
        m.runtime = rt;
        m.hang_rpc = Some(("status".into(), entered.clone(), release.clone()));
    }
    let principal = tokio_util::sync::CancellationToken::new();
    let principal_clone = principal.clone();
    let app_rev = h_rev.app.clone();
    let ws_rev = h_rev.ws_id.to_string();
    let read_task = tokio::spawn(async move {
        reader::read_with_timeout(
            &app_rev,
            &ws_rev,
            &ControlLocation::new(dir_rev, None),
            Some(&principal_clone),
            Duration::from_secs(4),
        )
        .await
    });
    // Wait until the 4 concurrency slots are occupied, then revoke the principal and release.
    loop {
        let notified = entered.notified();
        if h_rev.mock.lock().unwrap().rpc_calls.len() >= 4 {
            break;
        }
        tokio::time::timeout(Duration::from_secs(2), notified).await.unwrap();
    }
    assert_eq!(h_rev.mock.lock().unwrap().rpc_calls.len(), 4);
    principal.cancel();
    release.notify_waiters();
    let err = read_task.await.unwrap().err();
    assert!(matches!(err, Some(crate::subagent_depth::Fail::Status(Status::UNAUTHORIZED, _))));
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        h_rev.mock.lock().unwrap().rpc_calls.len(),
        4,
        "queued status RPCs must not dispatch after principal revocation"
    );

    // 5. Local `auth::admit` 401 refusal on integrations path also carries `Cache-Control: no-store`.
    let local_auth_dir = TempDir(crate::shared::test_dir("int-local-auth"));
    let local_auth = auth::Auth::new(auth::Settings {
        username: auth::DEFAULT_USERNAME.into(),
        password: Some("local-pass".into()),
        file: None,
        cookie: auth::DEFAULT_COOKIE.into(),
        token: false,
        managed_local: false,
        skip: false,
        idle: Duration::from_secs(3600),
        absolute: Duration::from_secs(7200),
    })
    .unwrap();
    let local_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local_port = local_listener.local_addr().unwrap().port();
    let local_settings =
        settings::Settings::new(settings::document::Location::resolve(&local_auth_dir.0.to_string_lossy()));
    let (wtx, _wrx) = tokio::sync::mpsc::channel(4);
    let local_app = Arc::new(App::new(
        local_auth,
        local_port,
        local_auth_dir.0.clone(),
        local_auth_dir.0.clone(),
        false,
        local_settings,
        json!({}),
        Native::test_connection(local_listener.local_addr().unwrap()),
        PathBuf::new(),
        None,
        files::watch::Watches::new(wtx),
        None,
    ));
    let local_router = super::routes()
        .layer(axum::middleware::from_fn_with_state(local_app.clone(), auth::admit))
        .with_state(local_app);
    let local_task = tokio::spawn(async move { axum::serve(local_listener, local_router).await.unwrap() });
    let unauth = h
        .client
        .get(format!("http://127.0.0.1:{local_port}/api/workspaces/{}/integrations", h.ws_id))
        .query(&[("directory", dir.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), Status::UNAUTHORIZED);
    assert_eq!(unauth.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));
    local_task.abort();
}

#[tokio::test]
async fn round2_pinning_body_cancel_content_type_param_limit_trailing_slash_and_encoded_paths() {
    let h = Harness::new().await;
    h.seed_loaded_fixture().await;
    let dir = h.dir();

    // 1. Directory swap DURING the very first `/api/config` read inside `read_bound` is refused (`403`).
    for kind in ["install", "read", "hosts"] {
        let h_swap = Harness::new().await;
        h_swap.seed_loaded_fixture().await;
        let dir_swap = h_swap.dir();
        let swapped = h_swap.project_dir.clone();
        let moved = h_swap.root.join("swapped-on-first-config");
        let fired = Arc::new(AtomicUsize::new(0));
        let fired_cb = fired.clone();
        h_swap.mock.lock().unwrap().on_config_read = Some(Arc::new(move || {
            if fired_cb.fetch_add(1, Ordering::SeqCst) == 0 {
                fs::rename(&swapped, &moved).unwrap();
                fs::create_dir_all(&swapped).unwrap();
            }
        }));
        let resp = match kind {
            "install" => h_swap
                .client
                .post(h_swap.url("/mail/install"))
                .query(&[("directory", &dir_swap)])
                .json(&json!({ "scope": "global" }))
                .send()
                .await
                .unwrap(),
            "read" => h_swap.client.get(h_swap.url("")).query(&[("directory", &dir_swap)]).send().await.unwrap(),
            _ => {
                h_swap.client.get(h_swap.url("/fixture/hosts")).query(&[("directory", &dir_swap)]).send().await.unwrap()
            }
        };
        assert_eq!(resp.status(), Status::FORBIDDEN, "{kind} must refuse swap during initial snapshot read");
    }

    // 2. Principal cancellation aborts `status` RPC during stalled body read (strictly after headers arrived).
    let h_body = Harness::new().await;
    h_body.seed_loaded_fixture().await;
    let dir_body = h_body.dir();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let headers_received = Arc::new(Notify::new());
    h_body.mock.lock().unwrap().stall_rpc_body = Some(("status".into(), entered.clone(), release.clone()));
    let principal = tokio_util::sync::CancellationToken::new();
    let principal_cb = principal.clone();
    let headers_cb = headers_received.clone();
    let app_body = h_body.app.clone();
    let ws_body = h_body.ws_id.to_string();
    let started = std::time::Instant::now();
    let task = tokio::spawn(async move {
        reader::read_with_timeout_and_headers_hook(
            &app_body,
            &ws_body,
            &ControlLocation::new(dir_body, None),
            Some(&principal_cb),
            Duration::from_secs(6),
            headers_cb,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), entered.notified()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), headers_received.notified()).await.unwrap();
    principal.cancel();
    let body_res = tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap();
    assert!(matches!(body_res, Err(crate::subagent_depth::Fail::Status(Status::UNAUTHORIZED, _))));
    assert!(started.elapsed() < Duration::from_secs(2), "body read must abort promptly on principal cancellation");
    release.notify_waiters();

    // 3. Strict native Content-Type (`application/json`) and strict `RpcError` status (`400` only).
    h.mock.lock().unwrap().plain_session = true;
    h.mock.lock().unwrap().rpc_calls.clear();
    let plain_sess = h
        .client
        .post(h.url("/fixture/attach"))
        .query(&[("directory", &dir)])
        .json(&json!({ "offerID": "offer_fixture", "sessionID": "ses_1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(plain_sess.status(), Status::SERVICE_UNAVAILABLE);
    assert!(h.mock.lock().unwrap().rpc_calls.is_empty(), "text/plain session must not authorize RPCs");
    h.mock.lock().unwrap().plain_session = false;

    h.mock.lock().unwrap().plain_rpc = true;
    let plain_binding = h
        .client
        .get(h.url("/fixture/binding"))
        .query(&[("directory", dir.as_str()), ("sessionID", "ses_1")])
        .send()
        .await
        .unwrap();
    assert_eq!(plain_binding.status(), Status::OK);
    assert_eq!(plain_binding.json::<Value>().await.unwrap(), json!({ "state": "unknown" }));
    h.mock.lock().unwrap().plain_rpc = false;

    // `201 Created` carrying `RpcError` must NOT be classified as `409 unsupported` or `502 non-conforming`.
    h.mock.lock().unwrap().rpc_outputs.insert(
        ("neuralnomads.fixture".into(), "hosts".into()),
        (Status::CREATED, json!({ "_tag": "RpcError", "type": "rpc.unavailable", "message": "x" })),
    );
    let hosts_201_err = h.client.get(h.url("/fixture/hosts")).query(&[("directory", &dir)]).send().await.unwrap();
    assert_eq!(hosts_201_err.status(), Status::SERVICE_UNAVAILABLE);
    assert_eq!(hosts_201_err.json::<Value>().await.unwrap()["code"], "unavailable");
    h.mock.lock().unwrap().rpc_outputs.remove(&("neuralnomads.fixture".into(), "hosts".into()));

    h.mock.lock().unwrap().rpc_outputs.insert(
        ("neuralnomads.fixture".into(), "status".into()),
        (Status::CREATED, json!({ "_tag": "RpcError", "type": "rpc.unavailable", "message": "x" })),
    );
    let status_201_err = h.client.get(h.url("")).query(&[("directory", &dir)]).send().await.unwrap();
    assert_eq!(status_201_err.status(), Status::OK);
    assert_eq!(status_201_err.json::<Value>().await.unwrap()["integrations"][0]["state"], "unknown");
    h.mock.lock().unwrap().rpc_outputs.remove(&("neuralnomads.fixture".into(), "status".into()));

    // 4. Fastify `maxParamLength: 100` -> `integrationId` of 101 chars returns `404 no-store`, not `400`.
    let long_id = "a".repeat(101);
    let long_hosts =
        h.client.get(h.url(&format!("/{long_id}/hosts"))).query(&[("directory", &dir)]).send().await.unwrap();
    assert_eq!(long_hosts.status(), Status::NOT_FOUND);
    assert_eq!(long_hosts.headers()[header::CACHE_CONTROL], "no-store");
    let long_install = h
        .client
        .post(h.url(&format!("/{long_id}/install")))
        .query(&[("directory", &dir)])
        .header(header::CONTENT_TYPE, "application/xml")
        .body("<bad/>")
        .send()
        .await
        .unwrap();
    assert_eq!(long_install.status(), Status::NOT_FOUND);
    assert_eq!(long_install.headers()[header::CACHE_CONTROL], "no-store");

    // 5. Trailing-slash integration subpaths return `404 no-store` instead of falling through.
    for suffix in ["/fixture/", "/fixture/hosts/", "/fixture/unknown/", "/fixture/hosts/extra/"] {
        let resp = h.client.get(h.url(suffix)).send().await.unwrap();
        assert_eq!(resp.status(), Status::NOT_FOUND, "{suffix}");
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "no-store", "{suffix}");
    }

    // 6. `previews::admit_local` + `auth::admit` preserve `no-store` even on percent-encoded `/%61pi/...`.
    let local_dir = TempDir(crate::shared::test_dir("int-preview-local"));
    let local_auth = auth::Auth::new(auth::Settings {
        username: auth::DEFAULT_USERNAME.into(),
        password: Some("local-pass".into()),
        file: None,
        cookie: auth::DEFAULT_COOKIE.into(),
        token: false,
        managed_local: false,
        skip: false,
        idle: Duration::from_secs(3600),
        absolute: Duration::from_secs(7200),
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let local_settings = settings::Settings::new(settings::document::Location::resolve(&local_dir.0.to_string_lossy()));
    let (wtx, _wrx) = tokio::sync::mpsc::channel(4);
    let local_app = Arc::new(App::new(
        local_auth,
        port,
        local_dir.0.clone(),
        local_dir.0.clone(),
        false,
        local_settings,
        json!({}),
        Native::test_connection(listener.local_addr().unwrap()),
        PathBuf::new(),
        None,
        files::watch::Watches::new(wtx),
        None,
    ));
    let local_router = super::routes()
        .layer(axum::middleware::from_fn_with_state(local_app.clone(), auth::admit))
        .layer(axum::middleware::from_fn_with_state(local_app.clone(), crate::previews::admit_local))
        .with_state(local_app);
    let local_task = tokio::spawn(async move { axum::serve(listener, local_router).await.unwrap() });

    let preview_host = format!("00000000-0000-0000-0000-000000000000.preview.localhost:{port}");
    for target_path in [
        format!("/api/workspaces/{}/integrations/fixture/hosts", h.ws_id),
        format!("/%61pi/workspaces/{}/integrations/fixture/hosts", h.ws_id),
    ] {
        let prev_refused = h
            .client
            .get(format!("http://127.0.0.1:{port}{target_path}"))
            .header(header::HOST, &preview_host)
            .send()
            .await
            .unwrap();
        assert_eq!(prev_refused.status(), Status::NOT_FOUND, "{target_path}");
        assert_eq!(
            prev_refused.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()),
            Some("no-store"),
            "{target_path}"
        );
    }

    let encoded_refused = h
        .client
        .get(format!("http://127.0.0.1:{port}/%61pi/workspaces/{}/integrations/fixture/hosts", h.ws_id))
        .send()
        .await
        .unwrap();
    assert_eq!(encoded_refused.status(), Status::NOT_FOUND);
    assert_eq!(encoded_refused.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));

    // 7. Semicolon query delimiters (`integrations;directory=...`) get `no-store` across preview and auth refusals.
    assert!(super::is_integrations_path(&format!("/api/workspaces/{}/integrations;directory=/secret", h.ws_id)));
    assert!(super::is_integrations_path(&format!(
        "/api/workspaces/{}/integrations/fixture/hosts;directory=/secret",
        h.ws_id
    )));
    for semi_path in [
        format!("/api/workspaces/{}/integrations;directory=/secret", h.ws_id),
        format!("/api/workspaces/{}/integrations/fixture/hosts;directory=/secret", h.ws_id),
    ] {
        let semi_prev = h
            .client
            .get(format!("http://127.0.0.1:{port}{semi_path}"))
            .header(header::HOST, &preview_host)
            .send()
            .await
            .unwrap();
        assert_eq!(semi_prev.status(), Status::NOT_FOUND, "{semi_path}");
        assert_eq!(
            semi_prev.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()),
            Some("no-store"),
            "{semi_path}"
        );
        let semi_auth = h.client.get(format!("http://127.0.0.1:{port}{semi_path}")).send().await.unwrap();
        assert_eq!(semi_auth.status(), Status::UNAUTHORIZED, "{semi_path}");
        assert_eq!(
            semi_auth.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()),
            Some("no-store"),
            "{semi_path}"
        );
    }
    local_task.abort();

    // 8. Fully percent-encoded 36-char UUID (`108` raw chars, `36` decoded) passes Fastify `maxParamLength: 100`.
    let encoded_ws_id: String = h.ws_id.to_string().bytes().map(|b| format!("%{b:02X}")).collect();
    assert_eq!(encoded_ws_id.len(), 108);
    let encoded_ws_resp = h
        .client
        .get(format!("{}/api/workspaces/{encoded_ws_id}/integrations", h.base))
        .query(&[("directory", &dir)])
        .send()
        .await
        .unwrap();
    assert_eq!(encoded_ws_resp.status(), Status::OK);

    // 9. `capture_location_pin` rejects non-canonical paths and `pin_still_live_sync` rejects a replaced
    // workspace root even while an independent target directory stays untouched.
    let pin_root = TempDir(crate::shared::test_dir("int-pin-root"));
    let root_a = pin_root.0.join("root-a");
    let wt_b = pin_root.0.join("wt-b");
    fs::create_dir_all(&root_a).unwrap();
    fs::create_dir_all(&wt_b).unwrap();
    let root_canon = dunce::canonicalize(&root_a).unwrap();
    let wt_canon = dunce::canonicalize(&wt_b).unwrap();
    let mut fake_ws = h.app.workspace(&h.ws_id.to_string()).unwrap();
    fake_ws.path = root_canon.clone();
    // Non-canonical `..` path must be rejected by `capture_location_pin` (never recorded as a pin).
    let non_canon = wt_canon.join("..").join("wt-b").to_string_lossy().into_owned();
    assert!(crate::plugin_controls::engine::capture_location_pin(&fake_ws, &non_canon).await.is_none());

    let wt_str = wt_canon.to_string_lossy().into_owned();
    let pin = crate::plugin_controls::engine::capture_location_pin(&fake_ws, &wt_str).await.unwrap();
    assert!(crate::plugin_controls::engine::pin_still_live_sync(&root_canon, &wt_str, &pin));

    // Replacing the workspace root while `wt-b` stays in place must invalidate the pin immediately.
    let root_moved = pin_root.0.join("root-moved");
    fs::rename(&root_canon, &root_moved).unwrap();
    fs::create_dir_all(&root_canon).unwrap();
    assert!(
        !crate::plugin_controls::engine::pin_still_live_sync(&root_canon, &wt_str, &pin),
        "swapped workspace root must fail pre-write commit pin check even when linked worktree stays untouched"
    );

    // 10. A missing target subfolder pins its nearest existing ancestor's physical identity:
    // replacing that parent at the same path while root stays untouched invalidates the pin.
    let missing_root = TempDir(crate::shared::test_dir("int-pin-missing-ancestor"));
    let m_root = dunce::canonicalize(&missing_root.0).unwrap();
    let parent_dir = m_root.join("parent");
    fs::create_dir_all(&parent_dir).unwrap();
    let missing_leaf = parent_dir.join("absent-child").to_string_lossy().into_owned();
    let mut missing_ws = h.app.workspace(&h.ws_id.to_string()).unwrap();
    missing_ws.path = m_root.clone();
    let missing_pin = crate::plugin_controls::engine::capture_location_pin(&missing_ws, &missing_leaf).await.unwrap();
    assert!(crate::plugin_controls::engine::pin_still_live_sync(&m_root, &missing_leaf, &missing_pin));
    let parent_moved = m_root.join("parent-moved");
    fs::rename(&parent_dir, &parent_moved).unwrap();
    fs::create_dir_all(&parent_dir).unwrap();
    assert!(
        !crate::plugin_controls::engine::pin_still_live_sync(&m_root, &missing_leaf, &missing_pin),
        "swapped nearest existing ancestor of a missing location must invalidate the pin"
    );
}
