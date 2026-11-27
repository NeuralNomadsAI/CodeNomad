//! Core `PluginControls` async engine (`opencode/plugin-controls.ts`): context acquisition,
//! snapshot assembly with HMAC-SHA256 revisions, activation rule mutations, and multi-document
//! prepared commits with atomic workspace + connection locking.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, LazyLock, Mutex, Weak},
    time::Duration,
};

use axum::http::{Method, StatusCode as Status};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::{
    App, Shared, Workspace,
    files::node_path::Style,
    opencode::Endpoint,
    opencode_settings::{Scope, assert_current, fail, guard_current, has_control_chars, mapped, native_get},
    subagent_depth::{Fail, document::Document, fs, jsonc, resolve_targets, rules},
    worktrees::{fence, ownership},
};

use super::{
    discovery::{
        ManagedDesktopPlugin, declared_entrypoint_of, discovery_entrypoint_of, discovery_loaders,
        read_managed_desktop_plugins, reporting_entries, resolve_inventory_item,
    },
    doc::{PluginConfigEntry, document_plugins, normalize_plugin_entries, replace_plugin_control_rules},
    order::{AppliedSequence, defined_before, enabled_through, matches_selector},
    snapshot::{
        ActivationControl, ConfigScope, ConfiguredRule, ConfiguredSource, ControlLocation, ControlTarget, EvalContext,
        LocalIdentity, Overlay, PackageVersionInfo, ResolvedTarget, RuntimeEntry, ScopeRuleState, Snapshot,
        another_loader, config_documents, configured_local_target, discovery_child, discovery_folders,
        evaluate_documents, mutation_target_plugins, replaceable_rule_indexes, snapshot_base,
    },
    spec::{git_plugin_revision, is_hex_revision},
};

const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(15);
const MISSIONS_PLUGIN_ID: &str = "codenomad.missions";
const PLUGIN_VERSIONS_RPC_ID: &str = "codenomad.plugin-versions";

static REVISION_KEY: LazyLock<[u8; 32]> = LazyLock::new(|| {
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).expect("OS randomness for plugin control revisions");
    key
});

type ConnectionRegistry = Vec<(Weak<Endpoint>, String)>;

static CONNECTION_IDS: LazyLock<Mutex<ConnectionRegistry>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn connection_identity(endpoint: &Arc<Endpoint>) -> String {
    let mut guard = CONNECTION_IDS.lock().unwrap();
    guard.retain(|(weak, _)| weak.strong_count() > 0);
    for (weak, id) in guard.iter() {
        if let Some(existing) = weak.upgrade()
            && Arc::ptr_eq(&existing, endpoint)
        {
            return id.clone();
        }
    }
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).expect("OS randomness for connection identity");
    let mut hex = String::with_capacity(32);
    for byte in nonce {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    guard.push((Arc::downgrade(endpoint), hex.clone()));
    hex
}

