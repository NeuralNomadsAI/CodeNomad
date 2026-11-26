//! One-time Mission creation options of the reference pipeline
//! (`mission-creation-pipeline.ts`, `mission-creation.ts`): followed
//! conversations, the task mode and an explicit coordinator. Their business
//! policy (catalog, membership, execution, followed sources) stays native.
use crate::{
    App, Error, Workspace, files, opencode,
    shared::js_trim,
    worktrees::{fence, ownership},
};
use axum::{
    Json,
    http::{Method, StatusCode as Status},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

const MAX_OUTCOMES: usize = 128;
type Key = (String, String);

#[derive(Default)]
pub struct Creations(Mutex<BTreeMap<Key, Record>>);

struct Record {
    digest: [u8; 32],
    state: State,
    attempt: Option<Arc<Attempt>>,
    permit: Option<fence::Entered>,
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    Pending,
    Unknown,
    Rejected,
    Created,
}

impl Creations {
    pub(super) fn hold_root(&self, owner: &str, root: &str, permit: fence::Entered) -> Result<(), Error> {
        let key = (owner.to_owned(), root.to_owned());
        self.register(owner, root, &Value::Null)?;
        self.0.lock().unwrap().get_mut(&key).unwrap().permit = Some(permit);
        Ok(())
    }

    pub(super) fn release_root(&self, owner: &str, root: &str) {
        self.0.lock().unwrap().remove(&(owner.to_owned(), root.to_owned()));
    }

    pub(super) fn root_held(&self, owner: &str, root: &str) -> bool {
        self.0.lock().unwrap().contains_key(&(owner.to_owned(), root.to_owned()))
    }

    pub fn register(&self, workspace: &str, request: &str, raw: &Value) -> Result<(), Error> {
        use sha2::{Digest, Sha256};
        let key = (workspace.to_owned(), request.to_owned());
        let digest = Sha256::digest(raw.to_string().as_bytes()).into();
        let mut entries = self.0.lock().unwrap();
        if let Some(previous) = entries.get(&key) {
            if previous.digest != digest {
                return Err((
                    Status::CONFLICT,
                    Json(
                        json!({"error":"Mission creation request conflicts with the original","code":"creation-conflict"}),
                    ),
                ));
            }
            if previous.state != State::Rejected {
                return Err(uncertain());
            }
        } else if entries.len() >= MAX_OUTCOMES {
            let terminal = entries
                .iter()
                .find(|(_, r)| matches!(r.state, State::Created | State::Rejected))
                .map(|(k, _)| k.clone());
            if let Some(key) = terminal {
                entries.remove(&key);
            } else {
                return Err((
                    Status::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"Mission creation outcome capacity exceeded","code":"creation-capacity"})),
                ));
            }
        }
        entries.insert(key, Record { digest, state: State::Pending, attempt: None, permit: None });
        Ok(())
    }

    pub(super) fn dispatched(&self, key: &Key, attempt: Arc<Attempt>, permit: fence::Entered) -> Result<(), Error> {
        let mut entries = self.0.lock().unwrap();
        if entries.iter().any(|(other, record)| {
            other != key
                && record.permit.is_some()
                && record
                    .attempt
                    .as_ref()
                    .is_some_and(|a| a.scope.project == attempt.scope.project && a.mission == attempt.mission)
        }) {
            return Err(uncertain());
        }
        let record = entries.get_mut(key).unwrap();
        record.attempt = Some(attempt);
        record.permit = Some(permit);
        Ok(())
    }

    pub fn finish(&self, key: &Key, result: &Result<Value, Error>) {
        let mut entries = self.0.lock().unwrap();
        let record = entries.get_mut(key).unwrap();
        record.state = match result {
            Ok(_) => State::Created,
            Err(e) if e.1.0["code"] == "creation-uncertain" => State::Unknown,
            Err(_) => State::Rejected,
        };
        if record.state != State::Unknown {
            record.permit = None;
        }
    }

    pub async fn receipt(&self, app: &App, key: &Key) -> Value {
        let _read = fence::serialize(format!("mission-creation-receipt\n{}\n{}", key.0, key.1)).await;
        let unknown = || json!({"requestId":key.1,"state":"unknown"});
        let entry = {
            let entries = self.0.lock().unwrap();
            match entries.get(key) {
                Some(r) if r.state == State::Rejected => return json!({"requestId":key.1,"state":"rejected"}),
                Some(r) if matches!(r.state, State::Unknown | State::Created) => {
                    r.attempt.clone().map(|attempt| (attempt, r.state == State::Unknown))
                }
                _ => None,
            }
        };
        let Some((attempt, recovering)) = entry else { return unknown() };
        let Ok(result) = attempt.receipt(app).await else { return unknown() };
        if recovering {
            // The native creation receipt establishes settlement; present rules
            // only recover local ownership, without writing any native rules.
            let _ = attempt.confirm_permissions(app, &result, true).await;
        }
        if self.settle(key, &attempt) {
            return json!({"requestId":key.1,"state":"created","mission":result});
        }
        unknown()
    }

    fn settle(&self, key: &Key, attempt: &Arc<Attempt>) -> bool {
        let mut entries = self.0.lock().unwrap();
        let Some(record) = entries.get_mut(key).filter(|r| r.attempt.as_ref().is_some_and(|a| Arc::ptr_eq(a, attempt)))
        else {
            return false;
        };
        record.state = State::Created;
        record.permit = None;
        true
    }
}

