use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Request, State},
    http::{Method, StatusCode as Status},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use uuid::Uuid;

use super::*;
use crate::{
    App, auth,
    events::{Next, Sub},
    files, meta,
    opencode::Native,
    settings, workspaces,
};

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

#[derive(Default)]
struct NativeMock {
    sessions: Vec<Value>,
    /// Extra sessions returned only by `parentID=` queries, simulating a descendant whose
    /// `time_updated` shifted across global pagination boundaries.
    parent_only_sessions: Vec<Value>,
    active: serde_json::Map<String, Value>,
    malformed_active: bool,
    carrier: Option<String>,
    removed: Vec<String>,
    repeat_cursor: bool,
    malformed_cursor: bool,
    session_list_queries: Vec<String>,
    /// Optional hook executed when `/api/session/active` is queried, used to simulate a file
    /// arriving between `onlyIfEmpty`'s initial empty check and the atomic `rmdir`.
    on_active: Option<Box<dyn Fn() + Send + Sync>>,
    /// Optional one-shot async pause on `DELETE /api/session/{id}`, used to drop the discard
    /// caller mid-flight and prove the detached discard finishes atomically.
    on_delete: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
}

async fn fake_native(State(mock): State<Arc<Mutex<NativeMock>>>, req: Request) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let query = req.uri().query().unwrap_or_default().to_owned();
    let body = axum::body::to_bytes(req.into_body(), 1024 * 1024).await.unwrap_or_default();

    if method == Method::GET && path == "/api/location" {
        let dir = reqwest::Url::parse(&format!("http://127.0.0.1/?{query}"))
            .ok()
            .and_then(|u| u.query_pairs().find(|(k, _)| k == "location[directory]").map(|(_, v)| v.into_owned()))
            .unwrap_or_default();
        return Json(json!({ "data": { "directory": dir } })).into_response();
    }
    if method == Method::GET && path == "/api/session" {
        let parsed = reqwest::Url::parse(&format!("http://127.0.0.1/?{query}")).ok();
        let filter_dir =
            parsed.as_ref().and_then(|u| u.query_pairs().find(|(k, _)| k == "directory").map(|(_, v)| v.into_owned()));
        let filter_parent =
            parsed.as_ref().and_then(|u| u.query_pairs().find(|(k, _)| k == "parentID").map(|(_, v)| v.into_owned()));
        let (mut data, parent_only, repeat, malformed) = {
            let mut guard = mock.lock().unwrap();
            guard.session_list_queries.push(query.clone());
            (guard.sessions.clone(), guard.parent_only_sessions.clone(), guard.repeat_cursor, guard.malformed_cursor)
        };
        if let Some(parent) = filter_parent {
            data.extend(parent_only);
            data.retain(|row| row["parentID"].as_str() == Some(parent.as_str()));
        } else if let Some(exact) = filter_dir {
            // Mirror OpenCode's exact-equality directory filter so tests catch missing subfolder queries.
            data.retain(|row| row["location"]["directory"].as_str() == Some(exact.as_str()));
        }
        if malformed {
            return Json(json!({ "data": data, "cursor": { "next": "" } })).into_response();
        }
        let cursor = if repeat { json!({ "next": "stuck-cursor" }) } else { json!({}) };
        return Json(json!({ "data": data, "cursor": cursor })).into_response();
    }
    if method == Method::GET && path == "/api/session/active" {
        let (active, malformed) = {
            let guard = mock.lock().unwrap();
            if let Some(hook) = guard.on_active.as_ref() {
                hook();
            }
            (guard.active.clone(), guard.malformed_active)
        };
        if malformed {
            return Json(json!({ "data": null })).into_response();
        }
        return Json(json!({ "data": active })).into_response();
    }
    if method == Method::POST && path == "/api/rpc/codenomad.missions/scheduleCarrierRead" {
        let parsed: Value = serde_json::from_slice(&body).unwrap_or_default();
        let sid = parsed["input"]["sessionID"].as_str().unwrap_or_default();
        let owned = mock.lock().unwrap().carrier.as_deref() == Some(sid);
        return Json(json!({ "output": { "owned": owned } })).into_response();
    }
    if method == Method::GET
        && let Some(sid) = path.strip_prefix("/api/session/")
    {
        let found = {
            let guard = mock.lock().unwrap();
            guard
                .sessions
                .iter()
                .chain(guard.parent_only_sessions.iter())
                .find(|s| s["id"].as_str() == Some(sid))
                .cloned()
        };
        return match found {
            Some(row) => Json(json!({ "data": row })).into_response(),
            None => (Status::NOT_FOUND, Json(json!({ "_tag": "SessionNotFoundError" }))).into_response(),
        };
    }
    if method == Method::DELETE
        && let Some(sid) = path.strip_prefix("/api/session/")
    {
        let pause = {
            let mut guard = mock.lock().unwrap();
            guard.removed.push(sid.to_owned());
            guard.on_delete.take()
        };
        if let Some((reached, release)) = pause {
            reached.notify_one();
            release.notified().await;
        }
        if sid == "ses_already_gone" {
            return (Status::NOT_FOUND, Json(json!({ "_tag": "SessionNotFoundError", "sessionID": sid })))
                .into_response();
        }
        return Status::NO_CONTENT.into_response();
    }
    (Status::NOT_FOUND, Json(json!({ "error": format!("unhandled {method} {path}") }))).into_response()
}

