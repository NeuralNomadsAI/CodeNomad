use super::{
    bridge::{current_root, find, mission, snapshot},
    creation_admission::Scope,
    run::{bad, foreign, held, id},
};
use crate::{App, Error};
use axum::{
    Json,
    http::{Method, StatusCode as Status},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    time::Duration,
};
use tokio::time::Instant;

const INTERRUPT_BUDGET: Duration = Duration::from_secs(45);

pub(super) fn valid_key(key: &str) -> bool {
    (2..=64).contains(&key.len())
        && key.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

fn proves_task(prompt: &str, mid: &str, key: &str) -> bool {
    // The reference takes only the first header, including when the
    // coordinator wraps it in surrounding instructions.
    let text = prompt.replace("\r\n", "\n");
    let mut lines = text.split('\n').skip_while(|l| *l != "# CodeNomad Mission Assignment");
    let actor = |line: &str| {
        ["native task actor", "visible independent root-session actor"]
            .iter()
            .any(|actor| line.strip_prefix(&format!("You are a {actor} in mission ")) == Some(&format!("{mid}.")))
    };
    let valid = lines.next().is_some()
        && lines.next() == Some("")
        && lines.next().is_some_and(actor)
        && lines.next() == Some("")
        && lines.next().is_some_and(|l| l.starts_with("Playbook: "))
        && lines.next().is_some_and(|l| l.starts_with("Role: "));
    valid
        && lines.next().is_some_and(|l| l.strip_prefix("Task key: ") == Some(key))
        && lines.next().is_some_and(|l| l.starts_with("Blocked by: "))
        && key.bytes().last().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn live_continuations(tasks: &[Value], task_key: &str) -> Vec<String> {
    let by_key: HashMap<&str, &Value> = tasks.iter().filter_map(|t| Some((t["key"].as_str()?, t))).collect();
    fn edges(task: &Value) -> Vec<&str> {
        let mode = &task["executionMode"];
        if mode["kind"] != "native" {
            return Vec::new();
        }
        ["reuseFromTaskKey", "parentTaskKey"].into_iter().filter_map(|k| mode[k].as_str()).collect()
    }
    let reaches = |task: &Value| {
        let mut seen = HashSet::new();
        let mut queue: VecDeque<&str> = edges(task).into();
        while let Some(key) = queue.pop_front() {
            if key == task_key {
                return true;
            }
            if !seen.insert(key) {
                continue;
            }
            if let Some(next) = by_key.get(key) {
                queue.extend(edges(next));
            }
        }
        false
    };
    tasks
        .iter()
        .filter_map(|task| {
            let key = task["key"].as_str()?;
            let status = task["status"].as_str()?;
            (key != task_key && !matches!(status, "withdrawn" | "completed" | "failed") && reaches(task))
                .then(|| key.to_owned())
        })
        .collect()
}

fn parse_input(input: &Value) -> Result<(&str, &str), Error> {
    let mid = input["missionID"].as_str().filter(|s| id(s, 100)).ok_or_else(bad)?;
    let key = input["taskKey"].as_str().filter(|s| valid_key(s)).ok_or_else(bad)?;
    if input.as_object().is_none_or(|o| o.len() != 2) {
        return Err(bad());
    }
    Ok((mid, key))
}

fn check_native_root_task<'a>(m: &'a Value, key: &str) -> Result<&'a Value, Error> {
    let task = find(m, "tasks", "key", key).ok_or_else(foreign)?;
    let mode = &task["executionMode"];
    if mode["kind"] != "native" || mode.get("parentTaskKey") != Some(&Value::Null) {
        return Err((
            Status::CONFLICT,
            Json(
                json!({"code":"task-sessions-unavailable","error":"Only native tasks launched by the coordinator have observable conversations"}),
            ),
        ));
    }
    Ok(task)
}

fn assert_stoppable(m: &Value, task: &Value, key: &str) -> Result<(), Error> {
    if m["status"] != "active" || task["status"] != "withdrawn" {
        return Err((
            Status::CONFLICT,
            Json(json!({"code":"task-not-retired","error":"Retire the task with mission.revise before stopping its work"})),
        ));
    }
    let tasks = m["tasks"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if !live_continuations(tasks, key).is_empty() {
        return Err((
            Status::CONFLICT,
            Json(json!({"code":"task-reused","error":"An open task continues this task's conversation; retire that task first"})),
        ));
    }
    Ok(())
}

async fn find_roots(app: &App, scope: &Scope, co: &Value, mid: &str, key: &str) -> Result<(Vec<Value>, bool), Error> {
    let sid = co["id"].as_str().ok_or_else(foreign)?;
    let mut cursor = None::<String>;
    let mut cursors = HashSet::new();
    let mut visited = HashSet::new();
    let mut listed = 0;
    let mut complete = true;
    let mut roots = Vec::new();
    'pages: loop {
        let mut query = vec![("parentID", sid), ("limit", "100")];
        if let Some(c) = cursor.as_deref() {
            query.push(("cursor", c));
        }
        let (status, page) = scope.request(app, Method::GET, "/api/session", &query, None, 10, 2 * 1024 * 1024).await?;
        let rows =
            page["data"].as_array().filter(|_| status.is_success() && page["cursor"].is_object()).ok_or_else(held)?;
        for child in rows {
            listed += 1;
            if listed > 200 {
                complete = false;
                break 'pages;
            }
            let Some(child_id) =
                child["id"].as_str().filter(|id_value| id(id_value, 240) && visited.insert(id_value.to_string()))
            else {
                complete = false;
                continue;
            };
            if child["parentID"] != sid || child["projectID"] != scope.project || child["location"] != co["location"] {
                complete = false;
                continue;
            }
            let first = scope
                .request(
                    app,
                    Method::GET,
                    &format!("/api/session/{child_id}/message"),
                    &[("limit", "1"), ("order", "asc"), ("type", "user")],
                    None,
                    5,
                    512 * 1024,
                )
                .await;
            match first {
                Ok((status, messages)) if status.is_success() && messages["data"].is_array() => {
                    if messages["data"].get(0).is_some_and(|msg| {
                        msg["type"] == "user" && msg["text"].as_str().is_some_and(|text| proves_task(text, mid, key))
                    }) {
                        roots.push(child.clone());
                    }
                }
                _ => complete = false,
            }
        }
        match page["cursor"].get("next") {
            None | Some(Value::Null) => break,
            Some(Value::String(next))
                if !rows.is_empty() && !next.is_empty() && next.len() <= 8192 && cursors.insert(next.clone()) =>
            {
                cursor = Some(next.clone());
            }
            _ => {
                complete = false;
                break;
            }
        }
    }
    Ok((roots, complete))
}

