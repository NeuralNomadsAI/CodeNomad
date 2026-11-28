//! Missions agent configuration library and profile/depth settings bridge commands
//! (reference `mission-profile-defaults.ts`, `mission-agent-settings.ts`, `model-library.ts`, `settings-tool.ts`).
use super::{bridge::current_agent, configuration, creation_admission::Scope, run::held};
use crate::{App, Error, Shared, shared::js_trim};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode as Status, header},
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const MAX_MISSION_MODELS: usize = 20;
const MODEL_FIELDS: [&str; 8] = ["version", "id", "name", "objective", "notes", "template", "profiles", "taskMode"];
const DEFAULT_SCOPES: [&str; 6] = ["all", "custom", "debug", "wayfinder", "delivery", "compare"];

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b[8] == b'-'
        && b[13] == b'-'
        && b[18] == b'-'
        && b[23] == b'-'
        && b.iter().enumerate().all(|(i, c)| matches!(i, 8 | 13 | 18 | 23) || c.is_ascii_hexdigit())
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn parse_mission_model(input: &Value) -> Result<Value, ()> {
    let o = input.as_object().ok_or(())?;
    if o.keys().any(|k| !MODEL_FIELDS.contains(&k.as_str()))
        || o.get("version").and_then(Value::as_u64) != Some(1)
    {
        return Err(());
    }
    let id = o.get("id").and_then(Value::as_str).filter(|s| is_uuid(s)).ok_or(())?;
    let name = o.get("name").and_then(Value::as_str).filter(|s| !js_trim(s).is_empty() && utf16_len(s) <= 80).ok_or(())?;
    let objective = o
        .get("objective")
        .and_then(Value::as_str)
        .filter(|s| !js_trim(s).is_empty() && utf16_len(s) <= 20_000)
        .ok_or(())?;
    let notes = o.get("notes").and_then(Value::as_str).filter(|s| utf16_len(s) <= 20_000).ok_or(())?;
    let template = o.get("template").and_then(Value::as_str).filter(|t| configuration::TEMPLATES.contains(t)).ok_or(())?;
    let task_mode = match o.get("taskMode") {
        None => None,
        Some(v) => Some(v.as_str().filter(|m| matches!(*m, "native" | "independent")).ok_or(())?),
    };
    let profiles = match o.get("profiles") {
        None => None,
        Some(p) => {
            let parsed = configuration::profiles(p)?;
            if !configuration::valid_profile_roles(template, &parsed) {
                return Err(());
            }
            Some(parsed)
        }
    };
    let mut out = Map::new();
    out.insert("version".into(), json!(1));
    out.insert("id".into(), json!(id));
    out.insert("name".into(), json!(js_trim(name)));
    out.insert("objective".into(), json!(js_trim(objective)));
    out.insert("notes".into(), json!(notes));
    out.insert("template".into(), json!(template));
    if let Some(p) = profiles {
        out.insert("profiles".into(), p);
    }
    if let Some(m) = task_mode {
        out.insert("taskMode".into(), json!(m));
    }
    Ok(Value::Object(out))
}

fn normalize_mission_models(input: Option<&Value>) -> Vec<Value> {
    let Some(arr) = input.and_then(Value::as_array).filter(|a| a.len() <= MAX_MISSION_MODELS) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(arr.len());
    let mut seen = HashSet::with_capacity(arr.len());
    for item in arr {
        let Ok(model) = parse_mission_model(item) else { return Vec::new() };
        let id = model["id"].as_str().unwrap_or_default().to_owned();
        if !seen.insert(id) {
            return Vec::new();
        }
        out.push(model);
    }
    out
}

fn valid_mission_models(input: Option<&Value>) -> bool {
    match input {
        None => true,
        Some(Value::Array(arr)) => arr.is_empty() || normalize_mission_models(input).len() == arr.len(),
        Some(_) => false,
    }
}

