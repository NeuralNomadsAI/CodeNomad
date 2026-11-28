//! Programmed Missions ("calendars") routes and `mission.program` agent bridge.
//! Mirrors TS `server/routes/mission-calendars.ts` and `server/routes/mission-agent-program.ts`.
use super::{
    bridge,
    calendars_native::{
        CalendarView, NativeCalendars, NativeError, Unsupported, mission_calendar_automations, valid_calendar_id,
    },
    configuration,
    creation_admission::Scope,
    run,
    schedule_contract::{input_invalid, unavailable as schedule_unavailable},
};
use crate::{App, Error, Shared, opencode::Endpoint};
use axum::{
    Extension, Json,
    extract::{Path, RawQuery, State, rejection::JsonRejection},
    http::{Method, StatusCode as Status},
};
use serde_json::{Map, Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, Weak},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const FORBIDDEN_CONFIG_KEYS: [&str; 4] = ["roots", "profileID", "executionHost", "coordinatorSelectionAuthor"];

type TakenOverEntry = (Weak<Endpoint>, HashSet<(String, String)>);

/// Per native service connection, directories where no legacy recurring schedule remains.
#[derive(Default)]
pub struct TakenOver(Mutex<Vec<TakenOverEntry>>);

impl TakenOver {
    fn has(&self, endpoint: &Arc<Endpoint>, project: &str, dir: &str) -> bool {
        let mut entries = self.0.lock().unwrap();
        entries.retain(|(weak, _)| weak.strong_count() > 0);
        entries
            .iter()
            .find(|(weak, _)| weak.upgrade().is_some_and(|a| Arc::ptr_eq(&a, endpoint)))
            .is_some_and(|(_, dirs)| dirs.contains(&(project.to_owned(), dir.to_owned())))
    }

    fn mark(&self, endpoint: &Arc<Endpoint>, project: String, dir: String) {
        let mut entries = self.0.lock().unwrap();
        entries.retain(|(weak, _)| weak.strong_count() > 0);
        if let Some((_, dirs)) =
            entries.iter_mut().find(|(weak, _)| weak.upgrade().is_some_and(|a| Arc::ptr_eq(&a, endpoint)))
        {
            dirs.insert((project, dir));
        } else {
            let mut dirs = HashSet::new();
            dirs.insert((project, dir));
            entries.push((Arc::downgrade(endpoint), dirs));
        }
    }
}

enum Operation {
    List,
    Save { calendar: String, configuration: Value, paused: bool },
    Pause(String),
    Resume(String),
    Delete(String),
}

enum Refused {
    InputInvalid,
    Unsupported(Unsupported),
}

enum Outcome {
    Calendars(Vec<CalendarView>),
    Refused(Refused),
}

enum CalendarError {
    Missing,
    Mutation(Status),
    Unavailable,
}

impl From<NativeError> for CalendarError {
    fn from(value: NativeError) -> Self {
        match value {
            NativeError::Missing => Self::Missing,
            NativeError::Unavailable => Self::Unavailable,
        }
    }
}

fn valid_dir(s: &str) -> bool {
    let n = s.chars().count();
    (1..=4096).contains(&n) && !s.contains('\0')
}

fn parse_directory_query(raw: Option<&str>) -> Result<Option<String>, ()> {
    let q = super::recurrence::query(raw).ok_or(())?;
    if q.keys().any(|k| k != "directory") {
        return Err(());
    }
    match q.get("directory").and_then(Value::as_str) {
        None => Ok(None),
        Some(dir) if valid_dir(dir) => Ok(Some(dir.to_owned())),
        Some(_) => Err(()),
    }
}

