//! Catalog integration reader (`opencode/integrations/integrations.ts` and `status.ts`).
//!
//! Recognises every catalog entry from the authoritative `PluginControls` snapshot, invokes each
//! loaded integration's `status` RPC under its catalog RPC ID with bounded concurrency and
//! timeout, then re-checks Location ownership and daemon identity before returning.

use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
    time::Duration,
};

use axum::http::{Method, StatusCode as Status};
use futures_util::future::join_all;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::{
    App,
    opencode::Endpoint,
    opencode_settings::{assert_current, fail},
    plugin_controls::{
        catalog::{CatalogAvailability, IntegrationCatalogApp},
        engine,
        snapshot::{ConfigScope, ControlLocation, RuntimeSource, RuntimeState},
    },
    subagent_depth::Fail,
};

use super::{
    contract::{
        IntegrationStatusConnection, IntegrationStatusHost, IntegrationStatusOutput, is_integration_docs_url,
        looks_like_path, parse_status_output,
    },
    is_json_content_type, owns_location,
    recognition::{IntegrationRecognition, recognize_integrations},
};

pub(crate) const INTEGRATION_STATUS_TIMEOUT: Duration = Duration::from_secs(8);
const INTEGRATION_STATUS_CONCURRENCY: usize = 4;
const STATUS_RPC_MAX_BYTES: usize = 256 * 1024;
const RPC_ERROR_MAX_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum IntegrationRuntimeState {
    Absent,
    Inactive,
    Failed,
    Unsupported,
    NonConforming,
    Unknown,
    Ok,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogMeta {
    pub(crate) state: CatalogAvailability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) fetched_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AmbiguousSourceRef {
    pub(crate) scope: &'static str,
    pub(crate) entry_index: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfiguredRef {
    pub(crate) scope: &'static str,
    pub(crate) entry_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expected_revision: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginFacts {
    pub(crate) declared: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime_id: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct IntegrationConnectionView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) offers: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) state: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct IntegrationStatusView {
    pub(crate) version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) host: Option<IntegrationStatusHost>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) connection: Option<IntegrationConnectionView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) notices: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrationView {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) family: String,
    pub(crate) summary: BTreeMap<String, String>,
    pub(crate) app: IntegrationCatalogApp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) docs: Option<String>,
    pub(crate) catalog_status: String,
    pub(crate) configured: bool,
    pub(crate) plugin: PluginFacts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ambiguous: Option<bool>,
    pub(crate) scopes: Vec<&'static str>,
    pub(crate) configured_sources: Vec<ConfiguredRef>,
    pub(crate) configured_rules: Vec<ConfiguredRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) outdated: Option<bool>,
    pub(crate) state: IntegrationRuntimeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<IntegrationStatusView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrationsResponse {
    pub(crate) location: ControlLocation,
    pub(crate) catalog: CatalogMeta,
    pub(crate) ambiguous_sources: Vec<AmbiguousSourceRef>,
    pub(crate) integrations: Vec<IntegrationView>,
}

pub(crate) async fn read(
    app: &App,
    workspace_id: &str,
    location: &ControlLocation,
    principal: Option<&CancellationToken>,
) -> Result<IntegrationsResponse, Fail> {
    read_with_timeout(app, workspace_id, location, principal, INTEGRATION_STATUS_TIMEOUT).await
}

pub(crate) async fn read_with_timeout(
    app: &App,
    workspace_id: &str,
    location: &ControlLocation,
    principal: Option<&CancellationToken>,
    timeout: Duration,
) -> Result<IntegrationsResponse, Fail> {
    read_inner(
        app,
        workspace_id,
        location,
        principal,
        timeout,
        #[cfg(test)]
        None,
    )
    .await
}

#[cfg(test)]
pub(crate) async fn read_with_timeout_and_headers_hook(
    app: &App,
    workspace_id: &str,
    location: &ControlLocation,
    principal: Option<&CancellationToken>,
    timeout: Duration,
    on_status_headers: Arc<tokio::sync::Notify>,
) -> Result<IntegrationsResponse, Fail> {
    read_inner(app, workspace_id, location, principal, timeout, Some(on_status_headers)).await
}