/// The original connection, workspace occurrence and physical paths are part
/// of the authority, independently of the project ID carried by the RPC.
pub(super) struct Scope {
    pub workspace: Workspace,
    pub endpoint: Arc<opencode::Endpoint>,
    pub project: String,
    pub dir: String,
    canonical: String,
    paths: Vec<(PathBuf, String)>,
    checkouts: Vec<String>,
}

impl Scope {
    pub async fn open(app: &App, workspace: Workspace, requested: Option<&str>) -> Result<Self, Error> {
        let endpoint = app.native.endpoint().ok_or_else(unavailable)?;
        let base = super::run::directory(&workspace)?;
        let (dir, checkout) = owned_path(app, &workspace, requested.unwrap_or(base)).await?;
        let mut scope = Self {
            workspace,
            endpoint,
            project: String::new(),
            dir,
            canonical: String::new(),
            paths: vec![],
            checkouts: vec![],
        };
        scope.capture(&scope.workspace.path.clone())?;
        scope.capture_location(&scope.dir.clone(), &checkout)?;
        let base = super::run::directory(&scope.workspace)?;
        (scope.project, scope.canonical) = scope.project_at(app, base).await?;
        if scope.dir != base && !scope.owns_project(app, &scope.dir).await? {
            return Err((Status::FORBIDDEN, Json(json!({"error":"Mission directory belongs to another project"}))));
        }
        super::reads::active_plugin(app, &scope.endpoint, &scope.dir).await.map_err(|_| unavailable())?;
        if !scope.current(app) {
            return Err(unavailable());
        }
        Ok(scope)
    }

