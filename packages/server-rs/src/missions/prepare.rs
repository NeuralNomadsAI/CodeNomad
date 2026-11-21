use super::{
    bridge::{self, dir, session, snapshot},
    configuration,
    creation_admission::{self, Attempt, Scope},
    run::{autonomous_creation, creation_profiles, document_capabilities, token},
};
use crate::{App, Error, shared::js_trim};
use axum::{Json, http::StatusCode as Status};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc};

fn refusal(code: &'static str) -> Error {
    let message = match code {
        "prepare-conflict" => "This requestID already prepared a different mission",
        "prepare-uncertain" => "The prepared mission's outcome is uncertain; retry with the same requestID",
        "prepare-no-effect" => "The preparation request was refused without effects; correct the request and retry",
        _ => "The mission could not be prepared; nothing was created",
    };
    (Status::CONFLICT, Json(json!({"code":code,"error":message})))
}

const REFUSED: &str = "prepare-refused";
const UNKNOWN: &str = "prepare-uncertain";

pub(super) fn defaults(app: &App, input: Value) -> Result<Value, Error> {
    let invalid = || {
        (
            Status::CONFLICT,
            Json(json!({"code":"invalid-execution","error":"Correct the mission command, profiles or taskMode"})),
        )
    };
    let owner = app.settings.raw_config_owner("ui").map_err(|_| {
        (
            Status::SERVICE_UNAVAILABLE,
            Json(json!({"code":"mission-preferences-unavailable","error":"Missions preferences unavailable"})),
        )
    })?;
    let bad_prefs = || {
        (
            Status::CONFLICT,
            Json(
                json!({"code":"mission-preferences-invalid","error":"Correct the Missions preferences before creating a mission"}),
            ),
        )
    };
    let mut preferences = std::collections::BTreeMap::new();
    if owner.get("settings").is_some_and(|s| !s.is_object()) {
        return Err(bad_prefs());
    }
    if let Some(items) = owner.get("settings").and_then(|s| s.get("missionProfileDefaults")) {
        let items = items.as_array().filter(|a| a.len() <= 6).ok_or_else(bad_prefs)?;
        for p in items {
            let t = p["template"]
                .as_str()
                .filter(|t| *t == "all" || configuration::TEMPLATES.contains(t))
                .ok_or_else(bad_prefs)?;
            let profiles = configuration::profiles(&p["profiles"]).map_err(|_| bad_prefs())?;
            if !configuration::valid_profile_roles(if t == "all" { "custom" } else { t }, &profiles)
                || !p
                    .as_object()
                    .is_some_and(|o| o.keys().all(|k| matches!(k.as_str(), "template" | "profiles" | "taskMode")))
                || p.get("taskMode").is_some_and(|m| !matches!(m.as_str(), Some("native" | "independent")))
                || preferences.insert(t, p).is_some()
            {
                return Err(bad_prefs());
            }
        }
    }
    let template = input["template"].as_str().filter(|t| configuration::TEMPLATES.contains(t)).ok_or_else(invalid)?;
    let explicit =
        input.get("profiles").map(configuration::profiles).transpose().map_err(|_| invalid())?.unwrap_or_default();
    if !configuration::valid_profile_roles(template, &explicit)
        || !input.as_object().is_some_and(|o| {
            o.keys().all(|k| matches!(k.as_str(), "template" | "profiles" | "taskMode" | "coordinatorModel"))
        })
        || input.get("taskMode").is_some_and(|v| !matches!(v.as_str(), Some("native" | "independent")))
    {
        return Err(invalid());
    }
    let model = input
        .get("coordinatorModel")
        .map(|m| configuration::profiles(&json!({"coordinator":{"model":m}})))
        .transpose()
        .map_err(|_| invalid())?;
    let all = preferences.get("all").copied().unwrap_or(&Value::Null);
    let specific = preferences.get(template).copied().unwrap_or(&Value::Null);
    let slot = |explicit: &Value, specific: &Value, all: &Value| {
        if !explicit.is_null() {
            (explicit.clone(), "explicit")
        } else if !specific.is_null() {
            (specific.clone(), "preference")
        } else if !all.is_null() {
            (all.clone(), "preference")
        } else {
            (json!({}), "opencode-default")
        }
    };
    let (coordinator, coordinator_origin) =
        slot(&explicit["coordinator"], &specific["profiles"]["coordinator"], &all["profiles"]["coordinator"]);
    let mut result = json!({"profiles":{"coordinator":coordinator,"roles":{}},"origins":{"coordinator":coordinator_origin,"roles":{}}});
    for role in configuration::template_roles(template) {
        let judge = template == "compare" && *role == "comparator";
        let inherited = if judge { &Value::Null } else { &all["profiles"]["roles"]["specialist"] };
        let (mut selected, mut origin) =
            slot(&explicit["roles"][*role], &specific["profiles"]["roles"][*role], inherited);
        if judge {
            if origin == "opencode-default" {
                origin = coordinator_origin;
            }
            if selected.get("model").is_none() {
                if let Some(model) =
                    coordinator.get("model").or_else(|| model.as_ref()?.get("coordinator")?.get("model"))
                {
                    selected["model"] = model.clone();
                }
            }
        }
        result["profiles"]["roles"][*role] = selected;
        result["origins"]["roles"][*role] = json!(origin);
    }
    let (mode, origin) = slot(&input["taskMode"], &specific["taskMode"], &all["taskMode"]);
    result["taskMode"] = json!(mode.as_str().unwrap_or("native"));
    result["origins"]["taskMode"] = json!(origin);
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    #[serde(rename = "missionID")]
    mission: Option<String>,
    #[serde(rename = "requestID")]
    request: String,
    objective: String,
    title: Option<String>,
    notes: Option<String>,
    template: String,
    profiles: Option<Value>,
    task_mode: Option<String>,
    creation_defaults: Option<Value>,
    #[serde(rename = "watchedConversationIDs")]
    watched: Option<Vec<String>>,
    #[serde(rename = "coordinatorSessionID")]
    coordinator: Option<String>,
    start_on_creation: Option<bool>,
    launch: Option<Value>,
    observe_only: Option<bool>,
}

