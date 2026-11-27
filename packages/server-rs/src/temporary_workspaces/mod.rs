//! Temporary workspaces: registered folders under `<config>/temporary-workspaces`
//! persisted in `<config>/temporary-workspaces.json`, with create, abandon, keep and discard.
mod fs_ops;

use std::{
    cmp::Reverse,
    collections::{BTreeMap, HashMap, HashSet},
    ffi::{OsStr, OsString},
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path as RoutePath, State},
    http::{HeaderMap, StatusCode as Status},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use cap_std::fs::Dir;
use chrono::Utc;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    App, Error, Shared, Workspace, error,
    files::{node_path::Style, paths},
    opencode::{self, daemon},
    shared::fastify,
    worktrees::fence,
};

const MAX_SESSION_PAGES: usize = 1000;
const SESSION_PAGE_LIMIT: &str = "200";
const BODY_LIMIT: usize = 16 * 1024;
const REMOVE_RETRIES: usize = if cfg!(test) { 1 } else { 5 };
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(if cfg!(test) { 10 } else { 200 });

#[cfg(test)]
static FAIL_NEXT_REMOVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/workspaces/temporary", get(list).post(create))
        .route("/api/workspaces/temporary/abandon", post(abandon).layer(DefaultBodyLimit::max(BODY_LIMIT)))
        .route("/api/workspaces/{id}/keep", post(keep))
        .route("/api/workspaces/{id}/discard", post(discard).layer(DefaultBodyLimit::max(BODY_LIMIT)))
}

#[derive(Debug)]
struct TempError {
    code: &'static str,
    message: String,
    status: Status,
}

impl TempError {
    fn new(code: &'static str, message: impl Into<String>, status: Status) -> Self {
        Self { code, message: message.into(), status }
    }
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.code, "message": self.message }))).into_response()
    }
}

enum OpError {
    Temp(TempError),
    Server(Error),
}

impl From<TempError> for OpError {
    fn from(value: TempError) -> Self {
        Self::Temp(value)
    }
}
impl From<Error> for OpError {
    fn from(value: Error) -> Self {
        Self::Server(value)
    }
}
impl IntoResponse for OpError {
    fn into_response(self) -> Response {
        match self {
            Self::Temp(err) => err.into_response(),
            Self::Server(err) => err.into_response(),
        }
    }
}

struct RegistryState {
    /// Keyed by `host_identity(folder)` -> canonical folder path string.
    folders: HashMap<String, String>,
    /// Physical directory identity `(dev, ino)` captured when each folder was created or loaded,
    /// preventing deletion if an external process swaps another directory into the same name.
    identities: HashMap<String, fs_ops::DirIdentity>,
    /// Preserves insertion order for deterministic listing.
    order: Vec<String>,
}

impl RegistryState {
    fn list(&self) -> Vec<String> {
        self.order.iter().filter_map(|key| self.folders.get(key).cloned()).collect()
    }
    fn disk_identities(&self) -> BTreeMap<String, fs_ops::DirIdentity> {
        self.order.iter().filter_map(|key| Some((self.folders.get(key)?.clone(), *self.identities.get(key)?))).collect()
    }
    fn insert(&mut self, key: String, folder: String, identity: Option<fs_ops::DirIdentity>) {
        if self.folders.insert(key.clone(), folder).is_none() {
            self.order.push(key.clone());
        }
        if let Some(id) = identity {
            self.identities.insert(key, id);
        }
    }
    fn remove(&mut self, key: &str) -> bool {
        self.identities.remove(key);
        if self.folders.remove(key).is_some() {
            self.order.retain(|k| k != key);
            true
        } else {
            false
        }
    }
}

pub struct TemporaryFolderRegistry {
    root: PathBuf,
    root_identity: String,
    scope: PathBuf,
    /// Pinned OS handle to `scope` when running in restricted workspace-root mode, used to confirm
    /// `root_dir` and `file_dir` remain on the same mount as `scope`.
    scope_dir: Option<Arc<Dir>>,
    /// Pinned OS directory handle to `root`, verified on the open handle at startup and before
    /// mutations: every folder create, inspect and remove runs strictly relative to this handle
    /// without re-resolving ancestor paths or following symlinks/junctions.
    root_dir: Arc<Dir>,
    /// Pinned OS directory handle to the parent directory of `temporary-workspaces.json`, verified
    /// under `scope` at startup and before persistence so registry writes never leave `scope`.
    file_dir: Arc<Dir>,
    file_dir_path: PathBuf,
    file_name: OsString,
    /// Sidecar file next to `file_name` storing physical folder identities (`dev`/`ino`), kept
    /// separate from `temporary-workspaces.json` so TypeScript server writes never erase Rust's
    /// persisted identity proofs during Rust -> TS -> Rust round-trips.
    identities_file_name: OsString,
    state: Arc<Mutex<RegistryState>>,
    /// Serializes disk persistence, in-memory updates, and `workspace.temporaryChanged` SSE
    /// publication so concurrent mutations never publish out-of-order snapshots.
    write: Arc<Mutex<()>>,
}

