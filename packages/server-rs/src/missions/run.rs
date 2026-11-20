use crate::{App, Error, Shared, Workspace, error, worktrees::linked, files};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{Method, StatusCode as Status},
    response::{IntoResponse, Response},
    routing::post,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;

const PREFIX: &str = "/api/rpc/codenomad.missions/";
const BRIDGE: &str = "/api/opencode-plugin/automation";
pub async fn playbooks() -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        include_str!("../../contracts/mission-playbooks-native.json"),
    )
        .into_response()
}
fn bad() -> Error {
    error(Status::BAD_REQUEST, "Invalid one-time Mission request")
}
fn foreign() -> Error {
    error(
        Status::FORBIDDEN,
        "Mission does not belong to an open authorized root",
    )
}
fn held() -> Error {
    error(
        Status::SERVICE_UNAVAILABLE,
        "Mission outcome unavailable; reconcile the same request",
    )
}
fn id(s: &str, n: usize) -> bool {
    s.len() <= n && crate::opencode::valid_id(s)
}
fn text(s: &str, n: usize) -> bool {
    !s.trim().is_empty() && s.encode_utf16().count() <= n && !s.contains('\0')
}
fn token(s: &str, n: usize) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))[..n].into()
}
pub fn directory(w: &Workspace) -> Result<&str, Error> {
    w.location["directory"].as_str().ok_or_else(foreign)
}

pub async fn rpc(
    app: &App,
    dir: &str,
    method: &str,
    input: Value,
    max: usize,
) -> Result<Value, Error> {
    let url = app
        .native
        .url()
        .join(&format!("{PREFIX}{method}"))
        .map_err(|_| held())?;
    let res = app
        .native
        .request(Method::POST, url)
        .query(&[("location[directory]", dir)])
        .json(&json!({"input":input}))
        .timeout(std::time::Duration::from_secs(85))
        .send()
        .await
        .map_err(|_| held())?;
    let status = res.status();
    let body = crate::opencode::read_json(res, max).await.map_err(|_| held())?;
    if !status.is_success() {
        // Preserve reviewed reserved conflict/validation codes, not daemon prose.
        let code = body["type"]
            .as_str()
            .or_else(|| body["code"].as_str())
            .unwrap_or_default();
        let public = code.strip_prefix("mission.").unwrap_or(code);
        if crate::bench::missions_run() {
            eprintln!(
                "Mission RPC {method} refused ({status}, {})",
                if public
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                    && public.len() <= 64
                {
                    public
                } else {
                    "opaque"
                }
            );
        }
        if matches!(
            public,
            "stale-revision"
                | "revision-conflict"
                | "request-conflict"
                | "already-member"
                | "mission-not-found"
                | "invalid-execution"
                | "invalid-state"
                | "control-pending"
        ) {
            return Err((
                Status::CONFLICT,
                Json(json!({"error":"Mission request refused","code":public})),
            ));
        }
        return Err(held());
    }
    body.get("output").cloned().ok_or_else(held)
}
pub async fn owner(app: &App, w: &Workspace) -> Result<String, Error> {
    Ok(project_owner(app, w).await?.0)
}