/// Validates `missionCalendarConfigurationSchema` (or `scheduleToolConfiguration`
/// when `criteria_only` is true), returning the shape-normalized object without
/// server-owned fields.
fn parse_calendar_configuration(raw: &Value, criteria_only: bool) -> Result<Value, ()> {
    let obj = raw.as_object().ok_or(())?;
    if FORBIDDEN_CONFIG_KEYS.iter().any(|key| obj.contains_key(*key)) {
        return Err(());
    }
    if criteria_only {
        let launch = obj.get("launch").ok_or(())?;
        configuration::criteria_only(launch)?;
    }
    let mut probe = obj.clone();
    probe.insert("profileID".into(), Value::Null);
    probe.insert("executionHost".into(), Value::Null);
    probe.insert("roots".into(), json!([{"mode":"directory-only","directory":"/"}]));
    let mut shaped = configuration::shape(&Value::Object(probe))?;
    let shaped_obj = shaped.as_object_mut().ok_or(())?;
    for key in FORBIDDEN_CONFIG_KEYS {
        shaped_obj.remove(key);
    }
    Ok(shaped)
}

fn request_invalid() -> Error {
    (Status::BAD_REQUEST, Json(json!({ "error": "Invalid Mission calendar request", "code": "calendar-input-invalid" })))
}

fn calendar_error_response(err: CalendarError) -> Error {
    match err {
        CalendarError::Missing => {
            (Status::NOT_FOUND, Json(json!({ "error": "Mission calendar not found", "code": "calendar-missing" })))
        }
        CalendarError::Mutation(status) => {
            (status, Json(json!({ "error": "Mission calendars unavailable", "code": "calendar-unavailable" })))
        }
        CalendarError::Unavailable => (
            Status::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "Mission calendars unavailable", "code": "calendar-unavailable" })),
        ),
    }
}

fn outcome_response(outcome: Outcome) -> Result<Json<Value>, Error> {
    match outcome {
        Outcome::Calendars(calendars) => {
            Ok(Json(json!({ "calendars": calendars.iter().map(CalendarView::to_json).collect::<Vec<_>>() })))
        }
        Outcome::Refused(Refused::Unsupported(reason)) => Err((
            Status::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error": "Launch criteria a calendar cannot carry",
                "code": "calendar-unsupported",
                "reason": reason.as_str(),
            })),
        )),
        Outcome::Refused(Refused::InputInvalid) => Err((
            Status::BAD_REQUEST,
            Json(json!({ "error": "Invalid Mission calendar configuration", "code": "calendar-input-invalid" })),
        )),
    }
}

async fn rpc_mission(app: &App, scope: &Scope, mission_id: &str) -> Result<Option<Value>, CalendarError> {
    let (status, body) = scope
        .call(app, "mission", &json!({ "missionID": mission_id }), 15, 2 * 1024 * 1024)
        .await
        .map_err(|_| CalendarError::Unavailable)?;
    if !status.is_success() {
        return Err(CalendarError::Unavailable);
    }
    let mission = &body["output"]["mission"];
    Ok((!mission.is_null()).then(|| mission.clone()))
}

async fn prepare_mission(
    app: &Shared,
    scope: &Scope,
    config: &Value,
    request: &str,
    coordinator_session_id: Option<&str>,
    cancel: &CancellationToken,
) -> Result<String, CalendarError> {
    let short = &Uuid::new_v4().simple().to_string()[..8];
    let request_id = format!("calendar_{request}_{short}");
    run::prepare_for_calendar(app, scope, &request_id, config, coordinator_session_id, cancel)
        .await
        .map_err(|_| CalendarError::Unavailable)
}

struct SaveContext<'a> {
    app: &'a Shared,
    scope: &'a Scope,
    calendars: &'a NativeCalendars<'a>,
    cancel: &'a CancellationToken,
}