impl TemporaryFolderRegistry {
    /// Opens the registry, creating `root`, verifying its open handle under `scope`, and pruning
    /// missing, cross-mount, identity-mismatched, or non-direct-child entries.
    pub fn open(root: PathBuf, file: PathBuf, scope: &Path) -> Result<Self, String> {
        if !paths::under(scope, &root) {
            return Err("Temporary workspaces root is outside authorized workspace scope".into());
        }
        let Some(file_parent) = file.parent() else {
            return Err("Temporary workspaces registry file must have a parent directory".into());
        };
        let Some(file_name) = file.file_name().map(OsStr::to_os_string) else {
            return Err("Temporary workspaces registry file must have a file name".into());
        };
        if !paths::under(scope, file_parent) {
            return Err("Temporary workspaces registry file is outside authorized workspace scope".into());
        }
        let identities_file_name = OsString::from(format!("{}.identities", file_name.to_string_lossy()));
        let scope_dir =
            if scope.as_os_str().is_empty() { None } else { Some(Arc::new(fs_ops::open_verified_scope(scope)?)) };
        let (file_dir_path, file_dir) = fs_ops::ensure_verified_root(file_parent, scope)?;
        let (canonical_root, root_dir) = fs_ops::ensure_verified_root(&root, scope)?;
        if let Some(scope_handle) = &scope_dir {
            fs_ops::ensure_same_mount(scope_handle, &file_dir)
                .map_err(|e| format!("Temporary workspaces registry crosses mount boundary: {e}"))?;
            fs_ops::ensure_same_mount(scope_handle, &root_dir)
                .map_err(|e| format!("Temporary workspaces root crosses mount boundary: {e}"))?;
        }
        let root_identity = host_identity(&canonical_root.to_string_lossy());
        let (entries, existed) = read_entries(&file_dir, &file_name)?;
        let (stored_identities, identities_existed) = read_identities(&file_dir, &identities_file_name)?;
        let mut state = RegistryState { folders: HashMap::new(), identities: HashMap::new(), order: Vec::new() };
        let mut pruned = false;
        let mut identities_dirty = false;
        for entry in entries {
            let Some(raw) = entry.as_str() else {
                pruned = true;
                continue;
            };
            let Some(name) = direct_child_name(&root_identity, raw) else {
                pruned = true;
                continue;
            };
            let Ok(child) = fs_ops::open_dir_nofollow(&root_dir, &name) else {
                pruned = true;
                continue;
            };
            if fs_ops::ensure_same_mount(&root_dir, &child).is_err() {
                pruned = true;
                continue;
            }
            let Ok(identity) = fs_ops::dir_identity(&child) else {
                pruned = true;
                continue;
            };
            let canonical_str = canonical_root.join(&name).to_string_lossy().into_owned();
            let key = host_identity(&canonical_str);
            if let Some(&expected_id) = stored_identities.get(&key) {
                // Refuse to adopt a folder whose physical identity changed while the server was stopped.
                if expected_id != identity {
                    pruned = true;
                    identities_dirty = true;
                    continue;
                }
            } else {
                identities_dirty = true;
            }
            if state.folders.contains_key(&key) {
                pruned = true;
                continue;
            }
            if canonical_str != raw {
                pruned = true;
            }
            state.insert(key, canonical_str, Some(identity));
        }
        if stored_identities.len() != state.identities.len() {
            identities_dirty = true;
        }
        if existed && pruned {
            fs_ops::verify_open_root_handle(&file_dir, &file_dir_path, scope)?;
            write_entries(&file_dir, &file_name, &state.list())?;
        }
        if identities_dirty || (identities_existed && pruned) {
            fs_ops::verify_open_root_handle(&file_dir, &file_dir_path, scope)?;
            write_identities(&file_dir, &identities_file_name, &state.disk_identities())?;
        }
        Ok(Self {
            root: canonical_root,
            root_identity,
            scope: scope.to_path_buf(),
            scope_dir,
            root_dir: Arc::new(root_dir),
            file_dir: Arc::new(file_dir),
            file_dir_path,
            file_name,
            identities_file_name,
            state: Arc::new(Mutex::new(state)),
            write: Arc::new(Mutex::new(())),
        })
    }

