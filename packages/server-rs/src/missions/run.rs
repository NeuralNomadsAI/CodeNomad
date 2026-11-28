use super::{
    configuration,
    creation_admission::{self, Attempt, Scope},
};
use crate::shared::js_trim;
use crate::{App, Error, Shared, Workspace, error, files, worktrees::linked};
use axum::{
    Extension, Json,
    extract::{Path, RawQuery, State},
    http::{Method, StatusCode as Status},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, LazyLock};
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;

const NATIVE_PLAYBOOKS: &str = include_str!("../../contracts/mission-playbooks-native.json");
const INDEPENDENT_PLAYBOOKS: &str = include_str!("playbooks_independent.json");

pub(super) fn playbook_details(task_mode: &str) -> &'static Value {
    static NATIVE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(NATIVE_PLAYBOOKS).expect("bundled native playbooks"));
    static INDEPENDENT: LazyLock<Value> =
        LazyLock::new(|| serde_json::from_str(INDEPENDENT_PLAYBOOKS).expect("bundled independent playbooks"));
    if task_mode == "independent" { &INDEPENDENT } else { &NATIVE }
}

pub async fn playbooks(RawQuery(raw): RawQuery) -> Result<Response, Error> {
    let invalid = || error(Status::BAD_REQUEST, "Invalid playbook request");
    let query = super::recurrence::query(raw.as_deref()).ok_or_else(invalid)?;
    if query.keys().any(|k| k != "taskMode") {
        return Err(invalid());
    }
    let body = match query.get("taskMode").and_then(Value::as_str) {
        None | Some("native") => NATIVE_PLAYBOOKS,
        Some("independent") => INDEPENDENT_PLAYBOOKS,
        Some(_) => return Err(invalid()),
    };
    Ok(([(axum::http::header::CONTENT_TYPE, "application/json")], body).into_response())
}
pub(super) fn bad() -> Error {
    error(Status::BAD_REQUEST, "Invalid one-time Mission request")
}
pub(super) fn foreign() -> Error {
    error(Status::FORBIDDEN, "Mission does not belong to an open authorized root")
}
pub(super) fn held() -> Error {
    error(Status::SERVICE_UNAVAILABLE, "Mission outcome unavailable; reconcile the same request")
}
pub(super) fn id(s: &str, n: usize) -> bool {
    s.len() <= n && crate::opencode::valid_id(s)
}
pub(super) fn text(s: &str, n: usize) -> bool {
    !s.trim().is_empty() && s.encode_utf16().count() <= n && !s.contains('\0')
}
pub(super) fn token(s: &str, n: usize) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))[..n].into()
}
pub fn directory(w: &Workspace) -> Result<&str, Error> {
    w.location["directory"].as_str().ok_or_else(foreign)
}