async fn read_inner(
    app: &App,
    workspace_id: &str,
    location: &ControlLocation,
    principal: Option<&CancellationToken>,
    timeout: Duration,
    #[cfg(test)] on_status_headers: Option<Arc<tokio::sync::Notify>>,
) -> Result<IntegrationsResponse, Fail> {
    let ((snapshot, workspace, endpoint, pin), catalog) =
        tokio::try_join!(engine::read_bound(app, workspace_id, location, principal, None), async {
            Ok::<_, Fail>(app.integration_catalog.read_view(true).await)
        },)?;

    let owned = snapshot.location.clone();
    let recognitions = recognize_integrations(&catalog.catalog, &snapshot);

    let sem = Arc::new(Semaphore::new(INTEGRATION_STATUS_CONCURRENCY));
    let statuses = join_all(recognitions.iter().map(|recognition| {
        let sem = sem.clone();
        let endpoint = endpoint.clone();
        let workspace = workspace.clone();
        let dir = owned.directory.clone();
        let pin = pin.clone();
        #[cfg(test)]
        let on_status_headers = on_status_headers.clone();
        async move {
            // Short-circuit entries that require no RPC without consuming a concurrency slot.
            if let Some(local) = local_status_state(recognition) {
                return StatusRead::State(local);
            }
            let _permit = match principal {
                Some(tok) => tokio::select! {
                    biased;
                    _ = tok.cancelled() => return StatusRead::Aborted,
                    res = sem.acquire_owned() => match res { Ok(p) => p, Err(_) => return StatusRead::Aborted },
                },
                None => match sem.acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => return StatusRead::Aborted,
                },
            };
            // Re-verify connection, principal, and location authority right after acquiring the
            // semaphore permit so queued RPCs never dispatch after authority revocation.
            if assert_current(app, &endpoint, &workspace, principal).is_err()
                || !owns_location(app, &workspace, &dir, &pin).await
                || assert_current(app, &endpoint, &workspace, principal).is_err()
            {
                return StatusRead::Aborted;
            }
            read_one_status(
                app,
                &endpoint,
                &dir,
                recognition,
                principal,
                timeout,
                #[cfg(test)]
                on_status_headers.as_deref(),
            )
            .await
        }
    }))
    .await;

    if !owns_location(app, &workspace, &owned.directory, &pin).await {
        return Err(fail(Status::FORBIDDEN, "Location is not owned by this workspace"));
    }
    assert_current(app, &endpoint, &workspace, principal).map_err(|err| match err {
        Fail::Status(Status::UNAUTHORIZED, msg) => Fail::Status(Status::UNAUTHORIZED, msg),
        _ => fail(Status::SERVICE_UNAVAILABLE, "OpenCode service connection changed"),
    })?;
    if statuses.iter().any(|s| matches!(s, StatusRead::Aborted)) {
        return Err(fail(Status::SERVICE_UNAVAILABLE, "OpenCode service connection changed"));
    }

    let find_target = |scope: ConfigScope, path: Option<&str>| -> Option<(&'static str, Option<String>)> {
        let scope_str = writable_scope(scope)?;
        let path = path?;
        snapshot
            .targets
            .iter()
            .find(|t| t.scope == scope_str && t.path == path)
            .map(|t| (scope_str, t.expected_revision.clone()))
    };

    let mut ambiguous_seen: HashSet<(&'static str, usize)> = HashSet::new();
    let mut ambiguous_sources = Vec::new();
    for recognition in &recognitions {
        for &idx in &recognition.candidates {
            let source = &snapshot.configured.sources[idx];
            if let Some((scope_str, _)) = find_target(source.scope, source.path.as_deref())
                && ambiguous_seen.insert((scope_str, source.entry_index))
            {
                ambiguous_sources.push(AmbiguousSourceRef { scope: scope_str, entry_index: source.entry_index });
            }
        }
    }

    let integrations = recognitions
        .into_iter()
        .zip(statuses)
        .map(|(recognition, status_read)| {
            let entry = recognition.entry;
            let scopes: Vec<&'static str> = recognition.scopes.iter().copied().filter_map(writable_scope).collect();
            let configured_sources: Vec<ConfiguredRef> = recognition
                .sources
                .iter()
                .filter_map(|&idx| {
                    let source = &snapshot.configured.sources[idx];
                    let (scope_str, expected_revision) = find_target(source.scope, source.path.as_deref())?;
                    Some(ConfiguredRef { scope: scope_str, entry_index: source.entry_index, expected_revision })
                })
                .collect();
            let configured_rules: Vec<ConfiguredRef> = if recognition.ambiguous {
                Vec::new()
            } else {
                snapshot
                    .configured
                    .rules
                    .iter()
                    .filter(|rule| rule.selector == entry.plugin)
                    .filter_map(|rule| {
                        let (scope_str, expected_revision) = find_target(rule.scope, rule.path.as_deref())?;
                        Some(ConfiguredRef { scope: scope_str, entry_index: rule.entry_index, expected_revision })
                    })
                    .collect()
            };

            let (version, outdated) = match recognition.runtime.as_ref().map(|r| &r.source) {
                Some(RuntimeSource::Package { version, outdated, .. }) => {
                    (version.clone(), (*outdated == Some(true)).then_some(true))
                }
                _ => (None, None),
            };
            let runtime_state = recognition.runtime.as_ref().map(|r| match r.state {
                RuntimeState::Failed { .. } => "failed",
                RuntimeState::Active => "loaded",
            });
            let runtime_id =
                if !recognition.ambiguous { recognition.runtime.as_ref().and_then(|r| r.id.clone()) } else { None };
            let docs = is_integration_docs_url(&entry.docs, Some(&entry.id)).then_some(entry.docs);
            let (state, status) = match status_read {
                StatusRead::Ok(st) => (
                    IntegrationRuntimeState::Ok,
                    Some(IntegrationStatusView {
                        version: st.version,
                        host: st.host,
                        connection: st.connection.map(|c| project_connection(&entry.family, c)),
                        notices: st.notices,
                    }),
                ),
                StatusRead::State(state) => (state, None),
                StatusRead::Aborted => (IntegrationRuntimeState::Unknown, None),
            };

            IntegrationView {
                id: entry.id,
                display_name: entry.display_name,
                family: entry.family,
                summary: entry.summary,
                app: entry.app,
                docs,
                catalog_status: entry.status,
                configured: !recognition.ways.is_empty(),
                plugin: PluginFacts { declared: !recognition.sources.is_empty(), runtime: runtime_state, runtime_id },
                ambiguous: recognition.ambiguous.then_some(true),
                scopes,
                configured_sources,
                configured_rules,
                version,
                outdated,
                state,
                status,
            }
        })
        .collect();

    Ok(IntegrationsResponse {
        location: owned,
        catalog: CatalogMeta { state: catalog.state, fetched_at: catalog.fetched_at },
        ambiguous_sources,
        integrations,
    })
}