    fn verify_root(&self) -> Result<(), Error> {
        fs_ops::verify_open_root_handle(&self.root_dir, &self.root, &self.scope)
            .map_err(|e| error(Status::INTERNAL_SERVER_ERROR, &e))?;
        if let Some(scope_handle) = &self.scope_dir {
            fs_ops::ensure_same_mount(scope_handle, &self.root_dir)
                .map_err(|e| error(Status::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        }
        Ok(())
    }

    fn verify_file_dir(&self) -> Result<(), Error> {
        fs_ops::verify_open_root_handle(&self.file_dir, &self.file_dir_path, &self.scope)
            .map_err(|e| error(Status::INTERNAL_SERVER_ERROR, &e))?;
        if let Some(scope_handle) = &self.scope_dir {
            fs_ops::ensure_same_mount(scope_handle, &self.file_dir)
                .map_err(|e| error(Status::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        }
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn list(&self) -> Vec<String> {
        self.state.lock().unwrap().list()
    }

    pub fn has(&self, folder: &Path) -> bool {
        let raw = folder.to_string_lossy();
        self.lookup(&raw).is_some()
    }

    pub fn lookup(&self, folder: &str) -> Option<String> {
        direct_child_name(&self.root_identity, folder)?;
        let key = host_identity(folder);
        self.state.lock().unwrap().folders.get(&key).cloned()
    }

    fn child_name(&self, folder: &str) -> Option<OsString> {
        direct_child_name(&self.root_identity, folder)
    }

    fn identity_of(&self, folder: &str) -> Option<fs_ops::DirIdentity> {
        let key = host_identity(folder);
        self.state.lock().unwrap().identities.get(&key).copied()
    }

    /// Serialized disk write + in-memory commit + ordered SSE publish under `self.write`.
    fn add_and_emit(&self, app: &App, folder: String, identity: fs_ops::DirIdentity) -> Result<(), Error> {
        if direct_child_name(&self.root_identity, &folder).is_none() {
            return Err(error(Status::INTERNAL_SERVER_ERROR, "Folder is outside the temporary workspaces root"));
        }
        let _write = self.write.lock().unwrap();
        let key = host_identity(&folder);
        let (next, next_identities) = {
            let st = self.state.lock().unwrap();
            let mut list = st.list();
            let mut ids = st.disk_identities();
            if !st.folders.contains_key(&key) {
                list.push(folder.clone());
            }
            ids.insert(folder.clone(), identity);
            (list, ids)
        };
        self.verify_file_dir()?;
        // Crash-safe order on add: persist identity proof before publishing the folder entry.
        write_identities(&self.file_dir, &self.identities_file_name, &next_identities)
            .map_err(|e| error(Status::INTERNAL_SERVER_ERROR, &e))?;
        write_entries(&self.file_dir, &self.file_name, &next).map_err(|e| error(Status::INTERNAL_SERVER_ERROR, &e))?;
        let folders = {
            let mut st = self.state.lock().unwrap();
            st.insert(key, folder, Some(identity));
            st.list()
        };
        emit_changed(app, folders);
        Ok(())
    }

    /// Serialized disk write + in-memory removal + optional callback + ordered SSE publish under `self.write`.
    fn delete_and_emit(&self, app: &App, folder: &str, after_commit: impl FnOnce()) -> Result<(), Error> {
        let _write = self.write.lock().unwrap();
        let key = host_identity(folder);
        let (present, next, next_identities) = {
            let st = self.state.lock().unwrap();
            let present = st.folders.contains_key(&key);
            let next: Vec<String> =
                st.order.iter().filter(|k| k.as_str() != key).filter_map(|k| st.folders.get(k).cloned()).collect();
            let next_identities: BTreeMap<String, fs_ops::DirIdentity> = st
                .order
                .iter()
                .filter(|k| k.as_str() != key)
                .filter_map(|k| Some((st.folders.get(k)?.clone(), *st.identities.get(k)?)))
                .collect();
            (present, next, next_identities)
        };
        if present {
            self.verify_file_dir()?;
            // Crash-safe order on delete: remove the folder entry on disk and in memory first, then
            // prune the sidecar best-effort (any leftover sidecar entry is pruned on next open/write)
            // so a second-write error can never leave disk and in-memory state out of sync.
            write_entries(&self.file_dir, &self.file_name, &next)
                .map_err(|e| error(Status::INTERNAL_SERVER_ERROR, &e))?;
            {
                let mut st = self.state.lock().unwrap();
                st.remove(&key);
            }
            let _ = write_identities(&self.file_dir, &self.identities_file_name, &next_identities);
        }
        after_commit();
        emit_changed(app, next);
        Ok(())
    }
}

fn read_entries(file_dir: &Dir, file_name: &OsStr) -> Result<(Vec<Value>, bool), String> {
    let raw = match fs_ops::read_file_anchored(file_dir, file_name) {
        Ok(Some(text)) => text,
        Ok(None) => return Ok((Vec::new(), false)),
        Err(err) => return Err(format!("Failed to read temporary workspaces registry: {err}")),
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid temporary workspaces registry: {e}"))?;
    let folders = parsed.get("folders").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok((folders, true))
}

fn write_entries(file_dir: &Dir, file_name: &OsStr, folders: &[String]) -> Result<(), String> {
    let body = serde_json::to_string_pretty(&json!({ "folders": folders }))
        .map_err(|e| format!("Failed to encode registry: {e}"))?;
    fs_ops::write_file_atomic_anchored(file_dir, file_name, body.as_bytes())
        .map_err(|e| format!("Failed to persist temporary registry: {e}"))
}

fn read_identities(file_dir: &Dir, file_name: &OsStr) -> Result<(HashMap<String, fs_ops::DirIdentity>, bool), String> {
    let raw = match fs_ops::read_file_anchored(file_dir, file_name) {
        Ok(Some(text)) => text,
        Ok(None) => return Ok((HashMap::new(), false)),
        Err(err) => return Err(format!("Failed to read temporary workspaces identities: {err}")),
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid temporary workspaces identities: {e}"))?;
    let Some(map) = parsed.get("identities").and_then(Value::as_object) else {
        return Err("Invalid temporary workspaces identities: expected object".into());
    };
    let mut out = HashMap::with_capacity(map.len());
    for (raw_folder, raw_id) in map {
        let id = serde_json::from_value::<fs_ops::DirIdentity>(raw_id.clone())
            .map_err(|e| format!("Invalid temporary workspace identity entry: {e}"))?;
        out.insert(host_identity(raw_folder), id);
    }
    Ok((out, true))
}

fn write_identities(
    file_dir: &Dir,
    file_name: &OsStr,
    identities: &BTreeMap<String, fs_ops::DirIdentity>,
) -> Result<(), String> {
    let body = serde_json::to_string_pretty(&json!({ "identities": identities }))
        .map_err(|e| format!("Failed to encode temporary workspaces identities: {e}"))?;
    fs_ops::write_file_atomic_anchored(file_dir, file_name, body.as_bytes())
        .map_err(|e| format!("Failed to persist temporary workspaces identities: {e}"))
}

fn trim_trailing_separators(path: &str) -> &str {
    if cfg!(windows) { path.trim_end_matches(['\\', '/']) } else { path.trim_end_matches('/') }
}

pub(crate) fn host_identity(folder: &str) -> String {
    let normalized = Style::host().normalize(folder);
    let trimmed = if normalized.len() > 1 {
        let stripped = trim_trailing_separators(&normalized);
        if stripped.is_empty() { "/" } else { stripped }
    } else {
        normalized.as_str()
    };
    if cfg!(windows) { trimmed.to_lowercase() } else { trimmed.to_owned() }
}

/// Validates that `folder` is a direct child of `root_identity` and returns its single normal
/// path component name for handle-anchored operations against `root_dir`.
fn direct_child_name(root_identity: &str, folder: &str) -> Option<OsString> {
    if !paths::local_absolute(folder) {
        return None;
    }
    let normalized = Style::host().normalize(folder);
    let trimmed = trim_trailing_separators(&normalized);
    if trimmed.is_empty() || host_identity(trimmed) == root_identity {
        return None;
    }
    let path = Path::new(trimmed);
    let parent = path.parent()?;
    if host_identity(&parent.to_string_lossy()) != root_identity {
        return None;
    }
    let name = path.file_name()?;
    let mut comps = Path::new(name).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(seg)), None) if !seg.is_empty() => Some(seg.to_os_string()),
        _ => None,
    }
}

fn within(root: &str, candidate: &str) -> bool {
    let root_id = host_identity(root);
    let cand_id = host_identity(candidate);
    if cand_id == root_id {
        return true;
    }
    let sep = if cfg!(windows) { '\\' } else { '/' };
    let prefix = if root_id.ends_with(sep) { root_id } else { format!("{root_id}{sep}") };
    cand_id.starts_with(&prefix)
}

fn folder_lock_key(folder: &str) -> String {
    format!("temporary:{}", host_identity(folder))
}

fn unavailable() -> Error {
    error(Status::SERVICE_UNAVAILABLE, "Temporary workspaces are unavailable")
}

fn registry(app: &App) -> Result<&TemporaryFolderRegistry, OpError> {
    app.temporary_workspaces.as_ref().ok_or_else(|| OpError::Server(unavailable()))
}

fn emit_changed(app: &App, folders: Vec<String>) {
    app.emit(json!({ "type": "workspace.temporaryChanged", "folders": folders }));
}

/// `GET /api/workspaces/temporary` returns an empty list when temporary workspaces are unavailable,
/// matching TS `routes/temporary-workspaces.ts:38`.
async fn list(State(app): State<Shared>) -> Json<Value> {
    let folders = app.temporary_workspaces.as_ref().map_or_else(Vec::new, |reg| reg.list());
    Json(json!({ "folders": folders }))
}

async fn create(State(app): State<Shared>) -> Result<Response, OpError> {
    let _ = registry(&app)?;
    let app_clone = app.clone();
    let folder = tokio::task::spawn_blocking(move || -> Result<String, OpError> {
        let reg = registry(&app_clone)?;
        reg.verify_root()?;
        let name = create_unique_folder(&reg.root_dir).map_err(|e| error(Status::INTERNAL_SERVER_ERROR, &e))?;
        let child = fs_ops::open_dir_nofollow(&reg.root_dir, &name)
            .map_err(|e| error(Status::INTERNAL_SERVER_ERROR, &format!("Failed to verify created folder: {e}")))?;
        let identity = fs_ops::dir_identity(&child)
            .map_err(|e| error(Status::INTERNAL_SERVER_ERROR, &format!("Failed to stat created folder: {e}")))?;
        drop(child);
        let folder = reg.root.join(&name).to_string_lossy().into_owned();
        reg.add_and_emit(&app_clone, folder.clone(), identity)?;
        Ok(folder)
    })
    .await
    .map_err(|_| error(Status::INTERNAL_SERVER_ERROR, "Failed to create temporary workspace folder"))??;
    Ok((Status::CREATED, Json(json!({ "path": folder, "supportsCancelAndAbandon": true }))).into_response())
}

fn create_unique_folder(root_dir: &Dir) -> Result<OsString, String> {
    let stamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    for _ in 0..16 {
        let mut bytes = [0u8; 4];
        getrandom::fill(&mut bytes).map_err(|_| "Secure random source unavailable".to_owned())?;
        let suffix: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let name = OsString::from(format!("{stamp}-{suffix}"));
        match fs_ops::create_dir_anchored(root_dir, &name) {
            Ok(()) => return Ok(name),
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("Failed to create temporary folder: {err}")),
        }
    }
    Err("Failed to allocate unique temporary workspace folder".into())
}

/// Strict Fastify `Content-Type` + Zod `z.object({ path: z.string().min(1), requestId?: ... })`
/// parsing. Rejects `text/plain`, unsupported media types, arrays (`[]`), `null`, and primitives.
fn parse_abandon_body(headers: &HeaderMap, body: &Bytes) -> Result<(String, Option<String>), Error> {
    let invalid = || error(Status::BAD_REQUEST, "Invalid temporary workspace abandon request");
    let parsed = match fastify::body(headers, body)? {
        Some(fastify::Body::Json(Value::Object(map))) => map,
        _ => return Err(invalid()),
    };
    let Some(path) = parsed.get("path").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        return Err(invalid());
    };
    let request_id = match parsed.get("requestId") {
        None => None,
        Some(Value::String(raw)) => {
            let trimmed = raw.trim_matches(crate::shared::js_space).to_owned();
            if !crate::workspaces::request_id_valid(&trimmed) {
                return Err(invalid());
            }
            Some(trimmed)
        }
        Some(_) => return Err(invalid()),
    };
    Ok((path.to_owned(), request_id))
}

/// Strict Fastify `Content-Type` + Zod `DiscardSchema.parse(request.body ?? {})` parsing.
/// Accepts empty body without Content-Type, JSON `null`, or a JSON object with optional boolean
/// `onlyIfEmpty`; rejects `text/plain`, unsupported media types, arrays (`[]`), and primitives.
fn parse_discard_body(headers: &HeaderMap, body: &Bytes) -> Result<bool, Error> {
    let invalid = || error(Status::BAD_REQUEST, "Invalid temporary workspace discard request");
    match fastify::body(headers, body)? {
        None | Some(fastify::Body::Json(Value::Null)) => Ok(false),
        Some(fastify::Body::Json(Value::Object(map))) => match map.get("onlyIfEmpty") {
            None => Ok(false),
            Some(Value::Bool(v)) => Ok(*v),
            Some(_) => Err(invalid()),
        },
        Some(fastify::Body::Json(_)) | Some(fastify::Body::Text(_)) => Err(invalid()),
    }
}

async fn abandon(State(app): State<Shared>, headers: HeaderMap, body: Bytes) -> Result<Status, OpError> {
    let reg = registry(&app)?;
    let (raw_path, request_id) = parse_abandon_body(&headers, &body)?;
    let Some(initial_folder) = reg.lookup(&raw_path) else {
        return Err(
            TempError::new("temporary_not_temporary", "This folder is not temporary", Status::BAD_REQUEST).into()
        );
    };
    let folder_guard = fence::serialize(folder_lock_key(&initial_folder)).await;
    let Some(folder) = reg.lookup(&initial_folder) else {
        return Err(
            TempError::new("temporary_not_temporary", "This folder is not temporary", Status::BAD_REQUEST).into()
        );
    };
    let Some(name) = reg.child_name(&folder) else {
        return Err(
            TempError::new("temporary_not_temporary", "This folder is not temporary", Status::BAD_REQUEST).into()
        );
    };
    if let Some(key) = &request_id {
        app.cancel_workspace_creation(key);
    }
    let folder_fence = fence::identity(Path::new(&folder));
    let blocked =
        fence::block(std::slice::from_ref(&folder_fence)).await.map_err(|msg| error(Status::BAD_GATEWAY, msg))?;
    let reservation = {
        let store = app.inner.lock().unwrap();
        if store.workspaces.iter().any(|w| within(&folder, &w.path.to_string_lossy())) {
            return Err(TempError::new(
                "temporary_open_elsewhere",
                "This temporary folder is open in a tab",
                Status::CONFLICT,
            )
            .into());
        }
        fence::reserve_deletion_root(&folder_fence).map_err(|_| {
            TempError::new("temporary_open_elsewhere", "This temporary folder is open in a tab", Status::CONFLICT)
        })?
    };
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || -> Result<(), OpError> {
        let _folder_guard = folder_guard;
        let _blocked = blocked;
        let _reservation = reservation;
        let reg = registry(&app_clone)?;
        reg.verify_root()?;
        remove_empty_child_anchored(reg, &name, reg.identity_of(&folder))?;
        reg.delete_and_emit(&app_clone, &folder, || {})?;
        Ok(())
    })
    .await
    .map_err(|_| error(Status::INTERNAL_SERVER_ERROR, "Failed to remove temporary folder"))??;
    Ok(Status::NO_CONTENT)
}

/// Opens `name` under `reg.root_dir` without following links and verifies both its live kernel
/// handle path and recorded physical directory identity. Returns `Ok(None)` if already removed.
fn verify_child_identity(
    reg: &TemporaryFolderRegistry,
    name: &OsStr,
    expected_identity: Option<fs_ops::DirIdentity>,
) -> Result<Option<(Dir, fs_ops::DirIdentity)>, OpError> {
    reg.verify_root()?;
    let expected_child = reg.root.join(name);
    match fs_ops::open_dir_nofollow(&reg.root_dir, name) {
        Ok(child) => {
            fs_ops::verify_open_root_handle(&child, &expected_child, &reg.scope)
                .map_err(|_| error(Status::CONFLICT, "Temporary workspace folder identity changed"))?;
            fs_ops::ensure_same_mount(&reg.root_dir, &child)
                .map_err(|_| error(Status::CONFLICT, "Temporary workspace folder identity changed"))?;
            let actual = fs_ops::dir_identity(&child)
                .map_err(|e| error(Status::INTERNAL_SERVER_ERROR, &format!("Failed to stat temporary folder: {e}")))?;
            if let Some(expected_id) = expected_identity
                && actual != expected_id
            {
                return Err(error(Status::CONFLICT, "Temporary workspace folder identity changed").into());
            }
            Ok(Some((child, actual)))
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) if fs_ops::is_not_physical_dir(&err) => {
            Err(error(Status::CONFLICT, "Temporary workspace folder identity changed").into())
        }
        Err(err) => {
            Err(error(Status::INTERNAL_SERVER_ERROR, &format!("Failed to inspect temporary folder: {err}")).into())
        }
    }
}

/// Removes an empty direct child directory strictly by handle relative to `reg.root_dir`,
/// verifying both live kernel handle path and recorded physical directory identity, refusing
/// symlinks/reparse points and returning `409 temporary_not_empty` when non-empty.
fn remove_empty_child_anchored(
    reg: &TemporaryFolderRegistry,
    name: &OsStr,
    expected_identity: Option<fs_ops::DirIdentity>,
) -> Result<(), OpError> {
    let Some((child, actual_id)) = verify_child_identity(reg, name, expected_identity)? else {
        return Ok(());
    };
    let expected_child = reg.root.join(name);
    #[cfg(windows)]
    drop(child);
    reg.verify_root()?;
    let res =
        fs_ops::delete_entry_anchored(&reg.root_dir, name, true, Some(actual_id), Some((&expected_child, &reg.scope)));
    #[cfg(not(windows))]
    drop(child);
    match res {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) if err.kind() == ErrorKind::InvalidInput => {
            Err(error(Status::CONFLICT, "Temporary workspace folder identity changed").into())
        }
        Err(err) if is_dir_not_empty(&err) => {
            Err(TempError::new("temporary_not_empty", "This temporary folder is not empty", Status::CONFLICT).into())
        }
        Err(err) => {
            Err(error(Status::INTERNAL_SERVER_ERROR, &format!("Failed to remove temporary folder: {err}")).into())
        }
    }
}