async fn save_calendar(
    ctx: &SaveContext<'_>,
    id: &str,
    configuration: &Value,
    paused: bool,
    restoring: bool,
) -> Result<Option<Refused>, CalendarError> {
    let (app, scope, calendars, cancel) = (ctx.app, ctx.scope, ctx.calendars, ctx.cancel);
    if cancel.is_cancelled() {
        return Err(CalendarError::Unavailable);
    }
    let profile_id = crate::settings::profile::scope(&app.settings.location.config)
        .map(|s| json!(s.key))
        .unwrap_or(Value::Null);
    let mut full = configuration.as_object().cloned().ok_or(CalendarError::Unavailable)?;
    full.insert("profileID".into(), profile_id);
    full.insert("executionHost".into(), json!("local"));
    full.insert("roots".into(), json!([{ "mode": "directory-only", "directory": scope.dir }]));
    let Ok(config) = configuration::normalize(&Value::Object(full)) else {
        return Ok(Some(Refused::InputInvalid));
    };
    if let Err(reason) = mission_calendar_automations(&config, id, None) {
        return Ok(Some(Refused::Unsupported(reason)));
    }
    let existing = calendars.list().await?.into_iter().find(|item| item.id == id);
    let current = match existing.and_then(|item| item.mission_id) {
        Some(mid) => rpc_mission(app, scope, &mid).await?,
        None => None,
    };
    let pristine = current.as_ref().is_some_and(|m| m["status"] == "active" && m["runState"] == "prepared");
    let mut prepared: Option<String> = None;
    if current.is_none() || pristine {
        if pristine {
            let cur = current.as_ref().unwrap();
            let short = &Uuid::new_v4().simple().to_string()[..8];
            let (status, _) = scope
                .call(
                    app,
                    "delete",
                    &json!({
                        "missionID": cur["id"],
                        "expectedRevision": cur["revision"],
                        "requestID": format!("calendar_edit_{short}"),
                        "deleteManagedSessions": false,
                    }),
                    30,
                    512 * 1024,
                )
                .await
                .map_err(|_| CalendarError::Unavailable)?;
            if !status.is_success() {
                return Err(CalendarError::Unavailable);
            }
        }
        let session = config["coordinatorSessionID"]
            .as_str()
            .or_else(|| if pristine { current.as_ref().and_then(|m| m["coordinatorSessionId"].as_str()) } else { None });
        let created = match prepare_mission(app, scope, &config, id, session, cancel).await {
            Ok(mid) => mid,
            Err(err) => {
                if !restoring || session.is_none() {
                    return Err(err);
                }
                prepare_mission(app, scope, &config, id, None, cancel).await?
            }
        };
        prepared = Some(created);
    }
    if cancel.is_cancelled() {
        return Err(CalendarError::Unavailable);
    }
    scope.refresh(app).await.map_err(|_| CalendarError::Mutation(Status::CONFLICT))?;
    let target_mid = prepared.as_deref().or_else(|| current.as_ref().and_then(|m| m["id"].as_str()));
    let automations =
        mission_calendar_automations(&config, id, target_mid).map_err(|_| CalendarError::Unavailable)?;
    calendars.save(id, &automations, paused).await?;
    Ok(None)
}

async fn take_over_legacy(ctx: &SaveContext<'_>, schedule: &Value) -> Result<(), CalendarError> {
    let (app, scope, calendars, cancel) = (ctx.app, ctx.scope, ctx.calendars, ctx.cancel);
    if schedule["busy"] == true {
        return Ok(());
    }
    let Some(id) = schedule["id"].as_str().filter(|s| valid_calendar_id(s)) else {
        return Ok(());
    };
    let running = schedule["running"] == true;
    let mut programmed = calendars.list().await?.iter().any(|item| item.id == id);
    if !programmed {
        let Some(stored) = schedule["configuration"].as_object() else {
            return Ok(());
        };
        let mut stripped = stored.clone();
        for key in FORBIDDEN_CONFIG_KEYS {
            stripped.remove(key);
        }
        let Ok(mut config) = parse_calendar_configuration(&Value::Object(stripped), false) else {
            return Ok(());
        };
        if let Some(sid) = config["coordinatorSessionID"].as_str().filter(|s| *s != "." && *s != "..").map(str::to_owned)
            && let Ok((status, body)) =
                scope.request(app, Method::GET, &format!("/api/session/{sid}"), &[], None, 10, 1024 * 1024).await
            && status == Status::NOT_FOUND
            && body["_tag"] == "SessionNotFoundError"
        {
            config.as_object_mut().unwrap().remove("coordinatorSessionID");
        }
        programmed = save_calendar(ctx, id, &config, true, false).await?.is_none();
        if !programmed {
            prepare_mission(app, scope, &config, id, None, cancel).await?;
        }
    }
    if let Some(automations) = schedule["automations"].as_array() {
        for automation_id in automations.iter().filter_map(Value::as_str) {
            calendars.delete_automation_best_effort(automation_id).await;
        }
    }
    let (status, _) = scope
        .call(app, "retireLegacySchedule", &json!({ "id": id }), 15, 65536)
        .await
        .map_err(|_| CalendarError::Unavailable)?;
    if !status.is_success() {
        return Err(CalendarError::Unavailable);
    }
    if programmed && running {
        calendars.resume(id).await?;
    }
    Ok(())
}

