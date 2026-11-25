//! Mission Preferences HTTP contracts: conditional UI preferences, native profile catalog,
//! and Location-scoped subagent depth.
mod model;
pub use model::*;

use crate::{
    backend::{Backend, read_json},
    history::{Result, valid_id},
};
use reqwest::StatusCode;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub struct MissionPreferenceExpectation {
    pub key: &'static str,
    pub present: bool,
    pub value: Option<Value>,
}

impl MissionPreferenceExpectation {
    pub fn from_ui_config(snapshot: Option<&Value>, key: &'static str) -> Self {
        let existing = snapshot
            .and_then(|doc| doc.get("settings"))
            .and_then(Value::as_object)
            .and_then(|settings| settings.get(key))
            .cloned();
        match existing {
            Some(value) => Self {
                key,
                present: true,
                value: Some(value),
            },
            None => Self {
                key,
                present: false,
                value: None,
            },
        }
    }

    fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("key".into(), json!(self.key));
        map.insert("present".into(), json!(self.present));
        if self.present
            && let Some(value) = &self.value
        {
            map.insert("value".into(), value.clone());
        }
        Value::Object(map)
    }
}

#[derive(Debug)]
pub enum MissionPatchOutcome {
    Applied(Value),
    Conflict,
    Unsupported,
    Failed,
}

