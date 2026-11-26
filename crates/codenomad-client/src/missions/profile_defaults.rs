//! Mission creation preference defaults and Compare profile freezing,
//! matching `packages/server/src/missions/profile-defaults.ts` and `playbook-profiles.ts`.
use super::{TaskMode, Template, utf16_len};
use crate::backend::{Backend, read_json_limited};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, time::Duration};

const DEFAULTS_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_DEFAULTS_BYTES: usize = 2 * 1024 * 1024;
const MAX_EXEC_TEXT: usize = 240;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MissionModelRef {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct MissionExecution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<MissionModelRef>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct MissionProfiles {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator: Option<MissionExecution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<BTreeMap<String, MissionExecution>>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum MissionDefaultScope {
    All,
    Template(Template),
}

impl MissionDefaultScope {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "all" => Some(Self::All),
            "custom" => Some(Self::Template(Template::Custom)),
            "debug" => Some(Self::Template(Template::Debug)),
            "wayfinder" => Some(Self::Template(Template::Wayfinder)),
            "delivery" => Some(Self::Template(Template::Delivery)),
            "compare" => Some(Self::Template(Template::Compare)),
            _ => None,
        }
    }

    fn roles(self) -> &'static [&'static str] {
        match self {
            Self::All => template_roles(Template::Custom),
            Self::Template(template) => template_roles(template),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MissionProfileDefault {
    pub template: MissionDefaultScope,
    pub profiles: MissionProfiles,
    pub task_mode: Option<TaskMode>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MissionDefaultsOutcome {
    Ready(Vec<MissionProfileDefault>),
    Unavailable,
    AuthExpired,
}

pub const fn template_roles(template: Template) -> &'static [&'static str] {
    match template {
        Template::Custom => &["specialist"],
        Template::Debug => &[
            "review-standards",
            "review-spec",
            "validator",
            "diagnostician",
            "implementer",
            "resolver",
        ],
        Template::Wayfinder => &[
            "cartographer",
            "research",
            "prototype",
            "grilling",
            "decision",
        ],
        Template::Delivery => &[
            "business-analyst",
            "technical-architect",
            "tech-lead",
            "developer",
            "qa-engineer",
            "ui-ux-designer",
        ],
        Template::Compare => &["model-a", "model-b", "comparator"],
    }
}

fn valid_exec_text(value: &str) -> bool {
    !super::js_trim(value).is_empty() && utf16_len(value) <= MAX_EXEC_TEXT
}

fn parse_execution(value: &Value) -> std::result::Result<MissionExecution, ()> {
    let map = value.as_object().ok_or(())?;
    if map.keys().any(|key| key != "agent" && key != "model") {
        return Err(());
    }
    let agent = match map.get("agent") {
        None => None,
        Some(raw) => {
            let text = raw.as_str().ok_or(())?;
            if !valid_exec_text(text) {
                return Err(());
            }
            Some(text.to_owned())
        }
    };
    let model = match map.get("model") {
        None => None,
        Some(raw) => {
            let m = raw.as_object().ok_or(())?;
            if m.keys()
                .any(|key| !matches!(key.as_str(), "providerID" | "id" | "variant"))
            {
                return Err(());
            }
            let provider_id = m.get("providerID").and_then(Value::as_str).ok_or(())?;
            let id = m.get("id").and_then(Value::as_str).ok_or(())?;
            if !valid_exec_text(provider_id) || !valid_exec_text(id) {
                return Err(());
            }
            let variant = match m.get("variant") {
                None => None,
                Some(raw_v) => {
                    let v = raw_v.as_str().ok_or(())?;
                    if !valid_exec_text(v) {
                        return Err(());
                    }
                    Some(v.to_owned())
                }
            };
            Some(MissionModelRef {
                provider_id: provider_id.to_owned(),
                id: id.to_owned(),
                variant,
            })
        }
    };
    Ok(MissionExecution { agent, model })
}

fn parse_profiles(value: &Value, allowed: &[&str]) -> std::result::Result<MissionProfiles, ()> {
    let map = value.as_object().ok_or(())?;
    if map.keys().any(|key| key != "coordinator" && key != "roles") {
        return Err(());
    }
    let coordinator = match map.get("coordinator") {
        None => None,
        Some(raw) => Some(parse_execution(raw)?),
    };
    let roles = match map.get("roles") {
        None => None,
        Some(raw) => {
            let role_map = raw.as_object().ok_or(())?;
            if role_map.len() > allowed.len() {
                return Err(());
            }
            let mut parsed = BTreeMap::new();
            for (role, exec) in role_map {
                if !allowed.contains(&role.as_str()) {
                    return Err(());
                }
                parsed.insert(role.clone(), parse_execution(exec)?);
            }
            Some(parsed)
        }
    };
    Ok(MissionProfiles { coordinator, roles })
}

/// Validates and normalizes `settings.missionProfileDefaults`, failing closed on malformed entries.
pub fn normalize_mission_defaults(value: &Value) -> Option<Vec<MissionProfileDefault>> {
    let entries = value.as_array()?;
    if entries.len() > 6 {
        return None;
    }
    let mut result: Vec<MissionProfileDefault> = Vec::with_capacity(entries.len());
    for entry in entries {
        let map = entry.as_object()?;
        if map
            .keys()
            .any(|key| !matches!(key.as_str(), "template" | "profiles" | "taskMode"))
        {
            return None;
        }
        let template = map
            .get("template")
            .and_then(Value::as_str)
            .and_then(MissionDefaultScope::parse)?;
        if result.iter().any(|item| item.template == template) {
            return None;
        }
        let task_mode = match map.get("taskMode") {
            None => None,
            Some(Value::String(raw)) => match raw.as_str() {
                "native" => Some(TaskMode::Native),
                "independent" => Some(TaskMode::Independent),
                _ => return None,
            },
            Some(_) => return None,
        };
        let profiles_raw = map.get("profiles")?;
        let profiles = parse_profiles(profiles_raw, template.roles()).ok()?;
        result.push(MissionProfileDefault {
            template,
            profiles,
            task_mode,
        });
    }
    // Legacy Flexible entry promotes to global `all` when no explicit `all` entry exists.
    if !result
        .iter()
        .any(|item| item.template == MissionDefaultScope::All)
        && let Some(legacy) = result
            .iter_mut()
            .find(|item| item.template == MissionDefaultScope::Template(Template::Custom))
    {
        legacy.template = MissionDefaultScope::All;
    }
    Some(result)
}

/// Template exception ?? global `all` default ?? `TaskMode::Native`.
pub fn mission_task_mode_for(defaults: &[MissionProfileDefault], template: Template) -> TaskMode {
    defaults
        .iter()
        .find(|item| item.template == MissionDefaultScope::Template(template))
        .and_then(|item| item.task_mode)
        .or_else(|| {
            defaults
                .iter()
                .find(|item| item.template == MissionDefaultScope::All)
                .and_then(|item| item.task_mode)
        })
        .unwrap_or(TaskMode::Native)
}

/// Resolves creation-time profile defaults for a template.
pub fn mission_defaults_for(
    defaults: &[MissionProfileDefault],
    template: Template,
) -> Option<MissionProfiles> {
    let base = defaults
        .iter()
        .find(|item| item.template == MissionDefaultScope::All)
        .map(|item| &item.profiles);
    let specific = defaults
        .iter()
        .find(|item| item.template == MissionDefaultScope::Template(template))
        .map(|item| &item.profiles);
    let coordinator = specific
        .and_then(|p| p.coordinator.clone())
        .or_else(|| base.and_then(|p| p.coordinator.clone()));
    let mut roles = BTreeMap::new();
    for &role in template_roles(template) {
        let execution = specific
            .and_then(|p| p.roles.as_ref()?.get(role).cloned())
            .or_else(|| {
                if template == Template::Compare && role == "comparator" {
                    None
                } else {
                    base.and_then(|p| p.roles.as_ref()?.get("specialist").cloned())
                }
            });
        if let Some(exec) = execution {
            roles.insert(role.to_owned(), exec);
        }
    }
    if coordinator.is_none() && roles.is_empty() {
        return None;
    }
    Some(MissionProfiles {
        coordinator,
        roles: (!roles.is_empty()).then_some(roles),
    })
}

/// Validates Compare model A/B presence and distinctness (variant alone is not a distinct model).
pub fn compare_model_error(profiles: Option<&MissionProfiles>) -> Option<&'static str> {
    let Some(roles) = profiles.and_then(|profiles| profiles.roles.as_ref()) else {
        return Some("missions.compare.compare-models-required");
    };
    let a = roles.get("model-a").and_then(|exec| exec.model.as_ref());
    let b = roles.get("model-b").and_then(|exec| exec.model.as_ref());
    let (Some(a), Some(b)) = (a, b) else {
        return Some("missions.compare.compare-models-required");
    };
    if a.provider_id == b.provider_id && a.id == b.id {
        return Some("missions.compare.compare-models-identical");
    }
    None
}

/// Freezes Compare's comparator judge model against the coordinator model at creation time,
/// matching `freezeCompareProfiles` in `packages/server/src/missions/playbook-profiles.ts`.
pub fn freeze_compare_profiles(
    template: Template,
    profiles: Option<&MissionProfiles>,
) -> Option<MissionProfiles> {
    let base = profiles?;
    if template != Template::Compare {
        return Some(base.clone());
    }
    let own_judge = base
        .roles
        .as_ref()
        .and_then(|roles| roles.get("comparator"))
        .cloned();
    let coord_model = base
        .coordinator
        .as_ref()
        .and_then(|exec| exec.model.as_ref())
        .map(|model| MissionModelRef {
            provider_id: model.provider_id.clone(),
            id: model.id.clone(),
            variant: model.variant.clone().filter(|variant| variant != "default"),
        });
    let judge_model = own_judge
        .as_ref()
        .and_then(|exec| exec.model.clone())
        .or(coord_model);
    let Some(model) = judge_model else {
        return Some(base.clone());
    };
    let mut frozen = base.clone();
    let mut judge = own_judge.unwrap_or_default();
    judge.model = Some(model);
    frozen
        .roles
        .get_or_insert_with(BTreeMap::new)
        .insert("comparator".to_owned(), judge);
    Some(frozen)
}

pub fn valid_mission_profiles(template: Template, profiles: &MissionProfiles) -> bool {
    let check_exec = |exec: &MissionExecution| {
        exec.agent.as_deref().is_none_or(valid_exec_text)
            && exec.model.as_ref().is_none_or(|model| {
                valid_exec_text(&model.provider_id)
                    && valid_exec_text(&model.id)
                    && model.variant.as_deref().is_none_or(valid_exec_text)
            })
    };
    if profiles
        .coordinator
        .as_ref()
        .is_some_and(|c| !check_exec(c))
    {
        return false;
    }
    let allowed = template_roles(template);
    if let Some(roles) = &profiles.roles
        && (roles.len() > allowed.len()
            || roles
                .iter()
                .any(|(role, exec)| !allowed.contains(&role.as_str()) || !check_exec(exec)))
    {
        return false;
    }
    true
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MissionCatalogAgent {
    pub id: String,
    pub mode: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MissionCatalogModel {
    pub provider_id: String,
    pub id: String,
    pub variants: Vec<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MissionCatalog {
    pub agents: Vec<MissionCatalogAgent>,
    pub models: Vec<MissionCatalogModel>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MissionCatalogOutcome {
    Ready(MissionCatalog),
    Unavailable,
    AuthExpired,
}

pub fn defaults_have_profiles(defaults: &[MissionProfileDefault]) -> bool {
    defaults.iter().any(|entry| {
        entry.profiles.coordinator.is_some()
            || entry
                .profiles
                .roles
                .as_ref()
                .is_some_and(|roles| !roles.is_empty())
    })
}

/// Validates resolved Mission profiles against the active workspace's native catalog,
/// matching `validateMissionProfileCatalog` in `packages/server/src/missions/playbook-profiles.ts`.
pub fn catalog_profiles_valid(
    profiles: Option<&MissionProfiles>,
    catalog: &MissionCatalog,
    task_mode: TaskMode,
) -> bool {
    let Some(profiles) = profiles else {
        return true;
    };
    let has_roles = profiles.roles.as_ref().is_some_and(|r| !r.is_empty());
    if profiles.coordinator.is_none() && !has_roles {
        return true;
    }
    let valid_exec = |exec: &MissionExecution, child: bool| -> bool {
        if let Some(agent_id) = exec.agent.as_deref() {
            let Some(agent) = catalog.agents.iter().find(|a| a.id == agent_id) else {
                return false;
            };
            let allowed = if child {
                matches!(agent.mode.as_str(), "subagent" | "all")
            } else {
                matches!(agent.mode.as_str(), "primary" | "all")
            };
            if !allowed {
                return false;
            }
        }
        if let Some(model) = &exec.model {
            let Some(found) = catalog
                .models
                .iter()
                .find(|m| m.provider_id == model.provider_id && m.id == model.id)
            else {
                return false;
            };
            if let Some(variant) = model.variant.as_deref()
                && !found.variants.iter().any(|v| v == variant)
            {
                return false;
            }
        }
        true
    };
    if let Some(coord) = &profiles.coordinator
        && !valid_exec(coord, false)
    {
        return false;
    }
    let child_role = task_mode == TaskMode::Native;
    if let Some(roles) = &profiles.roles
        && roles.values().any(|exec| !valid_exec(exec, child_role))
    {
        return false;
    }
    true
}

impl Backend {
    /// Reads the owning backend's `missionProfileDefaults` from `/api/storage/config/ui`.
    pub async fn read_mission_defaults(&self) -> MissionDefaultsOutcome {
        let url = format!("{}api/storage/config/ui", self.base);
        let request = self
            .client
            .get(url)
            .query(&[("authoritative", "1")])
            .header(reqwest::header::CACHE_CONTROL, "no-store")
            .timeout(DEFAULTS_TIMEOUT);
        #[cfg(target_arch = "wasm32")]
        let request = request.fetch_cache_no_store();
        let Ok(response) = request.send().await else {
            return MissionDefaultsOutcome::Unavailable;
        };
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            return MissionDefaultsOutcome::AuthExpired;
        }
        if !status.is_success() {
            return MissionDefaultsOutcome::Unavailable;
        }
        let Ok(body) = read_json_limited(response, MAX_DEFAULTS_BYTES).await else {
            return MissionDefaultsOutcome::Unavailable;
        };
        let Some(root) = body.as_object() else {
            return MissionDefaultsOutcome::Unavailable;
        };
        let settings = match root.get("settings") {
            None => return MissionDefaultsOutcome::Ready(Vec::new()),
            Some(Value::Object(map)) => map,
            Some(_) => return MissionDefaultsOutcome::Unavailable,
        };
        let Some(raw_defaults) = settings.get("missionProfileDefaults") else {
            return MissionDefaultsOutcome::Ready(Vec::new());
        };
        match normalize_mission_defaults(raw_defaults) {
            Some(list) => MissionDefaultsOutcome::Ready(list),
            None => MissionDefaultsOutcome::Unavailable,
        }
    }

    /// Reads the active workspace's visible agents and enabled tool-capable models,
    /// matching `readMissionCatalog` in `packages/server/src/missions/native-catalog.ts`.
    pub async fn read_mission_catalog(&self) -> MissionCatalogOutcome {
        if !crate::history::valid_id(&self.workspace) {
            return MissionCatalogOutcome::Unavailable;
        }
        let base = format!("{}workspaces/{}/instance/api", self.base, self.workspace);
        let fetch = |route: &str| {
            let url = format!("{base}/{route}");
            async move {
                let request = self
                    .client
                    .get(url)
                    .header(reqwest::header::CACHE_CONTROL, "no-store")
                    .timeout(DEFAULTS_TIMEOUT);
                #[cfg(target_arch = "wasm32")]
                let request = request.fetch_cache_no_store();
                let Ok(response) = request.send().await else {
                    return Err(false);
                };
                let status = response.status();
                if status == StatusCode::UNAUTHORIZED {
                    return Err(true);
                }
                if !status.is_success() {
                    return Err(false);
                }
                read_json_limited(response, MAX_DEFAULTS_BYTES)
                    .await
                    .map_err(|_| false)
            }
        };
        let (agents_res, models_res) =
            futures_lite::future::zip(fetch("agent"), fetch("model")).await;
        let (agents_body, models_body) = match (agents_res, models_res) {
            (Ok(a), Ok(m)) => (a, m),
            (Err(true), _) | (_, Err(true)) => return MissionCatalogOutcome::AuthExpired,
            _ => return MissionCatalogOutcome::Unavailable,
        };
        let a_dir = agents_body["location"]["directory"].as_str();
        let m_dir = models_body["location"]["directory"].as_str();
        if let (Some(a), Some(m)) = (a_dir, m_dir)
            && !crate::same_server_path(a, m)
        {
            return MissionCatalogOutcome::Unavailable;
        }
        let Some(agent_rows) = agents_body["data"].as_array() else {
            return MissionCatalogOutcome::Unavailable;
        };
        let Some(model_rows) = models_body["data"].as_array() else {
            return MissionCatalogOutcome::Unavailable;
        };
        let mut agents = Vec::new();
        for row in agent_rows {
            if row.get("hidden").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(id) = row.get("id").and_then(Value::as_str) else {
                return MissionCatalogOutcome::Unavailable;
            };
            let Some(mode) = row.get("mode").and_then(Value::as_str) else {
                return MissionCatalogOutcome::Unavailable;
            };
            agents.push(MissionCatalogAgent {
                id: id.to_owned(),
                mode: mode.to_owned(),
            });
        }
        let mut models = Vec::new();
        for row in model_rows {
            let enabled = row.get("enabled").and_then(Value::as_bool) == Some(true);
            let tools = row
                .get("capabilities")
                .and_then(|c| c.get("tools"))
                .and_then(Value::as_bool)
                == Some(true);
            if !enabled || !tools {
                continue;
            }
            let Some(provider_id) = row.get("providerID").and_then(Value::as_str) else {
                return MissionCatalogOutcome::Unavailable;
            };
            let Some(id) = row.get("id").and_then(Value::as_str) else {
                return MissionCatalogOutcome::Unavailable;
            };
            let mut variants = Vec::new();
            if let Some(raw_variants) = row.get("variants") {
                let Some(arr) = raw_variants.as_array() else {
                    return MissionCatalogOutcome::Unavailable;
                };
                for v in arr {
                    if let Some(vid) = v.get("id").and_then(Value::as_str) {
                        variants.push(vid.to_owned());
                    }
                }
            }
            models.push(MissionCatalogModel {
                provider_id: provider_id.to_owned(),
                id: id.to_owned(),
                variants,
            });
        }
        MissionCatalogOutcome::Ready(MissionCatalog { agents, models })
    }
}