/// The actual author may be an ordinary descendant; the source is the nearest
/// proven Mission membership, not a user-supplied ancestor or a graph edge.
async fn source(app: &App, scope: &Scope, author: &Value) -> Result<Option<String>, Error> {
    let s = snapshot(app, scope).await?;
    let mut who = author.clone();
    let mut seen = HashSet::new();
    for _ in 0..=32 {
        let id = who["id"].as_str().ok_or_else(|| refusal(REFUSED))?;
        if id.starts_with("ses_cn_schedule_")
            || !seen.insert(id.to_owned())
            || who["projectID"] != scope.project
            || who["location"] != author["location"]
        {
            return Err(refusal(REFUSED));
        }
        let memberships = s["missions"].as_array().unwrap().iter().filter(|m| bridge::recorded(m, &who));
        let mut active = memberships.clone().filter(|m| m["status"] == "active");
        let primary = active.next();
        if active.next().is_some() {
            return Err(refusal(REFUSED));
        }
        let marker = who["metadata"].get("codenomad.mission");
        if marker.is_some_and(|m| !m["missionID"].is_string()) {
            return Err(refusal(REFUSED));
        }
        let selected = primary
            .map(|m| &m["id"])
            .or_else(|| marker.map(|m| &m["missionID"]))
            .or_else(|| memberships.max_by_key(|m| m["updatedAt"].as_u64()).map(|m| &m["id"]));
        if let Some(mid) = selected {
            return Ok(Some(mid.as_str().ok_or_else(|| refusal(REFUSED))?.to_owned()));
        }
        if who["parentID"].is_null() {
            return Ok(None);
        }
        let parent = who["parentID"].as_str().ok_or_else(|| refusal(REFUSED))?;
        who = session(app, scope, parent).await?;
    }
    Err(refusal(REFUSED))
}

