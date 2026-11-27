//! /workspaces/:id/instance/*: the allowlisted relay to the daemon, confined to the workspace's
//! locations and sessions.
#[cfg(test)]
mod account_tests;
#[cfg(test)]
mod background_tests;
mod defer_media;
mod dispatch;
mod guards;
#[cfg(test)]
mod inbox_tests;
mod mutation;
#[cfg(test)]
mod stack_tests;

pub use guards::verify_mutation;
use guards::verify_mutation_at;
pub(crate) use guards::verify_ordinary_session_at;

use std::time::Duration;

use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use super::{SESSION_LOCATED_ELSEWHERE, SESSION_PLACEMENT_HEADER, controls, upstream_error};
use crate::{Error, Shared, error, not_found, unavailable};
use guards::{
    ALLOWED, carrier_denied, foreign, guarded, is_account_no_store_route, is_hop_by_hop_connection_token,
    parse_location_context, resolve_media_path_async, safe_route, schedule_input, valid_segment,
};

pub(in crate::opencode) fn before_dispatch_error((status, body): Error) -> Response {
    (status, [("x-codenomad-before-dispatch", "1")], body).into_response()
}

fn is_account_proxy_path(path: &str, method: &Method) -> bool {
    let Some(suffix) =
        path.strip_prefix("/workspaces/").and_then(|t| t.split_once('/')).and_then(|(_, s)| s.strip_prefix("instance"))
    else {
        return false;
    };
    if let Some(route) = safe_route(suffix) {
        let route = route.trim_end_matches('/');
        if is_account_no_store_route(route, method) {
            return true;
        }
    }
    let trimmed = suffix.trim_end_matches('/');
    trimmed == "/api/credential"
        || trimmed.starts_with("/api/credential/")
        || (trimmed.starts_with("/api/integration/") && trimmed.contains("/connect/"))
}

pub async fn relay(State(app): State<Shared>, request: Request) -> Result<Response, Error> {
    let no_store = is_account_proxy_path(request.uri().path(), request.method());
    let result = Box::pin(relay_inner(app, request)).await;
    if no_store {
        let mut response = match result {
            Ok(response) => response,
            Err(err) => err.into_response(),
        };
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        Ok(response)
    } else {
        result
    }
}

async fn relay_inner(app: Shared, request: Request) -> Result<Response, Error> {
    let send_input = is_send_input_request(request.method(), request.uri().path());
    match Box::pin(prepare_relay(app, request, send_input)).await {
        Ok(PreparedRelay::Response(mut response)) => {
            if send_input && !response.status().is_success() {
                response.headers_mut().insert("x-codenomad-before-dispatch", header::HeaderValue::from_static("1"));
            }
            Ok(response)
        }
        Ok(PreparedRelay::Dispatch(ctx)) => Box::pin(dispatch::dispatch_upstream(*ctx)).await,
        Err(err) if send_input => Ok(before_dispatch_error(err)),
        Err(err) => Err(err),
    }
}

fn is_send_input_request(method: &Method, path: &str) -> bool {
    if *method != Method::POST {
        return false;
    }
    let path = path.split(';').next().unwrap_or(path);
    let Some(tail) = path.strip_prefix("/workspaces/") else {
        return false;
    };
    let Some((_, suffix)) = tail.split_once('/') else {
        return false;
    };
    let Some(suffix) = suffix.strip_prefix("instance") else {
        return false;
    };
    let Some(route) = safe_route(suffix) else {
        return false;
    };
    let route = route.strip_suffix('/').unwrap_or(&route);
    route.starts_with("/api/session/") && (route.ends_with("/prompt") || route.ends_with("/command"))
}

enum PreparedRelay {
    Response(Response),
    Dispatch(Box<dispatch::DispatchContext>),
}