    async fn project_at(&self, app: &App, dir: &str) -> Result<(String, String), Error> {
        let response = app
            .native
            .client
            .get(self.endpoint.url.join("/api/location").map_err(|_| unavailable())?)
            .basic_auth("opencode", Some(&self.endpoint.password))
            .query(&[("location[directory]", dir)])
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| unavailable())?;
        let resolved = opencode::read_json(response.error_for_status().map_err(|_| unavailable())?, 128 * 1024)
            .await
            .map_err(|_| unavailable())?;
        if !same_directory(&resolved, &json!({"directory":dir})) {
            return Err((
                Status::FORBIDDEN,
                Json(json!({"error":"Native mission location differs from owned directory"})),
            ));
        }
        let id = resolved["project"]["id"].as_str().filter(|id| !id.is_empty()).ok_or_else(unavailable)?;
        let canonical = resolved["project"]["canonical"].as_str().filter(|p| !p.is_empty()).ok_or_else(unavailable)?;
        Ok((id.to_owned(), fence::normalize(canonical)))
    }

    async fn owns_project(&self, app: &App, dir: &str) -> Result<bool, Error> {
        let (id, canonical) = self.project_at(app, dir).await?;
        Ok(id == self.project && canonical == self.canonical)
    }

    pub async fn refresh(&self, app: &App) -> Result<(), Error> {
        if self.current(app) && self.owns_project(app, &self.dir).await? && self.current(app) {
            Ok(())
        } else {
            Err(unavailable())
        }
    }

    fn capture(&mut self, path: &Path) -> Result<(), Error> {
        self.paths.push((path.to_owned(), files::host_identity(path).map_err(|_| unavailable())?));
        Ok(())
    }

    fn capture_location(&mut self, dir: &str, checkout: &Path) -> Result<(), Error> {
        self.capture(Path::new(dir))?;
        self.capture(checkout)?;
        self.checkouts.push(fence::identity(checkout));
        Ok(())
    }

    pub async fn attach(&mut self, app: &App, id: &str) -> Result<Value, Error> {
        let row = opencode::session_record(app, id).await.map_err(|_| unavailable())?;
        let location = &row["location"];
        let dir = location["directory"]
            .as_str()
            .filter(|_| location.get("workspaceID").is_none())
            .ok_or_else(foreign_coordinator)?;
        if !row["parentID"].is_null() || row["projectID"] != self.project {
            return Err(foreign_coordinator());
        }
        self.add_location(app, dir).await.map_err(|_| foreign_coordinator())?;
        Ok(location.clone())
    }

    pub async fn add_location(&mut self, app: &App, dir: &str) -> Result<(), Error> {
        if dir == self.dir {
            return Ok(());
        }
        let (_, checkout) = owned_path(app, &self.workspace, dir).await?;
        if !self.owns_project(app, dir).await? {
            return Err(foreign_coordinator());
        }
        self.capture_location(dir, &checkout)
    }

    pub fn current(&self, app: &App) -> bool {
        app.native.endpoint().is_some_and(|p| Arc::ptr_eq(&p, &self.endpoint))
            && app.workspace(&self.workspace.id.to_string()).is_ok_and(|w| {
                w.path == self.workspace.path
                    && w.location == self.workspace.location
                    && w.created_at == self.workspace.created_at
            })
            && self.paths.iter().all(|(path, id)| files::host_identity(path).as_ref().ok() == Some(id))
    }

    pub fn permit(&self) -> Option<fence::Entered> {
        fence::enter(&self.checkouts)
    }

    pub async fn call(
        &self,
        app: &App,
        method: &str,
        input: &Value,
        seconds: u64,
        max: usize,
    ) -> Result<(Status, Value), Error> {
        self.request(
            app,
            Method::POST,
            &format!("/api/rpc/codenomad.missions/{method}"),
            &[("location[directory]", self.dir.as_str())],
            Some(&json!({"input":input})),
            seconds,
            max,
        )
        .await
    }

    pub async fn request(
        &self,
        app: &App,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        input: Option<&Value>,
        seconds: u64,
        max: usize,
    ) -> Result<(Status, Value), Error> {
        let url = self.endpoint.url.join(path).map_err(|_| unavailable())?;
        if !self.current(app) {
            return Err(unavailable());
        }
        let request = app
            .native
            .client
            .request(method, url)
            .basic_auth("opencode", Some(&self.endpoint.password))
            .query(query)
            .timeout(Duration::from_secs(seconds));
        let request = if let Some(input) = input { request.json(input) } else { request };
        let res = request.send().await.map_err(|_| unavailable())?;
        let status = res.status();
        let body = if status == Status::NO_CONTENT {
            Value::Null
        } else {
            opencode::read_json(res, max).await.map_err(|_| unavailable())?
        };
        if !self.current(app) {
            return Err(unavailable());
        }
        Ok((status, body))
    }
}

async fn owned_path(app: &App, workspace: &Workspace, dir: &str) -> Result<(String, PathBuf), Error> {
    let owned = if files::paths::local_absolute(dir) { ownership::resolve(app, workspace, dir).await } else { None };
    owned
        .map(|o| (o.directory, o.checkout))
        .ok_or_else(|| (Status::FORBIDDEN, Json(json!({"error":"Mission directory does not belong to workspace"}))))
}

