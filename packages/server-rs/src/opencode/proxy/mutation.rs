//! Request body validation, permission-rule locking, worktree mutation fences, and pre-send sync.
use std::{path::PathBuf, sync::Arc, time::Duration};

use axum::{
    body::Body,
    http::{Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use super::guards::{carrier_denied, directory_identity, foreign, marker, one_location, same_target, schedule_input};
use crate::missions::human_answer;
use crate::opencode::{Endpoint, controls, upstream_error};
use crate::{Error, Shared, Workspace, error, not_found, unavailable};

pub(super) struct PreparedMutation {
    pub fork: bool,
    pub root_permissions: Option<Value>,
    pub input: Option<Value>,
    pub rules_lock: Option<tokio::sync::OwnedMutexGuard<()>>,
    pub mutation: Option<crate::worktrees::fence::Entered>,
    pub receipt: Option<crate::sessions::receipts::Prepared>,
}

pub(super) enum MutationOutcome {
    Ready(PreparedMutation),
    Early(Response),
}

pub(super) struct InputRecheck<'a> {
    pub app: &'a Shared,
    pub workspace: &'a Workspace,
    pub endpoint: &'a Arc<Endpoint>,
    pub principal: &'a crate::auth::Principal,
    pub session: Option<&'a str>,
    pub directory: &'a str,
    pub native_directory: Option<&'a str>,
    pub message_list: bool,
    pub actual: &'a Option<Value>,
    pub initial_identity: &'a Option<(PathBuf, PathBuf, String)>,
    pub input_checkout: &'a Option<crate::worktrees::ownership::DirectoryProof>,
}

impl InputRecheck<'_> {
    fn location_live(&self) -> bool {
        *self.initial_identity == directory_identity(&self.app.scope, self.native_directory, self.message_list)
            && self
                .initial_identity
                .as_ref()
                .zip(self.input_checkout.as_ref())
                .is_some_and(|((resolved, _, _), checkout)| checkout.live(resolved))
            && crate::sessions::permission_mode::workspace_current(self.app, self.workspace)
    }

    pub(super) async fn verify(&self) -> Result<Value, Error> {
        let (_, physical, _) = self.initial_identity.as_ref().ok_or_else(foreign)?;
        let admitted = self.input_checkout.as_ref().ok_or_else(foreign)?;
        if !crate::worktrees::ownership::capture_directory(self.app, self.workspace, physical)
            .await
            .is_some_and(|current| admitted.same_checkout(&current))
        {
            return Err(foreign());
        }
        let fresh = crate::opencode::session_record_at(
            self.app,
            self.endpoint,
            self.session.ok_or_else(crate::opencode::pre_dispatch_unavailable)?,
        )
        .await
        .map_err(|e| if e.0 == Status::BAD_GATEWAY { crate::opencode::pre_dispatch_unavailable() } else { e })?;
        if !self.actual.as_ref().is_some_and(|initial| same_target(initial, &fresh))
            || fresh["location"]["directory"] != self.directory
            || !self.location_live()
        {
            return Err(foreign());
        }
        if marker(&fresh) {
            return Err(carrier_denied());
        }
        self.principal.live()?;
        if !self.app.native.current(self.endpoint) {
            return Err(crate::opencode::pre_dispatch_unavailable());
        }
        Ok(fresh)
    }
}

pub(super) struct MutationContext<'a> {
    pub recheck: &'a InputRecheck<'a>,
    pub head: &'a axum::http::request::Parts,
    pub route: &'a str,
    pub control: Option<controls::Control<'a>>,
    pub send_input: bool,
    pub command: bool,
    pub body_limit: usize,
    pub declared: Option<usize>,
    pub pending_body: &'a mut Option<Body>,
    pub prompt_input: &'a mut Option<Value>,
    pub prompt_locations:
        &'a [(String, crate::opencode::prompt::Location, (Arc<std::sync::atomic::AtomicBool>, tokio::time::Instant))],
    pub trace_fence: bool,
    pub explicit: bool,
    pub session_list: bool,
    pub target: &'a mut reqwest::Url,
}

