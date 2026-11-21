use super::{
    activity::{
        native::{Observer, Session, truthy},
        ojson::J,
    },
    creation_admission::Scope,
    run::token,
};
use crate::{App, Error};
use axum::{Json, http::StatusCode as Status};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};
use tokio::time::Instant;

pub(super) fn refusal(code: &'static str) -> Error {
    let (status, message) = match code {
        "recovery-busy" => (Status::CONFLICT, "Native work or a wait prevents targeted recovery"),
        "recovery-conflict" => (Status::CONFLICT, "Mission changed; reload before targeted recovery"),
        _ => (Status::SERVICE_UNAVAILABLE, "Native activity is unknown; recovery was not admitted"),
    };
    (status, Json(json!({"code":code,"error":message})))
}

pub(super) fn input(m: &Value, metadata: &Value) -> Result<Value, Error> {
    let conflict = || refusal("recovery-conflict");
    let mission = m["id"].as_str().ok_or_else(conflict)?;
    let rev = m["revision"].as_u64().filter(|r| *r > 0 && metadata["revision"] == *r).ok_or_else(conflict)?;
    let target = metadata["target"].as_str().ok_or_else(conflict)?;
    let key = metadata["taskKey"].as_str().unwrap_or_default();
    let (sid, text) = match target {
        "coordinator" if metadata.get("taskKey").is_none() => (
            m["coordinatorSessionId"].as_str().ok_or_else(conflict)?,
            format!(
                "Recover coordination of existing mission {mission}. If you had concluded it, the user has resumed it. Inspect its saved map and reports, and use existing results to decide the next step, ask the human through the native question tool when it cannot continue without a person, or finish it as completed when justified. This is not permission to replay assignments, restart validation, or create a replacement mission. Respect unresolved gates, paused/stopped work, permissions and human decisions."
            ),
        ),
        "report" if !key.is_empty() => {
            let task = super::bridge::find(m, "tasks", "key", key).ok_or_else(conflict)?;
            // Native child reports need the plugin's separate invocation
            // authority; this bridge only admits recorded independent roots.
            if !task["nativeBinding"].is_null() || !task["nativeExecution"].is_null() {
                return Err(refusal("recovery-unknown"));
            }
            let admitted = task["admissionId"].as_str().is_some_and(|s| !s.trim().is_empty());
            let outstanding = task["outstandingExecution"] == true;
            if (!admitted && !outstanding)
                || !task["report"].is_null()
                || task["lateReports"].as_array().is_some_and(|a| !a.is_empty())
                || (!outstanding && !matches!(task["status"].as_str(), Some("queued" | "dispatching")))
            {
                return Err(conflict());
            }
            (
                task["actorSessionId"].as_str().ok_or_else(conflict)?,
                format!(
                    "Recover the missing report for task {key} in existing mission {mission}. Inspect the saved mission map and your transcript/tool results first. Record the existing result through mission.report, or report a concrete blocker if the evidence is incomplete. This is not a new assignment: do not rerun completed work, restart validation, or create a replacement task or mission."
                ),
            )
        }
        _ => return Err(conflict()),
    };
    let mut meta = json!({"version":1,"missionID":mission,"kind":"recovery","target":target,"revision":rev});
    if target == "report" {
        meta["taskKey"] = json!(key);
    }
    let id = format!("msg_{}", token(&format!("recovery\0{mission}\0{rev}\0{target}\0{key}"), 28));
    Ok(json!({"sessionID":sid,"id":id,"text":text,"description":"CodeNomad targeted mission recovery",
        "metadata":{"codenomad.mission":meta},"delivery":"queue","resume":true}))
}

pub(super) async fn ready(app: &App, scope: &Scope, row: &Value) -> Result<(), Error> {
    let unknown = || refusal("recovery-unknown");
    let busy = || refusal("recovery-busy");
    let current = || scope.current(app);
    let deadline = Instant::now() + Duration::from_secs(15);
    let obs = Observer::new(app, &scope.workspace, deadline, &current);
    let source: J = serde_json::from_value(row.clone()).map_err(|_| unknown())?;
    let session = Session::read(&source);
    let loc = session.location.as_ref().ok_or_else(unknown)?;
    let family = obs.family(&session).await;
    let active = obs.get("/api/session/active", &[], 256 * 1024, deadline).await.map_err(|_| unknown())?;
    let active = active.get("data").and_then(J::obj).ok_or_else(unknown)?;
    if active.iter().any(|(id, v)| id == &session.id && truthy(v)) {
        return Err(busy());
    }
    let family = match family {
        Ok(family) => family,
        Err(_) => {
            return Err(
                if obs
                    .active_descendant(&session.id, active, &mut HashMap::new(), &mut 256, deadline)
                    .await
                    .unwrap_or(false)
                {
                    busy()
                } else {
                    unknown()
                },
            );
        }
    };
    if active.iter().any(|(id, v)| family.has(id) && truthy(v)) {
        return Err(busy());
    }
    for id in &family.order {
        let id = super::activity::native::component(id).ok_or_else(unknown)?;
        let body =
            obs.get(&format!("/api/session/{id}/inbox"), &[], 512 * 1024, deadline).await.map_err(|_| unknown())?;
        if !body.get("data").and_then(J::arr).ok_or_else(unknown)?.is_empty() {
            return Err(busy());
        }
    }
    for (path, shell) in [("/api/form", false), ("/api/permission/request", false), ("/api/shell", true)] {
        let body = obs
            .get(path, &[("location[directory]", &loc.directory)], 2 * 1024 * 1024, deadline)
            .await
            .map_err(|_| unknown())?;
        if body.get("location").and_then(|l| l.get("directory")).and_then(J::str) != Some(loc.directory.as_str()) {
            return Err(unknown());
        }
        for row in body.get("data").and_then(J::arr).ok_or_else(unknown)? {
            if shell {
                match row.get("status").and_then(J::str) {
                    Some("running") => {
                        let owner = row.get("metadata").and_then(|m| m.get("sessionID")).and_then(J::str);
                        if owner.is_none_or(|id| id.trim().is_empty() || family.has(id)) {
                            return Err(busy());
                        }
                    }
                    Some(_) => {}
                    None => return Err(unknown()),
                }
            } else {
                let owner = row.get("sessionID").and_then(J::str).ok_or_else(unknown)?;
                if owner == "global" || family.has(owner) {
                    return Err(busy());
                }
            }
        }
    }
    if !obs.assert() {
        return Err(unknown());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_requires_the_exact_revision_and_an_outstanding_actor() {
        let m = json!({"id":"msn_fixture","revision":7,"coordinatorSessionId":"ses_coordinator","tasks":[
            {"key":"worker","status":"queued","actorSessionId":"ses_worker","admissionId":"msg_assignment"}
        ]});
        let meta = json!({"revision":7,"target":"report","taskKey":"worker"});
        let first = input(&m, &meta).unwrap();
        assert_eq!(first["sessionID"], "ses_worker");
        assert_eq!(first["id"], format!("msg_{}", token("recovery\0msn_fixture\07\0report\0worker", 28)));
        assert!(input(&m, &json!({"revision":6,"target":"report","taskKey":"worker"})).is_err());
        assert!(input(&m, &json!({"revision":7,"target":"coordinator","taskKey":"worker"})).is_err());
        let mut ended = m;
        ended["tasks"][0]["report"] = json!({"id":"stored"});
        assert!(input(&ended, &meta).is_err());
    }
}
