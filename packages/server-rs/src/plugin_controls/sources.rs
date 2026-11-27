//! Plugin source declarations (`opencode/plugin-sources.ts`):
//! - `POST /api/workspaces/:id/plugin-sources` (server-wide serialized add with deadline + duplicate/selector checks)
//! - `DELETE /api/workspaces/:id/plugin-sources` (confirmed source removal with dependent rule cleanup, or orphan rule removal)

use std::{
    collections::{BTreeMap, HashSet},
    sync::{
        Arc, LazyLock,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use axum::http::StatusCode as Status;
use serde::Serialize;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::{Shared, opencode::Endpoint, opencode_settings::Scope, subagent_depth::Fail};

use super::{
    catalog::{IntegrationCatalog, integrations_for_spec},
    doc::{append_plugin_control_rule, remove_plugin_source_entry, replace_plugin_control_rules},
    engine::{self, COMMIT_ABORTED, COMMIT_ADMITTED, COMMIT_PENDING},
    order::defined_before,
    snapshot::{ControlLocation, Snapshot},
    spec::{plugin_package_identities, validate_plugin_source_spec},
};

pub(super) const PLUGIN_SOURCE_ADD_TIMEOUT: Duration = Duration::from_secs(20);
const PLUGIN_SOURCE_ABORT_GRACE: Duration = Duration::from_secs(5);

/// Server-wide queue: the Global document is shared across every workspace.
static ADD_QUEUE: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Clone, Debug)]
pub(crate) enum SourceError {
    Refused { status: Status, code: Option<&'static str> },
    Failed,
}

impl SourceError {
    pub(crate) const fn with_code(status: Status, code: &'static str) -> Self {
        Self::Refused { status, code: Some(code) }
    }