fn is_dir_not_empty(err: &std::io::Error) -> bool {
    if matches!(err.kind(), ErrorKind::DirectoryNotEmpty | ErrorKind::AlreadyExists) {
        return true;
    }
    #[cfg(windows)]
    {
        // ERROR_DIR_NOT_EMPTY (145)
        if err.raw_os_error() == Some(145) {
            return true;
        }
    }
    false
}

fn require_temporary(app: &App, reg: &TemporaryFolderRegistry, id: &str) -> Result<(Workspace, String), OpError> {
    let workspace = app
        .workspace(id)
        .map_err(|_| TempError::new("temporary_not_found", "Workspace not found", Status::NOT_FOUND))?;
    let Some(folder) = reg.lookup(&workspace.path.to_string_lossy()) else {
        return Err(
            TempError::new("temporary_not_temporary", "This workspace is not temporary", Status::BAD_REQUEST).into()
        );
    };
    Ok((workspace, folder))
}

async fn keep(State(app): State<Shared>, RoutePath(id): RoutePath<String>) -> Result<Status, OpError> {
    let reg = registry(&app)?;
    let (_, initial_folder) = require_temporary(&app, reg, &id)?;
    let folder_guard = fence::serialize(folder_lock_key(&initial_folder)).await;
    let (workspace, folder) = require_temporary(&app, reg, &id)?;
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || -> Result<(), OpError> {
        let _folder_guard = folder_guard;
        let reg = registry(&app_clone)?;
        reg.delete_and_emit(&app_clone, &folder, || {
            let mut store = app_clone.inner.lock().unwrap();
            let folder_id = host_identity(&workspace.path.to_string_lossy());
            for record in &mut store.workspaces {
                if host_identity(&record.path.to_string_lossy()) == folder_id {
                    record.temporary = None;
                }
            }
        })?;
        Ok(())
    })
    .await
    .map_err(|_| error(Status::INTERNAL_SERVER_ERROR, "Failed to save temporary workspaces"))??;
    Ok(Status::NO_CONTENT)
}