enum StatusRead {
    State(IntegrationRuntimeState),
    Ok(IntegrationStatusOutput),
    Aborted,
}

fn local_status_state(recognition: &IntegrationRecognition) -> Option<IntegrationRuntimeState> {
    if recognition.ways.is_empty() {
        return Some(IntegrationRuntimeState::Absent);
    }
    if recognition.ambiguous {
        return Some(IntegrationRuntimeState::NonConforming);
    }
    let Some(ref runtime) = recognition.runtime else {
        return Some(IntegrationRuntimeState::Inactive);
    };
    if matches!(runtime.state, RuntimeState::Failed { .. }) {
        return Some(IntegrationRuntimeState::Failed);
    }
    None
}

enum BodyReadErr {
    Aborted,
    Failed,
}

async fn read_json_cancellable(
    response: reqwest::Response,
    max_bytes: usize,
    principal: Option<&CancellationToken>,
    deadline: tokio::time::Instant,
) -> Result<Value, BodyReadErr> {
    let read = tokio::time::timeout_at(deadline, crate::opencode::read_json(response, max_bytes));
    match principal {
        Some(tok) => tokio::select! {
            biased;
            _ = tok.cancelled() => Err(BodyReadErr::Aborted),
            res = read => match res {
                Ok(Ok(val)) => Ok(val),
                _ => Err(BodyReadErr::Failed),
            },
        },
        None => match read.await {
            Ok(Ok(val)) => Ok(val),
            _ => Err(BodyReadErr::Failed),
        },
    }
}