fn same_directory(a: &Value, b: &Value) -> bool {
    let dir = |v: &Value| v["directory"].as_str().filter(|p| files::paths::local_absolute(p)).map(fence::normalize);
    a.get("workspaceID").is_none() && b.get("workspaceID").is_none() && dir(a).is_some_and(|p| Some(p) == dir(b))
}

pub(super) struct Attempt {
    pub scope: Scope,
    pub input: Value,
    pub mission: String,
}

impl Attempt {
    pub async fn confirm_permissions(&self, app: &App, mission: &Value, recovering: bool) -> Result<(), Error> {
        if let Some(block) = self.input.get("permissions") {
            let coordinator = mission["coordinatorSessionId"].as_str().ok_or_else(uncertain)?;
            crate::sessions::permission_mode::confirm_root(
                app,
                &self.scope.endpoint,
                &self.scope.dir,
                &self.scope.project,
                coordinator,
                block,
                recovering,
                || self.scope.current(app),
            )
            .await
            .map_err(|_| uncertain())?;
        }
        Ok(())
    }

    fn matches(&self, m: &Value) -> bool {
        let Some(coordinator) = m["coordinatorSessionId"].as_str() else { return false };
        m["id"] == self.mission
            && m["projectID"] == self.scope.project
            && coordinator_matches(self.input["coordinatorSessionID"].as_str(), coordinator, &self.mission)
    }

    pub fn acknowledgement(&self, result: &Value) -> bool {
        let m = &result["mission"];
        self.matches(m)
            && matches!(result["acknowledgement"].as_str(), Some("fresh" | "recovered"))
            && m["template"] == self.input["template"]
            && m["title"] == self.input["title"]
            && (result["acknowledgement"] == "recovered" || m["runState"] == "prepared")
            && m["taskMode"].as_str().unwrap_or("native") == self.input["taskMode"]
            && m["profiles"] == self.input["profiles"]
            && match self.input.get("preparedBy") {
                Some(author) => {
                    m["preparedBy"]["missionId"] == author["missionID"]
                        && m["preparedBy"]["coordinatorSessionId"] == author["coordinatorSessionID"]
                }
                None => m["preparedBy"].is_null(),
            }
            && m["actors"].as_array().is_some_and(|actors| {
                actors.iter().any(|a| {
                    a["sessionId"] == m["coordinatorSessionId"]
                        && a["kind"] == "coordinator"
                        && same_directory(&a["location"], &self.input["expectedCoordinatorLocation"])
                })
            })
    }

    async fn receipt(&self, app: &App) -> Result<Value, Error> {
        self.scope.refresh(app).await?;
        let (status, body) = self.scope.call(app, "creationReceipt", &self.input, 10, 4 * 1024 * 1024).await?;
        if !status.is_success() || self.scope.refresh(app).await.is_err() {
            return Err(uncertain());
        }
        self.exact_receipt(&body["output"]).cloned().ok_or_else(uncertain)
    }

    fn exact_receipt<'a>(&self, output: &'a Value) -> Option<&'a Value> {
        let m = &output["mission"];
        (output["requestID"] == self.input["requestID"] && output["projectID"] == self.scope.project && self.matches(m))
            .then_some(m)
    }

    pub async fn create(&self, app: &App) -> Result<Value, Error> {
        let (status, body) =
            self.scope.call(app, "create", &self.input, 85, 4 * 1024 * 1024).await.map_err(|_| uncertain())?;
        if !status.is_success() {
            let request = self.input["requestID"].as_str().unwrap_or_default();
            return Err(if no_effect(&body, request, &self.mission) { rejection(&body) } else { None }
                .unwrap_or_else(uncertain));
        }
        body.get("output").cloned().ok_or_else(uncertain)
    }
}

fn coordinator_matches(explicit: Option<&str>, id: &str, mission: &str) -> bool {
    if let Some(explicit) = explicit {
        return explicit == id;
    }
    derived_session(id, &format!("{mission}\0coordinator"))
}

