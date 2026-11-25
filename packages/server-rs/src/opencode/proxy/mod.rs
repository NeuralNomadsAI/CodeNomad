//! /workspaces/:id/instance/*: the allowlisted relay to the daemon, confined to the workspace's
//! locations and sessions.
mod defer_media;
mod dispatch;
mod guards;
mod mutation;

pub use guards::verify_mutation;

use std::time::Duration;

use axum::{
    Json,
    extract::{Request, State},
    http::{Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use super::{SESSION_LOCATED_ELSEWHERE, SESSION_PLACEMENT_HEADER, controls, upstream_error};
use crate::{Error, Shared, error, not_found, unavailable};
use guards::{
    ALLOWED, carrier_denied, foreign, guarded, is_hop_by_hop_connection_token, parse_location_context,
    resolve_media_path_async, safe_route, schedule_input, verify_mutation_at,
};

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
    let recheck = mutation::InputRecheck {
        app: &app,
        workspace: &workspace,
        endpoint: &endpoint,
        principal: &principal,
        session,
        directory,
        native_directory,
        message_list,
        actual: &actual,
        initial_identity: &initial_identity,
        input_checkout: &input_checkout,
    };
    let mutation::PreparedMutation { fork, root_permissions, input, rules_lock, mutation, receipt } =
        match mutation::prepare_mutation(
            &app,
            &workspace,
            &endpoint,
            &principal,
            &head,
            route,
            directory,
            control,
            session,
            send_input,
            command,
            body_limit,
            declared,
            &mut pending_body,
            &mut prompt_input,
            &prompt_locations,
            &actual,
            trace_fence,
            explicit,
            session_list,
            &mut target,
            &recheck,
        )
        .await?
        {
            mutation::MutationOutcome::Ready(prepared) => prepared,
            mutation::MutationOutcome::Early(response) => return Ok(response),
        };
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
        recheck.verify().await?;
    }
    if !app.native.current(&endpoint) || !crate::sessions::permission_mode::workspace_current(&app, &workspace) {
        return Err(upstream_error());
    }
    if let Some(session) = defer_media {
        return defer_media::stream_deferred_message_list(defer_media::DeferContext {
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
        })
        .await;
    }
    let opened = opened.to_owned();
    let directory = directory.to_owned();
    let route = route.to_owned();
    let id = id.to_owned();
    dispatch::dispatch_upstream(dispatch::DispatchContext {
        app,
        workspace,
        endpoint,
        principal,
        upstream,
        route,
        opened,
        directory,
        id,
        message_list,
        fork,
        actual,
        project,
        root_permissions,
        receipt,
        mutation,
        rules_lock,
    })
    .await
}
