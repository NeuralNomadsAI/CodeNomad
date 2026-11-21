use super::{
    bridge::{self, current_root, dir, find, matches_execution, mission, recorded, running, send, session, snapshot},
    creation_admission::{Scope, derived_session},
    recovery,
    run::{autonomous_creation, bad, foreign, held, id, token},
};
use crate::{App, Error, Shared};
use axum::http::{Method, StatusCode as Status};
use serde_json::{Value, json};
use std::sync::LazyLock;

const KEY: &str = "codenomad.mission";

fn identity<'a>(v: &'a Value, field: &str, n: usize) -> Result<&'a str, Error> {
    v[field].as_str().filter(|s| id(s, n)).ok_or_else(bad)
}

fn assignment(m: &Value, t: &Value) -> Option<Value> {
    static PLAYBOOKS: LazyLock<Value> = LazyLock::new(|| {
        serde_json::from_str(include_str!("../../contracts/mission-playbooks-native.json")).expect("bundled playbooks")
    });
    let mid = m["id"].as_str()?;
    let key = t["key"].as_str()?;
    let role = t["role"].as_str()?;
    let recipe = find(&PLAYBOOKS, "playbooks", "id", m["template"].as_str()?)?;
    let generic = find(&PLAYBOOKS, "playbooks", "id", "custom")?;
    let assignment = recipe["prompts"]["roles"][role]["assignment"].as_str();
    let source = assignment.or_else(|| generic["prompts"]["roles"]["specialist"]["assignment"].as_str())?;
    let (head, _) = source.split_once("Return a concise summary, concrete evidence, recommended next steps and any required role artifact through the ordinary native subagent result.")?;
    let mut head = head.replace("You are a native task actor", "You are a visible independent root-session actor");
    if assignment.is_none() {
        // Unknown roles use the Specialist contract but keep the task's actual role.
        let (_, remainder) = head.split_once("\nRole: Specialist (specialist)\n")?;
        let (prefix, _) = head.split_once("\nPlaybook: ")?;
        head = format!("{prefix}\nPlaybook: {}\nRole: Specialist ({role})\n{remainder}", recipe["title"].as_str()?);
    }
    let escape = |v: &Value| v.as_str().map(|s| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;"));
    let values = [
        ("[mission ID]", mid.to_owned()),
        ("[task key]", key.to_owned()),
        ("[blocked by]", {
            let blocked = t["blockedBy"].as_array()?.iter().map(Value::as_str).collect::<Option<Vec<_>>>()?;
            if blocked.is_empty() { "none".into() } else { blocked.join(", ") }
        }),
        ("[objective]", escape(&m["objective"])?),
        ("[task title]", escape(&t["title"])?),
        ("[task brief]", escape(&t["brief"])?),
    ];
    let mut text = String::with_capacity(head.len());
    let mut rest = head.as_str();
    while let Some((prefix, tail)) = rest.split_once('[') {
        text.push_str(prefix);
        rest = &rest[prefix.len()..];
        if let Some((marker, value)) = values.iter().find(|(marker, _)| rest.starts_with(marker)) {
            text.push_str(value);
            rest = &rest[marker.len()..];
        } else {
            text.push('[');
            rest = tail;
        }
    }
    text.push_str(rest);
    text.push_str(&format!("When finished, call mission.report with missionID {mid}, taskKey {key}, an outcome, a concise summary, concrete evidence, and any recommended next steps. Example envelope: {{\"missionID\":\"{mid}\",\"taskKey\":\"{key}\",\"outcome\":\"completed\",\"summary\":\"...\",\"evidence\":[\"...\"],\"next\":[],\"artifact\":{{}},\"final\":false}}; replace artifact with the required role contract. Do not merely describe the report in prose."));
    Some(json!({"sessionID":t["actorSessionId"],"id":t["admissionId"],"text":text,
        "metadata":{KEY:{"version":1,"missionID":mid,"kind":"assignment","taskKey":key,"role":role}},
        "delivery":t["delivery"],"resume":true}))
}

fn expected(m: &Value, kind: &str, meta: &Value) -> Result<(Value, Option<Value>), Error> {
    if !running(m) {
        return Err(foreign());
    }
    if kind == "synthetic" && meta["kind"] == "recovery" {
        return Ok((recovery::input(m, meta)?, None));
    }
    let mid = identity(m, "id", 100)?;
    let task_key = meta["taskKey"].as_str().filter(|s| super::task_sessions::valid_key(s)).ok_or_else(bad)?;
    let task = find(m, "tasks", "key", task_key).ok_or_else(foreign)?;
    if kind == "prompt"
        && meta["kind"] == "assignment"
        && task["status"] == "dispatching"
        && task["executionMode"]["kind"] != "native"
    {
        return Ok((assignment(m, task).ok_or_else(held)?, Some(task["execution"].clone())));
    }
    if kind != "synthetic" || meta["kind"] != "report" {
        return Err(foreign());
    }
    let rid = identity(meta, "reportID", 100)?;
    let report = if task["report"]["id"] == rid {
        &task["report"]
    } else {
        find(task, "lateReports", "id", rid).ok_or_else(foreign)?
    };
    let late = report["late"] == true;
    let prefix = if late { "Late report for retired work" } else { "Mission report received" };
    let description = if late { "Late CodeNomad mission report" } else { "CodeNomad mission report" };
    let field = |f: &str| report[f].as_str().ok_or_else(held);
    let text = format!(
        "{prefix} for “{}” from {}. Outcome: {}.\n\n{}",
        field("taskKey")?,
        field("sessionId")?,
        field("outcome")?,
        field("summary")?
    );
    let id = format!("msg_{}", token(&format!("report\0{rid}"), 28));
    Ok((
        json!({"sessionID":m["coordinatorSessionId"],"id":id,"text":text,"description":description,
        "metadata":{KEY:{"version":1,"missionID":mid,"kind":"report","taskKey":report["taskKey"],"reportID":rid,"fromSessionID":report["sessionId"]}},
        "delivery":"queue","resume":true}),
        None,
    ))
}

pub(super) async fn admit(app: &Shared, mut scope: Scope, co: Value, kind: &str, input: Value) -> Result<Value, Error> {
    let sid = identity(&input, "sessionID", 240)?;
    let metadata = &input["metadata"][KEY];
    let mid = identity(metadata, "missionID", 100)?;
    let recover = metadata["kind"] == "recovery";
    let target = session(app, &scope, sid).await?;
    scope.add_location(app, dir(&target)?).await?;
    let _permit = scope.permit().ok_or_else(held)?;
    let check = || async {
        scope.refresh(app).await?;
        let latest = current_root(app, &scope, &co).await?;
        let current = current_root(app, &scope, &target).await?;
        let s = snapshot(app, &scope).await?;
        if metadata["kind"] == "report" && s["notificationUnavailable"] == true {
            return Err(held());
        }
        let m = mission(&s, mid, &latest)?;
        let (wanted, execution) = expected(m, kind, metadata)?;
        if wanted != input
            || !recorded(m, &current)
            || execution.as_ref().is_some_and(|p| !matches_execution(p, &current))
        {
            return Err(foreign());
        }
        Ok::<_, Error>(current)
    };
    let initial = check().await?;
    if recover {
        recovery::ready(app, &scope, &initial).await?;
    }
    check().await?;
    bridge::sync_environment(app, &scope, sid).await?;
    bridge::sync_memory(app, &scope, &initial).await;
    let fresh = check().await?;
    if recover {
        recovery::ready(app, &scope, &fresh).await?;
        check().await?;
    }
    if kind == "prompt" {
        // Permission-sensitive prompt dispatch joins the ordinary permission
        // refresh service here. A persisted Supervised block may outlive the
        // current new-root preference; do not use the preference to bypass it.
        let may_be_supervised = fresh["permissions"].as_array().is_some_and(|rules| {
            rules.windows(2).any(|rules| {
                rules[0] == json!({"action":"edit","resource":"*","effect":"ask"})
                    && rules[1] == json!({"action":"shell","resource":"*","effect":"ask"})
            })
        });
        if may_be_supervised || fresh.get("permissions").is_some_and(|p| !p.is_array()) {
            return Err(held());
        }
    }
    let mut body = input.clone();
    body.as_object_mut().ok_or_else(bad)?.remove("sessionID");
    send(app, &scope, Method::POST, &format!("/api/session/{sid}/{kind}"), &body).await?;
    Ok(json!({"admitted":true}))
}

async fn managed_contract(app: &App, scope: &Scope, co: &Value, mid: &str, key: &str) -> Result<(Value, Value), Error> {
    let co = current_root(app, scope, co).await?;
    let s = snapshot(app, scope).await?;
    let m = mission(&s, mid, &co)?;
    let task = find(m, "tasks", "key", key).ok_or_else(foreign)?;
    let sid = identity(task, "actorSessionId", 240)?;
    let actor = find(m, "actors", "sessionId", sid).ok_or_else(foreign)?;
    let task_id = task["id"].as_str().ok_or_else(foreign)?;
    if !running(m)
        || task["status"] != "dispatching"
        || task["executionMode"]["kind"] == "native"
        || actor["kind"] != "specialist"
        || actor["managed"] != true
        || actor["location"] != co["location"]
        || !derived_session(sid, &format!("{mid}\0task\0{task_id}"))
    {
        return Err(foreign());
    }
    Ok((task.clone(), actor.clone()))
}

pub(super) async fn create_root(app: &App, scope: Scope, co: Value, request: Value) -> Result<Value, Error> {
    let mid = identity(&request, "missionID", 100)?;
    let key = request["taskKey"].as_str().filter(|s| !s.is_empty() && s.len() <= 100).ok_or_else(bad)?;
    if request.as_object().is_none_or(|o| o.len() != 2) {
        return Err(bad());
    }
    let contract = managed_contract(app, &scope, &co, mid, key).await?;
    let (task, actor) = (&contract.0, &contract.1);
    let sid = identity(actor, "sessionId", 240)?;
    let owner = format!("managed:{}:{mid}", scope.project);
    if app.mission_creations.root_held(&owner, sid) {
        return Err(super::creation_admission::uncertain());
    }
    let permit = scope.permit().ok_or_else(held)?;
    let meta = json!({KEY:{"version":1,"missionID":mid,"kind":"actor","role":task["role"]}});
    let matches = |row: &Value| {
        row["id"] == sid
            && row["projectID"] == scope.project
            && row["parentID"].is_null()
            && row["location"] == actor["location"]
            && row["metadata"][KEY] == meta[KEY]
            && matches_execution(&task["execution"], row)
    };
    let row = match session(app, &scope, sid).await {
        Ok(row) if matches(&row) => row,
        Err(e) if e.0 == Status::NOT_FOUND => {
            let title = actor["title"].as_str().filter(|s| !s.is_empty()).map(str::to_owned).unwrap_or_else(|| {
                format!(
                    "Mission · {}: {}",
                    task["role"].as_str().unwrap_or_default(),
                    task["title"].as_str().unwrap_or_default()
                )
            });
            let mut input = json!({"id":sid,"title":title,"metadata":meta,"location":actor["location"]});
            if let Some(execution) = task["execution"].as_object() {
                for k in ["agent", "model"] {
                    if let Some(value) = execution.get(k) {
                        input[k] = value.clone();
                    }
                }
            }
            if managed_contract(app, &scope, &co, mid, key).await? != contract {
                return Err(foreign());
            }
            autonomous_creation(app)?;
            app.mission_creations.hold_root(&owner, sid, permit)?;
            let body = send(app, &scope, Method::POST, "/api/session", &input)
                .await
                .map_err(|_| super::creation_admission::uncertain())?;
            let row = body.get("data").unwrap_or(&body);
            if !matches(row) {
                return Err(super::creation_admission::uncertain());
            }
            app.mission_creations.release_root(&owner, sid);
            row.clone()
        }
        _ => return Err(foreign()),
    };
    if managed_contract(app, &scope, &co, mid, key).await? != contract {
        return Err(foreign());
    }
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independent_assignment_matches_typescript_for_exact_and_fallback_roles() {
        for (template, role, digest) in [
            ("custom", "specialist", "aa9ec3946eebe08dd846f1f4b52f98426206f8b817c57e053b888427ec55ef84"),
            ("compare", "comparator", "4767d4428803532367afb4b09d643332a0e07b59b9898418531636ac16faad2b"),
            ("debug", "custom-review", "0abca5137d4fbccc4b9d6e6b55a43134fba8d139411d7c3993e8514cdd478e07"),
        ] {
            let m = json!({"id":"msn_fixture","objective":"Keep [task brief] and <context>&","template":template,"taskMode":"independent"});
            let t = json!({"key":"worker-1","title":"Title [mission ID]","brief":"Review the <source>& notes",
                "role":role,"blockedBy":[],"executionMode":{"kind":"independent"}});
            assert_eq!(token(assignment(&m, &t).unwrap()["text"].as_str().unwrap(), 64), digest);
        }
    }

    #[test]
    fn requested_variant_is_preserved_and_the_default_is_equivalent_to_omission() {
        let implicit = json!({"model":{"providerID":"fixture","id":"small"}});
        let default = json!({"model":{"providerID":"fixture","id":"small","variant":"default"}});
        let other = json!({"model":{"providerID":"fixture","id":"small","variant":"high"}});
        assert!(matches_execution(&implicit, &default));
        assert!(!matches_execution(&other, &default));
    }
}
