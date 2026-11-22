//! `/workspaces/:id/instance/*`: the allowlisted relay to the daemon, confined to the workspace's
//! locations and sessions.
use std::{sync::LazyLock, time::Duration};

use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use percent_encoding::percent_decode_str;
use regex::Regex;
use serde_json::{Value, json};

use super::{
    NativeBody, SESSION_LOCATED_ELSEWHERE, SESSION_PLACEMENT_HEADER, controls, native_rpc_absent, read_json,
    session_directory, session_record, upstream_error,
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
            && ["/prompt", "/agent", "/model", "/fork"].iter().any(|suffix| route.ends_with(suffix)))
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
fn schedule_input(data: &serde_json::Map<String, Value>) -> bool {
    data.get("metadata").and_then(Value::as_object).is_some_and(|metadata| {
        ["schedule", "automation", "codenomad.schedule-carrier"].iter().any(|key| metadata.contains_key(*key))
    })
}
pub async fn verify_mutation(app: &App, id: &str, directory: &str, record: &Value) -> Result<(), Error> {
    if id.starts_with("ses_cn_schedule_") || marker(record) {
        return Err(carrier_denied());
    }
    let uncertain = || error(Status::SERVICE_UNAVAILABLE, "Mission schedule carrier ownership could not be verified");
    let response = app
        .native
        .rpc("codenomad.missions/scheduleCarrierRead", directory, &json!({"sessionID": id}))
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
    let fresh = session_record(app, id).await?;
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
    let principal = head.extensions.get::<crate::auth::Principal>().ok_or_else(crate::auth::unauthorized)?;
    let invalid = || error(Status::BAD_REQUEST, "Invalid workspace instance path");
    let tail = head.uri.path().strip_prefix("/workspaces/").ok_or_else(invalid)?;
    let (id, suffix) = tail.split_once('/').ok_or_else(invalid)?;
    let suffix = suffix.strip_prefix("instance").ok_or_else(invalid)?;
    let workspace = app.workspace(id)?;
    let route = safe_route(suffix).ok_or_else(invalid)?;
    let route = route.trim_end_matches('/');
    let control = controls::classify(route, &head.method);
    if !ALLOWED.iter().any(|(m, pat)| *m == head.method.as_str() && pat.is_match(route)) {
        return Err(error(Status::FORBIDDEN, "OpenCode route is not available through a workspace"));
    }
    if control.is_none() && !guarded(route, &head.method) {
        return Ok(unavailable());
    }
    // Native writes that can create or move execution state share the
    // backend's worktree mutation fence with Git, files and removal.
    let mut mutation = if head.method != Method::GET {
        let held = app.project_mutation.clone().lock_owned().await;
        principal.live()?;
        Some(held)
    } else {
        None
    };

    let opened = workspace.location["directory"].as_str().ok_or_else(upstream_error)?;
    let endpoint = app.native.endpoint().ok_or_else(upstream_error)?;
    if dunce::canonicalize(opened).ok().as_ref() != Some(&workspace.path) {
        return Err(foreign());
    }
    let mut target = endpoint.url.clone();
    target.set_query(head.uri.query());
    let requested = target
        .query_pairs()
        .find(|(k, _)| matches!(k.as_ref(), "directory" | "location[directory]"))
        .map(|(_, v)| v.into_owned());
    let session_path = route.strip_prefix("/api/session/").or_else(|| route.strip_prefix("/api/experimental/session/"));
    let session = session_path.and_then(|path| path.split('/').next()).filter(|v| !matches!(*v, "active" | "global"));
    let actual = if let Some(session) = session {
        Some(super::session_record_at(&app, &endpoint, session).await?)
    } else {
        None
    };
    // TS checks the session's own location first and names a proven
    // departure, so the UI can drop a conversation moved out of the project.
    let list_slug = match &actual {
        Some(record) => match crate::worktrees::placement(&app, &workspace, &record["location"]).await {
            Ok(slug) => Some(slug),
            Err(elsewhere) => {
                let mut body = json!({"error":"Session does not belong to workspace"});
                if elsewhere {
                    body["reason"] = json!(SESSION_LOCATED_ELSEWHERE);
                }
                return Err((Status::FORBIDDEN, Json(body)));
            }
        },
        None => None,
    };
    let directory = requested
        .as_deref()
        .or_else(|| actual.as_ref().and_then(|r| r["location"]["directory"].as_str()))
        .unwrap_or(opened);
    if !crate::worktrees::owns(&app, &workspace, directory).await {
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
            .and_then(decode)
            .and_then(|s| serde_json::from_str(&s).ok())
            .ok_or_else(|| error(Status::BAD_REQUEST, "Invalid location context"))?;
        one_location(&context, directory)?;
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
                if seen_directory || value != directory {
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
        if record["location"]["directory"] != directory || record["location"].get("workspaceID").is_some() {
            return Err(error(Status::FORBIDDEN, "Session does not belong to workspace"));
        }
        if head.method != Method::GET {
            if !crate::worktrees::exact_root_supported(&app, &workspace).await? {
                return Ok(unavailable());
            }
            verify_mutation(&app, session, directory, record).await?;
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
        let contents =
            to_bytes(body, 1024 * 1024).await.map_err(|_| error(Status::PAYLOAD_TOO_LARGE, "Request too large"))?;
        let data: Value = if contents.is_empty() {
            json!({})
        } else {
            if !head.headers.get(header::CONTENT_TYPE).is_some_and(|v| v.as_bytes().starts_with(b"application/json")) {
                return Err(if control.is_some() {
                    controls::invalid("Invalid session control")
                } else {
                    error(Status::BAD_REQUEST, "Session request requires a JSON object")
                });
            }
            serde_json::from_slice(&contents).map_err(|_| error(Status::BAD_REQUEST, "Invalid JSON"))?
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
                return Err(error(Status::BAD_REQUEST, "Session request requires a JSON object"));
            };
            if data.contains_key("parentID") {
                return Err(error(Status::FORBIDDEN, "Parent session creation is not available through a workspace"));
            }
            if let Some(location) = data.get("location") {
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
            if data.keys().any(|key| !fields.contains(&key.as_str())) {
                return Ok(unavailable());
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
    let _rules_lock = if permissions_patch {
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
    if head.method == Method::POST && route.ends_with("/prompt") {
        let session = session.ok_or_else(upstream_error)?;
        let url = endpoint.url.join(&format!("/api/session/{session}/environment")).map_err(|_| upstream_error())?;
        // Backend secrets and private daemon state never reach a session's environment.
        const PRIVATE: &str = "OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD CODENOMAD_SERVER_PASSWORD \
            CODENOMAD_AUTOMATION_BRIDGE_TOKEN CODENOMAD_BOOTSTRAP_TOKEN OPENCODE_DB XDG_STATE_HOME OPENCODE_CONFIG_CONTENT";
        let shared = |key: &String| {
            let name = key.to_ascii_uppercase();
            !name.starts_with("CNRS_") && !PRIVATE.split(' ').any(|p| p == name)
        };
        let variables: std::collections::BTreeMap<_, _> = std::env::vars().filter(|(key, _)| shared(key)).collect();
        app.workspace(id)?;
        principal.live()?;
        let response = app
            .native
            .client
            .request(Method::PUT, url)
            .basic_auth("opencode", Some(&endpoint.password))
            .json(&json!({"variables":variables}))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| upstream_error())?;
        if !response.status().is_success() {
            return Err(error(Status::BAD_GATEWAY, "Failed to apply session environment"));
        }
        let fresh = super::session_record_at(&app, &endpoint, session).await?;
        if fresh["location"]["directory"] != directory
            || fresh["location"].get("workspaceID").is_some()
            || marker(&fresh)
        {
            return Err(carrier_denied());
        }
        // `syncSessionMemoryContext`: advisory, bounded to its own 2 s budget.
        crate::memory::sync(&app, session).await;
        principal.live()?;
        let identity = crate::files::host_identity(std::path::Path::new(directory)).map_err(|_| foreign())?;
        crate::sessions::permission_mode::refresh_before_send(&app, &endpoint, &fresh, || {
            principal.live().is_ok()
                && crate::sessions::permission_mode::workspace_current(&app, &workspace)
                && crate::files::host_identity(std::path::Path::new(directory)).as_ref().ok() == Some(&identity)
        })
        .await?;
    }
    if !explicit && !create && session.is_none() && !matches!(route, "/api/project" | "/api/session/active") {
        target.query_pairs_mut().append_pair(if session_list { "directory" } else { "location[directory]" }, directory);
    }

    if !app.inner.lock().unwrap().workspaces.iter().any(|w| w.id == workspace.id) {
        return Err(not_found());
    }
    if !app.native.endpoint().is_some_and(|current| std::sync::Arc::ptr_eq(&current, &endpoint)) {
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
            principal,
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
    if control.is_some() {
        let fresh = super::session_record_at(&app, &endpoint, session.ok_or_else(upstream_error)?)
            .await
            .map_err(|e| if e.0 == Status::NOT_FOUND { foreign() } else { e })?;
        if actual.as_ref().is_none_or(|prior| {
            ["id", "location", "projectID", "parentID", "fork"].iter().any(|key| prior[*key] != fresh[*key])
                || prior["time"]["created"] != fresh["time"]["created"]
        }) {
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
    if let Some(input) = input {
        upstream = upstream.json(&input);
    }
    principal.live()?;
    let response = upstream.send().await.map_err(|_| upstream_error())?;
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
            directory,
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
        app.workspace(id)?;
        principal.live()?;
        return builder.extension(NativeBody).body(Body::from(native.to_string())).map_err(|_| upstream_error());
    }
    if response.status().is_success() && matches!(route, "/api/project" | "/api/session/active") {
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
            if session_directory(&app, &id).await.as_deref().ok() != Some(directory) {
                active.remove(&id);
            }
        }
        return Ok(Json(native).into_response());
    }
    let builder = relayed(&response);
    use futures_util::StreamExt;
    let bytes = response.bytes_stream().take_until(principal.0.clone().cancelled_owned());
    builder.extension(NativeBody).body(Body::from_stream(bytes)).map_err(|_| upstream_error())
}

#[test]
fn ordinary_input_refuses_reserved_metadata_even_with_null_values() {
    for key in ["schedule", "automation", "codenomad.schedule-carrier"] {
        let input = json!({"metadata":{(key):null}});
        assert!(schedule_input(input.as_object().unwrap()));
    }
    assert!(!schedule_input(json!({"metadata":{"other":"automation"}}).as_object().unwrap()));
}
