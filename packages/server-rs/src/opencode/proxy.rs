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
    let endpoint = app
        .native
        .endpoint()
        .ok_or_else(|| if send_input { super::pre_dispatch_unavailable() } else { upstream_error() })?;
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
    let requested = target
        .query_pairs()
        .find(|(k, _)| matches!(k.as_ref(), "directory" | "location[directory]"))
        .map(|(_, v)| v.into_owned());
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
    let session_path = route.strip_prefix("/api/session/").or_else(|| route.strip_prefix("/api/experimental/session/"));
    let session = session_path.and_then(|path| path.split('/').next()).filter(|v| !matches!(*v, "active" | "global"));
    static TRACE_FENCE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let trace_fence =
        send_input && *TRACE_FENCE.get_or_init(|| std::env::var_os("CNRS_MUTATION_FENCE_TRACE").is_some());
    let actual = if let Some(session) = session {
        if trace_fence {
            eprintln!("mutation-fence prompt {session}: read native session before admission");
        }
        Some(super::session_record_at(&app, &endpoint, session).await.map_err(|e| {
            if send_input && e.0 == Status::BAD_GATEWAY { super::pre_dispatch_unavailable() } else { e }
        })?)
    } else {
        None
    };
    let native_directory = actual.as_ref().and_then(|r| r["location"]["directory"].as_str());
    if send_input && let Some(raw_bound) = head.headers.get("x-codenomad-session-directory") {
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
    }
    let directory =
        if send_input { native_directory.or(requested.as_deref()) } else { requested.as_deref().or(native_directory) }
            .unwrap_or(opened);
    let identity_now = || {
        let path = crate::files::paths::canonical(&app.scope, native_directory?)?;
        let identity = crate::files::host_identity(&path).ok()?;
        Some((path, identity))
    };
    let initial_identity = send_input.then(&identity_now).flatten();
    let input_checkout = match &initial_identity {
        Some((physical, _)) => {
            crate::worktrees::ownership::capture_directory_with_refresh(&app, &workspace, physical, true).await
        }
        None => None,
    };
    // TS checks the session's own location first and names a proven
    // departure, so the UI can drop a conversation moved out of the project.
    let list_slug = match &actual {
        Some(record) => match crate::worktrees::placement(&app, &workspace, &record["location"]).await {
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
        },
        None => None,
    };
    if (send_input && input_checkout.is_none())
        || (!send_input && !crate::worktrees::owns(&app, &workspace, directory).await)
    {
        return Err(foreign());
    }
    target.path_segments_mut().map_err(|_| invalid())?.clear().extend(route.trim_start_matches('/').split('/'));
    target.set_query(head.uri.query());
    if head.headers.contains_key("x-opencode-directory") || head.headers.contains_key("x-opencode-workspace") {
        return Err(foreign());
    }
    if let Some(value) = head.headers.get("x-codenomad-location") {
        let context = value
            .to_str()
            .ok()
            .and_then(|value| {
                if send_input {
                    if value.len() > 16_384 { None } else { crate::shared::decode_component(value) }
                } else {
                    decode(value)
                }
            })
            .and_then(|s| serde_json::from_str(&s).ok())
            .ok_or_else(|| error(Status::BAD_REQUEST, "Invalid location context"))?;
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
        } else {
            one_location(&context, directory)?;
        }
    }
    let session_list = route == "/api/session" && head.method == Method::GET;
    if target.query_pairs().any(|(key, _)| {
        matches!(key.as_ref(), "workspace" | "workspaceID" | "location[workspace]" | "location[workspaceID]")
    }) {
        return Err(foreign());
    }
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
                if seen_directory || (prompt_query.is_none() && value != directory) {
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
        if record["location"]["directory"] != directory || record["location"].get("workspaceID").is_some() {
            return Err(error(Status::FORBIDDEN, "Session does not belong to workspace"));
        }
        if head.method != Method::GET {
            if !crate::worktrees::exact_root_supported(&app, &workspace).await? {
                return Ok(unavailable());
            }
            verify_mutation_at(&app, &endpoint, session, directory, record).await.map_err(|e| {
                if send_input && e.0 == Status::BAD_GATEWAY { super::pre_dispatch_unavailable() } else { e }
            })?;
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
                .is_some_and(|((path, _), checkout)| checkout.live(path))
            && crate::sessions::permission_mode::workspace_current(&app, &workspace)
    };
    let recheck_input = || async {
        let (physical, _) = initial_identity.as_ref().ok_or_else(foreign)?;
        let admitted = input_checkout.as_ref().ok_or_else(foreign)?;
        if !crate::worktrees::ownership::capture_directory(&app, &workspace, physical)
            .await
            .is_some_and(|current| admitted.same_checkout(&current))
        {
            return Err(foreign());
        }
        let fresh = super::session_record_at(&app, &endpoint, session.ok_or_else(super::pre_dispatch_unavailable)?)
            .await
            .map_err(|e| if e.0 == Status::BAD_GATEWAY { super::pre_dispatch_unavailable() } else { e })?;
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
            return Err(super::pre_dispatch_unavailable());
        }
        Ok(fresh)
    };
    if send_input {
        let session = session.ok_or_else(super::pre_dispatch_unavailable)?;
        let url = endpoint
            .url
            .join(&format!("/api/session/{session}/environment"))
            .map_err(|_| super::pre_dispatch_unavailable())?;
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
        .await
        .map_err(|e| if e.0 == Status::BAD_GATEWAY { super::pre_dispatch_unavailable() } else { e })?;
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
        return Err(if send_input { super::pre_dispatch_unavailable() } else { upstream_error() });
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
        return Err(if send_input { super::pre_dispatch_unavailable() } else { upstream_error() });
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
            return Err(if send_input { super::pre_dispatch_unavailable() } else { upstream_error() });
        }
        // Undici's default headers deadline for the TypeScript runtime transport.
        // Do not cap the total lifetime of a streaming native response.
        let response = tokio::select! {
            _ = principal.0.cancelled(), if !dispatched_mutation => return Err(crate::auth::unauthorized()),
            response = tokio::time::timeout(super::PROXY_IDLE, upstream.send()) =>
                response.map_err(|_| upstream_error())?.map_err(|_| upstream_error())?,
        };
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
        let builder = relayed(&response);
        use futures_util::StreamExt;
        let bytes = response.bytes_stream().take_until(async move {
            if dispatched_mutation {
                std::future::pending::<()>().await;
            }
            principal.0.cancelled().await;
        });
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
