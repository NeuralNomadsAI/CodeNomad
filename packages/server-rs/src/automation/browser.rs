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

async fn owns(app: &App, location: &Value, strict: bool) -> Option<bool> {
    let Some(directory) = location["directory"].as_str().filter(|_| location.get("workspaceID").is_none()) else {
        return Some(false);
    };
    let workspaces = app.inner.lock().unwrap().workspaces.clone();
    let mut checks = workspaces
        .iter()
        .map(|w| ownership::resolve_checked(app, w, directory, strict))
        .collect::<FuturesUnordered<_>>();
    let mut unreadable = false;
    while let Some(checked) = checks.next().await {
        match checked {
            Ok(Some(_)) => return Some(true),
            Ok(None) => {}
            Err(()) => unreadable = true,
        }
    }
    (!strict || !unreadable).then_some(false)
}

pub(super) async fn handle(app: &App, mode: &str, id: &str, body: &Value) -> Response {
    let discovery = mode != "browser-execute";
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
            Ok(record) => owns(app, &record["location"], discovery)
                .await
                .map(|owned| (!owned).then_some("Session is not owned by this CodeNomad instance")),
            Err((status, Json(error)))
                if !discovery
                    || (status == Status::NOT_FOUND
                        && error["_tag"] == "SessionNotFoundError"
                        && error["sessionID"] == id) =>
            {
                Some(Some("Session not found"))
            }
            Err(_) => None,
        }
    };
    match timeout_at(until, ownership).await {
        _ if Instant::now() >= until => return elapsed(),
        Ok(Some(None)) => {}
        Ok(Some(Some(message))) if discovery => return refusal(Status::NOT_FOUND, "browser-not-owner", message),
        Ok(Some(Some(message))) => return refuse(Status::NOT_FOUND, message),
        _ => return elapsed(),
    }
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
            let params = match execution_params(id, body) {
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
                Err(error) => native_refusal(&error, false),
            }
        }
    }
}

fn execution_params(id: &str, body: &Value) -> Result<Value, Response> {
    let command = actions::browser(&body["command"]).map_err(|error| refuse(Status::BAD_REQUEST, &error))?;
    let opening = command["action"] == "open";
    let mut params = json!({ "sessionID": id, "command": command });
    if !opening {
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
            assert_eq!(execution_params("s", &input).unwrap_err().status(), Status::BAD_REQUEST);
        }
        for command in [json!({"action":"snapshot"}), json!({"action":"navigate","url":"https://fixture.invalid/"})] {
            let input = json!({ "command": command, "target": "guest:1:document" });
            assert_eq!(execution_params("s", &input).unwrap()["target"], "guest:1:document");
        }
        let open = json!({ "command": { "action": "open", "url": "https://fixture.invalid/" }, "target": "ignored" });
        assert!(execution_params("s", &open).unwrap().get("target").is_none());
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
