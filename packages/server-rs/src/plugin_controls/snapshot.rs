//! Pure snapshot & applied-order evaluation (`opencode/plugin-controls.ts` lines 698-1271).

use std::collections::{HashMap, HashSet};

use axum::http::StatusCode as Status;
use serde::Serialize;
use serde_json::Value;

use crate::{
    files::node_path::Style,
    opencode_settings::{Scope, fail},
    subagent_depth::Fail,
};

use super::{
    discovery::{
        ManagedDesktopPlugin, discovery_entrypoint_shape, file_url_to_path, managed_desktop_plugin_for_source,
    },
    doc::{PluginConfigEntry, contains_config_variable_entry, normalize_plugin_entries},
    order::{AppliedEntry, AppliedSequence, control_id_cmp, is_exact_selector, matches_selector, valid_plugin_id},
    spec::{git_plugin_revision, plugin_package_identities},
};

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ControlLocation {
    pub(crate) directory: String,
    #[serde(rename = "workspaceID", skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_id: Option<String>,
    /// Raw JSON `location.directory` contained an unpaired UTF-16 surrogate (never substituted).
    #[serde(skip)]
    pub(super) unrepresentable_directory: bool,
    /// Raw JSON `location.workspaceID` was present and contained an unpaired UTF-16 surrogate.
    #[serde(skip)]
    pub(super) unrepresentable_workspace_id: bool,
}

