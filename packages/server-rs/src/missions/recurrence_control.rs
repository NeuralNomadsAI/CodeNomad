//! Authenticated recurrence controls (reference
//! `mission-recurrence-play-preparation.ts`, `-control.ts`,
//! `-control-status.ts`, `-manual.ts`, `-supersede.ts`): physical admission
//! under a held permit, a signed proof the native plugin verifies through the
//! private bridge, one native write that survives a client disconnect, and
//! receipt-only status reads that never resend.
use crate::{
    App, Shared,
    auth::Principal,
    missions::recurrence::{Refused, Scope, fail, integer, query, rpc, scope, still},
    missions::recurrence_contract::{self as contract, SAFE, canonical, control_status, manual_result, rid, same_location},
    missions::recurrence_holds::{self as holds, Admission, Binding, Hold, Owner, Refusal, Request, now},
    missions::schedule_contract::ClaimBinding,
    files,
};
use axum::{
    Extension, Json,
    extract::{Path, RawQuery, State, rejection::JsonRejection},
    http::StatusCode as Status,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const READ: usize = 512 * 1024;
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);

/// The selected profile and its source, keyed like `SettingsService.getProfileScope`.
pub(crate) fn profile(app: &App) -> Option<(Value, Value)> {
    let path = app.calendar_profile.as_ref()?;
    let yaml = path.to_str()?;
    let (channel, identity, key) = if crate::config::serve() {
        let scope = crate::settings::profile::scope(path)?;
        (scope.channel, scope.identity, scope.key)
    } else {
        let channel = "cnrs-recurrence";
        (channel.into(), yaml.into(), contract::sha(&format!("{channel}\0{yaml}")))
    };
    Some((
        json!({"channel":channel,"configIdentity":identity,"key":key}),
        json!({"profileID":key,"executionHost":"local","configYamlPath":yaml}),
    ))
}
fn physical(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if cfg!(windows) { s.to_lowercase() } else { s }
}
/// `resolveRecurrenceRoot`: the Git checkout and family of the owned root.
pub(crate) async fn git_root(s: &Scope) -> Option<Value> {
    let out = crate::git::run(&s.w.path, &["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], 8192)
        .await
        .ok()?
        .ok()
        .ok()?
        .text();
    let mut lines = out.lines();
    let (checkout, common) = (lines.next()?, lines.next()?);
    let checkout = dunce::canonicalize(checkout).ok()?;
    let family = dunce::canonicalize(common).ok()?;
    // The prototype owns workspace roots only: the checkout is that root.
    (checkout == s.w.path).then(|| json!({"mode":"git","directory":s.dir,"family":physical(&family),"checkout":physical(&checkout)}))
}
/// A proof body the native plugin verifies through the private bridge: the
/// claim lives exactly as long as the native write that carries it.
pub(crate) struct Claim(Shared, String);
impl Drop for Claim {
    fn drop(&mut self) {
        self.0.calendar_claims.lock().unwrap().remove(&self.1);
    }
}
pub(crate) fn signed(app: &Shared, mut identity: Value, principal: &Principal, scope: &Scope) -> Option<(Value, Claim)> {
    let key = app.mission_bridge.as_ref()?;
    if !still(app, scope) {
        return None;
    }
    let marker = contract::digest(&identity);
    identity["digest"] = json!(marker);
    let proof = contract::sign(&identity, key);
    app.calendar_claims
        .lock()
        .unwrap()
        .insert(marker.clone(), Arc::new(ClaimBinding {
            proof: identity.clone(), principal: principal.0.clone(), physical: scope.host.clone(),
            project: scope.project.clone(), canonical: scope.canonical.clone(), endpoint: scope.endpoint.clone(),
        }));
    identity["proof"] = json!(proof);
    Some((identity, Claim(app.clone(), marker)))
}
pub(crate) fn auth_id() -> String {
    format!("cnrs-{}", uuid::Uuid::new_v4())
}

pub(crate) struct Input {
    request: Request,
    directory: Option<String>,
    retry: bool,
}
struct Prepared {
    body: Value,
    claim: Claim,
    hold: Hold,
    scope: Scope,
}
/// Any failure strictly before dispatch: this attempt sent nothing.
struct NotSent(Option<Refusal>);
impl From<Refusal> for NotSent {
    fn from(r: Refusal) -> Self {
        NotSent(Some(r))
    }
}
fn sent<T>(v: Option<T>) -> Result<T, NotSent> {
    v.ok_or(NotSent(None))
}
fn identity(q: &Request) -> Value {
    json!({"scheduleID":q.schedule,"requestID":q.request,"action":q.action,"expectedRevision":q.revision})
}
fn with_hint(mut v: Value, hint: Option<u64>) -> Value {
    if let Some(at) = hint {
        v["issuedAt"] = json!(at);
    }
    v
}
/// Exact control status read (never a resend).
async fn control_read(app: &App, scope: &Scope, q: &Request, hint: Option<u64>) -> Option<Value> {
    let read = rpc(app, scope, "recurrenceControlStatus", with_hint(identity(q), hint), READ);
    let v = tokio::time::timeout(STATUS_TIMEOUT, read).await.ok()?.ok()?;
    (control_status(&v)
        && v["scheduleID"] == q.schedule.as_str()
        && v["requestID"] == q.request.as_str()
        && v["expectedRevision"] == q.revision)
        .then_some(v)
}
fn manual_input(q: &Request, hint: Option<u64>) -> Value {
    with_hint(json!({"scheduleID":q.schedule,"requestID":q.request,"expectedRevision":q.revision}), hint)
}
fn manual_exact(v: &Value, q: &Request, dir: &str) -> bool {
    manual_result(v)
        && v["scheduleID"] == q.schedule.as_str()
        && v["requestID"] == q.request.as_str()
        && v["expectedRevision"] == q.revision
        && same_location(&v["location"], dir)
}
/// `readSupersededRecurrenceIntent`: the old intent's exact status, in control shape.
async fn superseded_status(app: &App, scope: &Scope, old: &Request, hint: Option<u64>) -> Option<Value> {
    if old.action != "run-now" {
        return control_read(app, scope, old, hint).await;
    }
    let v = rpc(app, scope, "recurrenceRunNowStatus", manual_input(old, hint), READ).await.ok()?;
    if !manual_exact(&v, old, &scope.dir) {
        return None;
    }
    let mut base = json!({"version":1,"scheduleID":old.schedule,"requestID":old.request,"expectedRevision":old.revision,"action":"run-now"});
    if v["outcome"] == "rejected" {
        base["outcome"] = json!("rejected");
        base["reason"] = v["reason"].clone();
    } else if v["outcome"] == "unknown" && v["passageID"].is_null() {
        base["outcome"] = json!("unknown");
    } else {
        let unknown = v["outcome"] == "unknown";
        base["revision"] = json!(old.revision + 1);
        base["outcome"] = json!(if unknown { "unknown" } else { "committed" });
        base["controlsComplete"] = json!(!unknown);
    }
    Some(base)
}
/// `prepareRecurrenceControl`: physical admission, permit, proofs, signed body.
async fn prepare(app: &Shared, workspace: &str, input: &Input, principal: &Principal) -> Result<Prepared, NotSent> {
    let (_, source) = sent(profile(app))?;
    sent(app.mission_bridge.as_ref())?;
    let s = scope(app, workspace, false).await.map_err(|_| NotSent(None))?;
    files::directory(&s.w, input.directory.as_deref()).map_err(|_| NotSent(None))?;
    let root = sent(git_root(&s).await)?;
    if principal.0.is_cancelled() || !still(app, &s) {
        return Err(NotSent(None));
    }
    let q = &input.request;
    let owner = Owner { workspace: s.id.clone(), project: s.project.clone(), canonical: s.canonical.clone(), checkout: s.host.clone() };
    let binding = Binding {
        workspace: workspace.to_owned(),
        directory: s.dir.clone(),
        request: q.clone(),
        owner: owner.clone(),
        admission: Admission { root: canonical(&root), profile: source["profileID"].as_str().unwrap_or_default().to_owned() },
        issued_at: None,
    };
    let mut hold = holds::hold(binding, input.retry)?;
    if hold.requires_partial_proof {
        let status = sent(control_read(app, &s, q, None).await)?;
        if !still(app, &s) || !hold.confirm_partial(&status) {
            return Err(NotSent(None));
        }
    }
    if let Some((old, hint)) = hold.superseded.clone() {
        let status = sent(superseded_status(app, &s, &old, hint).await)?;
        if !still(app, &s) {
            return Err(NotSent(None));
        }
        if !hold.confirm_superseded(&status, &owner) {
            // A definitive read settles the original permit; this request sends nothing.
            hold.dispose();
            holds::reconcile(workspace, &s.dir, &old, hint, &status);
            return Err(NotSent(None));
        }
    }
    if git_root(&s).await.as_ref() != Some(&root) || !still(app, &s) || principal.0.is_cancelled() {
        return Err(NotSent(None));
    }
    let issued = now();
    let proof = json!({"sessionID":auth_id(),"workspaceID":s.id,"requestID":q.request,"location":{"directory":s.dir},
        "scheduleID":q.schedule,"action":q.action,"expectedRevision":q.revision,"profileSource":source,"issuedAt":issued});
    let (mut body, claim) = sent(signed(app, proof, principal, &s))?;
    hold.issued(issued);
    if input.retry {
        body["retry"] = json!(true);
    }
    Ok(Prepared { body, claim, hold, scope: s })
}
fn refusal_code(reason: &Value) -> &'static str {
    if reason == "revision-conflict" { "recurrence-revision-conflict" } else { "recurrence-control-conflict" }
}
/// `dispatchRecurrenceControl`, detached from the client connection.
async fn dispatch_control(app: Shared, workspace: String, mut p: Prepared, q: Request) -> Option<(Status, Value)> {
    let result = rpc(&app, &p.scope, "recurrenceControl", p.body.clone(), READ).await;
    drop(p.claim);
    if let Ok(r) = result {
        let mut record = r.clone();
        if let Some(o) = record.as_object_mut() {
            o.remove("targetsKnown");
            o.insert("outcome".into(), json!(if r["controlsComplete"] == true { "committed" } else { "unknown" }));
        }
        if r["requestID"] == q.request.as_str()
            && r["scheduleID"] == q.schedule.as_str()
            && r["revision"] == q.revision + 1
            && r["controlsComplete"].is_boolean()
            && control_status(&record)
        {
            if r["controlsComplete"] == false {
                p.hold.partial();
            } else {
                p.hold.settled(true);
            }
            return Some((Status::OK, r));
        }
    }
    let status = control_read(&app, &p.scope, &q, holds::proof_hint(&workspace, &q)).await?;
    if status["outcome"] == "rejected" && status["reason"].is_string() {
        p.hold.settled(false);
        let body = json!({"error":"Recurrence control refused; nothing was applied","code":refusal_code(&status["reason"])});
        return Some((Status::CONFLICT, body));
    }
    if status["outcome"] == "committed"
        && status["controlsComplete"] == true
        && status["revision"] == q.revision + 1
        && contract::state_matches(&q.action, &status["state"])
    {
        p.hold.settled(true);
    } else if status["controlsComplete"] == false {
        p.hold.partial();
    }
    let code = if status["outcome"] == "committed" { Status::OK } else { Status::SERVICE_UNAVAILABLE };
    Some((code, status))
}
/// `dispatchRecurrenceRunNow`, detached from the client connection.
async fn dispatch_run_now(app: Shared, workspace: String, mut p: Prepared, q: Request) -> Option<(Status, Value)> {
    let dir = p.scope.dir.clone();
    let result = rpc(&app, &p.scope, "recurrenceRunNow", p.body.clone(), READ).await;
    drop(p.claim);
    let raw = match result {
        Ok(r) => r,
        Err(()) => {
            let read = rpc(&app, &p.scope, "recurrenceRunNowStatus", manual_input(&q, holds::proof_hint(&workspace, &q)), READ);
            tokio::time::timeout(STATUS_TIMEOUT, read).await.ok()?.ok()?
        }
    };
    if !manual_exact(&raw, &q, &dir) {
        return None;
    }
    if raw["outcome"] != "unknown" {
        p.hold.settled(true);
    }
    if raw["outcome"] == "rejected" && raw["reason"].is_string() {
        let body = json!({"error":"Manual passage refused; nothing was started","code":refusal_code(&raw["reason"])});
        return Some((Status::CONFLICT, body));
    }
    let code = if raw["outcome"] == "unknown" { Status::SERVICE_UNAVAILABLE } else { Status::OK };
    Some((code, raw))
}
fn reply((status, body): (Status, Value)) -> Response {
    (status, Json(body)).into_response()
}
/// Admit, dispatch once and settle; the write and its settlement run to
/// completion even if this client leaves (the reference never aborts them).
async fn admit(app: Shared, workspace: String, input: Input, principal: Principal, uncertain: &'static str) -> Response {
    let not_dispatched = |e: NotSent| match holds::not_dispatched(e.0.as_ref(), &workspace, &input.request.schedule, &input.request.request, input.retry) {
        Some(code) => (
            Status::from_u16(code).unwrap(),
            Json(json!({"error":"Recurrence request refused before dispatch; this attempt sent nothing","code":"recurrence-not-dispatched"})),
        )
            .into_response(),
        None => fail(Status::SERVICE_UNAVAILABLE, uncertain),
    };
    let p = match prepare(&app, &workspace, &input, &principal).await {
        Ok(p) => p,
        Err(e) => return not_dispatched(e),
    };
    if principal.0.is_cancelled() || !still(&app, &p.scope) || !p.hold.dispatched() {
        drop(p);
        return not_dispatched(NotSent(None));
    }
    let q = input.request.clone();
    let task = tokio::spawn(async move {
        if q.action == "run-now" { dispatch_run_now(app, workspace, p, q).await } else { dispatch_control(app, workspace, p, q).await }
    });
    match task.await.ok().flatten() {
        Some(done) => reply(done),
        None => fail(Status::SERVICE_UNAVAILABLE, uncertain),
    }
}

fn body_object(body: Result<Json<Value>, JsonRejection>) -> Option<serde_json::Map<String, Value>> {
    body.ok().and_then(|Json(v)| v.as_object().cloned())
}
fn directory(v: Option<&Value>) -> Result<Option<String>, ()> {
    match v {
        None => Ok(None),
        Some(d) => d.as_str().filter(|d| (1..=4096).contains(&contract::units(d))).map(|d| Some(d.to_owned())).ok_or(()),
    }
}
fn revision(v: Option<&Value>) -> Option<u64> {
    v?.as_u64().filter(|n| *n <= SAFE)
}
/// `POST /missions/recurrence/:s/control` (`recurrenceControlRouteSchema`).
pub async fn control(
    State(app): State<Shared>,
    Path((id, schedule)): Path<(String, String)>,
    Extension(principal): Extension<Principal>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    if !app.auth.human(&principal) {
        return fail(Status::UNAUTHORIZED, "Authenticated human session required");
    }
    let invalid = || fail(Status::BAD_REQUEST, "Invalid exact recurrence control request");
    let Some(mut o) = body_object(body) else { return invalid() };
    o.insert("scheduleID".into(), json!(schedule));
    let allowed = ["scheduleID", "requestID", "action", "expectedRevision", "directory", "retry"];
    let action = o.get("action").and_then(Value::as_str).filter(|a| contract::ACTIONS.contains(a) && *a != "run-now");
    let retry = match o.get("retry") {
        None => Some(false),
        Some(v) => v.as_bool(),
    };
    let (Some(action), Some(retry), Some(rev), Ok(dir)) = (action, retry, revision(o.get("expectedRevision")), directory(o.get("directory")))
    else {
        return invalid();
    };
    let request = o.get("requestID").and_then(Value::as_str).filter(|r| rid(r));
    if o.keys().any(|k| !allowed.contains(&k.as_str()))
        || request.is_none()
        || !rid(&schedule)
        || retry && !matches!(action, "pause" | "stop")
        || id.is_empty()
        || id.len() > 200
    {
        return invalid();
    }
    let request = Request { schedule, request: request.unwrap().to_owned(), action: action.to_owned(), revision: rev };
    admit(app, id, Input { request, directory: dir, retry }, principal, "Recurrence control uncertain; read exact status before another action").await
}
/// `POST /missions/recurrence/:s/run-now`.
pub async fn run_now(
    State(app): State<Shared>,
    Path((id, schedule)): Path<(String, String)>,
    Extension(principal): Extension<Principal>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    if !app.auth.human(&principal) {
        return fail(Status::UNAUTHORIZED, "Human authentication required");
    }
    let invalid = || fail(Status::BAD_REQUEST, "Invalid manual passage request");
    let Some(o) = body_object(body) else { return invalid() };
    let request = o.get("requestID").and_then(Value::as_str).filter(|r| rid(r));
    let (Some(request), Some(rev), Ok(dir)) = (request, revision(o.get("expectedRevision")), directory(o.get("directory"))) else {
        return invalid();
    };
    if o.keys().any(|k| !["expectedRevision", "requestID", "directory"].contains(&k.as_str())) {
        return invalid();
    }
    // The reference refuses an invalid schedule ID at preparation, before any permit.
    if !rid(&schedule) {
        return (
            Status::SERVICE_UNAVAILABLE,
            Json(json!({"error":"Recurrence request refused before dispatch; this attempt sent nothing","code":"recurrence-not-dispatched"})),
        )
            .into_response();
    }
    let request = Request { schedule, request: request.to_owned(), action: "run-now".into(), revision: rev };
    admit(app, id, Input { request, directory: dir, retry: false }, principal, "Manual admission uncertain; read status, do not resend").await
}

/// Ownership and directory of a status read, with the reference refusals.
async fn status_scope(app: &App, id: &str, dir: Option<&str>, foreign: (Status, &str), fallback: &str) -> Result<Scope, Response> {
    if app.workspace(id).is_err() {
        return Err(fail(Status::NOT_FOUND, "Workspace unavailable"));
    }
    let s = match scope(app, id, false).await {
        Ok(s) => s,
        Err(Refused::NotFound) => return Err(fail(Status::NOT_FOUND, "Workspace unavailable")),
        Err(Refused::NotOwned) => return Err(fail(foreign.0, foreign.1)),
        Err(_) => return Err(fail(Status::SERVICE_UNAVAILABLE, fallback)),
    };
    if files::directory(&s.w, dir).is_err() {
        return Err(fail(foreign.0, if foreign.0 == Status::FORBIDDEN { "Location unavailable" } else { fallback }));
    }
    Ok(s)
}
/// `POST /missions/recurrence/:s/control/status`: receipt-only reconciliation.
pub async fn control_status_route(
    State(app): State<Shared>,
    Path((id, schedule)): Path<(String, String)>,
    Extension(principal): Extension<Principal>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    if !app.auth.human(&principal) {
        return fail(Status::UNAUTHORIZED, "Human authentication required");
    }
    let invalid = || fail(Status::BAD_REQUEST, "Invalid exact control status request");
    let Some(o) = body_object(body) else { return invalid() };
    let action = o.get("action").and_then(Value::as_str).filter(|a| contract::ACTIONS.contains(a));
    let request = o.get("requestID").and_then(Value::as_str);
    let (Some(action), Some(request), Some(rev), Ok(dir)) = (action, request, o.get("expectedRevision"), directory(o.get("directory"))) else {
        return invalid();
    };
    if o.keys().any(|k| !["requestID", "action", "expectedRevision", "directory"].contains(&k.as_str())) || !rev.is_number() {
        return invalid();
    }
    let Some(rev) = revision(Some(rev)).filter(|_| rid(request) && rid(&schedule)) else { return invalid() };
    let q = Request { schedule, request: request.to_owned(), action: action.to_owned(), revision: rev };
    let unavailable = || fail(Status::SERVICE_UNAVAILABLE, "Exact recurrence control status unavailable");
    let s = match status_scope(&app, &id, dir.as_deref(), (Status::FORBIDDEN, "Foreign Location"), "Exact recurrence control status unavailable").await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let hint = holds::held_read(&id, &s.dir, &q).then(|| holds::proof_hint(&id, &q)).flatten();
    let Some(result) = control_read(&app, &s, &q, hint).await else { return unavailable() };
    if !still(&app, &s) || !app.auth.human(&principal) {
        return unavailable();
    }
    holds::reconcile(&id, &s.dir, &q, hint, &result);
    Json(result).into_response()
}
/// `GET /missions/recurrence/:s/run-now/status`.
pub async fn run_now_status(
    State(app): State<Shared>,
    Path((id, schedule)): Path<(String, String)>,
    Extension(principal): Extension<Principal>,
    RawQuery(raw): RawQuery,
) -> Response {
    if !app.auth.human(&principal) {
        return fail(Status::UNAUTHORIZED, "Human authentication required");
    }
    let invalid = || fail(Status::BAD_REQUEST, "Invalid manual status request");
    let Some(q) = query(raw.as_deref()) else { return invalid() };
    let (Some(request), Some(rev)) = (q.get("requestID").and_then(Value::as_str), q.get("expectedRevision").and_then(|v| integer(v, 0)))
    else {
        return invalid();
    };
    let dir = match q.get("directory") {
        None => None,
        Some(d) => match directory(Some(d)) {
            Ok(d) => d,
            Err(()) => return invalid(),
        },
    };
    if q.keys().any(|k| !["requestID", "expectedRevision", "directory"].contains(&k.as_str())) || !rid(request) || !rid(&schedule) {
        return invalid();
    }
    let q = Request { schedule, request: request.to_owned(), action: "run-now".into(), revision: rev };
    let unavailable = || fail(Status::SERVICE_UNAVAILABLE, "Manual status unavailable");
    let s = match status_scope(&app, &id, dir.as_deref(), (Status::SERVICE_UNAVAILABLE, "Manual status unavailable"), "Manual status unavailable").await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let hint = holds::held_read(&id, &s.dir, &q).then(|| holds::proof_hint(&id, &q)).flatten();
    let Ok(result) = rpc(&app, &s, "recurrenceRunNowStatus", manual_input(&q, hint), READ).await else { return unavailable() };
    if !manual_exact(&result, &q, &s.dir) || !still(&app, &s) || !app.auth.human(&principal) {
        return unavailable();
    }
    if result["outcome"] != "unknown" {
        let mut receipt = json!({"version":1,"scheduleID":q.schedule,"requestID":q.request,"expectedRevision":q.revision});
        if result["outcome"] == "rejected" && result["reason"].is_string() {
            receipt["outcome"] = json!("rejected");
            receipt["reason"] = result["reason"].clone();
        } else {
            receipt["revision"] = json!(q.revision + 1);
            receipt["outcome"] = json!("committed");
            receipt["controlsComplete"] = json!(true);
        }
        holds::reconcile(&id, &s.dir, &q, hint, &receipt);
    }
    Json(result).into_response()
}
