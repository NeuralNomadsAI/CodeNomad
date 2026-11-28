//! The private schedule bridge reuses the calendar's HTTP ownership, admits
//! signed agent principals and uses exact reads for preparation recovery.
use super::{
    ACTIONS, Activation, Agent, Filter, Input, Principal, ReadQuery, activation, activation_pending, activate_for,
    capabilities, good, input_invalid, list, mutate, parse_input, read, read_exact, read_receipt, schedule_id, scope,
    unavailable,
};
use crate::{Error, Shared, missions::{configuration, creation_admission::Scope, recurrence_control}};
use axum::{Json, extract::{Path, Query, State}, http::StatusCode as Status};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(in crate::missions) async fn agent_command(app: Shared, scope: Scope, row: Value, raw: Value) -> Result<Value, Error> {
    let invalid = || input_invalid();
    let input = raw.as_object().ok_or_else(invalid)?;
    if let Some(program) = input.get("program") {
        return super::super::calendars::agent_program(app, scope, row, program).await;
    }
    let action = raw["action"].as_str().ok_or_else(invalid)?;
    let cancel = CancellationToken::new();
    let _disconnect = cancel.clone().drop_guard();
    let agent = Arc::new(Agent { scope, row, cancel, creation: None });
    let scope = &agent.scope;
    let id = scope.workspace.id.to_string();
    let directory = Some(scope.dir.clone());
    let fields = |names: &[&str]| input.keys().all(|k| names.contains(&k.as_str()));
    if !agent.current(&app).await {
        return Err(unavailable());
    }
    let result = match action {
        _ if raw["owner"] == "daily" => recurrence_control::agent_daily(&app, agent.clone(), raw).await?,
        "list" if fields(&["action", "after", "limit"]) => {
            let after = input.get("after").map(|a| a.as_str().filter(|v| good(v)).map(str::to_owned).ok_or_else(invalid)).transpose()?;
            let limit = input.get("limit").map(|v| v.as_u64().filter(|n| (1..=8).contains(n)).ok_or_else(invalid)).transpose()?;
            let Json(mut page) = list(State(app.clone()), Path(id), Query(Filter { directory, after, limit, request: None })).await?;
            let schedules = page["schedules"].as_array().ok_or_else(unavailable)?;
            page["schedules"] = Value::Array(schedules.iter().map(|doc| {
                let mut summary = json!({"missionID":doc["id"],"title":doc["configuration"]["title"]});
                for name in ["kind","revision","state","observation","availableActions","blockReason"] {
                    if let Some(value) = doc.get(name) { summary[name] = value.clone(); }
                }
                summary
            }).collect());
            page
        }
        "capabilities" if fields(&["action"]) => {
            capabilities(State(app.clone()), Path(id), Query(Filter { directory, ..Filter::default() })).await?.0
        }
        "read" if fields(&["action", "missionID", "requestID"]) => {
            let mid = raw["missionID"].as_str().filter(|v| good(v)).ok_or_else(invalid)?.to_owned();
            let request = input.get("requestID").map(|r| r.as_str().filter(|v| good(v)).map(str::to_owned).ok_or_else(invalid)).transpose()?;
            status(read(State(app.clone()), Path((id, mid)), Ok(Query(ReadQuery { directory, request }))).await)
        }
        _ => agent_mutate(app.clone(), agent.clone(), raw).await?,
    };
    if !agent.current(&app).await { return Err(unavailable()); }
    Ok(result)
}

fn status(result: Result<Json<Value>, Error>) -> Value {
    let (status, mut body) = match result {
        Ok(Json(body)) => (Status::OK, body),
        Err((status, Json(body))) => (status, body),
    };
    body["status"] = json!(status.as_u16());
    body
}