pub async fn project_owner(app: &App, w: &Workspace) -> Result<(String, String), Error> {
    files::root(w)?;
    let dir = directory(w)?;
    let here =
        linked::native(app, Method::GET, "/api/location", &[("location[directory]", dir)], None, 128 * 1024).await?;
    let current = |value: &Value| value.as_str().and_then(|p| dunce::canonicalize(p).ok()).as_ref() == Some(&w.path);
    if !current(&here["directory"])
        || !current(&here["project"]["directory"])
        || !current(&here["project"]["canonical"])
    {
        return Err(foreign());
    }
    let id = here["project"]["id"]
        .as_str()
        .filter(|v| *v != "global" && id(v, 240))
        .map(str::to_owned)
        .ok_or_else(foreign)?;
    let canonical = here["project"]["canonical"].as_str().ok_or_else(foreign)?;
    Ok((id, canonical.to_owned()))
}
pub(super) fn ordinary(m: &Value) -> bool {
    let doc = &m["document"];
    let launch = &doc["launch"];
    m["template"].as_str().is_some_and(|t| configuration::TEMPLATES.contains(&t))
        && m["taskMode"].as_str().is_none_or(|v| v == "native" || v == "independent")
        && (doc.is_null()
            || doc["scheduleActivation"].is_null()
                && if let Some(when) = launch["when"].as_array() {
                    when.is_empty() || when.len() == 1 && when[0]["kind"] == "now"
                } else {
                    launch["timing"]["kind"] == "immediate"
                        && launch["condition"].is_null()
                        && launch["ends"].as_object().is_some_and(|e| e.values().all(Value::is_null))
                })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    request_id: String,
    objective: String,
    title: Option<String>,
    notes: Option<String>,
    template: String,
    directory: Option<String>,
    coordinator_session_id: Option<String>,
    profiles: Option<Value>,
    task_mode: Option<String>,
    #[serde(rename = "watchedConversationIDs")]
    watched_conversation_ids: Option<Vec<String>>,
}
pub async fn create(
    State(app): State<Shared>,
    Path(wid): Path<String>,
    Extension(p): Extension<crate::auth::Principal>,
    Json(raw): Json<Value>,
) -> Result<(Status, Json<Value>), Error> {
    let request = raw["requestId"]
        .as_str()
        .map(js_trim)
        .filter(|s| valid_text(s, 1, 128))
        .ok_or_else(creation_admission::invalid)?;
    app.mission_creations.register(&wid, request, &raw)?;
    let key = (wid, request.to_owned());
    let lifetime = p.0.child_token();
    let _disconnect = lifetime.clone().drop_guard();
    // Losing the HTTP client must not drop the permit or cancel an already dispatched create.
    let result = tokio::spawn(async move {
        let result = create_once(&app, &key, lifetime, raw).await;
        app.mission_creations.finish(&key, &result);
        result
    })
    .await
    .map_err(|_| creation_admission::uncertain())??;
    Ok((Status::OK, Json(result)))
}

async fn create_once(
    app: &App,
    key: &(String, String),
    lifetime: CancellationToken,
    raw: Value,
) -> Result<Value, Error> {
    let invalid = creation_admission::invalid;
    let unavailable = creation_admission::unavailable;
    if app.mission_bridge.is_none() {
        return Err(unavailable());
    }
    if raw.as_object().is_none_or(|o| o.values().any(Value::is_null)) {
        return Err(invalid());
    }
    let q: Create = serde_json::from_value(raw).map_err(|_| invalid())?;
    let options = creation_admission::options(
        q.task_mode.as_deref(),
        q.watched_conversation_ids,
        q.coordinator_session_id.as_deref(),
    )?;
    let requested = q.directory.as_deref().map(js_trim);
    if !configuration::TEMPLATES.contains(&q.template.as_str())
        || !valid_text(js_trim(&q.objective), 1, 20_000)
        || q.title.as_deref().map(js_trim).is_some_and(|s| !valid_text(s, 1, 60) || s.contains(['\r', '\n']))
        || q.notes.as_deref().is_some_and(|s| !valid_text(s, 0, 20_000))
        || requested.is_some_and(|s| !valid_text(s, 1, 4096))
    {
        return Err(invalid());
    }
    let profiles = creation_profiles(&q.template, q.profiles)?;
    let workspace = app.workspace(&key.0).map_err(|_| error(Status::NOT_FOUND, "Workspace unavailable"))?;
    let mut scope = Scope::open(app, workspace, requested).await?;
    let mut input = json!({"requestID":js_trim(&q.request_id),"objective":js_trim(&q.objective),"template":q.template,"taskMode":options.task_mode,"prepared":true,
        "expectedCoordinatorLocation":{"directory":scope.dir}});
    if let Some(watched) = options.watched {
        input["watchedConversationIDs"] = json!(watched);
    }
    if let Some(title) = q.title {
        input["title"] = json!(js_trim(&title));
    }
    if let Some(notes) = q.notes {
        input["notes"] = json!(notes);
    }
    if let Some(profiles) = profiles {
        input["profiles"] = profiles;
    }
    if lifetime.is_cancelled() {
        return Err(unavailable());
    }
    let (status, caps) = scope.call(app, "documentCapabilities", &json!({}), 10, 65536).await?;
    if !status.is_success() || !document_capabilities(&caps["output"]) {
        return Err(creation_unavailable("Unified Mission documents unavailable"));
    }
    // Reference order: the coordinator is read after the capability check.
    if let Some(session) = &options.coordinator {
        input["coordinatorSessionID"] = json!(session);
        input["expectedCoordinatorLocation"] = scope.attach(app, session).await?;
    } else if let Some(block) = crate::sessions::permission_mode::new_root(
        app,
        &scope.endpoint,
        &scope.dir,
        caps["output"]["rootPermissions"] == true,
    )
    .await
    .map_err(|_| creation_unavailable("Mission root permissions unavailable"))?
    {
        input["permissions"] = block;
    }
    let permit = scope.permit().ok_or_else(|| {
        (
            Status::CONFLICT,
            Json(json!({"error":"Worktree deletion is in progress","code":"creation-worktree-deleting"})),
        )
    })?;
    scope.refresh(app).await?;
    if lifetime.is_cancelled() {
        return Err(unavailable());
    }
    let mission = format!("msn_{}", token(&format!("{}\0{}", scope.project, key.1), 24));
    let attempt = Arc::new(Attempt { scope, input, mission });
    app.mission_creations.dispatched(key, attempt.clone(), permit)?;
    let result = attempt.create(app).await?;
    if !attempt.acknowledgement(&result) || attempt.scope.refresh(app).await.is_err() {
        return Err(creation_admission::uncertain());
    }
    if result["acknowledgement"] == "fresh" {
        attempt.confirm_permissions(app, &result["mission"], false).await?;
    }
    Ok(result)
}