async fn discard(
    State(app): State<Shared>,
    RoutePath(id): RoutePath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Status, OpError> {
    let reg = registry(&app)?;
    let only_if_empty = parse_discard_body(&headers, &body)?;
    let (_, initial_folder) = require_temporary(&app, reg, &id)?;
    let folder_guard = fence::serialize(folder_lock_key(&initial_folder)).await;

    let (workspace, folder) = require_temporary(&app, reg, &id)?;
    let Some(name) = reg.child_name(&folder) else {
        return Err(
            TempError::new("temporary_not_temporary", "This workspace is not temporary", Status::BAD_REQUEST).into()
        );
    };
    if has_other_overlapping_tab(&app, workspace.id, &folder) {
        return Err(TempError::new(
            "temporary_open_elsewhere",
            "This temporary folder is open in another tab",
            Status::CONFLICT,
        )
        .into());
    }
    let service_directory = workspace.location["directory"].as_str().unwrap_or(&folder).to_owned();
    let folder_fence = fence::identity(Path::new(&folder));
    let service_fence = fence::identity(Path::new(&service_directory));
    let mut fence_paths = vec![folder_fence.clone()];
    if service_fence != folder_fence {
        fence_paths.push(service_fence);
    }
    let blocked = fence::block(&fence_paths).await.map_err(|msg| error(Status::BAD_GATEWAY, msg))?;

    // Re-check under the deletion fence before querying native sessions.
    let _ = require_temporary(&app, reg, &id)?;
    if has_other_overlapping_tab(&app, workspace.id, &folder) {
        return Err(TempError::new(
            "temporary_open_elsewhere",
            "This temporary folder is open in another tab",
            Status::CONFLICT,
        )
        .into());
    }

    let deadline = tokio::time::Instant::now() + daemon::TIMEOUT;
    let endpoint =
        app.native.acquire(deadline).await.map_err(|r| error(Status::SERVICE_UNAVAILABLE, &r.to_string()))?;
    crate::extensions::lifecycle::prepare(&app, &endpoint).await;

    let inventory = list_sessions(&app, &endpoint, &service_directory).await?;
    if only_if_empty {
        if !inventory.in_folder.is_empty() {
            return Err(TempError::new(
                "temporary_has_conversations",
                "This temporary instance has conversations",
                Status::CONFLICT,
            )
            .into());
        }
        let app_check = app.clone();
        let name_check = name.clone();
        let folder_check = folder.clone();
        let non_empty = tokio::task::spawn_blocking(move || -> Result<bool, OpError> {
            let reg = registry(&app_check)?;
            match verify_child_identity(reg, &name_check, reg.identity_of(&folder_check))? {
                Some((child, _)) => fs_ops::is_dir_empty_anchored(&child).map(|empty| !empty).map_err(|e| {
                    error(Status::INTERNAL_SERVER_ERROR, &format!("Failed to inspect temporary folder: {e}")).into()
                }),
                None => Ok(false),
            }
        })
        .await
        .map_err(|_| error(Status::INTERNAL_SERVER_ERROR, "Failed to inspect temporary folder"))??;
        if non_empty {
            return Err(
                TempError::new("temporary_not_empty", "This temporary folder is not empty", Status::CONFLICT).into()
            );
        }
    }

    let active = active_sessions(&app, &endpoint).await?;
    let all_affected = inventory.in_folder.iter().chain(inventory.external_descendants.iter());
    if all_affected.clone().any(|s| s["id"].as_str().is_some_and(|sid| active.contains(sid))) {
        return Err(TempError::new(
            "temporary_running",
            "A conversation is still running in this temporary instance",
            Status::CONFLICT,
        )
        .into());
    }

    for session in all_affected {
        let sid = session["id"].as_str().ok_or_else(opencode::upstream_error)?;
        let session_dir = session["location"]["directory"].as_str().ok_or_else(opencode::upstream_error)?;
        let session_ws_id = session["location"].get("workspaceID").and_then(Value::as_str);
        crate::opencode::proxy::verify_ordinary_session_at(&app, &endpoint, sid, session_dir, session_ws_id, session)
            .await?;
    }

    if !inventory.external_descendants.is_empty() {
        return Err(TempError::new(
            "temporary_open_elsewhere",
            "A conversation in this temporary instance has linked conversations in another folder",
            Status::CONFLICT,
        )
        .into());
    }

    let sessions = inventory.in_folder;

    // Reserve the deletion root BEFORE any irreversible mutation (session deletion, workspace
    // close or folder removal), under the global lock order `app.inner -> fence::STATE`, so no
    // new tab on the folder or any descendant can open mid-discard.
    let reservation = {
        let store = app.inner.lock().unwrap();
        if !store.workspaces.iter().any(|w| w.id == workspace.id) {
            return Err(TempError::new("temporary_not_found", "Workspace not found", Status::NOT_FOUND).into());
        }
        if store.workspaces.iter().any(|w| w.id != workspace.id && within(&folder, &w.path.to_string_lossy())) {
            return Err(TempError::new(
                "temporary_open_elsewhere",
                "This temporary folder is open in another tab",
                Status::CONFLICT,
            )
            .into());
        }
        fence::reserve_deletion_root(&folder_fence).map_err(|_| {
            TempError::new("temporary_open_elsewhere", "This temporary folder is open in another tab", Status::CONFLICT)
        })?
    };

    if only_if_empty {
        let app_clone = app.clone();
        let workspace_id = workspace.id;
        tokio::task::spawn_blocking(move || -> Result<(), OpError> {
            let _folder_guard = folder_guard;
            let _blocked = blocked;
            let _reservation = reservation;
            let reg = registry(&app_clone)?;
            reg.verify_root()?;
            remove_empty_child_anchored(reg, &name, reg.identity_of(&folder))?;
            {
                let mut store = app_clone.inner.lock().unwrap();
                if let Some(index) = store.workspaces.iter().position(|w| w.id == workspace_id) {
                    app_clone.remove(&mut store, index, false);
                }
            }
            reg.delete_and_emit(&app_clone, &folder, || {})?;
            Ok(())
        })
        .await
        .map_err(|_| error(Status::INTERNAL_SERVER_ERROR, "Failed to remove temporary folder"))??;
        return Ok(Status::NO_CONTENT);
    }

    // Verify the target folder still matches its recorded physical identity and has no nested
    // mount points BEFORE deleting any conversations or closing the tab so a replaced or mounted
    // directory fails cleanly with 409.
    {
        let app_check = app.clone();
        let name_check = name.clone();
        let folder_check = folder.clone();
        tokio::task::spawn_blocking(move || -> Result<(), OpError> {
            let reg = registry(&app_check)?;
            if let Some((child, _)) = verify_child_identity(reg, &name_check, reg.identity_of(&folder_check))? {
                let expected_child = reg.root.join(&name_check);
                fs_ops::verify_tree_same_mount(&child, &expected_child, &reg.scope).map_err(|err| {
                    if err.kind() == ErrorKind::InvalidInput {
                        error(Status::CONFLICT, "Temporary workspace folder identity changed")
                    } else {
                        error(Status::INTERNAL_SERVER_ERROR, &format!("Failed to inspect temporary folder: {err}"))
                    }
                })?;
            }
            Ok(())
        })
        .await
        .map_err(|_| error(Status::INTERNAL_SERVER_ERROR, "Failed to verify temporary folder"))??;
    }

    for session in deepest_first(&sessions) {
        if let Some(sid) = session["id"].as_str() {
            remove_session(&app, &endpoint, sid).await?;
        }
    }

    {
        let mut store = app.inner.lock().unwrap();
        if let Some(index) = store.workspaces.iter().position(|w| w.id == workspace.id) {
            app.remove(&mut store, index, false);
        }
    }

    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || -> Result<(), OpError> {
        let _folder_guard = folder_guard;
        let _blocked = blocked;
        let _reservation = reservation;
        let reg = registry(&app_clone)?;
        reg.verify_root()?;
        remove_dir_all_anchored_with_retries(reg, &name, reg.identity_of(&folder))?;
        reg.delete_and_emit(&app_clone, &folder, || {})?;
        Ok(())
    })
    .await
    .map_err(|_| error(Status::INTERNAL_SERVER_ERROR, "Failed to remove temporary folder"))??;

    Ok(Status::NO_CONTENT)
}

