use super::{
    CAPACITY, CleanupKey, CleanupOwner, CleanupPolled, CleanupRetryResult, DeleteResult,
    runner::cleanup_settled_for,
};

impl CleanupOwner {
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
            let view_revoked = flight_live.as_ref().is_some_and(|flag| !flag.is_live());
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
                    if dispatched && intent.error.is_none() {
                        intent.error = Some("missions.cleanup.error.unconfirmed");
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
                    polled.auth_expired.push(backend);
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
        if polled.changed {
            self.bump_state();
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
            let view_current = view_live.is_live() && row_live.is_live();
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
                    polled.auth_expired.push(backend);
                }
            }
        }
        if polled.changed {
            self.bump_state();
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
        polled.auth_expired.extend(retries.auth_expired);
        polled
    }
}
