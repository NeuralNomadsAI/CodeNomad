//! Route allowlist, header/location validation, and schedule-carrier mutation checks.
use std::{path::PathBuf, sync::LazyLock, time::Duration};

use axum::{
    http::{Method, StatusCode as Status, header},
    response::Response,
};
use percent_encoding::percent_decode_str;
use regex::Regex;
use serde_json::{Value, json};

use crate::opencode::{native_rpc_absent, upstream_error};
use crate::{App, Error, error};

// The reference gate is separate from forwarding: allowlisted features whose
// workspace ownership checks aren't ported fail closed.
pub(super) static ALLOWED: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    include_str!("../allowlist.txt")
        .lines()
        .map(|line| {
            let (method, pattern) = line.split_once(' ').unwrap();
            (method, Regex::new(pattern).unwrap())
        })
        .collect()
});

fn decode(value: &str) -> Option<String> {
    percent_decode_str(value).decode_utf8().ok().map(|s| s.into_owned())
}

pub(super) fn safe_route(value: &str) -> Option<String> {
    if value.contains('\\') {
        return None;
    }
    for segment in value.split('/') {
        let mut decoded = segment.to_owned();
        for _ in 0..3 {
            decoded = decode(&decoded)?;
            if decoded == "." || decoded == ".." || decoded.contains(['/', '\\', '\0']) {
                return None;
            }
        }
    }
    decode(value)
}

pub(super) fn valid_segment(seg: &str) -> bool {
    !seg.is_empty()
        && !seg.contains('/')
        && seg.encode_utf16().count() <= 256
        && !seg.chars().any(|c| c.is_ascii_control())
}

pub(super) fn is_credential_mutation(route: &str, method: &Method) -> bool {
    let Some(rest) = route.strip_prefix("/api/credential/") else {
        return false;
    };
    match *method {
        Method::PATCH | Method::DELETE => valid_segment(rest),
        Method::POST => rest.strip_suffix("/activate").is_some_and(valid_segment),
        _ => false,
    }
}

pub(super) fn is_integration_connect_mutation(route: &str, method: &Method) -> bool {
    let Some(rest) = route.strip_prefix("/api/integration/") else {
        return false;
    };
    let Some((integration_id, tail)) = rest.split_once("/connect/") else {
        return false;
    };
    if !valid_segment(integration_id) {
        return false;
    }
    match *method {
        Method::POST => {
            matches!(tail, "key" | "oauth" | "command" | "external")
                || tail.strip_prefix("oauth/").and_then(|s| s.strip_suffix("/complete")).is_some_and(valid_segment)
        }
        Method::DELETE => {
            tail.strip_prefix("oauth/").or_else(|| tail.strip_prefix("command/")).is_some_and(valid_segment)
        }
        _ => false,
    }
}

pub(super) fn is_account_mutation(route: &str, method: &Method) -> bool {
    is_credential_mutation(route, method) || is_integration_connect_mutation(route, method)
}

pub(super) fn is_account_no_store_route(route: &str, method: &Method) -> bool {
    is_account_mutation(route, method)
        || (*method == Method::GET
            && route.strip_prefix("/api/integration/").and_then(|r| r.split_once("/connect/")).is_some_and(
                |(id, tail)| {
                    valid_segment(id)
                        && tail
                            .strip_prefix("oauth/")
                            .or_else(|| tail.strip_prefix("command/"))
                            .is_some_and(valid_segment)
                },
            ))
}

