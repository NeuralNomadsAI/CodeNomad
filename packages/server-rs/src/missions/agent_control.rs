//! Missions agent project control, proof verification, and briefing request bridge commands
//! (reference `mission-agent-control.ts`, `project-control-tool.ts`, `project-control-proof.ts`, `briefing-request.ts`).
use super::{
    bridge::{self, current_root, dir, find, session, snapshot},
    configuration,
    creation_admission::{self, Scope},
    recurrence_contract::{self, SAFE, same_location, sign},
    run::{bad, foreign, held, token},
    task_sessions::valid_key,
};
use crate::{App, Error, Shared, shared::js_trim, worktrees::fence};
use axum::{Json, http::Method};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use uuid::Uuid;

const LANGUAGES: [&str; 10] = ["en", "de", "es", "fr", "he", "ja", "ne", "ru", "tr", "zh-Hans"];
const CONTROL_ACTIONS: [&str; 9] = [
    "read",
    "play",
    "resume",
    "pause",
    "interrupt",
    "stop",
    "recover-coordinator",
    "recover-report",
    "request-update",
];
const LIFECYCLE_ACTIONS: [&str; 5] = ["play", "resume", "pause", "interrupt", "stop"];
const RECURRENCE_PROOF_LIFETIME_MS: u64 = 30_000;
const PROOF_FUTURE_SKEW_MS: u64 = 5_000;
const MAX_PROOF_BYTES: usize = 512 * 1024;
const MAX_CONTROL_JSON_UNITS: usize = 100_000;

struct RetainedControl {
    _permit: fence::Entered,
    fingerprint: String,
    observed: bool,
    tool: String,
}