fn recovered(m: Value, request: &str) -> Value {
    let mid = m["id"].clone();
    let automatic = &m["document"]["automaticStart"];
    let play = &m["document"]["firstPlay"];
    let attempted = automatic["attempted"] == true;
    let op = format!("evt_{}", token(&format!("{}\0control-{request}", mid.as_str().unwrap_or_default()), 28));
    let admitted = automatic["requestID"] == request
        && play["requestID"] == request
        && play["operationID"] == op
        && play["admittedAt"].as_u64().is_some();
    let target = json!({"kind":"one-time","mission":m});
    if attempted && !admitted {
        return json!({"outcome":"uncertain","phase":"start","requestID":request,"missionID":mid,"target":target});
    }
    json!({"outcome":if attempted { "activated" } else { "prepared" },"acknowledgement":"recovered","target":target})
}

pub(super) async fn prepare(
    app: &App,
    scope: Scope,
    author: Value,
    raw: Value,
    lifetime: tokio_util::sync::CancellationToken,
) -> Result<Value, Error> {
    let invalid = || refusal(REFUSED);
    if raw.as_object().is_none_or(|o| o.values().any(Value::is_null)) {
        return Err(invalid());
    }
    let q: Prepare = serde_json::from_value(raw.clone()).map_err(|_| invalid())?;
    let request = js_trim(&q.request);
    let objective = js_trim(&q.objective);
    let title = q.title.as_deref().map(js_trim);
    let size = |v: &str, n| (1..=n).contains(&v.chars().count());
    // Calendar writes need the dedicated signed project-agent principal; never
    // submit an agent preparation through the human calendar route.
    if q.launch
        .as_ref()
        .is_some_and(|launch| launch != &json!({"when":[]}) && launch != &json!({"when":[{"kind":"now"}]}))
        || q.coordinator.is_some()
        || q.observe_only.is_some()
        || !size(request, 128)
        || !size(objective, 20_000)
        || title.is_some_and(|s| !size(s, 60) || s.contains(['\r', '\n']))
        || q.notes.as_deref().is_some_and(|s| s.chars().count() > 20_000)
        || !configuration::TEMPLATES.contains(&q.template.as_str())
        || q.task_mode.as_deref().is_some_and(|s| !matches!(s, "native" | "independent"))
    {
        return Err(invalid());
    }
    let mut watched = q.watched.unwrap_or_default();
    if watched.len() > 64 || watched.iter().any(|id| !creation_admission::native_id(id)) {
        return Err(invalid());
    }
    watched.sort_unstable();
    if watched.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(invalid());
    }
    let author_sid = author["id"].as_str().ok_or_else(invalid)?;
    let owner = format!("prepare:{}:{author_sid}", scope.project);
    let key = (owner, request.to_owned());
    let request_start = format!("start_{}", token(&format!("creation\0{request}"), 24));
    match app.mission_creations.register(&key.0, request, &raw) {
        Ok(()) => {}
        Err(err) if err.1.0["code"] == "creation-uncertain" => {
            let observed = app.mission_creations.receipt(app, &key).await;
            if observed["state"] == "created" && observed["mission"]["preparedBy"]["coordinatorSessionId"] == author_sid
            {
                return Ok(recovered(observed["mission"].clone(), &request_start));
            }
            return Err(refusal(UNKNOWN));
        }
        Err(err) => {
            return Err(refusal(if err.1.0["code"] == "creation-conflict" { "prepare-conflict" } else { REFUSED }));
        }
    }
    let start = q.start_on_creation == Some(true);
    let result = async {
        let profiles = creation_profiles(&q.template, q.profiles)?;
        let initial_source = source(app, &scope, &author).await?;
        if initial_source != q.mission {
            return Err(invalid());
        }
        let mut by = json!({"coordinatorSessionID":author_sid});
        if let Some(mid) = &initial_source {
            by["missionID"] = json!(mid);
        }
        let mut input = json!({"requestID":request,"objective":objective,"template":q.template,"taskMode":q.task_mode.as_deref().unwrap_or("native"),
            "prepared":true,"preparedBy":by,"expectedCoordinatorLocation":{"directory":scope.dir},"startOnCreation":start});
        if let Some(title) = title { input["title"] = json!(title); }
        if let Some(notes) = q.notes { input["notes"] = json!(notes); }
        if let Some(profiles) = profiles { input["profiles"] = profiles; }
        if let Some(defaults) = q.creation_defaults {
            if defaults["profiles"] != input["profiles"] || defaults["taskMode"] != input["taskMode"] {
                return Err(invalid());
            }
            input["creationDefaults"] = defaults;
        }
        if !watched.is_empty() {
            input["preparationOptions"] = json!({"watchedConversationIDs":watched});
        }
        let (status, caps) = scope.call(app, "documentCapabilities", &json!({}), 10, 65_536).await?;
        if !status.is_success() || !document_capabilities(&caps["output"]) || caps["output"]["automaticStart"] != true {
            return Err(invalid());
        }
        let permit = scope.permit().ok_or_else(invalid)?;
        let _continuation = if start { Some(scope.permit().ok_or_else(invalid)?) } else { None };
        scope.refresh(app).await?;
        let fresh = session(app, &scope, author_sid).await?;
        if dir(&fresh)? != dir(&author)? || source(app, &scope, &fresh).await? != initial_source {
            return Err(invalid());
        }
        autonomous_creation(app)?;
        if lifetime.is_cancelled() {
            return Err(invalid());
        }
        let mission = format!("msn_{}", token(&format!("{}\0{request}", scope.project), 24));
        let attempt = Arc::new(Attempt {scope, input, mission});
        app.mission_creations.dispatched(&key, attempt.clone(), permit)?;
        let created = attempt.create(app).await?;
        if !attempt.acknowledgement(&created) || attempt.scope.refresh(app).await.is_err() {
            return Err(creation_admission::uncertain());
        }
        // Confirm creation before following a separately guarded fresh Play intent.
        if created["acknowledgement"] == "recovered" {
            return Ok(recovered(created["mission"].clone(), &request_start));
        }
        let m = created["mission"].clone();
        let target = json!({"kind":"one-time","mission":m});
        if !start {
            return Ok(json!({"outcome":"prepared","acknowledgement":"fresh","target":target}));
        }
        let uncertain = || json!({"outcome":"uncertain","phase":"start","requestID":request_start,"missionID":m["id"],"target":target});
        let document = &m["document"];
        if document["automaticStart"]["requestID"] != request_start || document["automaticStart"]["attempted"] != false
            || !document["firstPlay"].is_null() || document["revision"].as_u64().is_none()
        {
            return Ok(uncertain());
        }
        let play = json!({"missionID":m["id"],"requestID":request_start,"action":"start","expectedRevision":m["revision"],
            "automaticStart":{"creationRequestID":request,"authorSessionID":author_sid,"expectedDocumentRevision":document["revision"]}});
        if attempt.scope.refresh(app).await.is_err()
            || !session(app, &attempt.scope, author_sid).await.is_ok_and(|fresh| fresh["location"] == author["location"])
            || lifetime.is_cancelled()
        {
            return Ok(uncertain());
        }
        match attempt.scope.call(app, "lifecycle", &play, 85, 4 * 1024 * 1024).await {
            Ok((status, body)) if status.is_success() => {
                let actual = &body["output"]["mission"];
                if actual["id"] == m["id"] && actual["projectID"] == m["projectID"]
                    && actual["document"]["firstPlay"]["requestID"] == request_start
                    && actual["document"]["firstPlay"]["admittedAt"].as_u64().is_some()
                {
                    return Ok(json!({"outcome":"activated","acknowledgement":"fresh","target":{"kind":"one-time","mission":actual}}));
                }
            }
            Ok((_, body)) if body["type"] == "mission.rejected"
                && matches!(body["data"]["code"].as_str(), Some("revision-conflict" | "control-conflict" | "prepare-refused")) => {
                return Ok(json!({"outcome":"refused","phase":"start","code":body["data"]["code"],"target":target}));
            }
            _ => {}
        }
        Ok(uncertain())
    }.await;
    app.mission_creations.finish(&key, &result);
    result.map_err(|e| match e.1.0["code"].as_str() {
        Some("creation-uncertain") => refusal(UNKNOWN),
        Some("request-conflict") => refusal("prepare-no-effect"),
        Some("compare-models-required" | "compare-models-identical") => (Status::CONFLICT, e.1),
        _ => refusal(REFUSED),
    })
}
