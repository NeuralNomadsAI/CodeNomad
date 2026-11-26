//! OpenCode V2 MCP servers and plugin activation/source controls client.
use std::time::Duration;

mod http;
pub mod mcp;
mod parse;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) use http::is_route_not_found_body;
pub use http::{add_source, load, remove_source, run_package_action, set_activation};
pub(crate) use http::{classify_action_error, route_unavailable};
#[cfg(test)]
pub(crate) use parse::parse_snapshot;

const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_ITEMS: usize = 512;
const MAX_SPEC_CHARS: usize = 512;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

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
        error: String,
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
    pub expected_revision: Option<String>,
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
        self.controls.iter().filter(|c| !c.builtin)
    }

    pub fn unmatched_runtime(&self) -> impl Iterator<Item = &RuntimeEntry> {
        self.runtime.iter().filter(|entry| {
            !matches!(entry.source, RuntimeSource::Builtin)
                && entry
                    .id
                    .as_deref()
                    .is_none_or(|id| !self.controls.iter().any(|c| c.id == id))
        })
    }

    pub fn unmatched_sources(&self) -> Vec<&ConfiguredSource> {
        let mut seen = Vec::new();
        for source in &self.configured_sources {
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

    pub fn removable_for_control(&self, control: &ActivationControl) -> Vec<RemovalTarget> {
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