fn valid_text(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.chars().count())
}

fn creation_unavailable(message: &str) -> Error {
    (Status::SERVICE_UNAVAILABLE, Json(json!({"error":message,"code":"creation-unavailable"})))
}

pub(super) fn document_capabilities(value: &Value) -> bool {
    value["version"] == 1
        && value.as_object().is_some_and(|o| {
            o.iter().all(|(k, v)| {
                k == "version"
                    || (matches!(
                        k.as_str(),
                        "automaticStart" | "agentSchedulePreparation" | "agentScheduleControl" | "rootPermissions"
                    ) && v == true)
            })
        })
}

pub(super) fn creation_profiles(template: &str, profiles: Option<Value>) -> Result<Option<Value>, Error> {
    let mut profiles =
        profiles.map(|p| configuration::profiles(&p)).transpose().map_err(|_| creation_admission::invalid())?;
    if template == "compare" {
        let roles = profiles.as_ref().and_then(|p| p.get("roles")).unwrap_or(&Value::Null);
        let (a, b) = (&roles["model-a"]["model"], &roles["model-b"]["model"]);
        let reason = if a.is_null() || b.is_null() {
            Some("compare-models-required")
        } else if a["providerID"] == b["providerID"] && a["id"] == b["id"] {
            Some("compare-models-identical")
        } else {
            None
        };
        if let Some(code) = reason {
            return Err((Status::BAD_REQUEST, Json(json!({"error":code,"code":code}))));
        }
        let profiles = profiles.as_mut().unwrap();
        if profiles["roles"]["comparator"]["model"].is_null() && !profiles["coordinator"]["model"].is_null() {
            let model = profiles["coordinator"]["model"].clone();
            profiles["roles"]["comparator"]["model"] = model;
        }
    }
    if profiles.as_ref().is_some_and(|p| !configuration::valid_profile_roles(template, p)) {
        return Err(creation_admission::invalid());
    }
    Ok(profiles)
}

