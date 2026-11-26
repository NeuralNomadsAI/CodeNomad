use crate::missions::schedule_contract::{
    ACTIONS, ClaimBinding, HOLD_CAPACITY, Hold, activation_pending, bad, config_invalid, exact_refusal, good,
    human_required, input_invalid, pending, refused, unavailable, unconfirmed, valid_result,
};
pub use crate::missions::schedule_contract::{Claims, Holds};
use crate::{
    App, Error, Shared, Workspace,
    auth::tls,
    files,
    missions::run::{directory, project_owner},
    opencode::Endpoint,
    worktrees::fence,
};
use axum::{
    Extension, Json,
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::StatusCode as Status,
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
#[path = "calendar_activation.rs"]
mod activation;
#[path = "calendar_agent.rs"]
mod agent;
#[path = "calendar_capability.rs"]
mod capability;
pub use activation::Activation;
pub(super) use agent::{agent_command, prepare_agent_schedule};
use agent::same_creation;
use capability::automation_api;

const READ: usize = 512 * 1024;

pub(super) struct Agent {
    pub(super) scope: super::creation_admission::Scope,
    row: Value,
    cancel: CancellationToken,
    creation: Option<Value>,
}

impl Agent {
    fn id(&self) -> &str {
        self.row["id"].as_str().unwrap_or_default()
    }
    async fn current(&self, app: &App) -> bool {
        !self.cancel.is_cancelled() && self.scope.refresh(app).await.is_ok()
            && super::bridge::session(app, &self.scope, self.id()).await
                .is_ok_and(|row| row["location"] == self.row["location"] && row["parentID"] == self.row["parentID"])
            && !self.cancel.is_cancelled() && self.scope.current(app)
    }
}

pub(super) enum Principal {
    Human(crate::auth::Principal),
    Agent(Arc<Agent>),
}

impl Principal {
    pub(super) fn token(&self) -> &CancellationToken {
        match self { Self::Human(p) => &p.0, Self::Agent(agent) => &agent.cancel }
    }
    pub(super) async fn current(&self, app: &App) -> bool {
        match self { Self::Human(p) => app.auth.human(p), Self::Agent(agent) => agent.current(app).await }
    }
    pub(super) fn transport(&self, identity: &mut Value) {
        match self {
            Self::Human(_) => identity["sessionID"] = json!(super::recurrence_control::auth_id()),
            Self::Agent(agent) => {
                identity["principal"] = match &agent.creation {
                    Some(c) => json!({"kind":"agent","author":c["author"],"creationRequestID":c["requestID"],"creationDigest":c["digest"]}),
                    None => json!({"kind":"agent","author":{"coordinatorSessionID":agent.id()}}),
                };
            }
        }
    }
    pub(super) fn agent(&self) -> Option<Arc<Agent>> {
        match self { Self::Human(_) => None, Self::Agent(agent) => Some(agent.clone()) }
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
fn encoded(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}
fn digest(v: &Value) -> String {
    format!("{:x}", Sha256::digest(encoded(v).as_bytes()))
}
fn sign(v: &Value, key: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC key");
    mac.update(encoded(v).as_bytes());
    format!("{:x}", mac.finalize().into_bytes())
}
pub fn setup(data: &std::path::Path, config: &std::path::Path) -> Result<Option<PathBuf>, Box<dyn std::error::Error>> {
    if crate::config::serve() {
        return Ok(crate::settings::profile::scope(config).map(|_| config.to_path_buf()));
    }
    if !crate::bench::missions_calendar() {
        return Ok(None);
    }
    let dir = data.join("calendar-profile");
    tls::private_directory(&dir)?;
    let yaml = dir.join("profile.yaml");
    if !yaml.exists() {
        tls::write_private(&yaml, b"server:\n  environmentVariables: {}\n")?;
    }
    if std::fs::symlink_metadata(&yaml)?.is_symlink()
        || std::fs::read(&yaml)? != b"server:\n  environmentVariables: {}\n"
    {
        return Err("Prototype calendar requires its fixed private environment document".into());
    }
    Ok(Some(dunce::canonicalize(yaml)?))
}
fn source(app: &App) -> Result<Value, Error> {
    let y = app.calendar_profile.as_ref().and_then(|p| p.to_str()).ok_or_else(unavailable)?;
    if crate::config::serve() {
        return super::recurrence_control::profile(app).map(|(_, source)| source).ok_or_else(unavailable);
    }
    Ok(json!({"profileID":digest(&json!(["cnrs-calendar",y])),"executionHost":"local","configYamlPath":y}))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Filter {
    directory: Option<String>,
    after: Option<String>,
    limit: Option<u64>,
    #[serde(rename = "requestID")]
    request: Option<String>,
}
/// Reference read query: `{ directory?, requestID? }`, strict.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct ReadQuery {
    directory: Option<String>,
    #[serde(rename = "requestID")]
    request: Option<String>,
}
async fn scope(app: &App, wid: &str, dir: Option<&str>) -> Result<(Workspace, String, String), Error> {
    source(app)?;
    let w = app.workspace(wid)?;
    files::directory(&w, dir)?;
    let (project, canonical) = project_owner(app, &w).await?;
    Ok((w, project, canonical))
}

fn on_connection(app: &App, endpoint: &Arc<Endpoint>) -> bool {
    app.native.endpoint().is_some_and(|current| Arc::ptr_eq(&current, endpoint))
}

async fn rpc_raw(
    app: &App,
    endpoint: &Arc<Endpoint>,
    dir: &str,
    method: &str,
    input: Value,
    max: usize,
    timeout: std::time::Duration,
) -> Result<(Status, Value), Error> {
    let url = endpoint.url.join(&format!("/api/rpc/codenomad.missions/{method}")).map_err(|_| unavailable())?;
    if !on_connection(app, endpoint) {
        return Err(unavailable());
    }
    let response = app
        .native
        .client
        .post(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", dir)])
        .json(&json!({"input":input}))
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| unavailable())?;
    let status = response.status();
    if !status.is_success() && status != Status::BAD_REQUEST {
        return Err(unavailable());
    }
    let result = crate::opencode::read_json(response, max).await.map_err(|_| unavailable())?;
    if !on_connection(app, endpoint) {
        return Err(unavailable());
    }
    Ok((status, result))
}

pub(crate) async fn rpc(
    app: &App,
    endpoint: &Arc<Endpoint>,
    dir: &str,
    method: &str,
    input: Value,
    max: usize,
) -> Result<Value, Error> {
    let (status, result) =
        rpc_raw(app, endpoint, dir, method, input, max, std::time::Duration::from_secs(100)).await?;
    if !status.is_success() {
        return Err(unavailable());
    }
    result.get("output").cloned().ok_or_else(unavailable)
}

async fn current(
    app: &App,
    w: &Workspace,
    project: &str,
    canonical: &str,
    physical: &str,
    endpoint: &Arc<Endpoint>,
) -> bool {
    let owner = project_owner(app, w).await;
    owner.is_ok_and(|(p, c)| p == project && c == canonical)
        && on_connection(app, endpoint)
        && files::host_identity(&w.path).ok().as_deref() == Some(physical)
        && app
            .workspace(&w.id.to_string())
            .is_ok_and(|fresh| fresh.path == w.path && fresh.location == w.location && fresh.created_at == w.created_at)
}
pub async fn list(
    State(app): State<Shared>,
    Path(id): Path<String>,
    Query(q): Query<Filter>,
) -> Result<Json<Value>, Error> {
    let endpoint = app.native.endpoint().ok_or_else(unavailable)?;
    let (w, project, canonical) = scope(&app, &id, q.directory.as_deref()).await?;
    let physical = files::host_identity(&w.path).map_err(|_| unavailable())?;
    let dir = directory(&w)?;
    let display = fence::capture_display(dir);
    let mut args = json!({"limit":q.limit.unwrap_or(8)});
    if !(1..=8).contains(&args["limit"].as_u64().unwrap()) || q.request.is_some() {
        return Err(bad());
    }
    if let Some(a) = q.after {
        if !good(&a) {
            return Err(bad());
        }
        args["after"] = json!(a);
    }
    let seen = rpc(&app, &endpoint, dir, "scheduleList", args, READ).await?;
    if seen["projectID"] != project
        || seen["version"] != 1
        || !seen["schedules"].as_array().is_some_and(|a| a.len() <= 8)
        || !current(&app, &w, &project, &canonical, &physical, &endpoint).await
        || !display.load(Ordering::Relaxed)
    {
        return Err(unavailable());
    }
    Ok(Json(seen))
}
pub(super) fn valid_flag(flag: &Value) -> bool {
    let Some(obj) = flag.as_object() else {
        return false;
    };
    if !obj.keys().all(|k| matches!(k.as_str(), "enabled" | "provenance" | "path" | "hiddenOff")) {
        return false;
    }
    let valid_str = |v: &Value| v.as_str().is_some_and(|s| (1..=4096).contains(&s.encode_utf16().count()));
    flag["enabled"].is_boolean()
        && matches!(
            flag["provenance"].as_str(),
            Some("environment" | "experimental-block" | "all-flags" | "channel-default" | "automations-setting")
        )
        && obj.get("path").is_none_or(valid_str)
        && obj.get("hiddenOff").is_none_or(|v| {
            v.as_array().is_some_and(|items| items.len() <= 256 && items.iter().all(valid_str))
        })
}

async fn flag(app: &App, endpoint: &Arc<Endpoint>, w: &Workspace) -> Result<Value, Error> {
    let dir = directory(w)?;
    let timeout = std::time::Duration::from_secs(5);
    let (status, body) = rpc_raw(app, endpoint, dir, "scheduleSetting", json!({}), 32768, timeout).await?;
    let flag = if status.is_success() {
        body.get("output").cloned().ok_or_else(unavailable)?
    } else if crate::opencode::native_rpc_absent(&body, status) && body["type"] == "rpc.method_not_found" {
        // Only a bundle without `scheduleSetting` falls back to `scheduleFlag`; other errors stay errors.
        let (fallback_status, fallback_body) =
            rpc_raw(app, endpoint, dir, "scheduleFlag", json!({}), 32768, timeout).await?;
        if !fallback_status.is_success() {
            return Err(unavailable());
        }
        fallback_body.get("output").cloned().ok_or_else(unavailable)?
    } else {
        return Err(unavailable());
    };
    if !valid_flag(&flag) {
        return Err(unavailable());
    }
    Ok(flag)
}
pub async fn capabilities(
    State(app): State<Shared>,
    Path(id): Path<String>,
    Query(q): Query<Filter>,
) -> Result<Json<Value>, Error> {
    let endpoint = app.native.endpoint().ok_or_else(unavailable)?;
    let (w, project, canonical) = scope(&app, &id, q.directory.as_deref()).await?;
    let physical = files::host_identity(&w.path).map_err(|_| unavailable())?;
    let dir = directory(&w)?;
    let display = fence::capture_display(dir);
    if q.after.is_some() || q.limit.is_some() || q.request.is_some() {
        return Err(input_invalid());
    }
    let (api, settings) =
        tokio::try_join!(automation_api(&app, &endpoint), activation::settings(&app, &endpoint, &w, dir),)?;
    if !current(&app, &w, &project, &canonical, &physical, &endpoint).await || !display.load(Ordering::Relaxed) {
        return Err(unavailable());
    }
    Ok(Json(json!({"location":{"directory":dir},"api":api,"enabled":settings.enabled,
        "origin":settings.origin,"provenance":settings.provenance,"activation":settings.diagnostic(api["available"] == true)})))
}
fn schedule_id(project: &str, dir: &str, request: &str) -> String {
    format!("msn_{}", &digest(&json!([project, dir, request]))[..40])
}

async fn read_exact(
    app: &App,
    endpoint: &Arc<Endpoint>,
    w: &Workspace,
    id: &str,
    request: Option<&str>,
) -> Result<Value, Error> {
    if !good(id) || request.is_some_and(|s| !good(s)) {
        return Err(input_invalid());
    }
    let mut input = json!({"missionID":id});
    if let Some(r) = request {
        input["requestID"] = json!(r);
    }
    let lost = || unconfirmed(Status::SERVICE_UNAVAILABLE, Some(id));
    let dir = directory(w).map_err(|_| lost())?;
    let result = rpc(app, endpoint, dir, "scheduleRead", input, READ).await.map_err(|_| lost())?;
    if !valid_result(&result, id) {
        return Err(lost());
    }
    app.workspace(&w.id.to_string()).map_err(|(status, _)| unconfirmed(status, Some(id)))?;
    Ok(result)
}
/// Settles the held permit with its exact completed receipt.
fn settle(app: &App, w: &Workspace, project: &str, canonical: &str, mid: &str, raw: &Value) -> bool {
    let mut map = app.calendar_holds.lock().unwrap();
    let Some(hold) = map.get(mid) else {
        return false;
    };
    if !hold.owned_by(w, project, canonical) || !hold.settles(mid, raw) {
        return false;
    }
    map.remove(mid);
    true
}
fn read_query(query: Result<Query<ReadQuery>, QueryRejection>) -> Result<ReadQuery, Error> {
    let Query(q) = query.map_err(|_| input_invalid())?;
    if q.request.as_deref().is_some_and(|r| !good(r))
        || q.directory.as_deref().is_some_and(|d| d.is_empty() || d.len() > 4096 || d.contains('\0'))
    {
        return Err(input_invalid());
    }
    Ok(q)
}
/// Reads never retry or arm work. A held permit is read with its own request.
async fn read_receipt(
    app: &App,
    endpoint: &Arc<Endpoint>,
    w: &Workspace,
    project: &str,
    canonical: &str,
    mid: &str,
    request: Option<&str>,
) -> Result<Json<Value>, Error> {
    let lost = || unconfirmed(Status::SERVICE_UNAVAILABLE, Some(mid));
    let physical = files::host_identity(&w.path).map_err(|_| lost())?;
    let held = app.calendar_holds.lock().unwrap().get(mid).cloned();
    if let Some(hold) = &held {
        if !hold.owned_by(w, project, canonical) || request.is_some_and(|r| r != hold.request) {
            return Err(unconfirmed(Status::CONFLICT, Some(mid)));
        }
        if !hold.dispatched || hold.busy {
            return Err(pending(Some(mid), None));
        }
    }
    let display = held.is_none().then(|| directory(w).map(fence::capture_display)).transpose()?;
    let original = held.as_ref().map(|h| h.request.as_str()).or(request);
    let result = read_exact(app, endpoint, w, mid, original).await?;
    if !current(app, w, project, canonical, &physical, endpoint).await
        || display.is_some_and(|d| !d.load(Ordering::Relaxed))
    {
        return Err(lost());
    }
    if let Some(held) = held {
        let mut holds = app.calendar_holds.lock().unwrap();
        return if holds.get(mid).is_some_and(|h| {
            Arc::ptr_eq(&h.permit, &held.permit)
                && !h.busy
                && h.owned_by(w, project, canonical)
                && h.settles(mid, &result)
        }) {
            holds.remove(mid);
            Ok(Json(result))
        } else {
            Err(pending(Some(mid), Some(&result)))
        };
    }
    if result["pending"] == true {
        return Err(pending(Some(mid), Some(&result)));
    }
    Ok(Json(result))
}
pub async fn read(
    State(app): State<Shared>,
    Path((id, mid)): Path<(String, String)>,
    query: Result<Query<ReadQuery>, QueryRejection>,
) -> Result<Json<Value>, Error> {
    let q = read_query(query)?;
    if !good(&mid) {
        return Err(input_invalid());
    }
    let endpoint = app.native.endpoint().ok_or_else(|| unconfirmed(Status::SERVICE_UNAVAILABLE, Some(&mid)))?;
    let (w, p, c) =
        scope(&app, &id, q.directory.as_deref()).await.map_err(|(status, _)| unconfirmed(status, Some(&mid)))?;
    read_receipt(&app, &endpoint, &w, &p, &c, &mid, q.request.as_deref()).await
}
pub async fn request_read(
    State(app): State<Shared>,
    Path((id, request)): Path<(String, String)>,
    query: Result<Query<ReadQuery>, QueryRejection>,
) -> Result<Json<Value>, Error> {
    let q = read_query(query)?;
    if !good(&request) {
        return Err(input_invalid());
    }
    let endpoint = app.native.endpoint().ok_or_else(|| unconfirmed(Status::SERVICE_UNAVAILABLE, None))?;
    let (w, p, canonical) =
        scope(&app, &id, q.directory.as_deref()).await.map_err(|(status, _)| unconfirmed(status, None))?;
    // A lost reply may hide even the document ID: derive it from the owner.
    let mid = schedule_id(&p, &canonical, &request);
    if q.request.as_deref().is_some_and(|r| r != request) {
        return Err(unconfirmed(Status::CONFLICT, Some(&mid)));
    }
    read_receipt(&app, &endpoint, &w, &p, &canonical, &mid, Some(&request)).await
}

pub struct Input {
    request: String,
    revision: u64,
    action: String,
    configuration: Option<Value>,
    delete_managed: Option<bool>,
    retry: bool,
    directory: Option<String>,
}
/// Reference body schema and refinements (`mission-scheduled.ts`).
fn parse_input(body: Result<Json<Value>, JsonRejection>, creating: bool) -> Result<Input, Error> {
    let Json(raw) = body.map_err(|_| input_invalid())?;
    let obj = raw.as_object().ok_or_else(input_invalid)?;
    const KEYS: [&str; 7] =
        ["requestID", "expectedRevision", "action", "configuration", "deleteManagedSessions", "retry", "directory"];
    if obj.keys().any(|k| !KEYS.contains(&k.as_str())) {
        return Err(input_invalid());
    }
    let request = obj.get("requestID").and_then(Value::as_str).filter(|s| good(s));
    let revision = obj.get("expectedRevision").and_then(Value::as_u64).filter(|r| *r <= 9_007_199_254_740_991);
    let action = obj.get("action").and_then(Value::as_str).filter(|a| ACTIONS.contains(a));
    let (Some(request), Some(revision), Some(action)) = (request, revision, action) else {
        return Err(input_invalid());
    };
    let configuration = obj.get("configuration").cloned();
    let delete_managed = match obj.get("deleteManagedSessions") {
        None => None,
        Some(v) => Some(v.as_bool().ok_or_else(input_invalid)?),
    };
    let retry = match obj.get("retry") {
        None => false,
        Some(v) => v.as_bool().ok_or_else(input_invalid)?,
    };
    let directory = match obj.get("directory") {
        None => None,
        Some(v) => Some(
            v.as_str()
                .filter(|d| !d.is_empty() && d.len() <= 4096 && !d.contains('\0'))
                .ok_or_else(input_invalid)?
                .to_owned(),
        ),
    };
    if configuration.as_ref().is_some_and(|c| !c.is_object())
        || matches!(action, "create" | "configure") != configuration.is_some()
        || delete_managed.is_some() && action != "delete"
        || action == "create" && revision != 0
        || creating != (action == "create")
    {
        return Err(input_invalid());
    }
    Ok(Input {
        request: request.into(),
        revision,
        action: action.into(),
        configuration,
        delete_managed,
        retry,
        directory,
    })
}
pub async fn create(
    State(app): State<Shared>,
    Path(id): Path<String>,
    Extension(principal): Extension<crate::auth::Principal>,
    body: Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>, Error> {
    let input = parse_input(body, true)?;
    mutate(app, id, None, Principal::Human(principal), input).await
}
pub async fn control(
    State(app): State<Shared>,
    Path((id, mid)): Path<(String, String)>,
    Extension(principal): Extension<crate::auth::Principal>,
    body: Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>, Error> {
    let input = parse_input(body, false)?;
    if !good(&mid) {
        return Err(input_invalid());
    }
    mutate(app, id, Some(mid), Principal::Human(principal), input).await
}
fn validate_config(v: &mut Value, dir: &str, profile: &Value, creating: bool) -> Result<(), Error> {
    // Reference body schema: the user configuration omits the server-owned fields.
    let obj = v.as_object_mut().ok_or_else(input_invalid)?;
    if ["roots", "profileID", "executionHost", "coordinatorSelectionAuthor"].iter().any(|k| obj.contains_key(*k)) {
        return Err(input_invalid());
    }
    obj.insert("profileID".into(), profile["profileID"].clone());
    obj.insert("executionHost".into(), json!("local"));
    obj.insert("roots".into(), json!([{"mode":"directory-only","directory":dir}]));
    // The body schema holds the configuration's object shape (field rules) and
    // the calendar requirement of Create; the whole schema then adds its
    // object-level refinement. The native plugin recomputes the payload digest
    // from exactly this output.
    let shaped = crate::missions::configuration::shape(v).map_err(|()| input_invalid())?;
    if creating && !crate::missions::configuration::requires_calendar(&shaped["launch"]) {
        return Err(input_invalid());
    }
    let normalized = crate::missions::configuration::normalize(v).map_err(|()| config_invalid())?;
    // Like the reference human route, the server admits the schema only: event
    // sources, followed conversations, an explicit coordinator and the task
    // mode are checked by the native plugin (profile catalog and roots at
    // admission, source ownership and coordinator eligibility when read).
    *v = normalized;
    Ok(())
}
/// Clears an undispatched permit, or the in-flight mark of a dispatched one,
/// however the handler ends (the reference `dispose`).
struct Release(Shared, String, Arc<fence::Entered>);
impl Drop for Release {
    fn drop(&mut self) {
        let mut holds = self.0.calendar_holds.lock().unwrap();
        if let Some(hold) = holds.get_mut(&self.1).filter(|h| Arc::ptr_eq(&h.permit, &self.2)) {
            if hold.dispatched {
                hold.busy = false;
            } else {
                holds.remove(&self.1);
            }
        }
    }
}
async fn mutate(
    app: Shared,
    id: String,
    mid: Option<String>,
    principal: Principal,
    input: Input,
) -> Result<Json<Value>, Error> {
    if !principal.current(&app).await || app.mission_bridge.is_none() || app.calendar_profile.is_none() {
        return Err(human_required());
    }
    let _gate = app.calendar_slot.lock().await;
    let endpoint = app.native.endpoint().ok_or_else(|| unconfirmed(Status::SERVICE_UNAVAILABLE, mid.as_deref()))?;
    let (w, project, canonical) = scope(&app, &id, input.directory.as_deref())
        .await
        .map_err(|(status, _)| unconfirmed(status, mid.as_deref()))?;
    let lost = |status: Status, m: &str| unconfirmed(status, Some(m));
    let mid = mid.unwrap_or_else(|| schedule_id(&project, &canonical, &input.request));
    let dir = directory(&w).map_err(|_| lost(Status::SERVICE_UNAVAILABLE, &mid))?.to_owned();
    let profile = source(&app).map_err(|_| human_required())?;
    let mut conf = input.configuration.clone();
    if let Some(v) = &mut conf {
        validate_config(v, &dir, &profile, input.action == "create")?;
        if let Principal::Agent(agent) = &principal
            && agent.creation.is_none()
        {
            v["coordinatorSelectionAuthor"] = json!({"coordinatorSessionID":agent.id()});
        }
    }
    let creation = match &principal {
        Principal::Agent(agent) if input.action == "create" => Some(agent.creation.as_ref().ok_or_else(unavailable)?.clone()),
        _ => None,
    };
    let payload = if let Some(c) = &creation {
        digest(&json!({"configuration":conf,"creation":c}))
    } else {
        digest(conf.as_ref().unwrap_or(&json!({"deleteManagedSessions":input.delete_managed.unwrap_or(false)})))
    };
    let identity = digest(&json!([input.request, input.revision, input.action, payload]));
    let physical = files::host_identity(&w.path).map_err(|_| lost(Status::SERVICE_UNAVAILABLE, &mid))?;
    let existing = app.calendar_holds.lock().unwrap().get(&mid).cloned();
    let mut checking = None;
    let (permit, replacement) = if let Some(held) = existing {
        if !held.owned_by(&w, &project, &canonical) {
            return Err(lost(Status::CONFLICT, &mid));
        }
        if !held.dispatched || held.busy {
            return Err(pending(Some(&mid), None));
        }
        if input.action != "check" && held.identity != identity {
            return Err(lost(Status::CONFLICT, &mid));
        }
        let receipt = read_exact(&app, &endpoint, &w, &mid, Some(&held.request)).await?;
        if !principal.current(&app).await || !current(&app, &w, &project, &canonical, &physical, &endpoint).await {
            return Err(lost(Status::SERVICE_UNAVAILABLE, &mid));
        }
        if settle(&app, &w, &project, &canonical, &mid, &receipt) {
            return Ok(Json(receipt));
        }
        let adopt = input.action == "check" && input.request != held.request;
        if !adopt && !(input.retry && input.action != "check") {
            return Err(pending(Some(&mid), Some(&receipt)));
        }
        // Check adoption and original-intent retry both need the exact partial receipt.
        if !(held.exact(&mid, &receipt) && receipt["pending"] == true) {
            return Err(lost(Status::SERVICE_UNAVAILABLE, &mid));
        }
        let replacement = if Arc::ptr_eq(&held.endpoint, &endpoint) {
            None
        } else {
            Some(Arc::new(fence::enter(std::slice::from_ref(&dir)).ok_or_else(|| lost(Status::CONFLICT, &mid))?))
        };
        let mut holds = app.calendar_holds.lock().unwrap();
        let hold = holds
            .get_mut(&mid)
            .filter(|h| Arc::ptr_eq(&h.permit, &held.permit))
            .ok_or_else(|| lost(Status::SERVICE_UNAVAILABLE, &mid))?;
        hold.busy = true;
        checking = adopt.then(|| held.request.clone());
        (held.permit, replacement)
    } else {
        let permit = Arc::new(fence::enter(std::slice::from_ref(&dir)).ok_or_else(|| lost(Status::CONFLICT, &mid))?);
        let mut holds = app.calendar_holds.lock().unwrap();
        if holds.len() >= HOLD_CAPACITY || holds.contains_key(&mid) {
            return Err(lost(Status::CONFLICT, &mid));
        }
        holds.insert(
            mid.clone(),
            Hold {
                request: input.request.clone(),
                action: input.action.clone(),
                revision: input.revision,
                identity: identity.clone(),
                delete_managed: input.delete_managed.unwrap_or(false),
                workspace: w.id.to_string(),
                project: project.clone(),
                canonical: canonical.clone(),
                directory: dir.clone(),
                physical: physical.clone(),
                endpoint: endpoint.clone(),
                permit: permit.clone(),
                dispatched: false,
                busy: false,
                retried: false,
            },
        );
        (permit, None)
    };
    let mut release = Release(app.clone(), mid.clone(), permit);
    // The native owner additionally requires its ready activation proof.
    if matches!(input.action.as_str(), "play" | "resume" | "run-now") {
        let (api, settings) =
            tokio::try_join!(automation_api(&app, &endpoint), activation::settings(&app, &endpoint, &w, &dir),)
                .map_err(|_| lost(Status::SERVICE_UNAVAILABLE, &mid))?;
        if api["available"] != true || settings.require_enabled(None).is_err() {
            return Err(lost(Status::SERVICE_UNAVAILABLE, &mid));
        }
    }
    if !current(&app, &w, &project, &canonical, &physical, &endpoint).await || !principal.current(&app).await {
        return Err(lost(Status::SERVICE_UNAVAILABLE, &mid));
    }
    let mut proof = json!({"workspaceID":id,"requestID":input.request,"location":{"directory":dir},
        "scheduleID":mid,"expectedRevision":input.revision,"action":input.action,"profileSource":profile,"issuedAt":now()});
    principal.transport(&mut proof);
    if matches!(input.action.as_str(), "create" | "configure" | "delete") {
        proof["configDigest"] = json!(payload);
    }
    let marker = digest(&proof);
    proof["digest"] = json!(marker);
    let mut transport = proof.clone();
    let key = app.mission_bridge.as_ref().ok_or_else(human_required)?;
    transport["proof"] = json!(sign(&proof, key));
    let mut call = json!({"missionID":mid,"requestID":input.request,"expectedRevision":input.revision,"action":input.action,"transport":transport});
    if let Some(v) = conf {
        call["configuration"] = v;
    }
    if let Some(v) = creation {
        call["creation"] = v;
    }
    if let Some(v) = input.delete_managed {
        call["deleteManagedSessions"] = json!(v);
    }
    if input.retry {
        call["retry"] = json!(true);
    }
    {
        let mut holds = app.calendar_holds.lock().unwrap();
        let hold = holds
            .get_mut(&mid)
            .filter(|h| Arc::ptr_eq(&h.permit, &release.2))
            .ok_or_else(|| lost(Status::SERVICE_UNAVAILABLE, &mid))?;
        if let Some(fresh) = replacement {
            hold.endpoint = endpoint.clone();
            hold.permit = fresh.clone();
            release.2 = fresh;
        }
        hold.retried |= hold.dispatched;
        hold.dispatched = true;
        hold.busy = true;
    }
    app.calendar_claims.lock().unwrap().insert(
        marker.clone(),
        Arc::new(ClaimBinding {
            proof,
            principal: principal.token().clone(),
            physical: physical.clone(),
            project: project.clone(),
            canonical: canonical.clone(),
            endpoint: endpoint.clone(),
            agent: principal.agent(),
        }),
    );
    // An admitted native write runs to completion even if this client leaves;
    // its verification claim lives exactly as long as the write.
    let task = {
        let app = app.clone();
        let mid = mid.clone();
        tokio::spawn(async move {
            let _release = release;
            let result = rpc(&app, &endpoint, &dir, "scheduleControl", call, READ).await;
            app.calendar_claims.lock().unwrap().remove(&marker);
            let lost = || unconfirmed(Status::SERVICE_UNAVAILABLE, Some(&mid));
            let result = result.map_err(|_| lost())?;
            if !valid_result(&result, &mid)
                || !current(&app, &w, &project, &canonical, &physical, &endpoint).await
                || !principal.current(&app).await
            {
                return Err(lost());
            }
            if result["refusal"].is_object() {
                let exact = exact_refusal(&result, &mid, &input.request, input.revision, &input.action, &payload);
                if exact && checking.is_some() {
                    // A refused Check never releases the original permit.
                    return Err(refused(&mid, &result));
                }
                if exact && !input.retry {
                    let mut holds = app.calendar_holds.lock().unwrap();
                    if holds.get(&mid).is_some_and(|h| h.dispatched && !h.retried && h.identity == identity) {
                        holds.remove(&mid);
                        return Err(refused(&mid, &result));
                    }
                }
                return Err(pending(Some(&mid), Some(&result)));
            }
            // Check adopts the saved intent; its own ACK cannot settle the original.
            let result = match &checking {
                Some(original) => {
                    let exact = read_exact(&app, &endpoint, &w, &mid, Some(original)).await?;
                    if !current(&app, &w, &project, &canonical, &physical, &endpoint).await
                        || !principal.current(&app).await
                    {
                        return Err(lost());
                    }
                    exact
                }
                None => result,
            };
            if settle(&app, &w, &project, &canonical, &mid, &result) {
                Ok(Json(result))
            } else {
                Err(pending(Some(&mid), Some(&result)))
            }
        })
    };
    task.await.map_err(|_| unconfirmed(Status::SERVICE_UNAVAILABLE, Some(&mid)))?
}
pub async fn verify(app: &App, session: &str, proof: Value) -> Result<Json<Value>, Error> {
    let issued = proof["issuedAt"].as_u64().ok_or_else(bad)?;
    let marker = proof["digest"].as_str().ok_or_else(bad)?;
    let claim = app.calendar_claims.lock().unwrap().get(marker).cloned().ok_or_else(unavailable)?;
    let check = || {
        proof == claim.proof
            && claim.agent.as_ref().map_or(proof["sessionID"] == session, |agent| agent.id() == session)
            && !claim.principal.is_cancelled()
            && on_connection(app, &claim.endpoint)
            && issued <= now() + 5000
            && now().saturating_sub(issued) < 30000
    };
    if !check() {
        return Err(unavailable());
    }
    let id = proof["workspaceID"].as_str().ok_or_else(bad)?;
    let dir = proof["location"]["directory"].as_str().ok_or_else(bad)?;
    let (w, project, canonical) = scope(app, id, Some(dir)).await?;
    if let Some(agent) = &claim.agent {
        if agent.scope.project != project || !agent.current(app).await {
            return Err(unavailable());
        }
        if let Some(c) = &agent.creation {
            match proof["action"].as_str() {
                Some("create") if proof["requestID"] == c["requestID"]
                    && proof["scheduleID"] == schedule_id(&project, &canonical, c["requestID"].as_str().ok_or_else(bad)?) =>
                {
                    let binding = rpc(app, &claim.endpoint, dir, "schedulePreparationRead",
                        json!({"creationRequestID":c["requestID"]}), 64 * 1024).await?;
                    if binding["binding"] != json!({"author":c["author"],"creationRequestID":c["requestID"],"creationDigest":c["digest"]}) {
                        return Err(unavailable());
                    }
                }
                Some("play") => {
                    let mid = proof["scheduleID"].as_str().ok_or_else(bad)?;
                    let seen = read_exact(app, &claim.endpoint, &w, mid, None).await?;
                    let doc = &seen["document"];
                    if !same_creation(&doc["creation"], c) || doc["state"] != "paused" || !doc["firstPlayedAt"].is_null()
                        || doc["revision"] != proof["expectedRevision"]
                        || doc["creation"]["automaticStart"]["requestID"] != proof["requestID"]
                        || doc["creation"]["automaticStart"]["attempted"] != false
                    {
                        return Err(unavailable());
                    }
                }
                _ => return Err(unavailable()),
            }
        }
    }
    if !check()
        || directory(&w)? != dir
        || project != claim.project
        || canonical != claim.canonical
        || files::host_identity(&w.path).ok().as_ref() != Some(&claim.physical)
        || !app
            .workspace(id)
            .is_ok_and(|fresh| fresh.path == w.path && fresh.location == w.location && fresh.created_at == w.created_at)
        || !app.calendar_claims.lock().unwrap().get(marker).is_some_and(|r| Arc::ptr_eq(r, &claim))
    {
        return Err(unavailable());
    }
    Ok(Json(json!({"result":{"admitted":true}})))
}

pub async fn activation_read(
    State(app): State<Shared>,
    Path((id, mid)): Path<(String, String)>,
    Query(q): Query<Activation>,
) -> Result<Json<Value>, Error> {
    if !good(&mid) || !q.valid() {
        return Err(bad());
    }
    let endpoint = app.native.endpoint().ok_or_else(unavailable)?;
    let (w, project, canonical) = scope(&app, &id, None).await?;
    let physical = files::host_identity(&w.path).map_err(|_| unavailable())?;
    let dir = directory(&w)?;
    let display = fence::capture_display(dir);
    let journal = activation::Journal { app: &app, endpoint: &endpoint, dir, mission: &mid, input: &q };
    let result = journal.phase("read", Value::Null).await?;
    if !current(&app, &w, &project, &canonical, &physical, &endpoint).await || !display.load(Ordering::Relaxed) {
        return Err(unavailable());
    }
    Ok(Json(result))
}
pub async fn activate(
    State(app): State<Shared>,
    Path((id, mid)): Path<(String, String)>,
    Extension(principal): Extension<crate::auth::Principal>,
    Json(q): Json<Activation>,
) -> Result<Json<Value>, Error> {
    activate_for(&app, &id, &mid, &q, Principal::Human(principal)).await.map(Json)
}

async fn activate_for(app: &App, id: &str, mid: &str, q: &Activation, principal: Principal) -> Result<Value, Error> {
    if !good(&mid) || !q.valid() {
        return Err(bad());
    }
    let _gate = app.calendar_slot.lock().await;
    let endpoint = app.native.endpoint().ok_or_else(unavailable)?;
    let (w, project, canonical) = scope(&app, &id, None).await?;
    let physical = files::host_identity(&w.path).map_err(|_| unavailable())?;
    let dir = directory(&w)?;
    let _permit = fence::enter(&[dir.to_owned()]).ok_or_else(unavailable)?;
    let guarded =
        || async { current(&app, &w, &project, &canonical, &physical, &endpoint).await && principal.current(app).await };
    let journal = activation::Journal { app: &app, endpoint: &endpoint, dir, mission: &mid, input: &q };
    let legacy = digest(&json!(["enabled-fixture", source(&app)?, dir]));
    activation::execute(journal, &w, &legacy, guarded).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(body: Value, creating: bool) -> Result<Input, Error> {
        parse_input(Ok(Json(body)), creating)
    }

    #[test]
    fn schedule_bodies_follow_the_reference_refinements() {
        let ok = |b: Value, creating| parse(b, creating).is_ok();
        assert!(ok(json!({"requestID":"req_1","expectedRevision":0,"action":"create","configuration":{}}), true));
        assert!(!ok(json!({"requestID":"req_1","expectedRevision":1,"action":"create","configuration":{}}), true));
        assert!(!ok(json!({"requestID":"req_1","expectedRevision":0,"action":"create"}), true));
        assert!(!ok(json!({"requestID":"req_1","expectedRevision":0,"action":"play"}), true), "create path");
        assert!(!ok(json!({"requestID":"req_1","expectedRevision":0,"action":"create","configuration":{}}), false));
        assert!(ok(
            json!({"requestID":"req_1","expectedRevision":2,"action":"delete","deleteManagedSessions":false}),
            false
        ));
        assert!(!ok(
            json!({"requestID":"req_1","expectedRevision":2,"action":"stop","deleteManagedSessions":false}),
            false
        ));
        assert!(ok(json!({"requestID":"req_1","expectedRevision":2,"action":"play","retry":true}), false));
        assert!(!ok(json!({"requestID":"req_1","expectedRevision":2,"action":"play","configuration":{}}), false));
        assert!(ok(json!({"requestID":"req_1","expectedRevision":2,"action":"configure","configuration":{}}), false));
        assert!(!ok(json!({"requestID":"r","expectedRevision":2,"action":"play"}), false), "request ID bound");
        assert!(!ok(json!({"requestID":"req_1","expectedRevision":2,"action":"play","other":1}), false));
        assert!(!ok(json!({"requestID":"req_1","expectedRevision":2,"action":"play","directory":""}), false));
        assert_eq!(parse(json!([]), false).err().unwrap().1.0["code"], "schedule-input-invalid");
    }

    #[test]
    fn valid_flag_enforces_strict_schedule_setting_schema() {
        assert!(valid_flag(&json!({"enabled":true,"provenance":"channel-default"})));
        assert!(valid_flag(
            &json!({"enabled":true,"provenance":"automations-setting","path":"/p.json","hiddenOff":["/g.json"]})
        ));
        assert!(!valid_flag(&json!(null)));
        assert!(!valid_flag(&json!([])));
        assert!(!valid_flag(&json!({"enabled":"true","provenance":"channel-default"})));
        assert!(!valid_flag(&json!({"enabled":true,"provenance":"unknown"})));
        assert!(!valid_flag(&json!({"enabled":true,"provenance":"channel-default","extra":1})));
        assert!(!valid_flag(&json!({"enabled":true,"provenance":"automations-setting","path":""})));
        assert!(!valid_flag(&json!({"enabled":true,"provenance":"automations-setting","path":null})));
        assert!(!valid_flag(&json!({"enabled":true,"provenance":"automations-setting","hiddenOff":[""]})));
        assert!(!valid_flag(&json!({"enabled":true,"provenance":"automations-setting","hiddenOff":[null]})));
        assert!(!valid_flag(&json!({"enabled":true,"provenance":"automations-setting","hiddenOff":[1]})));
        assert!(!valid_flag(&json!({"enabled":true,"provenance":"automations-setting","hiddenOff":null})));

        // UTF-16 length boundary (4096 vs 4097 code units, including 2-unit surrogate pairs).
        let ok_ascii = "a".repeat(4096);
        let long_ascii = "a".repeat(4097);
        let ok_emoji = "🚀".repeat(2048);
        let long_emoji = "🚀".repeat(2049);
        assert!(valid_flag(&json!({"enabled":true,"provenance":"automations-setting","path":ok_ascii})));
        assert!(!valid_flag(&json!({"enabled":true,"provenance":"automations-setting","path":long_ascii})));
        assert!(valid_flag(&json!({"enabled":true,"provenance":"automations-setting","path":ok_emoji})));
        assert!(!valid_flag(&json!({"enabled":true,"provenance":"automations-setting","path":long_emoji})));
        assert!(valid_flag(&json!({"enabled":true,"provenance":"automations-setting","hiddenOff":[ok_emoji]})));
        assert!(!valid_flag(&json!({"enabled":true,"provenance":"automations-setting","hiddenOff":[long_emoji]})));

        // hiddenOff array cap (256 vs 257 entries).
        let ok_hidden: Vec<String> = (0..256).map(|i| format!("/f{i}.json")).collect();
        let too_many_hidden: Vec<String> = (0..257).map(|i| format!("/f{i}.json")).collect();
        assert!(valid_flag(&json!({"enabled":true,"provenance":"automations-setting","hiddenOff":ok_hidden})));
        assert!(!valid_flag(&json!({"enabled":true,"provenance":"automations-setting","hiddenOff":too_many_hidden})));
    }

    #[tokio::test]
    async fn flag_prefers_schedule_setting_and_falls_back_only_on_method_not_found() {
        use axum::{Router, routing::post};
        use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

        struct Cleanup {
            dir: PathBuf,
            server: tokio::task::JoinHandle<()>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.server.abort();
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }

        let mode = Arc::new(std::sync::Mutex::new("detailed"));
        let fallback_calls = Arc::new(AtomicUsize::new(0));
        let m1 = mode.clone();
        let fc = fallback_calls.clone();
        let router = Router::new()
            .route(
                "/api/rpc/codenomad.missions/scheduleSetting",
                post(move || {
                    let current = *m1.lock().unwrap();
                    async move {
                        match current {
                            "detailed" => (
                                Status::OK,
                                Json(json!({"output":{"enabled":true,"provenance":"automations-setting","path":"/p.json","hiddenOff":["/g.json"]}})),
                            ),
                            "missing" => (
                                Status::BAD_REQUEST,
                                Json(json!({"_tag":"RpcError","type":"rpc.method_not_found","message":"Unknown RPC method"})),
                            ),
                            "unavailable" => (
                                Status::BAD_REQUEST,
                                Json(json!({"_tag":"RpcError","type":"rpc.unavailable","message":"RPC unavailable"})),
                            ),
                            "bad-output" => (
                                Status::OK,
                                Json(json!({"output":{"enabled":true,"provenance":"unknown"}})),
                            ),
                            "bad-rpc-shape" => (
                                Status::BAD_REQUEST,
                                Json(json!({"_tag":"RpcError","type":"rpc.method_not_found","message":"Unknown","extra":true})),
                            ),
                            "wrong-tag" => (
                                Status::BAD_REQUEST,
                                Json(json!({"_tag":"Other","type":"rpc.method_not_found","message":"Unknown"})),
                            ),
                            _ => (Status::INTERNAL_SERVER_ERROR, Json(json!({"error":"boom"}))),
                        }
                    }
                }),
            )
            .route(
                "/api/rpc/codenomad.missions/scheduleFlag",
                post(move || {
                    fc.fetch_add(1, Relaxed);
                    async { (Status::OK, Json(json!({"output":{"enabled":true,"provenance":"channel-default"}}))) }
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let dir = crate::shared::test_dir("calendar-flag-rpc");
        let _cleanup = Cleanup { dir: dir.clone(), server };
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
        let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
            dir.join("config.yaml").to_str().unwrap(),
        ));
        let native = crate::opencode::Native::test_connection(addr);
        let app = App::new(
            auth,
            0,
            dir.clone(),
            dir.clone(),
            false,
            settings,
            Value::Null,
            native,
            PathBuf::new(),
            None,
            files::watch::Watches::new(tx),
            None,
        );
        let endpoint = app.native.endpoint().unwrap();
        let id = uuid::Uuid::new_v4();
        let workspace = Workspace {
            id,
            request_id: None,
            path: dir.clone(),
            name: None,
            status: "running",
            proxy_path: format!("/workspaces/{id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            location: json!({"directory": dir}),
            temporary: None,
        };

        let detailed = flag(&app, &endpoint, &workspace).await.unwrap();
        assert_eq!(
            detailed,
            json!({"enabled":true,"provenance":"automations-setting","path":"/p.json","hiddenOff":["/g.json"]})
        );
        assert_eq!(fallback_calls.load(Relaxed), 0);

        *mode.lock().unwrap() = "missing";
        let legacy = flag(&app, &endpoint, &workspace).await.unwrap();
        assert_eq!(legacy, json!({"enabled":true,"provenance":"channel-default"}));
        assert_eq!(fallback_calls.load(Relaxed), 1);

        for failure in ["unavailable", "bad-output", "bad-rpc-shape", "wrong-tag", "internal"] {
            *mode.lock().unwrap() = failure;
            assert!(flag(&app, &endpoint, &workspace).await.is_err(), "{failure} must not fall back");
        }
        assert_eq!(fallback_calls.load(Relaxed), 1, "non-missing errors never call scheduleFlag");
    }
}
#[cfg(test)]
#[path = "calendar_admission_tests.rs"]
mod admission_tests;
