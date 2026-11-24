//! `/workspaces/:id/instance/*`: the allowlisted relay to the daemon, confined to the workspace's
//! locations and sessions.
use std::{sync::LazyLock, time::Duration};

use axum::{
    Json,
    body::Body,
    extract::{Request, State},
    http::{Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use percent_encoding::percent_decode_str;
use regex::Regex;
use serde_json::{Value, json};

use super::{
    NativeBody, SESSION_LOCATED_ELSEWHERE, SESSION_PLACEMENT_HEADER, controls, native_rpc_absent, read_json,
    session_directory, upstream_error,
};
use crate::missions::human_answer;
use crate::{App, Error, Shared, error, not_found, unavailable};

// The reference gate is separate from forwarding: allowlisted features whose
// workspace ownership checks aren't ported fail closed.
static ALLOWED: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    include_str!("allowlist.txt")
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

fn safe_route(value: &str) -> Option<String> {
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

fn guarded(route: &str, method: &Method) -> bool {
    if *method == Method::GET {
        return !route.starts_with("/api/fs/") && !route.starts_with("/api/pty") && !route.starts_with("/api/shell");
    }
    (*method == Method::POST && route == "/api/session")
        || (*method == Method::POST
            && route.starts_with("/api/session/")
            && ["/prompt", "/command", "/agent", "/model", "/fork"].iter().any(|suffix| route.ends_with(suffix)))
        || (*method == Method::PATCH && route.strip_prefix("/api/session/").is_some_and(|r| !r.contains('/')))
        || (matches!(*method, Method::PUT | Method::DELETE)
            && route.starts_with("/api/experimental/session/")
            && route.contains("/instructions/entries/"))
}

fn foreign() -> Error {
    error(Status::FORBIDDEN, "Location does not belong to workspace")
}

fn carrier_denied() -> Error {
    error(Status::FORBIDDEN, "Mission schedule carriers and metadata require owned schedule controls")
}
fn marker(record: &Value) -> bool {
    record["metadata"].get("codenomad.schedule-carrier").is_some()
}
fn same_target(initial: &Value, current: &Value) -> bool {
    ["id", "location", "projectID", "parentID", "fork"].iter().all(|key| current[*key] == initial[*key])
        && current["time"]["created"] == initial["time"]["created"]
}
fn schedule_input(data: &serde_json::Map<String, Value>) -> bool {
    data.get("metadata").and_then(Value::as_object).is_some_and(|metadata| {
        ["schedule", "automation", "codenomad.schedule-carrier"].iter().any(|key| metadata.contains_key(*key))
    })
}
pub async fn verify_mutation(app: &App, id: &str, directory: &str, record: &Value) -> Result<(), Error> {
    let endpoint = app.native.endpoint().ok_or_else(upstream_error)?;
    verify_mutation_at(app, &endpoint, id, directory, record).await
}

async fn verify_mutation_at(
    app: &App,
    endpoint: &std::sync::Arc<super::Endpoint>,
    id: &str,
    directory: &str,
    record: &Value,
) -> Result<(), Error> {
    if id.starts_with("ses_cn_schedule_") || marker(record) {
        return Err(carrier_denied());
    }
    let uncertain = || error(Status::SERVICE_UNAVAILABLE, "Mission schedule carrier ownership could not be verified");
    let route = endpoint.url.join("/api/rpc/codenomad.missions/scheduleCarrierRead").map_err(|_| uncertain())?;
    let response = app
        .native
        .client
        .post(route)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", directory)])
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
    let fresh = super::session_record_at(app, endpoint, id).await?;
    if fresh["id"] != id
        || fresh["location"]["directory"] != directory
        || fresh["location"].get("workspaceID").is_some()
        || marker(&fresh)
    {
        return Err(carrier_denied());
    }
    Ok(())
}

/// The native status and the cache headers a relayed body keeps.
fn relayed(response: &reqwest::Response) -> axum::http::response::Builder {
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
fn is_json_content_type(headers: &axum::http::HeaderMap) -> bool {
    headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|ct| {
        let rest = ct.as_bytes();
        rest.len() >= 16
            && rest[..16].eq_ignore_ascii_case(b"application/json")
            && rest.get(16).is_none_or(|&b| !(b.is_ascii_alphanumeric() || b == b'_'))
    })
}

fn is_hop_by_hop_connection_token(headers: &axum::http::HeaderMap, name: &str) -> bool {
    headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|val| val.split(',').any(|token| token.trim().eq_ignore_ascii_case(name)))
}

/// Non-OK native error classification (`transport.ts:59`: `contentType.includes("application/json")`).
fn is_transport_json_content_type(headers: &axum::http::HeaderMap) -> bool {
    headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|ct| ct.contains("application/json"))
}

fn parse_location_context(headers: &axum::http::HeaderMap) -> Result<Option<Value>, Error> {
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

async fn resolve_media_path_async(
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

fn one_location(location: &Value, directory: &str) -> Result<(), Error> {
    if !location.as_object().is_some_and(|o| o.len() == 1) || location["directory"].as_str() != Some(directory) {
        return Err(foreign());
    }
    Ok(())
}

pub async fn relay(State(app): State<Shared>, request: Request) -> Result<Response, Error> {
    let (head, body) = request.into_parts();
    let principal = head.extensions.get::<crate::auth::Principal>().cloned().ok_or_else(crate::auth::unauthorized)?;
    let invalid = || error(Status::BAD_REQUEST, "Invalid workspace instance path");
    let tail = head.uri.path().strip_prefix("/workspaces/").ok_or_else(invalid)?;
    let (id, suffix) = tail.split_once('/').ok_or_else(invalid)?;
    let suffix = suffix.strip_prefix("instance").ok_or_else(invalid)?;
    let workspace = app.workspace(id)?;
    let route = safe_route(suffix).ok_or_else(invalid)?;
    let route = route.trim_end_matches('/');
    let prompt = head.method == Method::POST && route.starts_with("/api/session/") && route.ends_with("/prompt");
    let command = head.method == Method::POST && route.starts_with("/api/session/") && route.ends_with("/command");
    let send_input = prompt || command;
    let body_limit = if prompt { super::prompt::BODY_LIMIT } else { 1024 * 1024 };
    let control = controls::classify(route, &head.method);
    if !ALLOWED.iter().any(|(m, pat)| *m == head.method.as_str() && pat.is_match(route)) {
        return Err(error(Status::FORBIDDEN, "OpenCode route is not available through a workspace"));
    }
    if control.is_none() && !guarded(route, &head.method) {
        return Ok(unavailable());
    }
    let declared =
        head.headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
    if (control.is_some() || matches!(head.method, Method::POST | Method::PUT | Method::PATCH))
        && declared.is_some_and(|length| length > body_limit)
    {
        let _ = super::proxy_body::read(body, body_limit, declared).await;
        return Err(super::proxy_body::too_large());
    }
    let mut pending_body = Some(body);
    let mut prompt_directories = Vec::new();
    let mut prompt_input = if send_input {
        let bytes =
            super::proxy_body::read(pending_body.take().ok_or_else(upstream_error)?, body_limit, declared).await?;
        let data = super::prompt::parse(&head.headers, &bytes)?;
        if data.as_object().is_some_and(schedule_input) {
            return Err(carrier_denied());
        }
        // The reference rejects inline-data budgets before Location/path ownership.
        super::prompt::budget(&data)?;
        prompt_directories =
            super::prompt::locations(&data, workspace.location["directory"].as_str().ok_or_else(upstream_error)?)?;
        Some(data)
    } else {
        None
    };
    let opened = workspace.location["directory"].as_str().ok_or_else(upstream_error)?;
    let session_path = route.strip_prefix("/api/session/").or_else(|| route.strip_prefix("/api/experimental/session/"));
    let session = session_path.and_then(|path| path.split('/').next()).filter(|v| !matches!(*v, "active" | "global"));
    let message_list = head.method == Method::GET
        && session.is_some_and(|s| {
            route.strip_prefix("/api/session/").and_then(|rest| rest.strip_suffix("/message")) == Some(s)
        });
    let workspace_closed = || async {
        loop {
            let notified = app.workspace_closed.notified();
            if !app.workspace(id).is_ok_and(|current| current.id == workspace.id && current.path == workspace.path) {
                return;
            }
            notified.await;
        }
    };
    let list_deadline = tokio::time::Instant::now() + super::PROXY_IDLE;
    let deadline = if message_list {
        list_deadline.min(tokio::time::Instant::now() + Duration::from_secs(30))
    } else {
        tokio::time::Instant::now() + Duration::from_secs(30)
    };
    let endpoint = tokio::select! {
        biased;
        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
        _ = workspace_closed() => return Err(not_found()),
        acquired = app.native.acquire(deadline) => match acquired {
            Ok(endpoint) => endpoint,
            Err(ref refusal @ super::admission::Refusal::Unsupported { ref actual, reason }) => {
                return Err((
                    Status::UPGRADE_REQUIRED,
                    Json(json!({
                        "error": "opencode_update_required",
                        "message": refusal.to_string(),
                        "actualVersion": actual,
                        "minimumVersion": super::admission::MINIMUM_VERSION,
                        "reason": reason,
                    })),
                ));
            }
            Err(_) => return Err(upstream_error()),
        },
    };
    // Ensure bundled plugins are prepared for this captured connection before dispatching
    // (TS `opencode-service.ts:148-166`). Fast-paths when `STATE.prepared` already matches.
    tokio::select! {
        biased;
        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
        _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
        _ = workspace_closed() => return Err(not_found()),
        _ = tokio::time::timeout_at(deadline, crate::extensions::lifecycle::prepare(&app, &endpoint)) => {}
    }
    if dunce::canonicalize(opened).ok().as_ref() != Some(&workspace.path) {
        return Err(foreign());
    }
    let mut translated_directories = std::collections::BTreeMap::new();
    let mut prompt_locations = Vec::new();
    for directory in prompt_directories {
        let (translated, live, observed) = super::prompt::observe_directory(&app, &workspace, &directory).await?;
        translated_directories.insert(directory.clone(), translated.directory.clone());
        prompt_locations.push((directory, translated, (live, observed)));
    }
    if let Some(data) = &mut prompt_input {
        super::prompt::translate(data, &translated_directories);
    }
    let mut target = endpoint.url.clone();
    target.set_query(head.uri.query());
    let defer_media =
        (message_list && crate::sessions::media::wants_deferred(&head.headers)).then_some(session).flatten();
    // Validate `x-codenomad-location` shape and query selectors before any session lookup
    // (TS `http-server.ts:1133-1136, 1248-1269` & `proxy-locations.ts:27-34`).
    let parsed_location_context = parse_location_context(&head.headers)?;
    let (mut dir_count, mut loc_dir_count) = (0usize, 0usize);
    let mut invalid_query = false;
    let mut requested_dirs: Vec<String> = Vec::new();
    for (k, v) in target.query_pairs() {
        match k.as_ref() {
            "directory" => {
                dir_count += 1;
                if v.trim().is_empty() || v.contains('\0') {
                    invalid_query = true;
                } else {
                    requested_dirs.push(v.into_owned());
                }
            }
            "location[directory]" => {
                loc_dir_count += 1;
                if v.trim().is_empty() || v.contains('\0') {
                    invalid_query = true;
                } else {
                    requested_dirs.push(v.into_owned());
                }
            }
            "workspace" | "workspaceID" | "location[workspace]" | "location[workspaceID]" => {
                invalid_query = true;
            }
            _ => {}
        }
    }
    if dir_count > 1 || loc_dir_count > 1 || invalid_query {
        return Err(error(Status::BAD_REQUEST, "Location does not belong to workspace"));
    }
    let requested = requested_dirs.first().cloned();
    let prompt_query = if send_input && let Some(raw) = &requested {
        if let Some(translated) = translated_directories.get(raw) {
            Some(translated.clone())
        } else {
            let (location, live, observed) = super::prompt::observe_directory(&app, &workspace, raw).await?;
            let translated = location.directory.clone();
            prompt_locations.push((raw.clone(), location, (live, observed)));
            Some(translated)
        }
    } else {
        None
    };
    static TRACE_FENCE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let trace_fence =
        send_input && *TRACE_FENCE.get_or_init(|| std::env::var_os("CNRS_MUTATION_FENCE_TRACE").is_some());
    let resolve_media_path = |raw: &str| crate::worktrees::ownership::resolve_media_path(&app.scope, raw);
    let allow_subfolder = send_input || message_list;
    // TS checks every client-supplied directory and ambient context before session lookup or relay
    // (`http-server.ts:1248-1269`).
    let mut requested_checkout = None;
    let mut verified_media_dirs: Vec<(String, std::path::PathBuf)> = Vec::new();
    // Hold the admission slot across the entire `message.list` admission phase (query/header
    // checks, `session.get`, session location identity, and `media_directory`/placement inventory),
    // moving the owned permit into `spawn_blocking` probes so cancellation never frees a slot
    // while a detached filesystem worker is still executing.
    static LIST_ADMISSION_SLOTS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    let list_admission_slots = || {
        std::sync::Arc::clone(LIST_ADMISSION_SLOTS.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4))))
    };
    let list_admission_slot = if message_list {
        Some(std::sync::Arc::new(match list_admission_slots().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                _ = workspace_closed() => return Err(not_found()),
                permit = tokio::time::timeout_at(list_deadline, list_admission_slots().acquire_owned()) => {
                    permit.map_err(|_| upstream_error())?.map_err(|_| upstream_error())?
                }
            },
        }))
    } else {
        None
    };
    let admission_work = async {
        for req in &requested_dirs {
            if message_list {
                let Some((resolved, anchor)) =
                    resolve_media_path_async(app.scope.clone(), req.clone(), list_admission_slot.clone()).await
                else {
                    return Err(foreign());
                };
                let _proof = crate::worktrees::ownership::media_directory_with_slot(
                    &app,
                    &workspace,
                    &endpoint,
                    &resolved,
                    &anchor,
                    false,
                    list_admission_slot.clone(),
                )
                .await
                .ok()
                .flatten()
                .ok_or_else(foreign)?;
                verified_media_dirs.push((req.clone(), resolved));
            } else if send_input {
                let Some(physical) = crate::files::paths::canonical(&app.scope, req) else {
                    return Err(foreign());
                };
                let proof =
                    crate::worktrees::ownership::capture_directory_with_refresh(&app, &workspace, &physical, true)
                        .await
                        .ok_or_else(foreign)?;
                if requested_checkout.is_none() {
                    requested_checkout = Some(proof);
                }
            } else if !crate::worktrees::owns(&app, &workspace, req).await {
                return Err(foreign());
            }
        }
        if message_list && let Some(ctx_dir) = parsed_location_context.as_ref().and_then(|v| v["directory"].as_str()) {
            let ctx_resolved = if let Some((_, resolved)) = verified_media_dirs.iter().find(|(raw, _)| raw == ctx_dir) {
                resolved.clone()
            } else {
                let Some((resolved, anchor)) =
                    resolve_media_path_async(app.scope.clone(), ctx_dir.to_owned(), list_admission_slot.clone()).await
                else {
                    return Err(foreign());
                };
                let _proof = crate::worktrees::ownership::media_directory_with_slot(
                    &app,
                    &workspace,
                    &endpoint,
                    &resolved,
                    &anchor,
                    false,
                    list_admission_slot.clone(),
                )
                .await
                .ok()
                .flatten()
                .ok_or_else(foreign)?;
                verified_media_dirs.push((ctx_dir.to_owned(), resolved.clone()));
                resolved
            };
            if requested_dirs.iter().any(|req| {
                verified_media_dirs
                    .iter()
                    .find(|(raw, _)| raw == req)
                    .is_none_or(|(_, resolved)| *resolved != ctx_resolved)
            }) {
                return Err(error(Status::BAD_REQUEST, "Conflicting location context"));
            }
        }
        let actual = if let Some(session) = session {
            Some(if message_list {
                // Drop the full up-to-16 MiB session record before releasing the admission slot;
                // `message.list` only inspects `id` and `location.{directory,workspaceID}`.
                let record = super::session_record_list_at(&app, &endpoint, session).await?;
                let mut location = serde_json::Map::new();
                if let Some(dir) = record["location"]["directory"].as_str() {
                    location.insert("directory".into(), Value::String(dir.to_owned()));
                }
                if let Some(ws) = record["location"].get("workspaceID") {
                    // Preserve any present `workspaceID` (including `null`) so TS ownership
                    // refusal (`"workspaceID" in location`, `manager.ts:337-343`) stays exact
                    // without retaining oversized non-string values.
                    let kept = match ws {
                        Value::String(s) if s.len() <= 514 => Value::String(s.clone()),
                        _ => Value::Null,
                    };
                    location.insert("workspaceID".into(), kept);
                }
                json!({
                    "id": record["id"].as_str().unwrap_or_default(),
                    "location": Value::Object(location),
                })
            } else {
                if trace_fence {
                    eprintln!("mutation-fence prompt {session}: read native session before admission");
                }
                super::session_record_at(&app, &endpoint, session).await?
            })
        } else {
            None
        };
        Ok(actual)
    };
    let actual = if message_list {
        tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
            _ = workspace_closed() => return Err(not_found()),
            result = tokio::time::timeout_at(list_deadline, admission_work) => {
                result.map_err(|_| upstream_error())??
            }
        }
    } else {
        admission_work.await?
    };
    let native_directory = actual.as_ref().and_then(|r| r["location"]["directory"].as_str());
    let directory =
        if send_input { native_directory.or(requested.as_deref()) } else { requested.as_deref().or(native_directory) }
            .unwrap_or(opened);
    let identity_now = || {
        let raw = native_directory?;
        let (resolved, anchor) = if message_list {
            resolve_media_path(raw)?
        } else {
            let path = crate::files::paths::canonical(&app.scope, raw)?;
            (path.clone(), path)
        };
        let identity = crate::files::host_identity(&anchor).ok()?;
        Some((resolved, anchor, identity))
    };
    let initial_identity = if message_list {
        if let Some(raw) = native_directory {
            let (scope, raw) = (app.scope.clone(), raw.to_owned());
            let held_slot = list_admission_slot.clone();
            tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                _ = workspace_closed() => return Err(not_found()),
                res = tokio::time::timeout_at(
                    list_deadline,
                    tokio::task::spawn_blocking(move || {
                        let _slot = held_slot;
                        crate::worktrees::ownership::resolve_media_path(&scope, &raw).and_then(
                            |(resolved, anchor)| {
                                let identity = crate::files::directory_identity(&anchor).ok()?;
                                Some((resolved, anchor, identity))
                            },
                        )
                    }),
                ) => res.map_err(|_| upstream_error())?.map_err(|_| upstream_error())?,
            }
        } else {
            None
        }
    } else {
        allow_subfolder.then(&identity_now).flatten()
    };
    // Always verify the session's own resolved location freshly after `session.get` so an
    // alias retargeted between query validation and `session.get` cannot reuse a stale proof.
    let input_checkout = if message_list {
        if let Some((resolved, anchor, _)) = &initial_identity {
            tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                _ = workspace_closed() => return Err(not_found()),
                proof = tokio::time::timeout_at(
                    list_deadline,
                    crate::worktrees::ownership::media_directory_with_slot(
                        &app,
                        &workspace,
                        &endpoint,
                        resolved,
                        anchor,
                        false,
                        list_admission_slot.clone(),
                    ),
                ) => proof.map_err(|_| upstream_error())?.ok().flatten(),
            }
        } else {
            None
        }
    } else if allow_subfolder && requested.as_deref().is_some_and(|req| Some(req) == native_directory) {
        requested_checkout.take()
    } else if let Some((_, physical, _)) = &initial_identity {
        crate::worktrees::ownership::capture_directory_with_refresh(&app, &workspace, physical, true).await
    } else {
        None
    };
    // TS checks the session's own location first and names a proven
    // departure, so the UI can drop a conversation moved out of the project.
    // For `message_list`, reuse the already-verified `input_checkout` instead of
    // running a second worktree inventory (`list_slug` is only used on session GET).
    let list_slug = match &actual {
        Some(record) if message_list && input_checkout.is_some() && record["location"].get("workspaceID").is_none() => {
            None
        }
        Some(record) => {
            let placement = if message_list {
                tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                    _ = workspace_closed() => return Err(not_found()),
                    res = tokio::time::timeout_at(
                        list_deadline,
                        crate::worktrees::placement(&app, &workspace, &record["location"]),
                    ) => res.map_err(|_| upstream_error())?,
                }
            } else {
                crate::worktrees::placement(&app, &workspace, &record["location"]).await
            };
            match placement {
                Ok(slug) => Some(slug),
                Err(elsewhere) => {
                    if input_checkout.is_some() && record["location"].get("workspaceID").is_none() {
                        None
                    } else {
                        let mut body = json!({"error":"Session does not belong to workspace"});
                        if elsewhere {
                            body["reason"] = json!(SESSION_LOCATED_ELSEWHERE);
                        }
                        return Err((Status::FORBIDDEN, Json(body)));
                    }
                }
            }
        }
        None => None,
    };
    if (allow_subfolder && input_checkout.is_none())
        || (!allow_subfolder && !crate::worktrees::owns(&app, &workspace, directory).await)
    {
        return Err(foreign());
    }
    drop(list_admission_slot);
    target.path_segments_mut().map_err(|_| invalid())?.clear().extend(route.trim_start_matches('/').split('/'));
    if message_list && !verified_media_dirs.is_empty() {
        let pairs: Vec<(String, String)> = target
            .query_pairs()
            .map(|(k, v)| {
                let translated = if matches!(k.as_ref(), "directory" | "location[directory]") {
                    verified_media_dirs
                        .iter()
                        .find(|(raw, _)| raw == v.as_ref())
                        .map(|(_, resolved)| {
                            if *resolved == workspace.path {
                                opened.to_owned()
                            } else {
                                resolved.to_string_lossy().into_owned()
                            }
                        })
                        .unwrap_or_else(|| v.into_owned())
                } else {
                    v.into_owned()
                };
                (k.into_owned(), translated)
            })
            .collect();
        target.query_pairs_mut().clear().extend_pairs(pairs);
    } else {
        target.set_query(head.uri.query());
    }
    if let Some(context) = parsed_location_context {
        if send_input {
            let raw = super::prompt::context(&context)?;
            if let Some((_, existing, _)) = prompt_locations.iter().find(|(seen, _, _)| seen == raw) {
                if prompt_locations.iter().any(|(_, location, _)| location != existing) {
                    return Err(error(Status::BAD_REQUEST, "Conflicting location context"));
                }
            } else {
                let (context, live, observed) = super::prompt::observe_directory(&app, &workspace, raw).await?;
                if prompt_locations.iter().any(|(_, location, _)| location != &context) {
                    return Err(error(Status::BAD_REQUEST, "Conflicting location context"));
                }
                prompt_locations.push((raw.to_owned(), context, (live, observed)));
            }
        } else if !message_list {
            // Match TS `http-server.ts:1224-1269` & `compatibility/location.ts:74-83`: an ambient
            // `x-codenomad-location` only needs to belong to this workspace and agree with any
            // explicit query selector, NOT with the target session's own linked worktree.
            let ctx_dir = context["directory"].as_str().ok_or_else(invalid)?;
            if !crate::worktrees::owns(&app, &workspace, ctx_dir).await {
                return Err(foreign());
            }
            if let Some(req) = requested.as_deref()
                && req != ctx_dir
            {
                return Err(error(Status::BAD_REQUEST, "Conflicting location context"));
            }
        }
        // For `message_list`, shape, ownership, and query conflicts were already verified before
        // session lookup; TS (`location.ts:35-37, 74-84`) strips `x-codenomad-location` and does
        // not inject `x-opencode-directory` on `/api/session/:id/message`.
    }
    let session_list = route == "/api/session" && head.method == Method::GET;
    let cursor = if session_list { crate::opencode::scope::authorize_cursor(&mut target, directory)? } else { None };
    let mut explicit = cursor.is_some();
    let mut project = match cursor {
        Some(crate::opencode::scope::CursorScope::Project(value)) => Some(value),
        _ => None,
    };
    let mut subpath = None;
    let mut seen_directory = false;
    for (key, value) in target.query_pairs() {
        match key.as_ref() {
            "directory" | "location[directory]" => {
                if !message_list && (seen_directory || (prompt_query.is_none() && value != directory)) {
                    return Err(foreign());
                }
                seen_directory = true;
                explicit = (key == "directory") == session_list;
            }
            "project" if session_list => {
                if value.is_empty() || project.replace(value.into_owned()).is_some() {
                    return Err(error(Status::BAD_REQUEST, "Session list does not belong to workspace"));
                }
            }
            "subpath" if session_list => {
                if !crate::opencode::scope::safe_subpath(&value) || subpath.replace(value.into_owned()).is_some() {
                    return Err(error(Status::BAD_REQUEST, "Session list does not belong to workspace"));
                }
            }
            "workspace" | "workspaceID" | "location[workspace]" | "location[workspaceID]" => return Err(foreign()),
            _ => {}
        }
    }
    if let Some(translated) = prompt_query {
        let query: Vec<_> = target
            .query_pairs()
            .into_owned()
            .map(|(key, value)| {
                let value = if matches!(key.as_str(), "directory" | "location[directory]") {
                    translated.clone()
                } else {
                    value
                };
                (key, value)
            })
            .collect();
        target.query_pairs_mut().clear().extend_pairs(query);
    }
    if subpath.is_some() && project.is_none() {
        return Err(error(Status::BAD_REQUEST, "Session list does not belong to workspace"));
    }
    if let Some(project) = &project {
        if subpath.as_deref().is_some_and(|p| !matches!(p, "" | "."))
            || !crate::worktrees::native_project(&app, &workspace, project).await?
        {
            return Err(error(Status::FORBIDDEN, "Session list does not belong to workspace"));
        }
        explicit = true;
    }
    if session_path.is_some_and(|path| path.split('/').next() == Some("global")) {
        return Ok(unavailable());
    }
    if let Some(session) = session {
        let record = actual.as_ref().ok_or_else(upstream_error)?;
        if (!message_list && record["location"]["directory"] != directory)
            || record["location"].get("workspaceID").is_some()
        {
            return Err(error(Status::FORBIDDEN, "Session does not belong to workspace"));
        }
        if head.method != Method::GET {
            if !crate::worktrees::exact_root_supported(&app, &workspace).await? {
                return Ok(unavailable());
            }
            verify_mutation_at(&app, &endpoint, session, directory, record).await?;
        } else if route.strip_prefix("/api/session/").is_some_and(|rest| !rest.contains('/'))
            && head.headers.get(SESSION_PLACEMENT_HEADER).is_some_and(|v| v == "1")
        {
            let mut data = record.clone();
            if let Some(slug) = &list_slug {
                data["listWorktreeSlug"] = json!(slug);
            }
            app.workspace(id)?;
            principal.live()?;
            return Ok(Json(json!({ "data": data })).into_response());
        }
    }
    let create = route == "/api/session" && head.method == Method::POST;
    let fork = session.is_some() && route.ends_with("/fork") && head.method == Method::POST;
    let permissions_patch = session.is_some() && head.method == Method::PATCH;
    let mut root_permissions = None;
    let mut input = None;
    if control.is_some() || matches!(head.method, Method::POST | Method::PUT | Method::PATCH) {
        let data: Value = if let Some(data) = prompt_input.take() {
            data
        } else {
            let contents =
                super::proxy_body::read(pending_body.take().ok_or_else(upstream_error)?, body_limit, declared).await?;
            if contents.is_empty() {
                json!({})
            } else {
                if !head
                    .headers
                    .get(header::CONTENT_TYPE)
                    .is_some_and(|v| v.as_bytes().starts_with(b"application/json"))
                {
                    return Err(if control.is_some() {
                        controls::invalid("Invalid session control")
                    } else {
                        error(Status::BAD_REQUEST, "Session request requires a JSON object")
                    });
                }
                serde_json::from_slice(&contents).map_err(|_| error(Status::BAD_REQUEST, "Invalid JSON"))?
            }
        };
        if let Some(control) = control {
            if data.as_object().is_some_and(schedule_input) {
                return Err(carrier_denied());
            }
            control.validate(&data, &target)?;
            if head.method != Method::DELETE {
                input = Some(data);
            }
        } else {
            let Value::Object(mut data) = data else {
                return Err(error(
                    Status::BAD_REQUEST,
                    if send_input {
                        "Session input requires a JSON object"
                    } else {
                        "Session request requires a JSON object"
                    },
                ));
            };
            if !send_input && data.contains_key("parentID") {
                return Err(error(Status::FORBIDDEN, "Parent session creation is not available through a workspace"));
            }
            if !send_input && let Some(location) = data.get("location") {
                one_location(location, directory)?;
            }
            if schedule_input(&data) {
                return Err(carrier_denied());
            }
            let fields: &[&str] = if create {
                &["title", "location", "agent", "model"]
            } else if fork {
                &["before"]
            } else if permissions_patch {
                &["permissions"]
            } else if route.ends_with("/agent") {
                &["agent"]
            } else if route.ends_with("/model") {
                &["model"]
            } else if route.contains("/instructions/entries/") {
                &["value"]
            } else {
                &["text", "delivery", "id"]
            };
            if !send_input && data.keys().any(|key| !fields.contains(&key.as_str())) {
                return Ok(unavailable());
            }
            if send_input {
                super::prompt::validate(&app, &workspace, &data).await?;
            }
            if create {
                if !crate::worktrees::exact_root_supported(&app, &workspace).await? {
                    return Ok(unavailable());
                }
                data.insert("location".into(), json!({"directory": directory}));
                root_permissions = crate::sessions::permission_mode::new_root(&app, &endpoint, directory, true).await?;
                if let Some(block) = &root_permissions {
                    data.insert("permissions".into(), block.clone());
                }
            }
            input = Some(Value::Object(data));
        }
    }
    let rules_lock = if permissions_patch {
        #[cfg(test)]
        crate::worktrees::fence_test_trace::record("permission rules", "waiting for PATCH lock");
        let id = session.ok_or_else(upstream_error)?;
        let lock = crate::sessions::permission_mode::lock_patch(id, input.as_ref().ok_or_else(upstream_error)?).await?;
        let fresh = super::session_record_at(&app, &endpoint, id).await?;
        let prior = actual.as_ref().ok_or_else(upstream_error)?;
        if ["location", "projectID", "parentID", "fork"].iter().any(|key| fresh[*key] != prior[*key])
            || fresh["time"]["created"] != prior["time"]["created"]
        {
            return Err(foreign());
        }
        Some(lock)
    } else {
        None
    };
    #[cfg(test)]
    if send_input {
        crate::worktrees::fence_test_trace::before_admission().await;
    }
    let mut mutation = if !matches!(head.method, Method::GET | Method::HEAD) {
        use crate::worktrees::fence;
        let physical = match crate::files::paths::canonical(&app.scope, directory) {
            Some(physical) => physical,
            None => {
                let target = crate::worktrees::ownership::resolve_directory(directory)
                    .unwrap_or_else(|| std::path::PathBuf::from(directory));
                if fence::is_blocked(&fence::identity(&target)) {
                    return Err(error(Status::CONFLICT, "Worktree deletion is in progress"));
                }
                return Err(foreign());
            }
        };
        let mut checkouts = vec![fence::identity(&fence::checkout_root(&app.scope, &physical))];
        // Native reads can outlive a deletion. A prospective directory may
        // still resolve lexically after its original checkout has disappeared.
        let mut prospective_fallback = Vec::new();
        let mut live_rechecks = Vec::new();
        for (raw, initial, (initial_live, observed)) in &prompt_locations {
            let key = fence::identity(&initial.checkout);
            if fence::is_blocked(&key) {
                return Err(error(Status::CONFLICT, "Worktree deletion is in progress"));
            }
            let recheck_live = fence::capture_display(&key);
            match super::prompt::directory(&app, &workspace, raw).await {
                Ok(current) if &current == initial => {
                    live_rechecks.push((raw.as_str(), initial, recheck_live));
                }
                _ if fence::is_blocked(&key) => {
                    return Err(error(Status::CONFLICT, "Worktree deletion is in progress"));
                }
                _ if initial_live.load(std::sync::atomic::Ordering::Relaxed)
                    && initial.removed_prospectively(raw, *observed) =>
                {
                    prospective_fallback.push((raw.as_str(), initial, initial_live, *observed));
                }
                _ => return Err(foreign()),
            }
            checkouts.push(key);
        }
        checkouts.extend(session.map(fence::session));
        if trace_fence {
            eprintln!("mutation-fence prompt {session:?}: admit");
        }
        #[cfg(test)]
        if send_input {
            crate::worktrees::fence_test_trace::after_recheck_before_admit().await;
        }
        let permit = fence::admit(&checkouts)?;
        for (raw, initial, initial_live, observed) in prospective_fallback {
            if !initial_live.load(std::sync::atomic::Ordering::Relaxed) || !initial.removed_prospectively(raw, observed)
            {
                return Err(foreign());
            }
        }
        for (raw, initial, recheck_live) in live_rechecks {
            if !recheck_live.load(std::sync::atomic::Ordering::Relaxed) {
                match super::prompt::directory(&app, &workspace, raw).await {
                    Ok(current) if &current == initial => {}
                    _ => return Err(foreign()),
                }
            }
        }
        if create && !crate::worktrees::owns(&app, &workspace, directory).await {
            return Err(foreign());
        }
        Some(permit)
    } else {
        None
    };
    let input_location_live = || {
        initial_identity == identity_now()
            && initial_identity
                .as_ref()
                .zip(input_checkout.as_ref())
                .is_some_and(|((resolved, _, _), checkout)| checkout.live(resolved))
            && crate::sessions::permission_mode::workspace_current(&app, &workspace)
    };
    let recheck_input = || async {
        let (_, physical, _) = initial_identity.as_ref().ok_or_else(foreign)?;
        let admitted = input_checkout.as_ref().ok_or_else(foreign)?;
        if !crate::worktrees::ownership::capture_directory(&app, &workspace, physical)
            .await
            .is_some_and(|current| admitted.same_checkout(&current))
        {
            return Err(foreign());
        }
        let fresh = super::session_record_at(&app, &endpoint, session.ok_or_else(upstream_error)?).await?;
        if !actual.as_ref().is_some_and(|initial| same_target(initial, &fresh))
            || fresh["location"]["directory"] != directory
            || !input_location_live()
        {
            return Err(foreign());
        }
        if marker(&fresh) {
            return Err(carrier_denied());
        }
        principal.live()?;
        if !app.native.current(&endpoint) {
            return Err(super::session_environment::unavailable());
        }
        Ok(fresh)
    };
    if send_input {
        let session = session.ok_or_else(upstream_error)?;
        let mut url = endpoint.url.clone();
        url.path_segments_mut().map_err(|_| upstream_error())?.clear().extend([
            "api",
            "session",
            session,
            "environment",
        ]);
        let unavailable = super::session_environment::unavailable;
        let variables = super::session_environment::snapshot(app.settings.location.config.clone()).await?;
        if command && let Some(Value::Object(input)) = &input {
            super::prompt::validate(&app, &workspace, input).await?;
        }
        recheck_input().await?;
        if prompt_locations.iter().any(|(raw, p, _)| {
            crate::worktrees::ownership::resolve_directory(raw).as_deref() != Some(std::path::Path::new(&p.directory))
        }) {
            return Err(foreign());
        }
        let response = app
            .native
            .client
            .request(Method::PUT, url)
            .basic_auth("opencode", Some(&endpoint.password))
            .json(&json!({"variables":variables}))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| unavailable())?;
        if !response.status().is_success() {
            return Err(unavailable());
        }
        // `syncSessionMemoryContext`: advisory, bounded to its own 2 s budget.
        crate::memory::sync(&app, &endpoint, session, || async { recheck_input().await.is_ok() }).await;
        let fresh = recheck_input().await?;
        #[cfg(test)]
        crate::worktrees::fence_test_trace::record("permission rules", "waiting for send refresh");
        crate::sessions::permission_mode::refresh_before_send(&app, &endpoint, &fresh, || {
            principal.live().is_ok() && app.native.current(&endpoint) && input_location_live()
        })
        .await?;
        #[cfg(test)]
        crate::worktrees::fence_test_trace::record("permission rules", "send refresh finished");
    }
    if !explicit && !create && session.is_none() && !matches!(route, "/api/project" | "/api/session/active") {
        target.query_pairs_mut().append_pair(if session_list { "directory" } else { "location[directory]" }, directory);
    }

    if !app.inner.lock().unwrap().workspaces.iter().any(|w| w.id == workspace.id) {
        return Err(not_found());
    }
    if !app.native.current(&endpoint) {
        return Err(upstream_error());
    }
    let permission_snapshot = if let Some(control) = control {
        control.pending(&app, &endpoint, session.ok_or_else(upstream_error)?).await?
    } else {
        None
    };
    if let Some(form) = human_answer::form_reply(route, &head.method) {
        if human_answer::reply(
            &app,
            &workspace,
            &endpoint,
            &head,
            &principal,
            actual.as_ref().ok_or_else(upstream_error)?,
            form,
            input.as_ref().ok_or_else(upstream_error)?,
            &mut mutation,
        )
        .await?
        {
            return Ok(Status::NO_CONTENT.into_response());
        }
        if !app.native.endpoint().is_some_and(|current| std::sync::Arc::ptr_eq(&current, &endpoint)) {
            return Err(upstream_error());
        }
    }
    let receipt = if let Some(request) = permission_snapshot {
        Some(
            crate::sessions::receipts::prepare(&app, &endpoint, &request, input.as_ref().ok_or_else(upstream_error)?)
                .await?,
        )
    } else {
        None
    };
    if mutation.is_some()
        && !send_input
        && let Some(session) = session
    {
        let fresh = super::session_record_at(&app, &endpoint, session)
            .await
            .map_err(|e| if e.0 == Status::NOT_FOUND { foreign() } else { e })?;
        if actual.as_ref().is_none_or(|record| !same_target(record, &fresh)) {
            return Err(foreign());
        }
        if !crate::sessions::permission_mode::workspace_current(&app, &workspace) {
            return Err(foreign());
        }
        if !app.native.endpoint().is_some_and(|current| std::sync::Arc::ptr_eq(&current, &endpoint)) {
            return Err(upstream_error());
        }
    }
    let mut upstream = app.native.client.request(head.method, target).basic_auth("opencode", Some(&endpoint.password));
    // Forward all sanitized request headers across every proxied route (including Accept,
    // conditionals, Range, If-Range), matching TS `sanitizeInstanceProxyRequestHeaders`
    // (`http-server.ts:1836-1858`). `content-type` is omitted here and set by `.json(input)`
    // whenever a JSON body is forwarded.
    for (name, value) in &head.headers {
        let lower = name.as_str();
        let blocked = matches!(
            lower,
            "authorization"
                | "connection"
                | "cookie"
                | "forwarded"
                | "host"
                | "keep-alive"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "proxy-connection"
                | "set-cookie"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
                | "content-length"
                | "content-type"
                | "x-forwarded-for"
                | "x-forwarded-host"
                | "x-forwarded-port"
                | "x-forwarded-proto"
                | "x-codenomad-location"
                | "x-codenomad-human-answer"
                | "x-codenomad-media"
                | "x-codenomad-pending-reconciliation"
                | "x-codenomad-session-placement"
        ) || lower.starts_with("x-opencode-")
            || is_hop_by_hop_connection_token(&head.headers, lower);
        if !blocked {
            upstream = upstream.header(name, value);
        }
    }
    if let Some(input) = &input {
        upstream = upstream.json(input);
    }
    principal.live()?;
    if send_input {
        if command && let Some(Value::Object(input)) = &input {
            super::prompt::validate(&app, &workspace, input).await?;
        }
        recheck_input().await?;
    }
    if !app.native.current(&endpoint) || !crate::sessions::permission_mode::workspace_current(&app, &workspace) {
        return Err(upstream_error());
    }
    if let Some(session) = defer_media {
        // Banker's admission budget for deadlock-free concurrency: `ResponsePool::List` is 256 MiB,
        // `DEFER_SLOTS = 4` (acquired before `upstream.send()` and held across building + draining),
        // `FAIR_LIST_SHARE = 32 MiB`, and `OUTPUT_LIMIT = 160 MiB`. Up to 3 other active/draining
        // requests hold at most `3 * 32 = 96 MiB`, leaving the full `160 MiB` guaranteed for the
        // single `LARGE_DEFER_SLOT` holder (`96 + 160 = 256 MiB`).
        static DEFER_SLOTS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
        static LARGE_DEFER_SLOT: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
            std::sync::OnceLock::new();
        let defer_slots =
            || std::sync::Arc::clone(DEFER_SLOTS.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4))));
        let large_defer_slot = || {
            std::sync::Arc::clone(LARGE_DEFER_SLOT.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1))))
        };
        const FAIR_LIST_SHARE: usize = 32 * 1024 * 1024;
        let interrupted = || error(Status::BAD_GATEWAY, "OpenCode response was interrupted");
        if !app.native.current(&endpoint) || !crate::sessions::permission_mode::workspace_current(&app, &workspace) {
            return Err(upstream_error());
        }
        principal.live()?;
        // Acquire a concurrency slot BEFORE sending upstream so at most 4 deferred `message.list`
        // requests exist simultaneously across upstream I/O, projection, and downstream draining.
        let slot = match defer_slots().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = workspace_closed() => return Err(not_found()),
                _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                permit = tokio::time::timeout(super::PROXY_IDLE, defer_slots().acquire_owned()) => {
                    permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                }
            },
        };
        if !app.native.current(&endpoint) || !crate::sessions::permission_mode::workspace_current(&app, &workspace) {
            return Err(upstream_error());
        }
        principal.live()?;
        // Recheck local checkout ownership after waiting for `DEFER_SLOTS` so a worktree removed
        // or replaced while queued cannot dispatch an upstream list request.
        let slot = if let (Some(proof), Some((resolved, _, _)), Some(raw_dir)) =
            (&input_checkout, &initial_identity, native_directory)
        {
            let scope = app.scope.clone();
            let raw_dir = raw_dir.to_owned();
            let resolved = resolved.clone();
            let proof = proof.clone();
            let (live, returned_slot) = tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = workspace_closed() => return Err(not_found()),
                _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                res = tokio::time::timeout(
                    super::PROXY_IDLE,
                    tokio::task::spawn_blocking(move || {
                        let live = crate::worktrees::ownership::resolve_media_path(&scope, &raw_dir)
                            .map(|(p, _)| p)
                            .as_ref()
                            == Some(&resolved)
                            && proof.live(&resolved);
                        (live, slot)
                    }),
                ) => res.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
            };
            if !live {
                return Err(foreign());
            }
            if !app.native.current(&endpoint) || !crate::sessions::permission_mode::workspace_current(&app, &workspace)
            {
                return Err(upstream_error());
            }
            returned_slot
        } else {
            slot
        };
        // Once dispatched, TS (`proxy.ts:37-115`, `http-server.ts:261-273`) binds `message.list`
        // only to client disconnect (principal revocation) and OpenCode connection retirement.
        let mut response = tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
            sent = tokio::time::timeout(super::PROXY_IDLE, upstream.send()) => match sent {
                Ok(Ok(response)) => response,
                Ok(Err(_)) => {
                    app.native.invalidate(&endpoint);
                    return Err(upstream_error());
                }
                Err(_) => return Err(interrupted()),
            }
        };
        if response.status().is_success() && is_json_content_type(response.headers()) {
            let status = response.status();
            let headers: Vec<(&'static str, axum::http::HeaderValue)> =
                ["content-type", "cache-control", "etag", "last-modified"]
                    .into_iter()
                    .filter_map(|name| {
                        let mut values = response.headers().get_all(name).iter();
                        let first = values.next()?;
                        let Some(second) = values.next() else {
                            return Some((name, first.clone()));
                        };
                        // Match Fetch `Headers.get()` (TS `compatibility/proxy.ts:73-79`): combine
                        // repeated response headers (e.g. multiple `Cache-Control` lines) with `, `.
                        let mut combined = Vec::new();
                        combined.extend_from_slice(first.as_bytes());
                        combined.extend_from_slice(b", ");
                        combined.extend_from_slice(second.as_bytes());
                        for val in values {
                            combined.extend_from_slice(b", ");
                            combined.extend_from_slice(val.as_bytes());
                        }
                        axum::http::HeaderValue::from_bytes(&combined).ok().map(|v| (name, v))
                    })
                    .collect();
            let mut stream = crate::sessions::media_stream::MessageListStream::new(id, session);
            let mut slot = Some(slot);
            let mut large_slot: Option<tokio::sync::OwnedSemaphorePermit> = None;
            let mut mem: Option<tokio::sync::OwnedSemaphorePermit> = None;
            let mut held_units: u32 = 0;
            let fair_units = crate::shared::response_memory_units(crate::shared::ResponsePool::List, FAIR_LIST_SHARE);
            // Bound total deferred build time (120 s) so a trickle upstream cannot hold
            // `LARGE_DEFER_SLOT` or `DEFER_SLOTS` indefinitely while sending periodic chunks.
            const LIST_BUILD_MAX: Duration = Duration::from_secs(120);
            let build_deadline = tokio::time::Instant::now() + LIST_BUILD_MAX;
            let step_timeout = || {
                let left = build_deadline.saturating_duration_since(tokio::time::Instant::now());
                if left.is_zero() { None } else { Some(super::PROXY_IDLE.min(left)) }
            };
            loop {
                let timeout = step_timeout().ok_or_else(interrupted)?;
                let chunk = tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                    next = tokio::time::timeout(timeout, response.chunk()) => {
                        next.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                    }
                };
                let Some(chunk) = chunk else {
                    break;
                };
                // Clamp pre-reservation to `OUTPUT_LIMIT` (160 MiB) so the `LARGE_DEFER_SLOT`
                // holder never requests more than its guaranteed `256 - 3*32 = 160 MiB` budget,
                // accounting for both the live `chunk` and its copy inside `out`/`item`.
                let pre_needed = crate::shared::response_memory_units(
                    crate::shared::ResponsePool::List,
                    stream
                        .retained_bytes()
                        .saturating_add(chunk.len().saturating_mul(2))
                        .saturating_add(2 * crate::shared::RESPONSE_CHUNK)
                        .min(crate::sessions::media_stream::OUTPUT_LIMIT),
                );
                if pre_needed > fair_units && large_slot.is_none() {
                    let timeout = step_timeout().ok_or_else(interrupted)?;
                    large_slot = Some(tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                        permit = tokio::time::timeout(timeout, large_defer_slot().acquire_owned()) => {
                            permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                        }
                    });
                }
                if pre_needed > held_units {
                    let timeout = step_timeout().ok_or_else(interrupted)?;
                    let extra = tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                        permit = tokio::time::timeout(
                            timeout,
                            crate::shared::acquire_response_units(
                                crate::shared::ResponsePool::List,
                                pre_needed - held_units,
                            ),
                        ) => permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                    };
                    match &mut mem {
                        Some(existing) => existing.merge(extra),
                        None => mem = Some(extra),
                    }
                    held_units = pre_needed;
                }
                let mut pos = 0;
                while let Some(pending) = stream.feed(&chunk, &mut pos).map_err(|_| interrupted())? {
                    // Only reserve the 2x + 8 MiB projection/undo overhead when `project_item`
                    // will actually attempt deferral (`len <= MESSAGE_LIMIT` and `data:image`
                    // present); oversized or image-free items pass through zero-copy.
                    let item_peak = if pending.bytes.len() <= crate::sessions::media::MESSAGE_LIMIT
                        && crate::sessions::media_stream::may_contain_image_uri(&pending.bytes)
                    {
                        pending.bytes.capacity().saturating_mul(2).saturating_add(8 * 1024 * 1024)
                    } else {
                        pending.bytes.capacity()
                    };
                    stream.evict_undo_if_needed(item_peak);
                    let peak_bytes = stream.retained_bytes().saturating_add(item_peak);
                    if peak_bytes > crate::sessions::media_stream::OUTPUT_LIMIT {
                        return Err(interrupted());
                    }
                    let needed = crate::shared::response_memory_units(crate::shared::ResponsePool::List, peak_bytes);
                    if needed > fair_units && large_slot.is_none() {
                        let timeout = step_timeout().ok_or_else(interrupted)?;
                        large_slot = Some(tokio::select! {
                            biased;
                            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                            _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                            permit = tokio::time::timeout(timeout, large_defer_slot().acquire_owned()) => {
                                permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                            }
                        });
                    }
                    if needed > held_units {
                        let timeout = step_timeout().ok_or_else(interrupted)?;
                        let extra = tokio::select! {
                            biased;
                            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                            _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                            permit = tokio::time::timeout(
                                timeout,
                                crate::shared::acquire_response_units(
                                    crate::shared::ResponsePool::List,
                                    needed - held_units,
                                ),
                            ) => permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                        };
                        match &mut mem {
                            Some(existing) => existing.merge(extra),
                            None => mem = Some(extra),
                        }
                        held_units = needed;
                    }
                    let (ws, ses) = stream.ids().ok_or_else(interrupted)?;
                    let (ws, ses) = (ws.to_owned(), ses.to_owned());
                    let held = slot.take().ok_or_else(interrupted)?;
                    let held_large = large_slot.take();
                    let held_mem = mem.take();
                    let raw = pending.bytes;
                    let delimiter = pending.delimiter;
                    let moved_stream = stream;
                    let timeout = step_timeout().ok_or_else(interrupted)?;
                    // Move `slot`, `large_slot`, and `mem` into `spawn_blocking` so cancellation
                    // never releases permits or `LARGE_DEFER_SLOT` while a detached worker holds memory.
                    let (returned_stream, commit_res, returned, returned_large, returned_mem) = tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                        res = tokio::time::timeout(
                            timeout,
                            tokio::task::spawn_blocking(move || {
                                let mut s = moved_stream;
                                let (out, undo) = crate::sessions::media_stream::project_item(&ws, &ses, raw);
                                let commit_res = s.commit_item(out, undo, delimiter);
                                (s, commit_res, held, held_large, held_mem)
                            }),
                        ) => res.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                    };
                    stream = returned_stream;
                    slot = Some(returned);
                    large_slot = returned_large;
                    mem = returned_mem;
                    commit_res.map_err(|_| interrupted())?;
                    // Before resuming `stream.feed` on the remainder of the current chunk, keep
                    // permits >= `retained_bytes + live chunk + remaining copy` (never shrink mid-chunk).
                    let rem_bytes = stream
                        .retained_bytes()
                        .saturating_add(chunk.len())
                        .saturating_add(chunk.len().saturating_sub(pos))
                        .min(crate::sessions::media_stream::OUTPUT_LIMIT);
                    let rem_needed = crate::shared::response_memory_units(crate::shared::ResponsePool::List, rem_bytes);
                    if rem_needed > fair_units && large_slot.is_none() {
                        let timeout = step_timeout().ok_or_else(interrupted)?;
                        large_slot = Some(tokio::select! {
                            biased;
                            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                            _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                            permit = tokio::time::timeout(timeout, large_defer_slot().acquire_owned()) => {
                                permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                            }
                        });
                    }
                    if rem_needed > held_units {
                        let timeout = step_timeout().ok_or_else(interrupted)?;
                        let extra = tokio::select! {
                            biased;
                            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                            _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                            permit = tokio::time::timeout(
                                timeout,
                                crate::shared::acquire_response_units(
                                    crate::shared::ResponsePool::List,
                                    rem_needed - held_units,
                                ),
                            ) => permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                        };
                        match &mut mem {
                            Some(existing) => existing.merge(extra),
                            None => mem = Some(extra),
                        }
                        held_units = rem_needed;
                    }
                }
                let retained = stream.retained_bytes();
                if retained > crate::sessions::media_stream::OUTPUT_LIMIT {
                    return Err(interrupted());
                }
                let needed = crate::shared::response_memory_units(crate::shared::ResponsePool::List, retained);
                if needed > fair_units && large_slot.is_none() {
                    let timeout = step_timeout().ok_or_else(interrupted)?;
                    large_slot = Some(tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                        permit = tokio::time::timeout(timeout, large_defer_slot().acquire_owned()) => {
                            permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                        }
                    });
                }
                if needed > held_units {
                    let timeout = step_timeout().ok_or_else(interrupted)?;
                    let extra = tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                        permit = tokio::time::timeout(
                            timeout,
                            crate::shared::acquire_response_units(
                                crate::shared::ResponsePool::List,
                                needed - held_units,
                            ),
                        ) => permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                    };
                    match &mut mem {
                        Some(existing) => existing.merge(extra),
                        None => mem = Some(extra),
                    }
                    held_units = needed;
                } else if held_units > needed {
                    if needed == 0 {
                        mem = None;
                    } else if let Some(existing) = &mut mem {
                        let _ = existing.split((held_units - needed) as usize);
                    }
                    held_units = needed;
                }
                if held_units <= fair_units {
                    large_slot = None;
                }
            }
            let (payload, payload_len, backing_len, _changed) = if stream.needs_blocking_finish() {
                let held = slot.take().ok_or_else(interrupted)?;
                let held_large = large_slot.take();
                let held_mem = mem.take();
                let timeout = step_timeout().ok_or_else(interrupted)?;
                let (finished, returned, returned_large, returned_mem) = tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                    res = tokio::time::timeout(
                        timeout,
                        tokio::task::spawn_blocking(move || (stream.finish(), held, held_large, held_mem)),
                    ) => res.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                };
                slot = Some(returned);
                large_slot = returned_large;
                mem = returned_mem;
                finished.map_err(|_| interrupted())?
            } else {
                stream.finish().map_err(|_| interrupted())?
            };
            if backing_len > crate::sessions::media_stream::OUTPUT_LIMIT {
                return Err(interrupted());
            }
            let final_units = if backing_len == 0 {
                0
            } else {
                crate::shared::response_memory_units(crate::shared::ResponsePool::List, backing_len)
            };
            if final_units > fair_units && large_slot.is_none() {
                let timeout = step_timeout().ok_or_else(interrupted)?;
                large_slot = Some(tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                    permit = tokio::time::timeout(timeout, large_defer_slot().acquire_owned()) => {
                        permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                    }
                });
            }
            if final_units > held_units {
                let timeout = step_timeout().ok_or_else(interrupted)?;
                let extra = tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                    permit = tokio::time::timeout(
                        timeout,
                        crate::shared::acquire_response_units(
                            crate::shared::ResponsePool::List,
                            final_units - held_units,
                        ),
                    ) => permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                };
                match &mut mem {
                    Some(existing) => existing.merge(extra),
                    None => mem = Some(extra),
                }
            } else if held_units > final_units
                && let Some(existing) = &mut mem
            {
                let _ = existing.split((held_units - final_units) as usize);
            }
            if final_units == 0 {
                mem = None;
            } else if mem.is_none() {
                return Err(interrupted());
            }
            // Keep `slot` and `large_slot` attached to the draining response so at most 4
            // deferred responses exist globally (building OR draining) and at most one holds >32 MiB.
            let drain_large = if final_units > fair_units {
                large_slot.take().map(|p| (p, FAIR_LIST_SHARE))
            } else {
                drop(large_slot);
                None
            };
            let drain_slot = if final_units > 0 {
                slot.take()
            } else {
                drop(slot);
                None
            };
            if !app.native.current(&endpoint) {
                return Err(upstream_error());
            }
            principal.live()?;
            // Preserve upstream `etag` and omit extra `Vary` to match TS `compatibility/proxy.ts:76-94`.
            let length = axum::http::HeaderValue::from(payload_len);
            // Bound total response-drain lifetime (120 s) so a trickle reader cannot pin
            // `ResponsePool::List` permits indefinitely; once materialized and validated, do not
            // truncate on daemon rotation (TS `compatibility/proxy.ts:81-94`).
            const LIST_STREAM_MAX: Duration = Duration::from_secs(120);
            let abort = crate::shared::materialized_stream_abort(principal.0.clone(), LIST_STREAM_MAX);
            let write_abort = crate::shared::materialized_stream_abort(principal.0.clone(), LIST_STREAM_MAX);
            let builder = headers
                .into_iter()
                .fold(Response::builder().status(status), |builder, (name, value)| builder.header(name, value))
                .header(header::CONTENT_LENGTH, length);
            return builder
                .extension(NativeBody)
                .extension(crate::shared::CancelWrite::new(write_abort))
                .body(crate::shared::permit_body_chunks(payload, mem, drain_slot, drain_large, abort))
                .map_err(|_| upstream_error());
        }
        let status = response.status();
        // Fetch `redirect: "error"` rejects only redirect status codes (301/302/303/307/308),
        // letting 300 Multiple Choices pass through to the contract-error handler (TS `transport.ts:45-65`).
        if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            app.native.invalidate(&endpoint);
            return Err(upstream_error());
        }
        let unauthorized = status == Status::UNAUTHORIZED;
        if !status.is_success() && !is_transport_json_content_type(response.headers()) {
            drop(response);
            if status == Status::NOT_MODIFIED {
                // Match TS `transport.ts:59-65`, where `Response.json(..., { status: 304 })` throws
                // and `proxy.ts` converts it to 502 and invalidates the connection.
                app.native.invalidate(&endpoint);
                return Err(upstream_error());
            }
            if unauthorized {
                app.native.invalidate(&endpoint);
            }
            let version = if endpoint.version.is_empty() { "v2" } else { endpoint.version.as_str() };
            return Ok((
                status,
                Json(json!({
                    "_tag": "OpenCodeContractError",
                    "message": format!("OpenCode {version}: GET {route} returned HTTP {}", status.as_u16()),
                    "status": status.as_u16(),
                    "profile": "modern",
                    "method": "GET",
                    "path": route,
                })),
            )
                .into_response());
        }
        if status.is_success() {
            if !app.native.current(&endpoint) {
                return Err(upstream_error());
            }
            principal.live()?;
        }
        struct InvalidateOnDrop {
            app: Shared,
            endpoint: std::sync::Arc<super::Endpoint>,
        }
        impl Drop for InvalidateOnDrop {
            fn drop(&mut self) {
                self.app.native.invalidate(&self.endpoint);
            }
        }
        let builder = relayed(&response);
        use futures_util::StreamExt;
        let cancelled = Box::pin(principal.0.clone().cancelled_owned());
        let app_retire = app.clone();
        let endpoint_retire = endpoint.clone();
        // Matches TS `proxy.ts:33-35`: invalidate a 401 connection only after the native
        // 401 error body finishes streaming downstream, so retiring it does not truncate the body.
        let invalidate = unauthorized.then(|| InvalidateOnDrop { app: app.clone(), endpoint: endpoint.clone() });
        let bytes = futures_util::stream::unfold(
            (response.bytes_stream(), cancelled, app_retire, endpoint_retire, unauthorized, invalidate, false),
            |(mut inner, mut cancelled, app_retire, endpoint_retire, unauthorized, invalidate, done)| async move {
                if done {
                    return None;
                }
                let next = tokio::select! {
                    biased;
                    _ = &mut cancelled => {
                        return Some((
                            Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "upstream stream aborted")),
                            (inner, cancelled, app_retire, endpoint_retire, unauthorized, invalidate, true),
                        ));
                    }
                    _ = app_retire.native.wait_retired(&endpoint_retire), if !unauthorized => {
                        return Some((
                            Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "upstream stream aborted")),
                            (inner, cancelled, app_retire, endpoint_retire, unauthorized, invalidate, true),
                        ));
                    }
                    item = inner.next() => item,
                };
                next.map(|chunk| {
                    (
                        chunk.map_err(std::io::Error::other),
                        (inner, cancelled, app_retire, endpoint_retire, unauthorized, invalidate, false),
                    )
                })
            },
        );
        let cancel_write = if unauthorized {
            crate::shared::CancelWrite::token(principal.0.clone())
        } else {
            crate::shared::CancelWrite::new(crate::shared::proxy_stream_abort(
                app.clone(),
                endpoint.clone(),
                principal.0.clone(),
                None,
            ))
        };
        return builder
            .extension(NativeBody)
            .extension(cancel_write)
            .body(Body::from_stream(bytes))
            .map_err(|_| upstream_error());
    }
    let (route, opened, directory, id) = (route.to_owned(), opened.to_owned(), directory.to_owned(), id.to_owned());
    let dispatched_mutation = mutation.is_some();
    let observer = principal.0.clone();
    let dispatch = move |detached: tokio_util::sync::CancellationToken| async move {
        principal.live()?;
        if detached.is_cancelled()
            || !app.native.current(&endpoint)
            || !crate::sessions::permission_mode::workspace_current(&app, &workspace)
        {
            return Err(upstream_error());
        }
        let ws_closed_headers = async {
            loop {
                let notified = app.workspace_closed.notified();
                if !app.workspace(&id).is_ok_and(|current| current.id == workspace.id && current.path == workspace.path)
                {
                    return;
                }
                notified.await;
            }
        };
        // Undici's default headers deadline for the TypeScript runtime transport.
        // Do not cap the total lifetime of a streaming native response.
        let response = tokio::select! {
            biased;
            _ = principal.0.cancelled(), if !dispatched_mutation => return Err(crate::auth::unauthorized()),
            _ = app.native.wait_retired(&endpoint), if !dispatched_mutation => return Err(upstream_error()),
            _ = ws_closed_headers, if !dispatched_mutation && !message_list => return Err(not_found()),
            response = tokio::time::timeout(super::PROXY_IDLE, upstream.send()) => match response {
                Ok(Ok(response)) => response,
                Ok(Err(_)) => {
                    app.native.invalidate(&endpoint);
                    return Err(upstream_error());
                }
                Err(_) => return Err(upstream_error()),
            },
        };
        if message_list && matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            drop(response);
            app.native.invalidate(&endpoint);
            return Err(upstream_error());
        }
        if message_list && !response.status().is_success() && !is_transport_json_content_type(response.headers()) {
            let status = response.status();
            let unauthorized = status == Status::UNAUTHORIZED;
            drop(response);
            if status == Status::NOT_MODIFIED {
                app.native.invalidate(&endpoint);
                return Err(upstream_error());
            }
            if unauthorized {
                app.native.invalidate(&endpoint);
            }
            let version = if endpoint.version.is_empty() { "v2" } else { endpoint.version.as_str() };
            return Ok((
                status,
                Json(json!({
                    "_tag": "OpenCodeContractError",
                    "message": format!("OpenCode {version}: GET {route} returned HTTP {}", status.as_u16()),
                    "status": status.as_u16(),
                    "profile": "modern",
                    "method": "GET",
                    "path": route,
                })),
            )
                .into_response());
        }
        if message_list && response.status().is_success() {
            if !app.native.current(&endpoint) {
                return Err(upstream_error());
            }
            principal.live()?;
        }
        if response.status().is_success() {
            if let Some(receipt) = receipt {
                if let Err(error) = receipt.confirm(&app, &workspace).await {
                    eprintln!("Permission confirmed; receipt persistence failed: {}", error.0);
                }
            }
        }
        if fork && response.status().is_success() {
            let builder = relayed(&response);
            let native = read_json(response, 2 * 1024 * 1024).await.map_err(|_| upstream_error())?;
            let row = native.get("data").unwrap_or(&native);
            let source = actual.as_ref().ok_or_else(upstream_error)?;
            if row["projectID"] != source["projectID"]
                || row["fork"]["sessionID"] != source["id"]
                || row["location"] != source["location"]
            {
                return Err(foreign());
            }
            let _ = crate::sessions::permission_mode::observe_fork(&app, &endpoint, &workspace, row, source).await;
            return builder.extension(NativeBody).body(Body::from(native.to_string())).map_err(|_| upstream_error());
        }
        if let Some(block) = root_permissions.filter(|_| response.status().is_success()) {
            let builder = relayed(&response);
            let native = read_json(response, 2 * 1024 * 1024).await.map_err(|_| upstream_error())?;
            let row = native.get("data").unwrap_or(&native);
            let session = row["id"].as_str().ok_or_else(upstream_error)?;
            let project = row["projectID"].as_str().filter(|s| !s.is_empty()).ok_or_else(upstream_error)?;
            crate::sessions::permission_mode::confirm_root(
                &app,
                &endpoint,
                &directory,
                project,
                session,
                &block,
                false,
                || crate::sessions::permission_mode::workspace_current(&app, &workspace),
            )
            .await?;
            return builder.extension(NativeBody).body(Body::from(native.to_string())).map_err(|_| upstream_error());
        }
        if response.status().is_success() && project.is_some() {
            let builder = relayed(&response);
            let mut native = read_json(response, 8 * 1024 * 1024).await.map_err(|_| upstream_error())?;
            if !crate::worktrees::native_project(&app, &workspace, project.as_deref().unwrap()).await? {
                return Err(error(Status::FORBIDDEN, "Session list does not belong to workspace"));
            }
            let rows = native["data"].as_array_mut().ok_or_else(upstream_error)?;
            let catalogue = crate::worktrees::linked::catalogue(&app, &workspace, false).await?;
            rows.retain(|row| {
                row["location"].get("workspaceID").is_none()
                    && row["location"]["directory"].as_str().is_some_and(|p| catalogue.by_directory(p).is_some())
            });
            app.workspace(&id)?;
            principal.live()?;
            return builder.extension(NativeBody).body(Body::from(native.to_string())).map_err(|_| upstream_error());
        }
        if response.status().is_success() && matches!(route.as_str(), "/api/project" | "/api/session/active") {
            let mut native: Value = response.json().await.map_err(|_| upstream_error())?;
            if route == "/api/project" {
                let mut projects = native.as_array().cloned().ok_or_else(upstream_error)?;
                let catalogue = crate::worktrees::linked::catalogue(&app, &workspace, false).await.ok();
                projects.retain(|project| {
                    project["canonical"].as_str().and_then(|s| dunce::canonicalize(s).ok()).as_ref()
                        == Some(catalogue.as_ref().map_or(&workspace.path, |c| &c.main))
                        && catalogue.as_ref().is_none_or(|c| project["id"] == c.project)
                });
                for project in &mut projects {
                    if let Some(paths) = project["sandboxes"].as_array_mut() {
                        paths.retain(|path| {
                            path.as_str().is_some_and(|p| {
                                p == opened || catalogue.as_ref().is_some_and(|c| c.by_registered(p).is_some())
                            })
                        });
                    }
                }
                return Ok(Json(projects).into_response());
            }
            let active = native["data"].as_object_mut().ok_or_else(upstream_error)?;
            for id in active.keys().cloned().collect::<Vec<_>>() {
                if session_directory(&app, &id).await.as_deref().ok() != Some(directory.as_str()) {
                    active.remove(&id);
                }
            }
            return Ok(Json(native).into_response());
        }
        let status = response.status();
        let unauthorized = status == Status::UNAUTHORIZED;
        let builder = relayed(&response);
        let builder = if dispatched_mutation {
            builder
        } else if unauthorized {
            builder.extension(crate::shared::CancelWrite::token(principal.0.clone()))
        } else if message_list {
            builder.extension(crate::shared::CancelWrite::new(crate::shared::proxy_stream_abort(
                app.clone(),
                endpoint.clone(),
                principal.0.clone(),
                None,
            )))
        } else {
            builder.extension(crate::shared::CancelWrite::new(crate::shared::stream_abort(
                app.clone(),
                id.clone(),
                workspace.clone(),
                endpoint.clone(),
                principal.0.clone(),
            )))
        };
        use futures_util::StreamExt;
        let cancelled = Box::pin(principal.0.clone().cancelled_owned());
        let app_retire = app.clone();
        let endpoint_retire = endpoint.clone();
        let ws_key = id.clone();
        let ws_snapshot = workspace.clone();
        let ws_app = app.clone();
        let ws_closed = Box::pin(async move {
            if dispatched_mutation || message_list {
                std::future::pending::<()>().await;
            }
            loop {
                let notified = ws_app.workspace_closed.notified();
                if !ws_app
                    .workspace(&ws_key)
                    .is_ok_and(|current| current.id == ws_snapshot.id && current.path == ws_snapshot.path)
                {
                    return;
                }
                notified.await;
            }
        });
        struct InvalidateOnDrop {
            app: Shared,
            endpoint: std::sync::Arc<super::Endpoint>,
        }
        impl Drop for InvalidateOnDrop {
            fn drop(&mut self) {
                self.app.native.invalidate(&self.endpoint);
            }
        }
        let invalidate = unauthorized.then(|| InvalidateOnDrop { app: app.clone(), endpoint: endpoint.clone() });
        let bytes = futures_util::stream::unfold(
            (
                response.bytes_stream(),
                cancelled,
                ws_closed,
                app_retire,
                endpoint_retire,
                dispatched_mutation,
                unauthorized,
                invalidate,
                false,
            ),
            |(
                mut inner,
                mut cancelled,
                mut ws_closed,
                app_retire,
                endpoint_retire,
                dispatched_mutation,
                unauthorized,
                invalidate,
                done,
            )| async move {
                if done {
                    return None;
                }
                let next = tokio::select! {
                    biased;
                    _ = &mut cancelled, if !dispatched_mutation => {
                        return Some((
                            Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "upstream stream aborted")),
                            (
                                inner,
                                cancelled,
                                ws_closed,
                                app_retire,
                                endpoint_retire,
                                dispatched_mutation,
                                unauthorized,
                                invalidate,
                                true,
                            ),
                        ));
                    }
                    _ = &mut ws_closed, if !dispatched_mutation => {
                        return Some((
                            Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "workspace closed")),
                            (
                                inner,
                                cancelled,
                                ws_closed,
                                app_retire,
                                endpoint_retire,
                                dispatched_mutation,
                                unauthorized,
                                invalidate,
                                true,
                            ),
                        ));
                    }
                    _ = app_retire.native.wait_retired(&endpoint_retire), if !dispatched_mutation && !unauthorized => {
                        return Some((
                            Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "upstream stream aborted")),
                            (
                                inner,
                                cancelled,
                                ws_closed,
                                app_retire,
                                endpoint_retire,
                                dispatched_mutation,
                                unauthorized,
                                invalidate,
                                true,
                            ),
                        ));
                    }
                    item = inner.next() => item,
                };
                next.map(|chunk| {
                    (
                        chunk.map_err(std::io::Error::other),
                        (
                            inner,
                            cancelled,
                            ws_closed,
                            app_retire,
                            endpoint_retire,
                            dispatched_mutation,
                            unauthorized,
                            invalidate,
                            false,
                        ),
                    )
                })
            },
        );
        builder.extension(NativeBody).body(Body::from_stream(bytes)).map_err(|_| upstream_error())
    };
    if let Some(permit) = mutation {
        super::proxy_write::forward(permit, rules_lock, observer, dispatch).await
    } else {
        dispatch(tokio_util::sync::CancellationToken::new()).await
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