pub(super) fn derived_session(id: &str, seed: &str) -> bool {
    let Some(suffix) = id
        .strip_prefix("ses_")
        .filter(|s| s.len() == 26 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    else {
        return false;
    };
    suffix[12..] == super::run::token(seed, 14) || suffix == super::run::token(seed, 26)
}

/// `missionCreationRequestSchema` refusal.
pub fn invalid() -> Error {
    (Status::BAD_REQUEST, Json(json!({"error":"Invalid mission creation request"})))
}
/// A preparation failure that is not a declared refusal.
pub fn unavailable() -> Error {
    (Status::SERVICE_UNAVAILABLE, Json(json!({"error":"Mission creation unavailable","code":"creation-unavailable"})))
}
fn foreign_coordinator() -> Error {
    (Status::FORBIDDEN, Json(json!({"error":"Coordinator session does not belong to workspace project"})))
}

/// `nativeDocumentID`: 1–240 characters of `[A-Za-z0-9_.:-]`.
pub(super) fn native_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 240
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}
pub struct Options {
    pub task_mode: &'static str,
    pub watched: Option<Vec<String>>,
    pub coordinator: Option<String>,
}
/// The schema's `taskMode`, `watchedConversationIDs` and trimmed `coordinatorSessionId`.
pub fn options(
    task_mode: Option<&str>,
    watched: Option<Vec<String>>,
    coordinator: Option<&str>,
) -> Result<Options, Error> {
    let task_mode = match task_mode {
        None | Some("native") => "native",
        Some("independent") => "independent",
        Some(_) => return Err(invalid()),
    };
    if let Some(ids) = &watched {
        let unique = ids.iter().enumerate().all(|(i, x)| !ids[..i].contains(x));
        if ids.len() > 32 || !unique || !ids.iter().all(|id| native_id(id)) {
            return Err(invalid());
        }
    }
    let coordinator = match coordinator.map(js_trim) {
        None => None,
        Some(c) if c.is_empty() || c.chars().count() > 240 => return Err(invalid()),
        Some(c) => Some(c.to_owned()),
    };
    Ok(Options { task_mode, watched, coordinator })
}

/// `missionMutationStatus`: declared native rejections and their statuses.
fn rejection_status(code: &str) -> Option<Status> {
    Some(match code {
        "control-pending" | "cleanup-pending" | "recovery-unknown" => Status::SERVICE_UNAVAILABLE,
        "document-unavailable"
        | "control-conflict"
        | "recovery-conflict"
        | "recovery-busy"
        | "mission-not-running"
        | "revision-conflict"
        | "request-conflict"
        | "already-member"
        | "mission-finished" => Status::CONFLICT,
        "invalid-delete-option" | "invalid-execution" => Status::BAD_REQUEST,
        "mission-not-found" | "mission-deleted" | "session-not-found" => Status::NOT_FOUND,
        "foreign-session" | "child-session" => Status::FORBIDDEN,
        _ => return None,
    })
}
/// `readMissionMutationError` over the native RPC error body.
pub fn rejection(body: &Value) -> Option<Error> {
    let code = body["data"]["code"].as_str()?;
    let message = body["message"].as_str()?;
    if body["type"] != "mission.rejected" || message.encode_utf16().count() > 4096 {
        return None;
    }
    let status = rejection_status(code)?;
    Some((status, Json(json!({"error":message,"code":code}))))
}

