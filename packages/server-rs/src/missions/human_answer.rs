//! Session Form replies. Only the native Missions plugin writes and confirms UI marks.
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::http::{Method, StatusCode as Status, request::Parts};
use serde_json::{Value, json};
use tokio::sync::OwnedMutexGuard;
use uuid::Uuid;

use crate::{
    App, Error, Shared, Workspace,
    auth::{Principal, cookies, remote::BrowserDevice, tls::Channel},
    error,
    missions::recurrence_contract::{self as wire, units},
    opencode::{Endpoint, proxy::verify_mutation, read_json, session_record_at, upstream_error},
    settings::profile,
    worktrees,
};

const HEADER: &str = "x-codenomad-human-answer";
const AUTHORITY_MAX: usize = 128 * 1024;
const READ: Duration = Duration::from_secs(5);

fn id(value: &str) -> bool {
    (1..=240).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}

pub(crate) fn form_reply<'a>(route: &'a str, method: &Method) -> Option<&'a str> {
    if method != Method::POST {
        return None;
    }
    let mut parts = route.strip_prefix("/api/session/")?.split('/');
    let session = parts.next()?;
    if matches!(session, "" | "global" | "active") || parts.next()? != "form" {
        return None;
    }
    let form = parts.next()?;
    (id(form) && parts.next() == Some("reply") && parts.next().is_none()).then_some(form)
}

fn answer(body: &Value) -> Option<&Value> {
    let text = |value: &Value| value.as_str().is_some_and(|s| units(s) <= 20_000);
    let fields = body.get("answer")?.as_object()?;
    (body.as_object()?.len() == 1
        && !fields.contains_key("__proto__")
        && fields.values().all(|v| text(v) || v.as_array().is_some_and(|a| a.len() <= 32 && a.iter().all(text))))
    .then(|| &body["answer"])
}

#[derive(Clone)]
enum Human {
    Cookie { key: String, username: String },
    Device(Uuid),
}
impl Human {
    fn from_request(app: &App, head: &Parts) -> Option<Self> {
        if let Some(device) = head.extensions.get::<BrowserDevice>() {
            return Some(Self::Device(device.0));
        }
        if head.extensions.get::<Channel>().is_some() {
            return None;
        }
        let key = cookies(&head.headers, app.auth.cookie_name()).ok()?.0?;
        let username = app.auth.cookie_user(&key).filter(|s| (1..=256).contains(&units(s)))?;
        Some(Self::Cookie { key, username })
    }
    fn current(&self, app: &App) -> bool {
        match self {
            Self::Cookie { key, username } => app.auth.cookie_user(key).as_ref() == Some(username),
            Self::Device(id) => app.devices.as_ref().is_some_and(|d| d.lock().unwrap().is_authorized(*id)),
        }
    }
    fn wire(&self) -> (Value, &str) {
        match self {
            Self::Cookie { key, username } => (json!({"kind":"cookie","sessionID":key}), username),
            Self::Device(id) => (json!({"kind":"remote-device","deviceID":id}), "codenomad"),
        }
    }
}

struct Target {
    workspace: Workspace,
    host_identity: String,
    directory: String,
    directory_identity: String,
    project: String,
    session: String,
    endpoint: Arc<Endpoint>,
}
impl Target {
    fn current(&self, app: &App) -> bool {
        on_connection(app, &self.endpoint)
            && app.workspace(&self.workspace.id.to_string()).is_ok_and(|w| {
                w.path == self.workspace.path
                    && w.location == self.workspace.location
                    && w.created_at == self.workspace.created_at
            })
            && crate::files::host_identity(&self.workspace.path).ok().as_ref() == Some(&self.host_identity)
            && crate::files::host_identity(self.directory.as_ref()).ok().as_ref() == Some(&self.directory_identity)
    }
    fn matches(&self, row: &Value) -> bool {
        row["projectID"] == self.project
            && row["location"]["directory"] == self.directory
            && row["location"].get("workspaceID").is_none()
    }
    async fn fresh(&self, app: &App) -> Option<Value> {
        let row = session_record_at(app, &self.endpoint, &self.session).await.ok()?;
        (self.matches(&row)
            && worktrees::placement(app, &self.workspace, &row["location"]).await.is_ok()
            && self.current(app))
        .then_some(row)
    }
}

fn carrier(row: &Value) -> bool {
    row["id"].as_str().is_some_and(|id| id.starts_with("ses_cn_schedule_"))
        || row["metadata"].get("codenomad.schedule-carrier").is_some()
}

fn on_connection(app: &App, endpoint: &Arc<Endpoint>) -> bool {
    app.native.endpoint().is_some_and(|current| Arc::ptr_eq(&current, endpoint))
}