fn has_other_overlapping_tab(app: &App, id: Uuid, folder: &str) -> bool {
    app.inner
        .lock()
        .unwrap()
        .workspaces
        .iter()
        .any(|other| other.id != id && within(folder, &other.path.to_string_lossy()))
}

struct SessionInventory {
    in_folder: Vec<Value>,
    external_descendants: Vec<Value>,
}

async fn list_sessions(
    app: &App,
    endpoint: &std::sync::Arc<opencode::Endpoint>,
    directory: &str,
) -> Result<SessionInventory, Error> {
    // 1. Unfiltered inventory discovers sessions in `directory` and any subfolder (since OpenCode
    // filters `directory=` by exact equality).
    let mut all_sessions = list_session_pages(app, endpoint, None).await?;
    let mut seen: HashSet<String> =
        all_sessions.iter().filter_map(|row| row["id"].as_str().map(str::to_owned)).collect();

    // 2. Targeted `parentID=` BFS from every session inside `directory` ensures descendants moved
    // outside `directory` whose `time_updated` shifted across global pagination boundaries are
    // still discovered before recursive native removal.
    let mut queue: Vec<String> = all_sessions
        .iter()
        .filter(|row| row["location"]["directory"].as_str().is_some_and(|dir| within(directory, dir)))
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    let mut expanded: HashSet<String> = queue.iter().cloned().collect();
    while let Some(parent_id) = queue.pop() {
        let children = list_session_pages(app, endpoint, Some(&parent_id)).await?;
        for child in children {
            let sid = child["id"].as_str().ok_or_else(opencode::upstream_error)?.to_owned();
            if seen.insert(sid.clone()) {
                all_sessions.push(child);
            }
            if expanded.insert(sid.clone()) {
                queue.push(sid);
            }
        }
    }

    Ok(partition_sessions(all_sessions, directory))
}