pub(super) fn guarded(route: &str, method: &Method) -> bool {
    let session_segment = route
        .strip_prefix("/api/session/")
        .or_else(|| route.strip_prefix("/api/experimental/session/"))
        .and_then(|rest| rest.split('/').next());
    if *method == Method::GET {
        if session_segment
            .is_some_and(|seg| seg.is_empty() || seg == "global" || (seg == "active" && route != "/api/session/active"))
        {
            return false;
        }
        return !route.starts_with("/api/fs/") && !route.starts_with("/api/pty") && !route.starts_with("/api/shell");
    }
    if is_account_mutation(route, method) {
        return true;
    }
    if session_segment.is_some_and(|seg| matches!(seg, "" | "active" | "global")) {
        return false;
    }
    (*method == Method::POST && route == "/api/session")
        || (*method == Method::POST
            && route.starts_with("/api/session/")
            && ["/prompt", "/command", "/agent", "/model", "/fork", "/background", "/revert/stage"]
                .iter()
                .any(|suffix| route.ends_with(suffix)))
        || (matches!(*method, Method::PATCH | Method::DELETE)
            && route.strip_prefix("/api/session/").is_some_and(|r| !r.contains('/')))
        || (matches!(*method, Method::PATCH | Method::DELETE)
            && route.strip_prefix("/api/session/").and_then(|r| r.split_once("/inbox/")).is_some_and(|(sid, item)| {
                !sid.is_empty() && !sid.contains('/') && !item.is_empty() && !item.contains('/')
            }))
        || (*method == Method::DELETE
            && route
                .strip_prefix("/api/session/")
                .and_then(|r| r.strip_suffix("/revert"))
                .is_some_and(|r| !r.contains('/')))
        || (matches!(*method, Method::PUT | Method::DELETE)
            && route.starts_with("/api/experimental/session/")
            && route.contains("/instructions/entries/"))
}

pub(super) fn foreign() -> Error {
    error(Status::FORBIDDEN, "Location does not belong to workspace")
}

pub(super) fn carrier_denied() -> Error {
    error(Status::FORBIDDEN, "Mission schedule carriers and metadata require owned schedule controls")
}
pub(super) fn marker(record: &Value) -> bool {
    record["metadata"].get("codenomad.schedule-carrier").is_some()
}
pub(super) fn same_target(initial: &Value, current: &Value) -> bool {
    ["id", "location", "projectID", "parentID", "fork"].iter().all(|key| current[*key] == initial[*key])
        && current["time"]["created"] == initial["time"]["created"]
}
pub(super) fn schedule_input(data: &serde_json::Map<String, Value>) -> bool {
    data.get("metadata").and_then(Value::as_object).is_some_and(|metadata| {
        ["schedule", "automation", "codenomad.schedule-carrier"].iter().any(|key| metadata.contains_key(*key))
    })
}
pub async fn verify_mutation(app: &App, id: &str, directory: &str, record: &Value) -> Result<(), Error> {
    let endpoint = app.native.endpoint().ok_or_else(upstream_error)?;
    verify_mutation_at(app, &endpoint, id, directory, record).await
}

pub(crate) async fn verify_mutation_at(
    app: &App,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    id: &str,
    directory: &str,
    record: &Value,
) -> Result<(), Error> {
    verify_ordinary_session_at(app, endpoint, id, directory, None, record).await
}

pub(crate) async fn verify_ordinary_session_at(
    app: &App,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    id: &str,
    directory: &str,
    workspace_id: Option<&str>,
    record: &Value,
) -> Result<(), Error> {
    if id.starts_with("ses_cn_schedule_") || marker(record) {
        return Err(carrier_denied());
    }
    let uncertain = || error(Status::SERVICE_UNAVAILABLE, "Mission schedule carrier ownership could not be verified");
    let route = endpoint.url.join("/api/rpc/codenomad.missions/scheduleCarrierRead").map_err(|_| uncertain())?;
    let mut req = app
        .native
        .client
        .post(route)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", directory)]);
    if let Some(ws_id) = workspace_id {
        req = req.query(&[("location[workspaceID]", ws_id)]);
    }
    let response = req
        .json(&json!({"input":{"sessionID":id}}))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| uncertain())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|_| uncertain())?;
    if status.is_success() {
        match body["output"]["owned"].as_bool() {
            Some(false) => {}
            Some(true) => return Err(carrier_denied()),
            _ => return Err(uncertain()),
        }
    } else if !native_rpc_absent(&body, status)
        || record["model"]["providerID"] == "codenomad-missions-local"
        || record["title"] == "Mission schedule carrier"
    {
        return Err(uncertain());
    }
    let fresh = crate::opencode::session_record_at(app, endpoint, id).await?;
    let fresh_ws_id = fresh["location"].get("workspaceID");
    let ws_id_matches = match workspace_id {
        None => fresh_ws_id.is_none(),
        Some(expected) => fresh_ws_id.and_then(Value::as_str) == Some(expected),
    };
    if fresh["id"] != id || fresh["location"]["directory"] != directory || !ws_id_matches || marker(&fresh) {
        return Err(carrier_denied());
    }
    Ok(())
}