async fn read_one_status(
    app: &App,
    endpoint: &Endpoint,
    directory: &str,
    recognition: &IntegrationRecognition,
    principal: Option<&CancellationToken>,
    timeout: Duration,
    #[cfg(test)] on_status_headers: Option<&tokio::sync::Notify>,
) -> StatusRead {
    let Ok(url) = endpoint.url.join(&format!("/api/rpc/{}/status", recognition.entry.rpc)) else {
        return StatusRead::State(IntegrationRuntimeState::Unknown);
    };
    let deadline = tokio::time::Instant::now() + timeout;
    let send = app
        .native
        .client
        .request(Method::POST, url)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", directory)])
        .json(&json!({ "input": {} }))
        .timeout(timeout)
        .send();

    let response = match principal {
        Some(tok) => tokio::select! {
            biased;
            _ = tok.cancelled() => return StatusRead::Aborted,
            res = tokio::time::timeout_at(deadline, send) => match res {
                Ok(Ok(resp)) => resp,
                _ => return StatusRead::State(IntegrationRuntimeState::Unknown),
            },
        },
        None => match tokio::time::timeout_at(deadline, send).await {
            Ok(Ok(resp)) => resp,
            _ => return StatusRead::State(IntegrationRuntimeState::Unknown),
        },
    };
    let status = response.status();
    if !is_json_content_type(response.headers()) {
        return StatusRead::State(IntegrationRuntimeState::Unknown);
    }
    #[cfg(test)]
    if let Some(notify) = on_status_headers {
        notify.notify_one();
    }
    if status == Status::BAD_REQUEST {
        return match read_json_cancellable(response, RPC_ERROR_MAX_BYTES, principal, deadline).await {
            Ok(body) => StatusRead::State(classify_rpc_error(&body)),
            Err(BodyReadErr::Aborted) => StatusRead::Aborted,
            Err(BodyReadErr::Failed) => StatusRead::State(IntegrationRuntimeState::Unknown),
        };
    }
    if status != Status::OK {
        return StatusRead::State(IntegrationRuntimeState::Unknown);
    }
    let body = match read_json_cancellable(response, STATUS_RPC_MAX_BYTES, principal, deadline).await {
        Ok(val) => val,
        Err(BodyReadErr::Aborted) => return StatusRead::Aborted,
        Err(BodyReadErr::Failed) => return StatusRead::State(IntegrationRuntimeState::Unknown),
    };
    let Some(output) = body.get("output") else {
        return StatusRead::State(IntegrationRuntimeState::NonConforming);
    };
    let Some(parsed) = parse_status_output(output) else {
        return StatusRead::State(IntegrationRuntimeState::NonConforming);
    };
    if parsed.id != recognition.entry.id || parsed.family != recognition.entry.family {
        return StatusRead::State(IntegrationRuntimeState::NonConforming);
    }
    if parsed.host.as_ref().and_then(|h| h.app_version.as_deref()).is_some_and(looks_like_path) {
        return StatusRead::State(IntegrationRuntimeState::NonConforming);
    }
    StatusRead::Ok(parsed)
}

fn classify_rpc_error(body: &Value) -> IntegrationRuntimeState {
    if body.get("_tag").and_then(Value::as_str) != Some("RpcError") {
        return IntegrationRuntimeState::Unknown;
    }
    match body.get("type").and_then(Value::as_str) {
        Some("rpc.unavailable" | "rpc.method_not_found") => IntegrationRuntimeState::Unsupported,
        Some("rpc.invalid_output") => IntegrationRuntimeState::NonConforming,
        _ => IntegrationRuntimeState::Unknown,
    }
}

fn writable_scope(scope: ConfigScope) -> Option<&'static str> {
    match scope {
        ConfigScope::Global => Some("global"),
        ConfigScope::Project => Some("project"),
        ConfigScope::Other | ConfigScope::Virtual => None,
    }
}

fn project_connection(family: &str, connection: IntegrationStatusConnection) -> IntegrationConnectionView {
    if family == "native" {
        return IntegrationConnectionView { offers: connection.offers, state: None };
    }
    let state =
        if matches!(connection.state.as_str(), "attached" | "available") { None } else { Some(connection.state) };
    IntegrationConnectionView { offers: None, state }
}