    pub(crate) fn from_fail(err: Fail) -> Self {
        match err {
            Fail::Status(status, _) => Self::Refused { status, code: None },
            Fail::Generic => Self::Failed,
        }
    }
}

pub(crate) struct SourceAddRequest {
    pub(crate) location: ControlLocation,
    pub(crate) scope: Scope,
    pub(crate) spec: String,
}

pub(super) enum SourceRemoveTarget {
    Entry {
        target: String,
        entry_index: usize,
    },
    Orphan {
        plugin_id: String,
    },
    /// Valid JS JSON body whose `target` or `pluginId` contains an unpaired UTF-16 surrogate:
    /// runs every ordinary DELETE guard (queues, scope availability, ownership, fence, revision)
    /// and refuses as `409 stale` at comparison time without writing.
    Unrepresentable,
}

pub(super) struct SourceRemoveRequest {
    pub(super) location: ControlLocation,
    pub(super) scope: Scope,
    pub(super) expected_revision: String,
    pub(super) kind: SourceRemoveTarget,
}

#[derive(Serialize)]
pub(crate) struct SourceMutationResponse {
    pub(crate) scope: &'static str,
    pub(crate) spec: String,
    #[serde(rename = "reloadPending")]
    pub(crate) reload_pending: bool,
}

pub(super) async fn add(
    app: &Shared,
    workspace_id: &str,
    req: SourceAddRequest,
    principal: Option<CancellationToken>,
) -> Result<SourceMutationResponse, SourceError> {
    add_with_timeouts_pinned(
        app,
        workspace_id,
        req,
        principal,
        None,
        None,
        PLUGIN_SOURCE_ADD_TIMEOUT,
        PLUGIN_SOURCE_ABORT_GRACE,
    )
    .await
}

pub(crate) async fn add_pinned(
    app: &Shared,
    workspace_id: &str,
    req: SourceAddRequest,
    principal: Option<CancellationToken>,
    pinned_endpoint: Option<Arc<Endpoint>>,
    pinned_location: Option<engine::PinnedLocation>,
) -> Result<SourceMutationResponse, SourceError> {
    add_with_timeouts_pinned(
        app,
        workspace_id,
        req,
        principal,
        pinned_endpoint,
        pinned_location,
        PLUGIN_SOURCE_ADD_TIMEOUT,
        PLUGIN_SOURCE_ABORT_GRACE,
    )
    .await
}

#[cfg(test)]
pub(super) async fn add_with_timeouts(
    app: &Shared,
    workspace_id: &str,
    req: SourceAddRequest,
    principal: Option<CancellationToken>,
    add_timeout: Duration,
    abort_grace: Duration,
) -> Result<SourceMutationResponse, SourceError> {
    add_with_timeouts_pinned(app, workspace_id, req, principal, None, None, add_timeout, abort_grace).await
}

#[allow(clippy::too_many_arguments)]
async fn add_with_timeouts_pinned(
    app: &Shared,
    workspace_id: &str,
    req: SourceAddRequest,
    principal: Option<CancellationToken>,
    pinned_endpoint: Option<Arc<Endpoint>>,
    pinned_location: Option<engine::PinnedLocation>,
    add_timeout: Duration,
    abort_grace: Duration,
) -> Result<SourceMutationResponse, SourceError> {
    if let Err((code, _)) = validate_plugin_source_spec(&req.spec) {
        return Err(SourceError::with_code(Status::UNPROCESSABLE_ENTITY, code.as_str()));
    }
    let _turn = ADD_QUEUE.lock().await;
    let deadline = tokio::time::Instant::now() + add_timeout;
    let hard_deadline = deadline + abort_grace;
    let cancel = CancellationToken::new();
    let commit_state = Arc::new(AtomicU8::new(COMMIT_PENDING));
    let cancel_timer = cancel.clone();
    let state_timer = commit_state.clone();
    let timer = tokio::spawn(async move {
        tokio::time::sleep_until(deadline).await;
        // Arbitrate expiration on the same atomic state as rename admission so a rename cannot be
        // admitted during the grace window.
        let _ = state_timer.compare_exchange(COMMIT_PENDING, COMMIT_ABORTED, Ordering::SeqCst, Ordering::SeqCst);
        cancel_timer.cancel();
    });
    let op = add_serialized(
        app,
        workspace_id,
        &req,
        principal,
        pinned_endpoint,
        pinned_location,
        cancel.clone(),
        deadline,
        commit_state.clone(),
    );
    tokio::pin!(op);
    let outcome = match tokio::time::timeout_at(hard_deadline, &mut op).await {
        Ok(Ok(res)) => Ok(res),
        Ok(Err(err)) => {
            if cancel.is_cancelled() && commit_state.load(Ordering::SeqCst) != COMMIT_ADMITTED {
                Err(SourceError::with_code(Status::SERVICE_UNAVAILABLE, "timeout"))
            } else {
                Err(err)
            }
        }
        Err(_) => {
            cancel.cancel();
            if commit_state.compare_exchange(COMMIT_PENDING, COMMIT_ABORTED, Ordering::SeqCst, Ordering::SeqCst).is_ok()
                || commit_state.load(Ordering::SeqCst) == COMMIT_ABORTED
            {
                // Proven: `rename` has not been admitted and will abort under `guard_current`.
                Err(SourceError::with_code(Status::SERVICE_UNAVAILABLE, "timeout"))
            } else {
                // `rename` was already admitted (`COMMIT_ADMITTED`): return its real outcome without reclassifying.
                op.await
            }
        }
    };
    timer.abort();
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn add_serialized(
    app: &Shared,
    workspace_id: &str,
    req: &SourceAddRequest,
    principal: Option<CancellationToken>,
    pinned_endpoint: Option<Arc<Endpoint>>,
    pinned_location: Option<engine::PinnedLocation>,
    cancel: CancellationToken,
    deadline: tokio::time::Instant,
    commit_state: Arc<AtomicU8>,
) -> Result<SourceMutationResponse, SourceError> {
    let timeout_err = || SourceError::with_code(Status::SERVICE_UNAVAILABLE, "timeout");
    // Fail fast on workspace/daemon errors (matching JS `Promise.all`) so a slow catalog cannot
    // mask an immediate 404/403 refusal as a 503 timeout.
    let (snapshot, raw_docs, catalog) = tokio::try_join!(
        async {
            engine::read(app, workspace_id, &req.location, principal.as_ref(), Some(&cancel))
                .await
                .map_err(SourceError::from_fail)
        },
        async {
            engine::read_config_documents(app, workspace_id, &req.location, principal.as_ref(), Some(&cancel))
                .await
                .map_err(SourceError::from_fail)
        },
        async {
            Ok::<IntegrationCatalog, SourceError>(tokio::select! {
                _ = cancel.cancelled() => IntegrationCatalog::default(),
                catalog = app.integration_catalog.read() => catalog,
            })
        },
    )?;
    if cancel.is_cancelled() {
        return Err(timeout_err());
    }
    if pinned_location.as_ref().is_some_and(|p| p.directory != snapshot.location.directory) {
        return Err(SourceError::Refused { status: Status::FORBIDDEN, code: None });
    }

    // Integration catalog rules (`plugin-sources.ts:89-101`):
    // 1. Native integrations install in Global configuration only (`422 global-only`).
    // 2. Registry/Git specs of the same integration collide (`409 duplicate`).
    // 3. An integration whose plugin ID is already loaded in runtime collides (`409 duplicate`).
    let integrations = integrations_for_spec(&catalog, &req.spec);
    if req.scope == Scope::Project && integrations.iter().any(|entry| entry.family == "native") {
        return Err(SourceError::with_code(Status::UNPROCESSABLE_ENTITY, "global-only"));
    }
    let mut identities: HashSet<String> = plugin_package_identities(&req.spec).into_iter().collect();
    for entry in &integrations {
        identities.insert(format!("integration:{}", entry.id));
    }
    let loaded: HashSet<&str> = snapshot.runtime.iter().filter_map(|e| e.id.as_deref()).collect();
    if integrations.iter().any(|entry| loaded.contains(entry.plugin.as_str())) {
        return Err(SourceError::with_code(Status::CONFLICT, "duplicate"));
    }

    let ids = known_plugin_ids(&snapshot);

    let configured_targets: Vec<&str> = snapshot.configured.sources.iter().map(|s| s.target.as_str()).collect();
    assert_not_declared(&configured_targets, &identities, &HashSet::new(), &catalog)?;

    let mut raw_targets: Vec<String> = Vec::new();
    for (_, _, entries) in &raw_docs {
        raw_targets.extend(entries.iter().map(|e| e.target().to_owned()));
    }
    let raw_refs: Vec<&str> = raw_targets.iter().map(String::as_str).collect();
    assert_not_declared(&raw_refs, &identities, &ids, &catalog)?;

    if ids.contains(&req.spec) {
        return Err(SourceError::with_code(Status::UNPROCESSABLE_ENTITY, "plugin-id"));
    }

    let spec = req.spec.clone();
    let cancel_edit = cancel.clone();
    engine::edit_config_document_cancellable(
        app,
        engine::EditTarget {
            workspace_id,
            location: &req.location,
            scope: req.scope,
            principal,
            pinned_endpoint,
            pinned_location,
        },
        cancel,
        deadline,
        commit_state,
        SourceError::from_fail,
        timeout_err,
        move |doc, plugins| {
            if cancel_edit.is_cancelled() {
                return Err(timeout_err());
            }
            let targets: Vec<&str> = plugins.iter().map(|e| e.target()).collect();
            assert_not_declared(&targets, &identities, &ids, &catalog)?;
            append_plugin_control_rule(doc, &spec)
                .map_err(|e| SourceError::from_fail(crate::opencode_settings::mapped(e)))
        },
    )
    .await?;

    Ok(SourceMutationResponse { scope: req.scope.as_str(), spec: req.spec.clone(), reload_pending: true })
}

pub(super) async fn remove(
    app: &Shared,
    workspace_id: &str,
    req: SourceRemoveRequest,
    principal: Option<CancellationToken>,
) -> Result<SourceMutationResponse, SourceError> {
    let stale = || SourceError::with_code(Status::CONFLICT, "stale");
    if !is_expected_revision(&req.expected_revision) {
        return Err(stale());
    }
    let scope = req.scope;
    let spec_out = match &req.kind {
        SourceRemoveTarget::Entry { target, .. } => target.clone(),
        SourceRemoveTarget::Orphan { plugin_id } => plugin_id.clone(),
        SourceRemoveTarget::Unrepresentable => String::new(),
    };

    let result = engine::edit_plugin_documents(
        app,
        engine::EditTarget {
            workspace_id,
            location: &req.location,
            scope,
            principal,
            pinned_endpoint: None,
            pinned_location: None,
        },
        &req.expected_revision,
        SourceError::from_fail,
        |view| {
            let own = view.targets.iter().find(|t| t.scope == scope).ok_or_else(stale)?;
            let own_order = own.order.ok_or_else(stale)?;
            if !own.consistent {
                return Err(stale());
            }
            let own_source_indexes: HashSet<usize> = own.sources.iter().map(|s| s.entry_index).collect();
            let rules_of = |id: &str, keep: &dyn Fn(&super::snapshot::ConfiguredRule) -> bool| -> Vec<usize> {
                own.rules
                    .iter()
                    .filter(|r| r.selector == id && !own_source_indexes.contains(&r.entry_index) && !keep(r))
                    .map(|r| r.entry_index)
                    .collect()
            };

            match &req.kind {
                SourceRemoveTarget::Unrepresentable => Err(stale()),
                SourceRemoveTarget::Orphan { plugin_id } => {
                    let is_orphan = view.controls.iter().any(|c| c.id == *plugin_id && c.orphan == Some(true));
                    let indexes = rules_of(plugin_id, &|_| false);
                    if !is_orphan || indexes.is_empty() {
                        return Err(stale());
                    }
                    let disable_rule = format!("-{plugin_id}");
                    let updated =
                        replace_plugin_control_rules(&own.document, &indexes, &[plugin_id, &disable_rule], None)
                            .map_err(map_doc_remove_error)?;
                    Ok(vec![(scope, updated)])
                }
                SourceRemoveTarget::Entry { target, entry_index } => {
                    let source_pos = own
                        .sources
                        .iter()
                        .position(|s| s.entry_index == *entry_index && s.target == *target)
                        .ok_or_else(stale)?;
                    let source = &own.sources[source_pos];
                    let Some(ref id) = source.plugin_id else {
                        let updated = remove_plugin_source_entry(&own.document, *entry_index, target, &[], &[])
                            .map_err(map_doc_remove_error)?;
                        return Ok(vec![(scope, updated)]);
                    };

                    // Locate the matching source index in `view.all_sources` for `other_loader`.
                    let global_idx = view
                        .all_sources
                        .iter()
                        .position(|s| {
                            s.entry_index == source.entry_index && s.target == source.target && s.path == source.path
                        })
                        .ok_or_else(stale)?;
                    let remains = view.other_loader(global_idx);
                    let removed_pos = view
                        .sequence
                        .entries
                        .iter()
                        .find(|e| e.document == own_order && e.entry_index == *entry_index)
                        .map(|e| (e.document, e.entry_index));

                    let rule_indexes = rules_of(id, &|rule| {
                        if rule.enabled {
                            defined_before(&view.sequence, id, own_order, rule.entry_index, removed_pos)
                        } else {
                            remains
                        }
                    });
                    let disable_rule = format!("-{id}");
                    let own_updated = remove_plugin_source_entry(
                        &own.document,
                        *entry_index,
                        target,
                        &rule_indexes,
                        &[id.as_str(), disable_rule.as_str()],
                    )
                    .map_err(map_doc_remove_error)?;

                    let mut updates = vec![(scope, own_updated)];
                    // Preserve native document order deterministically (matching TS `new Set(losing.map(e => e.document))`).
                    let mut losing_by_doc: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
                    for entry in &view.sequence.entries {
                        if entry.document != own_order
                            && !entry.remove
                            && entry.plugin_id.is_none()
                            && entry.target == *id
                            && defined_before(&view.sequence, id, entry.document, entry.entry_index, None)
                            && !defined_before(&view.sequence, id, entry.document, entry.entry_index, removed_pos)
                        {
                            losing_by_doc.entry(entry.document).or_default().push(entry.entry_index);
                        }
                    }
                    for (doc_order, indexes) in losing_by_doc {
                        let Some(other_target) = view.targets.iter().find(|t| t.order == Some(doc_order)) else {
                            return Err(SourceError::with_code(Status::UNPROCESSABLE_ENTITY, "dependent-rule"));
                        };
                        if !other_target.consistent {
                            return Err(stale());
                        }
                        let other_updated =
                            replace_plugin_control_rules(&other_target.document, &indexes, &[id.as_str()], None)
                                .map_err(map_doc_remove_error)?;
                        updates.push((other_target.scope, other_updated));
                    }
                    Ok(updates)
                }
            }
        },
    )
    .await;

    match result {
        Ok(()) => Ok(SourceMutationResponse { scope: scope.as_str(), spec: spec_out, reload_pending: true }),
        Err(SourceError::Refused { status: Status::CONFLICT, code: None }) => Err(stale()),
        Err(err) => Err(err),
    }
}

fn map_doc_remove_error(err: crate::subagent_depth::document::DocError) -> SourceError {
    if matches!(err, crate::subagent_depth::document::DocError::Conflict(_)) {
        SourceError::with_code(Status::CONFLICT, "stale")
    } else {
        SourceError::from_fail(crate::opencode_settings::mapped(err))
    }
}

pub(super) fn is_expected_revision(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn known_plugin_ids(snapshot: &Snapshot) -> HashSet<String> {
    let mut ids = HashSet::new();
    for control in &snapshot.controls {
        ids.insert(control.id.clone());
    }
    for entry in &snapshot.runtime {
        if let Some(ref id) = entry.id {
            ids.insert(id.clone());
        }
    }
    for rule in &snapshot.configured.rules {
        ids.insert(rule.selector.clone());
    }
    ids
}

fn assert_not_declared(
    targets: &[&str],
    identities: &HashSet<String>,
    ids: &HashSet<String>,
    catalog: &IntegrationCatalog,
) -> Result<(), SourceError> {
    for &target in targets {
        if target.starts_with('-') || target.contains('*') || ids.contains(target) {
            continue;
        }
        let mut target_ids = plugin_package_identities(target);
        for entry in integrations_for_spec(catalog, target) {
            target_ids.push(format!("integration:{}", entry.id));
        }
        if target_ids.iter().any(|k| identities.contains(k)) {
            return Err(SourceError::with_code(Status::CONFLICT, "duplicate"));
        }
    }
    Ok(())
}
