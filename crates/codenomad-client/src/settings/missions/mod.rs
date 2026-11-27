//! Mission Preferences HTTP contracts: conditional UI preferences, native profile catalog,
//! and Location-scoped subagent depth.
mod depth;
mod library;
mod model;
mod profiles;
pub use depth::*;
pub use library::*;
pub use model::*;
pub use profiles::*;

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

fn confirms_patch(saved: &Value, patch_settings: &Value) -> bool {
    let Some(saved_settings) = saved.get("settings").and_then(Value::as_object) else {
        return false;
    };
    let Some(patched) = patch_settings.as_object() else {
        return false;
    };
    !patched.is_empty()
        && patched
            .iter()
            .all(|(key, expected)| saved_settings.get(key) == Some(expected))
}

pub async fn patch_mission_preferences(
    backend: &Backend,
    patch_settings: Value,
    expected: &[MissionPreferenceExpectation],
) -> MissionPatchOutcome {
    patch_mission_preferences_checked(backend, patch_settings, expected, || true)
        .await
        .unwrap_or(MissionPatchOutcome::Failed)
}

pub async fn patch_mission_preferences_checked(
    backend: &Backend,
    patch_settings: Value,
    expected: &[MissionPreferenceExpectation],
    can_send: impl FnOnce() -> bool,
) -> Option<MissionPatchOutcome> {
    let body = json!({
        "patch": { "settings": patch_settings },
        "expected": expected.iter().map(MissionPreferenceExpectation::to_json).collect::<Vec<_>>(),
    });
    let request = backend
        .client
        .patch(format!("{}api/storage/config/ui", backend.base))
        .query(&[("conditional", "missions-v1")])
        .json(&body);
    if !can_send() {
        return None;
    }
    let Ok(response) = request.send().await else {
        return Some(MissionPatchOutcome::Failed);
    };
    match response.status() {
        StatusCode::CONFLICT => return Some(MissionPatchOutcome::Conflict),
        StatusCode::NOT_FOUND | StatusCode::NOT_IMPLEMENTED => {
            return Some(MissionPatchOutcome::Unsupported);
        }
        status if !status.is_success() => return Some(MissionPatchOutcome::Failed),
        _ => {}
    }
    Some(match read_json(response).await {
        Ok(value) if confirms_patch(&value, &patch_settings) => MissionPatchOutcome::Applied(value),
        _ => MissionPatchOutcome::Failed,
    })
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
    pub all_model_names: BTreeMap<(String, String), String>,
}

pub fn legal_profile_agents(
    agents: &[ProfileAgent],
    coordinator: bool,
    task_mode: MissionTaskMode,
) -> Vec<&ProfileAgent> {
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
    pinned_directory: Option<&str>,
) -> Result<MissionCatalog> {
    if !valid_id(workspace) || session.is_some_and(|id| !valid_id(id)) {
        return Err("Invalid mission catalog Location".into());
    }
    let location = match pinned_directory {
        Some(dir) if crate::absolute_server_path(dir) => Some(dir.to_owned()),
        Some(_) => return Err("Invalid mission catalog Location".into()),
        None => match session {
            Some(session) => Some(super::session_directory(backend, workspace, session).await?),
            None => None,
        },
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
    if [&agents, &models, &providers]
        .iter()
        .any(|response| response["location"].get("workspaceID").is_some())
        || [&models, &providers]
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
        let Some(id) = agent["id"].as_str().filter(|s| valid_execution_id(s)) else {
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
    let mut all_model_names = BTreeMap::new();
    let mut models = Vec::new();
    for model in raw_models {
        if model["enabled"] != true || model["status"] == "deprecated" {
            continue;
        }
        let Some(provider_id) = model["providerID"]
            .as_str()
            .filter(|s| valid_execution_id(s))
        else {
            continue;
        };
        let Some(id) = model["id"].as_str().filter(|s| valid_execution_id(s)) else {
            continue;
        };
        let name = model["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(id);
        all_model_names.insert((provider_id.to_owned(), id.to_owned()), name.to_owned());
        if model["capabilities"]["tools"] != true {
            continue;
        }
        let variants = model["variants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| {
                v["id"]
                    .as_str()
                    .filter(|s| valid_execution_id(s))
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
        all_model_names,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_filters_oversized_ids_and_keeps_display_names_for_non_tool_models() {
        let huge = "x".repeat(241);
        let catalog = parse_mission_catalog(
            "/repo",
            &json!([
                {"id": "plan", "mode": "primary"},
                {"id": huge, "mode": "primary"},
                {"id": "worker", "mode": "subagent"},
                {"id": "general", "mode": "all"},
                {"id": "secret", "mode": "all", "hidden": true}
            ]),
            &json!([
                {"providerID": "b", "id": "m2", "name": "Beta", "enabled": true, "status": "active", "capabilities": {"tools": true}, "variants": [{"id": "high"}, {"id": "z".repeat(241)}]},
                {"providerID": "a", "id": "m1", "name": "Alpha", "enabled": true, "status": "active", "capabilities": {"tools": true}, "variants": []},
                {"providerID": "a", "id": "no-tools", "name": "Plain", "enabled": true, "status": "active", "capabilities": {"tools": false}, "variants": []},
                {"providerID": "a", "id": "off", "name": "Off", "enabled": false, "status": "active", "capabilities": {"tools": true}, "variants": []},
                {"providerID": "a", "id": "old", "name": "Old", "enabled": true, "status": "deprecated", "capabilities": {"tools": true}, "variants": []}
            ]),
            &json!([{"id": "a", "name": "Provider A"}, {"id": "b", "name": "Provider B"}]),
        )
        .unwrap();
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(catalog.models[1].variants, vec!["high"]);
        assert_eq!(
            catalog
                .all_model_names
                .get(&("a".into(), "no-tools".into()))
                .map(String::as_str),
            Some("Plain")
        );
        let coord: Vec<_> = legal_profile_agents(&catalog.agents, true, MissionTaskMode::Native)
            .into_iter()
            .map(|a| a.id.as_str())
            .collect();
        assert_eq!(coord, vec!["plan", "general"]);
    }

    #[test]
    fn expectation_and_ack_confirmation_are_strict() {
        let absent = MissionPreferenceExpectation::from_ui_config(
            Some(&json!({"settings": {}})),
            "missionProfileDefaults",
        );
        assert!(!absent.present);
        assert_eq!(
            absent.to_json(),
            json!({"key": "missionProfileDefaults", "present": false})
        );
        assert!(!confirms_patch(
            &json!({}),
            &json!({"missionDeleteSessions": true})
        ));
        assert!(!confirms_patch(
            &json!({"settings": {"missionDeleteSessions": false}}),
            &json!({"missionDeleteSessions": true})
        ));
        assert!(confirms_patch(
            &json!({"settings": {"missionDeleteSessions": true}}),
            &json!({"missionDeleteSessions": true})
        ));
    }
}