async fn agent_mutate(app: Shared, agent: Arc<Agent>, raw: Value) -> Result<Value, Error> {
    let action = raw["action"].as_str().ok_or_else(input_invalid)?;
    let mid = raw["missionID"].as_str().filter(|s| good(s)).ok_or_else(input_invalid)?.to_owned();
    let id = agent.scope.workspace.id.to_string();
    let dir = &agent.scope.dir;
    let activation = |request: String, revision| Activation { request, expected_document_revision: revision };
    if matches!(action, "activate" | "activation-read") {
        if !raw.as_object().unwrap().keys().all(|s| matches!(s.as_str(), "action" | "missionID" | "requestID" | "expectedRevision")) {
            return Err(input_invalid());
        }
        let request = raw["requestID"].as_str().filter(|s| good(s)).ok_or_else(input_invalid)?.to_owned();
        let revision = raw["expectedRevision"].as_u64().ok_or_else(input_invalid)?;
        let q = activation(request, revision);
        if !q.valid() { return Err(input_invalid()); }
        if action == "activation-read" {
            return activation::Journal { app: &app, endpoint: &agent.scope.endpoint, dir, mission: &mid, input: &q }
                .phase("read", Value::Null).await;
        }
        return activate_for(&app, &id, &mid, &q, Principal::Agent(agent)).await;
    }
    if !ACTIONS.contains(&action) || action == "create" || raw.get("directory").is_some()
        || raw.get("retry").is_some_and(|v| v != &Value::Bool(true) || action != "configure")
    {
        return Err(input_invalid());
    }
    let mut raw = raw;
    raw.as_object_mut().unwrap().remove("missionID");
    let mut input = parse_input(Ok(Json(raw)), false)?;
    input.directory = Some(dir.clone());
    let (status_code, caps) = agent.scope.call(&app, "documentCapabilities", &json!({}), 10, 32 * 1024).await?;
    if !status_code.is_success() || caps["output"]["version"] != 1 || caps["output"]["agentScheduleControl"] != true {
        return Ok(json!({"status":503,"pending":true,"missionID":mid,"requestID":input.request,"code":"schedule-control-unavailable"}));
    }
    let exact_read = |request| read_exact(&app, &agent.scope.endpoint, &agent.scope.workspace, &mid, request);
    let point = exact_read(None).await?;
    let doc = &point["document"];
    if !doc.is_null() && doc["kind"] != "schedule" && input.action != "configure" {
        return Err(input_invalid());
    }
    if matches!(input.action.as_str(), "play" | "resume") {
        let act = &doc["scheduleActivation"];
        let same_activation = act["requestID"] == input.request && act["expectedRevision"] == input.revision;
        let hold = app.calendar_holds.lock().unwrap().get(&mid).cloned();
        if let Some(held) = hold.as_ref().filter(|h| h.request == input.request && (same_activation || h.revision == input.revision)) {
            input.revision = held.revision;
        } else if hold.is_none() {
            let exact = exact_read(Some(&input.request)).await?;
            let control = &exact["document"]["control"];
            if control["requestID"] == input.request && (same_activation || control["expectedRevision"] == input.revision) {
                input.revision = control["expectedRevision"].as_u64().ok_or_else(activation_pending)?;
            } else if same_activation {
                return Ok(json!({"status":503,"pending":true,"missionID":mid,"requestID":input.request,"code":"schedule-pending"}));
            } else if doc["state"] == "paused" && configuration::requires_calendar(&doc["configuration"]["launch"]) {
                let q = activation(input.request.clone(), input.revision);
                let after = activate_for(&app, &id, &mid, &q, Principal::Agent(agent.clone())).await?;
                if after["document"]["scheduleActivation"]["state"] != "ready" { return Err(activation_pending()); }
                input.revision = after["document"]["revision"].as_u64().ok_or_else(activation_pending)?;
            }
        }
    }
    Ok(status(mutate(app, id, Some(mid), Principal::Agent(agent), input).await))
}

pub(super) fn same_creation(saved: &Value, expected: &Value) -> bool {
    ["requestID", "digest", "author"].iter().all(|key| saved[*key] == expected[*key])
}