fn profile_id(app: &App) -> Option<String> {
    profile::scope(&app.settings.location.config).map(|scope| scope.key)
}

struct Admission {
    target: Target,
    principal: Principal,
    human: Human,
    profile: String,
}
impl Admission {
    fn current(&self, app: &App) -> bool {
        self.principal.live().is_ok()
            && self.human.current(app)
            && profile_id(app).as_ref() == Some(&self.profile)
            && self.target.current(app)
    }
}

/// Callback authority is available only for the exact signed, dispatched answer.
/// The map retains its admission for this call only; nothing is persisted.
#[derive(Default)]
pub struct InFlight(Mutex<HashMap<String, Arc<Admission>>>);

struct Claim(Shared, String);
impl Drop for Claim {
    fn drop(&mut self) {
        self.0.human_answer.0.lock().unwrap().remove(&self.1);
    }
}

pub(crate) async fn verify(app: &App, input: &Value) -> Option<()> {
    let secret = app.bridge_token.as_deref()?;
    let body = input.get("command")?;
    if wire::bytes(body) > AUTHORITY_MAX || input["sessionID"] != body["sessionID"] || !fresh(body) {
        return None;
    }
    let proof = wire::sign(body, secret);
    let admit = app.human_answer.0.lock().unwrap().get(&proof)?.clone();
    if !admit.current(app) {
        return None;
    }
    let row = admit.target.fresh(app).await?;
    (!carrier(&row) && admit.current(app) && fresh(body) && app.human_answer.0.lock().unwrap().contains_key(&proof))
        .then_some(())
}

fn fresh(body: &Value) -> bool {
    let now = chrono::Utc::now().timestamp_millis();
    body["issuedAt"].as_i64().is_some_and(|at| at >= 0 && at <= now + 5_000 && at > now - 30_000)
}

async fn rpc(app: &App, t: &Target, method: &str, input: &Value, timeout: Duration) -> Option<Value> {
    let url = t.endpoint.url.join(&format!("/api/rpc/codenomad.missions.human-answer/{method}")).ok()?;
    if !on_connection(app, &t.endpoint) {
        return None;
    }
    let response = app
        .native
        .client
        .post(url)
        .basic_auth("opencode", Some(&t.endpoint.password))
        .query(&[("location[directory]", t.directory.as_str())])
        .json(&json!({"input":input}))
        .timeout(timeout)
        .send()
        .await
        .ok()?;
    if response.status() != Status::OK {
        return None;
    }
    let mut envelope = read_json(response, 16 * 1024).await.ok()?;
    envelope.as_object_mut()?.remove("output")
}

async fn binding(app: &App, admit: &Admission, form: &str) -> Option<Value> {
    let t = &admit.target;
    let mut request = json!({"sessionID":t.session,"formID":form,"profileID":admit.profile,"executionHost":"local"});
    let mut actor = t.session.clone();
    let mut owned = HashSet::new();
    let root = loop {
        if !admit.current(app) || owned.len() > 32 || !owned.insert(actor.clone()) {
            return None;
        }
        let record = session_record_at(app, &t.endpoint, &actor).await.ok()?;
        if !t.matches(&record) || carrier(&record) {
            return None;
        }
        match record.get("parentID").filter(|v| !v.is_null()) {
            Some(parent) => actor = parent.as_str()?.to_owned(),
            None => break record,
        }
    };
    if !root["metadata"]["codenomad.mission"].is_object() {
        request["rootSessionID"] = root["id"].clone();
    }
    let output = rpc(app, t, "binding", &request, READ).await?;
    request.as_object_mut()?.remove("rootSessionID");
    request["projectID"] = json!(t.project);
    request["location"] = json!({"directory":t.directory});
    (output == request).then_some(output)
}

async fn ordinary(app: &App, principal: &Principal, target: &Target) -> Result<bool, Error> {
    principal.live()?;
    let fresh = target.fresh(app).await.ok_or_else(upstream_error)?;
    if carrier(&fresh) {
        return Err(error(Status::FORBIDDEN, "Mission schedule carriers require owned schedule controls"));
    }
    Ok(false)
}