pub(super) async fn observe(app: &App, scope: Scope, co: Value, input: Value) -> Result<Value, Error> {
    let (mid, key) = parse_input(&input)?;
    let s = snapshot(app, &scope).await?;
    let m = mission(&s, mid, &co)?;
    let _ = check_native_root_task(m, key)?;
    let (roots, complete) = find_roots(app, &scope, &co, mid, key).await?;
    let mut sessions = Vec::new();
    if !roots.is_empty() {
        let (status, active) =
            scope.request(app, Method::GET, "/api/session/active", &[], None, 10, 256 * 1024).await?;
        let active = active["data"].as_object().filter(|_| status.is_success()).ok_or_else(held)?;
        for root in roots {
            if let Some(sid) = root["id"].as_str() {
                sessions.push(
                    json!({"sessionID":sid,"active":active.get(sid).is_some_and(|v| !v.is_null() && *v != false)}),
                );
            }
        }
    }
    current_root(app, &scope, &co).await?;
    Ok(json!({"sessions":sessions,"complete":complete}))
}

/// Stops a retired native task's conversations and their whole native families, deepest first,
/// then cancels their queued inputs. The coordinator is never touched.
pub(super) async fn interrupt(app: &App, scope: Scope, co: Value, input: Value) -> Result<Value, Error> {
    let (mid, key) = parse_input(&input)?;
    let s = snapshot(app, &scope).await?;
    let m = mission(&s, mid, &co)?;
    let task = check_native_root_task(m, key)?;
    assert_stoppable(m, task, key)?;
    let _permit = scope.permit().ok_or_else(held)?;
    let started = Instant::now();
    let deadline = started + INTERRUPT_BUDGET;
    let (roots, found_complete) = find_roots(app, &scope, &co, mid, key).await?;
    let root_ids: Vec<String> = roots.iter().filter_map(|r| r["id"].as_str().map(str::to_owned)).collect();
    let checkpoint = || {
        let scope = &scope;
        let co = &co;
        let root_ids = &root_ids;
        async move {
            scope.refresh(app).await?;
            let fresh_co = current_root(app, scope, co).await?;
            let s = snapshot(app, scope).await?;
            let m = mission(&s, mid, &fresh_co)?;
            let task = check_native_root_task(m, key)?;
            assert_stoppable(m, task, key)?;
            if m["tasks"].as_array().is_some_and(|tasks| {
                tasks.iter().any(|other| {
                    other["status"] != "withdrawn"
                        && other["actorSessionId"].as_str().is_some_and(|aid| root_ids.iter().any(|r| r == aid))
                })
            }) {
                return Err((
                    Status::CONFLICT,
                    Json(json!({"code":"task-reused","error":"An open task continues this task's conversation; retire that task first"})),
                ));
            }
            if !crate::worktrees::owns(app, &scope.workspace, &scope.dir).await || !scope.current(app) {
                return Err(foreign());
            }
            Ok(())
        }
    };
    let mut sessions = Vec::with_capacity(roots.len());
    for root in &roots {
        checkpoint().await?;
        sessions.push(super::family::interrupt_task_root(app, root, started, deadline, &checkpoint).await?);
    }
    let complete = found_complete && sessions.iter().all(|s| s["settled"] == true && s["descendants"]["complete"] == true);
    Ok(json!({"sessions":sessions,"complete":complete}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_the_first_exact_assignment_header() {
        let prompt = "Wrapper\r\n# CodeNomad Mission Assignment\r\n\r\nYou are a native task actor in mission msn_fixture.\r\n\r\nPlaybook: Custom\r\nRole: Specialist\r\nTask key: native-check\r\nBlocked by: none";
        assert!(proves_task(prompt, "msn_fixture", "native-check"));
        assert!(!proves_task(prompt, "msn_fixture", "native"));
        assert!(!proves_task(prompt, "msn_fixtur", "native-check"));
        assert!(!proves_task(
            &format!("# CodeNomad Mission Assignment\nfake\n{prompt}"),
            "msn_fixture",
            "native-check"
        ));
    }

    #[test]
    fn live_continuations_tracks_reuse_and_nested_chains() {
        let tasks = vec![
            json!({"key":"t1","status":"withdrawn","executionMode":{"kind":"native","parentTaskKey":null}}),
            json!({"key":"t2","status":"withdrawn","executionMode":{"kind":"native","reuseFromTaskKey":"t1","parentTaskKey":null}}),
            json!({"key":"t3","status":"in-progress","executionMode":{"kind":"native","parentTaskKey":"t2"}}),
            json!({"key":"t4","status":"completed","executionMode":{"kind":"native","reuseFromTaskKey":"t1","parentTaskKey":null}}),
        ];
        assert_eq!(live_continuations(&tasks, "t1"), vec!["t3"]);
        assert!(live_continuations(&tasks, "t3").is_empty());
    }
}
