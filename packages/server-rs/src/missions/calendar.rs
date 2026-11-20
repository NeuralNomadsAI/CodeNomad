use crate::{
    App, Error, Shared, Workspace,
    worktrees::linked::native,
    missions::run::{directory, project_owner, rpc},
    files, auth::tls,
};
use axum::{
    Extension, Json,
    extract::{
        Path, Query, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::{Method, StatusCode as Status},
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use crate::missions::schedule_contract::{
    ACTIONS, HOLD_CAPACITY, Hold, activation_pending, bad, config_invalid, good, human_required,
    input_invalid, pending, refused, unavailable, unconfirmed, valid_result,
};
pub use crate::missions::schedule_contract::{Claims, Holds};

const READ: usize = 512 * 1024;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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
pub fn setup(data: &std::path::Path) -> Result<Option<PathBuf>, Box<dyn std::error::Error>> {
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
    let y = app
        .calendar_profile
        .as_ref()
        .and_then(|p| p.to_str())
        .ok_or_else(unavailable)?;
    Ok(
        json!({"profileID":digest(&json!(["cnrs-calendar",y])),"executionHost":"local","configYamlPath":y}),
    )
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
async fn scope(
    app: &App,
    wid: &str,
    dir: Option<&str>,
) -> Result<(Workspace, String, String), Error> {
    source(app)?;
    let w = app.workspace(wid)?;
    files::directory(&w, dir)?;
    let (project, canonical) = project_owner(app, &w).await?;
    Ok((w, project, canonical))
}
pub async fn list(
    State(app): State<Shared>,
    Path(id): Path<String>,
    Query(q): Query<Filter>,
) -> Result<Json<Value>, Error> {
    let (w, project, _) = scope(&app, &id, q.directory.as_deref()).await?;
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
    let seen = rpc(&app, directory(&w)?, "scheduleList", args, READ).await?;
    if seen["projectID"] != project
        || seen["version"] != 1
        || !seen["schedules"].as_array().is_some_and(|a| a.len() <= 8)
    {
        return Err(unavailable());
    }
    Ok(Json(seen))
}
async fn flag(app: &App, w: &Workspace) -> Result<Value, Error> {
    let flag = rpc(app, directory(w)?, "scheduleFlag", json!({}), 32768).await?;
    if !flag["enabled"].is_boolean() {
        return Err(unavailable());
    }
    Ok(flag)
}
async fn automation_api(app: &App) -> Result<Value, Error> {
    let document = native(
        app,
        Method::GET,
        "/openapi.json",
        &[],
        None,
        4 * 1024 * 1024,
    )
    .await?;
    let base = "/api/experimental/automation";
    let item = format!("{base}/{{automationID}}");
    let paths = &document["paths"];
    let operations = [
        (base.to_owned(), "post", "create"),
        (base.to_owned(), "get", "list"),
        (item.clone(), "get", "get"),
        (item.clone(), "delete", "delete"),
        (format!("{item}/pause"), "post", "pause"),
        (format!("{item}/resume"), "post", "resume"),
    ];
    if operations
        .iter()
        .any(|(path, method, _)| !paths[path][method].is_object())
    {
        return Ok(json!({"available":false,"reason":"missing-api"}));
    }
    let expected = &document["components"]["schemas"]["Config.InfoEncoded"]["properties"]["experimental"]
        ["properties"]["automations"];
    if expected["type"] != "boolean"
        || operations.iter().any(|(path, method, action)| {
            let op = &paths[path][method];
            op["operationId"] != format!("experimental.automation.{action}")
                || if *action == "delete" {
                    !op["responses"]["204"].is_object()
                } else {
                    !op["responses"]["200"]["content"]["application/json"]["schema"].is_object()
                }
        })
    {
        return Ok(json!({"available":false,"reason":"incompatible-contract"}));
    }
    Ok(json!({"available":true}))
}
pub async fn capabilities(
    State(app): State<Shared>,
    Path(id): Path<String>,
    Query(q): Query<Filter>,
) -> Result<Json<Value>, Error> {
    let (w, _, _) = scope(&app, &id, q.directory.as_deref()).await?;
    let api = automation_api(&app).await?;
    let state = flag(&app, &w).await?;
    let enabled = state["enabled"] == true;
    Ok(Json(
        json!({"location":{"directory":directory(&w)?},"api":api,"enabled":enabled,
        "origin":null,"provenance":state["provenance"],"activation":if enabled&&api["available"]==true{json!({"available":true,"targets":[]})}
        else{json!({"available":false,"reason":"explicit-off","targets":[]})}}),
    ))
}
fn schedule_id(project: &str, dir: &str, request: &str) -> String {
    format!("msn_{}", &digest(&json!([project, dir, request]))[..40])
}

async fn read_exact(
    app: &App,
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
    let result = rpc(app, dir, "scheduleRead", input, READ).await.map_err(|_| lost())?;
    if !valid_result(&result, id) {
        return Err(lost());
    }
    app.workspace(&w.id.to_string())
        .map_err(|(status, _)| unconfirmed(status, Some(id)))?;
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
        || q.directory
            .as_deref()
            .is_some_and(|d| d.is_empty() || d.len() > 4096 || d.contains('\0'))
    {
        return Err(input_invalid());
    }
    Ok(q)
}
/// Reads never retry or arm work. A held permit is read with its own request.
async fn read_receipt(
    app: &App,
    w: &Workspace,
    project: &str,
    canonical: &str,
    mid: &str,
    request: Option<&str>,
) -> Result<Json<Value>, Error> {
    let held = app.calendar_holds.lock().unwrap().get(mid).cloned();
    if let Some(hold) = held {
        if !hold.owned_by(w, project, canonical) || request.is_some_and(|r| r != hold.request) {
            return Err(unconfirmed(Status::CONFLICT, Some(mid)));
        }
        if !hold.dispatched {
            return Err(pending(Some(mid), None));
        }
        let result = read_exact(app, w, mid, Some(&hold.request)).await?;
        return if settle(app, w, project, canonical, mid, &result) {
            Ok(Json(result))
        } else {
            Err(pending(Some(mid), Some(&result)))
        };
    }
    let result = read_exact(app, w, mid, request).await?;
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
    let (w, p, c) = scope(&app, &id, q.directory.as_deref())
        .await
        .map_err(|(status, _)| unconfirmed(status, Some(&mid)))?;
    read_receipt(&app, &w, &p, &c, &mid, q.request.as_deref()).await
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
    let (w, p, canonical) = scope(&app, &id, q.directory.as_deref())
        .await
        .map_err(|(status, _)| unconfirmed(status, None))?;
    // A lost reply may hide even the document ID: derive it from the owner.
    let mid = schedule_id(&p, &canonical, &request);
    if q.request.as_deref().is_some_and(|r| r != request) {
        return Err(unconfirmed(Status::CONFLICT, Some(&mid)));
    }
    read_receipt(&app, &w, &p, &canonical, &mid, Some(&request)).await
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
    const KEYS: [&str; 7] = [
        "requestID", "expectedRevision", "action", "configuration", "deleteManagedSessions", "retry", "directory",
    ];
    if obj.keys().any(|k| !KEYS.contains(&k.as_str())) {
        return Err(input_invalid());
    }
    let request = obj.get("requestID").and_then(Value::as_str).filter(|s| good(s));
    let revision = obj
        .get("expectedRevision")
        .and_then(Value::as_u64)
        .filter(|r| *r <= 9_007_199_254_740_991);
    let action = obj
        .get("action")
        .and_then(Value::as_str)
        .filter(|a| ACTIONS.contains(a));
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
    mutate(app, id, None, principal, input).await
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
    mutate(app, id, Some(mid), principal, input).await
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
struct Release(Shared, String);
impl Drop for Release {
    fn drop(&mut self) {
        let mut holds = self.0.calendar_holds.lock().unwrap();
        if let Some(hold) = holds.get_mut(&self.1) {
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
    principal: crate::auth::Principal,
    input: Input,
) -> Result<Json<Value>, Error> {
    if app.mission_bridge.is_none() || app.calendar_profile.is_none() {
        return Err(human_required());
    }
    let _gate = app.calendar_slot.lock().await;
    let _path = app.project_mutation.lock().await;
    let (w, project, canonical) = scope(&app, &id, input.directory.as_deref())
        .await
        .map_err(|(status, _)| unconfirmed(status, mid.as_deref()))?;
    let lost = |status: Status, m: &str| unconfirmed(status, Some(m));
    let mid = mid.unwrap_or_else(|| schedule_id(&project, &canonical, &input.request));
    let dir = directory(&w)
        .map_err(|_| lost(Status::SERVICE_UNAVAILABLE, &mid))?
        .to_owned();
    let profile = source(&app).map_err(|_| human_required())?;
    let mut conf = input.configuration.clone();
    if let Some(v) = &mut conf {
        validate_config(v, &dir, &profile, input.action == "create")?;
    }
    let payload = digest(
        conf.as_ref()
            .unwrap_or(&json!({"deleteManagedSessions":input.delete_managed.unwrap_or(false)})),
    );
    let identity = digest(&json!([input.request, input.revision, input.action, payload]));
    let physical = files::host_identity(&w.path)
        .map_err(|_| lost(Status::SERVICE_UNAVAILABLE, &mid))?;
    let existing = app.calendar_holds.lock().unwrap().get(&mid).cloned();
    let mut checking = None;
    if let Some(held) = existing {
        if !held.owned_by(&w, &project, &canonical) {
            return Err(lost(Status::CONFLICT, &mid));
        }
        if !held.dispatched || held.busy {
            return Err(pending(Some(&mid), None));
        }
        if input.action != "check" && held.identity != identity {
            return Err(lost(Status::CONFLICT, &mid));
        }
        let receipt = read_exact(&app, &w, &mid, Some(&held.request)).await?;
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
        let mut holds = app.calendar_holds.lock().unwrap();
        let hold = holds.get_mut(&mid).ok_or_else(|| lost(Status::SERVICE_UNAVAILABLE, &mid))?;
        hold.busy = true;
        if !adopt {
            hold.retried = true;
        }
        checking = adopt.then(|| held.request.clone());
    } else {
        let mut holds = app.calendar_holds.lock().unwrap();
        if holds.len() >= HOLD_CAPACITY {
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
                dispatched: false,
                busy: false,
                retried: false,
            },
        );
    }
    let _release = Release(app.clone(), mid.clone());
    // Stricter than the reference: arm only with the native Automations API
    // and the enabled flag (the plugin itself requires a ready activation).
    if matches!(input.action.as_str(), "play" | "resume" | "run-now")
        && (automation_api(&app).await.map_or(true, |a| a["available"] != true)
            || flag(&app, &w).await.map_or(true, |f| f["enabled"] != true))
        || principal.0.is_cancelled()
    {
        return Err(lost(Status::SERVICE_UNAVAILABLE, &mid));
    }
    let auth_id = format!("cnrs-{}", uuid::Uuid::new_v4());
    let mut proof = json!({"sessionID":auth_id,"workspaceID":id,"requestID":input.request,"location":{"directory":dir},
        "scheduleID":mid,"expectedRevision":input.revision,"action":input.action,"profileSource":profile,"issuedAt":now()});
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
    if let Some(v) = input.delete_managed {
        call["deleteManagedSessions"] = json!(v);
    }
    if input.retry {
        call["retry"] = json!(true);
    }
    if let Some(hold) = app.calendar_holds.lock().unwrap().get_mut(&mid) {
        hold.dispatched = true;
        hold.busy = true;
    }
    app.calendar_claims.lock().unwrap().insert(
        marker.clone(),
        (proof, principal.0.clone(), physical.clone()),
    );
    // An admitted native write runs to completion even if this client leaves;
    // its verification claim lives exactly as long as the write.
    let task = {
        let (app, dir) = (app.clone(), dir.clone());
        tokio::spawn(async move {
            let result = rpc(&app, &dir, "scheduleControl", call, READ).await;
            app.calendar_claims.lock().unwrap().remove(&marker);
            result
        })
    };
    let result = task
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| lost(Status::SERVICE_UNAVAILABLE, &mid))?;
    if principal.0.is_cancelled()
        || files::host_identity(&w.path).ok().as_ref() != Some(&physical)
        || !valid_result(&result, &mid)
    {
        return Err(lost(Status::SERVICE_UNAVAILABLE, &mid));
    }
    if result["refusal"].is_object() {
        let refusal = &result["refusal"];
        let exact = result["pending"] == false
            && refusal["requestID"] == input.request.as_str()
            && refusal["missionID"] == mid.as_str()
            && refusal["action"] == input.action.as_str()
            && refusal["expectedRevision"] == input.revision
            && refusal["payloadDigest"] == payload.as_str();
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
        Some(original) => read_exact(&app, &w, &mid, Some(original)).await?,
        None => result,
    };
    if settle(&app, &w, &project, &canonical, &mid, &result) {
        Ok(Json(result))
    } else {
        Err(pending(Some(&mid), Some(&result)))
    }
}
pub async fn verify(app: &App, session: &str, proof: Value) -> Result<Json<Value>, Error> {
    let issued = proof["issuedAt"].as_u64().ok_or_else(bad)?;
    let marker = proof["digest"].as_str().ok_or_else(bad)?;
    let (record, principal, physical) = app
        .calendar_claims
        .lock()
        .unwrap()
        .get(marker)
        .cloned()
        .ok_or_else(unavailable)?;
    let check = || {
        proof == record
            && proof["sessionID"] == session
            && !principal.is_cancelled()
            && issued <= now() + 5000
            && now().saturating_sub(issued) < 30000
    };
    if !check() {
        return Err(unavailable());
    }
    let id = proof["workspaceID"].as_str().ok_or_else(bad)?;
    let (w, _, _) = scope(app, id, proof["location"]["directory"].as_str()).await?;
    if !check() || files::host_identity(&w.path).ok().as_ref() != Some(&physical) {
        return Err(unavailable());
    }
    Ok(Json(json!({"result":{"admitted":true}})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activation {
    #[serde(rename = "requestID")]
    request: String,
    expected_document_revision: u64,
    directory: Option<String>,
}
pub async fn activation_read(
    State(app): State<Shared>,
    Path((id, mid)): Path<(String, String)>,
    Query(q): Query<Activation>,
) -> Result<Json<Value>, Error> {
    if !good(&mid) || !good(&q.request) || q.expected_document_revision > 9_007_199_254_740_991 {
        return Err(bad());
    }
    let (w, _, _) = scope(&app, &id, q.directory.as_deref()).await?;
    let result = rpc(&app, directory(&w)?, "documentActivation", json!({
        "missionID":mid, "requestID":q.request, "expectedRevision":q.expected_document_revision, "action":"read"
    }), READ).await?;
    if !result["document"]["revision"].is_u64()
        || !result["document"]["scheduleActivation"].is_object()
            && !result["document"]["scheduleActivation"].is_null()
    {
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
    if !good(&mid) || !good(&q.request) {
        return Err(bad());
    }
    let _gate = app.calendar_slot.lock().await;
    let _path = app.project_mutation.lock().await;
    let (w, _, _) = scope(&app, &id, q.directory.as_deref()).await?;
    let old = read_exact(&app, &w, &mid, None).await?;
    let doc = &old["document"];
    let activation = &doc["scheduleActivation"];
    if doc["state"] != "paused" || doc["kind"] != "schedule" || principal.0.is_cancelled() {
        return Err(unavailable());
    }
    let exact = activation["requestID"] == q.request
        && activation["expectedRevision"] == q.expected_document_revision;
    if activation["state"] == "ready" && (exact || doc["revision"] == q.expected_document_revision)
    {
        if flag(&app, &w).await?["enabled"] != true || principal.0.is_cancelled() {
            return Err(unavailable());
        }
        return Ok(Json(json!({"document":doc})));
    }
    if !activation.is_null() || doc["revision"] != q.expected_document_revision {
        return Err(activation_pending());
    }
    if automation_api(&app).await?["available"] != true || flag(&app, &w).await?["enabled"] != true
    {
        return Err(unavailable());
    }
    let dir = directory(&w)?;
    let scope = source(&app)?;
    let authority = digest(&json!(["enabled-fixture", scope, dir]));
    let mut intent = json!({"missionID":mid,"requestID":q.request,"expectedRevision":q.expected_document_revision,"action":"prepare","authority":authority,"targets":[]});
    rpc(&app, dir, "documentActivation", intent.clone(), 65536).await?;
    if principal.0.is_cancelled() || flag(&app, &w).await?["enabled"] != true {
        return Err(activation_pending());
    }
    let obj = intent.as_object_mut().ok_or_else(bad)?;
    obj.remove("authority");
    obj.remove("targets");
    obj.insert("action".into(), json!("ready"));
    obj.insert("effectiveOrigin".into(), Value::Null);
    let result = rpc(&app, dir, "documentActivation", intent, 65536).await?;
    if result["document"]["scheduleActivation"]["state"] != "ready" {
        return Err(activation_pending());
    }
    Ok(Json(result))
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
        assert!(ok(json!({"requestID":"req_1","expectedRevision":2,"action":"delete","deleteManagedSessions":false}), false));
        assert!(!ok(json!({"requestID":"req_1","expectedRevision":2,"action":"stop","deleteManagedSessions":false}), false));
        assert!(ok(json!({"requestID":"req_1","expectedRevision":2,"action":"play","retry":true}), false));
        assert!(!ok(json!({"requestID":"req_1","expectedRevision":2,"action":"play","configuration":{}}), false));
        assert!(ok(json!({"requestID":"req_1","expectedRevision":2,"action":"configure","configuration":{}}), false));
        assert!(!ok(json!({"requestID":"r","expectedRevision":2,"action":"play"}), false), "request ID bound");
        assert!(!ok(json!({"requestID":"req_1","expectedRevision":2,"action":"play","other":1}), false));
        assert!(!ok(json!({"requestID":"req_1","expectedRevision":2,"action":"play","directory":""}), false));
        assert_eq!(parse(json!([]), false).err().unwrap().1.0["code"], "schedule-input-invalid");
    }
}
#[cfg(test)]
#[path = "calendar_admission_tests.rs"]
mod admission_tests;
