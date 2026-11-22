use std::io::ErrorKind;
use std::time::Duration;

use futures_util::{StreamExt, stream::FuturesUnordered};
use tokio::time::{Instant, timeout_at};

use super::{Json, Response, Status, Value, actions, json, refuse, result};
use crate::{App, host::native_parent, worktrees::ownership};
use axum::response::IntoResponse;

const HOST_UNAVAILABLE: &str = "Browser automation is unavailable in this host";

fn refusal(status: Status, code: &str, error: &str) -> Response {
    (status, Json(json!({ "code": code, "error": error }))).into_response()
}

fn inventory_unavailable() -> Response {
    refusal(Status::SERVICE_UNAVAILABLE, "inventory-unavailable", "The preview inventory could not be verified")
}

fn expired() -> Response {
    refusal(Status::CONFLICT, "preview-expired", "Browser command expired before execution")
}

fn native_refusal(message: &str, probe: bool) -> Response {
    if message.contains("Multiple visible browser targets exist for this session") {
        return refusal(Status::CONFLICT, "ambiguous-target", "Several visible previews match this session");
    }
    let text = message.to_ascii_lowercase();
    if text.contains("no visible browser target") || text.contains("no visible local browser target") {
        let status = if probe { Status::NOT_FOUND } else { Status::CONFLICT };
        return refusal(status, "hidden-preview", "Show the session preview and take a new snapshot");
    }
    if [
        "target changed",
        "target is stale",
        "target is no longer current",
        "document changed",
        "lease is no longer current",
    ]
    .iter()
    .any(|part| text.contains(part))
    {
        return refusal(Status::CONFLICT, "stale-preview", "The preview changed; take a new snapshot");
    }
    let status = if probe { Status::SERVICE_UNAVAILABLE } else { Status::CONFLICT };
    refusal(status, "browser-unavailable", message)
}

fn open_refusal(message: &str) -> Response {
    let code = if message.contains("Multiple owning tabs") {
        "ambiguous-target"
    } else if message.contains("No visible local window has the owning project tab")
        || message.contains("Owning project tabs are unavailable")
    {
        "no-occurrence"
    } else if [
        "Browser open target changed",
        "Browser open renderer changed",
        "Browser open registration changed",
        "Browser navigation changed",
        "Browser open navigation changed",
    ]
    .iter()
    .any(|text| message.contains(text))
    {
        "target-gone"
    } else if message.contains("Browser preview already exists")
        || message.contains("Browser preview open is already in progress")
    {
        "preview-in-use"
    } else {
        return native_refusal(message, false);
    };
    refusal(Status::CONFLICT, code, message)
}

fn target(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 512 && !s.bytes().any(|b| b <= b' ' || b == 0x7f))
}

fn deadline(body: &Value, discovery: bool, now: i64) -> Option<i64> {
    let ceiling = now + if discovery { 5_000 } else { 90_000 };
    match body.get("deadline") {
        None => Some(ceiling),
        Some(value) => value
            .as_f64()
            .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
            .map(|n| (n as i64).min(ceiling)),
    }
}

async fn owning_workspaces(app: &App, location: &Value, strict: bool, all: bool) -> Option<Vec<String>> {
    let Some(directory) = location["directory"].as_str().filter(|_| location.get("workspaceID").is_none()) else {
        return Some(Vec::new());
    };
    let workspaces = app.inner.lock().unwrap().workspaces.clone();
    let mut checks = workspaces
        .iter()
        .map(|w| async move {
            // A removed workspace cannot supply an open occurrence; other unreadable roots must fail closed.
            if all {
                match dunce::canonicalize(&w.path) {
                    Ok(_) => {}
                    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                    Err(_) => return Err(()),
                }
            }
            ownership::resolve_checked(app, w, directory, strict).await.map(|owner| owner.map(|_| w.id.to_string()))
        })
        .collect::<FuturesUnordered<_>>();
    let mut ids = Vec::new();
    let mut unreadable = false;
    while let Some(checked) = checks.next().await {
        match checked {
            Ok(Some(id)) if !all => return Some(vec![id]),
            Ok(Some(id)) => ids.push(id),
            Ok(None) => {}
            Err(()) => unreadable = true,
        }
    }
    (!strict || !unreadable).then_some(ids)
}