async fn run_operation(
    app: &Shared,
    workspace_id: &str,
    directory: Option<&str>,
    operation: Operation,
    cancel: &CancellationToken,
) -> Result<Outcome, CalendarError> {
    if cancel.is_cancelled() {
        return Err(CalendarError::Unavailable);
    }
    let workspace = app.workspace(workspace_id).map_err(|_| CalendarError::Mutation(Status::NOT_FOUND))?;
    let scope = Scope::open(app, workspace, directory)
        .await
        .map_err(|(status, _)| {
            CalendarError::Mutation(if status == Status::FORBIDDEN { Status::FORBIDDEN } else { Status::SERVICE_UNAVAILABLE })
        })?;
    let _permit = scope.permit().ok_or(CalendarError::Mutation(Status::CONFLICT))?;
    scope.refresh(app).await.map_err(|_| CalendarError::Mutation(Status::CONFLICT))?;
    let calendars = NativeCalendars::new(app, &scope);
    let ctx = SaveContext { app, scope: &scope, calendars: &calendars, cancel };

    // Take over legacy recurring schedules once per (connection, projectID, directory).
    if !app.calendar_taken_over.has(&scope.endpoint, &scope.project, &scope.dir) {
        let legacy = match scope.call(app, "legacySchedules", &json!({}), 15, 2 * 1024 * 1024).await {
            Ok((status, body)) if status.is_success() => body["output"]["schedules"].as_array().cloned(),
            _ => None,
        };
        if let Some(schedules) = legacy {
            for schedule in &schedules {
                let _ = take_over_legacy(&ctx, schedule).await;
            }
            if schedules.is_empty() {
                app.calendar_taken_over.mark(&scope.endpoint, scope.project.clone(), scope.dir.clone());
            }
        }
        scope.refresh(app).await.map_err(|_| CalendarError::Mutation(Status::CONFLICT))?;
    }

    // Restore paused programmed Missions whose prepared Mission disappeared.
    for calendar in calendars.list().await? {
        if !calendar.paused {
            continue;
        }
        if let Some(mid) = &calendar.mission_id
            && rpc_mission(app, &scope, mid).await?.is_some()
        {
            continue;
        }
        let mut stored = calendar.mission.clone();
        stored.remove("when");
        stored.insert("watchedConversationIDs".into(), json!([]));
        if let Some(launch) = &calendar.launch {
            stored.insert("launch".into(), launch.clone());
        }
        if let Ok(config) = parse_calendar_configuration(&Value::Object(stored), false) {
            let _ = save_calendar(&ctx, &calendar.id, &config, true, true).await;
        }
    }

    match operation {
        Operation::List => {}
        Operation::Save { calendar, configuration, paused } => {
            if let Some(refused) = save_calendar(&ctx, &calendar, &configuration, paused, false).await? {
                return Ok(Outcome::Refused(refused));
            }
        }
        Operation::Pause(calendar) => calendars.pause(&calendar).await?,
        Operation::Resume(calendar) => calendars.resume(&calendar).await?,
        Operation::Delete(calendar) => calendars.delete(&calendar).await?,
    }
    scope.refresh(app).await.map_err(|_| CalendarError::Mutation(Status::CONFLICT))?;
    Ok(Outcome::Calendars(calendars.list().await?))
}

// ---- HTTP handlers ----

