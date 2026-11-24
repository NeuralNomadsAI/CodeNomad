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

fn is_json_content_type(headers: &axum::http::HeaderMap) -> bool {
    headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|ct| {
        let rest = ct.as_bytes();
        rest.len() >= 16
            && rest[..16].eq_ignore_ascii_case(b"application/json")
            && rest[16..].trim_ascii_start().first().is_none_or(|&b| b == b';')
    })
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
) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    tokio::task::spawn_blocking(move || crate::worktrees::ownership::resolve_media_path(&scope, &raw)).await.ok()?
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
    let endpoint = if message_list {
        let deadline = list_deadline.min(tokio::time::Instant::now() + Duration::from_secs(30));
        let endpoint = tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = workspace_closed() => return Err(not_found()),
            acquired = app.native.acquire(deadline) => acquired.map_err(|_| upstream_error())?,
        };
        tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
            _ = workspace_closed() => return Err(not_found()),
            _ = tokio::time::timeout_at(deadline, crate::extensions::lifecycle::prepare(&app, &endpoint)) => {}
        }
        endpoint
    } else {
        app.native.endpoint().ok_or_else(upstream_error)?
    };
    if dunce::canonicalize(opened).ok().as_ref() != Some(&workspace.path) {
        return Err(foreign());
    }
    let mut translated_directories = std::collections::BTreeMap::new();
    for directory in &mut prompt_directories {
        let translated = super::prompt::directory(&app, &workspace, directory).await?;
        translated_directories.insert(directory.clone(), translated.clone());
        *directory = translated;
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
    let resolve_media_path = |raw: &str| crate::worktrees::ownership::resolve_media_path(&app.scope, raw);
    let allow_subfolder = send_input || message_list;
    // TS checks every client-supplied directory and ambient context before session lookup or relay
    // (`http-server.ts:1248-1269`).
    let mut requested_checkout = None;
    let mut verified_media_dirs: Vec<(String, std::path::PathBuf)> = Vec::new();
    let admission_work = async {
        for req in &requested_dirs {
            if message_list {
                let Some((resolved, anchor)) = resolve_media_path_async(app.scope.clone(), req.clone()).await else {
                    return Err(foreign());
                };
                let _proof = crate::worktrees::ownership::media_directory(
                    &app, &workspace, &endpoint, &resolved, &anchor, false,
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
                let Some((resolved, anchor)) = resolve_media_path_async(app.scope.clone(), ctx_dir.to_owned()).await
                else {
                    return Err(foreign());
                };
                let _proof = crate::worktrees::ownership::media_directory(
                    &app, &workspace, &endpoint, &resolved, &anchor, false,
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
                static LIST_ADMISSION_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);
                let _admission_slot = LIST_ADMISSION_SLOTS.acquire().await.map_err(|_| upstream_error())?;
                super::session_record_list_at(&app, &endpoint, session).await?
            } else {
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
    let directory = requested.as_deref().or(native_directory).unwrap_or(opened);
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
            tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                _ = workspace_closed() => return Err(not_found()),
                res = tokio::time::timeout_at(
                    list_deadline,
                    tokio::task::spawn_blocking(move || {
                        let (resolved, anchor) = crate::worktrees::ownership::resolve_media_path(&scope, &raw)?;
                        let identity = crate::files::directory_identity(&anchor).ok()?;
                        Some((resolved, anchor, identity))
                    }),
                ) => res.map_err(|_| upstream_error())?.ok().flatten(),
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
                    crate::worktrees::ownership::media_directory(
                        &app,
                        &workspace,
                        &endpoint,
                        resolved,
                        anchor,
                        false,
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
    if !message_list
        && (head.headers.contains_key("x-opencode-directory") || head.headers.contains_key("x-opencode-workspace"))
    {
        return Err(foreign());
    }
    if let Some(context) = parsed_location_context {
        if send_input {
            let context = super::prompt::directory(&app, &workspace, super::prompt::context(&context)?).await?;
            if prompt_directories.iter().any(|directory| directory != &context)
                || target.query_pairs().any(|(key, value)| {
                    matches!(key.as_ref(), "directory" | "location[directory]") && value != context.as_str()
                })
            {
                return Err(error(Status::BAD_REQUEST, "Conflicting location context"));
            }
        } else if message_list {
            // Shape, ownership and query conflicts were already verified before session lookup.
        } else {
            one_location(&context, directory)?;
        }
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
                if !message_list && (seen_directory || value != directory) {
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
    let mut mutation = if !matches!(head.method, Method::GET | Method::HEAD) {
        use crate::worktrees::fence;
        let physical = crate::files::paths::canonical(&app.scope, directory).ok_or_else(foreign)?;
        let mut checkouts = vec![fence::identity(&physical)];
        // Prompt contexts have already been resolved, including prospective subfolders.
        checkouts.extend(prompt_directories.iter().map(|p| fence::identity(std::path::Path::new(p))));
        checkouts.extend(session.map(fence::session));
        Some(fence::admit(&checkouts)?)
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
        if prompt_directories
            .iter()
            .any(|p| crate::worktrees::ownership::resolve_directory(p).as_deref() != Some(std::path::Path::new(p)))
        {
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
        crate::sessions::permission_mode::refresh_before_send(&app, &endpoint, &fresh, || {
            principal.live().is_ok() && app.native.current(&endpoint) && input_location_live()
        })
        .await?;
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
    if let Some(accept) = head.headers.get(header::ACCEPT) {
        upstream = upstream.header(header::ACCEPT, accept);
    }
    if message_list {
        for conditional in [header::IF_NONE_MATCH, header::IF_MODIFIED_SINCE] {
            if let Some(value) = head.headers.get(&conditional) {
                upstream = upstream.header(conditional, value);
            }
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
        // One active projection builder at a time guarantees deadlock-free incremental
        // reservation against the shared 256 MiB `ResponsePool::List` budget while already-built
        // responses stream out concurrently and release permits on completion.
        static DEFER_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
        let interrupted = || error(Status::BAD_GATEWAY, "OpenCode response was interrupted");
        // Acquire the projection slot right before upstream dispatch so admission checks
        // and `session.get` never occupy slots while waiting or after principal revocation.
        let (slot, waited_for_slot) = match DEFER_SLOTS.try_acquire() {
            Ok(permit) => (permit, false),
            Err(_) => {
                let permit = tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                    _ = workspace_closed() => return Err(not_found()),
                    permit = tokio::time::timeout_at(list_deadline, DEFER_SLOTS.acquire()) => {
                        permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                    }
                };
                (permit, true)
            }
        };
        if waited_for_slot {
            // Re-verify session placement before dispatching upstream if this request waited
            // behind other projections, so a moved session's transcript is never fetched.
            let latest = tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                _ = workspace_closed() => return Err(not_found()),
                record = tokio::time::timeout_at(list_deadline, super::session_record_list_at(&app, &endpoint, session)) => {
                    record.map_err(|_| interrupted())??
                }
            };
            if actual.as_ref().is_none_or(|orig| latest["id"] != orig["id"] || latest["location"] != orig["location"]) {
                return Err(foreign());
            }
        }
        let mut response = tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
            _ = workspace_closed() => return Err(not_found()),
            sent = tokio::time::timeout_at(list_deadline, upstream.send()) => match sent {
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
                    .filter_map(|name| response.headers().get(name).cloned().map(|value| (name, value)))
                    .collect();
            let mut stream = crate::sessions::media_stream::MessageListStream::new(id, session);
            let mut slot = Some(slot);
            let mut mem: Option<tokio::sync::OwnedSemaphorePermit> = None;
            let mut held_units: u32 = 0;
            loop {
                let chunk = tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                    _ = workspace_closed() => return Err(not_found()),
                    next = tokio::time::timeout_at(list_deadline, response.chunk()) => {
                        next.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                    }
                };
                let Some(chunk) = chunk else {
                    break;
                };
                let pre_needed = crate::shared::response_memory_units(
                    crate::shared::ResponsePool::List,
                    stream.retained_bytes().saturating_add(chunk.len()),
                );
                if pre_needed > held_units {
                    let extra = tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                        _ = workspace_closed() => return Err(not_found()),
                        permit = tokio::time::timeout_at(
                            list_deadline,
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
                    let needed = crate::shared::response_memory_units(
                        crate::shared::ResponsePool::List,
                        stream.retained_bytes().saturating_add(pending.bytes.capacity()),
                    );
                    if needed > held_units {
                        let extra = tokio::select! {
                            biased;
                            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                            _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                            _ = workspace_closed() => return Err(not_found()),
                            permit = tokio::time::timeout_at(
                                list_deadline,
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
                    let raw = pending.bytes;
                    let delimiter = pending.delimiter;
                    let moved_stream = stream;
                    let (returned_stream, commit_res, returned) = tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                        _ = workspace_closed() => return Err(not_found()),
                        res = tokio::time::timeout_at(
                            list_deadline,
                            tokio::task::spawn_blocking(move || {
                                let mut s = moved_stream;
                                let (out, changed) = crate::sessions::media_stream::project_item(&ws, &ses, raw);
                                let commit_res = s.commit_item(out, changed, delimiter);
                                (s, commit_res, held)
                            }),
                        ) => res.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                    };
                    stream = returned_stream;
                    slot = Some(returned);
                    commit_res.map_err(|_| interrupted())?;
                }
                let needed =
                    crate::shared::response_memory_units(crate::shared::ResponsePool::List, stream.retained_bytes());
                if needed > held_units {
                    let extra = tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                        _ = workspace_closed() => return Err(not_found()),
                        permit = tokio::time::timeout_at(
                            list_deadline,
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
            }
            let (payload, payload_len, changed) = stream.finish().map_err(|_| interrupted())?;
            let final_units = crate::shared::response_memory_units(crate::shared::ResponsePool::List, payload_len);
            if final_units > held_units {
                let extra = tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                    _ = workspace_closed() => return Err(not_found()),
                    permit = tokio::time::timeout_at(
                        list_deadline,
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
            let mem = mem.ok_or_else(interrupted)?;
            drop(slot);
            if !app.native.current(&endpoint) {
                return Err(upstream_error());
            }
            app.workspace(id)?;
            // Re-verify the session still belongs to the same location before releasing any
            // buffered transcript bytes, closing TOCTOU moves during slot wait or page read.
            let latest = tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                _ = workspace_closed() => return Err(not_found()),
                record = tokio::time::timeout_at(list_deadline, super::session_record_list_at(&app, &endpoint, session)) => {
                    record.map_err(|_| interrupted())??
                }
            };
            if actual.as_ref().is_none_or(|orig| latest["id"] != orig["id"] || latest["location"] != orig["location"]) {
                return Err(foreign());
            }
            let live_ok = if let (Some((resolved, anchor, expected_id)), Some(checkout), Some(raw)) =
                (&initial_identity, &input_checkout, native_directory)
            {
                let (scope, raw, resolved, anchor, expected_id, checkout) = (
                    app.scope.clone(),
                    raw.to_owned(),
                    resolved.clone(),
                    anchor.clone(),
                    expected_id.clone(),
                    checkout.clone(),
                );
                tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                    _ = workspace_closed() => return Err(not_found()),
                    res = tokio::time::timeout_at(
                        list_deadline,
                        tokio::task::spawn_blocking(move || {
                            crate::worktrees::ownership::resolve_media_path(&scope, &raw).is_some_and(
                                |(cur_res, cur_anc)| {
                                    cur_res == resolved
                                        && cur_anc == anchor
                                        && crate::files::directory_identity(&cur_anc).ok() == Some(expected_id)
                                        && checkout.live(&cur_res)
                                },
                            )
                        }),
                    ) => res.map_err(|_| interrupted())?.unwrap_or(false),
                }
            } else {
                false
            };
            if !live_ok || !crate::sessions::permission_mode::workspace_current(&app, &workspace) {
                return Err(foreign());
            }
            if !app.native.current(&endpoint) {
                return Err(upstream_error());
            }
            principal.live()?;
            // Drop the upstream strong ETag only when the JSON body was actually rewritten
            // (RFC 9110: never reuse the original validator for a modified representation).
            let length = axum::http::HeaderValue::from(payload_len);
            let abort = crate::shared::stream_abort(
                app.clone(),
                id.to_owned(),
                workspace.clone(),
                endpoint.clone(),
                principal.0.clone(),
            );
            let write_abort = crate::shared::stream_abort(
                app.clone(),
                id.to_owned(),
                workspace.clone(),
                endpoint.clone(),
                principal.0.clone(),
            );
            let builder = headers
                .into_iter()
                .filter(|(name, _)| !(changed && *name == "etag"))
                .fold(Response::builder().status(status), |builder, (name, value)| builder.header(name, value))
                .header(header::VARY, "x-codenomad-media")
                .header(header::CONTENT_LENGTH, length);
            return builder
                .extension(NativeBody)
                .extension(crate::shared::CancelWrite::new(write_abort))
                .body(crate::shared::permit_body_chunks(payload, Some(mem), abort))
                .map_err(|_| upstream_error());
        }
        drop(slot);
        let status = response.status();
        if status.is_redirection() && status != Status::NOT_MODIFIED {
            return Err(upstream_error());
        }
        let unauthorized = status == Status::UNAUTHORIZED;
        if !status.is_success() && status != Status::NOT_MODIFIED && !is_json_content_type(response.headers()) {
            drop(response);
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
            // Re-verify session placement and physical checkout identity on non-JSON 2xx fallback
            // responses too, matching both deferred JSON and inline `message.list`.
            let latest = tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                _ = workspace_closed() => return Err(not_found()),
                record = tokio::time::timeout_at(list_deadline, super::session_record_list_at(&app, &endpoint, session)) => {
                    record.map_err(|_| interrupted())??
                }
            };
            if actual.as_ref().is_none_or(|orig| latest["id"] != orig["id"] || latest["location"] != orig["location"]) {
                return Err(foreign());
            }
            let live_ok = if let (Some((resolved, anchor, expected_id)), Some(checkout), Some(raw)) =
                (&initial_identity, &input_checkout, native_directory)
            {
                let (scope, raw, resolved, anchor, expected_id, checkout) = (
                    app.scope.clone(),
                    raw.to_owned(),
                    resolved.clone(),
                    anchor.clone(),
                    expected_id.clone(),
                    checkout.clone(),
                );
                tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                    _ = workspace_closed() => return Err(not_found()),
                    res = tokio::time::timeout_at(
                        list_deadline,
                        tokio::task::spawn_blocking(move || {
                            crate::worktrees::ownership::resolve_media_path(&scope, &raw).is_some_and(
                                |(cur_res, cur_anc)| {
                                    cur_res == resolved
                                        && cur_anc == anchor
                                        && crate::files::directory_identity(&cur_anc).ok() == Some(expected_id)
                                        && checkout.live(&cur_res)
                                },
                            )
                        }),
                    ) => res.map_err(|_| interrupted())?.unwrap_or(false),
                }
            } else {
                false
            };
            if !live_ok || !crate::sessions::permission_mode::workspace_current(&app, &workspace) {
                return Err(foreign());
            }
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
        let ws_key = id.to_owned();
        let ws_snapshot = workspace.clone();
        let ws_app = app.clone();
        let ws_closed = Box::pin(async move {
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
        // Matches TS `proxy.ts:33-35`: invalidate a 401 connection only after the native
        // 401 error body finishes streaming downstream, so retiring it does not truncate the body.
        let invalidate = unauthorized.then(|| InvalidateOnDrop { app: app.clone(), endpoint: endpoint.clone() });
        let bytes = futures_util::stream::unfold(
            (
                response.bytes_stream(),
                cancelled,
                ws_closed,
                app_retire,
                endpoint_retire,
                unauthorized,
                invalidate,
                false,
            ),
            |(mut inner, mut cancelled, mut ws_closed, app_retire, endpoint_retire, unauthorized, invalidate, done)| async move {
                if done {
                    return None;
                }
                let next = tokio::select! {
                    biased;
                    _ = &mut cancelled => {
                        return Some((
                            Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "upstream stream aborted")),
                            (inner, cancelled, ws_closed, app_retire, endpoint_retire, unauthorized, invalidate, true),
                        ));
                    }
                    _ = &mut ws_closed => {
                        return Some((
                            Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "workspace closed")),
                            (inner, cancelled, ws_closed, app_retire, endpoint_retire, unauthorized, invalidate, true),
                        ));
                    }
                    _ = app_retire.native.wait_retired(&endpoint_retire), if !unauthorized => {
                        return Some((
                            Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "upstream stream aborted")),
                            (inner, cancelled, ws_closed, app_retire, endpoint_retire, unauthorized, invalidate, true),
                        ));
                    }
                    item = inner.next() => item,
                };
                next.map(|chunk| {
                    (
                        chunk.map_err(std::io::Error::other),
                        (inner, cancelled, ws_closed, app_retire, endpoint_retire, unauthorized, invalidate, false),
                    )
                })
            },
        );
        let cancel_write = if unauthorized {
            crate::shared::CancelWrite::token(principal.0.clone())
        } else {
            crate::shared::CancelWrite::new(crate::shared::stream_abort(
                app.clone(),
                id.to_owned(),
                workspace.clone(),
                endpoint.clone(),
                principal.0.clone(),
            ))
        };
        return builder
            .header(header::VARY, "x-codenomad-media")
            .extension(NativeBody)
            .extension(cancel_write)
            .body(Body::from_stream(bytes))
            .map_err(|_| upstream_error());
    }
    let (route, opened, directory, id) = (route.to_owned(), opened.to_owned(), directory.to_owned(), id.to_owned());
    let list_session = message_list.then_some(session).flatten().map(str::to_owned);
    let inline_live_check =
        message_list.then(|| (initial_identity.clone(), input_checkout.clone(), native_directory.map(str::to_owned)));
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
        // Undici's default headers deadline for the TypeScript runtime transport.
        // Do not cap the total lifetime of a streaming native response.
        let response = tokio::select! {
            _ = principal.0.cancelled(), if !dispatched_mutation => return Err(crate::auth::unauthorized()),
            _ = app.native.wait_retired(&endpoint), if !dispatched_mutation => return Err(upstream_error()),
            response = tokio::time::timeout(super::PROXY_IDLE, upstream.send()) => match response {
                Ok(Ok(response)) => response,
                Ok(Err(_)) => {
                    app.native.invalidate(&endpoint);
                    return Err(upstream_error());
                }
                Err(_) => return Err(upstream_error()),
            },
        };
        if message_list
            && !response.status().is_success()
            && response.status() != Status::NOT_MODIFIED
            && !is_json_content_type(response.headers())
        {
            let status = response.status();
            let unauthorized = status == Status::UNAUTHORIZED;
            drop(response);
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
        if let Some(list_session) = &list_session
            && response.status().is_success()
        {
            // Intentional server-rs security hardening (TS `http-server.ts:1670-1707` omits this
            // recheck; tracked in `solid-backlog.md`): re-verify both native session placement and
            // physical checkout identity before streaming inline `message.list` bytes so a session
            // moved out of the workspace or retargeted via symlink after admission cannot leak.
            let latest = tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                record = tokio::time::timeout_at(list_deadline, super::session_record_list_at(&app, &endpoint, list_session)) => {
                    record.map_err(|_| upstream_error())??
                }
            };
            if actual.as_ref().is_none_or(|orig| latest["id"] != orig["id"] || latest["location"] != orig["location"]) {
                return Err(foreign());
            }
            let live_ok =
                if let Some((Some((resolved, anchor, expected_id)), Some(checkout), Some(raw))) = &inline_live_check {
                    let (scope, raw, resolved, anchor, expected_id, checkout) = (
                        app.scope.clone(),
                        raw.clone(),
                        resolved.clone(),
                        anchor.clone(),
                        expected_id.clone(),
                        checkout.clone(),
                    );
                    tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(&endpoint) => return Err(upstream_error()),
                        res = tokio::time::timeout_at(
                            list_deadline,
                            tokio::task::spawn_blocking(move || {
                                crate::worktrees::ownership::resolve_media_path(&scope, &raw).is_some_and(
                                    |(cur_res, cur_anc)| {
                                        cur_res == resolved
                                            && cur_anc == anchor
                                            && crate::files::directory_identity(&cur_anc).ok() == Some(expected_id)
                                            && checkout.live(&cur_res)
                                    },
                                )
                            }),
                        ) => res.map_err(|_| upstream_error())?.unwrap_or(false),
                    }
                } else {
                    false
                };
            if !live_ok || !crate::sessions::permission_mode::workspace_current(&app, &workspace) {
                return Err(foreign());
            }
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
        let builder = if message_list { builder.header(header::VARY, "x-codenomad-media") } else { builder };
        let builder = if dispatched_mutation {
            builder
        } else if unauthorized {
            builder.extension(crate::shared::CancelWrite::token(principal.0.clone()))
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
            if dispatched_mutation {
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
        ("application/json foo", false),
        ("application/json-patch+json", false),
        ("application/jsonp", false),
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
