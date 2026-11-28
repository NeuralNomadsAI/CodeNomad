//! Request body validation, permission-rule locking, worktree mutation fences, and pre-send sync.
use std::{path::PathBuf, sync::Arc, time::Duration};

use axum::{
    body::Body,
    http::{Method, StatusCode as Status},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use super::guards::{
    carrier_denied, directory_identity, foreign, is_account_mutation, is_account_no_store_route, is_json_content_type,
    is_mcp_toggle, is_workspace_location_mutation, marker, one_location, same_target, schedule_input,
};
use crate::missions::human_answer;
use crate::opencode::{Endpoint, controls, upstream_error};
use crate::{Error, Shared, Workspace, error, not_found, unavailable};

pub(super) struct PreparedMutation {
    pub fork: bool,
    pub root_permissions: Option<Value>,
    pub input: Option<Value>,
    pub rules_lock: Option<tokio::sync::OwnedMutexGuard<()>>,
    pub mutation: Option<crate::worktrees::fence::Entered>,
    pub account_manual: Option<crate::provider_usage::selection::ManualGuard>,
    pub account_context_dir: Option<String>,
    pub account_verified_locs: Vec<VerifiedAccountLocation>,
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
    pub bound_directory: Option<&'a str>,
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
        let fresh_dir = fresh["location"]["directory"].as_str();
        let bound_ok = self.bound_directory.is_none_or(|bound| {
            fresh_dir.is_some_and(|native| {
                native == bound
                    || crate::files::paths::canonical(&self.app.scope, native)
                        .zip(crate::files::paths::canonical(&self.app.scope, bound))
                        .is_some_and(|(a, b)| a == b)
            })
        });
        if !self.actual.as_ref().is_some_and(|initial| same_target(initial, &fresh))
            || fresh_dir != Some(self.directory)
            || !bound_ok
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
    pub shell: bool,
    pub body_limit: usize,
    pub declared: Option<usize>,
    pub pending_body: &'a mut Option<Body>,
    pub prompt_input: &'a mut Option<Value>,
    pub prompt_locations:
        &'a [(String, crate::opencode::prompt::Location, (Arc<std::sync::atomic::AtomicBool>, tokio::time::Instant))],
    pub extra_mutation_dirs: &'a [(String, PathBuf, String, crate::worktrees::ownership::DirectoryProof)],
    pub trace_fence: bool,
    pub explicit: bool,
    pub requested_dirs: &'a [String],
    pub location_context_dir: Option<&'a str>,
    pub session_list: bool,
    pub target: &'a mut reqwest::Url,
}

async fn wait_workspace_closed(app: &Shared, workspace: &Workspace) {
    loop {
        let notified = app.workspace_closed.notified();
        if !app.inner.lock().unwrap().workspaces.iter().any(|w| w.id == workspace.id && w.path == workspace.path) {
            return;
        }
        notified.await;
    }
}

pub(super) async fn prepare_mutation(ctx: MutationContext<'_>) -> Result<MutationOutcome, Error> {
    let MutationContext {
        recheck,
        head,
        route,
        control,
        send_input,
        command,
        shell,
        body_limit,
        declared,
        pending_body,
        prompt_input,
        prompt_locations,
        extra_mutation_dirs,
        trace_fence,
        explicit,
        requested_dirs,
        location_context_dir,
        session_list,
        target,
    } = ctx;
    let InputRecheck { app, workspace, endpoint, principal, session, directory, actual, .. } = *recheck;
    let create = route == "/api/session" && head.method == Method::POST;
    let fork = session.is_some() && route.ends_with("/fork") && head.method == Method::POST;
    let revert_stage = session.is_some() && route.ends_with("/revert/stage") && head.method == Method::POST;
    let background =
        route.starts_with("/api/session/") && route.ends_with("/background") && head.method == Method::POST;
    let account_mutation = is_account_mutation(route, &head.method);
    let location_mutation = is_workspace_location_mutation(route, &head.method);
    let scoped_mutation = account_mutation || location_mutation;
    let inbox_patch = session.is_some()
        && head.method == Method::PATCH
        && route.strip_prefix("/api/session/").and_then(|r| r.split_once("/inbox/")).is_some_and(|(sid, item)| {
            !sid.is_empty() && !sid.contains('/') && !item.is_empty() && !item.contains('/')
        });
    let permissions_patch = session.is_some()
        && head.method == Method::PATCH
        && route.strip_prefix("/api/session/").is_some_and(|r| !r.contains('/'));
    let mut root_permissions = None;
    let mut input = None;
    let mut account_verified_locs: Vec<VerifiedAccountLocation> = Vec::new();
    let mut account_query_resolved: Option<String> = None;
    let mut account_body_resolved: Option<String> = None;
    let mut account_context_dir: Option<String> = None;
    let mut has_body_location = false;
    if control.is_some() || matches!(head.method, Method::POST | Method::PUT | Method::PATCH | Method::DELETE) {
        let mut body_empty = false;
        let data: Value = if let Some(data) = prompt_input.take() {
            data
        } else {
            let contents = tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                _ = wait_workspace_closed(app, workspace) => return Err(not_found()),
                res = crate::opencode::proxy_body::read(
                    pending_body.take().ok_or_else(upstream_error)?,
                    body_limit,
                    declared,
                ) => res?,
            };
            if contents.is_empty() {
                body_empty = true;
                json!({})
            } else {
                if !is_json_content_type(&head.headers) {
                    return Err(if control.is_some() {
                        controls::invalid("Invalid session control")
                    } else if scoped_mutation {
                        error(Status::BAD_REQUEST, "Invalid request body")
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
        } else if scoped_mutation {
            let Value::Object(mut data) = data else {
                return Err(error(Status::BAD_REQUEST, "Invalid request body"));
            };
            if schedule_input(&data) {
                return Err(carrier_denied());
            }
            let is_credential = account_mutation && route.starts_with("/api/credential/");
            let opened = workspace.location["directory"].as_str().ok_or_else(upstream_error)?;
            let resolved =
                resolve_account_locations(app, workspace, &data, opened, requested_dirs, location_context_dir).await?;
            if account_mutation {
                validate_account_body(route, &head.method, &data, body_empty)?;
            } else {
                validate_workspace_location_body(route, &head.method, &data, body_empty)?;
            }
            if !is_credential {
                account_query_resolved = resolved.queries.first().map(|loc| loc.owned.directory.clone());
                account_body_resolved = resolved.body.as_ref().map(|loc| loc.owned.directory.clone());
                if let Some(ctx_loc) = &resolved.context {
                    account_context_dir = Some(ctx_loc.owned.directory.clone());
                }
                has_body_location = resolved.body.is_some();
            }
            // Native OpenCode account, MCP toggle, and plugin package endpoints take
            // `location[directory]` or `x-opencode-directory` rather than a body `location`
            // (including `location: null`); global credential mutations consume it only for
            // workspace authority and deletion fencing.
            data.remove("location");
            account_verified_locs.extend(resolved.queries);
            for item in [resolved.context, resolved.body].into_iter().flatten() {
                account_verified_locs.push(item);
            }
            if account_verified_locs.is_empty() && !is_credential {
                account_verified_locs.push(capture_account_location(app, workspace, opened.to_owned()).await?);
            }
            let omit_empty_body = body_empty
                || (is_credential && head.method == Method::POST)
                || (is_mcp_toggle(route, &head.method) && data.is_empty());
            if head.method != Method::DELETE && !omit_empty_body {
                input = Some(Value::Object(data));
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
            } else if revert_stage {
                &["messageID", "partID"]
            } else if background || head.method == Method::DELETE {
                &[]
            } else if permissions_patch {
                &["permissions"]
            } else if inbox_patch {
                &["delivery"]
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
            if inbox_patch
                && let Some(delivery) = data.get("delivery")
                && !matches!(delivery.as_str(), Some("steer" | "queue"))
            {
                return Err(error(Status::BAD_REQUEST, "Invalid inbox delivery"));
            }
            if send_input && !shell {
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
            if head.method != Method::DELETE && !((background || inbox_patch) && body_empty) {
                input = Some(Value::Object(data));
            }
        }
    } else if is_account_no_store_route(route, &head.method) {
        let opened = workspace.location["directory"].as_str().ok_or_else(upstream_error)?;
        let empty = serde_json::Map::new();
        let resolved =
            resolve_account_locations(app, workspace, &empty, opened, requested_dirs, location_context_dir).await?;
        if let Some(q_loc) = resolved.queries.first() {
            account_query_resolved = Some(q_loc.owned.directory.clone());
        }
        if let Some(ctx_loc) = &resolved.context {
            account_context_dir = Some(ctx_loc.owned.directory.clone());
        }
        account_verified_locs.extend(resolved.queries);
        if let Some(ctx_loc) = resolved.context {
            account_verified_locs.push(ctx_loc);
        }
        if account_verified_locs.is_empty() {
            account_verified_locs.push(capture_account_location(app, workspace, opened.to_owned()).await?);
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
        for loc in &account_verified_locs {
            checkouts.push(fence::identity(&loc.owned.checkout));
        }
        for (_, physical, _, _) in extra_mutation_dirs {
            checkouts.push(fence::identity(&fence::checkout_root(&app.scope, physical)));
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
    let account_manual =
        if account_mutation { Some(app.provider_usage.accounts.manual_fence(endpoint).await) } else { None };
    for loc in &account_verified_locs {
        if !verify_account_location_live(app, workspace, loc).await {
            return Err(foreign());
        }
    }
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
        if !shell {
            // `syncSessionMemoryContext`: advisory, bounded to its own 2 s budget.
            crate::memory::sync(app, endpoint, session, || async { recheck.verify().await.is_ok() }).await;
            match crate::provider_usage::selection::before_send(app, endpoint, principal, session, |dir| async move {
                dir == directory && recheck.verify().await.is_ok()
            })
            .await
            {
                Ok(()) => {}
                Err(e) if e.0 == Status::UNAUTHORIZED => {
                    return Ok(MutationOutcome::Early(crate::auth::unauthorized_before_dispatch()));
                }
                Err(e) => return Err(e),
            }
        }
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
    if account_mutation && route.starts_with("/api/credential/") {
        let pairs: Vec<(String, String)> = target
            .query_pairs()
            .into_owned()
            .filter(|(k, _)| !matches!(k.as_str(), "directory" | "location[directory]"))
            .collect();
        if pairs.is_empty() {
            target.set_query(None);
        } else {
            target.query_pairs_mut().clear().extend_pairs(pairs);
        }
    } else if let Some(ref translated) = account_query_resolved {
        let mut emitted_location = false;
        let mut pairs: Vec<(String, String)> = Vec::new();
        for (k, v) in target.query_pairs().into_owned() {
            if matches!(k.as_str(), "directory" | "location[directory]") {
                if !emitted_location {
                    emitted_location = true;
                    pairs.push(("location[directory]".into(), translated.clone()));
                }
            } else {
                pairs.push((k, v));
            }
        }
        target.query_pairs_mut().clear().extend_pairs(pairs);
    }
    if scoped_mutation
        && !route.starts_with("/api/credential/")
        && !explicit
        && account_context_dir.is_none()
        && let Some(ref translated) = account_body_resolved
    {
        target.query_pairs_mut().append_pair("location[directory]", translated);
    } else if !explicit
        && !has_body_location
        && account_context_dir.is_none()
        && !create
        && session.is_none()
        && !matches!(route, "/api/project" | "/api/session/active")
        && !route.starts_with("/api/credential/")
    {
        target.query_pairs_mut().append_pair(if session_list { "directory" } else { "location[directory]" }, directory);
    }

    if !app.inner.lock().unwrap().workspaces.iter().any(|w| w.id == workspace.id) {
        return Err(not_found());
    }
    if !app.native.current(endpoint) {
        return Err(if send_input { crate::opencode::pre_dispatch_unavailable() } else { upstream_error() });
    }
    let permission_snapshot = if let Some(control) = control
        && let Some(session_id) = session
    {
        control.pending(app, endpoint, session_id).await?
    } else {
        None
    };
    if session.is_some()
        && let Some(form) = human_answer::form_reply(route, &head.method)
    {
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
        let verify_under_fence = async {
            let fresh = crate::opencode::session_record_at(app, endpoint, session)
                .await
                .map_err(|e| if e.0 == Status::NOT_FOUND { foreign() } else { e })?;
            if actual.as_ref().is_none_or(|record| !same_target(record, &fresh)) {
                return Err(foreign());
            }
            if marker(&fresh) {
                return Err(carrier_denied());
            }
            let fresh_dir = fresh["location"]["directory"].as_str().ok_or_else(foreign)?;
            if let (Some((_, physical, _)), Some(admitted)) = (recheck.initial_identity, recheck.input_checkout) {
                if !crate::worktrees::ownership::capture_directory(app, workspace, physical)
                    .await
                    .is_some_and(|current| admitted.same_checkout(&current))
                {
                    return Err(foreign());
                }
            } else if !crate::worktrees::owns(app, workspace, fresh_dir).await {
                return Err(foreign());
            }
            for (_raw, physical, _initial_id, proof) in extra_mutation_dirs {
                if !crate::worktrees::ownership::capture_directory(app, workspace, physical)
                    .await
                    .is_some_and(|current| proof.same_checkout(&current))
                {
                    return Err(foreign());
                }
            }
            // Final synchronous physical-identity and liveness checks after all `.await`s
            // so no alias or checkout can retarget while probing another location.
            if recheck.initial_identity.is_some() && recheck.input_checkout.is_some() && !recheck.location_live() {
                return Err(foreign());
            }
            for (raw, physical, initial_id, proof) in extra_mutation_dirs {
                let current_id = directory_identity(&app.scope, Some(raw.as_str()), false);
                if !current_id.as_ref().is_some_and(|(r, p, id)| r == physical && p == physical && id == initial_id)
                    || !proof.live(physical)
                {
                    return Err(foreign());
                }
            }
            Ok(())
        };
        tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
            _ = wait_workspace_closed(app, workspace) => return Err(not_found()),
            res = verify_under_fence => res?,
        }
        principal.live()?;
        if !crate::sessions::permission_mode::workspace_current(app, workspace) {
            return Err(foreign());
        }
        if !app.native.endpoint().is_some_and(|current| std::sync::Arc::ptr_eq(&current, endpoint)) {
            return Err(upstream_error());
        }
    }
    Ok(MutationOutcome::Ready(PreparedMutation {
        fork,
        root_permissions,
        input,
        rules_lock,
        mutation,
        account_manual,
        account_context_dir,
        account_verified_locs,
        receipt,
    }))
}

pub(super) struct VerifiedAccountLocation {
    raw: String,
    owned: crate::worktrees::ownership::Owned,
    checkout_handle: same_file::Handle,
    anchor: PathBuf,
    anchor_handle: same_file::Handle,
}

async fn capture_account_location(
    app: &Shared,
    workspace: &Workspace,
    raw: String,
) -> Result<VerifiedAccountLocation, Error> {
    let owned = crate::worktrees::ownership::resolve(app, workspace, &raw).await.ok_or_else(foreign)?;
    let dir_path = PathBuf::from(&owned.directory);
    let checkout_path = owned.checkout.clone();
    let (checkout_handle, anchor, anchor_handle) = tokio::task::spawn_blocking(move || {
        let checkout_handle = same_file::Handle::from_path(&checkout_path).ok()?;
        let anchor = crate::worktrees::ownership::existing_directory(&dir_path)?.to_path_buf();
        let anchor_handle = same_file::Handle::from_path(&anchor).ok()?;
        Some((checkout_handle, anchor, anchor_handle))
    })
    .await
    .ok()
    .flatten()
    .ok_or_else(foreign)?;
    Ok(VerifiedAccountLocation { raw, owned, checkout_handle, anchor, anchor_handle })
}

pub(super) async fn verify_account_location_live(
    app: &Shared,
    workspace: &Workspace,
    loc: &VerifiedAccountLocation,
) -> bool {
    if !crate::sessions::permission_mode::workspace_current(app, workspace) {
        return false;
    }
    let Some(latest) = crate::worktrees::ownership::resolve(app, workspace, &loc.raw).await else {
        return false;
    };
    if latest.directory != loc.owned.directory || latest.checkout != loc.owned.checkout {
        return false;
    }
    let dir_path = PathBuf::from(&latest.directory);
    let checkout_path = latest.checkout;
    let expected_anchor = loc.anchor.clone();
    let handles = tokio::task::spawn_blocking(move || {
        let checkout = same_file::Handle::from_path(&checkout_path).ok()?;
        let anchor_live = crate::worktrees::ownership::existing_directory(&dir_path) == Some(expected_anchor.as_path());
        if !anchor_live {
            return None;
        }
        let anchor = same_file::Handle::from_path(&expected_anchor).ok()?;
        Some((checkout, anchor))
    })
    .await
    .ok()
    .flatten();
    handles.is_some_and(|(checkout, anchor)| checkout == loc.checkout_handle && anchor == loc.anchor_handle)
}

struct AccountLocations {
    queries: Vec<VerifiedAccountLocation>,
    context: Option<VerifiedAccountLocation>,
    body: Option<VerifiedAccountLocation>,
}

async fn resolve_account_locations(
    app: &Shared,
    workspace: &Workspace,
    data: &serde_json::Map<String, Value>,
    opened: &str,
    requested_dirs: &[String],
    location_context_dir: Option<&str>,
) -> Result<AccountLocations, Error> {
    let invalid_loc = || error(Status::BAD_REQUEST, "Location does not belong to workspace");
    if data.contains_key("workspace") || data.contains_key("workspaceID") {
        return Err(invalid_loc());
    }
    let body_raw: Option<String> = if let Some(loc_val) = data.get("location")
        && !loc_val.is_null()
    {
        let loc = loc_val.as_object().ok_or_else(invalid_loc)?;
        if loc.contains_key("workspace") || loc.contains_key("workspaceID") || loc.keys().any(|k| k != "directory") {
            return Err(invalid_loc());
        }
        let dir = match loc.get("directory") {
            Some(v) => v
                .as_str()
                .filter(|s| !s.trim().is_empty() && !s.contains('\0') && s.encode_utf16().count() <= 4096)
                .ok_or_else(invalid_loc)?,
            None => opened,
        };
        Some(dir.to_owned())
    } else {
        None
    };

    let top_dir_raw: Option<String> = if let Some(dir_val) = data.get("directory") {
        let dir = if dir_val.is_null() {
            opened
        } else {
            dir_val
                .as_str()
                .filter(|s| !s.trim().is_empty() && !s.contains('\0') && s.encode_utf16().count() <= 4096)
                .ok_or_else(invalid_loc)?
        };
        Some(dir.to_owned())
    } else {
        None
    };

    let mut queries = Vec::with_capacity(requested_dirs.len());
    for raw in requested_dirs {
        queries.push(capture_account_location(app, workspace, raw.clone()).await?);
    }
    let context = match location_context_dir {
        Some(raw) => Some(capture_account_location(app, workspace, raw.to_owned()).await?),
        None => None,
    };
    let body = match body_raw {
        Some(raw) => Some(capture_account_location(app, workspace, raw).await?),
        None => None,
    };
    let top_dir = match top_dir_raw {
        Some(raw) => Some(capture_account_location(app, workspace, raw).await?),
        None => None,
    };

    let mut canonical: Option<&str> = None;
    for item in queries.iter().chain(context.iter()).chain(body.iter()).chain(top_dir.iter()) {
        if let Some(prev) = canonical
            && prev != item.owned.directory
        {
            return Err(error(Status::BAD_REQUEST, "Conflicting location context"));
        }
        canonical = Some(item.owned.directory.as_str());
    }
    Ok(AccountLocations { queries, context, body })
}

fn validate_account_body(
    route: &str,
    method: &Method,
    data: &serde_json::Map<String, Value>,
    body_empty: bool,
) -> Result<(), Error> {
    let invalid = || error(Status::BAD_REQUEST, "Invalid request body");
    let check_optional_label = |data: &serde_json::Map<String, Value>| -> Result<(), Error> {
        if let Some(v) = data.get("label")
            && !v.is_null()
            && !v.as_str().is_some_and(|s| s.encode_utf16().count() <= 512 && !s.contains('\0'))
        {
            return Err(invalid());
        }
        Ok(())
    };
    let check_optional_answer = |data: &serde_json::Map<String, Value>| -> Result<(), Error> {
        if let Some(v) = data.get("answer")
            && !v.is_null()
            && !v.is_object()
        {
            return Err(invalid());
        }
        Ok(())
    };
    if let Some(rest) = route.strip_prefix("/api/credential/") {
        return match *method {
            Method::PATCH => {
                if body_empty || data.keys().any(|k| !matches!(k.as_str(), "label" | "location")) {
                    return Err(invalid());
                }
                if !data
                    .get("label")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 256 && !s.contains('\0'))
                {
                    return Err(invalid());
                }
                Ok(())
            }
            Method::POST if rest.ends_with("/activate") => {
                if !body_empty && data.keys().any(|k| k != "location") {
                    return Err(invalid());
                }
                Ok(())
            }
            Method::DELETE => {
                if !body_empty && data.keys().any(|k| k != "location") {
                    return Err(invalid());
                }
                Ok(())
            }
            _ => Err(invalid()),
        };
    }
    let Some((_, tail)) = route.strip_prefix("/api/integration/").and_then(|r| r.split_once("/connect/")) else {
        return Err(invalid());
    };
    match (method, tail) {
        (m, "key") if *m == Method::POST => {
            if body_empty || data.keys().any(|k| !matches!(k.as_str(), "key" | "answer" | "label" | "location")) {
                return Err(invalid());
            }
            if !data
                .get("key")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 65_536 && !s.contains('\0'))
            {
                return Err(invalid());
            }
            check_optional_answer(data)?;
            check_optional_label(data)?;
            Ok(())
        }
        (m, "oauth" | "external") if *m == Method::POST => {
            if body_empty || data.keys().any(|k| !matches!(k.as_str(), "methodID" | "answer" | "label" | "location")) {
                return Err(invalid());
            }
            if !data
                .get("methodID")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 256 && !s.contains('\0'))
            {
                return Err(invalid());
            }
            check_optional_answer(data)?;
            check_optional_label(data)?;
            Ok(())
        }
        (m, "command") if *m == Method::POST => {
            if body_empty || data.keys().any(|k| !matches!(k.as_str(), "methodID" | "label" | "location")) {
                return Err(invalid());
            }
            if !data
                .get("methodID")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 256 && !s.contains('\0'))
            {
                return Err(invalid());
            }
            check_optional_label(data)?;
            Ok(())
        }
        (m, t) if *m == Method::POST && t.starts_with("oauth/") && t.ends_with("/complete") => {
            if body_empty || data.keys().any(|k| !matches!(k.as_str(), "code" | "location")) {
                return Err(invalid());
            }
            if !data
                .get("code")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 16_384 && !s.contains('\0'))
            {
                return Err(invalid());
            }
            Ok(())
        }
        (m, t) if *m == Method::DELETE && (t.starts_with("oauth/") || t.starts_with("command/")) => {
            if !body_empty && data.keys().any(|k| k != "location") {
                return Err(invalid());
            }
            Ok(())
        }
        _ => Err(invalid()),
    }
}

fn validate_workspace_location_body(
    route: &str,
    method: &Method,
    data: &serde_json::Map<String, Value>,
    body_empty: bool,
) -> Result<(), Error> {
    let invalid = || error(Status::BAD_REQUEST, "Invalid request body");
    let valid_spec = |v: &Value| {
        v.as_str().is_some_and(|s| {
            !s.trim().is_empty()
                && s.encode_utf16().count() <= 512
                && !s.contains('\0')
                && !s.chars().any(|c| c.is_ascii_control())
        })
    };
    if is_mcp_toggle(route, method) {
        if !body_empty && data.keys().any(|k| k != "location") {
            return Err(invalid());
        }
        return Ok(());
    }
    if *method == Method::POST && route == "/api/plugin/check" {
        if !body_empty && data.keys().any(|k| !matches!(k.as_str(), "target" | "location")) {
            return Err(invalid());
        }
        if let Some(v) = data.get("target")
            && !v.is_null()
            && !valid_spec(v)
        {
            return Err(invalid());
        }
        return Ok(());
    }
    if *method == Method::POST && route == "/api/plugin/update" {
        if !body_empty && data.keys().any(|k| !matches!(k.as_str(), "targets" | "location")) {
            return Err(invalid());
        }
        if let Some(v) = data.get("targets")
            && !v.is_null()
            && !v.as_array().is_some_and(|items| items.len() <= 128 && items.iter().all(valid_spec))
        {
            return Err(invalid());
        }
        return Ok(());
    }
    Err(invalid())
}