struct Harness {
    root: PathBuf,
    app: Shared,
    mock: Arc<Mutex<NativeMock>>,
    base: String,
    client: reqwest::Client,
    native_task: tokio::task::JoinHandle<()>,
    server_task: tokio::task::JoinHandle<()>,
    _dir: TempDir,
}

impl Harness {
    async fn new(unrestricted: bool) -> Self {
        let dir = TempDir::new("cn-temp-ws");
        let root = dir.0.join("workspace-root");
        let config_dir = dir.0.join("config");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&config_dir).unwrap();

        let mock = Arc::new(Mutex::new(NativeMock::default()));
        let native_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native = Native::test_connection(native_listener.local_addr().unwrap());
        let mock_clone = mock.clone();
        let native_task = tokio::spawn(async move {
            axum::serve(native_listener, Router::new().fallback(any(fake_native)).with_state(mock_clone))
                .await
                .unwrap();
        });

        let server_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server_addr = server_listener.local_addr().unwrap();

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
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let settings = settings::Settings::new(settings::document::Location::resolve(
            config_dir.join("config.yaml").to_str().unwrap(),
        ));
        let meta_doc = meta::document(Some(Uuid::new_v4()), server_addr.port(), &root, None, json!({})).unwrap();
        let app = Arc::new(App::new(
            auth,
            server_addr.port(),
            dir.0.clone(),
            root.clone(),
            unrestricted,
            settings,
            meta_doc,
            native,
            PathBuf::new(),
            None,
            files::watch::Watches::new(tx),
            None,
        ));
        let router = Router::new()
            .merge(meta::routes())
            .merge(routes())
            .merge(workspaces::routes())
            .layer(axum::middleware::from_fn_with_state(app.clone(), auth::admit))
            .with_state(app.clone());
        let server_task = tokio::spawn(async move {
            axum::serve(server_listener, router).await.unwrap();
        });
        Self {
            _dir: dir,
            root,
            app,
            mock,
            base: format!("http://{server_addr}"),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            native_task,
            server_task,
        }
    }

    fn drain_events(&self, sub: &Sub) -> Vec<Value> {
        let mut out = Vec::new();
        while let Next::Frame(frame) = self.app.events.pop(sub) {
            if let Ok(v) = serde_json::from_str::<Value>(&frame) {
                out.push(v);
            }
        }
        out
    }

    async fn open_workspace(&self, folder: &str, request_id: Option<&str>) -> Value {
        let mut body = json!({ "path": folder });
        if let Some(req_id) = request_id {
            body["requestId"] = json!(req_id);
        }
        let resp = self.client.post(format!("{}/api/workspaces", self.base)).json(&body).send().await.unwrap();
        assert_eq!(resp.status(), Status::CREATED);
        resp.json().await.unwrap()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server_task.abort();
        self.native_task.abort();
    }
}