pub(super) async fn handle(app: &App, mode: &str, id: &str, body: &Value) -> Response {
    let discovery = mode != "browser-execute";
    let opening = !discovery && body["command"]["action"] == "open";
    let now = chrono::Utc::now().timestamp_millis();
    let Some(deadline) = deadline(body, discovery, now) else {
        let error = if discovery { "Invalid browser discovery deadline" } else { "Invalid browser command deadline" };
        return refusal(Status::BAD_REQUEST, "invalid-deadline", error);
    };
    let elapsed = if discovery { inventory_unavailable } else { expired };
    if deadline <= now {
        return elapsed();
    }
    if discovery && (!native_parent::available() || crate::config::native_browser_automation_unavailable()) {
        return refusal(Status::NOT_FOUND, "no-preview-host", HOST_UNAVAILABLE);
    }
    let until = Instant::now() + Duration::from_millis((deadline - now) as u64);
    let ownership = async {
        match crate::opencode::session_record(app, id).await {
            Ok(record) => owning_workspaces(app, &record["location"], discovery || opening, opening).await.map(|ids| {
                if ids.is_empty() { Err("Session is not owned by this CodeNomad instance") } else { Ok(ids) }
            }),
            Err((status, Json(error)))
                if !discovery
                    || (status == Status::NOT_FOUND
                        && error["_tag"] == "SessionNotFoundError"
                        && error["sessionID"] == id) =>
            {
                Some(Err("Session not found"))
            }
            Err(_) => None,
        }
    };
    let workspace_ids = match timeout_at(until, ownership).await {
        _ if Instant::now() >= until => return elapsed(),
        Ok(Some(Ok(ids))) => ids,
        Ok(Some(Err(message))) if discovery => return refusal(Status::NOT_FOUND, "browser-not-owner", message),
        Ok(Some(Err(message))) => return refuse(Status::NOT_FOUND, message),
        Ok(None) if opening => return refuse(Status::CONFLICT, "Could not verify the owning project tabs"),
        _ => return elapsed(),
    };
    match mode {
        "browser-claim" => result(json!({ "available": true })),
        "browser-probe" => {
            match native_parent::request_until("browser.probe", json!({ "sessionID": id }), deadline).await {
                _ if Instant::now() >= until => inventory_unavailable(),
                Ok(found) if found["available"] == false => native_refusal("No visible browser target", true),
                Ok(found) if found["available"] == true && target(&found["target"]).is_some() => {
                    result(json!({ "available": true, "target": found["target"] }))
                }
                Ok(_) => refusal(Status::CONFLICT, "unsupported", "The desktop host cannot pin a browser target"),
                Err(error) => native_refusal(&error, true),
            }
        }
        _ => {
            if crate::config::native_browser_automation_unavailable() {
                return refusal(Status::CONFLICT, "unsupported", HOST_UNAVAILABLE);
            }
            let params = match execution_params(id, body, &workspace_ids) {
                Ok(params) => params,
                Err(response) => return response,
            };
            match native_parent::request_until("browser.execute", params, deadline).await {
                _ if Instant::now() >= until => refusal(
                    Status::CONFLICT,
                    "preview-expired",
                    "Browser command timed out; inspect before another action",
                ),
                Ok(done) => result(done),
                Err(error) if opening => open_refusal(&error),
                Err(error) => native_refusal(&error, false),
            }
        }
    }
}

fn execution_params(id: &str, body: &Value, workspace_ids: &[String]) -> Result<Value, Response> {
    let command = actions::browser(&body["command"]).map_err(|error| refuse(Status::BAD_REQUEST, &error))?;
    let opening = command["action"] == "open";
    let mut params = json!({ "sessionID": id, "command": command });
    if opening {
        params["workspaceIDs"] = json!(workspace_ids);
    } else {
        let Some(target) = target(&body["target"]) else {
            return Err(refusal(Status::BAD_REQUEST, "target-required", "A current browser target is required"));
        };
        params["target"] = json!(target);
    }
    Ok(params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_preserves_exact_target_and_refuses_missing_or_invalid_targets() {
        for invalid in [Value::Null, json!(""), json!("target\n"), json!("x".repeat(513))] {
            let input = json!({ "command": { "action": "snapshot" }, "target": invalid });
            assert_eq!(execution_params("s", &input, &[]).unwrap_err().status(), Status::BAD_REQUEST);
        }
        for command in [json!({"action":"snapshot"}), json!({"action":"navigate","url":"https://fixture.invalid/"})] {
            let input = json!({ "command": command, "target": "guest:1:document" });
            let params = execution_params("s", &input, &["tab-a".into()]).unwrap();
            assert_eq!(params["target"], "guest:1:document");
            assert!(params.get("workspaceIDs").is_none());
        }
    }

    #[test]
    fn opening_forwards_only_server_verified_workspace_ids_and_ignores_the_target() {
        let open = json!({
            "command": { "action": "open", "url": "https://fixture.invalid/" },
            "target": "ignored",
            "workspaceIDs": ["untrusted"],
        });
        let params = execution_params("s", &open, &["tab-a".into(), "tab-b".into()]).unwrap();
        assert_eq!(params["workspaceIDs"], json!(["tab-a", "tab-b"]));
        assert!(params.get("target").is_none());
    }

    #[test]
    fn caps_deadlines_and_preserves_earlier_or_expired_deadlines() {
        assert_eq!(deadline(&json!({}), true, 10_000), Some(15_000));
        assert_eq!(deadline(&json!({"deadline":123_000}), false, 10_000), Some(100_000));
        assert_eq!(deadline(&json!({"deadline":10_200}), false, 10_000), Some(10_200));
        assert_eq!(deadline(&json!({"deadline":9_000}), true, 10_000), Some(9_000));
        assert_eq!(deadline(&json!({"deadline":null}), false, 10_000), None);
    }
}