pub async fn project_owner(app: &App, w: &Workspace) -> Result<(String, String), Error> {
    files::root(w)?;
    let dir = directory(w)?;
    let here = linked::native(
        app,
        Method::GET,
        "/api/location",
        &[("location[directory]", dir)],
        None,
        128 * 1024,
    )
    .await?;
    let current = |value: &Value| {
        value
            .as_str()
            .and_then(|p| dunce::canonicalize(p).ok())
            .as_ref()
            == Some(&w.path)
    };
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
async fn snapshot(app: &App, w: &Workspace, project: &str) -> Result<Value, Error> {
    let seen = rpc(app, directory(w)?, "snapshot", json!({}), 4 * 1024 * 1024).await?;
    if seen["projectID"] != project
        || !seen["missions"].is_array()
        || seen["discardedEvents"] != 0
        || seen["controlUnavailable"] == true
    {
        return Err(held());
    }
    Ok(seen)
}
fn map<'a>(s: &'a Value, id: &str) -> Result<&'a Value, Error> {
    s["missions"]
        .as_array()
        .and_then(|r| r.iter().find(|m| m["id"] == id))
        .ok_or_else(foreign)
}
fn ordinary(m: &Value) -> bool {
    let doc = &m["document"];
    let launch = &doc["launch"];
    m["template"] == "custom"
        && m["taskMode"].as_str().is_none_or(|v| v == "native" || v == "independent")
        && (doc.is_null()
            || doc["scheduleActivation"].is_null()
                && if let Some(when) = launch["when"].as_array() {
                    when.is_empty() || when.len() == 1 && when[0]["kind"] == "now"
                } else {
                    launch["timing"]["kind"] == "immediate"
                        && launch["condition"].is_null()
                        && launch["ends"]
                            .as_object()
                            .is_some_and(|e| e.values().all(Value::is_null))
                })
}
fn response_ok(value: &Value, w: &Workspace, project: &str) -> bool {
    value["projectID"] == project
        && value["projectCanonical"]
            .as_str()
            .and_then(|p| dunce::canonicalize(p).ok())
            .as_ref()
            == Some(&w.path)
        && ordinary(value)
}
async fn root_session(
    app: &App,
    w: &Workspace,
    project: &str,
    session: &str,
) -> Result<Value, Error> {
    let row = crate::opencode::session_record(app, session).await?;
    if row["id"] != session
        || row["projectID"] != project
        || !row["parentID"].is_null()
        || row["location"] != json!({"directory":directory(w)?})
    {
        return Err(foreign());
    }
    Ok(row)
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
    Json(q): Json<Create>,
) -> Result<(Status, Json<Value>), Error> {
    if app.mission_bridge.is_none() {
        return Err(held());
    }
    let options = crate::missions::creation_admission::options(
        q.task_mode.as_deref(),
        q.watched_conversation_ids.clone(),
        q.coordinator_session_id.as_deref(),
    )?;
    if q.template != "custom"
        || !id(&q.request_id, 128)
        || !text(&q.objective, 20_000)
        || q.title
            .as_deref()
            .is_some_and(|s| !text(s, 60) || s.contains(['\r', '\n']))
        || q.notes
            .as_deref()
            .is_some_and(|s| s.encode_utf16().count() > 20_000)
        || q.profiles.as_ref().is_some_and(|p| !p.is_object())
    {
        return Err(bad());
    }
    let _lock = app.project_mutation.lock().await;
    let w = app.workspace(&wid)?;
    files::directory(&w, q.directory.as_deref())?;
    let project = owner(&app, &w).await?;
    let dir = directory(&w)?;
    let scope = files::host_identity(&w.path).map_err(|_| foreign())?;
    let mut input = json!({"requestID":q.request_id,"objective":q.objective.trim(),"template":"custom","taskMode":options.task_mode,"prepared":true,
        "expectedCoordinatorLocation":{"directory":dir}});
    if let Some(watched) = &options.watched {
        input["watchedConversationIDs"] = json!(watched);
    }
    if let Some(title) = q.title {
        input["title"] = json!(title.trim());
    }
    if let Some(notes) = q.notes {
        input["notes"] = json!(notes);
    }
    if let Some(profiles) = q.profiles {
        input["profiles"] = profiles;
    }
    if p.0.is_cancelled() {
        return Err(foreign());
    }
    let caps = rpc(&app, dir, "documentCapabilities", json!({}), 65536).await?;
    if caps["version"] != 1
        || files::host_identity(&w.path).ok().as_ref() != Some(&scope)
        || p.0.is_cancelled()
    {
        eprintln!("Mission creation checkpoint refused");
        return Err(held());
    }
    // Reference order: the coordinator is read after the capability check.
    if let Some(session) = &options.coordinator {
        let location = crate::missions::creation_admission::coordinator(&app, &w, &project, session).await?;
        input["coordinatorSessionID"] = json!(session);
        input["expectedCoordinatorLocation"] = location;
    }
    if p.0.is_cancelled() || files::host_identity(&w.path).ok().as_ref() != Some(&scope) {
        return Err(foreign());
    }
    let mission = format!("msn_{}", token(&format!("{project}\0{}", q.request_id), 24));
    let result = crate::missions::creation_admission::create(&app, dir, input, &mission).await?;
    if !response_ok(&result["mission"], &w, &project)
        || result["mission"]["id"] != mission.as_str()
        || result["mission"]["runState"] != "prepared"
        || result["mission"]["taskMode"].as_str().unwrap_or("native") != options.task_mode
        || options.coordinator.as_ref().is_some_and(|c| result["mission"]["coordinatorSessionId"] != c.as_str())
    {
        eprintln!("Mission creation acknowledgement did not match scope or prepared state");
        return Err(crate::missions::creation_admission::uncertain());
    }
    root_session(
        &app,
        &w,
        &project,
        result["mission"]["coordinatorSessionId"]
            .as_str()
            .ok_or_else(held)?,
    )
    .await?;
    Ok((Status::OK, Json(result)))
}
pub async fn creation_receipt(
    State(app): State<Shared>,
    Path((wid, request)): Path<(String, String)>,
) -> Result<Json<Value>, Error> {
    if app.mission_bridge.is_none() || !id(&request, 128) {
        return Err(bad());
    }
    let w = app.workspace(&wid)?;
    let project = owner(&app, &w).await?;
    let lookup = format!("msn_{}", token(&format!("{project}\0{request}"), 24));
    let result = rpc(
        &app,
        directory(&w)?,
        "mission",
        json!({"missionID":lookup}),
        4 * 1024 * 1024,
    )
    .await?;
    if result["projectID"] != project {
        return Err(foreign());
    }
    if let Some(m) = result.get("mission") {
        if m["id"] != lookup || !response_ok(m, &w, &project) {
            return Err(foreign());
        }
        Ok(Json(
            json!({"requestId":request,"state":"created","mission":m}),
        ))
    } else {
        Ok(Json(json!({"requestId":request,"state":"unknown"})))
    }
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
    Json(q): Json<Control>,
) -> Result<Json<Value>, Error> {
    if app.mission_bridge.is_none() {
        return Err(held());
    }
    if !id(&mid, 100)
        || !id(&q.request_id, 128)
        || q.expected_revision == 0
        || q.expected_revision > 9_007_199_254_740_991
        || !matches!(q.action.as_str(), "start" | "pause" | "stop")
        || q.graceful.is_some_and(|v| !v || q.action != "pause")
    {
        return Err(bad());
    }
    let _slot = app.mission_control_slot.acquire().await.unwrap();
    let w = app.workspace(&wid)?;
    let project = owner(&app, &w).await?;
    let seen = snapshot(&app, &w, &project).await?;
    let m = map(&seen, &mid)?;
    if !response_ok(m, &w, &project) {
        return Err(foreign());
    }
    root_session(
        &app,
        &w,
        &project,
        m["coordinatorSessionId"].as_str().ok_or_else(foreign)?,
    )
    .await?;
    let mut input = json!({"missionID":mid,"action":q.action,"requestID":q.request_id,"expectedRevision":q.expected_revision});
    if q.graceful == Some(true) {
        input["graceful"] = json!(true);
    }
    if p.0.is_cancelled() {
        return Err(foreign());
    }
    let result = rpc(&app, directory(&w)?, "lifecycle", input, 4 * 1024 * 1024).await?;
    if !response_ok(&result["mission"], &w, &project) || result["mission"]["id"] != mid {
        return Err(held());
    }
    Ok(Json(result))
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

async fn dispatch(
    State(app): State<Shared>,
    request: axum::extract::Request,
) -> Result<Json<Value>, Error> {
    let Some(secret) = app.mission_bridge.as_ref() else {
        return Err(foreign());
    };
    let headers = request.headers();
    let got = headers
        .get("x-codenomad-automation-token")
        .map(|v| v.as_bytes())
        .unwrap_or_default();
    if got.len() != secret.len()
        || !bool::from(secret.as_bytes().ct_eq(got))
        || headers.keys().any(|k| {
            matches!(
                k.as_str(),
                "origin" | "referer" | "cookie" | "forwarded" | "x-forwarded-for"
            ) || k.as_str().starts_with("sec-")
        })
    {
        return Err(error(Status::UNAUTHORIZED, "Unauthorized Mission bridge"));
    }
    if headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        != Some("application/json")
    {
        return Err(bad());
    }
    let data = axum::body::to_bytes(request.into_body(), 512 * 1024)
        .await
        .map_err(|_| {
            error(
                Status::PAYLOAD_TOO_LARGE,
                "Mission bridge payload too large",
            )
        })?;
    let req: Bridge = serde_json::from_slice(&data).map_err(|_| bad())?;
    if req.mode == "recurrence-control-verify" {
        return crate::missions::calendar::verify(
            &app,
            &req.session_id,
            req.command.ok_or_else(bad)?,
        )
        .await;
    }
    if req.mode.starts_with("memory-") && req.purpose.is_none() {
        return crate::memory::bridge(&app, &req.mode, &req.session_id, req.command).await;
    }
    if !id(&req.session_id, 240) {
        return Err(bad());
    }
    let co = crate::opencode::session_record(&app, &req.session_id).await?;
    let dir = co["location"]["directory"].as_str().ok_or_else(foreign)?;
    let project = co["projectID"].as_str().ok_or_else(foreign)?;
    let w = app
        .inner
        .lock()
        .unwrap()
        .workspaces
        .iter()
        .find(|w| w.location["directory"] == dir)
        .cloned()
        .ok_or_else(foreign)?;
    if !co["parentID"].is_null() || owner(&app, &w).await? != project {
        return Err(foreign());
    }
    if req.mode == "browser-claim"
        && matches!(
            req.purpose.as_deref(),
            Some("mission" | "mission-preferences")
        )
        && req.command.is_none()
    {
        return Ok(Json(json!({"result":{"available":true}})));
    }
    let command: Command =
        serde_json::from_value(req.command.ok_or_else(bad)?).map_err(|_| bad())?;
    if req.mode != "mission-input" {
        return Err(bad());
    }
    if command.kind == "profile-defaults" {
        return Ok(Json(json!({"result":{}})));
    }
    if command.kind != "lifecycle" {
        return Err(error(
            Status::NOT_IMPLEMENTED,
            "Mission bridge operation unavailable",
        ));
    }
    let life: Life = serde_json::from_value(command.input).map_err(|_| bad())?;
    if !id(&life.mid, 100)
        || !id(&life.operation, 100)
        || life.sid != req.session_id
        || life
            .start_text
            .as_deref()
            .is_some_and(|t| !text(t, 250_000))
    {
        return Err(bad());
    }
    let _lock = app.project_mutation.lock().await;
    let s = snapshot(&app, &w, project).await?;
    let m = map(&s, &life.mid)?;
    let op = &m["control"];
    let action = op["action"].as_str().ok_or_else(held)?;
    if !response_ok(m, &w, project)
        || m["coordinatorSessionId"] != life.sid
        || op["id"] != life.operation
        || !op["pending"]
            .as_array()
            .is_some_and(|p| p.contains(&json!(life.sid)))
        || !op["targets"].as_array().is_some_and(|p| {
            p.len() == 1 && p[0]["sessionID"] == life.sid && p[0]["location"] == co["location"]
        })
    {
        return Err(foreign());
    }
    if s["missions"].as_array().unwrap().iter().any(|other| {
        other["id"] != life.mid
            && other["status"] == "active"
            && other["actors"]
                .as_array()
                .is_some_and(|a| a.iter().any(|member| member["sessionId"] == life.sid))
    }) {
        return Err(foreign());
    }
    let checkpoint = || async {
        app.workspace(&w.id.to_string())?;
        root_session(&app, &w, project, &life.sid).await?;
        let latest = snapshot(&app, &w, project).await?;
        let fresh = map(&latest, &life.mid)?;
        if fresh["control"] != *op
            || fresh["runState"] != m["runState"]
            || fresh["document"]["firstPlay"] != m["document"]["firstPlay"]
        {
            return Err(held());
        }
        Ok(())
    };
    let mut ack = json!({"missionID":life.mid,"operationID":life.operation,"sessionID":life.sid,"action":action});
    if action == "start" && m["runState"] == "running" && m["status"] == "active" {
        let frozen = &m["document"]["firstPlay"];
        let first = frozen["operationID"] == life.operation;
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
        } else {
            if first && !frozen["inputDigest"].is_null() {
                return Err(foreign());
            }
            let paused = crate::missions::family::paused_context(
                &app,
                &co,
                &m["tasks"],
                &op["pausedDescendants"],
            )
            .await?;
            format!(
                "Start or resume existing mission {}. Inspect its map and playbook, use saved results, and continue coordination autonomously. Do not create a replacement mission. Resume existing queued assignments rather than duplicate them.{}",
                life.mid, paused
            )
        };
        checkpoint().await?;
        // Explicit empty execution overlay in the isolated benchmark. The
        // provider is configured by the native daemon's own private profile.
        linked::native(
            &app,
            Method::PUT,
            &format!("/api/session/{}/environment", life.sid),
            &[],
            Some(json!({"variables":{}})),
            4096,
        )
        .await?;
        checkpoint().await?;
        let message = format!(
            "msg_{}",
            token(&format!("{}\0resume\0{}", life.operation, life.sid), 28)
        );
        let input = json!({"id":message,"text":route,"description":"CodeNomad mission start/resume","delivery":"queue","resume":true,
            "metadata":{"codenomad.mission":{"version":1,"missionID":life.mid,"kind":"lifecycle","operationID":life.operation}}});
        let result = linked::native(
            &app,
            Method::POST,
            &format!("/api/session/{}/synthetic", life.sid),
            &[],
            Some(input),
            64 * 1024,
        )
        .await?;
        if !result["data"].is_object() {
            return Err(held());
        }
        ack["disposition"] = json!("start-admitted");
        ack["admission"] = result["data"].clone();
    } else if matches!(action, "pause" | "stop") && life.start_text.is_none() {
        if m["runState"]
            != if action == "pause" {
                "paused"
            } else {
                "stopped"
            }
        {
            return Err(foreign());
        }
        let effect = crate::missions::family::apply(&app, &co, action, &life.mid, checkpoint).await?;
        ack.as_object_mut()
            .unwrap()
            .extend(effect.as_object().ok_or_else(held)?.clone());
    } else {
        return Err(foreign());
    }
    Ok(Json(json!({"result":{"nativeAcknowledgement":ack}})))
}

