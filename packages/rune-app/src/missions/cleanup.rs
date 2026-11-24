use super::lifecycle::{MissionKey, Source};
use crate::platform;
use codenomad_client::{
    Receiver, Sender, Wake,
    backend::Backend,
    bounded,
    missions::{Cleanup, DeletionOutcome, DeletionRequest, LifecycleTarget, ReconciliationOutcome},
    runtime::until_closed,
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
};

const CAPACITY: usize = 64;
const DOCUMENT_CLEANUP_CAP: usize = 2_000;
const PHASE_PREFLIGHT: u8 = 0;
const PHASE_CANCELLED: u8 = 1;
const PHASE_DISPATCHED: u8 = 2;

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

    pub fn identity(&self) -> super::directory::CleanupIdentity {
        (
            self.mission_id.clone(),
            self.deletion_id.clone(),
            self.request_id.clone(),
            self.expected_revision,
            self.delete_managed_sessions,
            self.created_at_bits,
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DeleteState {
    Busy,
    Failed(&'static str),
}

pub(super) enum DeleteResult {
    Deleted {
        receipt: Option<Box<Cleanup>>,
        dispatched: bool,
    },
    Failed {
        key: &'static str,
        dispatched: bool,
        document_cleanup: bool,
        deletion_id: Option<String>,
        created_at_bits: Option<u64>,
        tombstoned: bool,
    },
    Cancelled {
        dispatched: bool,
        document_cleanup: bool,
        deletion_id: Option<String>,
        created_at_bits: Option<u64>,
        tombstoned: bool,
    },
    AuthExpired {
        backend: Backend,
        document_cleanup: bool,
        deletion_id: Option<String>,
        created_at_bits: Option<u64>,
    },
}

pub(super) struct DeleteIntent {
    scope: WorkspaceScope,
    pub(super) title: String,
    target: LifecycleTarget,
    request: DeletionRequest,
    pub(super) flight: Option<Receiver<DeleteResult>>,
    flight_live: Option<Arc<AtomicBool>>,
    flight_cancel: Option<Receiver<()>>,
    flight_phase: Option<Arc<AtomicU8>>,
    pub(super) error: Option<&'static str>,
    document_cleanup: bool,
    deletion_id: Option<String>,
    created_at_bits: Option<u64>,
    retired: bool,
}

impl DeleteIntent {
    pub(super) fn request_id(&self) -> &str {
        &self.request.request_id
    }
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
    AuthExpired {
        backend: Backend,
        document_cleanup: bool,
    },
}

struct CleanupRetry {
    key: CleanupKey,
    view_live: Arc<AtomicBool>,
    row_live: Arc<AtomicBool>,
    cancel: Option<Receiver<()>>,
    phase: Arc<AtomicU8>,
    flight: Receiver<CleanupRetryResult>,
    retired: bool,
}

impl CleanupRetry {
    fn is_live_or_dispatched(&self) -> bool {
        !self.retired
            && (self.phase.load(Ordering::Acquire) == PHASE_DISPATCHED
                || (self.view_live.load(Ordering::Acquire)
                    && self.row_live.load(Ordering::Acquire)))
    }
}

#[derive(Default)]
pub(super) struct CleanupPolled {
    pub refreshed_missions: Vec<(MissionKey, LifecycleTarget)>,
    pub refreshed_scopes: Vec<WorkspaceScope>,
    pub deleted_missions: Vec<(WorkspaceScope, String)>,
    pub settled_cleanups: Vec<(WorkspaceScope, Cleanup)>,
    pub document_pending_rows: Vec<(WorkspaceScope, super::directory::CleanupIdentity)>,
    pub auth_expired: Option<Backend>,
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
            && self.auth_expired.is_none()
    }
}

#[derive(Default)]
pub(super) struct CleanupOwner {
    deletes: HashMap<(WorkspaceScope, MissionKey), DeleteIntent>,
    retries: HashMap<WorkspaceScope, CleanupRetry>,
    retry_errors: HashMap<WorkspaceScope, (String, String, &'static str)>,
    document_cleanups: HashSet<CleanupKey>,
    document_cleanup_order: VecDeque<CleanupKey>,
}

impl CleanupOwner {
    fn record_document_cleanup(&mut self, key: CleanupKey) {
        if self.document_cleanups.contains(&key) {
            return;
        }
        while self.document_cleanups.len() >= DOCUMENT_CLEANUP_CAP {
            let Some(evict) = self.document_cleanup_order.pop_front() else {
                break;
            };
            self.document_cleanups.remove(&evict);
        }
        self.document_cleanup_order.push_back(key.clone());
        self.document_cleanups.insert(key);
    }

    fn forget_document_cleanup(&mut self, key: &CleanupKey) {
        if self.document_cleanups.remove(key) {
            self.document_cleanup_order.retain(|entry| entry != key);
        }
    }
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
        let busy = intent.flight.is_some()
            && intent.flight_phase.as_ref().is_none_or(|phase| {
                phase.load(Ordering::Acquire) == PHASE_DISPATCHED
                    || intent
                        .flight_live
                        .as_ref()
                        .is_none_or(|flag| flag.load(Ordering::Acquire))
            });
        if busy {
            Some(DeleteState::Busy)
        } else {
            intent.error.map(DeleteState::Failed)
        }
    }

    pub fn delete_request_id(&self, source: &Source) -> Option<String> {
        let intent = self
            .deletes
            .get(&(source.workspace_scope(), source.mission.clone()))
            .filter(|intent| intent.target == source.target && !intent.retired)?;
        (intent.flight.is_none() && intent.error.is_some())
            .then(|| intent.request.request_id.clone())
    }

    pub fn has_delete_intents_in_scope(&self, scope: &WorkspaceScope) -> bool {
        self.deletes
            .values()
            .any(|intent| !intent.retired && &intent.scope == scope)
    }

    pub fn has_active_cleanup_retry(&self, scope: &WorkspaceScope, mission_id: &str) -> bool {
        self.retries.get(scope).is_some_and(|retry| {
            retry.is_live_or_dispatched() && retry.key.mission_id == mission_id
        })
    }

    pub fn has_active_delete_flight(&self, scope: &WorkspaceScope, mission_id: &str) -> bool {
        self.deletes.values().any(|intent| {
            !intent.retired
                && &intent.scope == scope
                && intent.target.mission == mission_id
                && intent.flight.is_some()
                && intent.flight_phase.as_ref().is_none_or(|phase| {
                    phase.load(Ordering::Acquire) == PHASE_DISPATCHED
                        || intent
                            .flight_live
                            .as_ref()
                            .is_none_or(|flag| flag.load(Ordering::Acquire))
                })
        })
    }

    fn release_revoked_preflights(&mut self) -> bool {
        let mut released = false;
        self.retries.retain(|_, retry| {
            let revoked = retry.retired
                || !retry.view_live.load(Ordering::Acquire)
                || !retry.row_live.load(Ordering::Acquire);
            if !revoked {
                return true;
            }
            if retry
                .phase
                .compare_exchange(
                    PHASE_PREFLIGHT,
                    PHASE_CANCELLED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                if let Some(cancel) = retry.cancel.take() {
                    cancel.close();
                }
                released = true;
                return false;
            }
            // Already dispatched DELETE: close cancel so any post-409 GET aborts immediately,
            // while keeping the entry until the DELETE flight reports its receipt.
            if let Some(cancel) = retry.cancel.take() {
                cancel.close();
            }
            true
        });
        for intent in self.deletes.values_mut() {
            let revoked = intent.retired
                || intent
                    .flight_live
                    .as_ref()
                    .is_some_and(|flag| !flag.load(Ordering::Acquire));
            if !revoked {
                continue;
            }
            if let Some(phase) = intent.flight_phase.as_ref()
                && phase
                    .compare_exchange(
                        PHASE_PREFLIGHT,
                        PHASE_CANCELLED,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_ok()
            {
                if let Some(cancel) = intent.flight_cancel.take() {
                    cancel.close();
                }
                intent.flight = None;
                intent.flight_live = None;
                intent.flight_phase = None;
                released = true;
            }
        }
        released
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
                flight_live: None,
                flight_cancel: None,
                flight_phase: None,
                error: None,
                document_cleanup: false,
                deletion_id: None,
                created_at_bits: None,
                retired: false,
            },
        );
        platform::spawn(async move {
            let result = run_delete(
                backend, target, request, false, false, None, None, None, None, None,
            )
            .await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    pub fn retry_delete(
        &mut self,
        source: &Source,
        expected_request_id: &str,
        live: Arc<AtomicBool>,
        backend: Backend,
        wake: Wake,
    ) {
        self.release_revoked_preflights();
        let scope = source.workspace_scope();
        if self.has_active_cleanup_retry(&scope, &source.target.mission) {
            return;
        }
        let Some(intent) = self.deletes.get_mut(&(scope, source.mission.clone())) else {
            return;
        };
        if intent.target != source.target
            || intent.request.request_id != expected_request_id
            || intent.flight.is_some()
            || intent.retired
        {
            return;
        }
        Self::dispatch_retry_delete(intent, live, backend, wake);
    }

    pub fn retry_delete_in_scope(
        &mut self,
        scope: &WorkspaceScope,
        mission: &MissionKey,
        expected_request_id: &str,
        live: Arc<AtomicBool>,
        backend: Backend,
        wake: Wake,
    ) {
        self.release_revoked_preflights();
        if self.has_active_cleanup_retry(scope, &mission.id) {
            return;
        }
        let Some(intent) = self.deletes.get_mut(&(scope.clone(), mission.clone())) else {
            return;
        };
        if &intent.scope != scope
            || intent.request.request_id != expected_request_id
            || intent.flight.is_some()
            || intent.retired
        {
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
        let (cancel_tx, cancel_rx) = bounded(1);
        let phase = Arc::new(AtomicU8::new(PHASE_PREFLIGHT));
        let target = intent.target.clone();
        let request = intent.request.clone();
        let document_cleanup = intent.document_cleanup;
        let expected_deletion_id = intent.deletion_id.clone();
        let expected_created_at = intent.created_at_bits;
        intent.flight = Some(inbox);
        intent.flight_live = Some(live.clone());
        intent.flight_cancel = Some(cancel_rx);
        intent.flight_phase = Some(phase.clone());
        platform::spawn(async move {
            let result = run_delete(
                backend,
                target,
                request,
                true,
                document_cleanup,
                expected_deletion_id,
                expected_created_at,
                Some(live),
                Some(cancel_tx),
                Some(phase),
            )
            .await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    pub fn cancel_delete(&mut self, source: &Source, expected_request_id: &str) {
        self.release_revoked_preflights();
        let key = (source.workspace_scope(), source.mission.clone());
        if self.deletes.get(&key).is_some_and(|intent| {
            intent.target == source.target
                && intent.request.request_id == expected_request_id
                && intent.flight.is_none()
        }) {
            self.deletes.remove(&key);
        }
    }

    pub fn cancel_delete_in_scope(
        &mut self,
        scope: &WorkspaceScope,
        mission: &MissionKey,
        expected_request_id: &str,
    ) {
        self.release_revoked_preflights();
        let key = (scope.clone(), mission.clone());
        if self.deletes.get(&key).is_some_and(|intent| {
            &intent.scope == scope
                && intent.request.request_id == expected_request_id
                && intent.flight.is_none()
        }) {
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
        self.release_revoked_preflights();
        self.deletes
            .retain(|(intent_scope, _), intent| intent_scope != scope || intent.flight.is_some());
        self.retry_errors.remove(scope);
        self.document_cleanups.retain(|key| &key.scope != scope);
        self.document_cleanup_order
            .retain(|key| &key.scope != scope);
    }

    pub fn observe_cleanups(&mut self, scope: &WorkspaceScope, cleanups: &[Cleanup]) {
        for row in cleanups {
            if row.document_pending == Some(true) {
                self.record_document_cleanup(CleanupKey::new(scope.clone(), row));
            }
        }
        for intent in self.deletes.values_mut() {
            if &intent.scope != scope {
                continue;
            }
            if let WireCleanupMatch::Exact(row) = match_wire_cleanup(
                &intent.target.mission,
                &intent.request,
                intent.deletion_id.as_deref(),
                intent.created_at_bits,
                cleanups,
            ) && row.document_pending == Some(true)
            {
                intent.document_cleanup = true;
            }
        }
    }

    pub fn retire_settled_cleanups(
        &mut self,
        scope: &WorkspaceScope,
        cleanups: &[Cleanup],
        covered: bool,
    ) {
        for row in cleanups {
            if row.document_pending == Some(false) {
                self.forget_document_cleanup(&CleanupKey::new(scope.clone(), row));
            } else if row.document_pending == Some(true) {
                self.record_document_cleanup(CleanupKey::new(scope.clone(), row));
            }
        }
        self.deletes.retain(|_, intent| {
            if &intent.scope != scope {
                return true;
            }
            let WireCleanupMatch::Exact(row) = match_wire_cleanup(
                &intent.target.mission,
                &intent.request,
                intent.deletion_id.as_deref(),
                intent.created_at_bits,
                cleanups,
            ) else {
                return true;
            };
            if row.document_pending == Some(true) {
                intent.document_cleanup = true;
            }
            if intent.flight.is_some() {
                return true;
            }
            if intent.deletion_id.is_none() {
                intent.deletion_id = Some(row.deletion_id.clone());
            }
            if intent.created_at_bits.is_none() {
                intent.created_at_bits = Some(row.created_at.to_bits());
            }
            !cleanup_settled_for(intent.document_cleanup, row)
        });
        if let Some((mission_id, deletion_id, _)) = self.retry_errors.get(scope) {
            let matching = cleanups
                .iter()
                .find(|row| &row.mission_id == mission_id && &row.deletion_id == deletion_id);
            let clear = match matching {
                Some(row) => !row.is_pending(),
                None => covered,
            };
            if clear {
                self.retry_errors.remove(scope);
            }
        }
    }

    pub fn cleanup_busy(&self, scope: &WorkspaceScope) -> bool {
        self.retries
            .get(scope)
            .is_some_and(CleanupRetry::is_live_or_dispatched)
    }

    pub fn cleanup_retrying(&self, key: &CleanupKey) -> bool {
        self.retries
            .get(&key.scope)
            .is_some_and(|retry| retry.is_live_or_dispatched() && &retry.key == key)
    }

    pub fn active_cleanup_retry_key(&self, scope: &WorkspaceScope) -> Option<CleanupKey> {
        self.retries
            .get(scope)
            .filter(|retry| retry.is_live_or_dispatched())
            .map(|retry| retry.key.clone())
    }

    pub fn active_delete_mission_ids(&self, scope: &WorkspaceScope) -> HashSet<String> {
        self.deletes
            .values()
            .filter(|intent| {
                !intent.retired
                    && &intent.scope == scope
                    && intent.flight.is_some()
                    && intent.flight_phase.as_ref().is_none_or(|phase| {
                        phase.load(Ordering::Acquire) == PHASE_DISPATCHED
                            || intent
                                .flight_live
                                .as_ref()
                                .is_none_or(|flag| flag.load(Ordering::Acquire))
                    })
            })
            .map(|intent| intent.target.mission.clone())
            .collect()
    }

    #[cfg(test)]
    pub fn current_delete_request_id(
        &self,
        scope: &WorkspaceScope,
        mission: &MissionKey,
    ) -> Option<String> {
        self.deletes
            .get(&(scope.clone(), mission.clone()))
            .map(|intent| intent.request.request_id.clone())
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
        self.release_revoked_preflights();
        if !cleanup.is_pending()
            || self.retries.contains_key(&scope)
            || self.retries.len() >= CAPACITY
            || self.has_active_delete_flight(&scope, &cleanup.mission_id)
        {
            return;
        }
        self.retry_errors.remove(&scope);
        let key = CleanupKey::new(scope.clone(), &cleanup);
        let require_document_settled = cleanup.document_pending == Some(true)
            || self.document_cleanups.contains(&key)
            || self.has_document_cleanup_intent(&scope, &cleanup);
        let project = scope.project.clone();
        let (out, inbox) = bounded(1);
        let (cancel_tx, cancel_rx) = bounded(1);
        let phase = Arc::new(AtomicU8::new(PHASE_PREFLIGHT));
        self.retries.insert(
            scope,
            CleanupRetry {
                key,
                view_live: view_live.clone(),
                row_live: row_live.clone(),
                cancel: Some(cancel_rx),
                phase: phase.clone(),
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
                cancel_tx,
                phase,
            )
            .await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    fn has_document_cleanup_intent(&self, scope: &WorkspaceScope, cleanup: &Cleanup) -> bool {
        self.deletes.values().any(|intent| {
            intent.document_cleanup
                && intent.scope == *scope
                && intent.target.mission == cleanup.mission_id
                && intent.request.request_id == cleanup.request_id
                && intent.request.expected_revision == cleanup.expected_revision
                && intent.request.delete_managed_sessions == cleanup.delete_managed_sessions
                && intent
                    .deletion_id
                    .as_deref()
                    .is_none_or(|id| id == cleanup.deletion_id)
                && intent
                    .created_at_bits
                    .is_none_or(|bits| bits == cleanup.created_at.to_bits())
        })
    }

    pub fn poll_deletes(&mut self) -> CleanupPolled {
        let mut polled = CleanupPolled::default();
        polled.changed |= self.release_revoked_preflights();
        let mut learned_doc_cleanups = Vec::new();
        self.deletes.retain(|(_, mission), intent| {
            let Some(result) = intent
                .flight
                .as_ref()
                .and_then(|inbox| inbox.try_recv().ok())
            else {
                return true;
            };
            intent.flight = None;
            let flight_live = intent.flight_live.take();
            intent.flight_cancel = None;
            intent.flight_phase = None;
            polled.changed = true;
            if intent.retired {
                return false;
            }
            let view_revoked = flight_live
                .as_ref()
                .is_some_and(|flag| !flag.load(Ordering::Acquire));
            match result {
                DeleteResult::Deleted {
                    receipt,
                    dispatched,
                } => {
                    if !dispatched && view_revoked {
                        return true;
                    }
                    if intent.document_cleanup
                        && receipt
                            .as_deref()
                            .is_none_or(|r| !cleanup_settled_for(true, r))
                    {
                        intent.error = Some("missions.cleanup.error.unconfirmed");
                        polled
                            .refreshed_missions
                            .push((mission.clone(), intent.target.clone()));
                        if !polled.refreshed_scopes.contains(&intent.scope) {
                            polled.refreshed_scopes.push(intent.scope.clone());
                        }
                        return true;
                    }
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
                    dispatched,
                    document_cleanup,
                    deletion_id,
                    created_at_bits,
                    tombstoned,
                } => {
                    if !dispatched && view_revoked {
                        return true;
                    }
                    intent.error = Some(key);
                    intent.document_cleanup |= document_cleanup;
                    if intent.deletion_id.is_none() {
                        intent.deletion_id = deletion_id;
                    }
                    if intent.created_at_bits.is_none() {
                        intent.created_at_bits = created_at_bits;
                    }
                    if intent.document_cleanup
                        && let (Some(del_id), Some(ts_bits)) =
                            (intent.deletion_id.as_ref(), intent.created_at_bits)
                    {
                        learned_doc_cleanups.push(CleanupKey {
                            scope: intent.scope.clone(),
                            mission_id: intent.target.mission.clone(),
                            deletion_id: del_id.clone(),
                            request_id: intent.request.request_id.clone(),
                            expected_revision: intent.request.expected_revision,
                            delete_managed_sessions: intent.request.delete_managed_sessions,
                            created_at_bits: ts_bits,
                        });
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
                    created_at_bits,
                    tombstoned,
                } => {
                    if !dispatched && view_revoked {
                        return true;
                    }
                    intent.document_cleanup |= document_cleanup;
                    if intent.deletion_id.is_none() {
                        intent.deletion_id = deletion_id;
                    }
                    if intent.created_at_bits.is_none() {
                        intent.created_at_bits = created_at_bits;
                    }
                    if intent.document_cleanup
                        && let (Some(del_id), Some(ts_bits)) =
                            (intent.deletion_id.as_ref(), intent.created_at_bits)
                    {
                        learned_doc_cleanups.push(CleanupKey {
                            scope: intent.scope.clone(),
                            mission_id: intent.target.mission.clone(),
                            deletion_id: del_id.clone(),
                            request_id: intent.request.request_id.clone(),
                            expected_revision: intent.request.expected_revision,
                            delete_managed_sessions: intent.request.delete_managed_sessions,
                            created_at_bits: ts_bits,
                        });
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
                DeleteResult::AuthExpired {
                    backend,
                    document_cleanup,
                    deletion_id,
                    created_at_bits,
                } => {
                    intent.error = Some("missions.cleanup.error.unconfirmed");
                    intent.document_cleanup |= document_cleanup;
                    if intent.deletion_id.is_none() {
                        intent.deletion_id = deletion_id;
                    }
                    if intent.created_at_bits.is_none() {
                        intent.created_at_bits = created_at_bits;
                    }
                    if intent.document_cleanup
                        && let (Some(del_id), Some(ts_bits)) =
                            (intent.deletion_id.as_ref(), intent.created_at_bits)
                    {
                        learned_doc_cleanups.push(CleanupKey {
                            scope: intent.scope.clone(),
                            mission_id: intent.target.mission.clone(),
                            deletion_id: del_id.clone(),
                            request_id: intent.request.request_id.clone(),
                            expected_revision: intent.request.expected_revision,
                            delete_managed_sessions: intent.request.delete_managed_sessions,
                            created_at_bits: ts_bits,
                        });
                    }
                    if polled.auth_expired.is_none() {
                        polled.auth_expired = Some(backend);
                    }
                    true
                }
            }
        });
        for key in learned_doc_cleanups {
            polled.document_pending_rows.push((
                key.scope.clone(),
                (
                    key.mission_id.clone(),
                    key.deletion_id.clone(),
                    key.request_id.clone(),
                    key.expected_revision,
                    key.delete_managed_sessions,
                    key.created_at_bits,
                ),
            ));
            self.record_document_cleanup(key);
        }
        polled
    }

    pub fn poll_retries(&mut self) -> CleanupPolled {
        let mut polled = CleanupPolled::default();
        polled.changed |= self.release_revoked_preflights();
        let mut finished_retries = Vec::new();
        for (scope, retry) in &self.retries {
            if let Ok(result) = retry.flight.try_recv() {
                finished_retries.push((
                    scope.clone(),
                    retry.key.clone(),
                    retry.view_live.clone(),
                    retry.row_live.clone(),
                    retry.retired,
                    result,
                ));
            }
        }
        for (scope, retry_key, view_live, row_live, retired, result) in finished_retries {
            self.retries.remove(&scope);
            polled.changed = true;
            if retired {
                continue;
            }
            let view_current =
                view_live.load(Ordering::Acquire) && row_live.load(Ordering::Acquire);
            let record_doc = |owner: &mut Self, polled: &mut CleanupPolled, key: &CleanupKey| {
                owner.record_document_cleanup(key.clone());
                polled
                    .document_pending_rows
                    .push((key.scope.clone(), key.identity()));
            };
            match result {
                CleanupRetryResult::Settled {
                    receipt,
                    mutated,
                    document_cleanup,
                } => {
                    if !view_current && !mutated {
                        continue;
                    }
                    let require_doc = document_cleanup
                        || self.document_cleanups.contains(&retry_key)
                        || self.has_document_cleanup_intent(&scope, &receipt);
                    if require_doc && !cleanup_settled_for(true, &receipt) {
                        record_doc(self, &mut polled, &retry_key);
                        if view_current {
                            if !self.retry_errors.contains_key(&scope)
                                && self.retry_errors.len() >= CAPACITY
                                && let Some(evict) = self.retry_errors.keys().next().cloned()
                            {
                                self.retry_errors.remove(&evict);
                            }
                            self.retry_errors.insert(
                                scope.clone(),
                                (
                                    retry_key.mission_id,
                                    retry_key.deletion_id,
                                    "missions.cleanup.error.unconfirmed",
                                ),
                            );
                            if !polled.refreshed_scopes.contains(&scope) {
                                polled.refreshed_scopes.push(scope);
                            }
                        }
                        continue;
                    }
                    if receipt.document_pending == Some(false) {
                        self.forget_document_cleanup(&CleanupKey::new(scope.clone(), &receipt));
                    } else if document_cleanup {
                        record_doc(self, &mut polled, &retry_key);
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
                                .is_none_or(|id| id == receipt.deletion_id)
                            && intent
                                .created_at_bits
                                .is_none_or(|bits| bits == receipt.created_at.to_bits());
                        if matches {
                            intent.document_cleanup |= document_cleanup;
                            if intent.deletion_id.is_none() {
                                intent.deletion_id = Some(receipt.deletion_id.clone());
                            }
                            if intent.created_at_bits.is_none() {
                                intent.created_at_bits = Some(receipt.created_at.to_bits());
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
                    if document_cleanup && (view_current || mutated) {
                        record_doc(self, &mut polled, &retry_key);
                    }
                    if view_current {
                        if !self.retry_errors.contains_key(&scope)
                            && self.retry_errors.len() >= CAPACITY
                            && let Some(evict) = self.retry_errors.keys().next().cloned()
                        {
                            self.retry_errors.remove(&evict);
                        }
                        self.retry_errors.insert(
                            scope.clone(),
                            (retry_key.mission_id, retry_key.deletion_id, key),
                        );
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
                    if document_cleanup && mutated {
                        record_doc(self, &mut polled, &retry_key);
                    }
                    if mutated && !polled.refreshed_scopes.contains(&scope) {
                        polled.refreshed_scopes.push(scope);
                    }
                }
                CleanupRetryResult::AuthExpired {
                    backend,
                    document_cleanup,
                } => {
                    if document_cleanup {
                        record_doc(self, &mut polled, &retry_key);
                    }
                    if polled.auth_expired.is_none() {
                        polled.auth_expired = Some(backend);
                    }
                }
            }
        }
        polled
    }

    #[cfg(test)]
    pub fn poll(&mut self) -> CleanupPolled {
        let mut polled = self.poll_deletes();
        let retries = self.poll_retries();
        polled.changed |= retries.changed;
        polled.refreshed_missions.extend(retries.refreshed_missions);
        for scope in retries.refreshed_scopes {
            if !polled.refreshed_scopes.contains(&scope) {
                polled.refreshed_scopes.push(scope);
            }
        }
        polled.deleted_missions.extend(retries.deleted_missions);
        polled.settled_cleanups.extend(retries.settled_cleanups);
        polled
            .document_pending_rows
            .extend(retries.document_pending_rows);
        if polled.auth_expired.is_none() {
            polled.auth_expired = retries.auth_expired;
        }
        polled
    }
}

enum WireCleanupMatch<'a> {
    None,
    Ambiguous,
    Mismatch,
    Exact(&'a Cleanup),
}

fn match_wire_cleanup<'a>(
    mission_id: &str,
    request: &DeletionRequest,
    expected_deletion_id: Option<&str>,
    expected_created_at: Option<u64>,
    cleanups: &'a [Cleanup],
) -> WireCleanupMatch<'a> {
    let mut matched: Option<&'a Cleanup> = None;
    for row in cleanups {
        if !request.matches_cleanup(mission_id, row) {
            continue;
        }
        if matched.is_some() {
            return WireCleanupMatch::Ambiguous;
        }
        matched = Some(row);
    }
    let Some(row) = matched else {
        return WireCleanupMatch::None;
    };
    if expected_deletion_id.is_some_and(|id| row.deletion_id != id)
        || expected_created_at.is_some_and(|bits| row.created_at.to_bits() != bits)
    {
        return WireCleanupMatch::Mismatch;
    }
    WireCleanupMatch::Exact(row)
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
    mut expected_created_at: Option<u64>,
    live: Option<Arc<AtomicBool>>,
    cancel: Option<Sender<()>>,
    phase: Option<Arc<AtomicU8>>,
) -> DeleteResult {
    let still_live = || {
        live.as_ref()
            .is_none_or(|flag| flag.load(Ordering::Acquire))
    };
    let mut tombstoned = false;
    if reconcile_first {
        let preflight = if let Some(cancel) = cancel.as_ref() {
            match until_closed(
                cancel,
                backend.read_mission_reconciliation(&target.project, &target.mission),
            )
            .await
            {
                Some(result) => result,
                None => {
                    return DeleteResult::Cancelled {
                        dispatched: false,
                        document_cleanup: require_document_settled,
                        deletion_id: expected_deletion_id,
                        created_at_bits: expected_created_at,
                        tombstoned,
                    };
                }
            }
        } else {
            backend
                .read_mission_reconciliation(&target.project, &target.mission)
                .await
        };
        let snapshot = match preflight {
            Ok(ReconciliationOutcome::Snapshot(snapshot)) => snapshot,
            Ok(ReconciliationOutcome::AuthenticationRequired) => {
                return DeleteResult::AuthExpired {
                    backend,
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    created_at_bits: expected_created_at,
                };
            }
            Err(_) => {
                return if still_live() {
                    DeleteResult::Failed {
                        key: "missions.cleanup.error.unconfirmed",
                        dispatched: false,
                        document_cleanup: require_document_settled,
                        deletion_id: expected_deletion_id,
                        created_at_bits: expected_created_at,
                        tombstoned,
                    }
                } else {
                    DeleteResult::Cancelled {
                        dispatched: false,
                        document_cleanup: require_document_settled,
                        deletion_id: expected_deletion_id,
                        created_at_bits: expected_created_at,
                        tombstoned,
                    }
                };
            }
        };
        if snapshot.cleanup_unavailable {
            return if still_live() {
                DeleteResult::Failed {
                    key: "missions.cleanup.error.unconfirmed",
                    dispatched: false,
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    created_at_bits: expected_created_at,
                    tombstoned,
                }
            } else {
                DeleteResult::Cancelled {
                    dispatched: false,
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    created_at_bits: expected_created_at,
                    tombstoned,
                }
            };
        }
        let matching = match match_wire_cleanup(
            &target.mission,
            &request,
            expected_deletion_id.as_deref(),
            expected_created_at,
            &snapshot.cleanups,
        ) {
            WireCleanupMatch::Ambiguous | WireCleanupMatch::Mismatch => {
                return if still_live() {
                    DeleteResult::Failed {
                        key: "missions.cleanup.error.unconfirmed",
                        dispatched: false,
                        document_cleanup: require_document_settled,
                        deletion_id: expected_deletion_id,
                        created_at_bits: expected_created_at,
                        tombstoned: false,
                    }
                } else {
                    DeleteResult::Cancelled {
                        dispatched: false,
                        document_cleanup: require_document_settled,
                        deletion_id: expected_deletion_id,
                        created_at_bits: expected_created_at,
                        tombstoned: false,
                    }
                };
            }
            WireCleanupMatch::None => {
                if expected_deletion_id.is_some() && snapshot.mission_revision.is_some() {
                    return if still_live() {
                        DeleteResult::Failed {
                            key: "missions.cleanup.error.unconfirmed",
                            dispatched: false,
                            document_cleanup: require_document_settled,
                            deletion_id: expected_deletion_id,
                            created_at_bits: expected_created_at,
                            tombstoned: false,
                        }
                    } else {
                        DeleteResult::Cancelled {
                            dispatched: false,
                            document_cleanup: require_document_settled,
                            deletion_id: expected_deletion_id,
                            created_at_bits: expected_created_at,
                            tombstoned: false,
                        }
                    };
                }
                None
            }
            WireCleanupMatch::Exact(row) => Some(row),
        };
        if let Some(intent) = matching {
            if !still_live() {
                return DeleteResult::Cancelled {
                    dispatched: false,
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    created_at_bits: expected_created_at,
                    tombstoned: false,
                };
            }
            if snapshot.mission_revision.is_none() {
                tombstoned = true;
            }
            if intent.document_pending == Some(true) {
                require_document_settled = true;
            }
            if expected_deletion_id.is_none() {
                expected_deletion_id = Some(intent.deletion_id.clone());
            }
            if expected_created_at.is_none() {
                expected_created_at = Some(intent.created_at.to_bits());
            }
            if !intent.is_pending() {
                return if cleanup_settled_for(require_document_settled, intent) {
                    DeleteResult::Deleted {
                        receipt: Some(Box::new(intent.clone())),
                        dispatched: false,
                    }
                } else {
                    DeleteResult::Failed {
                        key: "missions.cleanup.error.unconfirmed",
                        dispatched: false,
                        document_cleanup: require_document_settled,
                        deletion_id: expected_deletion_id,
                        created_at_bits: expected_created_at,
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
                    dispatched: false,
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    created_at_bits: expected_created_at,
                    tombstoned,
                }
            } else {
                DeleteResult::Cancelled {
                    dispatched: false,
                    document_cleanup: require_document_settled,
                    deletion_id: expected_deletion_id,
                    created_at_bits: expected_created_at,
                    tombstoned,
                }
            };
        }
        if !still_live()
            || phase.as_ref().is_some_and(|p| {
                p.compare_exchange(
                    PHASE_PREFLIGHT,
                    PHASE_DISPATCHED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_err()
            })
        {
            return DeleteResult::Cancelled {
                dispatched: false,
                document_cleanup: require_document_settled,
                deletion_id: expected_deletion_id,
                created_at_bits: expected_created_at,
                tombstoned: false,
            };
        }
    }
    let outcome = backend
        .delete_mission(
            &target.mission,
            &request,
            expected_deletion_id.as_deref(),
            expected_created_at.map(f64::from_bits),
            require_document_settled,
        )
        .await
        .unwrap_or(DeletionOutcome::Unconfirmed);
    if matches!(outcome, DeletionOutcome::AuthenticationRequired) {
        return DeleteResult::AuthExpired {
            backend,
            document_cleanup: require_document_settled,
            deletion_id: expected_deletion_id,
            created_at_bits: expected_created_at,
        };
    }
    if let DeletionOutcome::Deleted(receipt) = outcome {
        return DeleteResult::Deleted {
            receipt,
            dispatched: true,
        };
    }
    if live.is_some() && !still_live() {
        return DeleteResult::Cancelled {
            dispatched: true,
            document_cleanup: require_document_settled,
            deletion_id: expected_deletion_id,
            created_at_bits: expected_created_at,
            tombstoned,
        };
    }
    let mut key = outcome.error_key();
    let conflict = matches!(
        outcome,
        DeletionOutcome::Failed(err) if err.status == 409
    );
    match backend
        .read_mission_reconciliation(&target.project, &target.mission)
        .await
    {
        Ok(ReconciliationOutcome::Snapshot(snapshot)) if !snapshot.cleanup_unavailable => {
            match match_wire_cleanup(
                &target.mission,
                &request,
                expected_deletion_id.as_deref(),
                expected_created_at,
                &snapshot.cleanups,
            ) {
                WireCleanupMatch::Ambiguous | WireCleanupMatch::Mismatch => {
                    key = "missions.cleanup.error.unconfirmed";
                }
                WireCleanupMatch::Exact(intent) => {
                    if snapshot.mission_revision.is_none() {
                        tombstoned = true;
                    }
                    if expected_deletion_id.is_none() {
                        expected_deletion_id = Some(intent.deletion_id.clone());
                    }
                    if expected_created_at.is_none() {
                        expected_created_at = Some(intent.created_at.to_bits());
                    }
                    if intent.document_pending == Some(true) {
                        require_document_settled = true;
                    }
                    if cleanup_settled_for(require_document_settled, intent) {
                        return DeleteResult::Deleted {
                            receipt: Some(Box::new(intent.clone())),
                            dispatched: true,
                        };
                    }
                    if !conflict {
                        key = if intent.document_pending == Some(true) {
                            "missions.cleanup.documentPending"
                        } else {
                            "missions.cleanup.error.pending"
                        };
                    }
                }
                WireCleanupMatch::None => {}
            }
        }
        Ok(ReconciliationOutcome::AuthenticationRequired) => {
            return DeleteResult::AuthExpired {
                backend,
                document_cleanup: require_document_settled,
                deletion_id: expected_deletion_id,
                created_at_bits: expected_created_at,
            };
        }
        _ => {}
    }
    if live.is_some() && !still_live() {
        return DeleteResult::Cancelled {
            dispatched: true,
            document_cleanup: require_document_settled,
            deletion_id: expected_deletion_id,
            created_at_bits: expected_created_at,
            tombstoned,
        };
    }
    DeleteResult::Failed {
        key,
        dispatched: true,
        document_cleanup: require_document_settled,
        deletion_id: expected_deletion_id,
        created_at_bits: expected_created_at,
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
    cancel: Sender<()>,
    phase: Arc<AtomicU8>,
) -> CleanupRetryResult {
    let still_live = || view_live.load(Ordering::Acquire) && row_live.load(Ordering::Acquire);
    let Some(preflight) = until_closed(
        &cancel,
        backend.read_mission_reconciliation(&project, &saved.mission_id),
    )
    .await
    else {
        return CleanupRetryResult::Cancelled {
            mutated: false,
            document_cleanup: require_document_settled,
        };
    };
    let snapshot = match preflight {
        Ok(ReconciliationOutcome::Snapshot(snapshot)) => snapshot,
        Ok(ReconciliationOutcome::AuthenticationRequired) => {
            return CleanupRetryResult::AuthExpired {
                backend,
                document_cleanup: require_document_settled,
            };
        }
        Err(_) => {
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
    let Ok(saved_request) = DeletionRequest::from_cleanup(&saved) else {
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
    let ambiguous_preflight = snapshot
        .cleanups
        .iter()
        .filter(|item| saved_request.matches_cleanup(&saved.mission_id, item))
        .count()
        > 1;
    let Some(fresh) = (!ambiguous_preflight)
        .then(|| {
            snapshot
                .cleanups
                .iter()
                .find(|item| item.matches_saved(&saved))
        })
        .flatten()
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
    if !still_live()
        || phase
            .compare_exchange(
                PHASE_PREFLIGHT,
                PHASE_DISPATCHED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
    {
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
            Some(fresh.created_at),
            require_document_settled,
        )
        .await
        .unwrap_or(DeletionOutcome::Unconfirmed);
    if matches!(outcome, DeletionOutcome::AuthenticationRequired) {
        return CleanupRetryResult::AuthExpired {
            backend,
            document_cleanup: require_document_settled,
        };
    }
    if let DeletionOutcome::Deleted(Some(ref receipt)) = outcome
        && receipt.matches_saved(&saved)
    {
        return CleanupRetryResult::Settled {
            receipt: receipt.clone(),
            mutated: true,
            document_cleanup: require_document_settled,
        };
    }
    let conflict_409 = matches!(outcome, DeletionOutcome::Failed(err) if err.status == 409);
    let mutated = !conflict_409;
    if !still_live() {
        return CleanupRetryResult::Cancelled {
            mutated,
            document_cleanup: require_document_settled,
        };
    }
    if conflict_409 {
        let Some(post_409) = until_closed(
            &cancel,
            backend.read_mission_reconciliation(&project, &saved.mission_id),
        )
        .await
        else {
            return CleanupRetryResult::Cancelled {
                mutated: false,
                document_cleanup: require_document_settled,
            };
        };
        match post_409 {
            Ok(ReconciliationOutcome::Snapshot(after)) => {
                if !still_live() {
                    return CleanupRetryResult::Cancelled {
                        mutated: false,
                        document_cleanup: require_document_settled,
                    };
                }
                let ambiguous_after = after
                    .cleanups
                    .iter()
                    .filter(|item| saved_request.matches_cleanup(&saved.mission_id, item))
                    .count()
                    > 1;
                if !after.cleanup_unavailable
                    && !ambiguous_after
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
                            mutated: false,
                            document_cleanup: require_document_settled,
                        };
                    }
                }
            }
            Ok(ReconciliationOutcome::AuthenticationRequired) => {
                return CleanupRetryResult::AuthExpired {
                    backend,
                    document_cleanup: require_document_settled,
                };
            }
            Err(_) => {}
        }
    }
    if !still_live() {
        return CleanupRetryResult::Cancelled {
            mutated,
            document_cleanup: require_document_settled,
        };
    }
    CleanupRetryResult::Failed {
        key: outcome.error_key(),
        mutated,
        document_cleanup: require_document_settled,
    }
}

#[cfg(test)]
mod tests;