/// The native status and the cache headers a relayed body keeps.
pub(super) fn relayed(response: &reqwest::Response) -> axum::http::response::Builder {
    ["content-type", "cache-control", "etag", "last-modified"].into_iter().fold(
        Response::builder().status(response.status()),
        |builder, name| match response.headers().get(name) {
            Some(value) => builder.header(name, value),
            None => builder,
        },
    )
}

/// Matches TS `proxy.ts:81` (`/^application\/json\b/i`) for `2xx` deferred `message.list`
/// projection, including structured types like `application/json-patch+json`.
pub(super) fn is_json_content_type(headers: &axum::http::HeaderMap) -> bool {
    headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|ct| {
        let rest = ct.as_bytes();
        rest.len() >= 16
            && rest[..16].eq_ignore_ascii_case(b"application/json")
            && rest.get(16).is_none_or(|&b| !(b.is_ascii_alphanumeric() || b == b'_'))
    })
}

pub(super) fn is_hop_by_hop_connection_token(headers: &axum::http::HeaderMap, name: &str) -> bool {
    headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|val| val.split(',').any(|token| token.trim().eq_ignore_ascii_case(name)))
}

/// Non-OK native error classification (`transport.ts:59`: `contentType.includes("application/json")`).
pub(super) fn is_transport_json_content_type(headers: &axum::http::HeaderMap) -> bool {
    headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|ct| ct.contains("application/json"))
}

pub(super) fn parse_location_context(headers: &axum::http::HeaderMap) -> Result<Option<Value>, Error> {
    let invalid = || error(Status::BAD_REQUEST, "Invalid location context");
    let mut values = headers.get_all("x-codenomad-location").iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(invalid());
    }
    let text = value.to_str().ok().filter(|v| v.len() <= 16_384).ok_or_else(invalid)?;
    let decoded = crate::shared::decode_component(text).ok_or_else(invalid)?;
    let parsed: Value = serde_json::from_str(&decoded).map_err(|_| invalid())?;
    let object = parsed.as_object().ok_or_else(invalid)?;
    if object.len() != 1
        || !object.get("directory").and_then(Value::as_str).is_some_and(|d| !d.trim().is_empty() && !d.contains('\0'))
    {
        return Err(invalid());
    }
    Ok(Some(parsed))
}

pub(super) async fn resolve_media_path_async(
    scope: std::path::PathBuf,
    raw: String,
    slot: Option<std::sync::Arc<tokio::sync::OwnedSemaphorePermit>>,
) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    // Keep the `Arc<OwnedSemaphorePermit>` alive inside `spawn_blocking` so cancelling a stalled
    // request never releases a slot while the detached filesystem probe worker is still running.
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        crate::worktrees::ownership::resolve_media_path(&scope, &raw)
    })
    .await
    .ok()?
}

pub(super) fn one_location(location: &Value, directory: &str) -> Result<(), Error> {
    if !location.as_object().is_some_and(|o| o.len() == 1) || location["directory"].as_str() != Some(directory) {
        return Err(foreign());
    }
    Ok(())
}

pub(super) fn directory_identity(
    scope: &std::path::Path,
    native_directory: Option<&str>,
    message_list: bool,
) -> Option<(PathBuf, PathBuf, String)> {
    let raw = native_directory?;
    let (resolved, anchor) = if message_list {
        crate::worktrees::ownership::resolve_media_path(scope, raw)?
    } else {
        let path = crate::files::paths::canonical(scope, raw)?;
        (path.clone(), path)
    };
    let identity = crate::files::host_identity(&anchor).ok()?;
    Some((resolved, anchor, identity))
}