pub(super) fn document_revision(
    workspace_id: &str,
    location: &ControlLocation,
    target: &ResolvedTarget,
    endpoint: &Arc<Endpoint>,
    doc: &Document,
) -> String {
    let conn = connection_identity(endpoint);
    let payload = json!([
        workspace_id,
        location,
        target.scope.as_str(),
        target.path,
        doc.requested,
        doc.write,
        Value::Null,
        conn,
        doc.exists,
        doc.mode,
        doc.bom,
        jsonc::string(&doc.text),
    ]);
    let mut mac = Hmac::<Sha256>::new_from_slice(&*REVISION_KEY).expect("HMAC-SHA256 accepts 32-byte key");
    mac.update(payload.to_string().as_bytes());
    let digest = mac.finalize().into_bytes();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

fn revision_eq(expected: &str, actual: &str) -> bool {
    expected.len() == actual.len() && bool::from(expected.as_bytes().ct_eq(actual.as_bytes()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PinnedTarget {
    /// Existing target directory: exact canonical path and OS directory identity.
    Existing { canonical: std::path::PathBuf, identity: String },
    /// Missing target directory: nearest existing ancestor's exact canonical path and OS identity.
    Missing { ancestor: std::path::PathBuf, ancestor_identity: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LocationPin {
    pub(crate) root_canonical: std::path::PathBuf,
    pub(crate) root_identity: String,
    pub(crate) target: PinnedTarget,
}

fn nearest_existing_ancestor(path: &Path) -> Option<std::path::PathBuf> {
    let mut cur = path.parent();
    while let Some(ancestor) = cur {
        match dunce::canonicalize(ancestor) {
            Ok(canon) => return (canon == ancestor).then_some(canon),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => cur = ancestor.parent(),
            Err(_) => return None,
        }
    }
    None
}

pub(crate) async fn capture_location_pin(workspace: &Workspace, directory: &str) -> Option<LocationPin> {
    let root = workspace.path.clone();
    let dir = directory.to_owned();
    tokio::task::spawn_blocking(move || {
        let root_canonical = dunce::canonicalize(&root).ok()?;
        if root_canonical != root {
            return None;
        }
        let root_identity = crate::files::directory_identity(&root_canonical).ok()?;
        let dir_path = Path::new(&dir);
        let target = match dunce::canonicalize(dir_path) {
            Ok(canon) => {
                if canon != dir_path {
                    return None;
                }
                let identity = crate::files::directory_identity(&canon).ok()?;
                PinnedTarget::Existing { canonical: canon, identity }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                if ownership::resolve_directory(&dir).as_deref() != Some(dir_path) {
                    return None;
                }
                let ancestor = nearest_existing_ancestor(dir_path)?;
                let ancestor_identity = crate::files::directory_identity(&ancestor).ok()?;
                PinnedTarget::Missing { ancestor, ancestor_identity }
            }
            Err(_) => return None,
        };
        Some(LocationPin { root_canonical, root_identity, target })
    })
    .await
    .ok()
    .flatten()
}

pub(crate) fn pin_still_live_sync(root: &Path, dir: &str, pin: &LocationPin) -> bool {
    if dunce::canonicalize(root).ok().as_ref() != Some(&pin.root_canonical) {
        return false;
    }
    if crate::files::directory_identity(&pin.root_canonical).ok().as_deref() != Some(pin.root_identity.as_str()) {
        return false;
    }
    let dir_path = Path::new(dir);
    match &pin.target {
        PinnedTarget::Existing { canonical, identity } => {
            dunce::canonicalize(dir_path).ok().as_ref() == Some(canonical)
                && canonical == dir_path
                && crate::files::directory_identity(canonical).ok().as_deref() == Some(identity.as_str())
        }
        PinnedTarget::Missing { ancestor, ancestor_identity } => {
            ownership::resolve_directory(dir).as_deref() == Some(dir_path)
                && dunce::canonicalize(ancestor).ok().as_ref() == Some(ancestor)
                && crate::files::directory_identity(ancestor).ok().as_deref() == Some(ancestor_identity.as_str())
        }
    }
}

pub(crate) async fn pin_still_live(workspace: &Workspace, directory: &str, pin: &LocationPin) -> bool {
    let root = workspace.path.clone();
    let dir = directory.to_owned();
    let pin = pin.clone();
    tokio::task::spawn_blocking(move || pin_still_live_sync(&root, &dir, &pin)).await.unwrap_or(false)
}

pub(super) struct ReadContext {
    pub(super) workspace: Workspace,
    pub(super) endpoint: Arc<Endpoint>,
    pub(super) entries: Vec<Value>,
    pub(super) runtime: Vec<Value>,
    pub(super) location: ControlLocation,
    pub(super) location_pin: LocationPin,
    pub(super) style: Style,
    pub(super) global_dir: String,
    pub(super) targets: Vec<ResolvedTarget>,
    pub(super) managed_plugins: Vec<ManagedDesktopPlugin>,
    pub(super) package_versions: HashMap<String, PackageVersionInfo>,
    pub(super) existing_entrypoints: Option<HashSet<String>>,
    pub(super) discovery_loaders: Option<Vec<Vec<String>>>,
    pub(super) local_identities: HashMap<String, LocalIdentity>,
}

impl ReadContext {
    pub(super) fn eval_ctx(&self) -> EvalContext<'_> {
        EvalContext {
            location: &self.location,
            entries: &self.entries,
            runtime: &self.runtime,
            style: self.style,
            global_dir: &self.global_dir,
            targets: &self.targets,
            managed_plugins: &self.managed_plugins,
            package_versions: &self.package_versions,
            existing_entrypoints: self.existing_entrypoints.as_ref(),
            discovery_loaders: self.discovery_loaders.as_deref(),
            local_identities: &self.local_identities,
        }
    }
}

pub(super) struct ActivationMutationRequest {
    pub(super) location: ControlLocation,
    /// `None` when raw JSON `pluginId` contained an unpaired UTF-16 surrogate (never matches any ID).
    pub(super) plugin_id: Option<String>,
    pub(super) scope: Scope,
    pub(super) enabled: bool,
    pub(super) managed_by: Option<String>,
}

#[derive(Serialize)]
pub(super) struct ActivationMutationResponse {
    pub(super) snapshot: Snapshot,
    pub(super) rule: String,
    pub(super) target: ControlTarget,
    pub(super) changed: bool,
    #[serde(rename = "reloadPending")]
    pub(super) reload_pending: bool,
}

pub(super) struct PluginDocumentsTarget {
    pub(super) scope: Scope,
    pub(super) document: Document,
    pub(super) order: Option<usize>,
    pub(super) consistent: bool,
    pub(super) sources: Vec<ConfiguredSource>,
    pub(super) rules: Vec<ConfiguredRule>,
}

pub(super) struct PluginDocumentsView<'a> {
    pub(super) ctx: &'a ReadContext,
    pub(super) all_sources: Vec<ConfiguredSource>,
    pub(super) runtime: Vec<RuntimeEntry>,
    pub(super) controls: Vec<ActivationControl>,
    pub(super) sequence: AppliedSequence,
    pub(super) targets: Vec<PluginDocumentsTarget>,
}

impl PluginDocumentsView<'_> {
    pub(super) fn other_loader(&self, source_idx: usize) -> bool {
        let Some(source) = self.all_sources.get(source_idx) else { return true };
        let Some(ref id) = source.plugin_id else { return true };
        another_loader(&self.ctx.eval_ctx(), &self.all_sources, &self.runtime, id, Some(source_idx))
    }
}

fn check_cancelled(cancel: Option<&CancellationToken>) -> Result<(), Fail> {
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        return Err(fail(Status::SERVICE_UNAVAILABLE, "OpenCode did not answer in time"));
    }
    Ok(())
}

/// Resolves an owned service directory without spawning `git rev-parse` for the unused checkout
/// path when `directory` is already the canonical workspace root (`worktrees::ownership::resolve`).
async fn resolve_owned_directory(app: &App, workspace: &Workspace, directory: &str) -> Option<String> {
    if !crate::files::paths::under(&app.scope, Path::new(directory)) {
        return None;
    }
    let dir = directory.to_owned();
    let root = workspace.path.clone();
    let scope = app.scope.clone();
    let is_root = tokio::task::spawn_blocking(move || {
        let target = dunce::canonicalize(&dir).ok()?;
        if !target.starts_with(&scope) {
            return Some(false);
        }
        (target == root && dunce::canonicalize(&root).ok().as_ref() == Some(&root)).then_some(true)
    })
    .await
    .ok()
    .flatten();
    match is_root {
        Some(true) => Some(workspace.path.to_string_lossy().into_owned()),
        Some(false) => None,
        None => ownership::resolve(app, workspace, directory).await.map(|owned| owned.directory),
    }
}

async fn native_get_cancellable(
    app: &App,
    endpoint: &Endpoint,
    path: &str,
    query: &[(&str, &str)],
    timeout: Duration,
    max_bytes: usize,
    cancel: Option<&CancellationToken>,
) -> Result<Value, ()> {
    let fut = native_get(app, endpoint, path, query, timeout, max_bytes);
    match cancel {
        Some(tok) => tokio::select! {
            biased;
            _ = tok.cancelled() => Err(()),
            res = fut => res,
        },
        None => fut.await,
    }
}

async fn fetch_package_versions(
    app: &App,
    endpoint: &Endpoint,
    location_dir: &str,
    cancel: Option<&CancellationToken>,
) -> HashMap<String, PackageVersionInfo> {
    let mut map = HashMap::new();
    let Ok(url) = endpoint.url.join(&format!("/api/rpc/{PLUGIN_VERSIONS_RPC_ID}/list")) else { return map };
    let req = app
        .native
        .client
        .request(Method::POST, url)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", location_dir)])
        .json(&json!({ "input": {} }))
        .timeout(Duration::from_millis(2500))
        .send();
    let response = match cancel {
        Some(tok) => tokio::select! {
            biased;
            _ = tok.cancelled() => return map,
            res = req => match res { Ok(r) => r, Err(_) => return map },
        },
        None => match req.await {
            Ok(r) => r,
            Err(_) => return map,
        },
    };
    if !response.status().is_success() {
        return map;
    }
    let Ok(body) = crate::opencode::read_json(response, 1024 * 1024).await else { return map };
    let Some(items) = body.get("output").and_then(Value::as_array) else { return map };
    if items.len() > 64 {
        return map;
    }
    for item in items {
        let Some(obj) = item.as_object().filter(|o| o.len() == 3) else { return HashMap::new() };
        let Some(target) = obj.get("target").and_then(Value::as_str).filter(|s| {
            let n = s.encode_utf16().count();
            (1..=4096).contains(&n)
        }) else {
            return HashMap::new();
        };
        let Some(revision) = obj.get("revision").and_then(Value::as_str).filter(|s| is_hex_revision(s)) else {
            return HashMap::new();
        };
        let Some(version) = obj.get("version").and_then(Value::as_str).filter(|s| {
            let n = s.encode_utf16().count();
            (1..=256).contains(&n) && *s == crate::shared::js_trim(s) && !has_control_chars(s)
        }) else {
            return HashMap::new();
        };
        map.insert(
            target.to_owned(),
            PackageVersionInfo { revision: revision.to_owned(), version: version.to_owned() },
        );
    }
    map
}

async fn resolve_local_identities(
    entries: &[Value],
    runtime: &[Value],
    location_dir: &str,
    style: Style,
) -> HashMap<String, LocalIdentity> {
    let mut targets = HashSet::new();
    for entry in entries {
        if entry["type"] != "document" {
            continue;
        }
        let doc_path = entry["path"].as_str();
        for plugin in normalize_plugin_entries(entry.get("info").and_then(|i| i.get("plugins"))) {
            let raw_target = match plugin {
                PluginConfigEntry::Str(ref s) if !s.starts_with('-') => Some(s.as_str()),
                PluginConfigEntry::Obj { ref package, .. } => Some(package.as_str()),
                _ => None,
            };
            if let Some(t) = raw_target
                && let Some(local) = configured_local_target(style, location_dir, doc_path, t)
            {
                targets.insert(local);
            }
        }
    }
    if targets.is_empty() {
        return HashMap::new();
    }
    let runtime_local: Vec<(String, String)> = runtime
        .iter()
        .filter_map(|e| {
            let id = e["id"].as_str()?.to_owned();
            if e["source"]["type"] != "local" {
                return None;
            }
            let path = e["source"]["path"].as_str()?.to_owned();
            Some((id, path))
        })
        .collect();

    tokio::task::spawn_blocking(move || {
        let inventory: Vec<_> =
            runtime_local.into_iter().map(|(id, service)| resolve_inventory_item(id, service)).collect();
        let mut identities = HashMap::new();
        for target in targets {
            let Some(Some(selected)) = declared_entrypoint_of(Path::new(&target)) else { continue };
            let reporting = reporting_entries(&selected, &inventory);
            let unique_ids: HashSet<&str> = reporting.iter().map(|e| e.id.as_str()).collect();
            if unique_ids.len() == 1
                && let Some(&id) = unique_ids.iter().next()
            {
                identities.insert(
                    target,
                    LocalIdentity {
                        id: id.to_owned(),
                        paths: reporting.into_iter().map(|e| e.service.clone()).collect(),
                    },
                );
            }
        }
        identities
    })
    .await
    .unwrap_or_default()
}

pub(super) async fn read_context(
    app: &App,
    workspace_id: &str,
    input: &ControlLocation,
    principal: Option<&CancellationToken>,
    cancel: Option<&CancellationToken>,
) -> Result<ReadContext, Fail> {
    check_cancelled(cancel)?;
    let workspace = app.workspace(workspace_id).map_err(|_| fail(Status::NOT_FOUND, "Workspace not found"))?;
    let directory = crate::shared::js_trim(&input.directory).to_owned();
    let ws_selector = input.workspace_id.as_deref().map(|s| crate::shared::js_trim(s).to_owned());
    if directory.is_empty() || directory.contains('\0') || ws_selector.as_deref().is_some_and(str::is_empty) {
        return Err(fail(Status::UNPROCESSABLE_ENTITY, "Invalid OpenCode location"));
    }
    if workspace.status != "ready" {
        return Err(fail(Status::SERVICE_UNAVAILABLE, "OpenCode service is unavailable"));
    }
    let endpoint = match cancel {
        Some(tok) => tokio::select! {
            biased;
            _ = tok.cancelled() => return Err(fail(Status::SERVICE_UNAVAILABLE, "OpenCode did not answer in time")),
            res = app.native.acquire(Instant::now() + ACQUIRE_TIMEOUT) => {
                res.map_err(|_| fail(Status::SERVICE_UNAVAILABLE, "OpenCode service is unavailable"))?
            }
        },
        None => app
            .native
            .acquire(Instant::now() + ACQUIRE_TIMEOUT)
            .await
            .map_err(|_| fail(Status::SERVICE_UNAVAILABLE, "OpenCode service is unavailable"))?,
    };
    assert_current(app, &endpoint, &workspace, principal)?;

    let foreign = fail(Status::FORBIDDEN, "Location is not owned by this workspace");
    // OpenCode V2 identifies locations by directory; a retired `workspaceID` selector or an
    // unrepresentable UTF-16 directory is never owned.
    if ws_selector.is_some() || input.unrepresentable_workspace_id || input.unrepresentable_directory {
        return Err(foreign);
    }
    let location_dir = resolve_owned_directory(app, &workspace, &directory).await.ok_or(foreign.clone())?;
    let location = ControlLocation::new(location_dir, None);
    // Pin root and target physical identities BEFORE native `/api/config` & `/api/plugin` reads,
    // refusing redirected paths and re-confirming ownership while the captured pin stays live.
    let location_pin = capture_location_pin(&workspace, &location.directory).await.ok_or(foreign.clone())?;
    if resolve_owned_directory(app, &workspace, &location.directory).await.as_deref()
        != Some(location.directory.as_str())
        || !pin_still_live(&workspace, &location.directory, &location_pin).await
    {
        return Err(foreign);
    }
    check_cancelled(cancel)?;
    assert_current(app, &endpoint, &workspace, principal)?;

    let query = [("location[directory]", location.directory.as_str())];
    let (config, plugin) = tokio::join!(
        native_get_cancellable(
            app,
            &endpoint,
            "/api/config",
            &query,
            Duration::from_secs(12),
            16 * 1024 * 1024,
            cancel
        ),
        native_get_cancellable(
            app,
            &endpoint,
            "/api/plugin",
            &query,
            Duration::from_secs(12),
            16 * 1024 * 1024,
            cancel
        ),
    );
    check_cancelled(cancel)?;
    assert_current(app, &endpoint, &workspace, principal)?;
    if !pin_still_live(&workspace, &location.directory, &location_pin).await {
        return Err(foreign);
    }
    let (entries, runtime) = match (config, plugin) {
        (Ok(Value::Array(entries)), Ok(p)) if p["data"].is_array() => {
            (entries, p["data"].as_array().cloned().unwrap_or_default())
        }
        _ => return Err(fail(Status::SERVICE_UNAVAILABLE, "Unable to read OpenCode plugin configuration")),
    };

    let style = Style::host();
    let global_dir = entries
        .iter()
        .find(|e| e["type"] == "directory")
        .and_then(rules::path_of)
        .filter(|g| style.valid_absolute(g))
        .ok_or(fail(Status::SERVICE_UNAVAILABLE, "OpenCode did not report its global configuration directory"))?
        .to_owned();
    if !style.valid_absolute(&location.directory) {
        return Err(fail(Status::UNPROCESSABLE_ENTITY, "OpenCode location directory is invalid"));
    }

    let (g_copy, p_copy, e_copy) = (global_dir.clone(), location.directory.clone(), entries.clone());
    let raw_targets = tokio::task::spawn_blocking(move || resolve_targets(style, &g_copy, &p_copy, &e_copy, false))
        .await
        .map_err(|_| Fail::Generic)??;
    let targets: Vec<ResolvedTarget> = raw_targets
        .into_iter()
        .map(|t| ResolvedTarget {
            scope: if t.project { Scope::Project } else { Scope::Global },
            path: t.path,
            io_path: t.io,
            requested_io_path: t.requested_io,
            exists: t.exists,
        })
        .collect();

    let g_managed = global_dir.clone();
    let managed_plugins =
        tokio::task::spawn_blocking(move || read_managed_desktop_plugins(&g_managed, style)).await.unwrap_or_default();
    check_cancelled(cancel)?;
    assert_current(app, &endpoint, &workspace, principal)?;

    let needs_versions = runtime.iter().any(|entry| {
        entry["source"]["type"] == "package"
            && entry["source"]["target"]
                .as_str()
                .is_some_and(|t| git_plugin_revision(t, entry["source"]["version"].as_str()).is_some())
    });
    let package_versions = if needs_versions {
        fetch_package_versions(app, &endpoint, &location.directory, cancel).await
    } else {
        HashMap::new()
    };

    let local_identities = resolve_local_identities(&entries, &runtime, &location.directory, style).await;
    check_cancelled(cancel)?;
    assert_current(app, &endpoint, &workspace, principal)?;

    Ok(ReadContext {
        workspace,
        endpoint,
        entries,
        runtime,
        location,
        location_pin,
        style,
        global_dir,
        targets,
        managed_plugins,
        package_versions,
        existing_entrypoints: None,
        discovery_loaders: None,
        local_identities,
    })
}

async fn verify_discovered_entrypoints(
    app: &App,
    ctx: &mut ReadContext,
    principal: Option<&CancellationToken>,
) -> Result<(), Fail> {
    let folders = discovery_folders(&ctx.entries, ctx.style);
    let style = ctx.style;
    let reported: Vec<String> = ctx
        .runtime
        .iter()
        .filter_map(|e| {
            (e["source"]["type"] == "local").then(|| e["source"]["path"].as_str().map(str::to_owned)).flatten()
        })
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let existing = tokio::task::spawn_blocking(move || {
        let mut set = HashSet::new();
        for file in reported {
            let Some(child) = discovery_child(style, &folders, &file) else { continue };
            let Some(Some(selected)) = discovery_entrypoint_of(Path::new(&child)) else { continue };
            let file_path = Path::new(&file);
            let same = selected == file_path
                || (dunce::canonicalize(&selected)
                    .ok()
                    .is_some_and(|s| dunce::canonicalize(file_path).ok() == Some(s)));
            if same {
                set.insert(file);
            }
        }
        set
    })
    .await
    .unwrap_or_default();
    assert_current(app, &ctx.endpoint, &ctx.workspace, principal)?;
    ctx.existing_entrypoints = Some(existing);
    Ok(())
}

async fn compute_discovery_loaders(ctx: &ReadContext) -> Option<Vec<Vec<String>>> {
    let folders = discovery_folders(&ctx.entries, ctx.style);
    let style = ctx.style;
    let managed = ctx.managed_plugins.clone();
    let runtime_local: Vec<(String, String)> = ctx
        .runtime
        .iter()
        .filter_map(|e| {
            let id = e["id"].as_str()?.to_owned();
            if e["source"]["type"] != "local" {
                return None;
            }
            let path = e["source"]["path"].as_str()?.to_owned();
            Some((id, path))
        })
        .collect();
    tokio::task::spawn_blocking(move || {
        let inventory: Vec<_> =
            runtime_local.into_iter().map(|(id, service)| resolve_inventory_item(id, service)).collect();
        discovery_loaders(&folders, &inventory, &managed, style)
    })
    .await
    .ok()
    .flatten()
}

/// `PluginControls.read`: `GET /api/workspaces/:id/plugin-controls`.
pub(crate) async fn read(
    app: &App,
    workspace_id: &str,
    location: &ControlLocation,
    principal: Option<&CancellationToken>,
    cancel: Option<&CancellationToken>,
) -> Result<Snapshot, Fail> {
    read_bound(app, workspace_id, location, principal, cancel).await.map(|(snapshot, _, _, _)| snapshot)
}

/// `PluginControls.read` returning the bound `Workspace`, `Endpoint` and pre-read `LocationPin`
/// that produced the snapshot, so integration routes re-verify the exact same connection and
/// physical directory identity after catalog waits and follow-up RPCs.
pub(crate) async fn read_bound(
    app: &App,
    workspace_id: &str,
    location: &ControlLocation,
    principal: Option<&CancellationToken>,
    cancel: Option<&CancellationToken>,
) -> Result<(Snapshot, Workspace, Arc<Endpoint>, LocationPin), Fail> {
    let mut ctx = read_context(app, workspace_id, location, principal, cancel).await?;
    let base = snapshot_base(&ctx.eval_ctx())?;
    let mut snapshot = evaluate_documents(&base, &ctx.eval_ctx(), None).snapshot;
    if snapshot.controls.iter().any(|c| c.runtime.is_none() && c.managed_by.is_none() && !c.builtin) {
        ctx.discovery_loaders = compute_discovery_loaders(&ctx).await;
        assert_current(app, &ctx.endpoint, &ctx.workspace, principal)?;
        snapshot = evaluate_documents(&base, &ctx.eval_ctx(), None).snapshot;
    }

    let (documents, _) = config_documents(&ctx.eval_ctx());
    let targets = ctx.targets.clone();
    let loaded: Vec<(ResolvedTarget, Option<Document>)> = tokio::task::spawn_blocking(move || {
        targets
            .into_iter()
            .map(|t| {
                let doc = fs::load(&t.io_path).ok();
                (t, doc)
            })
            .collect()
    })
    .await
    .unwrap_or_default();

    for (target, doc) in loaded {
        let Some(doc) = doc else { continue };
        if !doc.exists {
            continue;
        }
        let Ok(raw_plugins) = document_plugins(&doc) else { continue };
        let normalized = documents.iter().find(|d| d.path.as_deref().is_some_and(|p| ctx.style.same(p, &target.path)));
        let Some(normalized) = normalized else { continue };
        if normalized.plugins != raw_plugins {
            continue;
        }
        let rev = document_revision(workspace_id, &ctx.location, &target, &ctx.endpoint, &doc);
        if let Some(slot) = snapshot.targets.iter_mut().find(|t| t.scope == target.scope.as_str()) {
            slot.expected_revision = Some(rev);
        }
    }
    assert_current(app, &ctx.endpoint, &ctx.workspace, principal)?;
    check_cancelled(cancel)?;
    if !pin_still_live(&ctx.workspace, &ctx.location.directory, &ctx.location_pin).await {
        return Err(fail(Status::FORBIDDEN, "Location is not owned by this workspace"));
    }
    check_cancelled(cancel)?;
    assert_current(app, &ctx.endpoint, &ctx.workspace, principal)?;
    Ok((snapshot, ctx.workspace, ctx.endpoint, ctx.location_pin))
}

/// `PluginControls.readConfigDocuments` (`strictDocuments = false`) for `sources::add`.
pub(super) async fn read_config_documents(
    app: &App,
    workspace_id: &str,
    location: &ControlLocation,
    principal: Option<&CancellationToken>,
    cancel: Option<&CancellationToken>,
) -> Result<Vec<(ResolvedTarget, Document, Vec<PluginConfigEntry>)>, Fail> {
    let ctx = read_context(app, workspace_id, location, principal, cancel).await?;
    let targets = ctx.targets.clone();
    let docs = tokio::task::spawn_blocking(move || {
        targets
            .into_iter()
            .map(|t| {
                let d = fs::load(&t.io_path)?;
                let plugins = document_plugins(&d)?;
                Ok((t, d, plugins))
            })
            .collect::<Result<Vec<_>, crate::subagent_depth::document::DocError>>()
    })
    .await
    .map_err(|_| Fail::Generic)?
    // Matches TS `readConfigDocuments`: document load/parse errors are NOT mapped to `PluginControlsError`,
    // so `routes/plugin-sources.ts` renders `500 {"error":"Plugin source update failed"}`.
    .map_err(|_| Fail::Generic)?;
    assert_current(app, &ctx.endpoint, &ctx.workspace, principal)?;
    check_cancelled(cancel)?;
    Ok(docs)
}

/// `PluginControls.mutate`: `PATCH /api/workspaces/:id/plugin-controls`.
pub(super) async fn mutate(
    app: &Shared,
    workspace_id: &str,
    req: ActivationMutationRequest,
    principal: Option<CancellationToken>,
) -> Result<ActivationMutationResponse, Fail> {
    let queue_key = match req.scope {
        Scope::Global => format!("{workspace_id}\nglobal"),
        Scope::Project => fence::project_key(workspace_id, &req.location.directory),
    };
    let queue_guard = fence::serialize(queue_key).await;

    let mut ctx = read_context(app, workspace_id, &req.location, principal.as_ref(), None).await?;
    let target_idx = ctx
        .targets
        .iter()
        .position(|t| t.scope == req.scope)
        .ok_or(fail(Status::SERVICE_UNAVAILABLE, "OpenCode configuration scope is unavailable"))?;

    let owner = ownership::resolve(app, &ctx.workspace, &ctx.location.directory)
        .await
        .ok_or(fail(Status::FORBIDDEN, "Location is not owned by an active worktree"))?;
    let admitted = fence::enter(&[fence::identity(&owner.checkout)])
        .ok_or(fail(Status::CONFLICT, "Worktree deletion is in progress"))?;

    verify_discovered_entrypoints(app, &mut ctx, principal.as_ref()).await?;
    ctx.discovery_loaders = compute_discovery_loaders(&ctx).await;

    let exact = req.scope == Scope::Global
        && req.plugin_id.as_deref() == Some(MISSIONS_PLUGIN_ID)
        && req.managed_by.as_deref() == Some("codenomad");
    let target = ctx.targets[target_idx].clone();
    let load_path = if exact { target.requested_io_path.clone() } else { target.io_path.clone() };
    let doc =
        tokio::task::spawn_blocking(move || fs::load(&load_path)).await.map_err(|_| Fail::Generic)?.map_err(mapped)?;
    let raw_plugins = document_plugins(&doc).map_err(mapped)?;

    let eval_ctx = ctx.eval_ctx();
    let base = snapshot_base(&eval_ctx)?;
    let authoritative = evaluate_documents(&base, &eval_ctx, None).snapshot;
    let auth_ids: Vec<String> = authoritative.controls.iter().map(|c| c.id.clone()).collect();
    let (projected_plugins, no_op_safe) =
        mutation_target_plugins(&base.documents, ctx.style, &target.path, &raw_plugins, &auth_ids);
    let before = evaluate_documents(
        &base,
        &eval_ctx,
        Some(&Overlay { service_path: &target.path, plugins: &projected_plugins, scope: req.scope }),
    )
    .snapshot;

    let Some(plugin_id) = req.plugin_id.as_deref() else {
        return Err(fail(Status::FORBIDDEN, "Plugin ID is not present in the authorized inventory"));
    };
    let control = before.controls.iter().find(|c| c.id == plugin_id);
    let authorized = control.is_some_and(|c| req.managed_by.as_deref().is_none_or(|m| c.managed_by == Some(m)));
    if !authorized {
        return Err(fail(Status::FORBIDDEN, "Plugin ID is not present in the authorized inventory"));
    }
    let control = control.unwrap();
    if exact && !ctx.style.same(&target.requested_io_path, &doc.write) {
        return Err(fail(
            Status::SERVICE_UNAVAILABLE,
            "Missions activation requires a direct OpenCode global configuration file",
        ));
    }

    let desired = if req.enabled { ScopeRuleState::Enabled } else { ScopeRuleState::Disabled };
    let rule = if req.enabled { plugin_id.to_owned() } else { format!("-{plugin_id}") };
    let exact_global = |snap: &Snapshot, plugins: &[PluginConfigEntry]| -> bool {
        let deciding = snap
            .configured
            .rules
            .iter()
            .rev()
            .find(|r| r.scope == ConfigScope::Global && matches_selector(&r.selector, plugin_id));
        deciding.is_some_and(|r| {
            r.path.as_deref().is_some_and(|p| ctx.style.same(p, &target.path))
                && plugins.get(r.entry_index).and_then(PluginConfigEntry::as_str) == Some(rule.as_str())
        })
    };

    assert_current(app, &ctx.endpoint, &ctx.workspace, principal.as_ref())?;
    let current_scope_state = match req.scope {
        Scope::Global => control.global,
        Scope::Project => control.project,
    };
    if no_op_safe && current_scope_state == desired && (!exact || exact_global(&before, &raw_plugins)) {
        return Ok(ActivationMutationResponse {
            snapshot: before,
            rule,
            target: target.public(),
            changed: false,
            reload_pending: false,
        });
    }

    let removable = if no_op_safe {
        replaceable_rule_indexes(
            &raw_plugins,
            &projected_plugins,
            &before,
            &target.path,
            req.scope,
            plugin_id,
            ctx.style,
        )
    } else {
        Vec::new()
    };
    let kept: Vec<PluginConfigEntry> =
        projected_plugins.iter().enumerate().filter(|(i, _)| !removable.contains(i)).map(|(_, e)| e.clone()).collect();

    let mut candidates: Vec<(Vec<usize>, Option<&str>)> = Vec::new();
    if !removable.is_empty() {
        candidates.push((removable.clone(), None));
        candidates.push((removable.clone(), Some(rule.as_str())));
    }
    candidates.push((Vec::new(), Some(rule.as_str())));

    let scope_cfg: ConfigScope = req.scope.into();
    let mut chosen: Option<(Vec<usize>, Option<String>, Snapshot)> = None;
    for (rem, cand_rule) in candidates {
        if exact && cand_rule.is_none() {
            continue;
        }
        let mut plugins = if rem.is_empty() && cand_rule.is_some() { projected_plugins.clone() } else { kept.clone() };
        if let Some(r) = cand_rule {
            plugins.push(PluginConfigEntry::Str(r.to_owned()));
        }
        let evaluated = evaluate_documents(
            &base,
            &eval_ctx,
            Some(&Overlay { service_path: &target.path, plugins: &plugins, scope: req.scope }),
        );
        let Some(pos) = evaluated
            .documents
            .iter()
            .find(|d| d.path.as_deref().is_some_and(|p| ctx.style.same(p, &target.path)))
            .map(|d| d.order)
        else {
            continue;
        };
        let through = evaluated.documents.iter().filter(|d| d.scope == scope_cfg).map(|d| d.order).max().unwrap_or(pos);
        if cand_rule.is_some()
            && req.enabled
            && !defined_before(&evaluated.sequence, plugin_id, pos, plugins.len() - 1, None)
        {
            continue;
        }
        if enabled_through(&evaluated.sequence, plugin_id, through) != req.enabled {
            continue;
        }
        if exact && !exact_global(&evaluated.snapshot, &plugins) {
            continue;
        }
        chosen = Some((rem, cand_rule.map(str::to_owned), evaluated.snapshot));
        break;
    }

    let Some((remove_indexes, append_rule, snapshot)) = chosen else {
        return Err(fail(Status::FORBIDDEN, "OpenCode's plugin order cannot reach this state without a package spec"));
    };
    let disable_rule = format!("-{plugin_id}");
    let updated =
        replace_plugin_control_rules(&doc, &remove_indexes, &[plugin_id, &disable_rule], append_rule.as_deref())
            .map_err(mapped)?;

    let app_commit = app.clone();
    let endpoint = ctx.endpoint.clone();
    let workspace = ctx.workspace.clone();
    tokio::task::spawn_blocking(move || {
        let _held = (admitted, queue_guard);
        let prepared = fs::prepare(&doc, &updated).map_err(mapped)?;
        prepared.commit_checked(mapped, || guard_current(&app_commit, &endpoint, None, &workspace, principal.as_ref()))
    })
    .await
    .map_err(|_| Fail::Generic)??;

    let mut out_target = target.public();
    out_target.exists = true;
    Ok(ActivationMutationResponse { snapshot, rule, target: out_target, changed: true, reload_pending: true })
}

#[derive(Clone, Debug)]
pub(crate) struct PinnedLocation {
    pub(crate) workspace_root: std::path::PathBuf,
    pub(crate) directory: String,
    pub(crate) pin: LocationPin,
}

fn check_pinned_location_sync(pinned: Option<&PinnedLocation>) -> Result<(), Fail> {
    let Some(pinned) = pinned else {
        return Ok(());
    };
    if !pin_still_live_sync(&pinned.workspace_root, &pinned.directory, &pinned.pin) {
        return Err(fail(Status::FORBIDDEN, "Location is not owned by this workspace"));
    }
    Ok(())
}

pub(super) struct EditTarget<'a> {
    pub(super) workspace_id: &'a str,
    pub(super) location: &'a ControlLocation,
    pub(super) scope: Scope,
    pub(super) principal: Option<CancellationToken>,
    pub(super) pinned_endpoint: Option<Arc<Endpoint>>,
    pub(super) pinned_location: Option<PinnedLocation>,
}

/// Shared commit-admission state for `POST /plugin-sources` deadline arbitration:
/// - `COMMIT_PENDING`: neither timed out past grace nor admitted to rename.
/// - `COMMIT_ABORTED`: grace elapsed and timeout won; `rename` must not execute.
/// - `COMMIT_ADMITTED`: `rename` admitted under `guard_current`; timeout must not be published.
pub(super) const COMMIT_PENDING: u8 = 0;
pub(super) const COMMIT_ABORTED: u8 = 1;
pub(super) const COMMIT_ADMITTED: u8 = 2;

/// Cancellable single-document edit for `POST /api/workspaces/:id/plugin-sources`.
pub(super) async fn edit_config_document_cancellable<E, F>(
    app: &Shared,
    target_req: EditTarget<'_>,
    cancel: CancellationToken,
    deadline: Instant,
    commit_state: Arc<std::sync::atomic::AtomicU8>,
    map_fail: impl Fn(Fail) -> E + Send + Copy + 'static,
    timeout_err: impl Fn() -> E + Send + Copy + 'static,
    edit: F,
) -> Result<(), E>
where
    E: Send + 'static,
    F: FnOnce(&Document, &[PluginConfigEntry]) -> Result<jsonc::Text, E> + Send + 'static,
{
    let EditTarget { workspace_id, location, scope, principal, pinned_endpoint, pinned_location } = target_req;
    let queue_key = match scope {
        Scope::Global => format!("{workspace_id}\nglobal"),
        Scope::Project => fence::project_key(workspace_id, &location.directory),
    };
    let queue_guard = fence::serialize(queue_key).await;
    if cancel.is_cancelled() || Instant::now() >= deadline {
        return Err(timeout_err());
    }

    let ctx = read_context(app, workspace_id, location, principal.as_ref(), Some(&cancel)).await.map_err(map_fail)?;
    if let Some(ref pinned) = pinned_endpoint {
        assert_current(app, pinned, &ctx.workspace, principal.as_ref()).map_err(map_fail)?;
    }
    if pinned_location.as_ref().is_some_and(|p| p.directory != ctx.location.directory || p.pin != ctx.location_pin) {
        return Err(map_fail(fail(Status::FORBIDDEN, "Location is not owned by this workspace")));
    }
    let target =
        ctx.targets.into_iter().find(|t| t.scope == scope).ok_or_else(|| {
            map_fail(fail(Status::SERVICE_UNAVAILABLE, "OpenCode configuration scope is unavailable"))
        })?;

    let owner = ownership::resolve(app, &ctx.workspace, &ctx.location.directory)
        .await
        .ok_or_else(|| map_fail(fail(Status::FORBIDDEN, "Location is not owned by an active worktree")))?;
    if pinned_location.as_ref().is_some_and(|p| p.directory != owner.directory) {
        return Err(map_fail(fail(Status::FORBIDDEN, "Location is not owned by this workspace")));
    }
    let admitted = fence::enter(&[fence::identity(&owner.checkout)])
        .ok_or_else(|| map_fail(fail(Status::CONFLICT, "Worktree deletion is in progress")))?;

    let app_commit = app.clone();
    let endpoint = ctx.endpoint;
    let workspace = ctx.workspace;
    tokio::task::spawn_blocking(move || {
        let _held = (admitted, queue_guard);
        if cancel.is_cancelled() || Instant::now() >= deadline {
            return Err(timeout_err());
        }
        check_pinned_location_sync(pinned_location.as_ref()).map_err(map_fail)?;
        let doc = fs::load(&target.io_path).map_err(|e| map_fail(mapped(e)))?;
        let plugins = document_plugins(&doc).map_err(|e| map_fail(mapped(e)))?;
        if let Some(ref pinned) = pinned_endpoint {
            assert_current(&app_commit, pinned, &workspace, principal.as_ref()).map_err(map_fail)?;
        }
        assert_current(&app_commit, &endpoint, &workspace, principal.as_ref()).map_err(map_fail)?;
        let updated = edit(&doc, &plugins)?;
        let mut prepared = fs::prepare(&doc, &updated).map_err(|e| map_fail(mapped(e)))?;
        prepared.commit_in_place(
            |e| map_fail(mapped(e)),
            || {
                check_pinned_location_sync(pinned_location.as_ref()).map_err(map_fail)?;
                guard_current(&app_commit, &endpoint, pinned_endpoint.as_ref(), &workspace, principal.as_ref())
                    .map_err(map_fail)
            },
            || {
                use std::sync::atomic::Ordering;
                if Instant::now() >= deadline {
                    let _ = commit_state.compare_exchange(
                        COMMIT_PENDING,
                        COMMIT_ABORTED,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    );
                    return Err(timeout_err());
                }
                if commit_state
                    .compare_exchange(COMMIT_PENDING, COMMIT_ADMITTED, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
                {
                    return Err(timeout_err());
                }
                Ok(())
            },
        )
    })
    .await
    .map_err(|_| map_fail(Fail::Generic))?
}

/// Multi-document prepared commit (`PluginControls.editPluginDocuments`) for `DELETE /plugin-sources`.
pub(super) async fn edit_plugin_documents<E, F>(
    app: &Shared,
    target_req: EditTarget<'_>,
    expected_revision: &str,
    map_fail: impl Fn(Fail) -> E + Send + Copy + 'static,
    edit: F,
) -> Result<(), E>
where
    E: Send + 'static,
    F: FnOnce(&PluginDocumentsView<'_>) -> Result<Vec<(Scope, jsonc::Text)>, E>,
{
    let EditTarget { workspace_id, location, scope, principal, pinned_endpoint: _, pinned_location: _ } = target_req;
    // Global and Project queues are always held in that fixed order.
    let global_guard = fence::serialize(format!("{workspace_id}\nglobal")).await;
    let project_guard = fence::serialize(fence::project_key(workspace_id, &location.directory)).await;

    let mut ctx = read_context(app, workspace_id, location, principal.as_ref(), None).await.map_err(map_fail)?;
    if !ctx.targets.iter().any(|t| t.scope == scope) {
        return Err(map_fail(fail(Status::SERVICE_UNAVAILABLE, "OpenCode configuration scope is unavailable")));
    }

    let owner = ownership::resolve(app, &ctx.workspace, &ctx.location.directory)
        .await
        .ok_or_else(|| map_fail(fail(Status::FORBIDDEN, "Location is not owned by an active worktree")))?;
    let admitted = fence::enter(&[fence::identity(&owner.checkout)])
        .ok_or_else(|| map_fail(fail(Status::CONFLICT, "Worktree deletion is in progress")))?;

    verify_discovered_entrypoints(app, &mut ctx, principal.as_ref()).await.map_err(map_fail)?;

    let targets_to_load = ctx.targets.clone();
    let loaded_docs: Vec<(ResolvedTarget, Document)> = tokio::task::spawn_blocking(move || {
        targets_to_load.into_iter().map(|t| fs::load(&t.io_path).map(|d| (t, d))).collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|_| map_fail(Fail::Generic))?
    .map_err(|e| map_fail(mapped(e)))?;

    let confirmed = loaded_docs
        .iter()
        .find(|(t, _)| t.scope == scope)
        .ok_or_else(|| map_fail(fail(Status::SERVICE_UNAVAILABLE, "OpenCode configuration scope is unavailable")))?;
    let actual_rev = document_revision(workspace_id, &ctx.location, &confirmed.0, &ctx.endpoint, &confirmed.1);
    if !revision_eq(expected_revision, &actual_rev) {
        return Err(map_fail(fail(Status::CONFLICT, "OpenCode configuration changed since confirmation")));
    }

    ctx.discovery_loaders = compute_discovery_loaders(&ctx).await;
    assert_current(app, &ctx.endpoint, &ctx.workspace, principal.as_ref()).map_err(map_fail)?;

    let eval_ctx = ctx.eval_ctx();
    let base = snapshot_base(&eval_ctx).map_err(map_fail)?;
    let evaluated = evaluate_documents(&base, &eval_ctx, None);
    let applied = &evaluated.documents;
    let at_path = |item_path: Option<&str>, target_path: &str| -> bool {
        item_path.is_some_and(|p| ctx.style.same(p, target_path))
    };

    let mut view_targets = Vec::with_capacity(loaded_docs.len());
    for (target, doc) in &loaded_docs {
        let normalized = applied.iter().find(|d| at_path(d.path.as_deref(), &target.path));
        let raw_plugins = document_plugins(doc).map_err(|e| map_fail(mapped(e)))?;
        let consistent = doc.exists && normalized.is_some_and(|n| n.plugins == raw_plugins);
        let sources: Vec<ConfiguredSource> = evaluated
            .snapshot
            .configured
            .sources
            .iter()
            .filter(|s| at_path(s.path.as_deref(), &target.path))
            .cloned()
            .collect();
        let rules: Vec<ConfiguredRule> = evaluated
            .snapshot
            .configured
            .rules
            .iter()
            .filter(|r| at_path(r.path.as_deref(), &target.path))
            .cloned()
            .collect();
        view_targets.push(PluginDocumentsTarget {
            scope: target.scope,
            document: doc.clone(),
            order: normalized.map(|n| n.order),
            consistent,
            sources,
            rules,
        });
    }

    let view = PluginDocumentsView {
        ctx: &ctx,
        all_sources: evaluated.snapshot.configured.sources,
        runtime: evaluated.snapshot.runtime,
        controls: evaluated.snapshot.controls,
        sequence: evaluated.sequence,
        targets: view_targets,
    };

    let updates = edit(&view)?;
    if updates.is_empty() {
        return Ok(());
    }

    // Prepare changed files in physical write-path order to prevent lock inversion.
    let mut plan: Vec<(Scope, Document, jsonc::Text)> = Vec::with_capacity(updates.len());
    for (upd_scope, updated) in updates {
        let (_, doc) = loaded_docs.iter().find(|(t, _)| t.scope == upd_scope).ok_or_else(|| {
            map_fail(fail(Status::SERVICE_UNAVAILABLE, "OpenCode configuration scope is unavailable"))
        })?;
        plan.push((upd_scope, doc.clone(), updated));
    }
    plan.sort_by(|a, b| a.1.write.cmp(&b.1.write));

    let app_commit = app.clone();
    let endpoint = ctx.endpoint.clone();
    let workspace = ctx.workspace.clone();
    tokio::task::spawn_blocking(move || {
        let _held = (admitted, project_guard, global_guard);
        let mut prepared: Vec<(Scope, fs::Prepared)> = Vec::with_capacity(plan.len());
        for (item_scope, doc, updated) in plan {
            assert_current(&app_commit, &endpoint, &workspace, principal.as_ref()).map_err(map_fail)?;
            let prep = fs::prepare(&doc, &updated).map_err(|e| map_fail(mapped(e)))?;
            prepared.push((item_scope, prep));
        }
        for (_, prep) in &prepared {
            prep.verify().map_err(|e| map_fail(mapped(e)))?;
        }
        // Safety commit order: dependent cleanup first, confirmed source document last.
        // Keep every `Prepared` (and its replacement lock) alive until the whole batch completes.
        prepared.sort_by_key(|(item_scope, _)| usize::from(*item_scope == scope));
        for (_, prep) in &mut prepared {
            prep.commit_in_place(
                |e| map_fail(mapped(e)),
                || guard_current(&app_commit, &endpoint, None, &workspace, principal.as_ref()).map_err(map_fail),
                || Ok(()),
            )?;
        }
        drop(prepared);
        Ok(())
    })
    .await
    .map_err(|_| map_fail(Fail::Generic))?
}
