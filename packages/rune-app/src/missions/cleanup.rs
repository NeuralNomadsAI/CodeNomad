use super::{
    Panel,
    lifecycle::{MissionKey, Source},
};
use crate::{
    State, platform,
    strings::{locale, t},
};
use codenomad_client::{
    Receiver, Wake,
    backend::Backend,
    bounded,
    missions::{Cleanup, DeletionOutcome, DeletionRequest, LifecycleTarget},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue, git_panel as theme,
    layout::{self, Layout},
};
use std::{
    collections::HashMap,
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

enum DeleteResult {
    Deleted,
    Failed(&'static str),
    Cancelled,
}

struct DeleteIntent {
    scope: WorkspaceScope,
    title: String,
    target: LifecycleTarget,
    request: DeletionRequest,
    flight: Option<Receiver<DeleteResult>>,
    error: Option<&'static str>,
}

enum CleanupRetryResult {
    Settled {
        mission_id: String,
        request_id: String,
        expected_revision: u64,
        delete_managed_sessions: bool,
    },
    Failed(&'static str),
    Cancelled,
}

struct CleanupRetry {
    key: CleanupKey,
    flight: Receiver<CleanupRetryResult>,
}

#[derive(Default)]
pub(super) struct CleanupPolled {
    pub refreshed_missions: Vec<(MissionKey, LifecycleTarget)>,
    pub refreshed_scopes: Vec<WorkspaceScope>,
    pub changed: bool,
}

impl CleanupPolled {
    pub fn is_empty(&self) -> bool {
        !self.changed && self.refreshed_missions.is_empty() && self.refreshed_scopes.is_empty()
    }
}

#[derive(Default)]
pub(super) struct CleanupOwner {
    deletes: HashMap<MissionKey, DeleteIntent>,
    retries: HashMap<WorkspaceScope, CleanupRetry>,
    retry_errors: HashMap<WorkspaceScope, (String, String, &'static str)>,
}

impl CleanupOwner {
    pub fn delete_state(&self, source: &Source) -> Option<DeleteState> {
        let intent = self
            .deletes
            .get(&source.mission)
            .filter(|intent| intent.target == source.target)?;
        if intent.flight.is_some() {
            Some(DeleteState::Busy)
        } else {
            intent.error.map(DeleteState::Failed)
        }
    }

    pub fn delete_active(&self, source: &Source) -> bool {
        self.delete_state(source).is_some()
    }

    pub fn can_delete(&self, source: &Source) -> bool {
        !self.deletes.contains_key(&source.mission) && self.deletes.len() < CAPACITY
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
            source.mission.clone(),
            DeleteIntent {
                scope,
                title,
                target: target.clone(),
                request: request.clone(),
                flight: Some(inbox),
                error: None,
            },
        );
        platform::spawn(async move {
            let result = run_delete(backend, target, request, false, None).await;
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
        let Some(intent) = self.deletes.get_mut(&source.mission) else {
            return;
        };
        if intent.target != source.target || intent.flight.is_some() {
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
        let Some(intent) = self.deletes.get_mut(mission) else {
            return;
        };
        if &intent.scope != scope || intent.flight.is_some() {
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
        intent.flight = Some(inbox);
        platform::spawn(async move {
            let result = run_delete(backend, target, request, true, Some(live)).await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    pub fn cancel_delete(&mut self, source: &Source) {
        if self
            .deletes
            .get(&source.mission)
            .is_some_and(|intent| intent.target == source.target && intent.flight.is_none())
        {
            self.deletes.remove(&source.mission);
        }
    }

    pub fn cancel_delete_in_scope(&mut self, scope: &WorkspaceScope, mission: &MissionKey) {
        if self
            .deletes
            .get(mission)
            .is_some_and(|intent| &intent.scope == scope && intent.flight.is_none())
        {
            self.deletes.remove(mission);
        }
    }

    pub fn retire_settled_cleanups(&mut self, scope: &WorkspaceScope, cleanups: &[Cleanup]) {
        self.deletes.retain(|_, intent| {
            if &intent.scope != scope || intent.flight.is_some() {
                return true;
            }
            !cleanups.iter().any(|row| {
                !row.is_pending() && intent.request.matches_cleanup(&intent.target.mission, row)
            })
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
        self.retries.contains_key(scope)
    }

    pub fn cleanup_retrying(&self, key: &CleanupKey) -> bool {
        self.retries
            .get(&key.scope)
            .is_some_and(|retry| &retry.key == key)
    }

    pub fn cleanup_error(&self, scope: &WorkspaceScope) -> Option<&'static str> {
        self.retry_errors.get(scope).map(|(_, _, err)| *err)
    }

    pub fn start_cleanup_retry(
        &mut self,
        scope: WorkspaceScope,
        cleanup: Cleanup,
        live: Arc<AtomicBool>,
        backend: Backend,
        wake: Wake,
    ) {
        if !cleanup.is_pending() || self.retries.contains_key(&scope) {
            return;
        }
        self.retry_errors.remove(&scope);
        let key = CleanupKey::new(scope.clone(), &cleanup);
        let project = scope.project.clone();
        let (out, inbox) = bounded(1);
        self.retries
            .insert(scope, CleanupRetry { key, flight: inbox });
        platform::spawn(async move {
            let result = run_cleanup_retry(backend, project, cleanup, live).await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    pub fn poll(&mut self) -> CleanupPolled {
        let mut polled = CleanupPolled::default();
        self.deletes.retain(|mission, intent| {
            let Some(result) = intent
                .flight
                .as_ref()
                .and_then(|inbox| inbox.try_recv().ok())
            else {
                return true;
            };
            intent.flight = None;
            polled.changed = true;
            match result {
                DeleteResult::Deleted => {
                    polled
                        .refreshed_missions
                        .push((mission.clone(), intent.target.clone()));
                    if !polled.refreshed_scopes.contains(&intent.scope) {
                        polled.refreshed_scopes.push(intent.scope.clone());
                    }
                    false
                }
                DeleteResult::Failed(key) => {
                    intent.error = Some(key);
                    polled
                        .refreshed_missions
                        .push((mission.clone(), intent.target.clone()));
                    if !polled.refreshed_scopes.contains(&intent.scope) {
                        polled.refreshed_scopes.push(intent.scope.clone());
                    }
                    true
                }
                DeleteResult::Cancelled => true,
            }
        });
        let mut finished_retries = Vec::new();
        for (scope, retry) in &self.retries {
            if let Ok(result) = retry.flight.try_recv() {
                finished_retries.push((
                    scope.clone(),
                    retry.key.mission_id.clone(),
                    retry.key.deletion_id.clone(),
                    result,
                ));
            }
        }
        for (scope, mission_id, deletion_id, result) in finished_retries {
            self.retries.remove(&scope);
            polled.changed = true;
            match result {
                CleanupRetryResult::Settled {
                    mission_id,
                    request_id,
                    expected_revision,
                    delete_managed_sessions,
                } => {
                    self.retry_errors.remove(&scope);
                    self.deletes.retain(|_, intent| {
                        !(intent.scope == scope
                            && intent.flight.is_none()
                            && intent.target.mission == mission_id
                            && intent.request.request_id == request_id
                            && intent.request.expected_revision == expected_revision
                            && intent.request.delete_managed_sessions == delete_managed_sessions)
                    });
                    if !polled.refreshed_scopes.contains(&scope) {
                        polled.refreshed_scopes.push(scope);
                    }
                }
                CleanupRetryResult::Failed(key) => {
                    self.retry_errors
                        .insert(scope.clone(), (mission_id, deletion_id, key));
                    if !polled.refreshed_scopes.contains(&scope) {
                        polled.refreshed_scopes.push(scope);
                    }
                }
                CleanupRetryResult::Cancelled => {}
            }
        }
        polled
    }
}

async fn run_delete(
    backend: Backend,
    target: LifecycleTarget,
    request: DeletionRequest,
    reconcile_first: bool,
    live: Option<Arc<AtomicBool>>,
) -> DeleteResult {
    if reconcile_first {
        let Ok(snapshot) = backend
            .read_mission_reconciliation(&target.project, &target.mission)
            .await
        else {
            if live
                .as_ref()
                .is_some_and(|flag| !flag.load(Ordering::Acquire))
            {
                return DeleteResult::Cancelled;
            }
            return DeleteResult::Failed("missions.cleanup.error.unconfirmed");
        };
        if snapshot.cleanup_unavailable {
            if live
                .as_ref()
                .is_some_and(|flag| !flag.load(Ordering::Acquire))
            {
                return DeleteResult::Cancelled;
            }
            return DeleteResult::Failed("missions.cleanup.error.unconfirmed");
        }
        let matching = snapshot
            .cleanups
            .iter()
            .find(|item| request.matches_cleanup(&target.mission, item));
        if let Some(intent) = matching
            && !intent.is_pending()
        {
            return DeleteResult::Deleted;
        }
        if matching.is_none()
            && snapshot
                .mission_revision
                .is_some_and(|revision| revision != request.expected_revision)
        {
            return DeleteResult::Failed("missions.cleanup.error.revisionConflict");
        }
        if live
            .as_ref()
            .is_some_and(|flag| !flag.load(Ordering::Acquire))
        {
            return DeleteResult::Cancelled;
        }
    }
    let outcome = backend
        .delete_mission(&target.mission, &request)
        .await
        .unwrap_or(DeletionOutcome::Unconfirmed);
    if outcome == DeletionOutcome::Deleted {
        return DeleteResult::Deleted;
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
        && let Some(intent) = snapshot
            .cleanups
            .iter()
            .find(|item| request.matches_cleanup(&target.mission, item))
    {
        if !intent.is_pending() {
            return DeleteResult::Deleted;
        }
        if !conflict {
            key = if intent.document_pending == Some(true) {
                "missions.cleanup.documentPending"
            } else {
                "missions.cleanup.error.pending"
            };
        }
    }
    DeleteResult::Failed(key)
}

async fn run_cleanup_retry(
    backend: Backend,
    project: String,
    saved: Cleanup,
    live: Arc<AtomicBool>,
) -> CleanupRetryResult {
    let Ok(snapshot) = backend
        .read_mission_reconciliation(&project, &saved.mission_id)
        .await
    else {
        return if live.load(Ordering::Acquire) {
            CleanupRetryResult::Failed("missions.cleanup.error.unconfirmed")
        } else {
            CleanupRetryResult::Cancelled
        };
    };
    if snapshot.cleanup_unavailable {
        return if live.load(Ordering::Acquire) {
            CleanupRetryResult::Failed("missions.cleanup.error.unconfirmed")
        } else {
            CleanupRetryResult::Cancelled
        };
    }
    let Some(fresh) = snapshot
        .cleanups
        .iter()
        .find(|item| item.matches_saved(&saved))
    else {
        return if live.load(Ordering::Acquire) {
            CleanupRetryResult::Failed("missions.cleanup.error.unconfirmed")
        } else {
            CleanupRetryResult::Cancelled
        };
    };
    let settled = CleanupRetryResult::Settled {
        mission_id: fresh.mission_id.clone(),
        request_id: fresh.request_id.clone(),
        expected_revision: fresh.expected_revision,
        delete_managed_sessions: fresh.delete_managed_sessions,
    };
    if !fresh.is_pending() {
        return settled;
    }
    if !live.load(Ordering::Acquire) {
        return CleanupRetryResult::Cancelled;
    }
    let Ok(request) = DeletionRequest::from_cleanup(fresh) else {
        return CleanupRetryResult::Failed("missions.cleanup.error.unconfirmed");
    };
    let outcome = backend
        .delete_mission(&fresh.mission_id, &request)
        .await
        .unwrap_or(DeletionOutcome::Unconfirmed);
    if outcome == DeletionOutcome::Deleted {
        return settled;
    }
    if matches!(outcome, DeletionOutcome::Failed(err) if err.status == 409)
        && let Ok(after) = backend
            .read_mission_reconciliation(&project, &saved.mission_id)
            .await
        && !after.cleanup_unavailable
        && after
            .cleanups
            .iter()
            .find(|item| item.matches_saved(&saved))
            .is_some_and(|intent| !intent.is_pending())
    {
        return settled;
    }
    CleanupRetryResult::Failed(outcome.error_key())
}

pub(crate) type CleanupAct = fn(&mut State, String, WorkspaceScope, Cleanup);
pub(crate) type DeleteAct = fn(&mut State, String, WorkspaceScope, MissionKey, bool);

pub(crate) fn cleanup_view<S: 'static>(
    panel: &Panel,
    owner: &CleanupOwner,
    occurrence: &str,
    retry: fn(&mut S, String, WorkspaceScope, Cleanup),
    orphaned_delete: fn(&mut S, String, WorkspaceScope, MissionKey, bool),
) -> El {
    let scope = panel.cleanup_scope();
    let selected_id = panel
        .control_source(occurrence)
        .map(|(source, _)| source.mission);
    let mut orphaned: Vec<(&MissionKey, &DeleteIntent)> = scope
        .as_ref()
        .map(|scope| {
            owner
                .deletes
                .iter()
                .filter(|(key, intent)| {
                    &intent.scope == scope && selected_id.as_ref() != Some(*key)
                })
                .collect()
        })
        .unwrap_or_default();
    orphaned.sort_by(|(a, _), (b, _)| a.id.cmp(&b.id));
    if panel.cleanups.is_empty() && orphaned.is_empty() {
        return rune::el();
    }
    let mut root = col().full_width();
    if let Some(scope) = &scope
        && !orphaned.is_empty()
    {
        let mut pending = col()
            .full_width()
            .key("mission-orphaned-deletes")
            .role("region")
            .label(t("missions.control.delete"));
        for (mission_key, intent) in orphaned {
            let mut row = col()
                .full_width()
                .pad(Space::Sm)
                .key(format!("mission-delete-{}", mission_key.id))
                .child(
                    text(&intent.title)
                        .text_role(TextRole::Small)
                        .wrap_anywhere(),
                );
            if intent.flight.is_some() {
                row = row.child(theme::note(
                    t("missions.control.mutation.pending"),
                    "status",
                ));
            } else if let Some(err) = intent.error {
                let occ_retry = occurrence.to_owned();
                let scope_retry = scope.clone();
                let key_retry = mission_key.clone();
                let occ_cancel = occurrence.to_owned();
                let scope_cancel = scope.clone();
                let key_cancel = mission_key.clone();
                row = row.child(theme::note(t(err), "alert")).child(
                    layout::action_row()
                        .role("group")
                        .label(t("missions.control.delete"))
                        .child(
                            layout::button_tx(
                                t("missions.control.retry"),
                                false,
                                move |s: &mut S, tx| {
                                    orphaned_delete(
                                        s,
                                        occ_retry.clone(),
                                        scope_retry.clone(),
                                        key_retry.clone(),
                                        true,
                                    );
                                    tx.instant();
                                },
                            )
                            .description(&intent.title)
                            .key(format!("mission-delete-retry-{}", mission_key.id)),
                        )
                        .child(
                            layout::button_tx(
                                t("missions.control.cancel"),
                                false,
                                move |s: &mut S, tx| {
                                    orphaned_delete(
                                        s,
                                        occ_cancel.clone(),
                                        scope_cancel.clone(),
                                        key_cancel.clone(),
                                        false,
                                    );
                                    tx.instant();
                                },
                            )
                            .description(&intent.title)
                            .key(format!("mission-delete-cancel-{}", mission_key.id)),
                        ),
                );
            }
            pending = pending.child(row);
        }
        root = root.child(pending);
    }
    if panel.cleanups.is_empty() {
        return root;
    }
    let any_pending = panel.cleanups.iter().any(Cleanup::is_pending);
    let heading = t(if any_pending {
        "missions.cleanup.title"
    } else {
        "missions.progress.cleanupHistory"
    });
    let busy = scope
        .as_ref()
        .is_some_and(|scope| owner.cleanup_busy(scope));
    let mut section = col()
        .full_width()
        .key("mission-cleanup-section")
        .role("region")
        .label(heading)
        .child(
            text(heading)
                .text_role(TextRole::Small)
                .pad(Space::Sm)
                .role("heading"),
        );
    for cleanup in &panel.cleanups {
        let counts = catalogue::format(
            locale(),
            "missions.cleanup.counts",
            &[
                ("removed", &cleanup.removed.to_string()),
                ("retained", &cleanup.retained.to_string()),
                ("pending", &cleanup.pending.to_string()),
            ],
        );
        let mut row = col()
            .full_width()
            .pad(Space::Sm)
            .key(format!(
                "mission-cleanup-{}-{}",
                cleanup.mission_id, cleanup.deletion_id
            ))
            .child(
                text(&cleanup.objective)
                    .text_role(TextRole::Small)
                    .wrap_anywhere(),
            )
            .child(text(counts).text_role(TextRole::Small).wrap_anywhere());
        if cleanup.document_pending == Some(true) {
            row = row.child(theme::note(t("missions.cleanup.documentPending"), "status"));
        }
        if cleanup.retained > 0 {
            for reason in &cleanup.reasons {
                if let Some(key) = reason_key(reason) {
                    row = row.child(text(t(key)).text_role(TextRole::Small).wrap_anywhere());
                }
            }
        }
        if cleanup.is_pending() {
            let retrying = scope.as_ref().is_some_and(|scope| {
                owner.cleanup_retrying(&CleanupKey::new(scope.clone(), cleanup))
            });
            let label = t(if retrying {
                "missions.cleanup.retrying"
            } else {
                "missions.control.retry"
            });
            let disabled = scope.is_none() || busy;
            let occ = occurrence.to_owned();
            let captured_scope = scope.clone();
            let saved = cleanup.clone();
            row = row.child(
                layout::button_tx(label, false, move |state: &mut S, tx| {
                    if !disabled && let Some(scope) = captured_scope.clone() {
                        retry(state, occ.clone(), scope, saved.clone());
                        tx.instant();
                    }
                })
                .disabled(disabled)
                .focusable(true)
                .description(&cleanup.objective)
                .key(format!(
                    "mission-cleanup-retry-{}-{}",
                    cleanup.mission_id, cleanup.deletion_id
                )),
            );
        }
        section = section.child(row);
    }
    section = section.child(
        text(t("missions.cleanup.preserved"))
            .text_role(TextRole::Small)
            .pad(Space::Sm)
            .wrap_anywhere(),
    );
    if let Some(err) = scope.as_ref().and_then(|scope| owner.cleanup_error(scope)) {
        section = section.child(theme::note(t(err), "alert"));
    }
    root.child(section)
}

fn reason_key(reason: &str) -> Option<&'static str> {
    Some(match reason {
        "children" => "missions.cleanup.reason.children",
        "shared" => "missions.cleanup.reason.shared",
        "moved" => "missions.cleanup.reason.moved",
        "identity" => "missions.cleanup.reason.identity",
        "guarded" => "missions.cleanup.reason.guarded",
        _ => return None,
    })
}

#[cfg(test)]
mod tests;