pub async fn creation_receipt(
    State(app): State<Shared>,
    Path((wid, request)): Path<(String, String)>,
) -> Result<Json<Value>, Error> {
    if !valid_text(&request, 1, 128) {
        return Err(error(Status::BAD_REQUEST, "Invalid creation receipt request"));
    }
    app.workspace(&wid).map_err(|_| error(Status::NOT_FOUND, "Workspace unavailable"))?;
    Ok(Json(app.mission_creations.receipt(&app, &(wid, request)).await))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Control {
    request_id: String,
    action: String,
    expected_revision: u64,
    graceful: Option<bool>,
}
pub async fn control(
    State(app): State<Shared>,
    Path((wid, mid)): Path<(String, String)>,
    Extension(p): Extension<crate::auth::Principal>,
    Json(raw): Json<Value>,
) -> Result<Json<Value>, Error> {
    let invalid = "Invalid mission control request";
    let q: Control = mutation_body(raw, invalid)?;
    let (mid, request) = mutation_ids(&mid, &q.request_id, q.expected_revision, invalid)?;
    if !matches!(q.action.as_str(), "start" | "pause" | "stop") || q.graceful.is_some_and(|v| !v || q.action != "pause")
    {
        return Err(error(Status::BAD_REQUEST, invalid));
    }
    let mut input =
        json!({"missionID":mid,"action":q.action,"requestID":request,"expectedRevision":q.expected_revision});
    if q.graceful == Some(true) {
        input["graceful"] = json!(true);
    }
    mutate(app, wid, p, "lifecycle", input).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Recover {
    expected_revision: u64,
    target: RecoveryTarget,
    task_key: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum RecoveryTarget {
    Coordinator,
    Report,
}

pub async fn recover(
    State(app): State<Shared>,
    Path((wid, mid)): Path<(String, String)>,
    Extension(p): Extension<crate::auth::Principal>,
    Json(raw): Json<Value>,
) -> Result<Json<Value>, Error> {
    let invalid = "Invalid mission recovery request";
    let q: Recover = mutation_body(raw, invalid)?;
    let (mid, _) = mutation_ids(&mid, "recover", q.expected_revision, invalid)?;
    if !valid_text(js_trim(&wid), 1, 200) || q.task_key.as_deref().is_some_and(|k| !valid_text(k, 1, 100)) {
        return Err(error(Status::BAD_REQUEST, invalid));
    }
    let target = match q.target {
        RecoveryTarget::Coordinator => "coordinator",
        RecoveryTarget::Report => "report",
    };
    let mut input = json!({"missionID":mid,"expectedRevision":q.expected_revision,"target":target});
    if let Some(key) = q.task_key {
        input["taskKey"] = json!(key);
    }
    mutate(app, js_trim(&wid).into(), p, "recover", input).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    request_id: String,
    expected_revision: u64,
    objective: String,
    notes: Option<String>,
}

pub async fn update(
    State(app): State<Shared>,
    Path((wid, mid)): Path<(String, String)>,
    Extension(p): Extension<crate::auth::Principal>,
    Json(raw): Json<Value>,
) -> Result<Json<Value>, Error> {
    let invalid = "Invalid mission update request";
    let q: Update = mutation_body(raw, invalid)?;
    let (mid, request) = mutation_ids(&mid, &q.request_id, q.expected_revision, invalid)?;
    let objective = js_trim(&q.objective);
    if !valid_text(objective, 1, 20_000) || q.notes.as_deref().is_some_and(|n| !valid_text(n, 0, 20_000)) {
        return Err(error(Status::BAD_REQUEST, invalid));
    }
    let mut input =
        json!({"missionID":mid,"objective":objective,"requestID":request,"expectedRevision":q.expected_revision});
    if let Some(notes) = q.notes {
        input["notes"] = json!(notes);
    }
    mutate(app, wid, p, "update", input).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Delete {
    request_id: String,
    expected_revision: u64,
    delete_managed_sessions: Option<bool>,
}

pub async fn delete(
    State(app): State<Shared>,
    Path((wid, mid)): Path<(String, String)>,
    Extension(p): Extension<crate::auth::Principal>,
    Json(raw): Json<Value>,
) -> Result<Json<Value>, Error> {
    let invalid = "Invalid mission deletion request";
    let q: Delete = mutation_body(raw, invalid)?;
    let (mid, request) = mutation_ids(&mid, &q.request_id, q.expected_revision, invalid)?;
    let mut input = json!({"missionID":mid,"requestID":request,"expectedRevision":q.expected_revision});
    if let Some(delete) = q.delete_managed_sessions {
        input["deleteManagedSessions"] = json!(delete);
    }
    mutate(app, wid, p, "delete", input).await
}

fn mutation_body<T: serde::de::DeserializeOwned>(raw: Value, invalid: &str) -> Result<T, Error> {
    if raw.as_object().is_none_or(|o| o.values().any(Value::is_null)) {
        return Err(error(Status::BAD_REQUEST, invalid));
    }
    serde_json::from_value(raw).map_err(|_| error(Status::BAD_REQUEST, invalid))
}

fn mutation_ids<'a>(mid: &'a str, request: &'a str, revision: u64, invalid: &str) -> Result<(&'a str, &'a str), Error> {
    let (mid, request) = (js_trim(mid), js_trim(request));
    if !valid_text(mid, 1, 100) || !valid_text(request, 1, 128) || !(1..=9_007_199_254_740_991).contains(&revision) {
        return Err(error(Status::BAD_REQUEST, invalid));
    }
    Ok((mid, request))
}

fn plugin_unavailable() -> Error {
    error(Status::SERVICE_UNAVAILABLE, "Mission plugin unavailable")
}

async fn mutate(
    app: Shared,
    wid: String,
    p: crate::auth::Principal,
    method: &'static str,
    input: Value,
) -> Result<Json<Value>, Error> {
    if app.mission_bridge.is_none() {
        return Err(plugin_unavailable());
    }
    let lifetime = p.0.child_token();
    let _disconnect = lifetime.clone().drop_guard();
    tokio::spawn(async move {
        let _slot = app.mission_control_slot.acquire().await.map_err(|_| plugin_unavailable())?;
        p.live()?;
        let workspace = app.workspace(&wid).map_err(|_| error(Status::NOT_FOUND, "Workspace unavailable"))?;
        let scope = Scope::open(&app, workspace, None)
            .await
            .map_err(|e| if e.0 == Status::FORBIDDEN { e } else { plugin_unavailable() })?;
        let _permit = scope.permit().ok_or_else(|| error(Status::CONFLICT, "Worktree deletion is in progress"))?;
        p.live()?;
        if scope.refresh(&app).await.is_err() {
            return Err(error(Status::CONFLICT, "Mission workspace changed"));
        }
        p.live()?;
        if lifetime.is_cancelled() {
            return Err(plugin_unavailable());
        }
        let (status, body) =
            scope.call(&app, method, &input, 85, 4 * 1024 * 1024).await.map_err(|_| plugin_unavailable())?;
        if !status.is_success() {
            return Err(creation_admission::rejection(&body).unwrap_or_else(plugin_unavailable));
        }
        let result = &body["output"];
        if !scope.current(&app)
            || match method {
                "delete" => result["deleted"] != true,
                _ => {
                    result["mission"]["id"] != input["missionID"]
                        || result["mission"]["projectID"] != scope.project
                        || (method == "recover" && result["admitted"] != true)
                }
            }
        {
            return Err(plugin_unavailable());
        }
        Ok(Json(result.clone()))
    })
    .await
    .map_err(|_| plugin_unavailable())?
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bridge {
    mode: String,
    #[serde(rename = "sessionID")]
    session_id: String,
    purpose: Option<String>,
    command: Option<Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Command {
    kind: String,
    input: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Life {
    #[serde(rename = "missionID")]
    mid: String,
    #[serde(rename = "operationID")]
    operation: String,
    #[serde(rename = "sessionID")]
    sid: String,
    #[serde(rename = "startText")]
    start_text: Option<String>,
}

pub async fn dispatch(State(app): State<Shared>, request: axum::extract::Request) -> Result<Json<Value>, Error> {
    let Some(secret) = app.mission_bridge.as_ref() else {
        return Err(foreign());
    };
    let headers = request.headers();
    let got = headers.get("x-codenomad-automation-token").map(|v| v.as_bytes()).unwrap_or_default();
    if got.len() != secret.len()
        || !bool::from(secret.as_bytes().ct_eq(got))
        || headers.keys().any(|k| {
            matches!(k.as_str(), "origin" | "referer" | "cookie" | "forwarded" | "x-forwarded-for")
                || k.as_str().starts_with("sec-")
        })
    {
        return Err(error(Status::UNAUTHORIZED, "Unauthorized Mission bridge"));
    }
    if headers.get(axum::http::header::CONTENT_TYPE).and_then(|h| h.to_str().ok()) != Some("application/json") {
        return Err(bad());
    }
    let data = axum::body::to_bytes(request.into_body(), 512 * 1024)
        .await
        .map_err(|_| error(Status::PAYLOAD_TOO_LARGE, "Mission bridge payload too large"))?;
    let req: Bridge = serde_json::from_slice(&data).map_err(|_| bad())?;
    if req.mode == "recurrence-control-verify" {
        return crate::missions::calendar::verify(&app, &req.session_id, req.command.ok_or_else(bad)?).await;
    }
    if req.mode.starts_with("memory-") && req.purpose.is_none() {
        return crate::memory::bridge(&app, &req.mode, &req.session_id, req.command).await;
    }
    if !id(&req.session_id, 240) {
        return Err(bad());
    }
    let (scope, co) = super::bridge::owner(&app, &req.session_id).await?;
    if req.mode == "browser-claim"
        && matches!(req.purpose.as_deref(), Some("mission" | "mission-preferences" | "mission-prepare"))
        && req.command.is_none()
    {
        let preference = req.purpose.as_deref() != Some("mission");
        return Ok(Json(if preference {
            json!({"result":{"available":true,"missionCreationDefaults":true,"missionPreparationStart":true}})
        } else {
            json!({"result":{"available":true}})
        }));
    }
    let command: Command = serde_json::from_value(req.command.ok_or_else(bad)?).map_err(|_| bad())?;
    if req.mode != "mission-input" || req.purpose.is_some() {
        return Err(bad());
    }
    let result = match command.kind.as_str() {
        "profile-defaults" => super::prepare::defaults(&app, command.input),
        "configurations" => super::agent_settings::configurations(&app, command.input),
        "settings" => super::agent_settings::settings(&app, scope, co, command.input).await,
        "prepare" => {
            let lifetime = CancellationToken::new();
            let _disconnect = lifetime.clone().drop_guard();
            let app = app.clone();
            tokio::spawn(async move { super::prepare::prepare(&app, scope, co, command.input, lifetime).await })
                .await
                .map_err(|_| held())?
        }
        "create-root" => super::inputs::create_root(&app, scope, co, command.input).await,
        "cleanup" => super::cleanup::remove(&app, scope, co, command.input).await,
        "task-sessions" => super::task_sessions::observe(&app, scope, co, command.input).await,
        "interrupt" => super::task_sessions::interrupt(&app, scope, co, command.input).await,
        "project-read" => super::agent_read::read(&app, scope, co, command.input).await,
        "project-control" => super::agent_control::control(&app, scope, co, command.input).await,
        "project-control-verify" | "project-update" => {
            super::agent_control::verify(&app, scope, co, &command.kind, command.input).await
        }
        "schedule" => super::calendar::agent_command(app.clone(), scope, co, command.input).await,
        "prompt" | "synthetic" => super::inputs::admit(&app, scope, co, &command.kind, command.input).await,
        "lifecycle" => lifecycle(&app, scope, co, command.input).await,
        _ => Err(error(Status::NOT_IMPLEMENTED, "Mission bridge operation unavailable")),
    };
    let result = result?;
    Ok(Json(json!({"result":result})))
}

async fn lifecycle(app: &Shared, mut scope: Scope, co: Value, input: Value) -> Result<Value, Error> {
    use super::bridge::{self, current_root, dir, find, recorded, session, snapshot};
    let life: Life = serde_json::from_value(input).map_err(|_| bad())?;
    if !id(&life.mid, 100)
        || !id(&life.operation, 100)
        || !id(&life.sid, 240)
        || life.start_text.as_deref().is_some_and(|t| !text(t, 250_000))
    {
        return Err(bad());
    }
    let s = snapshot(app, &scope).await?;
    let m = bridge::mission(&s, &life.mid, &co)?;
    let op = &m["control"];
    let action = op["action"].as_str().ok_or_else(held)?;
    let is_coordinator = co["id"] == life.sid;
    let location = &find(op, "targets", "sessionID", &life.sid).ok_or_else(foreign)?["location"];
    if location.get("workspaceID").is_some()
        || !find(m, "actors", "sessionId", &life.sid).is_some_and(|a| a["location"] == *location)
    {
        return Err(foreign());
    }
    scope.add_location(app, location["directory"].as_str().ok_or_else(foreign)?).await?;
    let _permit = scope.permit().ok_or_else(held)?;
    let shared = |s: &Value| {
        s["missions"].as_array().is_some_and(|missions| {
            missions.iter().any(|other| {
                other["id"] != life.mid
                    && other["status"] == "active"
                    && find(other, "actors", "sessionId", &life.sid).is_some()
            })
        })
    };
    let authority = || async {
        scope.refresh(app).await?;
        let co = current_root(app, &scope, &co).await?;
        let latest = snapshot(app, &scope).await?;
        let fresh = bridge::mission(&latest, &life.mid, &co)?;
        let next = &fresh["control"];
        if next["id"] != life.operation
            || ["action", "requestID", "expectedRevision", "targets"].iter().any(|k| next[*k] != op[*k])
            || !next["pending"].as_array().is_some_and(|p| p.iter().any(|id| id == &life.sid))
            || fresh["runState"] != m["runState"]
            || fresh["status"] != m["status"]
            || fresh["document"]["firstPlay"] != m["document"]["firstPlay"]
            || !find(fresh, "actors", "sessionId", &life.sid).is_some_and(|a| a["location"] == *location)
        {
            return Err(held());
        }
        Ok(shared(&latest))
    };
    let mut ack = json!({"missionID":life.mid,"operationID":life.operation,"sessionID":life.sid,"action":action});
    let can_start = action == "start" && m["runState"] == "running" && m["status"] == "active";
    let can_interrupt = matches!(action, "pause" | "stop")
        && life.start_text.is_none()
        && m["runState"] == if action == "pause" { "paused" } else { "stopped" }
        && (action == "stop" || m["status"] == "active");
    if !can_start && !can_interrupt {
        return Err(foreign());
    }
    if authority().await? {
        if action != "stop" {
            return Err(foreign());
        }
        ack["disposition"] = json!("target-reused");
        return Ok(json!({"nativeAcknowledgement":ack}));
    }
    let row = match session(app, &scope, &life.sid).await {
        Ok(row) => row,
        Err(e) if can_interrupt && e.0 == Status::NOT_FOUND => {
            authority().await?;
            ack["disposition"] = json!("target-missing");
            return Ok(json!({"nativeAcknowledgement":ack}));
        }
        Err(e) => return Err(e),
    };
    let verify_target = |row: &Value| {
        row["parentID"].is_null()
            && recorded(m, row)
            && row["location"] == *location
            && (!can_start
                || !m["tasks"].as_array().is_some_and(|tasks| {
                    tasks.iter().any(|t| {
                        t["actorSessionId"] == life.sid
                            && t["status"] != "withdrawn"
                            && t["report"].is_null()
                            && !bridge::matches_execution(&t["execution"], row)
                    })
                }))
    };
    if !verify_target(&row) || dir(&row)? != location["directory"] {
        return Err(foreign());
    }
    let checkpoint = || async {
        if authority().await? || !verify_target(&current_root(app, &scope, &row).await?) {
            return Err(held());
        }
        Ok(())
    };
    if can_start {
        let frozen = &m["document"]["firstPlay"];
        let first = is_coordinator && frozen["operationID"] == life.operation;
        if crate::bench::family_trace() {
            eprintln!(
                "family resume: first={first} supplied={} paused={}",
                life.start_text.is_some(),
                op["pausedDescendants"].as_object().is_some()
            );
        }
        let route = if let Some(value) = &life.start_text {
            if !first || frozen["inputDigest"] != token(value, 64) {
                return Err(foreign());
            }
            value.clone()
        } else if is_coordinator {
            if first && !frozen["inputDigest"].is_null() {
                return Err(foreign());
            }
            let paused =
                crate::missions::family::paused_context(app, &co, &m["tasks"], &op["pausedDescendants"]).await?;
            format!(
                "Start or resume existing mission {}. Inspect its map and playbook, use saved results, and continue coordination autonomously. Do not create a replacement mission. Resume existing queued assignments rather than duplicate them.{}",
                life.mid, paused
            )
        } else {
            format!(
                "Resume your interrupted assignments in existing mission {}. Inspect the mission map and your transcript first; continue unfinished work without repeating completed actions, then report normally.",
                life.mid
            )
        };
        checkpoint().await?;
        bridge::sync_environment(app, &scope, &life.sid).await?;
        bridge::sync_memory(app, &scope, &row).await;
        checkpoint().await?;
        crate::sessions::permission_mode::refresh_coordinator(app, &scope.workspace, &scope.endpoint, &row).await?;
        checkpoint().await?;
        let message = format!("msg_{}", token(&format!("{}\0resume\0{}", life.operation, life.sid), 28));
        let input = json!({"id":message,"text":route,"description":"CodeNomad mission start/resume","delivery":"queue","resume":true,
            "metadata":{"codenomad.mission":{"version":1,"missionID":life.mid,"kind":"lifecycle","operationID":life.operation}}});
        let result =
            bridge::send(app, &scope, Method::POST, &format!("/api/session/{}/synthetic", life.sid), &input).await?;
        if !result["data"].is_object() {
            return Err(held());
        }
        ack["disposition"] = json!("start-admitted");
        ack["admission"] = result["data"].clone();
    } else {
        let effect = crate::missions::family::apply(app, &row, action, &life.mid, checkpoint).await?;
        ack.as_object_mut().unwrap().extend(effect.as_object().ok_or_else(held)?.clone());
    }
    Ok(json!({"nativeAcknowledgement":ack}))
}

/// Mission mutations use the same private bridge registration as the desktop tools.
pub fn new_token() -> Option<String> {
    (crate::config::serve() || crate::bench::missions_run()).then(crate::automation::new_token).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_capabilities_accept_the_pinned_root_permission_flag_only_if_true() {
        assert!(document_capabilities(&json!({"version":1})));
        assert!(document_capabilities(&json!({"version":1,"automaticStart":true,"agentSchedulePreparation":true,
            "agentScheduleControl":true,"rootPermissions":true})));
        assert!(!document_capabilities(&json!({"version":1,"rootPermissions":false})));
        assert!(!document_capabilities(&json!({"version":1,"unknown":true})));
    }

    #[test]
    fn one_time_profiles_check_roles_and_freeze_the_comparator_model() {
        let a = json!({"providerID":"fixture","id":"a"});
        let b = json!({"providerID":"fixture","id":"b"});
        let mut p = json!({"coordinator":{"model":a},
            "roles":{"model-a":{"model":a},"model-b":{"model":b},"comparator":{"agent":"build"}}});
        let frozen = creation_profiles("compare", Some(p.clone())).unwrap().unwrap();
        assert_eq!(frozen["roles"]["comparator"], json!({"agent":"build","model":a}));
        p["roles"]["model-b"]["model"] = a;
        p["roles"]["model-b"]["model"]["variant"] = json!("different");
        assert_eq!(creation_profiles("compare", Some(p)).unwrap_err().1.0["code"], "compare-models-identical");
        assert_eq!(creation_profiles("compare", None).unwrap_err().1.0["code"], "compare-models-required");
        assert!(creation_profiles("debug", Some(json!({"roles":{"specialist":{}}}))).is_err());
    }

    #[test]
    fn ordinary_mutation_envelopes_preserve_missing_and_explicit_fields() {
        let invalid = "invalid";
        assert!(
            mutation_body::<Update>(json!({"requestId":"a","expectedRevision":1,"objective":"edit"}), invalid)
                .unwrap()
                .notes
                .is_none()
        );
        assert_eq!(
            mutation_body::<Update>(
                json!({"requestId":"a","expectedRevision":1,"objective":"edit","notes":""}),
                invalid
            )
            .unwrap()
            .notes
            .as_deref(),
            Some("")
        );
        assert!(
            mutation_body::<Update>(
                json!({"requestId":"a","expectedRevision":1,"objective":"edit","notes":null}),
                invalid
            )
            .is_err()
        );
        assert!(
            mutation_body::<Delete>(
                json!({"requestId":"a","expectedRevision":1,"deleteManagedSessions":false}),
                invalid
            )
            .is_ok()
        );
        assert!(
            mutation_body::<Delete>(json!({"requestId":"a","expectedRevision":1,"foreign":false}), invalid).is_err()
        );
        assert_eq!(mutation_ids(" mission ", " id ", 1, invalid).unwrap(), ("mission", "id"));
    }
}