/// A dispatched creation without its exact acknowledgement or no-effect proof.
pub fn uncertain() -> Error {
    (
        Status::CONFLICT,
        Json(
            json!({"error":"Mission creation settlement is unknown; deletion remains blocked","code":"creation-uncertain"}),
        ),
    )
}
/// `isMissionCreateNoEffectError`: the exact request-conflict receipt of this request.
fn no_effect(body: &Value, request: &str, mission: &str) -> bool {
    let receipt = &body["data"]["noEffect"];
    body["data"]["code"] == "request-conflict"
        && receipt.as_object().is_some_and(|r| r.len() == 2)
        && receipt["requestID"] == request
        && receipt["missionID"] == mission
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_options_follow_the_reference_schema() {
        let ok = |m: Option<&str>, w: Option<Vec<&str>>, c: Option<&str>| {
            options(m, w.map(|w| w.into_iter().map(str::to_owned).collect()), c).is_ok()
        };
        assert!(ok(None, None, None));
        assert!(ok(Some("independent"), Some(vec!["ses_a", "ses.b:c-d"]), Some("  ses_x  ")));
        assert_eq!(options(None, None, Some(" ses_x ")).ok().unwrap().coordinator.as_deref(), Some("ses_x"));
        assert!(!ok(Some("other"), None, None));
        assert!(!ok(None, Some(vec!["ses_a", "ses_a"]), None), "unique");
        assert!(!ok(None, Some(vec!["bad/id"]), None));
        assert!(!ok(None, Some(vec![""]), None));
        assert!(!ok(None, Some(vec![" ses_a "]), None), "followed IDs are not trimmed");
        let many: Vec<String> = (0..33).map(|i| format!("ses_{i}")).collect();
        assert!(options(None, Some(many[..32].to_vec()), None).is_ok());
        assert!(options(None, Some(many), None).is_err());
        assert!(!ok(None, None, Some("   ")));
        assert!(!ok(None, None, Some(&"x".repeat(241))));
        assert_eq!(invalid().1.0, json!({"error":"Invalid mission creation request"}));
    }

    #[test]
    fn declared_native_rejections_keep_their_status_message_and_code() {
        let body = |code: &str| json!({"type":"mission.rejected","message":"Coordinator session already belongs to an active mission","data":{"code":code}});
        let (status, Json(value)) = rejection(&body("already-member")).unwrap();
        assert_eq!(status, Status::CONFLICT);
        assert_eq!(
            value,
            json!({"error":"Coordinator session already belongs to an active mission","code":"already-member"})
        );
        assert_eq!(rejection(&body("invalid-execution")).unwrap().0, Status::BAD_REQUEST);
        assert_eq!(rejection(&body("child-session")).unwrap().0, Status::FORBIDDEN);
        assert_eq!(rejection(&body("session-not-found")).unwrap().0, Status::NOT_FOUND);
        assert!(rejection(&body("unknown-code")).is_none());
        assert!(rejection(&json!({"type":"rpc.internal","message":"x","data":{"code":"already-member"}})).is_none());
        assert!(rejection(&json!({"type":"mission.rejected","data":{"code":"already-member"}})).is_none());
    }

    #[test]
    fn only_an_exact_no_effect_receipt_is_a_refusal_after_dispatch() {
        let body = |receipt: Value| {
            json!({"type":"mission.rejected","message":"Mission request conflict",
            "data":{"code":"request-conflict","noEffect":receipt}})
        };
        assert!(no_effect(&body(json!({"requestID":"req","missionID":"msn_a"})), "req", "msn_a"));
        assert!(!no_effect(&body(json!({"requestID":"req","missionID":"msn_b"})), "req", "msn_a"));
        assert!(!no_effect(&body(json!({"requestID":"other","missionID":"msn_a"})), "req", "msn_a"));
        assert!(!no_effect(&body(json!({"requestID":"req","missionID":"msn_a","extra":1})), "req", "msn_a"));
        let member = json!({"type":"mission.rejected","message":"x","data":{"code":"already-member"}});
        assert!(!no_effect(&member, "req", "msn_a"), "a declared rejection after dispatch stays uncertain");
        assert_eq!(uncertain().1.0["code"], "creation-uncertain");
    }

    fn attempt() -> Arc<Attempt> {
        let dir = if cfg!(windows) { "C:/fixture" } else { "/fixture" };
        Arc::new(Attempt {
            scope: Scope {
                workspace: Workspace {
                    id: uuid::Uuid::nil(),
                    request_id: None,
                    path: "fixture".into(),
                    name: None,
                    status: "ready",
                    proxy_path: String::new(),
                    binary_id: PathBuf::new(),
                    binary_label: String::new(),
                    created_at: String::new(),
                    updated_at: String::new(),
                    location: json!({"directory":dir}),
                    temporary: None,
                },
                endpoint: Arc::new(opencode::Endpoint {
                    url: "http://127.0.0.1:1/".parse().unwrap(),
                    password: "fixture".into(),
                    version: String::new(),
                    pid: 0,
                }),
                project: "fixture-project".into(),
                dir: dir.into(),
                canonical: dir.into(),
                paths: vec![],
                checkouts: vec![],
            },
            input: json!({"requestID":"original","coordinatorSessionID":"ses_exact","template":"debug","title":"Fixture",
                "taskMode":"native","expectedCoordinatorLocation":{"directory":dir}}),
            mission: "msn_fixture".into(),
        })
    }

    #[test]
    fn exact_creation_receipt_needs_the_retained_request_project_mission_and_coordinator() {
        let a = attempt();
        let proof = json!({"requestID":"original","projectID":"fixture-project","mission":{
            "id":"msn_fixture","projectID":"fixture-project","coordinatorSessionId":"ses_exact","runState":"running"
        }});
        assert!(a.exact_receipt(&proof).is_some(), "a valid receipt may describe a later run state");
        let mut wrong = proof.clone();
        wrong["requestID"] = json!("different");
        assert!(a.exact_receipt(&wrong).is_none());
        wrong = proof.clone();
        wrong["mission"]["coordinatorSessionId"] = json!("ses_other");
        assert!(a.exact_receipt(&wrong).is_none());
        assert!(a.exact_receipt(&json!({"mission":proof["mission"]})).is_none(), "a display map isn't a receipt");
        assert!(coordinator_matches(
            None,
            &format!("ses_000000000000{}", super::super::run::token("msn_fixture\0coordinator", 14)),
            "msn_fixture"
        ));
        assert!(!coordinator_matches(None, "ses_00000000000011111111111111", "msn_fixture"));
    }

    #[test]
    fn creation_acknowledgement_needs_its_exact_prepared_profile_and_actor() {
        let a = attempt();
        let mut result = json!({"acknowledgement":"fresh","mission":{
            "id":"msn_fixture","projectID":"fixture-project","coordinatorSessionId":"ses_exact","runState":"prepared",
            "template":"debug","title":"Fixture","actors":[{"sessionId":"ses_exact","kind":"coordinator","location":{"directory":a.scope.dir}}]
        }});
        assert!(a.acknowledgement(&result));
        result["mission"]["actors"][0]["location"]["workspaceID"] = json!("other");
        assert!(!a.acknowledgement(&result));
    }

    #[tokio::test]
    async fn only_the_original_settlement_releases_an_uncertain_creation_fence() {
        use std::{
            future::Future,
            task::{Context, Waker},
        };
        let requests = Creations::default();
        let key = ("workspace".to_owned(), "original".to_owned());
        let dir = vec!["/fixture-mission-fence/checkout".to_owned()];
        let raw = json!({"title":"Original"});
        requests.register(&key.0, &key.1, &raw).unwrap();
        let a = attempt();
        requests.dispatched(&key, Arc::clone(&a), fence::enter(&dir).unwrap()).unwrap();
        requests.finish(&key, &Err(uncertain()));
        assert_eq!(requests.register(&key.0, &key.1, &raw).unwrap_err().1.0["code"], "creation-uncertain");
        assert_eq!(
            requests.register(&key.0, &key.1, &json!({"title":"Changed"})).unwrap_err().1.0["code"],
            "creation-conflict"
        );
        assert!(!requests.settle(&key, &attempt()));
        let mut deletion = std::pin::pin!(fence::block(&dir));
        assert!(deletion.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
        assert!(requests.settle(&key, &a));
        assert!(deletion.await.is_ok());
    }

    #[test]
    fn unknown_creation_outcomes_never_make_room_for_another_request() {
        let requests = Creations::default();
        for i in 0..MAX_OUTCOMES {
            let key = ("fixture".to_owned(), i.to_string());
            requests.register(&key.0, &key.1, &Value::Null).unwrap();
            requests.finish(&key, &Err(uncertain()));
        }
        assert_eq!(
            requests.register("fixture", "overflow", &Value::Null).unwrap_err().1.0["code"],
            "creation-capacity"
        );
        requests.finish(&("fixture".into(), "0".into()), &Err(invalid()));
        requests.register("fixture", "overflow", &Value::Null).unwrap();
    }
}