fn normalize_mission_defaults(input: Option<&Value>) -> Vec<Value> {
    let Some(arr) = input.and_then(Value::as_array).filter(|a| a.len() <= DEFAULT_SCOPES.len()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(arr.len());
    let mut seen = HashSet::with_capacity(arr.len());
    for entry in arr {
        let Some(o) = entry.as_object() else { return Vec::new() };
        if o.keys().any(|k| !matches!(k.as_str(), "template" | "profiles" | "taskMode")) {
            return Vec::new();
        }
        let Some(template) = o.get("template").and_then(Value::as_str).filter(|t| DEFAULT_SCOPES.contains(t)) else {
            return Vec::new();
        };
        if !seen.insert(template) {
            return Vec::new();
        }
        let task_mode = match o.get("taskMode") {
            None => None,
            Some(v) => match v.as_str().filter(|m| matches!(*m, "native" | "independent")) {
                Some(m) => Some(m),
                None => return Vec::new(),
            },
        };
        let Some(raw_profiles) = o.get("profiles") else { return Vec::new() };
        let Ok(profiles) = configuration::profiles(raw_profiles) else { return Vec::new() };
        let role_template = if template == "all" { "custom" } else { template };
        if !configuration::valid_profile_roles(role_template, &profiles) {
            return Vec::new();
        }
        let mut item = json!({ "template": template, "profiles": profiles });
        if let Some(m) = task_mode {
            item["taskMode"] = json!(m);
        }
        out.push(item);
    }
    if !out.iter().any(|item| item["template"] == "all")
        && let Some(legacy) = out.iter_mut().find(|item| item["template"] == "custom")
    {
        legacy["template"] = json!("all");
    }
    out
}

fn valid_mission_defaults(input: Option<&Value>) -> bool {
    match input {
        None => true,
        Some(Value::Array(arr)) => arr.is_empty() || normalize_mission_defaults(input).len() == arr.len(),
        Some(_) => false,
    }
}

fn encode_mission_defaults(entries: &[Value]) -> Vec<Value> {
    let flexible_only =
        entries.iter().any(|e| e["template"] == "custom") && !entries.iter().any(|e| e["template"] == "all");
    let mut list = Vec::with_capacity(entries.len() + usize::from(flexible_only));
    if flexible_only {
        list.push(json!({ "template": "all", "profiles": {} }));
    }
    list.extend(entries.iter().cloned());
    normalize_mission_defaults(Some(&Value::Array(list)))
}

/// SHA-256 of UTF-16LE `JSON.stringify(present ? { present, value } : { present })`.
fn expectation(present: bool, value: Option<&Value>) -> String {
    let text = match value {
        Some(v) if present => format!("{{\"present\":true,\"value\":{}}}", serde_json::to_string(v).unwrap_or_default()),
        _ => "{\"present\":false}".to_owned(),
    };
    let mut bytes = Vec::with_capacity(text.len() * 2);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    format!("{:x}", Sha256::digest(&bytes))
}

fn refused(code: &str) -> Value {
    json!({ "refused": true, "code": code })
}

pub(super) fn configurations(app: &App, input: Value) -> Result<Value, Error> {
    if !input.as_object().is_some_and(Map::is_empty) {
        return Err((
            Status::CONFLICT,
            Json(json!({"code":"invalid-execution","error":"Invalid saved configurations request"})),
        ));
    }
    let owner = app.settings.raw_config_owner("ui").map_err(|_| {
        (
            Status::SERVICE_UNAVAILABLE,
            Json(json!({"code":"mission-preferences-unavailable","error":"Missions preferences unavailable"})),
        )
    })?;
    let invalid_prefs = || {
        (
            Status::CONFLICT,
            Json(
                json!({"code":"mission-preferences-invalid","error":"Correct the Missions preferences before creating a mission"}),
            ),
        )
    };
    if owner.get("settings").is_some_and(|s| !s.is_object()) {
        return Err(invalid_prefs());
    }
    let raw = owner.get("settings").and_then(|s| s.get("missionModels"));
    if !valid_mission_models(raw) {
        return Err(invalid_prefs());
    }
    Ok(Value::Array(normalize_mission_models(raw)))
}

enum SettingsAction {
    Read,
    Save,
    Delete,
    Reset,
}

enum SettingsRequest {
    Configurations {
        action: SettingsAction,
        expectation: Option<String>,
        configuration: Option<Value>,
        configuration_id: Option<String>,
    },
    Preferences {
        action: SettingsAction,
        expectation: Option<String>,
        field: &'static str,
        defaults: Option<Vec<Value>>,
        delete_sessions: Option<bool>,
    },
    Depth {
        action: SettingsAction,
        expectation: Option<String>,
        depth: Option<Option<u64>>,
    },
}

fn parse_settings_input(raw: &Value) -> Result<SettingsRequest, ()> {
    let o = raw.as_object().ok_or(())?;
    let scope = o.get("scope").and_then(Value::as_str).ok_or(())?;
    let action = match o.get("action").and_then(Value::as_str) {
        Some("read") => SettingsAction::Read,
        Some("save") => SettingsAction::Save,
        Some("delete") => SettingsAction::Delete,
        Some("reset") => SettingsAction::Reset,
        _ => return Err(()),
    };
    let expectation = match o.get("expectation") {
        None => None,
        Some(v) => Some(v.as_str().filter(|s| is_hex64(s)).ok_or(())?.to_owned()),
    };
    if matches!(action, SettingsAction::Read) != expectation.is_none() {
        return Err(());
    }
    match scope {
        "configurations" => {
            if o.keys().any(|k| !matches!(k.as_str(), "scope" | "action" | "expectation" | "configuration" | "configurationID")) {
                return Err(());
            }
            let configuration = match o.get("configuration") {
                None => None,
                Some(v) => {
                    let cfg = v.as_object().ok_or(())?;
                    if cfg.contains_key("version") {
                        return Err(());
                    }
                    let mut with_version = cfg.clone();
                    with_version.insert("version".into(), json!(1));
                    Some(parse_mission_model(&Value::Object(with_version))?)
                }
            };
            let configuration_id = match o.get("configurationID") {
                None => None,
                Some(v) => Some(v.as_str().filter(|s| is_uuid(s)).ok_or(())?.to_owned()),
            };
            if matches!(action, SettingsAction::Save) != configuration.is_some()
                || matches!(action, SettingsAction::Delete) != configuration_id.is_some()
            {
                return Err(());
            }
            Ok(SettingsRequest::Configurations { action, expectation, configuration, configuration_id })
        }
        "preferences" => {
            if o.keys().any(|k| !matches!(k.as_str(), "scope" | "action" | "expectation" | "field" | "defaults" | "deleteSessions")) {
                return Err(());
            }
            let field = match o.get("field").and_then(Value::as_str) {
                Some("missionProfileDefaults") => "missionProfileDefaults",
                Some("missionDeleteSessions") => "missionDeleteSessions",
                _ => return Err(()),
            };
            let defaults = match o.get("defaults") {
                None => None,
                Some(v) => {
                    if !v.is_array() || !valid_mission_defaults(Some(v)) {
                        return Err(());
                    }
                    Some(v.as_array().unwrap().clone())
                }
            };
            let delete_sessions = match o.get("deleteSessions") {
                None => None,
                Some(v) => Some(v.as_bool().ok_or(())?),
            };
            if matches!(action, SettingsAction::Delete)
                || (matches!(action, SettingsAction::Save) && field == "missionProfileDefaults") != defaults.is_some()
                || (matches!(action, SettingsAction::Save) && field == "missionDeleteSessions") != delete_sessions.is_some()
            {
                return Err(());
            }
            Ok(SettingsRequest::Preferences { action, expectation, field, defaults, delete_sessions })
        }
        "depth" => {
            if o.keys().any(|k| !matches!(k.as_str(), "scope" | "action" | "expectation" | "depth")) {
                return Err(());
            }
            let depth = match o.get("depth") {
                None => None,
                Some(Value::Null) => Some(None),
                Some(v) => Some(Some(
                    v.as_u64()
                        .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0 && (1.0..=10.0).contains(f)).map(|f| f as u64))
                        .filter(|n| (1..=10).contains(n))
                        .ok_or(())?,
                )),
            };
            if matches!(action, SettingsAction::Delete | SettingsAction::Reset)
                || matches!(action, SettingsAction::Save) != depth.is_some()
            {
                return Err(());
            }
            Ok(SettingsRequest::Depth { action, expectation, depth })
        }
        _ => Err(()),
    }
}