pub async fn patch_mission_preferences(
    backend: &Backend,
    patch_settings: Value,
    expected: &[MissionPreferenceExpectation],
) -> MissionPatchOutcome {
    let body = json!({
        "patch": { "settings": patch_settings },
        "expected": expected.iter().map(MissionPreferenceExpectation::to_json).collect::<Vec<_>>(),
    });
    let Ok(response) = backend
        .client
        .patch(format!("{}api/storage/config/ui", backend.base))
        .query(&[("conditional", "missions-v1")])
        .json(&body)
        .send()
        .await
    else {
        return MissionPatchOutcome::Failed;
    };
    match response.status() {
        StatusCode::CONFLICT => return MissionPatchOutcome::Conflict,
        StatusCode::NOT_FOUND | StatusCode::NOT_IMPLEMENTED => {
            return MissionPatchOutcome::Unsupported;
        }
        status if !status.is_success() => return MissionPatchOutcome::Failed,
        _ => {}
    }
    match read_json(response).await {
        Ok(value)
            if value
                .as_object()
                .is_some_and(|map| map.get("settings").is_none_or(Value::is_object)) =>
        {
            MissionPatchOutcome::Applied(value)
        }
        _ => MissionPatchOutcome::Failed,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileAgent {
    pub id: String,
    pub mode: String,
    pub hidden: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileModel {
    pub provider_id: String,
    pub provider_name: String,
    pub id: String,
    pub name: String,
    pub variants: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MissionCatalog {
    pub directory: String,
    pub agents: Vec<ProfileAgent>,
    pub models: Vec<ProfileModel>,
}

pub fn legal_profile_agents<'a>(
    agents: &'a [ProfileAgent],
    coordinator: bool,
    task_mode: MissionTaskMode,
) -> Vec<&'a ProfileAgent> {
    let native_child = !coordinator && task_mode == MissionTaskMode::Native;
    agents
        .iter()
        .filter(|agent| {
            !agent.hidden
                && if native_child {
                    matches!(agent.mode.as_str(), "subagent" | "all")
                } else {
                    matches!(agent.mode.as_str(), "primary" | "all")
                }
        })
        .collect()
}

pub async fn read_mission_catalog(
    backend: &Backend,
    workspace: &str,
    session: Option<&str>,
) -> Result<MissionCatalog> {
    if !valid_id(workspace) || session.is_some_and(|id| !valid_id(id)) {
        return Err("Invalid mission catalog Location".into());
    }
    let location = if let Some(session) = session {
        Some(super::session_directory(backend, workspace, session).await?)
    } else {
        None
    };
    let directory = location.as_deref();
    let base = format!("{}workspaces/{workspace}/instance/api", backend.base);
    let base = base.as_str();
    let load = |kind| async move {
        let mut request = backend.client.get(format!("{base}/{kind}"));
        if let Some(directory) = directory {
            request = request.query(&[("location[directory]", directory)]);
        }
        read_json(request.send().await?.error_for_status()?).await
    };
    use futures_lite::future::zip;
    let ((agents, models), providers) =
        zip(zip(load("agent"), load("model")), load("provider")).await;
    let (agents, models, providers) = (agents?, models?, providers?);
    let received = agents["location"]["directory"]
        .as_str()
        .filter(|path| crate::absolute_server_path(path))
        .ok_or("Invalid mission catalog Location")?;
    if [&models, &providers]
        .iter()
        .any(|response| response["location"]["directory"] != received)
        || directory.is_some_and(|requested| !crate::same_server_path(requested, received))
    {
        return Err("Mission catalog Location changed".into());
    }
    parse_mission_catalog(
        received,
        &agents["data"],
        &models["data"],
        &providers["data"],
    )
}

fn parse_mission_catalog(
    directory: &str,
    raw_agents: &Value,
    raw_models: &Value,
    raw_providers: &Value,
) -> Result<MissionCatalog> {
    let raw_agents = raw_agents
        .as_array()
        .filter(|items| items.len() <= 512)
        .ok_or("Invalid mission agent catalog")?;
    let raw_models = raw_models
        .as_array()
        .ok_or("Invalid mission model catalog")?;
    let raw_providers = raw_providers
        .as_array()
        .filter(|items| items.len() <= 2048)
        .ok_or("Invalid mission provider catalog")?;
    let mut provider_names = BTreeMap::new();
    for provider in raw_providers {
        if let Some(id) = provider["id"].as_str().filter(|s| !s.is_empty()) {
            let name = provider["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(id);
            provider_names.insert(id.to_owned(), name.to_owned());
        }
    }
    let mut agents = Vec::with_capacity(raw_agents.len());
    for agent in raw_agents {
        let Some(id) = agent["id"].as_str().filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        let Some(mode) = agent["mode"].as_str() else {
            continue;
        };
        agents.push(ProfileAgent {
            id: id.to_owned(),
            mode: mode.to_owned(),
            hidden: agent["hidden"] == true,
        });
    }
    let mut models = Vec::new();
    for model in raw_models {
        if model["enabled"] != true
            || model["status"] == "deprecated"
            || model["capabilities"]["tools"] != true
        {
            continue;
        }
        let Some(provider_id) = model["providerID"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(id) = model["id"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let name = model["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(id);
        let variants = model["variants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| {
                v["id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .collect();
        let provider_name = provider_names
            .get(provider_id)
            .cloned()
            .unwrap_or_else(|| provider_id.to_owned());
        models.push(ProfileModel {
            provider_id: provider_id.to_owned(),
            provider_name,
            id: id.to_owned(),
            name: name.to_owned(),
            variants,
        });
        if models.len() > 4096 {
            return Err("Oversized mission catalog".into());
        }
    }
    models.sort_by(|left, right| {
        left.provider_id
            .to_lowercase()
            .cmp(&right.provider_id.to_lowercase())
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.id.to_lowercase().cmp(&right.id.to_lowercase()))
    });
    Ok(MissionCatalog {
        directory: directory.to_owned(),
        agents,
        models,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentDepthCapability {
    pub minimum: u64,
    pub maximum: Option<u64>,
    pub default: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentDepthProject {
    pub path: String,
    pub depth: Option<u64>,
    pub expectation: String,
    pub nesting_skipped: bool,
    pub empty_experimental: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentDepthNesting {
    pub effect: String,
    pub hidden: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentDepthSnapshot {
    pub directory: String,
    pub capability: Option<SubagentDepthCapability>,
    pub effective_depth: Option<u64>,
    pub nesting: Option<SubagentDepthNesting>,
    pub origin: Option<String>,
    pub project: Option<SubagentDepthProject>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubagentDepthError {
    Unsupported,
    Conflict,
    Failed,
}

pub async fn resolve_workspace_directory(
    backend: &Backend,
    workspace: &str,
    session: Option<&str>,
) -> std::result::Result<String, SubagentDepthError> {
    if !valid_id(workspace) || session.is_some_and(|id| !valid_id(id)) {
        return Err(SubagentDepthError::Failed);
    }
    if let Some(session) = session {
        return super::session_directory(backend, workspace, session)
            .await
            .map_err(|_| SubagentDepthError::Failed);
    }
    let projects = backend
        .projects()
        .await
        .map_err(|_| SubagentDepthError::Failed)?;
    projects
        .into_iter()
        .find(|project| project.id == workspace)
        .map(|project| project.path)
        .ok_or(SubagentDepthError::Failed)
}

pub async fn read_subagent_depth(
    backend: &Backend,
    workspace: &str,
    directory: &str,
) -> std::result::Result<SubagentDepthSnapshot, SubagentDepthError> {
    if !valid_id(workspace) || directory.trim().is_empty() {
        return Err(SubagentDepthError::Failed);
    }
    let response = backend
        .client
        .get(format!(
            "{}api/workspaces/{workspace}/subagent-depth",
            backend.base
        ))
        .query(&[("directory", directory)])
        .send()
        .await
        .map_err(|_| SubagentDepthError::Failed)?;
    match response.status() {
        StatusCode::NOT_FOUND | StatusCode::NOT_IMPLEMENTED => {
            return Err(SubagentDepthError::Unsupported);
        }
        status if !status.is_success() => return Err(SubagentDepthError::Failed),
        _ => {}
    }
    let value = read_json(response)
        .await
        .map_err(|_| SubagentDepthError::Failed)?;
    parse_subagent_depth(&value).ok_or(SubagentDepthError::Failed)
}

pub async fn set_subagent_depth(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    depth: Option<u64>,
    expectation: &str,
) -> std::result::Result<(), SubagentDepthError> {
    if !valid_id(workspace) || directory.trim().is_empty() || expectation.is_empty() {
        return Err(SubagentDepthError::Failed);
    }
    let response = backend
        .client
        .put(format!(
            "{}api/workspaces/{workspace}/subagent-depth",
            backend.base
        ))
        .json(&json!({
            "location": { "directory": directory },
            "depth": depth,
            "expectation": expectation,
        }))
        .send()
        .await
        .map_err(|_| SubagentDepthError::Failed)?;
    match response.status() {
        StatusCode::CONFLICT => Err(SubagentDepthError::Conflict),
        StatusCode::NOT_FOUND | StatusCode::NOT_IMPLEMENTED => Err(SubagentDepthError::Unsupported),
        status if status.is_success() => Ok(()),
        _ => Err(SubagentDepthError::Failed),
    }
}

fn parse_subagent_depth(value: &Value) -> Option<SubagentDepthSnapshot> {
    let map = value.as_object()?;
    let directory = map.get("location")?.get("directory")?.as_str()?.to_owned();
    if directory.is_empty() {
        return None;
    }
    let capability = match map.get("capability")? {
        Value::Null => None,
        Value::Object(cap) => Some(SubagentDepthCapability {
            minimum: cap.get("minimum")?.as_u64()?,
            maximum: match cap.get("maximum") {
                None | Some(Value::Null) => None,
                Some(v) => Some(v.as_u64()?),
            },
            default: match cap.get("default") {
                None | Some(Value::Null) => None,
                Some(v) => Some(v.as_u64()?),
            },
        }),
        _ => return None,
    };
    let effective_depth = match map.get("effectiveDepth") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_u64()?),
    };
    let nesting = match map.get("nesting") {
        None | Some(Value::Null) => None,
        Some(Value::Object(n)) => Some(SubagentDepthNesting {
            effect: n.get("effect")?.as_str()?.to_owned(),
            hidden: n.get("hidden").and_then(Value::as_bool).unwrap_or(false),
        }),
        _ => return None,
    };
    let origin = match map.get("origin") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_str()?.to_owned()),
    };
    let project = match map.get("project")? {
        Value::Null => None,
        Value::Object(p) => Some(SubagentDepthProject {
            path: p.get("path")?.as_str()?.to_owned(),
            depth: match p.get("depth") {
                None | Some(Value::Null) => None,
                Some(v) => Some(v.as_u64()?),
            },
            expectation: p.get("expectation")?.as_str()?.to_owned(),
            nesting_skipped: p
                .get("nestingSkipped")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            empty_experimental: p
                .get("emptyExperimental")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        _ => return None,
    };
    Some(SubagentDepthSnapshot {
        directory,
        capability,
        effective_depth,
        nesting,
        origin,
        project,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_filters_enabled_tool_models_and_legal_agents() {
        let catalog = parse_mission_catalog(
            "/repo",
            &json!([
                {"id": "plan", "mode": "primary"},
                {"id": "worker", "mode": "subagent"},
                {"id": "general", "mode": "all"},
                {"id": "secret", "mode": "all", "hidden": true}
            ]),
            &json!([
                {"providerID": "b", "id": "m2", "name": "Beta", "enabled": true, "status": "active", "capabilities": {"tools": true}, "variants": [{"id": "high"}]},
                {"providerID": "a", "id": "m1", "name": "Alpha", "enabled": true, "status": "active", "capabilities": {"tools": true}, "variants": []},
                {"providerID": "a", "id": "no-tools", "name": "Plain", "enabled": true, "status": "active", "capabilities": {"tools": false}, "variants": []},
                {"providerID": "a", "id": "off", "name": "Off", "enabled": false, "status": "active", "capabilities": {"tools": true}, "variants": []},
                {"providerID": "a", "id": "old", "name": "Old", "enabled": true, "status": "deprecated", "capabilities": {"tools": true}, "variants": []}
            ]),
            &json!([{"id": "a", "name": "Provider A"}, {"id": "b", "name": "Provider B"}]),
        )
        .unwrap();
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(catalog.models[0].provider_name, "Provider A");
        assert_eq!(catalog.models[1].variants, vec!["high"]);
        let coord: Vec<_> = legal_profile_agents(&catalog.agents, true, MissionTaskMode::Native)
            .into_iter()
            .map(|a| a.id.as_str())
            .collect();
        assert_eq!(coord, vec!["plan", "general"]);
        let native_child: Vec<_> =
            legal_profile_agents(&catalog.agents, false, MissionTaskMode::Native)
                .into_iter()
                .map(|a| a.id.as_str())
                .collect();
        assert_eq!(native_child, vec!["worker", "general"]);
        let indep_child: Vec<_> =
            legal_profile_agents(&catalog.agents, false, MissionTaskMode::Independent)
                .into_iter()
                .map(|a| a.id.as_str())
                .collect();
        assert_eq!(indep_child, vec!["plan", "general"]);
    }

    #[test]
    fn subagent_depth_snapshot_parses_strictly() {
        let parsed = parse_subagent_depth(&json!({
            "location": {"directory": "/repo"},
            "capability": {"minimum": 0, "maximum": 10, "default": 2},
            "effectiveDepth": 3,
            "nesting": {"effect": "allow", "hidden": false},
            "origin": "/repo/opencode.jsonc",
            "project": {
                "path": "/repo/opencode.jsonc",
                "depth": 3,
                "expectation": "a".repeat(64),
                "nestingSkipped": true,
                "emptyExperimental": false
            }
        }))
        .unwrap();
        assert_eq!(parsed.effective_depth, Some(3));
        assert!(parsed.project.as_ref().unwrap().nesting_skipped);
        assert!(parse_subagent_depth(&json!({"location": {}})).is_none());
    }

    #[test]
    fn expectation_encodes_presence_strictly() {
        let absent = MissionPreferenceExpectation::from_ui_config(
            Some(&json!({"settings": {}})),
            "missionProfileDefaults",
        );
        assert!(!absent.present);
        assert_eq!(
            absent.to_json(),
            json!({"key": "missionProfileDefaults", "present": false})
        );
        let present = MissionPreferenceExpectation::from_ui_config(
            Some(&json!({"settings": {"missionDeleteSessions": true}})),
            "missionDeleteSessions",
        );
        assert!(present.present);
        assert_eq!(
            present.to_json(),
            json!({"key": "missionDeleteSessions", "present": true, "value": true})
        );
    }
}