async fn prepare_relay(app: Shared, request: Request, send_input_hint: bool) -> Result<PreparedRelay, Error> {
    let (head, body) = request.into_parts();
    let principal = head.extensions.get::<crate::auth::Principal>().cloned().ok_or_else(crate::auth::unauthorized)?;
    let invalid = || error(Status::BAD_REQUEST, "Invalid workspace instance path");
    let raw_path =
        if send_input_hint { head.uri.path().split(';').next().unwrap_or(head.uri.path()) } else { head.uri.path() };
    let tail = raw_path.strip_prefix("/workspaces/").ok_or_else(invalid)?;
    let (id, suffix) = tail.split_once('/').ok_or_else(invalid)?;
    let suffix = suffix.strip_prefix("instance").ok_or_else(invalid)?;
    let workspace = app.workspace(id)?;
    let workspace_closed = || async {
        loop {
            let notified = app.workspace_closed.notified();
            if !app.workspace(id).is_ok_and(|current| current.id == workspace.id && current.path == workspace.path) {
                return;
            }
            notified.await;
        }
    };
    let route = safe_route(suffix).ok_or_else(invalid)?;
    let route = route.strip_suffix('/').unwrap_or(&route);
    if (route.starts_with("/api/credential/")
        || (route.starts_with("/api/integration/") && route.contains("/connect/")))
        && route.trim_start_matches('/').split('/').any(|seg| !valid_segment(seg))
    {
        return Err(invalid());
    }
    let prompt = head.method == Method::POST && route.starts_with("/api/session/") && route.ends_with("/prompt");
    let command = head.method == Method::POST && route.starts_with("/api/session/") && route.ends_with("/command");
    let send_input = prompt || command;
    let body_limit = if prompt { super::prompt::BODY_LIMIT } else { 1024 * 1024 };
    let control = controls::classify(route, &head.method);
    if !ALLOWED.iter().any(|(m, pat)| *m == head.method.as_str() && pat.is_match(route)) {
        return Err(error(Status::FORBIDDEN, "OpenCode route is not available through a workspace"));
    }
    if control.is_none() && !guarded(route, &head.method) {
        return Ok(PreparedRelay::Response(unavailable()));
    }
    let declared =
        head.headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
    if (control.is_some() || matches!(head.method, Method::POST | Method::PUT | Method::PATCH | Method::DELETE))
        && declared.is_some_and(|length| length > body_limit)
    {
        tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = workspace_closed() => return Err(not_found()),
            _ = super::proxy_body::read(body, body_limit, declared) => {}
        }
        principal.live()?;
        if !app.workspace(id).is_ok_and(|current| current.id == workspace.id && current.path == workspace.path) {
            return Err(not_found());
        }
        return Err(super::proxy_body::too_large());
    }
    let mut pending_body = Some(body);
    let mut prompt_directories = Vec::new();
    let mut prompt_input = if send_input {
        let bytes = tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = workspace_closed() => return Err(not_found()),
            res = super::proxy_body::read(pending_body.take().ok_or_else(upstream_error)?, body_limit, declared) => {
                res?
            }
        };
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
    let account_route = is_account_no_store_route(route, &head.method);
    let list_deadline = tokio::time::Instant::now() + super::PROXY_IDLE;
    let deadline = if message_list {
        list_deadline.min(tokio::time::Instant::now() + Duration::from_secs(30))
    } else {
        tokio::time::Instant::now() + Duration::from_secs(30)
    };
    let endpoint = tokio::select! {
        biased;
        _ = principal.0.cancelled() => {
            return if send_input {
                Ok(PreparedRelay::Response(crate::auth::unauthorized_before_dispatch()))
            } else {
                Err(crate::auth::unauthorized())
            };
        }
        _ = workspace_closed() => return Err(not_found()),
        acquired = app.native.acquire(deadline) => match acquired {
            Ok(endpoint) => endpoint,
            Err(ref refusal @ super::admission::Refusal::Unsupported { ref actual, reason }) => {
                let body = if account_route {
                    json!({
                        "error": "opencode_update_required",
                        "message": "OpenCode update required",
                        "minimumVersion": super::admission::MINIMUM_VERSION,
                        "reason": reason,
                    })
                } else {
                    json!({
                        "error": "opencode_update_required",
                        "message": refusal.to_string(),
                        "actualVersion": actual,
                        "minimumVersion": super::admission::MINIMUM_VERSION,
                        "reason": reason,
                    })
                };
                return Err((Status::UPGRADE_REQUIRED, Json(body)));
            }
            Err(_) => return Err(if send_input { super::pre_dispatch_unavailable() } else { upstream_error() }),
        },
    };
    // Ensure bundled plugins are prepared for this captured connection before dispatching
    // (TS `opencode-service.ts:148-166`). Fast-paths when `STATE.prepared` already matches.
    tokio::select! {
        biased;
        _ = principal.0.cancelled() => {
            return if send_input {
                Ok(PreparedRelay::Response(crate::auth::unauthorized_before_dispatch()))
            } else {
                Err(crate::auth::unauthorized())
            };
        }
        _ = app.native.wait_retired(&endpoint) => {
            return Err(if send_input { super::pre_dispatch_unavailable() } else { upstream_error() });
        }
        _ = workspace_closed() => return Err(not_found()),
        _ = tokio::time::timeout_at(deadline, crate::extensions::lifecycle::prepare(&app, &endpoint)) => {}
    }
    if dunce::canonicalize(opened).ok().as_ref() != Some(&workspace.path) {
        return Err(foreign());
    }
    let mut translated_directories = std::collections::BTreeMap::new();
    let mut prompt_locations = Vec::new();
    for directory in prompt_directories {
        let (translated, live, observed) =
            Box::pin(super::prompt::observe_directory(&app, &workspace, &directory)).await?;
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
    let global_form = controls::is_global_form(route, &head.method);
    let global_form_directory = if global_form {
        let invalid_form = || error(Status::BAD_REQUEST, "Invalid Form location");
        if head.headers.contains_key("x-opencode-workspace") {
            return Err(invalid_form());
        }
        let mut values = head.headers.get_all("x-opencode-directory").iter();
        let header_dir = if let Some(value) = values.next() {
            if values.next().is_some() {
                return Err(invalid_form());
            }
            let raw = value.to_str().ok().ok_or_else(invalid_form)?;
            let decoded = crate::shared::decode_component(raw).ok_or_else(invalid_form)?;
            if decoded.trim().is_empty() || decoded.contains('\0') {
                return Err(invalid_form());
            }
            Some(decoded)
        } else {
            None
        };
        if let Some(ctx) = &parsed_location_context {
            let expected = header_dir.as_deref().unwrap_or(opened);
            if ctx["directory"].as_str() != Some(expected) {
                return Err(error(Status::BAD_REQUEST, "Conflicting Form location"));
            }
        }
        if let Some(dir) = &header_dir {
            if !crate::worktrees::owns(&app, &workspace, dir).await {
                return Err(foreign());
            }
        }
        header_dir
    } else {
        None
    };
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
            let (location, live, observed) = Box::pin(super::prompt::observe_directory(&app, &workspace, raw)).await?;
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
    let inbox_or_background = session.is_some()
        && ((head.method == Method::GET && route.ends_with("/inbox"))
            || (matches!(head.method, Method::PATCH | Method::DELETE)
                && route
                    .strip_prefix("/api/session/")
                    .and_then(|r| r.split_once("/inbox/"))
                    .is_some_and(|(sid, item)| !sid.is_empty() && !item.is_empty() && !item.contains('/')))
            || (head.method == Method::POST && route.ends_with("/background")));
    let allow_subfolder = send_input || message_list || inbox_or_background;
    // TS checks every client-supplied directory and ambient context before session lookup or relay
    // (`http-server.ts:1248-1269`).
    let mut requested_checkout = None;
    let mut verified_media_dirs: Vec<(String, std::path::PathBuf)> = Vec::new();
    let mut extra_mutation_dirs: Vec<(
        String,
        std::path::PathBuf,
        String,
        crate::worktrees::ownership::DirectoryProof,
    )> = Vec::new();
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
            } else if send_input || inbox_or_background {
                let Some((resolved, physical, dir_id)) = guards::directory_identity(&app.scope, Some(req), false)
                else {
                    return Err(foreign());
                };
                if resolved != physical {
                    return Err(foreign());
                }
                let proof =
                    crate::worktrees::ownership::capture_directory_with_refresh(&app, &workspace, &physical, true)
                        .await
                        .ok_or_else(foreign)?;
                if inbox_or_background {
                    extra_mutation_dirs.push((req.clone(), physical, dir_id, proof));
                } else if requested_checkout.is_none() {
                    requested_checkout = Some(proof);
                }
            } else if !account_route && !crate::worktrees::owns(&app, &workspace, req).await {
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
                super::session_record_at(&app, &endpoint, session).await.map_err(|e| {
                    if send_input && e.0 == Status::BAD_GATEWAY { super::pre_dispatch_unavailable() } else { e }
                })?
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
        tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
            _ = workspace_closed() => return Err(not_found()),
            result = admission_work => result?,
        }
    };
    let native_directory = actual.as_ref().and_then(|r| r["location"]["directory"].as_str());
    let bound_directory = if send_input {
        let mut values = head.headers.get_all("x-codenomad-session-directory").iter();
        if let Some(raw_bound) = values.next() {
            if values.next().is_some() {
                return Err(error(Status::BAD_REQUEST, "Invalid session directory header"));
            }
            let bound = raw_bound
                .to_str()
                .ok()
                .filter(|v| v.len() <= 16_384)
                .and_then(crate::shared::decode_component)
                .ok_or_else(|| error(Status::BAD_REQUEST, "Invalid session directory header"))?;
            let matches_native = native_directory.is_some_and(|native| {
                native == bound
                    || crate::files::paths::canonical(&app.scope, native)
                        .zip(crate::files::paths::canonical(&app.scope, &bound))
                        .is_some_and(|(a, b)| a == b)
            });
            if !matches_native {
                return Err(foreign());
            }
            Some(bound)
        } else {
            None
        }
    } else {
        None
    };
    let directory = if send_input || inbox_or_background {
        native_directory.or(requested.as_deref())
    } else if global_form_directory.is_some() {
        global_form_directory.as_deref()
    } else {
        requested.as_deref().or(native_directory)
    }
    .unwrap_or(opened);
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
        allow_subfolder.then(|| guards::directory_identity(&app.scope, native_directory, message_list)).flatten()
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
    } else if send_input && requested.as_deref().is_some_and(|req| Some(req) == native_directory) {
        requested_checkout.take()
    } else if let Some((_, physical, _)) = &initial_identity {
        tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
            _ = workspace_closed() => return Err(not_found()),
            proof = crate::worktrees::ownership::capture_directory_with_refresh(&app, &workspace, physical, true) => {
                proof
            }
        }
    } else {
        None
    };
    // TS checks the session's own location first and names a proven
    // departure, so the UI can drop a conversation moved out of the project.
    // For `message_list`, reuse the already-verified `input_checkout` instead of
    // running a second worktree inventory (`list_slug` is only used on session GET).
    let verified_placement = match &actual {
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
                        crate::worktrees::placement_verified(&app, &workspace, &record["location"]),
                    ) => res.map_err(|_| upstream_error())?,
                }
            } else {
                tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                    _ = workspace_closed() => return Err(not_found()),
                    res = crate::worktrees::placement_verified(&app, &workspace, &record["location"]) => res,
                }
            };
            match placement {
                Ok(verified) => Some(verified),
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
    let list_slug = verified_placement.as_ref().map(|p| p.slug.clone());
    if allow_subfolder {
        if input_checkout.is_none() {
            return Err(foreign());
        }
    } else {
        let reused_ok =
            if let Some(verified) = verified_placement.as_ref().filter(|_| native_directory == Some(directory)) {
                let verified = verified.clone();
                let scope = app.scope.clone();
                let ws = workspace.clone();
                let dir = directory.to_owned();
                tokio::task::spawn_blocking(move || verified.owns_now(&scope, &ws, &dir)).await.unwrap_or(false)
            } else {
                false
            };
        if !account_route && !reused_ok && !crate::worktrees::owns(&app, &workspace, directory).await {
            return Err(foreign());
        }
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
    let location_context_dir =
        parsed_location_context.as_ref().and_then(|v| v["directory"].as_str()).map(str::to_owned);
    if let Some(context) = parsed_location_context {
        if send_input {
            let raw = super::prompt::context(&context)?;
            if let Some((_, existing, _)) = prompt_locations.iter().find(|(seen, _, _)| seen == raw) {
                if prompt_locations.iter().any(|(_, location, _)| location != existing) {
                    return Err(error(Status::BAD_REQUEST, "Conflicting location context"));
                }
            } else {
                let (context, live, observed) =
                    Box::pin(super::prompt::observe_directory(&app, &workspace, raw)).await?;
                if prompt_locations.iter().any(|(_, location, _)| location != &context) {
                    return Err(error(Status::BAD_REQUEST, "Conflicting location context"));
                }
                prompt_locations.push((raw.to_owned(), context, (live, observed)));
            }
        } else if inbox_or_background {
            let ctx_dir = context["directory"].as_str().ok_or_else(invalid)?;
            let Some((resolved, physical, dir_id)) = guards::directory_identity(&app.scope, Some(ctx_dir), false)
            else {
                return Err(foreign());
            };
            if resolved != physical {
                return Err(foreign());
            }
            let proof = tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                _ = workspace_closed() => return Err(not_found()),
                proof = crate::worktrees::ownership::capture_directory_with_refresh(&app, &workspace, &physical, true) => {
                    proof.ok_or_else(foreign)?
                }
            };
            if extra_mutation_dirs.iter().any(|(_, req_phys, _, _)| *req_phys != physical) {
                return Err(error(Status::BAD_REQUEST, "Conflicting location context"));
            }
            extra_mutation_dirs.push((ctx_dir.to_owned(), physical, dir_id, proof));
        } else if !message_list && !account_route {
            // Match TS `http-server.ts:1224-1269` & `compatibility/location.ts:74-83`: an ambient
            // `x-codenomad-location` only needs to belong to this workspace and agree with any
            // explicit query selector, NOT with the target session's own linked worktree.
            let ctx_dir = context["directory"].as_str().ok_or_else(invalid)?;
            let ctx_verified =
                if let Some(verified) = verified_placement.as_ref().filter(|_| native_directory == Some(ctx_dir)) {
                    let verified = verified.clone();
                    let scope = app.scope.clone();
                    let ws = workspace.clone();
                    let dir = ctx_dir.to_owned();
                    tokio::task::spawn_blocking(move || verified.owns_now(&scope, &ws, &dir)).await.unwrap_or(false)
                } else {
                    false
                };
            if !ctx_verified && !crate::worktrees::owns(&app, &workspace, ctx_dir).await {
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
                if !message_list
                    && !account_route
                    && !inbox_or_background
                    && (seen_directory || (prompt_query.is_none() && value != directory))
                {
                    return Err(foreign());
                }
                seen_directory = true;
                explicit = account_route || (key == "directory") == session_list;
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
        if !global_form {
            return Ok(PreparedRelay::Response(unavailable()));
        }
        if !crate::worktrees::exact_root_supported(&app, &workspace).await? {
            return Ok(PreparedRelay::Response(unavailable()));
        }
    }
    if let Some(session) = session {
        let record = actual.as_ref().ok_or_else(upstream_error)?;
        if (!message_list && record["location"]["directory"] != directory)
            || record["location"].get("workspaceID").is_some()
        {
            return Err(error(Status::FORBIDDEN, "Session does not belong to workspace"));
        }
        if head.method != Method::GET {
            let exact_root = tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(&endpoint) => {
                    return Err(if send_input { super::pre_dispatch_unavailable() } else { upstream_error() });
                }
                _ = workspace_closed() => return Err(not_found()),
                result = crate::worktrees::exact_root_supported(&app, &workspace) => result?,
            };
            if !exact_root {
                return Ok(PreparedRelay::Response(unavailable()));
            }
            tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(&endpoint) => {
                    return Err(if send_input { super::pre_dispatch_unavailable() } else { upstream_error() });
                }
                _ = workspace_closed() => return Err(not_found()),
                result = verify_mutation_at(&app, &endpoint, session, directory, record) => result.map_err(|e| {
                    if send_input && e.0 == Status::BAD_GATEWAY { super::pre_dispatch_unavailable() } else { e }
                })?,
            }
        } else if route.strip_prefix("/api/session/").is_some_and(|rest| !rest.contains('/'))
            && head.headers.get(SESSION_PLACEMENT_HEADER).is_some_and(|v| v == "1")
        {
            let mut data = record.clone();
            if let Some(slug) = &list_slug {
                data["listWorktreeSlug"] = json!(slug);
            }
            app.workspace(id)?;
            if principal.0.is_cancelled() {
                return Ok(PreparedRelay::Response(crate::auth::unauthorized_before_dispatch()));
            }
            return Ok(PreparedRelay::Response(Json(json!({ "data": data })).into_response()));
        }
    }
    let recheck = mutation::InputRecheck {
        app: &app,
        workspace: &workspace,
        endpoint: &endpoint,
        principal: &principal,
        session,
        directory,
        native_directory,
        bound_directory: bound_directory.as_deref(),
        message_list,
        actual: &actual,
        initial_identity: &initial_identity,
        input_checkout: &input_checkout,
    };
    let mutation::PreparedMutation {
        fork,
        root_permissions,
        input,
        rules_lock,
        mutation,
        account_manual,
        account_context_dir,
        account_verified_locs,
        receipt,
    } = match Box::pin(mutation::prepare_mutation(mutation::MutationContext {
        recheck: &recheck,
        head: &head,
        route,
        control,
        send_input,
        command,
        body_limit,
        declared,
        pending_body: &mut pending_body,
        prompt_input: &mut prompt_input,
        prompt_locations: &prompt_locations,
        extra_mutation_dirs: &extra_mutation_dirs,
        trace_fence,
        explicit: explicit || global_form_directory.is_some(),
        requested_dirs: &requested_dirs,
        location_context_dir: location_context_dir.as_deref(),
        session_list,
        target: &mut target,
    }))
    .await?
    {
        mutation::MutationOutcome::Ready(prepared) => prepared,
        mutation::MutationOutcome::Early(response) => return Ok(PreparedRelay::Response(response)),
    };
    let method_str = head.method.to_string();
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
                | "x-codenomad-session-directory"
                | "x-codenomad-session-placement"
        ) || lower.starts_with("x-opencode-")
            || is_hop_by_hop_connection_token(&head.headers, lower);
        if !blocked {
            upstream = upstream.header(name, value);
        }
    }
    if let Some(dir) = global_form_directory.as_ref().or(account_context_dir.as_ref()) {
        let encoded = percent_encoding::utf8_percent_encode(dir, percent_encoding::NON_ALPHANUMERIC).to_string();
        upstream = upstream.header("x-opencode-directory", encoded);
    }
    if let Some(input) = &input {
        upstream = upstream.json(input);
    }
    if principal.0.is_cancelled() {
        return Ok(PreparedRelay::Response(crate::auth::unauthorized_before_dispatch()));
    }
    if send_input {
        if command && let Some(Value::Object(input)) = &input {
            Box::pin(super::prompt::validate(&app, &workspace, input)).await?;
        }
        match Box::pin(recheck.verify()).await {
            Ok(_) => {}
            Err(e) if e.0 == Status::UNAUTHORIZED => {
                return Ok(PreparedRelay::Response(crate::auth::unauthorized_before_dispatch()));
            }
            Err(e) => return Err(e),
        }
    }
    if !app.native.current(&endpoint) || !crate::sessions::permission_mode::workspace_current(&app, &workspace) {
        return Err(if send_input { super::pre_dispatch_unavailable() } else { upstream_error() });
    }
    if let Some(session) = defer_media {
        return Box::pin(defer_media::stream_deferred_message_list(defer_media::DeferContext {
            app: &app,
            workspace: &workspace,
            endpoint: &endpoint,
            principal: &principal,
            id,
            route,
            session,
            native_directory,
            initial_identity: &initial_identity,
            input_checkout: &input_checkout,
            upstream,
        }))
        .await
        .map(PreparedRelay::Response);
    }
    let opened = opened.to_owned();
    let directory = directory.to_owned();
    let route = route.to_owned();
    let id = id.to_owned();
    let dispatch_session = session.map(str::to_owned);
    Ok(PreparedRelay::Dispatch(Box::new(dispatch::DispatchContext {
        app,
        workspace,
        endpoint,
        principal,
        upstream,
        method: method_str,
        route,
        opened,
        directory,
        id,
        send_input,
        session: dispatch_session,
        bound_directory,
        initial_identity,
        input_checkout,
        message_list,
        account_route,
        fork,
        actual,
        project,
        root_permissions,
        receipt,
        mutation,
        account_manual,
        account_verified_locs,
        rules_lock,
    })))
}

