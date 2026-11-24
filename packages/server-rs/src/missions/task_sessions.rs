use super::{
    bridge::{current_root, find, mission, with_snapshot},
    creation_admission::Scope,
    run::{bad, foreign, held, id},
};
use crate::{App, Error};
use axum::{
    Json,
    http::{Method, StatusCode as Status},
};
use serde_json::{Value, json};
use std::collections::HashSet;

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

pub(super) async fn observe(app: &App, scope: Scope, co: Value, input: Value) -> Result<Value, Error> {
    let mid = input["missionID"].as_str().filter(|s| id(s, 100)).ok_or_else(bad)?;
    let key = input["taskKey"].as_str().filter(|s| valid_key(s)).ok_or_else(bad)?;
    if input.as_object().is_none_or(|o| o.len() != 2) {
        return Err(bad());
    }
    with_snapshot(app, &scope, |s| {
        let m = mission(&s, mid, &co)?;
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
        Ok(())
    })
    .await?;
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
                        roots.push(child_id.to_owned());
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
    let mut sessions = Vec::new();
    if !roots.is_empty() {
        let (status, active) =
            scope.request(app, Method::GET, "/api/session/active", &[], None, 10, 256 * 1024).await?;
        let active = active["data"].as_object().filter(|_| status.is_success()).ok_or_else(held)?;
        for sid in roots {
            sessions
                .push(json!({"sessionID":sid,"active":active.get(&sid).is_some_and(|v| !v.is_null() && *v != false)}));
        }
    }
    current_root(app, &scope, &co).await?;
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
}