pub fn new_token() -> Option<String> {
    if !crate::bench::missions_run() {
        return None;
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(URL_SAFE_NO_PAD.encode(bytes))
}
pub async fn serve(app: Shared, stop: CancellationToken) -> Result<(), Box<dyn std::error::Error>> {
    let token = app.mission_bridge.as_ref().ok_or("Missing bridge token")?;
    let dir = crate::bench::missions_registry()
        .map(PathBuf::from)
        .ok_or("Missing fixture registry")?;
    // Only publish inside the same private fixture profile as the identity.
    let home = app.data.parent().ok_or("Missing private fixture root")?;
    if !dir.is_absolute()
        || !dir.starts_with(home)
        || dir
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Foreign bridge registry".into());
    }
    crate::auth::tls::private_directory(&dir)?;
    if !dunce::canonicalize(&dir)?.starts_with(dunce::canonicalize(home)?) {
        return Err("Foreign bridge registry".into());
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let time = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
    let pid = std::process::id();
    let record = dir.join(format!("{time}-{pid}-{}.json", &token[..12]));
    let value = json!({"version":1,"url":format!("http://127.0.0.1:{}{BRIDGE}",listener.local_addr()?.port()),"token":token,
        "pid":pid,"startedAt":time});
    crate::auth::tls::write_private(&record, serde_json::to_string(&value)?.as_bytes())?;
    struct Remove(PathBuf);
    impl Drop for Remove {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _record = Remove(record);
    let router = Router::new()
        .route(
            BRIDGE,
            post(dispatch).layer(DefaultBodyLimit::max(512 * 1024)),
        )
        .with_state(app);
    axum::serve(listener, router)
        .with_graceful_shutdown(async move { stop.cancelled().await })
        .await?;
    Ok(())
}