#[tokio::test]
async fn registry_prunes_missing_and_out_of_root_entries_on_reopen_and_rejects_corrupt_json() {
    let dir = TempDir::new("cn-temp-registry");
    let root = dir.0.join("temporary-workspaces");
    let file = dir.0.join("temporary-workspaces.json");

    let reg = TemporaryFolderRegistry::open(root.clone(), file.clone(), Path::new("")).unwrap();
    let kept = reg.root().join(create_unique_folder(&reg.root_dir).unwrap()).to_string_lossy().into_owned();
    let deleted = reg.root().join(create_unique_folder(&reg.root_dir).unwrap()).to_string_lossy().into_owned();
    // Write a legacy TS-format registry (no sidecar identities file); reopen must adopt and persist identities sidecar.
    fs::write(&file, serde_json::to_string_pretty(&json!({ "folders": [kept, deleted] })).unwrap()).unwrap();
    drop(reg);
    let identities_file = dir.0.join("temporary-workspaces.json.identities");
    let reg = TemporaryFolderRegistry::open(root.clone(), file.clone(), Path::new("")).unwrap();
    assert!(reg.has(Path::new(&kept)));
    assert!(reg.has(Path::new(&deleted)));
    assert!(!reg.has(&dir.0.join("elsewhere")));
    let sidecar: Value = serde_json::from_str(&fs::read_to_string(&identities_file).unwrap()).unwrap();
    assert!(sidecar["identities"].as_object().is_some_and(|m| m.contains_key(&kept) && m.contains_key(&deleted)));

    fs::remove_dir_all(&deleted).unwrap();
    let mut saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    saved["folders"].as_array_mut().unwrap().push(json!(dir.0.join("outside-root")));
    fs::write(&file, serde_json::to_string_pretty(&saved).unwrap()).unwrap();

    let reopened = TemporaryFolderRegistry::open(root.clone(), file.clone(), Path::new("")).unwrap();
    assert!(reopened.has(Path::new(&kept)));
    assert!(!reopened.has(Path::new(&deleted)));
    let persisted: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(persisted, json!({ "folders": [kept] }));

    // Rust -> TS -> Rust round-trip: TS rewrites `temporary-workspaces.json` with only `folders`
    // (adding a new TS-created folder), while `kept` is replaced on disk by a different directory.
    // The sidecar preserves `kept`'s original identity proof so reopening prunes `kept` instead of
    // adopting the replacement, while legitimately adopting the brand-new TS folder.
    let ts_created =
        reopened.root().join(create_unique_folder(&reopened.root_dir).unwrap()).to_string_lossy().into_owned();
    drop(reopened);
    drop(reg);
    fs::write(&file, serde_json::to_string_pretty(&json!({ "folders": [kept, ts_created] })).unwrap()).unwrap();
    let parked = dir.0.join("parked-original");
    fs::rename(&kept, &parked).unwrap();
    fs::create_dir(&kept).unwrap();
    let after_roundtrip = TemporaryFolderRegistry::open(root.clone(), file.clone(), Path::new("")).unwrap();
    assert!(
        !after_roundtrip.has(Path::new(&kept)),
        "replaced folder must not be adopted even after TS rewrote folders"
    );
    assert!(after_roundtrip.has(Path::new(&ts_created)), "new TS-created folder must be adopted");
    let persisted_after: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(persisted_after, json!({ "folders": [ts_created] }));
    drop(after_roundtrip);

    // Corrupt sidecar fails closed instead of weakening identity checks.
    fs::write(&identities_file, "{ invalid").unwrap();
    assert!(TemporaryFolderRegistry::open(root.clone(), file.clone(), Path::new("")).is_err());
    let _ = fs::remove_file(&identities_file);

    fs::write(&file, "{ invalid json").unwrap();
    assert!(TemporaryFolderRegistry::open(root, file, Path::new("")).is_err());
}