static RETAINED: LazyLock<Mutex<HashMap<(Uuid, String), RetainedControl>>> = LazyLock::new(Default::default);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn valid_doc_id(s: &str) -> bool {
    (3..=100).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn valid_request_update_id(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn valid_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn trimmed_request_id(v: Option<&Value>) -> Result<Option<String>, ()> {
    match v {
        None => Ok(None),
        Some(v) => {
            let s = js_trim(v.as_str().ok_or(())?);
            let len = s.chars().count();
            if !(1..=128).contains(&len) {
                return Err(());
            }
            Ok(Some(s.to_owned()))
        }
    }
}

fn parse_schedule_tool_configuration(raw: &Value) -> Result<Value, ()> {
    let o = raw.as_object().ok_or(())?;
    for forbidden in ["roots", "profileID", "executionHost", "coordinatorSelectionAuthor"] {
        if o.contains_key(forbidden) {
            return Err(());
        }
    }
    if !o.get("launch").and_then(|l| l.get("when")).is_some_and(Value::is_array) {
        return Err(());
    }
    let mut synthetic = o.clone();
    synthetic.insert("roots".into(), json!([{"mode":"directory-only","directory":"/"}]));
    synthetic.insert("profileID".into(), Value::Null);
    synthetic.insert("executionHost".into(), Value::Null);
    let mut parsed = configuration::shape(&Value::Object(synthetic))?;
    let out = parsed.as_object_mut().ok_or(())?;
    out.remove("roots");
    out.remove("profileID");
    out.remove("executionHost");
    Ok(parsed)
}

fn parse_project_tool_command(raw: &Value) -> Result<Value, ()> {
    let o = raw.as_object().ok_or(())?;
    if o.len() != 2 || !o.contains_key("tool") || !o.contains_key("input") {
        return Err(());
    }
    let tool = o["tool"].as_str().ok_or(())?;
    let input = o["input"].as_object().ok_or(())?;
    let mid = input.get("missionID").and_then(Value::as_str).filter(|s| valid_doc_id(s)).ok_or(())?;
    let request_id = trimmed_request_id(input.get("requestID"))?;
    let retry = match input.get("retry") {
        None => None,
        Some(Value::Bool(true)) => Some(true),
        Some(_) => return Err(()),
    };
    let mut out = Map::new();
    out.insert("missionID".into(), json!(mid));
    if let Some(req) = &request_id {
        out.insert("requestID".into(), json!(req));
    }
    if retry == Some(true) {
        out.insert("retry".into(), json!(true));
    }
    match tool {
        "control" => {
            if input.keys().any(|k| {
                !matches!(k.as_str(), "missionID" | "requestID" | "expectedRevision" | "retry" | "action" | "taskKey" | "language")
            }) {
                return Err(());
            }
            let action = input.get("action").and_then(Value::as_str).filter(|a| CONTROL_ACTIONS.contains(a)).ok_or(())?;
            let expected_revision = match input.get("expectedRevision") {
                None => None,
                Some(v) => Some(v.as_u64().filter(|n| (1..=SAFE).contains(n)).ok_or(())?),
            };
            let task_key = match input.get("taskKey") {
                None => None,
                Some(v) => Some(v.as_str().filter(|s| valid_key(s)).ok_or(())?),
            };
            let language = match input.get("language") {
                None => None,
                Some(v) => Some(v.as_str().filter(|l| LANGUAGES.contains(l)).ok_or(())?),
            };
            if (action != "read" && (request_id.is_none() || expected_revision.is_none()))
                || (action == "read" && expected_revision.is_some() && request_id.is_none())
                || (action == "recover-report") != task_key.is_some()
                || (language.is_some() && action != "request-update")
                || (action == "request-update" && !request_id.as_deref().is_some_and(valid_request_update_id))
                || (retry.is_some() && !LIFECYCLE_ACTIONS.contains(&action))
            {
                return Err(());
            }
            out.insert("action".into(), json!(action));
            if let Some(rev) = expected_revision {
                out.insert("expectedRevision".into(), json!(rev));
            }
            if let Some(tk) = task_key {
                out.insert("taskKey".into(), json!(tk));
            }
            if let Some(lang) = language {
                out.insert("language".into(), json!(lang));
            }
            Ok(json!({ "tool": "control", "input": Value::Object(out) }))
        }
        "configure" => {
            if input.keys().any(|k| {
                !matches!(
                    k.as_str(),
                    "missionID" | "requestID" | "expectedRevision" | "retry" | "action" | "objective" | "notes" | "configuration"
                )
            }) {
                return Err(());
            }
            let action = input.get("action").and_then(Value::as_str).filter(|a| matches!(*a, "read" | "save")).ok_or(())?;
            let expected_revision = match input.get("expectedRevision") {
                None => None,
                Some(v) => Some(v.as_u64().filter(|n| *n <= SAFE).ok_or(())?),
            };
            let objective = match input.get("objective") {
                None => None,
                Some(v) => {
                    let s = js_trim(v.as_str().ok_or(())?);
                    let len = s.chars().count();
                    if !(1..=20_000).contains(&len) {
                        return Err(());
                    }
                    Some(s.to_owned())
                }
            };
            let notes = match input.get("notes") {
                None => None,
                Some(v) => {
                    let s = v.as_str().ok_or(())?;
                    if s.chars().count() > 20_000 {
                        return Err(());
                    }
                    Some(s.to_owned())
                }
            };
            let configuration = match input.get("configuration") {
                None => None,
                Some(c) => Some(parse_schedule_tool_configuration(c)?),
            };
            if (action == "save"
                && (request_id.is_none()
                    || expected_revision.is_none()
                    || (configuration.is_none() && expected_revision == Some(0))
                    || (configuration.is_none() == objective.is_none())))
                || (configuration.is_some() && (objective.is_some() || notes.is_some()))
                || (action == "read" && (configuration.is_some() || objective.is_some() || notes.is_some() || retry.is_some()))
                || (action == "read" && expected_revision.is_some() && request_id.is_none())
                || (retry.is_some() && configuration.is_none())
            {
                return Err(());
            }
            out.insert("action".into(), json!(action));
            if let Some(rev) = expected_revision {
                out.insert("expectedRevision".into(), json!(rev));
            }
            if let Some(obj) = objective {
                out.insert("objective".into(), json!(obj));
            }
            if let Some(n) = notes {
                out.insert("notes".into(), json!(n));
            }
            if let Some(cfg) = configuration {
                out.insert("configuration".into(), cfg);
            }
            Ok(json!({ "tool": "configure", "input": Value::Object(out) }))
        }
        "delete" => {
            if input.keys().any(|k| {
                !matches!(k.as_str(), "missionID" | "requestID" | "expectedRevision" | "retry" | "action" | "deleteManagedSessions")
            }) {
                return Err(());
            }
            let action = input.get("action").and_then(Value::as_str).filter(|a| matches!(*a, "read" | "delete")).ok_or(())?;
            let expected_revision = match input.get("expectedRevision") {
                None => None,
                Some(v) => Some(v.as_u64().filter(|n| (1..=SAFE).contains(n)).ok_or(())?),
            };
            let delete_managed = match input.get("deleteManagedSessions") {
                None => None,
                Some(v) => Some(v.as_bool().ok_or(())?),
            };
            if (action == "delete" && (request_id.is_none() || expected_revision.is_none()))
                || (action == "read" && expected_revision.is_some() && request_id.is_none())
                || (action == "read" && (delete_managed.is_some() || retry.is_some()))
            {
                return Err(());
            }
            out.insert("action".into(), json!(action));
            if let Some(rev) = expected_revision {
                out.insert("expectedRevision".into(), json!(rev));
            }
            if let Some(d) = delete_managed {
                out.insert("deleteManagedSessions".into(), json!(d));
            }
            Ok(json!({ "tool": "delete", "input": Value::Object(out) }))
        }
        _ => Err(()),
    }
}

fn fingerprint_of(command: &Value) -> String {
    let mut copy = command.clone();
    if let Some(input) = copy.get_mut("input").and_then(Value::as_object_mut) {
        input.remove("retry");
    }
    recurrence_contract::canonical(&copy)
}

fn refusal_reply(code: &str, mid: &str, request_id: Option<&str>) -> Value {
    let mut out = json!({ "refused": true, "code": code, "missionID": mid });
    if let Some(req) = request_id {
        out["requestID"] = json!(req);
    }
    out
}

fn uncertain_reply(mid: &str, request_id: Option<&str>) -> Value {
    let mut out = json!({ "uncertain": true, "missionID": mid });
    if let Some(req) = request_id {
        out["requestID"] = json!(req);
    }
    out
}

async fn rpc_project_control(
    app: &App,
    scope: &Scope,
    co: &Value,
    bridge_token: &str,
    command: &Value,
) -> Result<Value, Result<String, ()>> {
    scope.refresh(app).await.map_err(|_| Err(()))?;
    current_root(app, scope, co).await.map_err(|_| Err(()))?;
    let sid = co["id"].as_str().ok_or(Err(()))?;
    let body = json!({
        "principal": { "kind": "agent", "sessionID": sid },
        "projectID": scope.project,
        "directory": scope.dir,
        "command": command,
        "issuedAt": now_ms(),
    });
    if recurrence_contract::canonical(&body).len() > MAX_PROOF_BYTES {
        return Err(Err(()));
    }
    let proof = sign(&body, bridge_token);
    let mut signed = body;
    signed["proof"] = json!(proof);
    let (status, response) = scope.call(app, "projectControl", &signed, 85, 256 * 1024).await.map_err(|_| Err(()))?;
    if !status.is_success() {
        if let Some((_, Json(err))) = creation_admission::rejection(&response)
            && let Some(code) = err["code"].as_str()
        {
            return Err(Ok(code.to_owned()));
        }
        return Err(Err(()));
    }
    let output = response.get("output").and_then(Value::as_object).ok_or(Err(()))?;
    if output.len() != 1 {
        return Err(Err(()));
    }
    let raw_json = output
        .get("json")
        .and_then(Value::as_str)
        .filter(|s| s.encode_utf16().count() <= MAX_CONTROL_JSON_UNITS)
        .ok_or(Err(()))?;
    scope.refresh(app).await.map_err(|_| Err(()))?;
    current_root(app, scope, co).await.map_err(|_| Err(()))?;
    let parsed: Value = serde_json::from_str(raw_json).map_err(|_| Err(()))?;
    if !parsed.is_object() {
        return Err(Err(()));
    }
    Ok(parsed)
}

pub(super) async fn control(app: &Shared, scope: Scope, co: Value, input: Value) -> Result<Value, Error> {
    let command = parse_project_tool_command(&input).map_err(|_| bad())?;
    let Some(bridge_token) = app.mission_bridge.as_deref() else {
        return Err(held());
    };
    let tool = command["tool"].as_str().unwrap_or_default();
    if tool == "configure" && command["input"].get("configuration").is_some() {
        let mut sched = command["input"].as_object().cloned().unwrap_or_default();
        sched.remove("objective");
        sched.remove("notes");
        sched.insert("action".into(), json!("configure"));
        return super::calendar::agent_command(app.clone(), scope, co, Value::Object(sched)).await;
    }
    if tool == "configure" && command["input"]["action"] == "read" {
        let mid = command["input"]["missionID"].as_str().unwrap_or_default();
        let req = command["input"].get("requestID").and_then(Value::as_str);
        let mut sched_read = json!({ "action": "read", "missionID": mid });
        if let Some(r) = req {
            sched_read["requestID"] = json!(r);
        }
        let schedule = super::calendar::agent_command(app.clone(), scope.clone(), co.clone(), sched_read).await?;
        if let Some(r) = req
            && schedule["document"]["control"]["requestID"].as_str() == Some(r)
            && schedule["document"]["control"]["action"] == "configure"
        {
            return Ok(json!({ "schedule": schedule }));
        }
        let mut executed = execute(app, &scope, &co, bridge_token, command).await?;
        if let Some(obj) = executed.as_object_mut() {
            obj.insert("schedule".into(), schedule);
        }
        return Ok(executed);
    }
    execute(app, &scope, &co, bridge_token, command).await
}

async fn execute(app: &App, scope: &Scope, co: &Value, bridge_token: &str, mut selected: Value) -> Result<Value, Error> {
    let _permit = scope.permit().ok_or_else(held)?;
    let tool = selected["tool"].as_str().unwrap_or_default().to_owned();
    let mid = selected["input"]["missionID"].as_str().unwrap_or_default().to_owned();
    let action = selected["input"]["action"].as_str().unwrap_or_default().to_owned();
    let request_id = selected["input"].get("requestID").and_then(Value::as_str).map(str::to_owned);
    let retry = selected["input"].get("retry") == Some(&Value::Bool(true));

    if tool == "delete" && action == "delete" && selected["input"].get("deleteManagedSessions").is_none() {
        let read_cmd = json!({ "tool": "delete", "input": { "action": "read", "missionID": mid, "requestID": request_id } });
        let before = rpc_project_control(app, scope, co, bridge_token, &read_cmd).await.map_err(|_| held())?;
        let original = before["receipt"]["command"]["input"]["deleteManagedSessions"].as_bool();
        let resolved = match original {
            Some(flag) => flag,
            None => {
                let ui = app.settings.raw_config_owner("ui").map_err(|_| held())?;
                match ui.get("settings") {
                    None => false,
                    Some(Value::Object(settings)) => match settings.get("missionDeleteSessions") {
                        None => false,
                        Some(Value::Bool(flag)) => *flag,
                        Some(_) => return Err(held()),
                    },
                    Some(_) => return Err(held()),
                }
            }
        };
        selected["input"]["deleteManagedSessions"] = json!(resolved);
    }

    let key = format!("{}\0{mid}\0{}", scope.project, request_id.as_deref().unwrap_or_default());
    let reg_key = (app.favorite_source, key.clone());
    let fingerprint = fingerprint_of(&selected);
    let (held_fp, held_observed, others) = {
        let guard = RETAINED.lock().unwrap();
        let current = guard.get(&reg_key).map(|r| (r.fingerprint.clone(), r.observed));
        let prefix = format!("{}\0{mid}\0", scope.project);
        let others: Vec<(String, String)> = if action != "read" && current.is_none() {
            guard
                .iter()
                .filter(|((src, k), _)| *src == app.favorite_source && k.starts_with(&prefix) && *k != key)
                .map(|((_, k), r)| (k.clone(), r.tool.clone()))
                .collect()
        } else {
            Vec::new()
        };
        (current.as_ref().map(|c| c.0.clone()), current.as_ref().is_some_and(|c| c.1), others)
    };

    if action != "read" {
        if let Some(fp) = &held_fp
            && fp != &fingerprint
        {
            return Ok(refusal_reply("request-conflict", &mid, request_id.as_deref()));
        }
        let prefix = format!("{}\0{mid}\0", scope.project);
        for (other_key, other_tool) in others {
            let other_req = &other_key[prefix.len()..];
            let read_cmd = json!({ "tool": other_tool, "input": { "action": "read", "missionID": mid, "requestID": other_req } });
            let observed = rpc_project_control(app, scope, co, bridge_token, &read_cmd).await.map_err(|_| held())?;
            let original = &observed["receipt"];
            if matches!(original["state"].as_str(), Some("completed" | "refused")) {
                RETAINED.lock().unwrap().remove(&(app.favorite_source, other_key));
                continue;
            }
            let cmd = &original["command"];
            let independent = cmd.is_object()
                && cmd["tool"] != "delete"
                && !(cmd["tool"] == "control"
                    && cmd["input"]["action"].as_str().is_some_and(|a| LIFECYCLE_ACTIONS.contains(&a)));
            let allow_stop = tool == "control" && action == "stop" && (original["retryable"] == true || independent);
            if !allow_stop {
                return Ok(json!({ "refused": true, "code": "control-pending", "missionID": mid }));
            }
        }
        if held_fp.is_some() {
            let read_cmd = json!({ "tool": tool, "input": { "action": "read", "missionID": mid, "requestID": request_id } });
            let observed = rpc_project_control(app, scope, co, bridge_token, &read_cmd).await.map_err(|_| held())?;
            let original = &observed["receipt"];
            if matches!(original["state"].as_str(), Some("completed" | "refused")) {
                RETAINED.lock().unwrap().remove(&reg_key);
                return Ok(observed);
            }
            if !retry || !held_observed || original["retryable"] != true {
                return Ok(observed);
            }
        }
    }

    let hold = || {
        let mut guard = RETAINED.lock().unwrap();
        if !guard.contains_key(&reg_key)
            && let Some(retained_permit) = scope.permit()
        {
            guard.insert(
                reg_key.clone(),
                RetainedControl {
                    _permit: retained_permit,
                    fingerprint: fingerprint.clone(),
                    observed: false,
                    tool: tool.clone(),
                },
            );
        }
    };

    match rpc_project_control(app, scope, co, bridge_token, &selected).await {
        Ok(result) => {
            let state = result["receipt"]["state"].as_str();
            let retryable = result["receipt"]["retryable"] == true;
            if action == "read"
                && request_id.is_some()
                && let Some(entry) = RETAINED.lock().unwrap().get_mut(&reg_key)
            {
                entry.observed = retryable;
            }
            if matches!(state, Some("completed" | "refused")) {
                RETAINED.lock().unwrap().remove(&reg_key);
            } else if action != "read" {
                hold();
            }
            Ok(result)
        }
        Err(Ok(code)) => Ok(refusal_reply(&code, &mid, request_id.as_deref())),
        Err(Err(())) => {
            if action != "read" {
                hold();
            }
            Ok(uncertain_reply(&mid, request_id.as_deref()))
        }
    }
}

struct VerifiedProof {
    session_id: String,
    project_id: String,
    directory: String,
    command: Value,
}

fn verify_proof(raw: &Value, bridge_token: &str, now: u64) -> Result<VerifiedProof, ()> {
    let o = raw.as_object().ok_or(())?;
    if o.len() != 6
        || !["principal", "projectID", "directory", "command", "issuedAt", "proof"]
            .iter()
            .all(|k| o.contains_key(*k))
    {
        return Err(());
    }
    let principal = o["principal"].as_object().ok_or(())?;
    if principal.len() != 2 || principal.get("kind").and_then(Value::as_str) != Some("agent") {
        return Err(());
    }
    let sid = principal
        .get("sessionID")
        .and_then(Value::as_str)
        .filter(|s| s.starts_with("ses") && s.encode_utf16().count() <= 240)
        .ok_or(())?;
    let project_id = o["projectID"]
        .as_str()
        .filter(|s| (1..=240).contains(&s.encode_utf16().count()))
        .ok_or(())?;
    let directory = o["directory"]
        .as_str()
        .filter(|s| (1..=4096).contains(&s.encode_utf16().count()))
        .ok_or(())?;
    let command = parse_project_tool_command(&o["command"])?;
    let issued_at = o["issuedAt"].as_u64().filter(|n| *n <= SAFE).ok_or(())?;
    let proof = o["proof"].as_str().filter(|s| valid_hex64(s)).ok_or(())?;
    if issued_at > now.saturating_add(PROOF_FUTURE_SKEW_MS) || now.saturating_sub(issued_at) >= RECURRENCE_PROOF_LIFETIME_MS {
        return Err(());
    }
    let unsigned = json!({
        "principal": { "kind": "agent", "sessionID": sid },
        "projectID": project_id,
        "directory": directory,
        "command": command,
        "issuedAt": issued_at,
    });
    if recurrence_contract::canonical(&unsigned).len() > MAX_PROOF_BYTES {
        return Err(());
    }
    let expected = sign(&unsigned, bridge_token);
    if expected.len() != proof.len() || !bool::from(expected.as_bytes().ct_eq(proof.as_bytes())) {
        return Err(());
    }
    Ok(VerifiedProof {
        session_id: sid.to_owned(),
        project_id: project_id.to_owned(),
        directory: directory.to_owned(),
        command,
    })
}

fn accepts_coordinator_message(mission: &Value) -> bool {
    mission["status"] == "active"
        && (mission["runState"].is_null() || mission["runState"] == "running")
        && mission["controlUnavailable"] != true
        && (mission["control"].is_null() || mission["control"]["pending"].as_array().is_some_and(Vec::is_empty))
}

fn mission_briefing_request_text(mission_id: &str, request_id: &str, locale: &str) -> String {
    format!(
        "CodeNomad project briefing request.\nMission ID: {mission_id}\nRequest ID: {request_id}\nResponse language: {locale}\n\nMake a short user-facing assessment of the whole project, including every requested workstream. Inspect this exact mission's current map and use actual returned results and existing evidence. Do not perform new tests, run or replay tasks, restart the mission, change its plan or priorities, install anything, or publish anything in order to answer this request. This request grants no additional execution or human-consent authority.\n\nPublish through mission.briefing with this exact requestID and missionID, and the freshly inspected revision as basedOnRevision. Provide a plain-language summary (what is usable versus still unverified) and up to three concise entries in each section: achieved, ongoing, obstacles, next. Entries have text and exact live source taskKeys (an empty array if no task supports the statement). Preserve distinctions between past obstacles and current ones, preparation and delivery, conversation activity and task execution. State uncertainty instead of inventing progress, percentages, completion or human approval. Include the next step towards the user's objective; use native Forms/permissions for any actual question, not a fabricated response alert.\n\nThis is an on-demand readout, not a request for periodic updates or a report after every task. If the map revision changes before publication, inspect again and update the readout; never replay work. If the briefing tool is unavailable, explain that in the conversation; do not create a substitute task or claim that the Missions panel has been updated."
    )
}

pub(super) async fn verify(app: &Shared, scope: Scope, co: Value, kind: &str, input: Value) -> Result<Value, Error> {
    let Some(bridge_token) = app.mission_bridge.as_deref() else {
        return Err(held());
    };
    let proof = verify_proof(&input, bridge_token, now_ms()).map_err(|_| foreign())?;
    let sid = co["id"].as_str().ok_or_else(foreign)?;
    if proof.session_id != sid
        || proof.project_id != co["projectID"].as_str().unwrap_or_default()
        || !same_location(&co["location"], &proof.directory)
    {
        return Err(foreign());
    }
    scope.refresh(app).await?;
    current_root(app, &scope, &co).await?;
    if kind == "project-control-verify" {
        return Ok(json!({ "verified": true }));
    }
    request_update(app, &scope, &co, &proof.command).await
}

async fn request_update(app: &Shared, scope: &Scope, co: &Value, command: &Value) -> Result<Value, Error> {
    if command["tool"] != "control" || command["input"]["action"] != "request-update" {
        return Err(bad());
    }
    let mid = command["input"]["missionID"].as_str().ok_or_else(bad)?;
    let request_id = command["input"]["requestID"].as_str().ok_or_else(bad)?;
    let expected_revision = command["input"]["expectedRevision"].as_u64().ok_or_else(bad)?;
    let language = command["input"].get("language").and_then(Value::as_str).unwrap_or("en");

    let read_mission = || async {
        let state = snapshot(app, scope).await?;
        scope.refresh(app).await?;
        current_root(app, scope, co).await?;
        let mission = find(&state, "missions", "id", mid).ok_or_else(held)?;
        if state["projectID"] != co["projectID"]
            || state["controlUnavailable"] == true
            || !accepts_coordinator_message(mission)
            || mission["revision"].as_u64() != Some(expected_revision)
        {
            return Err(held());
        }
        Ok::<Value, Error>(mission.clone())
    };

    let mission = read_mission().await?;
    let coordinator_id = mission["coordinatorSessionId"].as_str().ok_or_else(foreign)?;
    let actor = find(&mission, "actors", "sessionId", coordinator_id).ok_or_else(foreign)?;
    let actor_dir = dir(actor)?;
    let owned = Scope::open(app, scope.workspace.clone(), Some(actor_dir)).await?;
    let _permit = owned.permit().ok_or_else(held)?;

    let assert_current = || async {
        let fresh = read_mission().await?;
        let target = session(app, &owned, coordinator_id).await?;
        if fresh["coordinatorSessionId"].as_str() != Some(coordinator_id)
            || !target["parentID"].is_null()
            || target["projectID"] != mission["projectID"]
            || target["location"] != actor["location"]
            || !crate::worktrees::owns(app, &owned.workspace, actor_dir).await
        {
            return Err(foreign());
        }
        Ok::<Value, Error>(target)
    };

    let initial = assert_current().await?;
    bridge::sync_environment(app, &owned, coordinator_id).await?;
    bridge::sync_memory(app, &owned, &initial).await;
    owned.refresh(app).await?;
    let target = assert_current().await?;
    crate::sessions::permission_mode::refresh_before_send(app, &owned.endpoint, &target, || owned.current(app)).await?;
    assert_current().await?;
    let message_id = format!("msg_{}", token(&format!("mission-briefing\0{mid}\0{request_id}"), 28));
    let prompt_body = json!({
        "id": message_id,
        "delivery": "steer",
        "text": mission_briefing_request_text(mid, request_id, language),
    });
    let (status, _) = owned
        .request(
            app,
            Method::POST,
            &format!("/api/session/{coordinator_id}/prompt"),
            &[("location[directory]", actor_dir)],
            Some(&prompt_body),
            15,
            128 * 1024,
        )
        .await?;
    if !status.is_success() {
        return Err(held());
    }
    Ok(json!({ "admitted": true, "messageID": message_id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_tool_command_enforces_cross_field_rules() {
        assert!(parse_project_tool_command(&json!({
            "tool": "control",
            "input": { "missionID": "msn_1", "action": "read" }
        }))
        .is_ok());
        assert!(parse_project_tool_command(&json!({
            "tool": "control",
            "input": { "missionID": "msn_1", "action": "request-update", "requestID": "req_1", "expectedRevision": 2, "language": "fr" }
        }))
        .is_ok());
        // language only valid on request-update
        assert!(parse_project_tool_command(&json!({
            "tool": "control",
            "input": { "missionID": "msn_1", "action": "pause", "requestID": "req_1", "expectedRevision": 2, "language": "fr" }
        }))
        .is_err());
        // recover-report requires taskKey
        assert!(parse_project_tool_command(&json!({
            "tool": "control",
            "input": { "missionID": "msn_1", "action": "recover-report", "requestID": "req_1", "expectedRevision": 2 }
        }))
        .is_err());
        // configure save requires either objective or configuration (never both)
        assert!(parse_project_tool_command(&json!({
            "tool": "configure",
            "input": { "missionID": "msn_1", "action": "save", "requestID": "req_1", "expectedRevision": 1, "objective": "  ship  " }
        }))
        .is_ok());
        assert!(parse_project_tool_command(&json!({
            "tool": "configure",
            "input": { "missionID": "msn_1", "action": "save", "requestID": "req_1", "expectedRevision": 0, "objective": "ship" }
        }))
        .is_err());
        assert!(parse_project_tool_command(&json!({
            "tool": "delete",
            "input": { "missionID": "msn_1", "action": "delete", "requestID": "req_1", "expectedRevision": 1, "deleteManagedSessions": true }
        }))
        .is_ok());
        assert!(parse_project_tool_command(&json!({
            "tool": "delete",
            "input": { "missionID": "msn_1", "action": "read", "deleteManagedSessions": true }
        }))
        .is_err());
    }

    #[test]
    fn proof_verification_checks_hmac_and_freshness() {
        let secret = "bridge-secret";
        let now = 1_700_000_000_000u64;
        let unsigned = json!({
            "principal": { "kind": "agent", "sessionID": "ses_agent1" },
            "projectID": "prj_1",
            "directory": "/repo",
            "command": { "tool": "control", "input": { "missionID": "msn_1", "action": "read" } },
            "issuedAt": now - 1000,
        });
        let mut signed = unsigned.clone();
        signed["proof"] = json!(sign(&unsigned, secret));
        assert!(verify_proof(&signed, secret, now).is_ok());
        assert!(verify_proof(&signed, "wrong-secret", now).is_err());
        assert!(verify_proof(&signed, secret, now + 30_000).is_err());
        assert!(verify_proof(&signed, secret, now - 10_000).is_err());
    }

    #[test]
    fn briefing_request_text_and_acceptance_match_contract() {
        assert!(accepts_coordinator_message(&json!({ "status": "active", "runState": "running" })));
        assert!(!accepts_coordinator_message(&json!({ "status": "active", "runState": "paused" })));
        assert!(!accepts_coordinator_message(&json!({ "status": "active", "control": { "pending": ["x"] } })));
        let text = mission_briefing_request_text("msn_1", "req_1", "fr");
        assert!(text.starts_with("CodeNomad project briefing request.\nMission ID: msn_1\nRequest ID: req_1\nResponse language: fr\n"));
        assert!(text.contains("Publish through mission.briefing with this exact requestID and missionID"));
    }
}