/// Return false only while an ordinary reply can still safely be attempted.
/// Once sent, the plugin RPC is observed independently of the HTTP client.
pub(crate) async fn reply(
    app: &Shared,
    workspace: &Workspace,
    endpoint: &Arc<Endpoint>,
    head: &Parts,
    principal: &Principal,
    row: &Value,
    form: &str,
    input: &Value,
    hold: &mut Option<OwnedMutexGuard<()>>,
) -> Result<bool, Error> {
    let session = row["id"].as_str().ok_or_else(upstream_error)?;
    let directory = row["location"]["directory"].as_str().ok_or_else(upstream_error)?;
    let target = Target {
        workspace: workspace.clone(),
        host_identity: crate::files::host_identity(&workspace.path).map_err(|_| upstream_error())?,
        directory: directory.to_owned(),
        directory_identity: crate::files::host_identity(directory.as_ref()).map_err(|_| upstream_error())?,
        project: row["projectID"].as_str().filter(|s| id(s)).ok_or_else(upstream_error)?.to_owned(),
        session: session.to_owned(),
        endpoint: endpoint.clone(),
    };
    let mut headers = head.headers.get_all(HEADER).iter();
    let requested = headers.next().is_some_and(|h| h == "1") && headers.next().is_none();
    let mark = || {
        Some((
            app.bridge_token.as_deref().filter(|_| crate::automation::published())?,
            Human::from_request(app, head)?,
            profile_id(app)?,
            answer(input)?,
        ))
    };
    let Some((secret, human, profile, answer)) = requested.then(mark).flatten() else {
        return ordinary(app, principal, &target).await;
    };
    let admit = Admission { target, principal: principal.clone(), human, profile };
    let fallback = || async {
        verify_mutation(app, session, directory, row).await?;
        ordinary(app, principal, &admit.target).await
    };
    let Some(mut body) = tokio::time::timeout(Duration::from_secs(8), binding(app, &admit, form)).await.ok().flatten()
    else {
        return fallback().await;
    };
    let (proof_principal, username) = admit.human.wire();
    body["workspaceID"] = json!(workspace.id);
    body["principal"] = proof_principal;
    body["username"] = json!(username);
    body["issuedAt"] = json!(chrono::Utc::now().timestamp_millis());
    body["answer"] = answer.clone();
    if wire::bytes(&body) > AUTHORITY_MAX
        || !admit.target.fresh(app).await.is_some_and(|row| !carrier(&row))
        || !admit.current(app)
    {
        return fallback().await;
    }
    let proof = wire::sign(&body, secret);
    let app = app.clone();
    let guard = hold.take().ok_or_else(upstream_error)?;
    let admit = Arc::new(admit);
    let task = tokio::spawn(async move {
        let _mutation = guard;
        let _claim = Claim(app.clone(), proof.clone());
        app.human_answer.0.lock().unwrap().insert(proof.clone(), admit.clone());
        let output =
            rpc(&app, &admit.target, "reply", &json!({"body":body,"proof":proof}), Duration::from_secs(30)).await;
        output == Some(json!({"status":"answered"}))
    });
    if matches!(task.await, Ok(true)) {
        Ok(true)
    } else {
        Err(error(Status::CONFLICT, "Human answer outcome unavailable; do not replay the native answer"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_session_form_reply_enters_the_mark_path() {
        assert_eq!(form_reply("/api/session/ses_root/form/frm_q/reply", &Method::POST), Some("frm_q"));
        for route in [
            "/api/session/global/form/frm_q/reply",
            "/api/session/active/form/frm_q/reply",
            "/api/session/ses_root/permission/frm_q/reply",
            "/api/session/ses_root/form/frm_q",
        ] {
            assert_eq!(form_reply(route, &Method::POST), None);
        }
    }

    #[test]
    fn answer_validation_preserves_text_and_uses_js_limits() {
        let body = json!({"answer":{"q0":"  café  ", "q1":["β",""]}});
        assert_eq!(answer(&body), body.get("answer"));
        assert!(answer(&json!({"answer":{"q0":"😀".repeat(10_000)}})).is_some());
        for body in [
            json!({"answer":{"q0":"😀".repeat(10_001)}}),
            json!({"answer":{"q0":vec!["";33]}}),
            json!({"answer":{"q0":7}}),
            json!({"answer":{}, "proof":"untrusted"}),
        ] {
            assert!(answer(&body).is_none());
        }
    }

    #[test]
    fn proof_matches_the_typescript_authority_contract() {
        let body = json!({
            "workspaceID":"wk", "projectID":"prj", "formID":"frm_test", "sessionID":"ses_test",
            "profileID":"profile", "executionHost":"local", "location":{"directory":r"C:\fixture"},
            "issuedAt":1700000000000u64, "principal":{"kind":"cookie","sessionID":"fixture-login"},
            "username":"fixture", "answer":{"😀":["choix","\n"], "\u{e000}":" é "}
        });
        assert_eq!(
            wire::sign(&body, "fixture-secret"),
            "604b29489446e6ef4e195399b1abfdf8b7f3b76a7920acf68b7ed2cfa674040c"
        );
    }
}
