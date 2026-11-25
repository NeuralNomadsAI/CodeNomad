use super::{
    CAPACITY, CleanupKey, CleanupOwner, CleanupRetry, DOCUMENT_CLEANUP_CAP, DeleteIntent,
    DeleteState, LiveFlag, PHASE_CANCELLED, PHASE_DISPATCHED, PHASE_PREFLIGHT, WorkspaceScope,
    runner::{
        WireCleanupMatch, cleanup_settled_for, group_cleanups_by_mission, match_wire_cleanup_refs,
        run_cleanup_retry, run_delete,
    },
};
use crate::missions::lifecycle::{MissionKey, Source};
use crate::platform;
use codenomad_client::{
    Wake,
    backend::Backend,
    bounded,
    missions::{Cleanup, DeletionRequest},
};
use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
};

impl CleanupOwner {
    pub fn state_gen(&self) -> u64 {
        self.state_gen
    }

    pub(super) fn bump_state(&mut self) {
        self.state_gen = self.state_gen.wrapping_add(1);
    }

    pub(super) fn record_document_cleanup(&mut self, key: CleanupKey) {
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

    pub(super) fn forget_document_cleanup(&mut self, key: &CleanupKey) {
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
                let state = phase.load(Ordering::Acquire);
                state == PHASE_DISPATCHED
                    || (state == PHASE_PREFLIGHT
                        && intent.flight_live.as_ref().is_none_or(LiveFlag::is_live))
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
                    let state = phase.load(Ordering::Acquire);
                    state == PHASE_DISPATCHED
                        || (state == PHASE_PREFLIGHT
                            && intent.flight_live.as_ref().is_none_or(LiveFlag::is_live))
                })
        })
    }

    pub(super) fn release_revoked_preflights(&mut self) -> bool {
        let mut released = false;
        self.retries.retain(|_, retry| {
            let revoked = retry.retired
                || retry.phase.load(Ordering::Acquire) == PHASE_CANCELLED
                || !retry.view_live.is_live()
                || !retry.row_live.is_live();
            if !revoked {
                return true;
            }
            if retry.phase.load(Ordering::Acquire) == PHASE_CANCELLED
                || retry
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
                    .flight_phase
                    .as_ref()
                    .is_some_and(|p| p.load(Ordering::Acquire) == PHASE_CANCELLED)
                || intent
                    .flight_live
                    .as_ref()
                    .is_some_and(|flag| !flag.is_live());
            if !revoked {
                continue;
            }
            if let Some(phase) = intent.flight_phase.as_ref()
                && (phase.load(Ordering::Acquire) == PHASE_CANCELLED
                    || phase
                        .compare_exchange(
                            PHASE_PREFLIGHT,
                            PHASE_CANCELLED,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok())
            {
                if let Some(cancel) = intent.flight_cancel.take() {
                    cancel.close();
                }
                intent.flight = None;
                intent.flight_live = None;
                intent.flight_phase = None;
                released = true;
            } else if let Some(cancel) = intent.flight_cancel.take() {
                // Already dispatched DELETE: close cancel so any post-DELETE reconciliation GET
                // aborts immediately while keeping the intent until the flight reports.
                cancel.close();
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
        live: LiveFlag,
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
        let (cancel_tx, cancel_rx) = bounded(1);
        let phase = Arc::new(AtomicU8::new(PHASE_DISPATCHED));
        if !live.register(phase.clone(), cancel_rx.clone()) {
            return;
        }
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
                flight_live: Some(live.clone()),
                flight_cancel: Some(cancel_rx),
                flight_phase: Some(phase.clone()),
                error: None,
                document_cleanup: false,
                deletion_id: None,
                created_at_bits: None,
                retired: false,
            },
        );
        self.bump_state();
        platform::spawn(async move {
            let result = run_delete(
                backend,
                target,
                request,
                false,
                false,
                None,
                None,
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

    pub fn retry_delete(
        &mut self,
        source: &Source,
        expected_request_id: &str,
        live: LiveFlag,
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
        live: LiveFlag,
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
        live: LiveFlag,
        backend: Backend,
        wake: Wake,
    ) {
        let (out, inbox) = bounded(1);
        let (cancel_tx, cancel_rx) = bounded(1);
        let phase = Arc::new(AtomicU8::new(PHASE_PREFLIGHT));
        if !live.register(phase.clone(), cancel_rx.clone()) {
            return;
        }
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
            self.bump_state();
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
            self.bump_state();
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
        self.bump_state();
    }

    pub fn observe_cleanups(&mut self, scope: &WorkspaceScope, cleanups: &[Cleanup]) {
        for row in cleanups {
            if row.document_pending == Some(true) {
                self.record_document_cleanup(CleanupKey::new(scope.clone(), row));
            }
        }
        let has_intents = self.deletes.values().any(|intent| &intent.scope == scope);
        if !has_intents || cleanups.is_empty() {
            return;
        }
        let by_mission = group_cleanups_by_mission(cleanups);
        for intent in self.deletes.values_mut() {
            if &intent.scope != scope {
                continue;
            }
            let Some(rows) = by_mission.get(intent.target.mission.as_str()) else {
                continue;
            };
            if let WireCleanupMatch::Exact(row) = match_wire_cleanup_refs(
                &intent.target.mission,
                &intent.request,
                intent.deletion_id.as_deref(),
                intent.created_at_bits,
                rows,
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
        let has_intents = self.deletes.values().any(|intent| &intent.scope == scope);
        let before_deletes = self.deletes.len();
        if has_intents && !cleanups.is_empty() {
            let by_mission = group_cleanups_by_mission(cleanups);
            self.deletes.retain(|_, intent| {
                if &intent.scope != scope {
                    return true;
                }
                let Some(rows) = by_mission.get(intent.target.mission.as_str()) else {
                    return true;
                };
                let WireCleanupMatch::Exact(row) = match_wire_cleanup_refs(
                    &intent.target.mission,
                    &intent.request,
                    intent.deletion_id.as_deref(),
                    intent.created_at_bits,
                    rows,
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
        }
        let mut mutated = self.deletes.len() != before_deletes;
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
                mutated = true;
            }
        }
        if mutated {
            self.bump_state();
        }
    }

    pub fn cleanup_busy(&self, scope: &WorkspaceScope) -> bool {
        self.retries
            .get(scope)
            .is_some_and(CleanupRetry::is_live_or_dispatched)
    }

    #[cfg(test)]
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
                        let state = phase.load(Ordering::Acquire);
                        state == PHASE_DISPATCHED
                            || (state == PHASE_PREFLIGHT
                                && intent.flight_live.as_ref().is_none_or(LiveFlag::is_live))
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
        view_live: LiveFlag,
        row_live: LiveFlag,
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
        let (cancel_tx, cancel_rx) = bounded(1);
        let phase = Arc::new(AtomicU8::new(PHASE_PREFLIGHT));
        if !view_live.register(phase.clone(), cancel_rx.clone())
            || !row_live.register(phase.clone(), cancel_rx.clone())
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

    pub(super) fn has_document_cleanup_intent(
        &self,
        scope: &WorkspaceScope,
        cleanup: &Cleanup,
    ) -> bool {
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
}
