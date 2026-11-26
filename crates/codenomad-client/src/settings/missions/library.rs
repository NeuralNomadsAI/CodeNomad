//! Saved Mission configurations (`missionModels`) matching `server/src/missions/model-library.ts`.
use super::model::{MissionTaskMode, MissionTemplate, js_trim, parse_profiles};
use serde_json::Value;
use std::collections::HashSet;

pub const MAX_MISSION_MODELS: usize = 20;

#[derive(Clone, Debug, PartialEq)]
pub struct UserMissionModel {
    pub id: String,
    pub name: String,
    raw: Value,
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

fn parse_mission_model(value: &Value) -> Option<UserMissionModel> {
    let map = value.as_object()?;
    if map.keys().any(|key| {
        !matches!(
            key.as_str(),
            "version"
                | "id"
                | "name"
                | "objective"
                | "notes"
                | "template"
                | "profiles"
                | "taskMode"
        )
    }) {
        return None;
    }
    let version = map.get("version")?;
    if version.as_u64() != Some(1) && version.as_f64() != Some(1.0) {
        return None;
    }
    let id = map.get("id")?.as_str()?;
    if !is_uuid(id) {
        return None;
    }
    let name = map.get("name")?.as_str()?;
    let trimmed_name = js_trim(name);
    if trimmed_name.is_empty() || name.encode_utf16().count() > 80 {
        return None;
    }
    let objective = map.get("objective")?.as_str()?;
    if js_trim(objective).is_empty() || objective.encode_utf16().count() > 20_000 {
        return None;
    }
    let notes = map.get("notes")?.as_str()?;
    if notes.encode_utf16().count() > 20_000 {
        return None;
    }
    let template = MissionTemplate::parse(map.get("template")?.as_str()?)?;
    if let Some(v) = map.get("taskMode") {
        MissionTaskMode::parse(v.as_str()?)?;
    }
    if let Some(v) = map.get("profiles") {
        parse_profiles(v, template.roles())?;
    }
    Some(UserMissionModel {
        id: id.to_owned(),
        name: trimmed_name.to_owned(),
        raw: value.clone(),
    })
}

fn parse_mission_models_strict(value: &Value) -> Option<Vec<UserMissionModel>> {
    let list = value.as_array()?;
    if list.len() > MAX_MISSION_MODELS {
        return None;
    }
    let mut ids = HashSet::with_capacity(list.len());
    let mut models = Vec::with_capacity(list.len());
    for item in list {
        let model = parse_mission_model(item)?;
        if !ids.insert(model.id.clone()) {
            return None;
        }
        models.push(model);
    }
    Some(models)
}

pub fn valid_mission_models(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(value) => parse_mission_models_strict(value).is_some(),
    }
}

pub fn normalize_mission_models(value: Option<&Value>) -> Vec<UserMissionModel> {
    value
        .and_then(parse_mission_models_strict)
        .unwrap_or_default()
}

/// Filter out one validated configuration while preserving untouched siblings' exact JSON shape.
pub fn remove_mission_model_value(models: &[UserMissionModel], id: &str) -> Value {
    Value::Array(
        models
            .iter()
            .filter(|model| model.id != id)
            .map(|model| model.raw.clone())
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_models_and_preserves_sibling_shape_on_removal() {
        assert!(!valid_mission_models(Some(&json!([{
            "version": 1,
            "id": "not-a-uuid",
            "name": "Brief",
            "objective": "Ship",
            "notes": "",
            "template": "custom"
        }]))));
        assert!(!valid_mission_models(Some(&json!([{
            "version": 1,
            "id": "004633fb-53c4-477c-8b01-4cc5c177724b",
            "name": "\u{FEFF}",
            "objective": "Ship",
            "notes": "",
            "template": "custom"
        }]))));
        let sibling = json!({
            "version": 1,
            "id": "114633fb-53c4-477c-8b01-4cc5c177724b",
            "name": "Keep",
            "objective": "Keep me",
            "notes": "",
            "template": "custom",
            "profiles": { "roles": {} }
        });
        let list = json!([
            {
                "version": 1,
                "id": "004633fb-53c4-477c-8b01-4cc5c177724b",
                "name": "  Daily check  ",
                "objective": "Verify build",
                "notes": "",
                "template": "debug",
                "taskMode": "native"
            },
            sibling
        ]);
        assert!(valid_mission_models(Some(&list)));
        let models = normalize_mission_models(Some(&list));
        assert_eq!(models[0].name, "Daily check");
        assert_eq!(
            remove_mission_model_value(&models, "004633fb-53c4-477c-8b01-4cc5c177724b"),
            json!([sibling])
        );
    }
}