#[cfg(test)]
mod tests {
    use super::same_target;
    use serde_json::json;

    #[test]
    fn same_target_rejects_location_metadata_change_and_accepts_reordered_fork_keys() {
        let initial = json!({
            "id": "ses_1",
            "location": { "directory": "/repo", "workspaceID": "ws_1" },
            "projectID": "proj_1",
            "parentID": null,
            "fork": { "sessionID": "ses_parent", "messageID": "msg_1" },
            "time": { "created": 100, "updated": 100 }
        });
        let reordered_fork = json!({
            "id": "ses_1",
            "location": { "directory": "/repo", "workspaceID": "ws_1" },
            "projectID": "proj_1",
            "parentID": null,
            "fork": { "messageID": "msg_1", "sessionID": "ses_parent" },
            "time": { "created": 100, "updated": 200 }
        });
        assert!(same_target(&initial, &reordered_fork));

        let location_changed = json!({
            "id": "ses_1",
            "location": { "directory": "/repo", "workspaceID": "ws_2" },
            "projectID": "proj_1",
            "parentID": null,
            "fork": { "sessionID": "ses_parent", "messageID": "msg_1" },
            "time": { "created": 100, "updated": 100 }
        });
        assert!(!same_target(&initial, &location_changed));

        // Absent optional fields and explicit null fields represent the same target state.
        let absent_parent = json!({
            "id": "ses_1",
            "location": { "directory": "/repo", "workspaceID": "ws_1" },
            "projectID": "proj_1",
            "fork": { "sessionID": "ses_parent", "messageID": "msg_1" },
            "time": { "created": 100 }
        });
        assert!(same_target(&initial, &absent_parent));
    }
}

#[test]
fn ordinary_input_refuses_reserved_metadata_even_with_null_values() {
    for key in ["schedule", "automation", "codenomad.schedule-carrier"] {
        let input = json!({"metadata":{(key):null}});
        assert!(schedule_input(input.as_object().unwrap()));
    }
    assert!(!schedule_input(json!({"metadata":{"other":"automation"}}).as_object().unwrap()));
}

#[test]
fn deferred_message_list_headers_and_location_context_validation() {
    let mut headers = axum::http::HeaderMap::new();
    for (ct, expected) in [
        ("application/json", true),
        ("Application/JSON; charset=utf-8", true),
        ("application/json ; charset=utf-8", true),
        ("application/json foo", true),
        ("application/json-patch+json", true),
        ("application/jsonp", false),
        ("application/json_v2", false),
        ("text/plain", false),
    ] {
        headers.insert(header::CONTENT_TYPE, ct.parse().unwrap());
        assert_eq!(is_json_content_type(&headers), expected, "{ct}");
    }
    assert!(parse_location_context(&axum::http::HeaderMap::new()).unwrap().is_none());
    for bad in [
        "%7B%7D",
        "%7B%22directory%22%3A%22%20%22%7D",
        "%7B%22directory%22%3A%22%2Fa%22%2C%22workspaceID%22%3A%22w%22%7D",
        "%7B%22directory%22%3A%22%2Fa%22%2C%22extra%22%3A1%7D",
        "not-json",
    ] {
        let mut h = axum::http::HeaderMap::new();
        h.insert("x-codenomad-location", bad.parse().unwrap());
        assert_eq!(parse_location_context(&h).unwrap_err().0, Status::BAD_REQUEST, "{bad}");
    }
    let mut ok = axum::http::HeaderMap::new();
    ok.insert("x-codenomad-location", "%7B%22directory%22%3A%22%2Frepo%22%7D".parse().unwrap());
    assert_eq!(parse_location_context(&ok).unwrap(), Some(json!({"directory": "/repo"})));
}
