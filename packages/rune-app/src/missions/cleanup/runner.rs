use super::{CleanupRetryResult, DeleteResult, LiveFlag, PHASE_DISPATCHED, PHASE_PREFLIGHT};
use codenomad_client::{
    Sender,
    backend::Backend,
    missions::{Cleanup, DeletionOutcome, DeletionRequest, LifecycleTarget, ReconciliationOutcome},
    runtime::until_closed,
};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
};

pub(super) enum WireCleanupMatch<'a> {
    None,
    Ambiguous,
    Mismatch,
    Exact(&'a Cleanup),
}

pub(super) fn group_cleanups_by_mission<'a>(
    cleanups: &'a [Cleanup],
) -> HashMap<&'a str, Vec<&'a Cleanup>> {
    let mut grouped: HashMap<&'a str, Vec<&'a Cleanup>> = HashMap::new();
    for row in cleanups {
        grouped
            .entry(row.mission_id.as_str())
            .or_default()
            .push(row);
    }
    grouped
}

fn match_wire_cleanup<'a>(
    mission_id: &str,
    request: &DeletionRequest,
    expected_deletion_id: Option<&str>,
    expected_created_at: Option<u64>,
    cleanups: &'a [Cleanup],
) -> WireCleanupMatch<'a> {
    match_wire_cleanup_iter(
        mission_id,
        request,
        expected_deletion_id,
        expected_created_at,
        cleanups.iter(),
    )
}

pub(super) fn match_wire_cleanup_refs<'a>(
    mission_id: &str,
    request: &DeletionRequest,
    expected_deletion_id: Option<&str>,
    expected_created_at: Option<u64>,
    cleanups: &[&'a Cleanup],
) -> WireCleanupMatch<'a> {
    match_wire_cleanup_iter(
        mission_id,
        request,
        expected_deletion_id,
        expected_created_at,
        cleanups.iter().copied(),
    )
}

fn match_wire_cleanup_iter<'a>(
    mission_id: &str,
    request: &DeletionRequest,
    expected_deletion_id: Option<&str>,
    expected_created_at: Option<u64>,
    cleanups: impl IntoIterator<Item = &'a Cleanup>,
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

pub(super) fn cleanup_settled_for(require_document_settled: bool, item: &Cleanup) -> bool {
    !item.is_pending() && (!require_document_settled || item.document_pending == Some(false))
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_delete(
    backend: Backend,
    target: LifecycleTarget,
    request: DeletionRequest,
    reconcile_first: bool,
    mut require_document_settled: bool,
    mut expected_deletion_id: Option<String>,
    mut expected_created_at: Option<u64>,
    live: Option<LiveFlag>,
    cancel: Option<Sender<()>>,
    phase: Option<Arc<AtomicU8>>,
) -> DeleteResult {
    let still_live = || live.as_ref().is_none_or(LiveFlag::is_live);
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
        let committed = match (live.as_ref(), phase.as_ref()) {
            (Some(flag), Some(p)) => LiveFlag::commit_dispatch(&[flag], p),
            (Some(flag), None) => flag.is_live(),
            (None, Some(p)) => p
                .compare_exchange(
                    PHASE_PREFLIGHT,
                    PHASE_DISPATCHED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok(),
            (None, None) => true,
        };
        if !committed {
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
    let reconciled = if let Some(cancel) = cancel.as_ref() {
        match until_closed(
            cancel,
            backend.read_mission_reconciliation(&target.project, &target.mission),
        )
        .await
        {
            Some(result) => result,
            None => {
                return DeleteResult::Cancelled {
                    dispatched: true,
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
    match reconciled {
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
                        if live.is_some() && !still_live() {
                            return DeleteResult::Cancelled {
                                dispatched: true,
                                document_cleanup: require_document_settled,
                                deletion_id: expected_deletion_id,
                                created_at_bits: expected_created_at,
                                tombstoned,
                            };
                        }
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

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_cleanup_retry(
    backend: Backend,
    project: String,
    saved: Cleanup,
    mut require_document_settled: bool,
    view_live: LiveFlag,
    row_live: LiveFlag,
    cancel: Sender<()>,
    phase: Arc<AtomicU8>,
) -> CleanupRetryResult {
    let still_live = || view_live.is_live() && row_live.is_live();
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
    if !LiveFlag::commit_dispatch(&[&view_live, &row_live], &phase) {
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
    let definitive_client_refusal = matches!(
        outcome,
        DeletionOutcome::Failed(err)
            if (400..500).contains(&err.status)
                && err.status != 409
                && matches!(
                    err.code,
                    Some(
                        codenomad_client::missions::DeletionCode::MissionNotFound
                            | codenomad_client::missions::DeletionCode::ForeignSession
                            | codenomad_client::missions::DeletionCode::ChildSession
                            | codenomad_client::missions::DeletionCode::InvalidDeleteOption
                    )
                )
    );
    let mutated = !conflict_409 && !definitive_client_refusal;
    if !still_live() {
        return CleanupRetryResult::Cancelled {
            mutated,
            document_cleanup: require_document_settled,
        };
    }
    // Reconcile any outcome that does not prove the mutation failed (409 conflicts,
    // dropped/truncated responses, 5xx, or bare Deleted(None) receipts) so an already-committed
    // cleanup row settles immediately instead of lingering as pending.
    if !definitive_client_refusal {
        let Some(post_reconcile) = until_closed(
            &cancel,
            backend.read_mission_reconciliation(&project, &saved.mission_id),
        )
        .await
        else {
            return CleanupRetryResult::Cancelled {
                mutated,
                document_cleanup: require_document_settled,
            };
        };
        match post_reconcile {
            Ok(ReconciliationOutcome::Snapshot(after)) => {
                if !still_live() {
                    return CleanupRetryResult::Cancelled {
                        mutated,
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
                            mutated,
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