impl ControlLocation {
    pub(crate) fn new(directory: String, workspace_id: Option<String>) -> Self {
        Self { directory, workspace_id, unrepresentable_directory: false, unrepresentable_workspace_id: false }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ConfigScope {
    Global,
    Project,
    Other,
    Virtual,
}

impl From<Scope> for ConfigScope {
    fn from(scope: Scope) -> Self {
        match scope {
            Scope::Global => Self::Global,
            Scope::Project => Self::Project,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum RuntimeSource {
    Builtin,
    Sdk,
    Local {
        path: String,
    },
    Package {
        target: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        revision: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        outdated: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        updating: Option<bool>,
    },
}

#[derive(Clone, Debug, Default, Serialize)]
pub(crate) struct RuntimeFeatures {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) server: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tui: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rpc: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) gui: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(crate) enum RuntimeState {
    Active,
    Failed {
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "ref")]
        reference: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RuntimeEntry {
    pub(crate) key: String,
    #[serde(rename = "managedBy", skip_serializing_if = "Option::is_none")]
    pub(crate) managed_by: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) id: Option<String>,
    pub(crate) source: RuntimeSource,
    pub(crate) features: RuntimeFeatures,
    pub(crate) state: RuntimeState,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ConfiguredRule {
    pub(crate) selector: String,
    pub(crate) enabled: bool,
    pub(crate) scope: ConfigScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    pub(crate) order: usize,
    #[serde(rename = "entryIndex")]
    pub(crate) entry_index: usize,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ConfiguredSource {
    pub(crate) target: String,
    #[serde(rename = "managedBy", skip_serializing_if = "Option::is_none")]
    pub(crate) managed_by: Option<&'static str>,
    pub(crate) scope: ConfigScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    #[serde(rename = "entryIndex")]
    pub(crate) entry_index: usize,
    #[serde(rename = "hasOptions")]
    pub(crate) has_options: bool,
    #[serde(rename = "pluginId", skip_serializing_if = "Option::is_none")]
    pub(crate) plugin_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ScopeRuleState {
    Default,
    Enabled,
    Disabled,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ActivationControl {
    pub(crate) id: String,
    #[serde(rename = "managedBy", skip_serializing_if = "Option::is_none")]
    pub(crate) managed_by: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime: Option<RuntimeEntry>,
    pub(crate) builtin: bool,
    pub(crate) effective: ScopeRuleState,
    pub(crate) global: ScopeRuleState,
    pub(crate) project: ScopeRuleState,
    #[serde(rename = "controllingRule", skip_serializing_if = "Option::is_none")]
    pub(crate) controlling_rule: Option<ConfiguredRule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) orphan: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ControlTarget {
    pub(crate) scope: &'static str,
    pub(crate) path: String,
    pub(crate) exists: bool,
    #[serde(rename = "expectedRevision", skip_serializing_if = "Option::is_none")]
    pub(crate) expected_revision: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ConfiguredSummary {
    pub(crate) rules: Vec<ConfiguredRule>,
    pub(crate) sources: Vec<ConfiguredSource>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Snapshot {
    pub(crate) location: ControlLocation,
    pub(crate) runtime: Vec<RuntimeEntry>,
    pub(crate) configured: ConfiguredSummary,
    pub(crate) controls: Vec<ActivationControl>,
    pub(crate) targets: Vec<ControlTarget>,
}

#[derive(Clone, Debug)]
pub(super) struct ConfigDocumentView {
    pub(super) path: Option<String>,
    pub(super) scope: ConfigScope,
    pub(super) plugins: Vec<PluginConfigEntry>,
    pub(super) order: usize,
}

#[derive(Clone, Debug)]
pub(super) struct LocalIdentity {
    pub(super) id: String,
    pub(super) paths: Vec<String>,
}

#[derive(Clone, Debug)]
pub(super) struct PackageVersionInfo {
    pub(super) revision: String,
    pub(super) version: String,
}

#[derive(Clone, Debug)]
pub(super) struct ResolvedTarget {
    pub(super) scope: Scope,
    pub(super) path: String,
    pub(super) io_path: String,
    pub(super) requested_io_path: String,
    pub(super) exists: bool,
}

impl ResolvedTarget {
    pub(super) fn public(&self) -> ControlTarget {
        ControlTarget {
            scope: self.scope.as_str(),
            path: self.path.clone(),
            exists: self.exists,
            expected_revision: None,
        }
    }
}

pub(super) struct EvalContext<'a> {
    pub(super) location: &'a ControlLocation,
    pub(super) entries: &'a [Value],
    pub(super) runtime: &'a [Value],
    pub(super) style: Style,
    pub(super) global_dir: &'a str,
    pub(super) targets: &'a [ResolvedTarget],
    pub(super) managed_plugins: &'a [ManagedDesktopPlugin],
    pub(super) package_versions: &'a HashMap<String, PackageVersionInfo>,
    pub(super) existing_entrypoints: Option<&'a HashSet<String>>,
    pub(super) discovery_loaders: Option<&'a [Vec<String>]>,
    pub(super) local_identities: &'a HashMap<String, LocalIdentity>,
}

pub(super) struct SnapshotBase {
    pub(super) runtime: Vec<RuntimeEntry>,
    pub(super) runtime_source_ids: HashMap<String, String>,
    pub(super) runtime_by_id: HashMap<String, RuntimeEntry>,
    pub(super) documents: Vec<ConfigDocumentView>,
    pub(super) source_orders: Vec<f64>,
}

pub(super) struct Overlay<'a> {
    pub(super) service_path: &'a str,
    pub(super) plugins: &'a [PluginConfigEntry],
    pub(super) scope: Scope,
}

pub(super) struct Evaluated {
    pub(super) snapshot: Snapshot,
    pub(super) sequence: AppliedSequence,
    pub(super) documents: Vec<ConfigDocumentView>,
}

pub(super) fn discovery_folders(entries: &[Value], style: Style) -> Vec<String> {
    let mut out = Vec::new();
    for entry in entries {
        if entry["type"] == "directory"
            && let Some(path) = entry["path"].as_str()
        {
            out.push(style.join(path, "plugin"));
            out.push(style.join(path, "plugins"));
        }
    }
    out
}

pub(super) fn discovery_child(style: Style, folders: &[String], file: &str) -> Option<String> {
    for folder in folders {
        let relative = style.relative(folder, file);
        if relative.is_empty() || super::discovery::escapes(style, &relative) {
            continue;
        }
        let first = relative.split(['/', '\\']).next().unwrap_or("");
        let child = style.join(folder, first);
        if discovery_entrypoint_shape(style, &child, file) {
            return Some(child);
        }
    }
    None
}

pub(super) fn configured_local_target(
    style: Style,
    location_dir: &str,
    document_path: Option<&str>,
    target: &str,
) -> Option<String> {
    if target.starts_with("file://") {
        return file_url_to_path(target, style);
    }
    if target.starts_with("./") || target.starts_with("../") {
        let base = document_path.map(|p| style.dirname(p)).unwrap_or_else(|| location_dir.to_owned());
        return Some(style.join(&base, target));
    }
    style.is_absolute(target).then(|| target.to_owned())
}

fn source_detail(source: &RuntimeSource) -> &str {
    match source {
        RuntimeSource::Package { target, .. } => target,
        RuntimeSource::Local { path } => path,
        RuntimeSource::Builtin => "builtin",
        RuntimeSource::Sdk => "sdk",
    }
}

fn normalize_runtime_source(
    source: &Value,
    package_versions: &HashMap<String, PackageVersionInfo>,
) -> Result<RuntimeSource, Fail> {
    let invalid = || fail(Status::SERVICE_UNAVAILABLE, "OpenCode returned an invalid plugin source");
    let obj = source.as_object().ok_or_else(invalid)?;
    match obj.get("type").and_then(Value::as_str) {
        Some("builtin") => Ok(RuntimeSource::Builtin),
        Some("sdk") => Ok(RuntimeSource::Sdk),
        Some("local") => {
            let path = obj.get("path").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(invalid)?;
            Ok(RuntimeSource::Local { path: path.to_owned() })
        }
        Some("package") => {
            let target = obj.get("target").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(invalid)?;
            let raw_version = obj.get("version").and_then(Value::as_str);
            let revision = git_plugin_revision(target, raw_version).map(str::to_owned);
            let version = if let Some(ref rev) = revision {
                let installed = package_versions.get(target);
                Some(match installed {
                    Some(info) if info.revision == *rev => info.version.clone(),
                    _ => rev[..rev.len().min(7)].to_owned(),
                })
            } else {
                raw_version.map(str::to_owned)
            };
            let outdated = (obj.get("outdated") == Some(&Value::Bool(true))).then_some(true);
            let updating = (obj.get("updating") == Some(&Value::Bool(true))).then_some(true);
            Ok(RuntimeSource::Package { target: target.to_owned(), version, revision, outdated, updating })
        }
        _ => Err(invalid()),
    }
}

fn normalize_runtime_entry(
    plugin: &Value,
    index: usize,
    package_versions: &HashMap<String, PackageVersionInfo>,
) -> Result<RuntimeEntry, Fail> {
    let invalid = || fail(Status::SERVICE_UNAVAILABLE, "OpenCode returned an invalid plugin inventory");
    let obj = plugin.as_object().ok_or_else(invalid)?;
    let state_obj = obj.get("state").and_then(Value::as_object).ok_or_else(invalid)?;
    let source = normalize_runtime_source(obj.get("source").unwrap_or(&Value::Null), package_versions)?;
    let id = obj.get("id").and_then(Value::as_str).filter(|s| valid_plugin_id(s)).map(str::to_owned);
    let features = match obj.get("features").and_then(Value::as_object) {
        Some(f) => RuntimeFeatures {
            server: (f.get("server") == Some(&Value::Bool(true))).then_some(true),
            tui: (f.get("tui") == Some(&Value::Bool(true))).then_some(true),
            rpc: (f.get("rpc") == Some(&Value::Bool(true))).then_some(true),
            gui: (f.get("gui") == Some(&Value::Bool(true))).then_some(true),
        },
        None => RuntimeFeatures::default(),
    };
    let state = match state_obj.get("status").and_then(Value::as_str) {
        Some("active") => RuntimeState::Active,
        Some("failed") => {
            let error = state_obj.get("error").and_then(Value::as_str).ok_or_else(invalid)?.to_owned();
            let reference = state_obj.get("ref").and_then(Value::as_str).map(str::to_owned);
            RuntimeState::Failed { error, reference }
        }
        _ => return Err(invalid()),
    };
    let key = id.clone().unwrap_or_else(|| {
        let kind = match &source {
            RuntimeSource::Builtin => "builtin",
            RuntimeSource::Sdk => "sdk",
            RuntimeSource::Local { .. } => "local",
            RuntimeSource::Package { .. } => "package",
        };
        format!("{kind}:{}:{index}", source_detail(&source))
    });
    Ok(RuntimeEntry { key, managed_by: None, id, source, features, state })
}

fn classify_scope(ctx: &EvalContext<'_>, service_path: Option<&str>) -> ConfigScope {
    let Some(service_path) = service_path else { return ConfigScope::Virtual };
    let parent = ctx.style.dirname(service_path);
    if ctx.style.same(&parent, ctx.global_dir) {
        return ConfigScope::Global;
    }
    let config_root = if ctx.style.basename(&parent) == ".opencode" { ctx.style.dirname(&parent) } else { parent };
    if ctx.style.contains(&config_root, &ctx.location.directory) { ConfigScope::Project } else { ConfigScope::Other }
}

pub(super) fn config_documents(ctx: &EvalContext<'_>) -> (Vec<ConfigDocumentView>, Vec<f64>) {
    let mut raw: Vec<(f64, Option<String>, ConfigScope, Vec<PluginConfigEntry>)> = Vec::new();
    for (source_order, entry) in ctx.entries.iter().enumerate() {
        if entry["type"] != "document" {
            continue;
        }
        let service_path = entry["path"].as_str().map(str::to_owned);
        let scope = classify_scope(ctx, service_path.as_deref());
        let plugins = normalize_plugin_entries(entry.get("info").and_then(|i| i.get("plugins")));
        raw.push((source_order as f64, service_path, scope, plugins));
    }
    raw.sort_by(|a, b| a.0.total_cmp(&b.0));
    let source_orders = raw.iter().map(|r| r.0).collect();
    let documents = raw
        .into_iter()
        .enumerate()
        .map(|(order, (_, path, scope, plugins))| ConfigDocumentView { path, scope, plugins, order })
        .collect();
    (documents, source_orders)
}

fn apply_overlay(base: &SnapshotBase, ctx: &EvalContext<'_>, overlay: &Overlay<'_>) -> Vec<ConfigDocumentView> {
    if base.documents.iter().any(|d| d.path.as_deref().is_some_and(|p| ctx.style.same(p, overlay.service_path))) {
        return base
            .documents
            .iter()
            .map(|doc| {
                if doc.path.as_deref().is_some_and(|p| ctx.style.same(p, overlay.service_path)) {
                    ConfigDocumentView {
                        path: doc.path.clone(),
                        scope: overlay.scope.into(),
                        plugins: overlay.plugins.to_vec(),
                        order: doc.order,
                    }
                } else {
                    doc.clone()
                }
            })
            .collect();
    }
    let overlay_dir = ctx.style.dirname(overlay.service_path);
    let mut target_dir_order: Option<f64> = None;
    let mut last_physical: f64 = -1.0;
    for (idx, entry) in ctx.entries.iter().enumerate() {
        if entry["type"] == "directory" && entry["path"].as_str().is_some_and(|p| ctx.style.same(p, &overlay_dir)) {
            target_dir_order = Some(idx as f64);
        }
        if entry["path"].is_string() {
            last_physical = idx as f64;
        }
    }
    let overlay_source_order = target_dir_order.map_or(last_physical + 0.5, |d| d - 0.5);
    let insert_at = base.source_orders.iter().filter(|&&o| o < overlay_source_order).count();
    let mut out = Vec::with_capacity(base.documents.len() + 1);
    out.extend(base.documents[..insert_at].iter().cloned());
    out.push(ConfigDocumentView {
        path: Some(overlay.service_path.to_owned()),
        scope: overlay.scope.into(),
        plugins: overlay.plugins.to_vec(),
        order: insert_at,
    });
    for doc in &base.documents[insert_at..] {
        let mut shifted = doc.clone();
        shifted.order += 1;
        out.push(shifted);
    }
    out
}

pub(super) fn snapshot_base(ctx: &EvalContext<'_>) -> Result<SnapshotBase, Fail> {
    let mut runtime = Vec::with_capacity(ctx.runtime.len());
    for (index, entry) in ctx.runtime.iter().enumerate() {
        let mut item = normalize_runtime_entry(entry, index, ctx.package_versions)?;
        if let RuntimeSource::Local { ref path } = item.source
            && managed_desktop_plugin_for_source(ctx.managed_plugins, path, ctx.style).is_some()
        {
            item.managed_by = Some("codenomad");
        }
        runtime.push(item);
    }
    let mut runtime_source_ids = HashMap::new();
    let mut runtime_by_id = HashMap::new();
    for entry in &runtime {
        let Some(ref id) = entry.id else { continue };
        runtime_by_id.entry(id.clone()).or_insert_with(|| entry.clone());
        if let RuntimeSource::Package { ref target, .. } = entry.source {
            runtime_source_ids.insert(target.clone(), id.clone());
        }
    }
    let (documents, source_orders) = config_documents(ctx);
    Ok(SnapshotBase { runtime, runtime_source_ids, runtime_by_id, documents, source_orders })
}

fn runtime_id_for_configured_target(
    ctx: &EvalContext<'_>,
    document: &ConfigDocumentView,
    target: &str,
    runtime: &[RuntimeEntry],
    runtime_by_id: &HashMap<String, RuntimeEntry>,
    direct: &HashMap<String, String>,
) -> Option<String> {
    let local_target = configured_local_target(ctx.style, &ctx.location.directory, document.path.as_deref(), target);
    let Some(local_target) = local_target else {
        return direct.get(target).cloned();
    };
    if let Some(installation) = managed_desktop_plugin_for_source(ctx.managed_plugins, &local_target, ctx.style) {
        // Walk the runtime inventory in native order, honoring only the first entry per plugin ID
        // (matching TS `runtimeById` insertion-ordered `Map`).
        let mut seen = HashSet::new();
        for entry in runtime {
            let Some(ref id) = entry.id else { continue };
            if !seen.insert(id.as_str()) {
                continue;
            }
            if entry.managed_by == Some("codenomad")
                && let RuntimeSource::Local { ref path } = entry.source
                && managed_desktop_plugin_for_source(ctx.managed_plugins, path, ctx.style)
                    .is_some_and(|m| m.entry == installation.entry)
            {
                return Some(id.clone());
            }
        }
        if installation.ids.len() == 1 && !runtime_by_id.contains_key(&installation.ids[0]) {
            return Some(installation.ids[0].clone());
        }
    }
    ctx.local_identities.get(&local_target).map(|ident| ident.id.clone())
}

pub(super) fn another_loader(
    ctx: &EvalContext<'_>,
    sources: &[ConfiguredSource],
    runtime: &[RuntimeEntry],
    id: &str,
    except_idx: Option<usize>,
) -> bool {
    let except = except_idx.and_then(|i| sources.get(i));
    let identities: HashSet<String> =
        except.map(|s| plugin_package_identities(&s.target).into_iter().collect()).unwrap_or_default();
    if sources.iter().enumerate().any(|(idx, other)| {
        if except_idx == Some(idx) {
            return false;
        }
        other.plugin_id.is_none()
            || other.plugin_id.as_deref() == Some(id)
            || except.is_some_and(|ex| {
                other.target == ex.target
                    || plugin_package_identities(&other.target).iter().any(|k| identities.contains(k))
            })
    }) {
        return true;
    }
    let local = except
        .and_then(|ex| configured_local_target(ctx.style, &ctx.location.directory, ex.path.as_deref(), &ex.target));
    let accounted = |entry: &RuntimeEntry| -> bool {
        let Some(ex) = except else { return false };
        match &entry.source {
            RuntimeSource::Package { target, .. } => *target == ex.target,
            RuntimeSource::Local { path } => local
                .as_ref()
                .and_then(|l| ctx.local_identities.get(l))
                .is_some_and(|ident| ident.paths.iter().any(|p| p == path)),
            _ => false,
        }
    };
    if runtime.iter().any(|entry| entry.id.as_deref() == Some(id) && !accounted(entry)) {
        return true;
    }
    match ctx.discovery_loaders {
        None => true,
        Some(loaders) => loaders.iter().any(|ids| ids.is_empty() || ids.iter().any(|candidate| candidate == id)),
    }
}

fn state_for_rule(rule: Option<&ConfiguredRule>) -> ScopeRuleState {
    match rule {
        None => ScopeRuleState::Default,
        Some(r) if r.enabled => ScopeRuleState::Enabled,
        Some(_) => ScopeRuleState::Disabled,
    }
}

pub(super) fn evaluate_documents(
    base: &SnapshotBase,
    ctx: &EvalContext<'_>,
    overlay: Option<&Overlay<'_>>,
) -> Evaluated {
    let documents = overlay.map_or_else(|| base.documents.clone(), |ov| apply_overlay(base, ctx, ov));
    let managed_ids: HashSet<String> = ctx
        .managed_plugins
        .iter()
        .flat_map(|m| m.ids.iter())
        .filter(|id| base.runtime_by_id.get(*id).is_none_or(|e| e.managed_by == Some("codenomad")))
        .cloned()
        .collect();
    let discovery = discovery_folders(ctx.entries, ctx.style);
    let mut start_ids: HashSet<String> = managed_ids.clone();
    for entry in &base.runtime {
        let Some(ref id) = entry.id else { continue };
        let defined_at_start = match &entry.source {
            RuntimeSource::Builtin | RuntimeSource::Sdk => true,
            RuntimeSource::Local { path } => {
                discovery_child(ctx.style, &discovery, path).is_some()
                    && ctx.existing_entrypoints.is_none_or(|existing| existing.contains(path))
            }
            RuntimeSource::Package { .. } => false,
        };
        if defined_at_start {
            start_ids.insert(id.clone());
        }
    }
    let mut known_definitions = start_ids.clone();
    let reported_targets: HashSet<&str> = base
        .runtime
        .iter()
        .filter_map(|e| match &e.source {
            RuntimeSource::Package { target, .. } => Some(target.as_str()),
            _ => None,
        })
        .collect();
    let mut declared_targets: HashSet<String> = HashSet::new();
    let mut rules: Vec<ConfiguredRule> = Vec::new();
    let mut sources: Vec<ConfiguredSource> = Vec::new();
    let mut applied: Vec<AppliedEntry> = Vec::new();

    for document in &documents {
        for (entry_index, entry) in document.plugins.iter().enumerate() {
            match entry {
                PluginConfigEntry::Obj { package, .. } => {
                    let runtime_id = runtime_id_for_configured_target(
                        ctx,
                        document,
                        package,
                        &base.runtime,
                        &base.runtime_by_id,
                        &base.runtime_source_ids,
                    );
                    applied.push(AppliedEntry {
                        document: document.order,
                        entry_index,
                        remove: false,
                        target: package.clone(),
                        plugin_id: runtime_id.clone(),
                    });
                    sources.push(ConfiguredSource {
                        target: package.clone(),
                        managed_by: None,
                        scope: document.scope,
                        path: document.path.clone(),
                        entry_index,
                        has_options: entry.has_options(),
                        plugin_id: runtime_id.clone(),
                    });
                    let is_first = (runtime_id.is_some() || reported_targets.contains(package.as_str()))
                        && !declared_targets.contains(package);
                    let selects =
                        package.starts_with("opencode.") || (!is_first && known_definitions.contains(package));
                    if selects {
                        rules.push(ConfiguredRule {
                            selector: package.clone(),
                            enabled: true,
                            scope: document.scope,
                            path: document.path.clone(),
                            order: document.order,
                            entry_index,
                        });
                    } else if let Some(ref rid) = runtime_id
                        && rules.iter().any(|r| !r.enabled && matches_selector(&r.selector, rid))
                    {
                        rules.push(ConfiguredRule {
                            selector: rid.clone(),
                            enabled: true,
                            scope: document.scope,
                            path: document.path.clone(),
                            order: document.order,
                            entry_index,
                        });
                    }
                    declared_targets.insert(package.clone());
                    if let Some(rid) = runtime_id {
                        known_definitions.insert(rid);
                    }
                }
                PluginConfigEntry::Str(s) => {
                    let (disabled, selector) = match s.strip_prefix('-') {
                        Some(rest) => (true, rest),
                        None => (false, s.as_str()),
                    };
                    if disabled {
                        applied.push(AppliedEntry {
                            document: document.order,
                            entry_index,
                            remove: true,
                            target: selector.to_owned(),
                            plugin_id: None,
                        });
                        rules.push(ConfiguredRule {
                            selector: selector.to_owned(),
                            enabled: false,
                            scope: document.scope,
                            path: document.path.clone(),
                            order: document.order,
                            entry_index,
                        });
                        continue;
                    }
                    let runtime_source_id = runtime_id_for_configured_target(
                        ctx,
                        document,
                        selector,
                        &base.runtime,
                        &base.runtime_by_id,
                        &base.runtime_source_ids,
                    );
                    let is_first = (runtime_source_id.is_some() || reported_targets.contains(selector))
                        && !declared_targets.contains(selector);
                    let selects = selector == "*"
                        || selector.ends_with(".*")
                        || selector.starts_with("opencode.")
                        || (!is_first && known_definitions.contains(selector));
                    if !selects {
                        applied.push(AppliedEntry {
                            document: document.order,
                            entry_index,
                            remove: false,
                            target: selector.to_owned(),
                            plugin_id: runtime_source_id.clone(),
                        });
                        sources.push(ConfiguredSource {
                            target: selector.to_owned(),
                            managed_by: None,
                            scope: document.scope,
                            path: document.path.clone(),
                            entry_index,
                            has_options: false,
                            plugin_id: runtime_source_id.clone(),
                        });
                        declared_targets.insert(selector.to_owned());
                        if let Some(rid) = runtime_source_id {
                            if rules.iter().any(|r| !r.enabled && matches_selector(&r.selector, &rid)) {
                                rules.push(ConfiguredRule {
                                    selector: rid.clone(),
                                    enabled: true,
                                    scope: document.scope,
                                    path: document.path.clone(),
                                    order: document.order,
                                    entry_index,
                                });
                            }
                            known_definitions.insert(rid);
                        }
                    } else {
                        applied.push(AppliedEntry {
                            document: document.order,
                            entry_index,
                            remove: false,
                            target: selector.to_owned(),
                            plugin_id: None,
                        });
                        rules.push(ConfiguredRule {
                            selector: selector.to_owned(),
                            enabled: true,
                            scope: document.scope,
                            path: document.path.clone(),
                            order: document.order,
                            entry_index,
                        });
                    }
                }
            }
        }
    }

    for source in &mut sources {
        let native_source = if source.target.starts_with("./") || source.target.starts_with("../") {
            let base_dir =
                source.path.as_deref().map(|p| ctx.style.dirname(p)).unwrap_or_else(|| ctx.location.directory.clone());
            ctx.style.join(&base_dir, &source.target)
        } else {
            source.target.clone()
        };
        if managed_desktop_plugin_for_source(ctx.managed_plugins, &native_source, ctx.style).is_some() {
            source.managed_by = Some("codenomad");
        }
    }

    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut sorted_ids: Vec<String> = Vec::new();
    let mut push_id = |id: &str| {
        if valid_plugin_id(id) && seen_ids.insert(id.to_owned()) {
            sorted_ids.push(id.to_owned());
        }
    };
    for entry in &base.runtime {
        if let Some(id) = entry.id.as_deref() {
            push_id(id);
        }
    }
    for m in ctx.managed_plugins {
        for id in &m.ids {
            push_id(id);
        }
    }
    for rule in &rules {
        if is_exact_selector(&rule.selector) {
            push_id(&rule.selector);
        }
    }
    sorted_ids.sort_by(|a, b| control_id_cmp(a, b));

    let controls: Vec<ActivationControl> = sorted_ids
        .into_iter()
        .map(|id| {
            let matching: Vec<&ConfiguredRule> = rules.iter().filter(|r| matches_selector(&r.selector, &id)).collect();
            let controlling_rule = matching.last().copied().cloned();
            let runtime_entry = base.runtime_by_id.get(&id).cloned().or_else(|| {
                base.runtime
                    .iter()
                    .find(|entry| {
                        entry.id.is_none()
                            && entry.managed_by == Some("codenomad")
                            && matches!(&entry.source, RuntimeSource::Local { path }
                                if managed_desktop_plugin_for_source(ctx.managed_plugins, path, ctx.style)
                                    .is_some_and(|m| m.ids.iter().any(|mid| mid == &id)))
                    })
                    .cloned()
            });
            let managed =
                runtime_entry.as_ref().is_some_and(|e| e.managed_by == Some("codenomad")) || managed_ids.contains(&id);
            let builtin = runtime_entry.as_ref().is_some_and(|e| matches!(e.source, RuntimeSource::Builtin))
                || id.starts_with("opencode.");
            let orphan = (runtime_entry.is_none()
                && !managed
                && !builtin
                && !another_loader(ctx, &sources, &base.runtime, &id, None))
            .then_some(true);
            let global = state_for_rule(matching.iter().rev().find(|r| r.scope == ConfigScope::Global).copied());
            let project = state_for_rule(matching.iter().rev().find(|r| r.scope == ConfigScope::Project).copied());
            ActivationControl {
                id,
                managed_by: managed.then_some("codenomad"),
                runtime: runtime_entry,
                builtin,
                effective: state_for_rule(controlling_rule.as_ref()),
                global,
                project,
                controlling_rule,
                orphan,
            }
        })
        .collect();

    Evaluated {
        snapshot: Snapshot {
            location: ctx.location.clone(),
            runtime: base.runtime.clone(),
            configured: ConfiguredSummary { rules, sources },
            controls,
            targets: ctx.targets.iter().map(ResolvedTarget::public).collect(),
        },
        sequence: AppliedSequence { entries: applied, start_ids },
        documents,
    }
}

/// `mutationTargetPlugins` (`plugin-controls.ts:860-897`).
pub(super) fn mutation_target_plugins(
    documents: &[ConfigDocumentView],
    style: Style,
    service_path: &str,
    raw_plugins: &[PluginConfigEntry],
    authorized_ids: &[String],
) -> (Vec<PluginConfigEntry>, bool) {
    let normalized: &[PluginConfigEntry] = documents
        .iter()
        .rev()
        .find(|d| d.path.as_deref().is_some_and(|p| style.same(p, service_path)))
        .map_or(&[], |d| d.plugins.as_slice());
    let mut no_op_safe = !raw_plugins.iter().any(contains_config_variable_entry);
    let mut normalized_index = 0usize;
    let mut pending_rules: Vec<PluginConfigEntry> = Vec::new();
    for entry in raw_plugins {
        if contains_config_variable_entry(entry) {
            if normalized_index < normalized.len() {
                normalized_index += 1;
            }
            continue;
        }
        if normalized_index < normalized.len() {
            if entry == &normalized[normalized_index] {
                normalized_index += 1;
            } else {
                no_op_safe = false;
            }
            continue;
        }
        let Some(s) = entry.as_str() else {
            no_op_safe = false;
            continue;
        };
        let selector = s.strip_prefix('-').unwrap_or(s);
        if selector.is_empty() || !authorized_ids.iter().any(|id| matches_selector(selector, id)) {
            no_op_safe = false;
            continue;
        }
        pending_rules.push(entry.clone());
    }
    let mut plugins = normalized.to_vec();
    plugins.extend(pending_rules);
    (plugins, no_op_safe && normalized_index == normalized.len())
}

/// `replaceableRuleIndexes` (`plugin-controls.ts:905-921`).
pub(super) fn replaceable_rule_indexes(
    raw_plugins: &[PluginConfigEntry],
    projected: &[PluginConfigEntry],
    snapshot: &Snapshot,
    service_path: &str,
    scope: Scope,
    plugin_id: &str,
    style: Style,
) -> Vec<usize> {
    if raw_plugins.len() != projected.len() || raw_plugins != projected {
        return Vec::new();
    }
    let scope_cfg: ConfigScope = scope.into();
    let sources: HashSet<usize> = snapshot
        .configured
        .sources
        .iter()
        .filter(|s| s.scope == scope_cfg && s.path.as_deref().is_some_and(|p| style.same(p, service_path)))
        .map(|s| s.entry_index)
        .collect();
    let disable_rule = format!("-{plugin_id}");
    raw_plugins
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let s = entry.as_str()?;
            ((s == plugin_id || s == disable_rule) && projected[index] == *entry && !sources.contains(&index))
                .then_some(index)
        })
        .collect()
}
