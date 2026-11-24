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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NativeCall {
    None,
    Active,
    Ended,
    Unknown,
}

fn non_empty(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.trim().is_empty())
}

fn valid_binding(binding: &Value) -> Option<(u64, &str, &str, &str)> {
    let obj = binding.as_object()?;
    let generation = obj
        .get("generation")?
        .as_u64()
        .filter(|&g| (1..=9_007_199_254_740_991).contains(&g))?;
    let parent_sid = obj.get("parentSessionID")?.as_str().filter(|s| !s.trim().is_empty())?;
    let parent_msg = obj.get("parentMessageID")?.as_str().filter(|s| !s.trim().is_empty())?;
    let tool_call = obj.get("toolCallID")?.as_str().filter(|s| !s.trim().is_empty())?;
    Some((generation, parent_sid, parent_msg, tool_call))
}

/// Mirrors TypeScript `missionTaskExecutionEvidence` (`packages/server/src/missions/execution-evidence.ts`).
pub(super) fn execution_evidence(task: &Value) -> (bool, NativeCall, bool) {
    let original = task.get("nativeBinding").filter(|v| !v.is_null());
    let current = task.get("nativeExecution").filter(|v| !v.is_null());
    let mut native_call = NativeCall::None;
    if original.is_some() || current.is_some() {
        native_call = NativeCall::Unknown;
        if let (Some(orig), Some(cur)) = (original, current)
            && let (Some((o_gen, o_psid, o_pmid, o_tcid)), Some((c_gen, c_psid, c_pmid, c_tcid))) =
                (valid_binding(orig), valid_binding(&cur["binding"]))
            && task
                .get("contractGeneration")
                .filter(|v| !v.is_null())
                .is_none_or(|cg| cg.as_u64() == Some(o_gen))
            && c_gen == o_gen
            && c_psid == o_psid
            && (c_tcid == o_tcid) == (c_pmid == o_pmid)
        {
            let conflict = cur.get("observationConflict").is_some_and(|v| v == true);
            let non_foreground = cur
                .get("launch")
                .filter(|v| !v.is_null())
                .is_some_and(|l| l["mode"] != "foreground");
            native_call = if conflict || non_foreground {
                NativeCall::Unknown
            } else if cur.get("ended").is_none_or(Value::is_null) {
                NativeCall::Active
            } else if matches!(cur["ended"].as_str(), Some("returned" | "error")) {
                NativeCall::Ended
            } else {
                NativeCall::Unknown
            };
        }
    }
    let outstanding = task["outstandingExecution"] == true;
    let has_execution = non_empty(&task["actorSessionId"])
        && (outstanding || non_empty(&task["admissionId"]) || original.and_then(valid_binding).is_some());
    let missing_report = has_execution
        && task["report"].is_null()
        && !task["lateReports"].as_array().is_some_and(|a| !a.is_empty())
        && (matches!(task["status"].as_str(), Some("queued" | "dispatching")) || outstanding);
    (has_execution, native_call, missing_report)
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
            let (_, native_call, missing_report) = execution_evidence(task);
            if native_call == NativeCall::Active {
                return Err(refusal("recovery-busy"));
            }
            if native_call == NativeCall::Unknown {
                return Err(refusal("recovery-unknown"));
            }
            if !missing_report {
                return Err(conflict());
            }
            (
                task["actorSessionId"].as_str().filter(|s| !s.trim().is_empty()).ok_or_else(conflict)?,
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

    #[test]
    fn native_task_report_recovery_matches_typescript_execution_evidence() {
        let binding = json!({
            "generation": 1,
            "parentSessionID": "ses_coordinator",
            "toolCallID": "call-one",
            "parentMessageID": "msg-one"
        });
        let base = || {
            json!({
                "id": "msn_fixture",
                "revision": 7,
                "coordinatorSessionId": "ses_coordinator",
                "tasks": [{
                    "key": "validation",
                    "status": "queued",
                    "actorSessionId": "ses_worker",
                    "nativeBinding": binding,
                    "nativeExecution": { "binding": binding, "ended": "returned" }
                }]
            })
        };
        let meta = json!({"revision": 7, "target": "report", "taskKey": "validation"});
        let admitted = input(&base(), &meta).unwrap();
        assert_eq!(admitted["sessionID"], "ses_worker");
        assert_eq!(admitted["id"], format!("msg_{}", token("recovery\0msn_fixture\07\0report\0validation", 28)));

        // Ended with error is also eligible when status is queued/dispatching or outstandingExecution.
        let mut errored = base();
        errored["tasks"][0]["nativeExecution"]["ended"] = json!("error");
        assert_eq!(input(&errored, &meta).unwrap()["sessionID"], "ses_worker");

        // Active continuation -> recovery-busy even if an old report exists.
        let mut active = base();
        active["tasks"][0]["nativeExecution"] = json!({
            "binding": {
                "generation": 1,
                "parentSessionID": "ses_coordinator",
                "toolCallID": "call-two",
                "parentMessageID": "msg-two"
            }
        });
        assert_eq!(input(&active, &meta).unwrap_err().1.0["code"], "recovery-busy");

        // Partial/corrupted/conflicted/background/stale-generation native evidence -> recovery-unknown.
        for mutate_case in [
            Box::new(|m: &mut Value| {
                m["tasks"][0].as_object_mut().unwrap().remove("nativeExecution");
            }) as Box<dyn Fn(&mut Value)>,
            Box::new(|m: &mut Value| {
                m["tasks"][0]["nativeExecution"]["binding"]["generation"] = json!(2);
            }),
            Box::new(|m: &mut Value| {
                m["tasks"][0]["nativeExecution"]["binding"]["parentSessionID"] = json!("ses_other");
            }),
            Box::new(|m: &mut Value| {
                m["tasks"][0]["nativeExecution"]["binding"]["toolCallID"] = json!("call-two");
            }),
            Box::new(|m: &mut Value| {
                m["tasks"][0]["nativeExecution"]["observationConflict"] = json!(true);
            }),
            Box::new(|m: &mut Value| {
                m["tasks"][0]["nativeExecution"]["launch"] = json!({"mode": "background"});
            }),
            Box::new(|m: &mut Value| {
                m["tasks"][0]["contractGeneration"] = json!(2);
            }),
        ] {
            let mut bad = base();
            bad["tasks"][0]["admissionId"] = json!("msg_historical");
            mutate_case(&mut bad);
            assert_eq!(input(&bad, &meta).unwrap_err().1.0["code"], "recovery-unknown");
        }
    }
}