async fn list_session_pages(
    app: &App,
    endpoint: &std::sync::Arc<opencode::Endpoint>,
    parent_id: Option<&str>,
) -> Result<Vec<Value>, Error> {
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    let mut seen_cursors = HashSet::new();
    let mut cursor: Option<String> = None;

    for _ in 0..MAX_SESSION_PAGES {
        let url = endpoint.url.join("/api/session").map_err(|_| opencode::upstream_error())?;
        let mut req = app
            .native
            .client
            .get(url)
            .basic_auth("opencode", Some(&endpoint.password))
            .timeout(Duration::from_secs(15));
        if let Some(next) = &cursor {
            req = req.query(&[("cursor", next.as_str()), ("limit", SESSION_PAGE_LIMIT)]);
        } else if let Some(parent) = parent_id {
            // Ascending `time_updated` order keeps concurrent monotonic updates ahead of the
            // cursor anchor so pagination cannot skip unseen sessions or moved descendants.
            req = req.query(&[("parentID", parent), ("order", "asc"), ("limit", SESSION_PAGE_LIMIT)]);
        } else {
            req = req.query(&[("order", "asc"), ("limit", SESSION_PAGE_LIMIT)]);
        }
        let response = req.send().await.map_err(|_| opencode::upstream_error())?;
        if !response.status().is_success() {
            return Err(opencode::upstream_error());
        }
        let page: Value = response.json().await.map_err(|_| opencode::upstream_error())?;
        let rows = page["data"].as_array().ok_or_else(opencode::upstream_error)?;
        let cursor_obj = page.get("cursor").and_then(Value::as_object).ok_or_else(opencode::upstream_error)?;
        for row in rows {
            let sid = row["id"].as_str().filter(|s| opencode::valid_id(s)).ok_or_else(opencode::upstream_error)?;
            let _ = row["location"]["directory"].as_str().ok_or_else(opencode::upstream_error)?;
            if seen.insert(sid.to_owned()) {
                sessions.push(row.clone());
            }
        }
        match cursor_obj.get("next") {
            None | Some(Value::Null) => return Ok(sessions),
            Some(Value::String(next))
                if !rows.is_empty() && !next.is_empty() && next.len() <= 8192 && seen_cursors.insert(next.clone()) =>
            {
                cursor = Some(next.clone());
            }
            _ => return Err(opencode::upstream_error()),
        }
    }
    Err(error(Status::INTERNAL_SERVER_ERROR, "Session listing exceeded pagination limit"))
}