#[tokio::test]
async fn create_open_delete_retains_folder_and_keep_clears_temporary_flag() {
    let h = Harness::new(true).await;
    let sub = h.app.events.subscribe();

    let meta_body: Value = h.client.get(format!("{}/api/meta", h.base)).send().await.unwrap().json().await.unwrap();
    assert!(meta_body["capabilities"].as_array().unwrap().iter().any(|c| c == "temporary-workspaces"));

    let created = h.client.post(format!("{}/api/workspaces/temporary", h.base)).send().await.unwrap();
    assert_eq!(created.status(), Status::CREATED);
    let created_body: Value = created.json().await.unwrap();
    let folder = created_body["path"].as_str().unwrap().to_owned();
    assert_eq!(created_body["supportsCancelAndAbandon"], true);
    assert_eq!(Path::new(&folder).parent(), Some(h.app.temporary_workspaces.as_ref().unwrap().root()));

    let events = h.drain_events(&sub);
    assert!(events.iter().any(|e| e["type"] == "workspace.temporaryChanged" && e["folders"] == json!([folder])));

    fs::write(Path::new(&folder).join("draft.txt"), "keep me").unwrap();

    // Open two tabs on the same temporary folder; closing one with DELETE retains folder and emits temporaryRetained.
    let closing = h.open_workspace(&folder, None).await;
    assert_eq!(closing["temporary"], true);
    let peer = h.open_workspace(&folder, None).await;
    assert_eq!(peer["temporary"], true);
    let _ = h.drain_events(&sub);

    let del =
        h.client.delete(format!("{}/api/workspaces/{}", h.base, closing["id"].as_str().unwrap())).send().await.unwrap();
    assert_eq!(del.status(), Status::NO_CONTENT);
    let events = h.drain_events(&sub);
    assert!(events.iter().any(|e| {
        e["type"] == "workspace.stopped" && e["workspaceId"] == closing["id"] && e["temporaryRetained"] == true
    }));
    assert_eq!(fs::read_to_string(Path::new(&folder).join("draft.txt")).unwrap(), "keep me");

    // Keep unregisters the folder, clears `temporary` on open tab, leaves files intact, and emits temporaryChanged.
    let kept =
        h.client.post(format!("{}/api/workspaces/{}/keep", h.base, peer["id"].as_str().unwrap())).send().await.unwrap();
    assert_eq!(kept.status(), Status::NO_CONTENT);
    let peer_after: Value = h
        .client
        .get(format!("{}/api/workspaces/{}", h.base, peer["id"].as_str().unwrap()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(peer_after.get("temporary").is_none());
    assert!(Path::new(&folder).is_dir());

    let events = h.drain_events(&sub);
    assert!(events.iter().any(|e| e["type"] == "workspace.temporaryChanged" && e["folders"] == json!([])));

    // Second keep fails with 400 temporary_not_temporary; unknown workspace fails with 404 temporary_not_found.
    let again =
        h.client.post(format!("{}/api/workspaces/{}/keep", h.base, peer["id"].as_str().unwrap())).send().await.unwrap();
    assert_eq!(again.status(), Status::BAD_REQUEST);
    assert_eq!(again.json::<Value>().await.unwrap()["error"], "temporary_not_temporary");

    let missing = h.client.post(format!("{}/api/workspaces/{}/keep", h.base, Uuid::new_v4())).send().await.unwrap();
    assert_eq!(missing.status(), Status::NOT_FOUND);
    assert_eq!(missing.json::<Value>().await.unwrap()["error"], "temporary_not_found");
}

#[tokio::test]
async fn restricted_scope_disables_out_of_scope_temporary_workspaces_consistently() {
    // config_dir is a sibling of workspace-root, outside app.scope when unrestricted == false.
    let h = Harness::new(false).await;
    assert!(h.app.temporary_workspaces.is_none());

    let meta_body: Value = h.client.get(format!("{}/api/meta", h.base)).send().await.unwrap().json().await.unwrap();
    assert!(!meta_body["capabilities"].as_array().unwrap().iter().any(|c| c == "temporary-workspaces"));

    // GET returns 200 {"folders":[]} (TS routes/temporary-workspaces.ts:38), mutations return 503.
    let listed = h.client.get(format!("{}/api/workspaces/temporary", h.base)).send().await.unwrap();
    assert_eq!(listed.status(), Status::OK);
    assert_eq!(listed.json::<Value>().await.unwrap(), json!({ "folders": [] }));

    let create_res = h.client.post(format!("{}/api/workspaces/temporary", h.base)).send().await.unwrap();
    assert_eq!(create_res.status(), Status::SERVICE_UNAVAILABLE);
    assert_eq!(create_res.json::<Value>().await.unwrap(), json!({ "error": "Temporary workspaces are unavailable" }));
}

#[tokio::test]
async fn abandon_validates_state_cancels_creation_request_and_removes_only_empty_folder() {
    let h = Harness::new(true).await;
    let sub = h.app.events.subscribe();

    let create_temp = || async {
        let resp: Value =
            h.client.post(format!("{}/api/workspaces/temporary", h.base)).send().await.unwrap().json().await.unwrap();
        resp["path"].as_str().unwrap().to_owned()
    };

    let unused = create_temp().await;
    let non_empty = create_temp().await;
    let open = create_temp().await;
    let pending = create_temp().await;

    fs::write(Path::new(&non_empty).join("notes.md"), "keep me").unwrap();
    let _open_ws = h.open_workspace(&open, None).await;
    let _pending_ws = h.open_workspace(&pending, Some("pending-request")).await;
    let _ = h.drain_events(&sub);

    // Unregistered folder -> 400 temporary_not_temporary.
    let bad = h
        .client
        .post(format!("{}/api/workspaces/temporary/abandon", h.base))
        .json(&json!({ "path": h.root }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), Status::BAD_REQUEST);
    assert_eq!(bad.json::<Value>().await.unwrap()["error"], "temporary_not_temporary");

    // Non-empty folder -> 409 temporary_not_empty.
    let full = h
        .client
        .post(format!("{}/api/workspaces/temporary/abandon", h.base))
        .json(&json!({ "path": non_empty }))
        .send()
        .await
        .unwrap();
    assert_eq!(full.status(), Status::CONFLICT);
    assert_eq!(full.json::<Value>().await.unwrap()["error"], "temporary_not_empty");

    // Open in tab -> 409 temporary_open_elsewhere (including case-differing path on Windows).
    let open_probe = if cfg!(windows) { open.to_uppercase() } else { open.clone() };
    let conflict = h
        .client
        .post(format!("{}/api/workspaces/temporary/abandon", h.base))
        .json(&json!({ "path": open_probe }))
        .send()
        .await
        .unwrap();
    assert_eq!(conflict.status(), Status::CONFLICT);
    assert_eq!(conflict.json::<Value>().await.unwrap()["error"], "temporary_open_elsewhere");

    // Unused empty folder -> 204 and deleted from disk & registry.
    let ok = h
        .client
        .post(format!("{}/api/workspaces/temporary/abandon", h.base))
        .json(&json!({ "path": unused }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), Status::NO_CONTENT);
    assert!(!Path::new(&unused).exists());

    // Pending workspace abandoned with requestId -> cancels creation, closes tab, removes empty folder.
    let cancelled = h
        .client
        .post(format!("{}/api/workspaces/temporary/abandon", h.base))
        .json(&json!({ "path": pending, "requestId": "pending-request" }))
        .send()
        .await
        .unwrap();
    assert_eq!(cancelled.status(), Status::NO_CONTENT);
    assert!(!Path::new(&pending).exists());

    let listed: Value =
        h.client.get(format!("{}/api/workspaces/temporary", h.base)).send().await.unwrap().json().await.unwrap();
    assert_eq!(listed["folders"], json!([non_empty, open]));
}

#[tokio::test]
async fn discard_enforces_only_if_empty_atomicity_guards_null_body_and_failed_removal_retention() {
    let h = Harness::new(true).await;
    let create_temp = || async {
        h.client
            .post(format!("{}/api/workspaces/temporary", h.base))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()["path"]
            .as_str()
            .unwrap()
            .to_owned()
    };

    let folder = create_temp().await;
    let ws = h.open_workspace(&folder, None).await;
    let id = ws["id"].as_str().unwrap();

    // 0. Non-object JSON bodies and non-JSON Content-Type (e.g. `text/plain` with `{}` / `null`)
    // are rejected without touching sessions, tabs or files.
    for (ct, invalid_body, expected) in [
        ("application/json", "[]", Status::BAD_REQUEST),
        ("application/json", "[true]", Status::BAD_REQUEST),
        ("application/json", "\"yes\"", Status::BAD_REQUEST),
        ("application/json", "123", Status::BAD_REQUEST),
        ("application/json", "true", Status::BAD_REQUEST),
        ("application/json", "{\"onlyIfEmpty\":\"yes\"}", Status::BAD_REQUEST),
        ("text/plain", "{}", Status::BAD_REQUEST),
        ("text/plain", "null", Status::BAD_REQUEST),
        ("application/octet-stream", "{}", Status::UNSUPPORTED_MEDIA_TYPE),
    ] {
        let bad = h
            .client
            .post(format!("{}/api/workspaces/{id}/discard", h.base))
            .header("content-type", ct)
            .body(invalid_body)
            .send()
            .await
            .unwrap();
        assert_eq!(bad.status(), expected, "expected {expected} for {ct} body {invalid_body}");
    }
    assert!(h.app.workspace(id).is_ok());
    assert!(Path::new(&folder).is_dir());

    // 1. onlyIfEmpty refuses conversations.
    h.mock.lock().unwrap().sessions = vec![json!({ "id": "ses_root", "location": { "directory": folder } })];
    let has_conv = h
        .client
        .post(format!("{}/api/workspaces/{id}/discard", h.base))
        .json(&json!({ "onlyIfEmpty": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(has_conv.status(), Status::CONFLICT);
    assert_eq!(has_conv.json::<Value>().await.unwrap()["error"], "temporary_has_conversations");

    // 2. onlyIfEmpty refuses files created AFTER the initial read_dir check without deleting the file or closing the tab.
    h.mock.lock().unwrap().sessions.clear();
    let late_file = Path::new(&folder).join("arrived-late.txt");
    let late_clone = late_file.clone();
    h.mock.lock().unwrap().on_active = Some(Box::new(move || {
        let _ = fs::write(&late_clone, "must survive");
    }));
    let late_res = h
        .client
        .post(format!("{}/api/workspaces/{id}/discard", h.base))
        .json(&json!({ "onlyIfEmpty": true }))
        .send()
        .await
        .unwrap();
    h.mock.lock().unwrap().on_active = None;
    assert_eq!(late_res.status(), Status::CONFLICT);
    assert_eq!(late_res.json::<Value>().await.unwrap()["error"], "temporary_not_empty");
    assert_eq!(fs::read_to_string(&late_file).unwrap(), "must survive");
    assert!(h.app.workspace(id).is_ok());

    // 3. Running session blocks discard without removing anything.
    h.mock.lock().unwrap().sessions = vec![json!({ "id": "ses_root", "location": { "directory": folder } })];
    h.mock.lock().unwrap().active.insert("ses_root".into(), json!({ "type": "busy" }));
    let running = h.client.post(format!("{}/api/workspaces/{id}/discard", h.base)).send().await.unwrap();
    assert_eq!(running.status(), Status::CONFLICT);
    assert_eq!(running.json::<Value>().await.unwrap()["error"], "temporary_running");
    h.mock.lock().unwrap().active.clear();

    // 4. Unmarked technical schedule carrier blocks discard before deleting ANY session or folder.
    h.mock.lock().unwrap().sessions = vec![
        json!({ "id": "ses_ordinary", "location": { "directory": folder } }),
        json!({ "id": "ses_carrier", "location": { "directory": folder } }),
    ];
    h.mock.lock().unwrap().carrier = Some("ses_carrier".into());
    let carrier = h.client.post(format!("{}/api/workspaces/{id}/discard", h.base)).send().await.unwrap();
    assert_eq!(carrier.status(), Status::FORBIDDEN);
    assert!(h.mock.lock().unwrap().removed.is_empty());
    assert!(Path::new(&folder).is_dir());
    h.mock.lock().unwrap().carrier = None;

    // 5. Duplicate open tab (and descendant tab) blocks discard without removing anything.
    let nested = Path::new(&folder).join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("script.py"), "print(1)").unwrap();
    let desc = h.open_workspace(&nested.to_string_lossy(), None).await;
    let dup_res = h.client.post(format!("{}/api/workspaces/{id}/discard", h.base)).send().await.unwrap();
    assert_eq!(dup_res.status(), Status::CONFLICT);
    assert_eq!(dup_res.json::<Value>().await.unwrap()["error"], "temporary_open_elsewhere");
    assert!(h.mock.lock().unwrap().removed.is_empty());

    let del_desc =
        h.client.delete(format!("{}/api/workspaces/{}", h.base, desc["id"].as_str().unwrap())).send().await.unwrap();
    assert_eq!(del_desc.status(), Status::NO_CONTENT);

    // 6. Full discard with JSON `null` body removes sessions deepest-first, ignores 404, skips foreign, removes folder.
    h.mock.lock().unwrap().sessions = vec![
        json!({ "id": "ses_root", "location": { "directory": folder } }),
        json!({ "id": "ses_child", "parentID": "ses_root", "location": { "directory": folder } }),
        json!({ "id": "ses_already_gone", "parentID": "ses_child", "location": { "directory": nested } }),
        json!({ "id": "ses_foreign", "location": { "directory": h.root } }),
    ];

    let sub = h.app.events.subscribe();
    let ok = h
        .client
        .post(format!("{}/api/workspaces/{id}/discard", h.base))
        .header("content-type", "application/json")
        .body("null")
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), Status::NO_CONTENT);
    assert_eq!(h.mock.lock().unwrap().removed, vec!["ses_already_gone", "ses_child", "ses_root"]);
    assert!(!Path::new(&folder).exists());
    assert!(h.app.workspace(id).is_err());

    let events = h.drain_events(&sub);
    let stopped = events
        .iter()
        .find(|e| e["type"] == "workspace.stopped" && e["workspaceId"] == id)
        .expect("workspace.stopped event");
    assert!(stopped.get("temporaryRetained").is_none());
    assert!(events.iter().any(|e| e["type"] == "workspace.temporaryChanged" && e["folders"] == json!([])));

    // 7. Subfolder conversations, `location.workspaceID` sessions, external moved descendants,
    // and malformed/repeated pagination cursors are handled strictly without silent deletion.
    let ws_id_folder = create_temp().await;
    let ws_sub = Path::new(&ws_id_folder).join("sub");
    fs::create_dir_all(&ws_sub).unwrap();
    let ws_id_open = h.open_workspace(&ws_id_folder, None).await;
    let ws_id = ws_id_open["id"].as_str().unwrap();
    {
        let mut mock = h.mock.lock().unwrap();
        mock.sessions = vec![
            json!({
                "id": "ses_with_wsid",
                "location": { "directory": ws_sub, "workspaceID": "wrk_1" }
            }),
            json!({
                "id": "ses_moved_child",
                "parentID": "ses_with_wsid",
                "location": { "directory": h.root }
            }),
        ];
        mock.repeat_cursor = true;
    }
    let bad_cursor = h.client.post(format!("{}/api/workspaces/{ws_id}/discard", h.base)).send().await.unwrap();
    assert_eq!(bad_cursor.status(), Status::BAD_GATEWAY);
    assert!(Path::new(&ws_id_folder).exists(), "repeated cursor must abort before deletion");

    {
        let mut mock = h.mock.lock().unwrap();
        mock.repeat_cursor = false;
        mock.malformed_cursor = true;
    }
    let empty_next = h.client.post(format!("{}/api/workspaces/{ws_id}/discard", h.base)).send().await.unwrap();
    assert_eq!(empty_next.status(), Status::BAD_GATEWAY);
    assert!(Path::new(&ws_id_folder).exists(), "empty next cursor must abort before deletion");

    h.mock.lock().unwrap().malformed_cursor = false;
    let blocked_wsid = h
        .client
        .post(format!("{}/api/workspaces/{ws_id}/discard", h.base))
        .json(&json!({ "onlyIfEmpty": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(blocked_wsid.status(), Status::CONFLICT);
    assert_eq!(blocked_wsid.json::<Value>().await.unwrap()["error"], "temporary_has_conversations");

    // External moved descendant missed by global pagination is still discovered via `parentID=`
    // BFS and blocks full discard so recursive native delete never wipes a foreign child.
    {
        let mut mock = h.mock.lock().unwrap();
        mock.sessions = vec![json!({
            "id": "ses_with_wsid",
            "location": { "directory": ws_sub, "workspaceID": "wrk_1" }
        })];
        mock.parent_only_sessions = vec![json!({
            "id": "ses_moved_child",
            "parentID": "ses_with_wsid",
            "location": { "directory": h.root }
        })];
        mock.removed.clear();
    }
    let blocked_ext = h.client.post(format!("{}/api/workspaces/{ws_id}/discard", h.base)).send().await.unwrap();
    assert_eq!(blocked_ext.status(), Status::CONFLICT);
    assert_eq!(blocked_ext.json::<Value>().await.unwrap()["error"], "temporary_open_elsewhere");
    assert!(h.mock.lock().unwrap().removed.is_empty());
    assert!(Path::new(&ws_id_folder).exists());

    // Malformed `/api/session/active` (`{"data": null}`) fails closed with 502 instead of deleting.
    {
        let mut mock = h.mock.lock().unwrap();
        mock.parent_only_sessions.clear();
        mock.malformed_active = true;
    }
    let bad_active = h.client.post(format!("{}/api/workspaces/{ws_id}/discard", h.base)).send().await.unwrap();
    assert_eq!(bad_active.status(), Status::BAD_GATEWAY);
    assert!(Path::new(&ws_id_folder).exists());

    // Once only the subfolder session remains and active response is valid, full discard succeeds.
    {
        let mut mock = h.mock.lock().unwrap();
        mock.malformed_active = false;
        mock.session_list_queries.clear();
    }
    let full_wsid = h.client.post(format!("{}/api/workspaces/{ws_id}/discard", h.base)).send().await.unwrap();
    assert_eq!(full_wsid.status(), Status::NO_CONTENT);
    assert_eq!(h.mock.lock().unwrap().removed, vec!["ses_with_wsid"]);
    {
        let queries = h.mock.lock().unwrap().session_list_queries.clone();
        assert!(queries.iter().any(|q| q.contains("order=asc") && q.contains("limit=200") && !q.contains("parentID=")));
        assert!(
            queries.iter().any(|q| {
                q.contains("parentID=ses_with_wsid") && q.contains("order=asc") && q.contains("limit=200")
            })
        );
    }
    assert!(!Path::new(&ws_id_folder).exists());

    // 7b. Swapping the temporary folder with a different directory before discard fails with 409
    // BEFORE deleting any conversations, closing the tab, or touching the replacement directory.
    let swapped = create_temp().await;
    let swapped_ws = h.open_workspace(&swapped, None).await;
    let swapped_id = swapped_ws["id"].as_str().unwrap();
    {
        let mut mock = h.mock.lock().unwrap();
        mock.sessions = vec![json!({ "id": "ses_survive_swap", "location": { "directory": swapped } })];
        mock.removed.clear();
    }
    let parked_dir = h._dir.0.join("parked-swapped");
    fs::rename(&swapped, &parked_dir).unwrap();
    fs::create_dir(&swapped).unwrap();
    fs::write(Path::new(&swapped).join("precious.txt"), "do not delete").unwrap();
    let swap_conflict = h.client.post(format!("{}/api/workspaces/{swapped_id}/discard", h.base)).send().await.unwrap();
    assert_eq!(swap_conflict.status(), Status::CONFLICT);
    assert!(
        h.mock.lock().unwrap().removed.is_empty(),
        "conversations must not be deleted when folder identity already changed"
    );
    assert!(h.app.workspace(swapped_id).is_ok(), "tab must remain open on pre-delete identity conflict");
    assert_eq!(fs::read_to_string(Path::new(&swapped).join("precious.txt")).unwrap(), "do not delete");

    // 8. Failed folder removal leaves tab closed while keeping the folder registered (PROJECTS.md).
    h.mock.lock().unwrap().sessions.clear();
    let stuck = create_temp().await;
    let stuck_ws = h.open_workspace(&stuck, None).await;
    let stuck_id = stuck_ws["id"].as_str().unwrap();
    FAIL_NEXT_REMOVE.store(true, Ordering::SeqCst);
    let failed = h.client.post(format!("{}/api/workspaces/{stuck_id}/discard", h.base)).send().await.unwrap();
    assert_eq!(failed.status(), Status::INTERNAL_SERVER_ERROR);
    assert!(h.app.workspace(stuck_id).is_err(), "tab must be closed even when folder removal fails");
    assert!(
        h.app.temporary_workspaces.as_ref().unwrap().has(Path::new(&stuck)),
        "folder must stay registered when folder removal fails"
    );
}

#[tokio::test]
async fn unavailable_registry_returns_empty_list_on_get_and_503_on_mutations() {
    let dir = TempDir::new("cn-temp-unavailable");
    let config_dir = dir.0.join("config");
    fs::create_dir_all(&config_dir).unwrap();
    fs::write(config_dir.join("temporary-workspaces.json"), "not-json").unwrap();

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
    let (tx, _rx) = tokio::sync::mpsc::channel(4);
    let settings = settings::Settings::new(settings::document::Location::resolve(
        config_dir.join("config.yaml").to_str().unwrap(),
    ));
    let app = Arc::new(App::new(
        auth,
        0,
        dir.0.clone(),
        dir.0.clone(),
        true,
        settings,
        Value::Null,
        Native::connect("opencode").unwrap(),
        PathBuf::new(),
        None,
        files::watch::Watches::new(tx),
        None,
    ));
    assert!(app.temporary_workspaces.is_none());

    let listed = list(State(app.clone())).await.0;
    assert_eq!(listed, json!({ "folders": [] }));

    let abandon_res =
        abandon(State(app), HeaderMap::new(), Bytes::from_static(b"{}")).await.unwrap_err().into_response();
    assert_eq!(abandon_res.status(), Status::SERVICE_UNAVAILABLE);
    let body = axum::body::to_bytes(abandon_res.into_body(), 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({ "error": "Temporary workspaces are unavailable" })
    );
}

#[tokio::test]
async fn discard_completes_when_caller_disconnects_mid_flight() {
    let h = Harness::new(true).await;
    let created = h.client.post(format!("{}/api/workspaces/temporary", h.base)).send().await.unwrap();
    assert_eq!(created.status(), Status::CREATED);
    let created_body: Value = created.json().await.unwrap();
    let folder = created_body["path"].as_str().unwrap().to_owned();
    fs::write(Path::new(&folder).join("scratch.txt"), "remove me").unwrap();

    let ws = h.open_workspace(&folder, None).await;
    let ws_id = ws["id"].as_str().unwrap().to_owned();

    let reached = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    {
        let mut mock = h.mock.lock().unwrap();
        mock.sessions = vec![
            json!({ "id": "ses_parent", "location": { "directory": folder } }),
            json!({ "id": "ses_child", "parentID": "ses_parent", "location": { "directory": folder } }),
        ];
        mock.on_delete = Some((reached.clone(), release.clone()));
    }

    let sub = h.app.events.subscribe();
    let caller = tokio::spawn(discard(State(h.app.clone()), RoutePath(ws_id.clone()), HeaderMap::new(), Bytes::new()));

    tokio::time::timeout(Duration::from_secs(15), reached.notified())
        .await
        .expect("discard should pause on deleting the first session");
    assert_eq!(h.mock.lock().unwrap().removed, vec!["ses_child"]);
    assert!(Path::new(&folder).exists(), "folder must still exist while paused mid-discard");

    // Simulate an HTTP client disconnect mid-flight by dropping the handler future.
    caller.abort();
    let _ = caller.await;

    release.notify_one();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let mut deleted_event = false;
    while tokio::time::Instant::now() < deadline {
        for event in h.drain_events(&sub) {
            if event["type"] == "workspace.temporaryChanged" && event["folders"] == json!([]) {
                deleted_event = true;
            }
        }
        if deleted_event && !Path::new(&folder).exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    assert!(deleted_event, "detached discard must finish and emit workspace.temporaryChanged");
    assert_eq!(h.mock.lock().unwrap().removed, vec!["ses_child", "ses_parent"]);
    assert!(!Path::new(&folder).exists(), "detached discard must remove the temporary folder on disk");
    assert!(
        !h.app.temporary_workspaces.as_ref().unwrap().has(Path::new(&folder)),
        "detached discard must unregister the temporary folder"
    );
    assert!(
        h.app.inner.lock().unwrap().workspaces.iter().all(|w| w.id.to_string() != ws_id),
        "detached discard must close the workspace tab"
    );
}