pub async fn list(
    State(app): State<Shared>,
    Path(id): Path<String>,
    RawQuery(raw_query): RawQuery,
    Extension(p): Extension<crate::auth::Principal>,
) -> Result<Json<Value>, Error> {
    if !(1..=200).contains(&id.chars().count()) {
        return Err(request_invalid());
    }
    let directory = parse_directory_query(raw_query.as_deref()).map_err(|()| request_invalid())?;
    let outcome = run_operation(&app, &id, directory.as_deref(), Operation::List, &p.0)
        .await
        .map_err(calendar_error_response)?;
    outcome_response(outcome)
}

pub async fn save(
    State(app): State<Shared>,
    Path((id, calendar)): Path<(String, String)>,
    RawQuery(raw_query): RawQuery,
    Extension(p): Extension<crate::auth::Principal>,
    body: Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>, Error> {
    if !(1..=200).contains(&id.chars().count()) || !valid_calendar_id(&calendar) {
        return Err(request_invalid());
    }
    let query_dir = parse_directory_query(raw_query.as_deref()).map_err(|()| request_invalid())?;
    let Json(raw) = body.map_err(|_| request_invalid())?;
    let obj = raw.as_object().ok_or_else(request_invalid)?;
    if obj.keys().any(|k| !matches!(k.as_str(), "configuration" | "directory" | "paused"))
        || obj.values().any(Value::is_null)
    {
        return Err(request_invalid());
    }
    let body_dir = match obj.get("directory") {
        None => None,
        Some(v) => Some(v.as_str().filter(|s| valid_dir(s)).ok_or_else(request_invalid)?.to_owned()),
    };
    let paused = match obj.get("paused") {
        None => false,
        Some(v) => v.as_bool().ok_or_else(request_invalid)?,
    };
    let config_raw = obj.get("configuration").ok_or_else(request_invalid)?;
    let configuration = parse_calendar_configuration(config_raw, false).map_err(|()| request_invalid())?;
    let directory = body_dir.or(query_dir);
    let outcome = run_operation(
        &app,
        &id,
        directory.as_deref(),
        Operation::Save { calendar, configuration, paused },
        &p.0,
    )
    .await
    .map_err(calendar_error_response)?;
    outcome_response(outcome)
}

pub async fn action(
    State(app): State<Shared>,
    Path((id, calendar, action)): Path<(String, String, String)>,
    RawQuery(raw_query): RawQuery,
    Extension(p): Extension<crate::auth::Principal>,
) -> Result<Json<Value>, Error> {
    if !(1..=200).contains(&id.chars().count()) || !valid_calendar_id(&calendar) {
        return Err(request_invalid());
    }
    let op = match action.as_str() {
        "pause" => Operation::Pause(calendar),
        "resume" => Operation::Resume(calendar),
        _ => return Err(request_invalid()),
    };
    let directory = parse_directory_query(raw_query.as_deref()).map_err(|()| request_invalid())?;
    let outcome = run_operation(&app, &id, directory.as_deref(), op, &p.0)
        .await
        .map_err(calendar_error_response)?;
    outcome_response(outcome)
}

pub async fn delete(
    State(app): State<Shared>,
    Path((id, calendar)): Path<(String, String)>,
    RawQuery(raw_query): RawQuery,
    Extension(p): Extension<crate::auth::Principal>,
) -> Result<Json<Value>, Error> {
    if !(1..=200).contains(&id.chars().count()) || !valid_calendar_id(&calendar) {
        return Err(request_invalid());
    }
    let directory = parse_directory_query(raw_query.as_deref()).map_err(|()| request_invalid())?;
    let outcome = run_operation(&app, &id, directory.as_deref(), Operation::Delete(calendar), &p.0)
        .await
        .map_err(calendar_error_response)?;
    outcome_response(outcome)
}

// ---- Agent bridge (`mission.program`) ----

fn parse_program_input(raw: &Value) -> Result<Operation, ()> {
    let obj = raw.as_object().ok_or(())?;
    if obj.keys().any(|k| !matches!(k.as_str(), "action" | "id" | "configuration" | "paused"))
        || obj.values().any(Value::is_null)
    {
        return Err(());
    }
    let action = obj.get("action").and_then(Value::as_str).ok_or(())?;
    if !matches!(action, "list" | "save" | "pause" | "resume" | "delete") {
        return Err(());
    }
    let id = match obj.get("id") {
        None => None,
        Some(v) => Some(v.as_str().filter(|s| valid_calendar_id(s)).ok_or(())?.to_owned()),
    };
    let configuration = match obj.get("configuration") {
        None => None,
        Some(v) => Some(parse_calendar_configuration(v, true)?),
    };
    let paused = match obj.get("paused") {
        None => None,
        Some(v) => Some(v.as_bool().ok_or(())?),
    };
    if (action == "list") != id.is_none()
        || (action == "save") != configuration.is_some()
        || (paused.is_some() && action != "save")
    {
        return Err(());
    }
    Ok(match action {
        "list" => Operation::List,
        "save" => Operation::Save {
            calendar: id.unwrap(),
            configuration: configuration.unwrap(),
            paused: paused.unwrap_or(false),
        },
        "pause" => Operation::Pause(id.unwrap()),
        "resume" => Operation::Resume(id.unwrap()),
        "delete" => Operation::Delete(id.unwrap()),
        _ => return Err(()),
    })
}

fn agent_program_view(calendar: &CalendarView) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(calendar.id));
    out.insert("title".into(), json!(calendar.title));
    out.insert("paused".into(), json!(calendar.paused));
    if let Some(mid) = &calendar.mission_id {
        out.insert("missionID".into(), json!(mid));
    }
    if let Some(launch) = &calendar.launch {
        out.insert("launch".into(), launch.clone());
    }
    if !calendar.paused {
        let mut best: Option<(f64, Value)> = None;
        for rule in &calendar.rules {
            if let Some(due_val) = rule.get("nextDueAt")
                && let Some(due_num) = due_val.as_f64().filter(|n| n.is_finite())
                && best.as_ref().is_none_or(|(cur, _)| due_num < *cur)
            {
                best = Some((due_num, due_val.clone()));
            }
        }
        if let Some((_, min_due)) = best {
            out.insert("nextDueAt".into(), min_due);
        }
    }
    if let Some(last) = &calendar.last {
        let mut summary = Map::new();
        summary.insert("at".into(), last.at.clone());
        summary.insert("outcome".into(), json!(last.outcome));
        summary.insert("launches".into(), json!(last.launches));
        if let Some(status) = &last.status {
            summary.insert("status".into(), json!(status));
        }
        out.insert("last".into(), Value::Object(summary));
    }
    Value::Object(out)
}