pub(super) async fn prepare_mutation(ctx: MutationContext<'_>) -> Result<MutationOutcome, Error> {
    let MutationContext {
        recheck,
        head,
        route,
        control,
        send_input,
        command,
        body_limit,
        declared,
        pending_body,
        prompt_input,
        prompt_locations,
        trace_fence,
        explicit,
        session_list,
        target,
    } = ctx;
    let InputRecheck { app, workspace, endpoint, principal, session, directory, actual, .. } = *recheck;
    let create = route == "/api/session" && head.method == Method::POST;
    let fork = session.is_some() && route.ends_with("/fork") && head.method == Method::POST;
    let permissions_patch = session.is_some() && head.method == Method::PATCH;
    let mut root_permissions = None;
    let mut input = None;
    if control.is_some() || matches!(head.method, Method::POST | Method::PUT | Method::PATCH) {
        let data: Value = if let Some(data) = prompt_input.take() {
            data
        } else {
            let contents = crate::opencode::proxy_body::read(
                pending_body.take().ok_or_else(upstream_error)?,
                body_limit,
                declared,
            )
            .await?;
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
                return Ok(MutationOutcome::Early(unavailable()));
            }
            if send_input {
                crate::opencode::prompt::validate(app, workspace, &data).await?;
            }
            if create {
                if !crate::worktrees::exact_root_supported(app, workspace).await? {
                    return Ok(MutationOutcome::Early(unavailable()));
                }
                data.insert("location".into(), json!({"directory": directory}));
                root_permissions = crate::sessions::permission_mode::new_root(app, endpoint, directory, true).await?;
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
        let fresh = crate::opencode::session_record_at(app, endpoint, id).await?;
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
        for (raw, initial, (initial_live, observed)) in prompt_locations {
            let key = fence::identity(&initial.checkout);
            if fence::is_blocked(&key) {
                return Err(error(Status::CONFLICT, "Worktree deletion is in progress"));
            }
            let recheck_live = fence::capture_display(&key);
            match crate::opencode::prompt::directory(app, workspace, raw).await {
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
                match crate::opencode::prompt::directory(app, workspace, raw).await {
                    Ok(current) if &current == initial => {}
                    _ => return Err(foreign()),
                }
            }
        }
        if create && !crate::worktrees::owns(app, workspace, directory).await {
            return Err(foreign());
        }
        Some(permit)
    } else {
        None
    };
    if send_input {
        let session = session.ok_or_else(crate::opencode::pre_dispatch_unavailable)?;
        let mut url = endpoint.url.clone();
        url.path_segments_mut().map_err(|_| crate::opencode::pre_dispatch_unavailable())?.clear().extend([
            "api",
            "session",
            session,
            "environment",
        ]);
        let unavailable = crate::opencode::session_environment::unavailable;
        let variables = crate::opencode::session_environment::snapshot(app.settings.location.config.clone()).await?;
        if command && let Some(Value::Object(input)) = &input {
            crate::opencode::prompt::validate(app, workspace, input).await?;
        }
        match recheck.verify().await {
            Ok(_) => {}
            Err(e) if e.0 == Status::UNAUTHORIZED => {
                return Ok(MutationOutcome::Early(crate::auth::unauthorized_before_dispatch()));
            }
            Err(e) => return Err(e),
        }
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
        crate::memory::sync(app, endpoint, session, || async { recheck.verify().await.is_ok() }).await;
        let fresh = match recheck.verify().await {
            Ok(fresh) => fresh,
            Err(e) if e.0 == Status::UNAUTHORIZED => {
                return Ok(MutationOutcome::Early(crate::auth::unauthorized_before_dispatch()));
            }
            Err(e) => return Err(e),
        };
        #[cfg(test)]
        crate::worktrees::fence_test_trace::record("permission rules", "waiting for send refresh");
        match crate::sessions::permission_mode::refresh_before_send(app, endpoint, &fresh, || {
            principal.live().is_ok() && app.native.current(endpoint) && recheck.location_live()
        })
        .await
        {
            Ok(()) => {}
            Err(_) if principal.0.is_cancelled() => {
                return Ok(MutationOutcome::Early(crate::auth::unauthorized_before_dispatch()));
            }
            Err(e) if e.0 == Status::BAD_GATEWAY => return Err(crate::opencode::pre_dispatch_unavailable()),
            Err(e) => return Err(e),
        }
        #[cfg(test)]
        crate::worktrees::fence_test_trace::record("permission rules", "send refresh finished");
    }
    if !explicit && !create && session.is_none() && !matches!(route, "/api/project" | "/api/session/active") {
        target.query_pairs_mut().append_pair(if session_list { "directory" } else { "location[directory]" }, directory);
    }

    if !app.inner.lock().unwrap().workspaces.iter().any(|w| w.id == workspace.id) {
        return Err(not_found());
    }
    if !app.native.current(endpoint) {
        return Err(if send_input { crate::opencode::pre_dispatch_unavailable() } else { upstream_error() });
    }
    let permission_snapshot = if let Some(control) = control {
        control.pending(app, endpoint, session.ok_or_else(upstream_error)?).await?
    } else {
        None
    };
    if let Some(form) = human_answer::form_reply(route, &head.method) {
        if human_answer::reply(
            app,
            workspace,
            endpoint,
            &head,
            &principal,
            actual.as_ref().ok_or_else(upstream_error)?,
            form,
            input.as_ref().ok_or_else(upstream_error)?,
            &mut mutation,
        )
        .await?
        {
            return Ok(MutationOutcome::Early(Status::NO_CONTENT.into_response()));
        }
        if !app.native.endpoint().is_some_and(|current| std::sync::Arc::ptr_eq(&current, endpoint)) {
            return Err(upstream_error());
        }
    }
    let receipt = if let Some(request) = permission_snapshot {
        Some(
            crate::sessions::receipts::prepare(app, endpoint, &request, input.as_ref().ok_or_else(upstream_error)?)
                .await?,
        )
    } else {
        None
    };
    if mutation.is_some()
        && !send_input
        && let Some(session) = session
    {
        let fresh = crate::opencode::session_record_at(app, endpoint, session)
            .await
            .map_err(|e| if e.0 == Status::NOT_FOUND { foreign() } else { e })?;
        if actual.as_ref().is_none_or(|record| !same_target(record, &fresh)) {
            return Err(foreign());
        }
        if !crate::sessions::permission_mode::workspace_current(app, workspace) {
            return Err(foreign());
        }
        if !app.native.endpoint().is_some_and(|current| std::sync::Arc::ptr_eq(&current, endpoint)) {
            return Err(upstream_error());
        }
    }
    Ok(MutationOutcome::Ready(PreparedMutation { fork, root_permissions, input, rules_lock, mutation, receipt }))
}