#[cfg(test)]
mod tests {
    use super::is_send_input_request;
    use axum::http::Method;

    #[test]
    fn send_input_request_matches_routed_variants_and_rejects_double_slash() {
        assert!(is_send_input_request(&Method::POST, "/workspaces/w/instance/api/session/ses_1/prompt"));
        assert!(is_send_input_request(&Method::POST, "/workspaces/w/instance/api/session/ses_1/prompt/"));
        assert!(is_send_input_request(&Method::POST, "/workspaces/w/instance/api/session/ses_1/prompt;v=1"));
        assert!(is_send_input_request(&Method::POST, "/workspaces/w/instance/api/session/ses_1/%70rompt"));
        assert!(is_send_input_request(&Method::POST, "/workspaces/w/instance/api/session/ses_1/command/"));
        assert!(!is_send_input_request(&Method::POST, "/workspaces/w/instance/api/session/ses_1/prompt//"));
        assert!(!is_send_input_request(&Method::POST, "/workspaces/w/instance/api/session/ses_1/command//"));
        assert!(!is_send_input_request(&Method::GET, "/workspaces/w/instance/api/session/ses_1/prompt"));
    }

    #[test]
    fn fence_admit_reports_session_move_distinct_from_worktree_deletion() {
        let session_key = crate::worktrees::fence::session("ses_admit_msg_test");
        let _block = crate::worktrees::fence::try_block(std::slice::from_ref(&session_key)).unwrap();
        let err = crate::worktrees::fence::admit(&["/repo/unused_admit_dir".into(), session_key])
            .err()
            .expect("session move block must refuse admit");
        assert_eq!(err.0, axum::http::StatusCode::CONFLICT);
        assert_eq!(err.1.0, serde_json::json!({ "error": "Session move is in progress" }));
    }
}