fn partition_sessions(all_sessions: Vec<Value>, directory: &str) -> SessionInventory {
    let mut children_by_parent: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut in_folder_idx = HashSet::new();
    for (idx, row) in all_sessions.iter().enumerate() {
        if let Some(parent) = row["parentID"].as_str() {
            children_by_parent.entry(parent).or_default().push(idx);
        }
        if row["location"]["directory"].as_str().is_some_and(|dir| within(directory, dir)) {
            in_folder_idx.insert(idx);
        }
    }
    let mut queue: Vec<usize> = in_folder_idx.iter().copied().collect();
    let mut visited = in_folder_idx.clone();
    let mut external_idx = HashSet::new();
    while let Some(idx) = queue.pop() {
        let Some(sid) = all_sessions[idx]["id"].as_str() else {
            continue;
        };
        if let Some(children) = children_by_parent.get(sid) {
            for &child in children {
                if visited.insert(child) {
                    if !in_folder_idx.contains(&child) {
                        external_idx.insert(child);
                    }
                    queue.push(child);
                }
            }
        }
    }
    let mut in_folder = Vec::new();
    let mut external_descendants = Vec::new();
    for (idx, row) in all_sessions.into_iter().enumerate() {
        if in_folder_idx.contains(&idx) {
            in_folder.push(row);
        } else if external_idx.contains(&idx) {
            external_descendants.push(row);
        }
    }
    SessionInventory { in_folder, external_descendants }
}

async fn active_sessions(app: &App, endpoint: &std::sync::Arc<opencode::Endpoint>) -> Result<HashSet<String>, Error> {
    let url = endpoint.url.join("/api/session/active").map_err(|_| opencode::upstream_error())?;
    let response = app
        .native
        .client
        .get(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| opencode::upstream_error())?;
    if !response.status().is_success() {
        return Err(opencode::upstream_error());
    }
    let body: Value = response.json().await.map_err(|_| opencode::upstream_error())?;
    let map = body.get("data").and_then(Value::as_object).ok_or_else(opencode::upstream_error)?;
    Ok(map.keys().cloned().collect())
}

fn deepest_first(sessions: &[Value]) -> Vec<&Value> {
    let by_id: HashMap<&str, Option<&str>> =
        sessions.iter().filter_map(|s| Some((s["id"].as_str()?, s["parentID"].as_str()))).collect();
    let depth = |session: &Value| -> usize {
        let mut count = 0usize;
        let mut parent = session["parentID"].as_str();
        while let Some(pid) = parent {
            if !by_id.contains_key(pid) || count >= sessions.len() {
                break;
            }
            count += 1;
            parent = by_id.get(pid).copied().flatten();
        }
        count
    };
    let mut ordered: Vec<&Value> = sessions.iter().collect();
    ordered.sort_by_key(|session| Reverse(depth(session)));
    ordered
}

async fn remove_session(
    app: &App,
    endpoint: &std::sync::Arc<opencode::Endpoint>,
    session_id: &str,
) -> Result<(), Error> {
    let url = endpoint.url.join(&format!("/api/session/{session_id}")).map_err(|_| opencode::upstream_error())?;
    let response = app
        .native
        .client
        .delete(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| opencode::upstream_error())?;
    let status = response.status();
    if status.is_success() || status == Status::NOT_FOUND {
        return Ok(());
    }
    let body: Value = response.json().await.unwrap_or_default();
    if is_session_not_found(&body) {
        return Ok(());
    }
    Err(opencode::upstream_error())
}

fn is_session_not_found(body: &Value) -> bool {
    let matches_tag = |v: &Value| matches!(v.as_str(), Some("SessionNotFoundError" | "NotFoundError"));
    matches_tag(&body["_tag"])
        || matches_tag(&body["name"])
        || matches_tag(&body["error"]["_tag"])
        || matches_tag(&body["error"]["name"])
}

fn remove_dir_all_anchored_with_retries(
    reg: &TemporaryFolderRegistry,
    name: &OsStr,
    expected_identity: Option<fs_ops::DirIdentity>,
) -> Result<(), Error> {
    #[cfg(test)]
    if FAIL_NEXT_REMOVE.swap(false, std::sync::atomic::Ordering::SeqCst) {
        return Err(error(Status::INTERNAL_SERVER_ERROR, "Failed to remove temporary folder: simulated"));
    }
    let mut last_err = None;
    for attempt in 0..=REMOVE_RETRIES {
        match fs_ops::remove_dir_all_anchored(&reg.root_dir, name, &reg.root, &reg.scope, expected_identity) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
            Err(err) if err.kind() == ErrorKind::InvalidInput => {
                return Err(error(Status::CONFLICT, "Temporary workspace folder identity changed"));
            }
            Err(err) => {
                last_err = Some(err);
                if attempt < REMOVE_RETRIES {
                    std::thread::sleep(REMOVE_RETRY_DELAY);
                }
            }
        }
    }
    let err = last_err.unwrap();
    Err(error(Status::INTERNAL_SERVER_ERROR, &format!("Failed to remove temporary folder: {err}")))
}

#[cfg(test)]
mod tests;
