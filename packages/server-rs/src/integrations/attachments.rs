//! Native integration host discovery, host installation, binding reads and per-session
//! attach/detach (`opencode/integrations/attachments.ts`).

use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex, Weak},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::http::{Method, StatusCode as Status};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::{sync::Mutex as AsyncMutex, time::Instant};
use tokio_util::sync::CancellationToken;

use crate::{
    App, Workspace,
    opencode::{Endpoint, launch},
    opencode_settings::assert_current,
    plugin_controls::{
        catalog::{IntegrationCatalogEntry, valid_integration_id},
        engine,
        snapshot::{ControlLocation, RuntimeState},
    },
    subagent_depth::Fail,
};

use super::{
    LocationPin,
    contract::{
        BindingReadOutput, INTEGRATION_ATTACHMENT_METADATA_KEY, IntegrationHostsOutput, OutcomeOutput, looks_like_path,
        parse_attach_host_output, parse_binding_read_output, parse_detach_host_output, parse_hosts_output,
        parse_install_host_output, parse_status_output, valid_native_session_id, valid_offer_id,
    },
    is_json_content_type, owns_location,
    recognition::recognize_integrations,
};

pub(crate) const INTEGRATION_ATTACHMENT_TIMEOUT: Duration = Duration::from_secs(8);
const HOST_DETECTION_TIMEOUT: Duration = Duration::from_secs(1);
const RPC_OUTPUT_MAX_BYTES: usize = 256 * 1024;
const SESSION_RECORD_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Per-session serialization queue for `attach` and `detach` (`IntegrationAttachments.sessions`).
///
/// Storing `Weak` handles ensures idle session keys are reclaimed automatically, and dropping an
/// operation future on timeout immediately drops its `OwnedMutexGuard` so the next action proceeds.
#[derive(Default)]
pub(crate) struct SessionQueue {
    sessions: StdMutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

impl SessionQueue {
    fn lock_for(&self, session_id: &str) -> Arc<AsyncMutex<()>> {
        let mut map = self.sessions.lock().unwrap();
        if map.len() > 256 {
            map.retain(|_, weak| weak.strong_count() > 0);
        }
        if let Some(existing) = map.get(session_id).and_then(Weak::upgrade) {
            return existing;
        }
        let fresh = Arc::new(AsyncMutex::new(()));
        map.insert(session_id.to_owned(), Arc::downgrade(&fresh));
        fresh
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AttachmentError {
    Unauthorized,
    Invalid,
    NotFound,
    Forbidden,
    Inactive,
    Unsupported,
    NonConforming,
    Unavailable,
}

impl AttachmentError {
    pub(crate) const fn status(self) -> Status {
        match self {
            Self::Unauthorized => Status::UNAUTHORIZED,
            Self::Invalid => Status::BAD_REQUEST,
            Self::NotFound => Status::NOT_FOUND,
            Self::Forbidden => Status::FORBIDDEN,
            Self::Inactive | Self::Unsupported => Status::CONFLICT,
            Self::NonConforming => Status::BAD_GATEWAY,
            Self::Unavailable => Status::SERVICE_UNAVAILABLE,
        }
    }

    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Invalid => "invalid",
            Self::NotFound => "not-found",
            Self::Forbidden => "forbidden",
            Self::Inactive => "inactive",
            Self::Unsupported => "unsupported",
            Self::NonConforming => "non-conforming",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub(crate) enum BindingResponse {
    Attached { label: String },
    None,
    Unknown,
}

#[derive(Serialize)]
pub(crate) struct InstallHostResponse {
    pub(crate) outcome: String,
}

#[derive(Clone)]
pub(crate) struct HostPolicy {
    pub(crate) is_linux: bool,
    pub(crate) wsl_env_set: bool,
    pub(crate) kernel_version: Option<Result<String, ()>>,
}

impl HostPolicy {
    pub(crate) fn current() -> Self {
        Self {
            is_linux: cfg!(target_os = "linux"),
            wsl_env_set: std::env::var_os("WSL_DISTRO_NAME").is_some(),
            kernel_version: None,
        }
    }

    async fn check_wsl(&self) -> Result<(), AttachmentError> {
        if !self.is_linux {
            return Ok(());
        }
        if self.wsl_env_set {
            return Err(AttachmentError::Unsupported);
        }
        let version = match &self.kernel_version {
            Some(Ok(v)) => v.clone(),
            Some(Err(())) => return Err(AttachmentError::Unavailable),
            None => tokio::time::timeout(HOST_DETECTION_TIMEOUT, tokio::fs::read_to_string("/proc/version"))
                .await
                .map_err(|_| AttachmentError::Unavailable)?
                .map_err(|_| AttachmentError::Unavailable)?,
        };
        if version.to_ascii_lowercase().contains("microsoft") {
            return Err(AttachmentError::Unsupported);
        }
        Ok(())
    }
}

struct Context<'a> {
    app: &'a App,
    workspace: Workspace,
    location: ControlLocation,
    pin: LocationPin,
    entry: IntegrationCatalogEntry,
    endpoint: Arc<Endpoint>,
    principal: Option<CancellationToken>,
    deadline: Instant,
}

impl Context<'_> {
    fn remaining(&self) -> Result<Duration, AttachmentError> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() { Err(AttachmentError::Unavailable) } else { Ok(left) }
    }
}

pub(crate) async fn install_host(
    app: &App,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    principal: Option<CancellationToken>,
) -> Result<InstallHostResponse, AttachmentError> {
    install_host_with(
        app,
        workspace_id,
        integration_id,
        directory,
        principal,
        INTEGRATION_ATTACHMENT_TIMEOUT,
        &HostPolicy::current(),
    )
    .await
}

pub(crate) async fn install_host_with(
    app: &App,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    principal: Option<CancellationToken>,
    timeout: Duration,
    host: &HostPolicy,
) -> Result<InstallHostResponse, AttachmentError> {
    // Refuse WSL before `catalog.read` (which may persist) or native RPCs.
    if app.workspace(workspace_id).ok().is_some_and(|w| launch::wsl(&w.binary_id.to_string_lossy())) {
        return Err(AttachmentError::Unsupported);
    }
    host.check_wsl().await?;
    run(app, workspace_id, integration_id, directory, principal, timeout, true, |ctx| async move {
        verify_status(&ctx, None).await?;
        let raw = rpc_call(&ctx, "installHost", &json!({ "target": "default" }), None).await?;
        let parsed = parse_install_host_output(&raw).ok_or(AttachmentError::NonConforming)?;
        if parsed.detail.as_deref().is_some_and(looks_like_path) {
            return Err(AttachmentError::NonConforming);
        }
        Ok(InstallHostResponse { outcome: parsed.outcome })
    })
    .await
}

pub(crate) async fn hosts(
    app: &App,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    principal: Option<CancellationToken>,
) -> Result<IntegrationHostsOutput, AttachmentError> {
    hosts_with_timeout(app, workspace_id, integration_id, directory, principal, INTEGRATION_ATTACHMENT_TIMEOUT).await
}

pub(crate) async fn hosts_with_timeout(
    app: &App,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    principal: Option<CancellationToken>,
    timeout: Duration,
) -> Result<IntegrationHostsOutput, AttachmentError> {
    run(app, workspace_id, integration_id, directory, principal, timeout, false, |ctx| async move {
        verify_status(&ctx, None).await?;
        fetch_hosts(&ctx, None).await
    })
    .await
}

pub(crate) async fn binding_read(
    app: &App,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    session_id: &str,
    principal: Option<CancellationToken>,
) -> Result<BindingResponse, AttachmentError> {
    binding_read_with_timeout(
        app,
        workspace_id,
        integration_id,
        directory,
        session_id,
        principal,
        INTEGRATION_ATTACHMENT_TIMEOUT,
    )
    .await
}

pub(crate) async fn binding_read_with_timeout(
    app: &App,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    session_id: &str,
    principal: Option<CancellationToken>,
    timeout: Duration,
) -> Result<BindingResponse, AttachmentError> {
    if !valid_native_session_id(session_id) {
        return Err(AttachmentError::Invalid);
    }
    let session = session_id.to_owned();
    let result = run(app, workspace_id, integration_id, directory, principal, timeout, false, |ctx| async move {
        let raw = rpc_call(&ctx, "bindingRead", &json!({ "sessionID": session }), Some(&session)).await?;
        let parsed = parse_binding_read_output(&raw).ok_or(AttachmentError::NonConforming)?;
        match parsed {
            BindingReadOutput::Attached { label } => {
                if looks_like_path(&label) {
                    return Err(AttachmentError::NonConforming);
                }
                Ok(BindingResponse::Attached { label })
            }
            BindingReadOutput::None => Ok(BindingResponse::None),
            BindingReadOutput::Unknown => Ok(BindingResponse::Unknown),
        }
    })
    .await;
    match result {
        Ok(resp) => Ok(resp),
        Err(err @ (AttachmentError::Invalid | AttachmentError::Forbidden | AttachmentError::Unauthorized)) => Err(err),
        Err(_) => Ok(BindingResponse::Unknown),
    }
}

pub(crate) async fn attach(
    app: &App,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    offer_id: &str,
    session_id: &str,
    principal: Option<CancellationToken>,
) -> Result<OutcomeOutput, AttachmentError> {
    attach_with_timeout(
        app,
        workspace_id,
        integration_id,
        directory,
        offer_id,
        session_id,
        principal,
        INTEGRATION_ATTACHMENT_TIMEOUT,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn attach_with_timeout(
    app: &App,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    offer_id: &str,
    session_id: &str,
    principal: Option<CancellationToken>,
    timeout: Duration,
) -> Result<OutcomeOutput, AttachmentError> {
    if !valid_offer_id(offer_id) || !valid_native_session_id(session_id) {
        return Err(AttachmentError::Invalid);
    }
    let offer_id = offer_id.to_owned();
    let session_id = session_id.to_owned();
    run(app, workspace_id, integration_id, directory, principal, timeout, false, |ctx| async move {
        let lock = ctx.app.integration_attachments.lock_for(&session_id);
        let _guard =
            tokio::time::timeout_at(ctx.deadline, lock.lock_owned()).await.map_err(|_| AttachmentError::Unavailable)?;
        verify_status(&ctx, Some(&session_id)).await?;
        let hosts = fetch_hosts(&ctx, Some(&session_id)).await?;
        let Some(offer) = hosts.offers.into_iter().find(|candidate| candidate.offer_id == offer_id) else {
            return Ok(OutcomeOutput { outcome: "gone" });
        };
        if offer.protocol != "ok" {
            return Ok(OutcomeOutput { outcome: "refused" });
        }
        let raw =
            rpc_call(&ctx, "attachHost", &json!({ "offerID": offer_id, "sessionID": session_id }), Some(&session_id))
                .await?;
        let parsed = parse_attach_host_output(&raw).ok_or(AttachmentError::NonConforming)?;
        if parsed.outcome == "attached" {
            let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
            let hint = json!({
                "integration": ctx.entry.id,
                "label": offer.label,
                "attachedAt": now_ms,
            });
            write_hint(&ctx, &session_id, Some(hint)).await?;
        }
        Ok(parsed)
    })
    .await
}

pub(crate) async fn detach(
    app: &App,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    session_id: &str,
    principal: Option<CancellationToken>,
) -> Result<OutcomeOutput, AttachmentError> {
    detach_with_timeout(
        app,
        workspace_id,
        integration_id,
        directory,
        session_id,
        principal,
        INTEGRATION_ATTACHMENT_TIMEOUT,
    )
    .await
}

pub(crate) async fn detach_with_timeout(
    app: &App,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    session_id: &str,
    principal: Option<CancellationToken>,
    timeout: Duration,
) -> Result<OutcomeOutput, AttachmentError> {
    if !valid_native_session_id(session_id) {
        return Err(AttachmentError::Invalid);
    }
    let session_id = session_id.to_owned();
    run(app, workspace_id, integration_id, directory, principal, timeout, false, |ctx| async move {
        let lock = ctx.app.integration_attachments.lock_for(&session_id);
        let _guard =
            tokio::time::timeout_at(ctx.deadline, lock.lock_owned()).await.map_err(|_| AttachmentError::Unavailable)?;
        // Detach remains available when the application is gone or unsupported.
        let raw = rpc_call(&ctx, "detachHost", &json!({ "sessionID": session_id }), Some(&session_id)).await?;
        let parsed = parse_detach_host_output(&raw).ok_or(AttachmentError::NonConforming)?;
        write_hint(&ctx, &session_id, None).await?;
        Ok(parsed)
    })
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run<'a, T, F, Fut>(
    app: &'a App,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    principal: Option<CancellationToken>,
    timeout: Duration,
    read_only_catalog: bool,
    operation: F,
) -> Result<T, AttachmentError>
where
    F: FnOnce(Context<'a>) -> Fut,
    Fut: std::future::Future<Output = Result<T, AttachmentError>>,
{
    if !valid_integration_id(integration_id)
        || directory.is_empty()
        || directory.encode_utf16().count() > 32_768
        || directory.chars().any(char::is_control)
    {
        return Err(AttachmentError::Invalid);
    }
    let deadline = Instant::now() + timeout;
    let location = ControlLocation::new(directory.to_owned(), None);
    let cancel = CancellationToken::new();

    let work = async {
        let ((snapshot, workspace, endpoint, pin), catalog) = tokio::try_join!(
            async {
                engine::read_bound(app, workspace_id, &location, principal.as_ref(), Some(&cancel))
                    .await
                    .map_err(map_controls_fail)
            },
            async { Ok::<_, AttachmentError>(app.integration_catalog.read_view(!read_only_catalog).await) },
        )?;
        let recognition = recognize_integrations(&catalog.catalog, &snapshot)
            .into_iter()
            .find(|item| item.entry.id == integration_id)
            .ok_or(AttachmentError::NotFound)?;
        if recognition.entry.family != "native" {
            return Err(AttachmentError::Unsupported);
        }
        if recognition.ambiguous {
            return Err(AttachmentError::NonConforming);
        }
        if !matches!(recognition.runtime.as_ref().map(|r| &r.state), Some(RuntimeState::Active)) {
            return Err(AttachmentError::Inactive);
        }
        let ctx = Context {
            app,
            workspace,
            location: snapshot.location,
            pin,
            entry: recognition.entry,
            endpoint,
            principal,
            deadline,
        };
        authorize(&ctx).await?;
        operation(ctx).await
    };

    match tokio::time::timeout_at(deadline, work).await {
        Ok(res) => res,
        Err(_) => {
            cancel.cancel();
            Err(AttachmentError::Unavailable)
        }
    }
}

async fn authorize(ctx: &Context<'_>) -> Result<(), AttachmentError> {
    let _ = ctx.remaining()?;
    assert_current(ctx.app, &ctx.endpoint, &ctx.workspace, ctx.principal.as_ref()).map_err(map_auth_fail)?;
    if ctx.location.workspace_id.is_some()
        || !owns_location(ctx.app, &ctx.workspace, &ctx.location.directory, &ctx.pin).await
    {
        return Err(AttachmentError::Forbidden);
    }
    let _ = ctx.remaining()?;
    assert_current(ctx.app, &ctx.endpoint, &ctx.workspace, ctx.principal.as_ref()).map_err(map_auth_fail)?;
    Ok(())
}

async fn fetch_session(ctx: &Context<'_>, session_id: &str) -> Result<Value, AttachmentError> {
    authorize(ctx).await?;
    let left = ctx.remaining()?;
    assert_current(ctx.app, &ctx.endpoint, &ctx.workspace, ctx.principal.as_ref()).map_err(map_auth_fail)?;
    let mut url = ctx.endpoint.url.clone();
    url.path_segments_mut().map_err(|_| AttachmentError::Unavailable)?.clear().extend(["api", "session", session_id]);

    let response = ctx
        .app
        .native
        .client
        .get(url)
        .basic_auth("opencode", Some(&ctx.endpoint.password))
        .timeout(left)
        .send()
        .await
        .map_err(|_| AttachmentError::Unavailable)?;

    if response.status() == Status::NOT_FOUND {
        if !is_json_content_type(response.headers()) {
            return Err(AttachmentError::Unavailable);
        }
        let body = crate::opencode::read_json(response, 4096).await.ok();
        if body.as_ref().and_then(|v| v.get("_tag")).and_then(Value::as_str) == Some("SessionNotFoundError") {
            return Err(AttachmentError::NotFound);
        }
        return Err(AttachmentError::Unavailable);
    }
    if response.status() != Status::OK || !is_json_content_type(response.headers()) {
        return Err(AttachmentError::Unavailable);
    }
    let mut parsed = crate::opencode::read_json(response, SESSION_RECORD_MAX_BYTES)
        .await
        .map_err(|_| AttachmentError::Unavailable)?;
    // Native `GET /api/session/:id` always wraps the session record in `{ "data": { ... } }`.
    let Some(record) = parsed.as_object_mut().and_then(|o| o.remove("data")).filter(Value::is_object) else {
        return Err(AttachmentError::Unavailable);
    };

    authorize(ctx).await?;
    let Some(id) = record.get("id").and_then(Value::as_str) else {
        return Err(AttachmentError::Forbidden);
    };
    let Some(session_dir) = read_local_location_ref(record.get("location")) else {
        return Err(AttachmentError::Forbidden);
    };
    if id != session_id || session_dir != ctx.location.directory {
        return Err(AttachmentError::Forbidden);
    }
    Ok(record)
}

/// Validates a native session `location` object (`readLocationRef` + no `workspaceID`).
fn read_local_location_ref(value: Option<&Value>) -> Option<&str> {
    let obj = value?.as_object()?;
    if obj.get("workspaceID").is_some() {
        return None;
    }
    let dir = obj.get("directory")?.as_str()?;
    if crate::shared::js_trim(dir).is_empty() || dir.contains('\0') {
        return None;
    }
    Some(dir)
}

async fn rpc_call(
    ctx: &Context<'_>,
    method: &str,
    input: &Value,
    session_id: Option<&str>,
) -> Result<Value, AttachmentError> {
    if let Some(sid) = session_id {
        let _ = fetch_session(ctx, sid).await?;
    } else {
        authorize(ctx).await?;
    }

    let left = ctx.remaining()?;
    assert_current(ctx.app, &ctx.endpoint, &ctx.workspace, ctx.principal.as_ref()).map_err(map_auth_fail)?;
    let url = ctx
        .endpoint
        .url
        .join(&format!("/api/rpc/{}/{method}", ctx.entry.rpc))
        .map_err(|_| AttachmentError::Unavailable)?;

    let call_result: Result<Value, AttachmentError> = match ctx
        .app
        .native
        .client
        .request(Method::POST, url)
        .basic_auth("opencode", Some(&ctx.endpoint.password))
        .query(&[("location[directory]", ctx.location.directory.as_str())])
        .json(&json!({ "input": input }))
        .timeout(left)
        .send()
        .await
    {
        Ok(response) if response.status() == Status::OK && is_json_content_type(response.headers()) => {
            match crate::opencode::read_json(response, RPC_OUTPUT_MAX_BYTES).await {
                Ok(mut body) => match body.as_object_mut().and_then(|o| o.remove("output")) {
                    Some(output) => Ok(output),
                    None => Err(AttachmentError::NonConforming),
                },
                Err(_) => Err(AttachmentError::Unavailable),
            }
        }
        Ok(response) if response.status() == Status::BAD_REQUEST && is_json_content_type(response.headers()) => {
            match crate::opencode::read_json(response, 64 * 1024).await {
                Ok(body) => Err(classify_attachment_rpc_error(&body)),
                Err(_) => Err(AttachmentError::Unavailable),
            }
        }
        Ok(_) | Err(_) => Err(AttachmentError::Unavailable),
    };

    // Always re-verify session/location authority AFTER the RPC, even if the RPC failed.
    if let Some(sid) = session_id {
        let _ = fetch_session(ctx, sid).await?;
    } else {
        authorize(ctx).await?;
    }

    call_result
}

async fn verify_status(ctx: &Context<'_>, session_id: Option<&str>) -> Result<(), AttachmentError> {
    let raw = rpc_call(ctx, "status", &json!({}), session_id).await?;
    let parsed = parse_status_output(&raw).ok_or(AttachmentError::NonConforming)?;
    if parsed.id != ctx.entry.id
        || parsed.family != ctx.entry.family
        || parsed.host.as_ref().and_then(|h| h.app_version.as_deref()).is_some_and(looks_like_path)
    {
        return Err(AttachmentError::NonConforming);
    }
    if parsed.host.as_ref().is_some_and(|h| h.state == "unsupported") {
        return Err(AttachmentError::Unsupported);
    }
    Ok(())
}

async fn fetch_hosts(ctx: &Context<'_>, session_id: Option<&str>) -> Result<IntegrationHostsOutput, AttachmentError> {
    let raw = rpc_call(ctx, "hosts", &json!({}), session_id).await?;
    let parsed = parse_hosts_output(&raw).ok_or(AttachmentError::NonConforming)?;
    if parsed.offers.iter().any(|offer| {
        looks_like_path(&offer.label)
            || offer.document.as_deref().is_some_and(looks_like_path)
            || offer.app_version.as_deref().is_some_and(looks_like_path)
    }) {
        return Err(AttachmentError::NonConforming);
    }
    Ok(parsed)
}

async fn write_hint(ctx: &Context<'_>, session_id: &str, hint: Option<Value>) -> Result<(), AttachmentError> {
    // Native `session.update` replaces `metadata` as a whole: read immediately before writing so
    // unrelated keys are preserved.
    let record = fetch_session(ctx, session_id).await?;
    let mut metadata: Map<String, Value> = match record.get("metadata") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => return Err(AttachmentError::Unavailable),
    };
    match hint {
        Some(val) => {
            metadata.insert(INTEGRATION_ATTACHMENT_METADATA_KEY.to_owned(), val);
        }
        None => {
            metadata.remove(INTEGRATION_ATTACHMENT_METADATA_KEY);
        }
    }

    let left = ctx.remaining()?;
    assert_current(ctx.app, &ctx.endpoint, &ctx.workspace, ctx.principal.as_ref()).map_err(map_auth_fail)?;
    let mut url = ctx.endpoint.url.clone();
    url.path_segments_mut().map_err(|_| AttachmentError::Unavailable)?.clear().extend(["api", "session", session_id]);

    let response = ctx
        .app
        .native
        .client
        .request(Method::PATCH, url)
        .basic_auth("opencode", Some(&ctx.endpoint.password))
        .json(&json!({ "metadata": metadata }))
        .timeout(left)
        .send()
        .await
        .map_err(|_| AttachmentError::Unavailable)?;

    if response.status() != Status::NO_CONTENT {
        return Err(AttachmentError::Unavailable);
    }
    let _ = fetch_session(ctx, session_id).await?;
    Ok(())
}

fn classify_attachment_rpc_error(body: &Value) -> AttachmentError {
    if body.get("_tag").and_then(Value::as_str) != Some("RpcError") {
        return AttachmentError::Unavailable;
    }
    match body.get("type").and_then(Value::as_str) {
        Some("rpc.invalid_output") => AttachmentError::NonConforming,
        Some("rpc.unavailable" | "rpc.method_not_found") => AttachmentError::Unsupported,
        _ => AttachmentError::Unavailable,
    }
}

fn map_auth_fail(err: Fail) -> AttachmentError {
    match err {
        Fail::Status(Status::UNAUTHORIZED, _) => AttachmentError::Unauthorized,
        _ => AttachmentError::Unavailable,
    }
}

fn map_controls_fail(err: Fail) -> AttachmentError {
    match err {
        Fail::Status(Status::UNAUTHORIZED, _) => AttachmentError::Unauthorized,
        Fail::Status(Status::FORBIDDEN, _) => AttachmentError::Forbidden,
        Fail::Status(Status::NOT_FOUND, _) => AttachmentError::NotFound,
        Fail::Status(Status::UNPROCESSABLE_ENTITY, _) => AttachmentError::Invalid,
        _ => AttachmentError::Unavailable,
    }
}
