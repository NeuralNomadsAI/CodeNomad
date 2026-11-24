use super::lifecycle::{MissionKey, Source};
use crate::platform;
use codenomad_client::{
    Receiver, Wake,
    backend::Backend,
    bounded,
    missions::{Cleanup, DeletionOutcome, DeletionRequest, LifecycleTarget},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

const CAPACITY: usize = 64;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct WorkspaceScope {
    pub server: String,
    pub workspace: String,
    pub project: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct CleanupKey {
    scope: WorkspaceScope,
    deletion_id: String,
    mission_id: String,
    request_id: String,
    expected_revision: u64,
    delete_managed_sessions: bool,
    created_at_bits: u64,
}

impl CleanupKey {
    pub fn new(scope: WorkspaceScope, cleanup: &Cleanup) -> Self {
        Self {
            scope,
            deletion_id: cleanup.deletion_id.clone(),
            mission_id: cleanup.mission_id.clone(),
            request_id: cleanup.request_id.clone(),
            expected_revision: cleanup.expected_revision,
            delete_managed_sessions: cleanup.delete_managed_sessions,
            created_at_bits: cleanup.created_at.to_bits(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DeleteState {
    Busy,
    Failed(&'static str),
}

pub(super) enum DeleteResult {
    Deleted(Option<Box<Cleanup>>),
    Failed {
        key: &'static str,
        document_cleanup: bool,
        deletion_id: Option<String>,
        tombstoned: bool,
    },
    Cancelled {
        dispatched: bool,
        document_cleanup: bool,
        deletion_id: Option<String>,
        tombstoned: bool,
    },
}

pub(super) struct DeleteIntent {
    scope: WorkspaceScope,
    pub(super) title: String,
    target: LifecycleTarget,
    request: DeletionRequest,
    pub(super) flight: Option<Receiver<DeleteResult>>,
    pub(super) error: Option<&'static str>,
    document_cleanup: bool,
    deletion_id: Option<String>,
    retired: bool,
}

enum CleanupRetryResult {
    Settled {
        receipt: Box<Cleanup>,
        mutated: bool,
        document_cleanup: bool,
    },
    Failed {
        key: &'static str,
        mutated: bool,
        document_cleanup: bool,
    },
    Cancelled {
        mutated: bool,
        document_cleanup: bool,
    },
}

struct CleanupRetry {
    key: CleanupKey,
    view_live: Arc<AtomicBool>,
    row_live: Arc<AtomicBool>,
    flight: Receiver<CleanupRetryResult>,
    retired: bool,
}

#[derive(Default)]
pub(super) struct CleanupPolled {
    pub refreshed_missions: Vec<(MissionKey, LifecycleTarget)>,
    pub refreshed_scopes: Vec<WorkspaceScope>,
    pub deleted_missions: Vec<(WorkspaceScope, String)>,
    pub settled_cleanups: Vec<(WorkspaceScope, Cleanup)>,
    pub document_pending_rows: Vec<(WorkspaceScope, String, String)>,
    pub changed: bool,
}

impl CleanupPolled {
    pub fn is_empty(&self) -> bool {
        !self.changed
            && self.refreshed_missions.is_empty()
            && self.refreshed_scopes.is_empty()
            && self.deleted_missions.is_empty()
            && self.settled_cleanups.is_empty()
            && self.document_pending_rows.is_empty()
    }
}

#[derive(Default)]
pub(super) struct CleanupOwner {
    deletes: HashMap<(WorkspaceScope, MissionKey), DeleteIntent>,
    retries: HashMap<WorkspaceScope, CleanupRetry>,
    retry_errors: HashMap<WorkspaceScope, (String, String, &'static str)>,
    document_cleanups: HashSet<(WorkspaceScope, String, String)>,
}

impl CleanupOwner {
    pub fn orphaned_deletes<'a>(
        &'a self,
        scope: &WorkspaceScope,
        selected_id: Option<&MissionKey>,
    ) -> Vec<(&'a MissionKey, &'a DeleteIntent)> {
        self.deletes
            .iter()
            .filter_map(|((intent_scope, key), intent)| {
                (!intent.retired && intent_scope == scope && selected_id != Some(key))
                    .then_some((key, intent))
            })
            .collect()
    }

    pub fn delete_state(&self, source: &Source) -> Option<DeleteState> {
        let intent = self
            .deletes
            .get(&(source.workspace_scope(), source.mission.clone()))
            .filter(|intent| intent.target == source.target && !intent.retired)?;
        if intent.flight.is_some() {
            Some(DeleteState::Busy)
        } else {
            intent.error.map(DeleteState::Failed)
        }
    }

    pub fn has_active_cleanup_retry(&self, scope: &WorkspaceScope, mission_id: &str) -> bool {
        self.retries
            .get(scope)
            .is_some_and(|retry| !retry.retired && retry.key.mission_id == mission_id)
    }

    pub fn has_active_delete_flight(&self, scope: &WorkspaceScope, mission_id: &str) -> bool {
        self.deletes.values().any(|intent| {
            !intent.retired
                && &intent.scope == scope
                && intent.target.mission == mission_id
                && intent.flight.is_some()
        })
    }

    pub fn delete_active(&self, source: &Source) -> bool {
        self.delete_state(source).is_some()
            || self.has_active_cleanup_retry(&source.workspace_scope(), &source.target.mission)
    }

    pub fn can_delete(&self, source: &Source) -> bool {
        let scope = source.workspace_scope();
        let key = (scope.clone(), source.mission.clone());
        !self.deletes.contains_key(&key)
            && !self.has_active_cleanup_retry(&scope, &source.target.mission)
            && !self.deletes.iter().any(|((_, mission), intent)| {
                mission == &source.mission
                    && intent.target == source.target
                    && intent.flight.is_some()
            })
            && self.deletes.len() < CAPACITY
    }

    pub fn start_delete(
        &mut self,
        source: &Source,
        title: String,
        revision: u64,
        delete_managed_sessions: bool,
        backend: Backend,
        wake: Wake,
    ) {
        if !self.can_delete(source) {
            return;
        }
        let Ok(request) = DeletionRequest::new(revision, delete_managed_sessions) else {
            return;
        };
        let (out, inbox) = bounded(1);
        let target = source.target.clone();
        let scope = source.workspace_scope();
        self.deletes.insert(
            (scope.clone(), source.mission.clone()),
            DeleteIntent {
                scope,
                title,
                target: target.clone(),
                request: request.clone(),
                flight: Some(inbox),
                error: None,
                document_cleanup: false,
                deletion_id: None,
                retired: false,
            },
        );
        platform::spawn(async move {
            let result = run_delete(backend, target, request, false, false, None, None).await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    pub fn retry_delete(
        &mut self,
        source: &Source,
        live: Arc<AtomicBool>,
        backend: Backend,
        wake: Wake,
    ) {
        let scope = source.workspace_scope();
        if self.has_active_cleanup_retry(&scope, &source.target.mission) {
            return;
        }
        let Some(intent) = self.deletes.get_mut(&(scope, source.mission.clone())) else {
            return;
        };
        if intent.target != source.target || intent.flight.is_some() || intent.retired {
            return;
        }
        Self::dispatch_retry_delete(intent, live, backend, wake);
    }

    pub fn retry_delete_in_scope(
        &mut self,
        scope: &WorkspaceScope,
        mission: &MissionKey,
        live: Arc<AtomicBool>,
        backend: Backend,
        wake: Wake,
    ) {
        if self.has_active_cleanup_retry(scope, &mission.id) {
            return;
        }
        let Some(intent) = self.deletes.get_mut(&(scope.clone(), mission.clone())) else {
            return;
        };
        if &intent.scope != scope || intent.flight.is_some() || intent.retired {
            return;
        }
        Self::dispatch_retry_delete(intent, live, backend, wake);
    }

    fn dispatch_retry_delete(
        intent: &mut DeleteIntent,
        live: Arc<AtomicBool>,
        backend: Backend,
        wake: Wake,
    ) {
        let (out, inbox) = bounded(1);
        let target = intent.target.clone();
        let request = intent.request.clone();
        let document_cleanup = intent.document_cleanup;
        let expected_deletion_id = intent.deletion_id.clone();
        intent.flight = Some(inbox);
        platform::spawn(async move {
            let result = run_delete(
                backend,
                target,
                request,
                true,
                document_cleanup,
                expected_deletion_id,
                Some(live),
            )
            .await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    pub fn cancel_delete(&mut self, source: &Source) {
        let key = (source.workspace_scope(), source.mission.clone());
        if self
            .deletes
            .get(&key)
            .is_some_and(|intent| intent.target == source.target && intent.flight.is_none())
        {
            self.deletes.remove(&key);
        }
    }

    pub fn cancel_delete_in_scope(&mut self, scope: &WorkspaceScope, mission: &MissionKey) {
        let key = (scope.clone(), mission.clone());
        if self
            .deletes
            .get(&key)
            .is_some_and(|intent| &intent.scope == scope && intent.flight.is_none())
        {
            self.deletes.remove(&key);
        }
    }

    pub fn retire_scope(&mut self, scope: &WorkspaceScope) {
        self.deletes.retain(|(intent_scope, _), intent| {
            if intent_scope != scope {
                return true;
            }
            if intent.flight.is_some() {
                intent.retired = true;
                true
            } else {
                false
            }
        });
        if let Some(retry) = self.retries.get_mut(scope) {
            retry.retired = true;
        }
        self.retry_errors.remove(scope);
        self.document_cleanups
            .retain(|(doc_scope, _, _)| doc_scope != scope);
    }

    pub fn retire_settled_cleanups(&mut self, scope: &WorkspaceScope, cleanups: &[Cleanup]) {
        for row in cleanups {
            if row.document_pending == Some(false) {
                self.document_cleanups.remove(&(
                    scope.clone(),
                    row.mission_id.clone(),
                    row.deletion_id.clone(),
                ));
            }
        }
        self.deletes.retain(|_, intent| {
            if &intent.scope != scope || intent.flight.is_some() {
                return true;
            }
            let matching: Vec<&Cleanup> = cleanups
                .iter()
                .filter(|row| {
                    intent.request.matches_cleanup(&intent.target.mission, row)
                        && intent
                            .deletion_id
                            .as_deref()
                            .is_none_or(|id| row.deletion_id == id)
                })
                .collect();
            if intent.deletion_id.is_none()
                && let Some(first) = matching.first()
                && matching
                    .iter()
                    .all(|row| row.deletion_id == first.deletion_id)
            {
                intent.deletion_id = Some(first.deletion_id.clone());
            }
            for row in matching {
                if row.document_pending == Some(true) {
                    intent.document_cleanup = true;
                }
                if intent
                    .deletion_id
                    .as_deref()
                    .is_none_or(|id| row.deletion_id == id)
                    && cleanup_settled_for(intent.document_cleanup, row)
                {
                    return false;
                }
            }
            true
        });
        if let Some((mission_id, deletion_id, _)) = self.retry_errors.get(scope) {
            let still_pending = cleanups.iter().any(|row| {
                row.is_pending() && &row.mission_id == mission_id && &row.deletion_id == deletion_id
            });
            if !still_pending {
                self.retry_errors.remove(scope);
            }
        }
    }

    pub fn cleanup_busy(&self, scope: &WorkspaceScope) -> bool {
        self.retries.get(scope).is_some_and(|retry| !retry.retired)
    }

    pub fn cleanup_retrying(&self, key: &CleanupKey) -> bool {
        self.retries
            .get(&key.scope)
            .is_some_and(|retry| !retry.retired && &retry.key == key)
    }

    pub fn cleanup_error(&self, scope: &WorkspaceScope) -> Option<&'static str> {
        self.retry_errors.get(scope).map(|(_, _, err)| *err)
    }

    pub fn start_cleanup_retry(
        &mut self,
        scope: WorkspaceScope,
        cleanup: Cleanup,
        view_live: Arc<AtomicBool>,
        row_live: Arc<AtomicBool>,
        backend: Backend,
        wake: Wake,
    ) {
        if !cleanup.is_pending()
            || self.retries.contains_key(&scope)
            || self.retries.len() >= CAPACITY
            || self.has_active_delete_flight(&scope, &cleanup.mission_id)
        {
            return;
        }
        self.retry_errors.remove(&scope);
        let require_document_settled = cleanup.document_pending == Some(true)
            || self.document_cleanups.contains(&(
                scope.clone(),
                cleanup.mission_id.clone(),
                cleanup.deletion_id.clone(),
            ));
        let key = CleanupKey::new(scope.clone(), &cleanup);
        let project = scope.project.clone();
        let (out, inbox) = bounded(1);
        self.retries.insert(
            scope,
            CleanupRetry {
                key,
                view_live: view_live.clone(),
                row_live: row_live.clone(),
                flight: inbox,
                retired: false,
            },
        );
        platform::spawn(async move {
            let result = run_cleanup_retry(
                backend,
                project,
                cleanup,
                require_document_settled,
                view_live,
                row_live,
            )
            .await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    pub fn poll(&mut self) -> CleanupPolled {
        let mut polled = CleanupPolled::default();
        self.deletes.retain(|(_, mission), intent| {
            let Some(result) = intent
                .flight
                .as_ref()
                .and_then(|inbox| inbox.try_recv().ok())
            else {
                return true;
            };
            intent.flight = None;
            polled.changed = true;
            if intent.retired {
                return false;
            }
            match result {
                DeleteResult::Deleted(receipt) => {
                    polled
                        .refreshed_missions
                        .push((mission.clone(), intent.target.clone()));
                    polled
                        .deleted_missions
                        .push((intent.scope.clone(), intent.target.mission.clone()));
                    if let Some(receipt) = receipt {
                        polled
                            .settled_cleanups
                            .push((intent.scope.clone(), *receipt));
                    }
                    if !polled.refreshed_scopes.contains(&intent.scope) {
                        polled.refreshed_scopes.push(intent.scope.clone());
                    }
                    false
                }
                DeleteResult::Failed {
                    key,
                    document_cleanup,
                    deletion_id,
                    tombstoned,
                } => {
                    intent.error = Some(key);
                    intent.document_cleanup |= document_cleanup;
                    if intent.deletion_id.is_none() {
                        intent.deletion_id = deletion_id;
                    }
                    if tombstoned {
                        polled
                            .deleted_missions
                            .push((intent.scope.clone(), intent.target.mission.clone()));
                    }
                    polled
                        .refreshed_missions
                        .push((mission.clone(), intent.target.clone()));
                    if !polled.refreshed_scopes.contains(&intent.scope) {
                        polled.refreshed_scopes.push(intent.scope.clone());
                    }
                    true
                }
                DeleteResult::Cancelled {
                    dispatched,
                    document_cleanup,
                    deletion_id,
                    tombstoned,
                } => {
                    intent.document_cleanup |= document_cleanup;
                    if intent.deletion_id.is_none() {
                        intent.deletion_id = deletion_id;
                    }
                    if tombstoned {
                        polled
                            .deleted_missions
                            .push((intent.scope.clone(), intent.target.mission.clone()));
                    }
                    if dispatched && !polled.refreshed_scopes.contains(&intent.scope) {
                        polled.refreshed_scopes.push(intent.scope.clone());
                    }
                    true
                }
            }
        });
        let mut finished_retries = Vec::new();
        for (scope, retry) in &self.retries {
            if let Ok(result) = retry.flight.try_recv() {
                finished_retries.push((
                    scope.clone(),
                    retry.key.mission_id.clone(),
                    retry.key.deletion_id.clone(),
                    retry.view_live.clone(),
                    retry.row_live.clone(),
                    retry.retired,
                    result,
                ));
            }
        }
        for (scope, mission_id, deletion_id, view_live, row_live, retired, result) in
            finished_retries
        {
            self.retries.remove(&scope);
            polled.changed = true;
            if retired {
                continue;
            }
            let view_current =
                view_live.load(Ordering::Acquire) && row_live.load(Ordering::Acquire);
            let record_doc = |owner: &mut Self,
                              polled: &mut CleanupPolled,
                              scope: &WorkspaceScope,
                              mission_id: &str,
                              deletion_id: &str| {
                let doc_key = (scope.clone(), mission_id.to_owned(), deletion_id.to_owned());
                if !owner.document_cleanups.contains(&doc_key) {
                    if owner.document_cleanups.len() >= CAPACITY
                        && let Some(evict) = owner.document_cleanups.iter().next().cloned()
                    {
                        owner.document_cleanups.remove(&evict);
                    }
                    owner.document_cleanups.insert(doc_key.clone());
                }
                polled.document_pending_rows.push(doc_key);
            };
            match result {
                CleanupRetryResult::Settled {
                    receipt,
                    mutated,
                    document_cleanup,
                } => {
                    if receipt.document_pending == Some(false) {
                        self.document_cleanups.remove(&(
                            scope.clone(),
                            receipt.mission_id.clone(),
                            receipt.deletion_id.clone(),
                        ));
                    } else if document_cleanup {
                        record_doc(self, &mut polled, &scope, &mission_id, &deletion_id);
                    }
                    if !view_current && !mutated {
                        continue;
                    }
                    self.deletes.retain(|_, intent| {
                        let matches = intent.scope == scope
                            && intent.flight.is_none()
                            && intent.target.mission == receipt.mission_id
                            && intent.request.request_id == receipt.request_id
                            && intent.request.expected_revision == receipt.expected_revision
                            && intent.request.delete_managed_sessions
                                == receipt.delete_managed_sessions
                            && intent
                                .deletion_id
                                .as_deref()
                                .is_none_or(|id| id == receipt.deletion_id);
                        if matches {
                            intent.document_cleanup |= document_cleanup;
                            if intent.deletion_id.is_none() {
                                intent.deletion_id = Some(receipt.deletion_id.clone());
                            }
                            !cleanup_settled_for(intent.document_cleanup, &receipt)
                        } else {
                            true
                        }
                    });
                    if view_current {
                        self.retry_errors.remove(&scope);
                        polled
                            .deleted_missions
                            .push((scope.clone(), receipt.mission_id.clone()));
                        polled.settled_cleanups.push((scope.clone(), *receipt));
                        if !polled.refreshed_scopes.contains(&scope) {
                            polled.refreshed_scopes.push(scope);
                        }
                    } else if mutated && !polled.refreshed_scopes.contains(&scope) {
                        polled.refreshed_scopes.push(scope);
                    }
                }
                CleanupRetryResult::Failed {
                    key,
                    mutated,
                    document_cleanup,
                } => {
                    if document_cleanup {
                        record_doc(self, &mut polled, &scope, &mission_id, &deletion_id);
                    }
                    if view_current {
                        if !self.retry_errors.contains_key(&scope)
                            && self.retry_errors.len() >= CAPACITY
                            && let Some(evict) = self.retry_errors.keys().next().cloned()
                        {
                            self.retry_errors.remove(&evict);
                        }
                        self.retry_errors
                            .insert(scope.clone(), (mission_id, deletion_id, key));
                        if !polled.refreshed_scopes.contains(&scope) {
                            polled.refreshed_scopes.push(scope);
                        }
                    } else if mutated && !polled.refreshed_scopes.contains(&scope) {
                        polled.refreshed_scopes.push(scope);
                    }
                }
                CleanupRetryResult::Cancelled {
                    mutated,
                    document_cleanup,
                } => {
                    if document_cleanup {
                        record_doc(self, &mut polled, &scope, &mission_id, &deletion_id);
                    }
                    if mutated && !polled.refreshed_scopes.contains(&scope) {
                        polled.refreshed_scopes.push(scope);
                    }
                }
            }
        }
        polled
    }
}

fn cleanup_settled_for(require_document_settled: bool, item: &Cleanup) -> bool {
    !item.is_pending() && (!require_document_settled || item.document_pending == Some(false))
}

async fn run_delete(
    backend: Backend,
    target: LifecycleTarget,
    request: DeletionRequest,
    reconcile_first: bool,
    mut require_document_settled: bool,
    mut expected_deletion_id: Option<String>,
    live: Option<Arc<AtomicBool>>,
) -> DeleteResult {
    let still_live = || {
        live.as_ref()
            .is_none_or(|flag| flag.load(Ordering::Acquire))
    };
    let mut tombstoned = false;
    if reconcile_first {
        let Ok(snapshot) = backend
            .read_mission_reconciliation(&target.project, &target.mission)
            .await
        else {
            return if still_live() {
                DeleteResult::Failed {
                    key: "missions.cleanup.error.unconfirmed",
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    tombstoned,
                }
            } else {
                DeleteResult::Cancelled {
                    dispatched: false,
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    tombstoned,
                }
            };
        };
        if snapshot.cleanup_unavailable {
            return if still_live() {
                DeleteResult::Failed {
                    key: "missions.cleanup.error.unconfirmed",
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    tombstoned,
                }
            } else {
                DeleteResult::Cancelled {
                    dispatched: false,
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    tombstoned,
                }
            };
        }
        let matching = snapshot.cleanups.iter().find(|item| {
            request.matches_cleanup(&target.mission, item)
                && expected_deletion_id
                    .as_deref()
                    .is_none_or(|id| item.deletion_id == id)
        });
        if matching.is_none()
            && expected_deletion_id.as_deref().is_some_and(|pinned| {
                snapshot.cleanups.iter().any(|item| {
                    request.matches_cleanup(&target.mission, item) && item.deletion_id != pinned
                })
            })
        {
            return if still_live() {
                DeleteResult::Failed {
                    key: "missions.cleanup.error.unconfirmed",
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    tombstoned: false,
                }
            } else {
                DeleteResult::Cancelled {
                    dispatched: false,
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    tombstoned: false,
                }
            };
        }
        if let Some(intent) = matching {
            if snapshot.mission_revision.is_none() {
                tombstoned = true;
            }
            if intent.document_pending == Some(true) {
                require_document_settled = true;
            }
            if expected_deletion_id.is_none() {
                expected_deletion_id = Some(intent.deletion_id.clone());
            }
            if !intent.is_pending() {
                return if cleanup_settled_for(require_document_settled, intent) {
                    DeleteResult::Deleted(Some(Box::new(intent.clone())))
                } else if still_live() {
                    DeleteResult::Failed {
                        key: "missions.cleanup.error.unconfirmed",
                        document_cleanup: require_document_settled,
                        deletion_id: expected_deletion_id,
                        tombstoned,
                    }
                } else {
                    DeleteResult::Cancelled {
                        dispatched: false,
                        document_cleanup: require_document_settled,
                        deletion_id: expected_deletion_id,
                        tombstoned,
                    }
                };
            }
        }
        if matching.is_none()
            && snapshot
                .mission_revision
                .is_some_and(|revision| revision != request.expected_revision)
        {
            return if still_live() {
                DeleteResult::Failed {
                    key: "missions.cleanup.error.revisionConflict",
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    tombstoned,
                }
            } else {
                DeleteResult::Cancelled {
                    dispatched: false,
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    tombstoned,
                }
            };
        }
        if !still_live() {
            return DeleteResult::Cancelled {
                dispatched: false,
                document_cleanup: require_document_settled,
                deletion_id: expected_deletion_id,
                tombstoned,
            };
        }
    }
    let outcome = backend
        .delete_mission(
            &target.mission,
            &request,
            expected_deletion_id.as_deref(),
            require_document_settled,
        )
        .await
        .unwrap_or(DeletionOutcome::Unconfirmed);
    if let DeletionOutcome::Deleted(receipt) = outcome {
        return DeleteResult::Deleted(receipt);
    }
    if live.is_some() && !still_live() {
        return DeleteResult::Cancelled {
            dispatched: true,
            document_cleanup: require_document_settled,
            deletion_id: expected_deletion_id,
            tombstoned,
        };
    }
    let mut key = outcome.error_key();
    let conflict = matches!(
        outcome,
        DeletionOutcome::Failed(err) if err.status == 409
    );
    if let Ok(snapshot) = backend
        .read_mission_reconciliation(&target.project, &target.mission)
        .await
        && !snapshot.cleanup_unavailable
        && let Some(intent) = snapshot.cleanups.iter().find(|item| {
            request.matches_cleanup(&target.mission, item)
                && expected_deletion_id
                    .as_deref()
                    .is_none_or(|id| item.deletion_id == id)
        })
    {
        if snapshot.mission_revision.is_none() {
            tombstoned = true;
        }
        if expected_deletion_id.is_none() {
            expected_deletion_id = Some(intent.deletion_id.clone());
        }
        if intent.document_pending == Some(true) {
            require_document_settled = true;
        }
        if cleanup_settled_for(require_document_settled, intent) {
            return DeleteResult::Deleted(Some(Box::new(intent.clone())));
        }
        if !conflict {
            key = if intent.document_pending == Some(true) {
                "missions.cleanup.documentPending"
            } else {
                "missions.cleanup.error.pending"
            };
        }
    }
    if live.is_some() && !still_live() {
        return DeleteResult::Cancelled {
            dispatched: true,
            document_cleanup: require_document_settled,
            deletion_id: expected_deletion_id,
            tombstoned,
        };
    }
    DeleteResult::Failed {
        key,
        document_cleanup: require_document_settled,
        deletion_id: expected_deletion_id,
        tombstoned,
    }
}

async fn run_cleanup_retry(
    backend: Backend,
    project: String,
    saved: Cleanup,
    mut require_document_settled: bool,
    view_live: Arc<AtomicBool>,
    row_live: Arc<AtomicBool>,
) -> CleanupRetryResult {
    let still_live = || view_live.load(Ordering::Acquire) && row_live.load(Ordering::Acquire);
    let Ok(snapshot) = backend
        .read_mission_reconciliation(&project, &saved.mission_id)
        .await
    else {
        return if still_live() {
            CleanupRetryResult::Failed {
                key: "missions.cleanup.error.unconfirmed",
                mutated: false,
                document_cleanup: require_document_settled,
            }
        } else {
            CleanupRetryResult::Cancelled {
                mutated: false,
                document_cleanup: require_document_settled,
            }
        };
    };
    if snapshot.cleanup_unavailable {
        return if still_live() {
            CleanupRetryResult::Failed {
                key: "missions.cleanup.error.unconfirmed",
                mutated: false,
                document_cleanup: require_document_settled,
            }
        } else {
            CleanupRetryResult::Cancelled {
                mutated: false,
                document_cleanup: require_document_settled,
            }
        };
    }
    let Some(fresh) = snapshot
        .cleanups
        .iter()
        .find(|item| item.matches_saved(&saved))
    else {
        return if still_live() {
            CleanupRetryResult::Failed {
                key: "missions.cleanup.error.unconfirmed",
                mutated: false,
                document_cleanup: require_document_settled,
            }
        } else {
            CleanupRetryResult::Cancelled {
                mutated: false,
                document_cleanup: require_document_settled,
            }
        };
    };
    if fresh.document_pending == Some(true) {
        require_document_settled = true;
    }
    if !fresh.is_pending() {
        if !still_live() {
            return CleanupRetryResult::Cancelled {
                mutated: false,
                document_cleanup: require_document_settled,
            };
        }
        return if cleanup_settled_for(require_document_settled, fresh) {
            CleanupRetryResult::Settled {
                receipt: Box::new(fresh.clone()),
                mutated: false,
                document_cleanup: require_document_settled,
            }
        } else {
            CleanupRetryResult::Failed {
                key: "missions.cleanup.error.unconfirmed",
                mutated: false,
                document_cleanup: require_document_settled,
            }
        };
    }
    if !still_live() {
        return CleanupRetryResult::Cancelled {
            mutated: false,
            document_cleanup: require_document_settled,
        };
    }
    let Ok(request) = DeletionRequest::from_cleanup(fresh) else {
        return CleanupRetryResult::Failed {
            key: "missions.cleanup.error.unconfirmed",
            mutated: false,
            document_cleanup: require_document_settled,
        };
    };
    let outcome = backend
        .delete_mission(
            &fresh.mission_id,
            &request,
            Some(&fresh.deletion_id),
            require_document_settled,
        )
        .await
        .unwrap_or(DeletionOutcome::Unconfirmed);
    if let DeletionOutcome::Deleted(Some(receipt)) = outcome {
        return CleanupRetryResult::Settled {
            receipt,
            mutated: true,
            document_cleanup: require_document_settled,
        };
    }
    if !still_live() {
        return CleanupRetryResult::Cancelled {
            mutated: true,
            document_cleanup: require_document_settled,
        };
    }
    if matches!(outcome, DeletionOutcome::Failed(err) if err.status == 409)
        && let Ok(after) = backend
            .read_mission_reconciliation(&project, &saved.mission_id)
            .await
    {
        if !still_live() {
            return CleanupRetryResult::Cancelled {
                mutated: true,
                document_cleanup: require_document_settled,
            };
        }
        if !after.cleanup_unavailable
            && let Some(intent) = after
                .cleanups
                .iter()
                .find(|item| item.matches_saved(&saved))
        {
            if intent.document_pending == Some(true) {
                require_document_settled = true;
            }
            if cleanup_settled_for(require_document_settled, intent) {
                return CleanupRetryResult::Settled {
                    receipt: Box::new(intent.clone()),
                    mutated: true,
                    document_cleanup: require_document_settled,
                };
            }
        }
    }
    if !still_live() {
        return CleanupRetryResult::Cancelled {
            mutated: true,
            document_cleanup: require_document_settled,
        };
    }
    CleanupRetryResult::Failed {
        key: outcome.error_key(),
        mutated: true,
        document_cleanup: require_document_settled,
    }
}

#[cfg(test)]
mod tests;