pub(in crate::missions) async fn prepare_agent_schedule(
    app: &Shared, owned: Scope, row: Value, cancel: CancellationToken, configuration: Value, creation: Value, observe_only: bool,
) -> Result<Value, Error> {
    let request = creation["requestID"].as_str().filter(|r| good(r)).ok_or_else(input_invalid)?.to_owned();
    let id = owned.workspace.id.to_string();
    let dir = owned.dir.clone();
    let endpoint = owned.endpoint.clone();
    let agent = Arc::new(Agent { scope: owned, row, cancel, creation: Some(creation.clone()) });
    let (w, project, canonical) = scope(app, &id, Some(&dir)).await?;
    let mid = schedule_id(&project, &canonical, &request);
    let uncertain = |phase, req: &str| json!({"outcome":"uncertain","phase":phase,"requestID":req,"missionID":mid});
    let recovered = async |mut read: Value| {
        let document = &read["document"];
        if document.is_null() || read["pending"] == true {
            return uncertain("creation", &request);
        }
        if !same_creation(&document["creation"], &creation) {
            return json!({"outcome":"refused","phase":"creation","code":"prepare-conflict"});
        }
        if document["creation"]["automaticStart"]["attempted"] == true {
            let Some(start) = document["creation"]["automaticStart"]["requestID"].as_str().map(str::to_owned) else {
                return uncertain("start", &request);
            };
            if document["control"]["requestID"] != start {
                let Ok(exact) = read_receipt(app, &endpoint, &w, &project, &canonical, &mid, Some(&start)).await
                else { return uncertain("start", &start) };
                if !agent.current(app).await { return uncertain("start", &start); }
                read = exact.0;
            }
            let document = &read["document"];
            if document["control"]["requestID"] == start && document["control"]["action"] == "play"
                && document["control"]["pending"] == false && read["pending"] == false
            {
                return json!({"outcome":"activated","acknowledgement":"recovered","target":{"kind":"schedule","document":read}});
            }
            return uncertain("start", &start);
        }
        json!({"outcome":"prepared","acknowledgement":"recovered","target":{"kind":"schedule","document":read}})
    };
    if !agent.current(app).await { return Err(unavailable()); }
    let held = app.calendar_holds.lock().unwrap().get(&mid).cloned();
    if held.is_some() || observe_only {
        let automatic = creation["automaticStart"]["requestID"].as_str();
        let start_held = held.as_ref().is_some_and(|h| h.action == "play" && Some(h.request.as_str()) == automatic);
        let exact = if start_held { automatic.unwrap() } else { &request };
        return Ok(match read_receipt(app, &endpoint, &w, &project, &canonical, &mid, Some(exact)).await {
            Ok(Json(read)) if agent.current(app).await => recovered(read).await,
            _ => uncertain(if start_held { "start" } else { "creation" }, exact),
        });
    }
    let before = read_exact(app, &endpoint, &w, &mid, None).await?;
    if before["pending"] == true || !before["document"].is_null() {
        return Ok(recovered(before).await);
    }
    let make = |action: &str, request: &str, revision, configuration| Input {
        action: action.to_owned(), request: request.to_owned(), revision, configuration,
        directory: Some(dir.clone()), delete_managed: None, retry: false,
    };
    let created = match mutate(app.clone(), id.clone(), Some(mid.clone()), Principal::Agent(agent.clone()),
        make("create", &request, 0, Some(configuration))).await {
        Ok(Json(created)) => created,
        Err((_, Json(error))) if error["code"] == "schedule-refused" => {
            return Ok(json!({"outcome":"refused","phase":"creation","code":error["refusal"]["reason"]}));
        }
        Err(_) => return Ok(uncertain("creation", &request)),
    };
    if created["acknowledgement"] != "fresh" || !same_creation(&created["document"]["creation"], &creation) {
        return Ok(recovered(created).await);
    }
    let target = json!({"kind":"schedule","document":created});
    let Some(start) = creation["automaticStart"]["requestID"].as_str() else {
        return Ok(json!({"outcome":"prepared","acknowledgement":"fresh","target":target}));
    };
    let revision = created["document"]["revision"].as_u64().ok_or_else(unavailable)?;
    let q = Activation { request: start.to_owned(), expected_document_revision: revision };
    let after = match activate_for(app, &id, &mid, &q, Principal::Agent(agent.clone())).await {
        Ok(after) if after["document"]["scheduleActivation"]["state"] == "ready" => after,
        Err((_, Json(error))) if error["code"] == "schedule-activation-refused" =>
            return Ok(json!({"outcome":"refused","phase":"activation","code":error["code"],"target":target})),
        _ => return Ok(uncertain("activation", start)),
    };
    let revision = after["document"]["revision"].as_u64().ok_or_else(unavailable)?;
    let played = mutate(app.clone(), id, Some(mid), Principal::Agent(agent), make("play", start, revision, None)).await;
    Ok(match played {
        Ok(Json(read)) => json!({"outcome":"activated","acknowledgement":"fresh","target":{"kind":"schedule","document":read}}),
        Err(_) => json!({"outcome":"uncertain","phase":"start","requestID":start,"missionID":created["document"]["id"],"target":target}),
    })
}
