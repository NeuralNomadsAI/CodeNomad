//! OpenCode V2 MCP servers and plugin activation/source controls client.
use std::time::Duration;

mod http;
pub mod mcp;
mod parse;
#[cfg(test)]
mod tests;

pub use http::{
    ActivationResult, add_source, load, remove_source, run_package_action, set_activation,
};
#[cfg(test)]
pub(crate) use http::{add_source_with_timeout, is_route_not_found_body};
pub(crate) use http::{classify_action_error, route_unavailable};
#[cfg(test)]
pub(crate) use parse::parse_snapshot;

const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_ITEMS: usize = 512;
const MAX_SPEC_CHARS: usize = 512;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
// Exceeds server PLUGIN_SOURCE_ADD_TIMEOUT_MS (20s) + PLUGIN_SOURCE_ABORT_GRACE_MS (5s)
// with headroom for a request waiting behind one prior queued add turn.
pub(crate) const ADD_SOURCE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
    Global,
    Project,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }

    pub fn i18n_key(self) -> &'static str {
        match self {
            Self::Global => "instanceServiceStatus.plugins.scope.global",
            Self::Project => "instanceServiceStatus.plugins.scope.project",
        }
    }

    pub(crate) fn parse(raw: &str) -> Option<Self> {
        match raw {
            "global" => Some(Self::Global),
            "project" => Some(Self::Project),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigScope {
    Global,
    Project,
    Other,
    Virtual,
}

impl ConfigScope {
    pub(crate) fn parse(raw: &str) -> Option<Self> {
        match raw {
            "global" => Some(Self::Global),
            "project" => Some(Self::Project),
            "other" => Some(Self::Other),
            "virtual" => Some(Self::Virtual),
            _ => None,
        }
    }

    pub fn control_scope(self) -> Option<Scope> {
        match self {
            Self::Global => Some(Scope::Global),
            Self::Project => Some(Scope::Project),
            Self::Other | Self::Virtual => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeRuleState {
    Default,
    Enabled,
    Disabled,
}

impl ScopeRuleState {
    pub(crate) fn parse(raw: &str) -> Option<Self> {
        match raw {
            "default" => Some(Self::Default),
            "enabled" => Some(Self::Enabled),
            "disabled" => Some(Self::Disabled),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeSource {
    Builtin,
    Package {
        target: String,
        version: Option<String>,
        revision: Option<String>,
        outdated: bool,
        updating: bool,
    },
    Local {
        path: String,
    },
    Sdk,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeState {
    Active,
    Failed {
        error: Option<String>,
        error_ref: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeEntry {
    pub key: String,
    pub managed_by_codenomad: bool,
    pub id: Option<String>,
    pub source: RuntimeSource,
    pub gui_feature: bool,
    pub state: RuntimeState,
}

impl RuntimeEntry {
    pub fn display_version(&self) -> Option<String> {
        let RuntimeSource::Package {
            version, revision, ..
        } = &self.source
        else {
            return None;
        };
        if let Some(v) = version.as_deref().filter(|s| !s.is_empty()) {
            return Some(v.to_owned());
        }
        revision
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|rev| rev.chars().take(7).collect())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfiguredRule {
    pub selector: String,
    pub enabled: bool,
    pub scope: ConfigScope,
    pub path: Option<String>,
    pub entry_index: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfiguredSource {
    pub target: String,
    pub scope: ConfigScope,
    pub path: Option<String>,
    pub entry_index: u64,
    pub plugin_id: Option<String>,
    pub managed_by_codenomad: bool,
    pub expected_revision: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControllingRule {
    pub selector: String,
    pub enabled: bool,
    pub scope: ConfigScope,
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivationControl {
    pub id: String,
    pub managed_by_codenomad: bool,
    pub runtime: Option<RuntimeEntry>,
    pub builtin: bool,
    pub effective: ScopeRuleState,
    pub global: ScopeRuleState,
    pub project: ScopeRuleState,
    pub controlling_rule: Option<ControllingRule>,
    pub orphan: bool,
}

impl ActivationControl {
    /// Matches Solid `pluginScopeChecked`: Global defaults to enabled; Project inherits Global.
    pub fn checked(&self, scope: Scope) -> bool {
        let scoped = match scope {
            Scope::Global => self.global,
            Scope::Project => self.project,
        };
        match scoped {
            ScopeRuleState::Enabled => true,
            ScopeRuleState::Disabled => false,
            ScopeRuleState::Default => match scope {
                Scope::Global => true,
                Scope::Project => self.checked(Scope::Global),
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlTarget {
    pub scope: Scope,
    pub path: String,
    pub exists: bool,
    pub expected_revision: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemovalTarget {
    pub scope: Scope,
    pub target: String,
    pub entry_index: Option<u64>,
    pub path: Option<String>,
    pub expected_revision: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub directory: String,
    pub controls_available: bool,
    pub runtime: Vec<RuntimeEntry>,
    pub configured_rules: Vec<ConfiguredRule>,
    pub configured_sources: Vec<ConfiguredSource>,
    pub controls: Vec<ActivationControl>,
    pub targets: Vec<ControlTarget>,
}

const MISSIONS_PLUGIN_ID: &str = "codenomad.missions";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemAttentionKind {
    Disabled,
    Failed,
    Unconfirmed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SystemAttentionEntry {
    pub key: String,
    pub name: String,
    pub kind: SystemAttentionKind,
    pub controlling_scope: Option<ConfigScope>,
    pub reenable_scope: Option<Scope>,
    pub control_id: Option<String>,
    pub runtime: Option<RuntimeEntry>,
    pub scopes: Vec<(ConfigScope, Option<String>)>,
}

impl Snapshot {
    pub fn project_available(&self) -> bool {
        self.targets.iter().any(|t| t.scope == Scope::Project)
    }

    pub fn scope_available(&self, scope: Scope) -> bool {
        self.targets.iter().any(|t| t.scope == scope)
    }

    pub fn target_for(&self, scope: Scope) -> Option<&ControlTarget> {
        self.targets.iter().find(|t| t.scope == scope)
    }

    pub fn visible_controls(&self) -> impl Iterator<Item = &ActivationControl> {
        self.controls
            .iter()
            .filter(|c| !c.builtin && !c.managed_by_codenomad)
    }

    pub fn unmatched_runtime(&self) -> impl Iterator<Item = &RuntimeEntry> {
        self.runtime.iter().filter(|entry| {
            !entry.managed_by_codenomad
                && !matches!(entry.source, RuntimeSource::Builtin)
                && entry
                    .id
                    .as_deref()
                    .is_none_or(|id| !self.controls.iter().any(|c| c.id == id))
        })
    }

    pub fn unmatched_sources(&self) -> Vec<&ConfiguredSource> {
        let mut seen = Vec::new();
        for source in &self.configured_sources {
            if source.managed_by_codenomad {
                continue;
            }
            let claimed = source
                .plugin_id
                .as_deref()
                .is_some_and(|id| self.controls.iter().any(|c| c.id == id))
                || self.runtime.iter().any(|r| match &r.source {
                    RuntimeSource::Package { target, .. } => target == &source.target,
                    _ => false,
                });
            if !claimed
                && !seen
                    .iter()
                    .any(|s: &&ConfiguredSource| s.target == source.target)
            {
                seen.push(source);
            }
        }
        seen
    }

    pub fn system_attention_entries(
        &self,
        runtime_unconfirmed: &std::collections::HashSet<String>,
    ) -> Vec<SystemAttentionEntry> {
        use std::collections::{HashMap, HashSet};
        let mut order: Vec<String> = Vec::new();
        let mut by_key: HashMap<
            String,
            (String, Option<&ActivationControl>, Option<&RuntimeEntry>),
        > = HashMap::new();
        let mut represented_targets: HashSet<String> = HashSet::new();
        let mut represented_keys: HashSet<String> = HashSet::new();

        for control in &self.controls {
            if !control.managed_by_codenomad {
                continue;
            }
            if let Some(rt) = &control.runtime {
                match &rt.source {
                    RuntimeSource::Package { target, .. } => {
                        represented_targets.insert(target.clone());
                    }
                    RuntimeSource::Local { path } => {
                        represented_targets.insert(path.clone());
                    }
                    _ => {}
                }
                represented_keys.insert(rt.key.clone());
            }
            let key = format!("id:{}", control.id);
            if !by_key.contains_key(&key) {
                order.push(key.clone());
            }
            by_key.insert(
                key,
                (control.id.clone(), Some(control), control.runtime.as_ref()),
            );
        }

        for rt in &self.runtime {
            if !rt.managed_by_codenomad || represented_keys.contains(&rt.key) {
                continue;
            }
            let name = rt.id.clone().unwrap_or_else(|| match &rt.source {
                RuntimeSource::Package { target, .. } => target.clone(),
                RuntimeSource::Local { path } => path.clone(),
                _ => rt.key.clone(),
            });
            let key = match &rt.id {
                Some(id) => format!("id:{id}"),
                None => format!("target:{name}"),
            };
            match &rt.source {
                RuntimeSource::Package { target, .. } => {
                    represented_targets.insert(target.clone());
                }
                RuntimeSource::Local { path } => {
                    represented_targets.insert(path.clone());
                }
                _ => {}
            }
            by_key.entry(key).or_insert_with_key(|k| {
                order.push(k.clone());
                (name, None, Some(rt))
            });
        }

        for source in &self.configured_sources {
            if !source.managed_by_codenomad || represented_targets.contains(&source.target) {
                continue;
            }
            if let Some(pid) = &source.plugin_id
                && by_key.contains_key(&format!("id:{pid}"))
            {
                continue;
            }
            let key = format!("target:{}", source.target);
            by_key.entry(key).or_insert_with_key(|k| {
                let name = source
                    .plugin_id
                    .clone()
                    .unwrap_or_else(|| source.target.clone());
                order.push(k.clone());
                (name, None, None)
            });
        }

        let mut out = Vec::new();
        for key in order {
            let Some((name, control, runtime)) = by_key.remove(&key) else {
                continue;
            };
            if key == format!("id:{MISSIONS_PLUGIN_ID}")
                && let Some(ctrl) = control
                && ctrl.effective == ScopeRuleState::Disabled
                && ctrl.controlling_rule.as_ref().is_some_and(|rule| {
                    rule.scope == ConfigScope::Global
                        && rule.selector == MISSIONS_PLUGIN_ID
                        && !rule.enabled
                })
            {
                continue;
            }
            let disabled = control.is_some_and(|c| c.effective == ScopeRuleState::Disabled);
            let unconfirmed = runtime_unconfirmed.contains(&name);
            let active = runtime.is_some_and(|r| matches!(r.state, RuntimeState::Active));
            if !disabled && !unconfirmed && active {
                continue;
            }
            let kind = if disabled {
                SystemAttentionKind::Disabled
            } else if unconfirmed {
                SystemAttentionKind::Unconfirmed
            } else if runtime.is_some_and(|r| matches!(r.state, RuntimeState::Failed { .. })) {
                SystemAttentionKind::Failed
            } else {
                SystemAttentionKind::Unconfirmed
            };
            let controlling_scope = control
                .and_then(|c| c.controlling_rule.as_ref())
                .map(|r| r.scope);
            let reenable_scope = if disabled {
                match controlling_scope.and_then(ConfigScope::control_scope) {
                    Some(scope) if self.scope_available(scope) => Some(scope),
                    _ if self.project_available() => Some(Scope::Project),
                    _ => None,
                }
            } else {
                None
            };
            let rt_target = runtime.and_then(|r| match &r.source {
                RuntimeSource::Package { target, .. } => Some(target.as_str()),
                RuntimeSource::Local { path } => Some(path.as_str()),
                _ => None,
            });
            let mut scopes = Vec::new();
            for src in &self.configured_sources {
                if !src.managed_by_codenomad {
                    continue;
                }
                let matches_entry = src.plugin_id.as_deref() == Some(name.as_str())
                    || rt_target == Some(src.target.as_str())
                    || format!("target:{}", src.target) == key;
                if matches_entry {
                    let record = (
                        src.scope,
                        src.path.clone().or_else(|| Some(src.target.clone())),
                    );
                    if !scopes.contains(&record) {
                        scopes.push(record);
                    }
                }
            }
            if let Some(rule) = control.and_then(|c| c.controlling_rule.as_ref()) {
                let path = rule.path.clone().or_else(|| {
                    rule.scope
                        .control_scope()
                        .and_then(|s| self.target_for(s))
                        .map(|t| t.path.clone())
                });
                let record = (rule.scope, path);
                if !scopes.contains(&record) {
                    scopes.push(record);
                }
            }
            out.push(SystemAttentionEntry {
                key,
                name,
                kind,
                controlling_scope,
                reenable_scope,
                control_id: control.map(|c| c.id.clone()),
                runtime: runtime.cloned(),
                scopes,
            });
        }
        out
    }

    pub fn removable_for_control(&self, control: &ActivationControl) -> Vec<RemovalTarget> {
        if control.managed_by_codenomad {
            return Vec::new();
        }
        let pkg_target = control.runtime.as_ref().and_then(|r| match &r.source {
            RuntimeSource::Package { target, .. } => Some(target.as_str()),
            _ => None,
        });
        let mut out = self.removable_sources(|source| {
            source.plugin_id.as_deref() == Some(control.id.as_str())
                || pkg_target.is_some_and(|t| t == source.target)
        });
        if control.orphan {
            for target in &self.targets {
                let Some(rev) = target
                    .expected_revision
                    .as_deref()
                    .filter(|r| valid_revision(r))
                else {
                    continue;
                };
                let has_rule = self.configured_rules.iter().any(|rule| {
                    rule.selector == control.id
                        && rule.scope.control_scope() == Some(target.scope)
                        && rule
                            .path
                            .as_deref()
                            .is_some_and(|p| crate::same_server_path(&target.path, p))
                });
                if has_rule {
                    out.push(RemovalTarget {
                        scope: target.scope,
                        target: control.id.clone(),
                        entry_index: None,
                        path: Some(target.path.clone()),
                        expected_revision: rev.to_owned(),
                    });
                }
            }
        }
        out
    }

    pub fn removable_for_target(&self, target_name: &str) -> Vec<RemovalTarget> {
        self.removable_sources(|source| source.target == target_name)
    }

    fn removable_sources(&self, matches: impl Fn(&ConfiguredSource) -> bool) -> Vec<RemovalTarget> {
        let mut out = Vec::new();
        for source in &self.configured_sources {
            if source.managed_by_codenomad {
                continue;
            }
            let Some(scope) = source.scope.control_scope() else {
                continue;
            };
            if !matches(source) {
                continue;
            }
            let Some(target) = self.target_for(scope) else {
                continue;
            };
            if !source
                .path
                .as_deref()
                .is_some_and(|p| crate::same_server_path(&target.path, p))
            {
                continue;
            }
            let Some(rev) = source
                .expected_revision
                .as_deref()
                .or(target.expected_revision.as_deref())
                .filter(|r| valid_revision(r))
            else {
                continue;
            };
            out.push(RemovalTarget {
                scope,
                target: source.target.clone(),
                entry_index: Some(source.entry_index),
                path: source.path.clone(),
                expected_revision: rev.to_owned(),
            });
        }
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActionError {
    Unsupported,
    Forbidden,
    Conflict,
    InvalidConfig,
    Unavailable,
    Code(String),
    Failed,
}

impl ActionError {
    pub fn activation_i18n_key(&self) -> &'static str {
        match self {
            Self::Forbidden => "instanceServiceStatus.plugins.errors.forbidden",
            Self::Conflict => "instanceServiceStatus.plugins.errors.conflict",
            Self::InvalidConfig => "instanceServiceStatus.plugins.errors.invalidConfig",
            _ => "instanceServiceStatus.plugins.errors.save",
        }
    }

    pub fn add_source_i18n_key(&self) -> &'static str {
        match self {
            Self::Code(code) => match code.as_str() {
                "invalid-spec" => "instanceServiceStatus.plugins.sources.errors.invalidSpec",
                "local-path" => "instanceServiceStatus.plugins.sources.errors.localPath",
                "plugin-id" => "instanceServiceStatus.plugins.sources.errors.pluginId",
                "duplicate" => "instanceServiceStatus.plugins.sources.errors.duplicate",
                "global-only" => "instanceServiceStatus.plugins.sources.errors.globalOnly",
                "timeout" => "instanceServiceStatus.plugins.sources.errors.timeout",
                _ => "instanceServiceStatus.plugins.sources.errors.add",
            },
            Self::Forbidden => "instanceServiceStatus.plugins.sources.errors.forbidden",
            Self::Conflict => "instanceServiceStatus.plugins.sources.errors.conflict",
            Self::InvalidConfig => "instanceServiceStatus.plugins.sources.errors.invalidConfig",
            Self::Unavailable => "instanceServiceStatus.plugins.sources.errors.unavailable",
            _ => "instanceServiceStatus.plugins.sources.errors.add",
        }
    }

    pub fn remove_source_i18n_key(&self) -> &'static str {
        match self {
            Self::Conflict => "instanceServiceStatus.plugins.sources.errors.removeStale",
            Self::Code(code) if code == "stale" => {
                "instanceServiceStatus.plugins.sources.errors.removeStale"
            }
            _ => "instanceServiceStatus.plugins.sources.errors.remove",
        }
    }
}

pub(crate) fn valid_revision(rev: &str) -> bool {
    rev.len() == 64 && rev.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn location_matches(requested: &str, returned: &str) -> bool {
    crate::same_server_path(requested, returned)
        || wsl_posix_alias(requested).is_some_and(|posix| crate::same_server_path(&posix, returned))
        || wsl_posix_alias(returned).is_some_and(|posix| crate::same_server_path(requested, &posix))
}

fn wsl_posix_alias(path: &str) -> Option<String> {
    let rest = path.strip_prefix("\\\\")?;
    let mut parts = rest.split(['\\', '/']);
    let host = parts.next()?;
    if !host.eq_ignore_ascii_case("wsl$") && !host.eq_ignore_ascii_case("wsl.localhost") {
        return None;
    }
    let distro = parts.next()?;
    if distro.is_empty() {
        return None;
    }
    let tail: Vec<&str> = parts.filter(|seg| !seg.is_empty()).collect();
    if tail.is_empty() {
        Some("/".to_owned())
    } else {
        Some(format!("/{}", tail.join("/")))
    }
}
