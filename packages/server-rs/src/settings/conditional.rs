//! `settings/mission-preference-condition.ts`: the Missions preferences under `ui.settings`, written only
//! while each patched key still has the value (or absence) its caller read, checked again under the write lock.
use serde_json::{Map, Value};

use super::{Failure, Kind, Settings, document::Doc};

const KEYS: [&str; 3] = ["missionModels", "missionProfileDefaults", "missionDeleteSessions"];

struct Expected {
    key: String,
    present: bool,
    value: Option<Value>,
}

/// `ConditionalSchema` (strict objects; the expected keys exactly match the distinct patched keys).
fn parse(body: &Value) -> Option<(Value, Vec<Expected>)> {
    let exact = |o: &Map<String, Value>, keys: &[&str]| o.keys().all(|k| keys.contains(&k.as_str()));
    let body = body.as_object().filter(|o| exact(o, &["patch", "expected"]))?;
    let patch = body.get("patch")?.as_object().filter(|o| exact(o, &["settings"]))?;
    let settings = patch.get("settings")?.as_object().filter(|o| exact(o, &KEYS))?;
    let list = body.get("expected")?.as_array().filter(|l| (1..=3).contains(&l.len()))?;
    let mut expected = Vec::new();
    for item in list {
        let item = item.as_object().filter(|o| exact(o, &["key", "present", "value"]))?;
        let key = item.get("key")?.as_str().filter(|k| KEYS.contains(k))?;
        let present = item.get("present")?.as_bool()?;
        if present != item.contains_key("value") || expected.iter().any(|e: &Expected| e.key == key) {
            return None;
        }
        expected.push(Expected { key: key.into(), present, value: item.get("value").cloned() });
    }
    if settings.len() != expected.len() || !settings.keys().all(|k| expected.iter().any(|e| &e.key == k)) {
        return None;
    }
    Some((Value::Object(Map::from_iter([("settings".into(), Value::Object(settings.clone()))])), expected))
}

fn holds(settings: &Map<String, Value>, expected: &[Expected]) -> bool {
    expected
        .iter()
        .all(|e| settings.contains_key(&e.key) == e.present && (!e.present || settings.get(&e.key) == e.value.as_ref()))
}

/// `applyConditionalMissionPreferences`
pub fn apply(settings: &Settings, owner: &str, body: &Value) -> Result<Value, Failure> {
    if owner != "ui" {
        return Err(Failure::Invalid("Conditional mission preferences require the ui owner".into()));
    }
    let (patch, expected) =
        parse(body).ok_or_else(|| Failure::Invalid("Invalid conditional mission preferences".into()))?;
    let current = settings.raw_config_owner("ui")?;
    let read = current.get("settings").and_then(Value::as_object).cloned().unwrap_or_default();
    if !holds(&read, &expected) {
        return Err(Failure::Conflict);
    }
    settings.patch_checked(Kind::Config, "ui", &patch, |before: &Doc, _| {
        let ui = before.get("ui");
        let latest = ui.and_then(|ui| ui.get("settings"));
        if ui.is_some_and(|ui| !ui.is_object()) || latest.is_some_and(|s| !s.is_object()) {
            return Err(Failure::Conflict);
        }
        match holds(&latest.and_then(Value::as_object).cloned().unwrap_or_default(), &expected) {
            true => Ok(()),
            false => Err(Failure::Conflict),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn conditions_follow_the_reference_schema_and_compare_values() {
        let dir = crate::shared::test_dir("settings-conditional");
        let settings =
            Settings::new(super::super::document::Location::resolve(dir.join("config.yaml").to_str().unwrap()));
        let set = |value: Value, expected: Value| {
            apply(&settings, "ui", &json!({"patch": {"settings": {"missionModels": value}}, "expected": expected}))
        };
        assert!(set(json!(1), json!([{"key": "missionModels", "present": false}])).is_ok());
        assert!(matches!(set(json!(2), json!([{"key": "missionModels", "present": false}])), Err(Failure::Conflict)));
        assert!(set(json!({"a": [1]}), json!([{"key": "missionModels", "present": true, "value": 1}])).is_ok());
        assert!(set(json!(3), json!([{"key": "missionModels", "present": true, "value": {"a": [1]}}])).is_ok());
        for invalid in [
            json!([{"key": "missionModels", "present": true}]),
            json!([{"key": "missionDeleteSessions", "present": false}]),
            json!([{"key": "missionModels", "present": false, "value": 3}]),
            json!([]),
            json!([{"key": "missionModels", "present": false, "extra": 1}]),
        ] {
            assert!(matches!(set(json!(4), invalid.clone()), Err(Failure::Invalid(_))), "{invalid}");
        }
        assert!(matches!(apply(&settings, "server", &json!({})), Err(Failure::Invalid(_))));
        assert_eq!(settings.raw_config_owner("ui").unwrap()["settings"]["missionModels"], json!(3));
        let _ = std::fs::remove_dir_all(dir);
    }
}