fn depth_refusal_code(status: Status) -> &'static str {
    match status {
        Status::CONFLICT => "settings-conflict",
        Status::UNPROCESSABLE_ENTITY | Status::BAD_REQUEST => "settings-invalid",
        Status::NOT_FOUND => "settings-not-found",
        Status::FORBIDDEN => "settings-forbidden",
        _ => "settings-unavailable",
    }
}

pub(super) async fn settings(app: &Shared, scope: Scope, co: Value, input: Value) -> Result<Value, Error> {
    let parsed = match parse_settings_input(&input) {
        Ok(parsed) => parsed,
        Err(()) => return Ok(refused("settings-invalid")),
    };
    scope.refresh(app).await?;
    current_agent(app, &scope, &co).await?;
    let sid = co["id"].as_str().ok_or_else(held)?;
    let principal = json!({ "kind": "agent", "sessionID": sid });

    if let SettingsRequest::Depth { action, expectation, depth } = parsed {
        let wid = scope.workspace.id.to_string();
        return match action {
            SettingsAction::Read => {
                let encoded =
                    percent_encoding::utf8_percent_encode(&scope.dir, percent_encoding::NON_ALPHANUMERIC).to_string();
                let response = match crate::subagent_depth::get(
                    State(app.clone()),
                    Path(wid),
                    RawQuery(Some(format!("directory={encoded}"))),
                )
                .await
                {
                    Ok(resp) => resp,
                    Err((status, _)) => return Ok(refused(depth_refusal_code(status))),
                };
                let bytes = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
                    .await
                    .map_err(|_| held())?;
                let snapshot: Value = serde_json::from_slice(&bytes).map_err(|_| held())?;
                scope.refresh(app).await?;
                current_agent(app, &scope, &co).await?;
                Ok(json!({ "principal": principal, "scope": "project-location", "snapshot": snapshot }))
            }
            SettingsAction::Save => {
                let body = serde_json::to_vec(&json!({
                    "location": { "directory": scope.dir },
                    "depth": depth.flatten(),
                    "expectation": expectation.unwrap_or_default(),
                }))
                .map_err(|_| held())?;
                let mut headers = HeaderMap::new();
                headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
                match crate::subagent_depth::put(State(app.clone()), Path(wid), headers, Bytes::from(body)).await {
                    Ok(_) => Ok(json!({ "principal": principal, "saved": true })),
                    Err((status, _)) => Ok(refused(depth_refusal_code(status))),
                }
            }
            _ => Ok(refused("settings-invalid")),
        };
    }

    let owner = app.settings.raw_config_owner("ui").map_err(|_| held())?;
    let values = match owner.get("settings") {
        None => None,
        Some(Value::Object(map)) => Some(map),
        Some(_) => return Err(held()),
    };
    let key = match &parsed {
        SettingsRequest::Configurations { .. } => "missionModels",
        SettingsRequest::Preferences { field, .. } => *field,
        SettingsRequest::Depth { .. } => unreachable!(),
    };
    let present = values.is_some_and(|m| m.contains_key(key));
    let prior_value = values.and_then(|m| m.get(key)).cloned();
    let expected = expectation(present, prior_value.as_ref());
    let valid = match key {
        "missionModels" => valid_mission_models(prior_value.as_ref()),
        "missionProfileDefaults" => valid_mission_defaults(prior_value.as_ref()),
        _ => prior_value.is_none() || prior_value.as_ref().is_some_and(Value::is_boolean),
    };

    let (is_read, supplied_expectation) = match &parsed {
        SettingsRequest::Configurations { action, expectation, .. }
        | SettingsRequest::Preferences { action, expectation, .. } => {
            (matches!(action, SettingsAction::Read), expectation.as_deref())
        }
        SettingsRequest::Depth { .. } => unreachable!(),
    };

    if is_read {
        let mut out = json!({
            "principal": principal,
            "scope": "codenomad-profile",
            "field": key,
            "present": present,
            "valid": valid,
            "expectation": expected,
        });
        if key == "missionModels" {
            let summaries: Vec<Value> = if valid {
                normalize_mission_models(prior_value.as_ref())
                    .into_iter()
                    .map(|m| json!({"id": m["id"], "name": m["name"], "template": m["template"]}))
                    .collect()
            } else {
                Vec::new()
            };
            out["configurations"] = Value::Array(summaries);
        } else if valid {
            out["value"] = if key == "missionProfileDefaults" {
                Value::Array(normalize_mission_defaults(prior_value.as_ref()))
            } else {
                json!(prior_value.as_ref().and_then(Value::as_bool).unwrap_or(false))
            };
        }
        return Ok(out);
    }

    if supplied_expectation != Some(expected.as_str()) {
        return Ok(refused("settings-conflict"));
    }

    let mut saved_configuration_id: Option<String> = None;
    let next = match parsed {
        SettingsRequest::Configurations { action: SettingsAction::Reset, .. } => json!([]),
        SettingsRequest::Preferences { action: SettingsAction::Reset, field, .. } => {
            if field == "missionDeleteSessions" { Value::Null } else { json!([]) }
        }
        SettingsRequest::Configurations { action, configuration, configuration_id, .. } => {
            if !valid {
                return Ok(refused("settings-invalid"));
            }
            let models = normalize_mission_models(prior_value.as_ref());
            match action {
                SettingsAction::Delete => {
                    let target = configuration_id.unwrap_or_default();
                    Value::Array(models.into_iter().filter(|m| m["id"].as_str() != Some(target.as_str())).collect())
                }
                SettingsAction::Save => {
                    let model = configuration.unwrap();
                    let id = model["id"].as_str().unwrap_or_default().to_owned();
                    let exists = models.iter().any(|m| m["id"].as_str() == Some(id.as_str()));
                    if !exists && models.len() >= MAX_MISSION_MODELS {
                        return Ok(refused("settings-invalid"));
                    }
                    let mut updated: Vec<Value> =
                        models.into_iter().filter(|m| m["id"].as_str() != Some(id.as_str())).collect();
                    updated.push(model);
                    saved_configuration_id = Some(id);
                    Value::Array(updated)
                }
                _ => return Ok(refused("settings-invalid")),
            }
        }
        SettingsRequest::Preferences { field: "missionProfileDefaults", defaults, .. } => {
            Value::Array(encode_mission_defaults(&defaults.unwrap_or_default()))
        }
        SettingsRequest::Preferences { field: "missionDeleteSessions", delete_sessions, .. } => {
            Value::Bool(delete_sessions.unwrap_or(false))
        }
        _ => return Ok(refused("settings-invalid")),
    };

    if !scope.current(app) {
        return Err(held());
    }
    let write = crate::settings::patch_owner_checked(
        app,
        crate::settings::Kind::Config,
        "ui",
        json!({ "settings": { key: next } }),
        |before, _| {
            let ui = match before.get("ui") {
                None => return if !present { Ok(()) } else { Err(crate::settings::Failure::Conflict) },
                Some(Value::Object(map)) => map,
                Some(_) => return Err(crate::settings::Failure::Unreadable),
            };
            let settings = match ui.get("settings") {
                None => return if !present { Ok(()) } else { Err(crate::settings::Failure::Conflict) },
                Some(Value::Object(map)) => map,
                Some(_) => return Err(crate::settings::Failure::Unreadable),
            };
            let same = match (present, settings.get(key)) {
                (false, None) => true,
                (true, Some(actual)) => prior_value.as_ref() == Some(actual),
                _ => false,
            };
            if same { Ok(()) } else { Err(crate::settings::Failure::Conflict) }
        },
        || {},
    );
    match write {
        Ok(_) => {
            let mut out = json!({ "principal": principal, "saved": true });
            if let Some(cid) = saved_configuration_id {
                out["configurationID"] = json!(cid);
            }
            Ok(out)
        }
        Err(crate::settings::Failure::Conflict) => Ok(refused("settings-conflict")),
        Err(_) => Err(held()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expectation_uses_utf16le_json_sha256() {
        // Exact Node `createHash("sha256").update(JSON.stringify(...), "utf16le").digest("hex")` vectors.
        assert_eq!(expectation(false, None), "02900f87c5a67e6b558a025a8cff645d0b221cb5535e0c6b69f7768e268d6aae");
        assert_eq!(
            expectation(true, Some(&json!(false))),
            "d503aeec91f3fd4d6f7ec07bf037777fad497a4627622d7199964fef5d0a1c20"
        );
    }

    #[test]
    fn mission_models_and_defaults_validate_and_normalize() {
        let id = "11111111-2222-4333-8444-555555555555";
        let raw = json!([{
            "version": 1,
            "id": id,
            "name": "  Nightly Check  ",
            "objective": "  Verify endpoints  ",
            "notes": "",
            "template": "custom",
            "taskMode": "native"
        }]);
        assert!(valid_mission_models(Some(&raw)));
        let normalized = normalize_mission_models(Some(&raw));
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0]["name"], "Nightly Check");
        assert_eq!(normalized[0]["objective"], "Verify endpoints");
        // Duplicate IDs fail validation.
        let dup = json!([raw[0].clone(), raw[0].clone()]);
        assert!(!valid_mission_models(Some(&dup)));

        // Legacy Flexible-only defaults decode as `all` and encode with explicit `all`.
        let legacy = json!([{ "template": "custom", "profiles": {}, "taskMode": "independent" }]);
        let decoded = normalize_mission_defaults(Some(&legacy));
        assert_eq!(decoded[0]["template"], "all");
        let encoded = encode_mission_defaults(legacy.as_array().unwrap());
        assert_eq!(encoded.len(), 2);
        assert_eq!(encoded[0]["template"], "all");
        assert_eq!(encoded[1]["template"], "custom");
    }

    #[test]
    fn settings_input_enforces_scope_action_refinements() {
        let hex = "a".repeat(64);
        assert!(parse_settings_input(&json!({"scope":"configurations","action":"read"})).is_ok());
        assert!(parse_settings_input(&json!({"scope":"configurations","action":"read","expectation":hex})).is_err());
        assert!(parse_settings_input(&json!({"scope":"preferences","action":"delete","field":"missionDeleteSessions","expectation":hex})).is_err());
        assert!(parse_settings_input(&json!({"scope":"depth","action":"reset","expectation":hex})).is_err());
        assert!(parse_settings_input(&json!({"scope":"depth","action":"save","depth":0,"expectation":hex})).is_err());
        assert!(parse_settings_input(&json!({"scope":"depth","action":"save","depth":null,"expectation":hex})).is_ok());
        assert!(parse_settings_input(&json!({"scope":"depth","action":"save","depth":3,"expectation":hex})).is_ok());
    }

    #[test]
    fn configurations_reads_and_validates_ui_owner_library() {
        let dir = dunce::canonicalize(crate::shared::test_dir("mission-configs")).unwrap();
        let auth = crate::auth::Auth::new(crate::auth::Settings {
            username: "opencode".into(),
            password: None,
            file: None,
            cookie: "cn".into(),
            token: false,
            skip: true,
            managed_local: false,
            idle: std::time::Duration::from_secs(60),
            absolute: std::time::Duration::from_secs(60),
        })
        .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let settings_store = crate::settings::Settings::new(crate::settings::document::Location::resolve(
            dir.join("config.yaml").to_str().unwrap(),
        ));
        let app = App::new(
            auth,
            0,
            dir.clone(),
            dir.clone(),
            false,
            settings_store,
            Value::Null,
            crate::opencode::Native::test_connection(([127, 0, 0, 1], 1).into()),
            std::path::PathBuf::new(),
            None,
            crate::files::watch::Watches::new(tx),
            None,
        );
        // Rejects non-empty input
        assert_eq!(configurations(&app, json!({"extra":true})).unwrap_err().0, Status::CONFLICT);
        // Empty config returns []
        assert_eq!(configurations(&app, json!({})).unwrap(), json!([]));
        // Valid saved model is normalized
        let cid = "11111111-2222-4333-8444-555555555555";
        crate::settings::patch_owner(
            &app,
            crate::settings::Kind::Config,
            "ui",
            json!({"settings":{"missionModels":[{"version":1,"id":cid,"name":"  Ops  ","objective":"  Run checks ","notes":"","template":"custom"}]}}),
        )
        .ok()
        .unwrap();
        let list = configurations(&app, json!({})).unwrap();
        assert_eq!(list.as_array().map(Vec::len), Some(1));
        assert_eq!(list[0]["name"], "Ops");
        assert_eq!(list[0]["objective"], "Run checks");
        // Corrupt missionModels returns 409 mission-preferences-invalid
        crate::settings::patch_owner(
            &app,
            crate::settings::Kind::Config,
            "ui",
            json!({"settings":{"missionModels":"bad"}}),
        )
        .ok()
        .unwrap();
        let err = configurations(&app, json!({})).unwrap_err();
        assert_eq!(err.0, Status::CONFLICT);
        assert_eq!(err.1.0["code"], "mission-preferences-invalid");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