pub(super) async fn agent_program(app: Shared, scope: Scope, row: Value, raw: &Value) -> Result<Value, Error> {
    let op = parse_program_input(raw).map_err(|()| input_invalid())?;
    bridge::current_agent(&app, &scope, &row).await?;
    let cancel = CancellationToken::new();
    let _disconnect = cancel.clone().drop_guard();
    let wid = scope.workspace.id.to_string();
    let outcome = match run_operation(&app, &wid, Some(&scope.dir), op, &cancel).await {
        Ok(outcome) => outcome,
        Err(CalendarError::Missing) => return Ok(json!({ "refused": "calendar-missing" })),
        Err(CalendarError::Mutation(_)) => return Ok(json!({ "refused": "calendar-unavailable" })),
        Err(CalendarError::Unavailable) => return Err(schedule_unavailable()),
    };
    scope.refresh(&app).await.map_err(|_| schedule_unavailable())?;
    bridge::current_agent(&app, &scope, &row).await?;
    Ok(match outcome {
        Outcome::Refused(Refused::InputInvalid) => json!({ "refused": "calendar-input-invalid" }),
        Outcome::Refused(Refused::Unsupported(reason)) => {
            json!({ "refused": "calendar-unsupported", "reason": reason.as_str() })
        }
        Outcome::Calendars(calendars) => {
            json!({ "programs": calendars.iter().map(agent_program_view).collect::<Vec<_>>() })
        }
    })
}
