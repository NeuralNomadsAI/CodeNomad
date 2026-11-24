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
use std::collections::HashMap;

const CAPACITY: usize = 64;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct WorkspaceScope {
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
}

struct DeleteIntent {
    target: LifecycleTarget,
    request: DeletionRequest,
    flight: Option<Receiver<DeleteResult>>,
    error: Option<&'static str>,
}

struct CleanupRetry {
    key: CleanupKey,
    flight: Receiver<Result<(), &'static str>>,
}

#[derive(Default)]
pub(super) struct CleanupPolled {
    pub refreshed_missions: Vec<(MissionKey, LifecycleTarget)>,
    pub refreshed_scopes: Vec<WorkspaceScope>,
}

impl CleanupPolled {
    pub fn is_empty(&self) -> bool {
        self.refreshed_missions.is_empty() && self.refreshed_scopes.is_empty()
    }
}

#[derive(Default)]
pub(super) struct CleanupOwner {
    deletes: HashMap<MissionKey, DeleteIntent>,
    retries: HashMap<WorkspaceScope, CleanupRetry>,
    retry_errors: HashMap<WorkspaceScope, &'static str>,
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

    pub fn delete_busy(&self, source: &Source) -> bool {
        self.delete_state(source) == Some(DeleteState::Busy)
    }

    pub fn can_delete(&self, source: &Source) -> bool {
        !self.deletes.contains_key(&source.mission) && self.deletes.len() < CAPACITY
    }

    pub fn start_delete(
        &mut self,
        source: &Source,
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
        self.deletes.insert(
            source.mission.clone(),
            DeleteIntent {
                target: target.clone(),
                request: request.clone(),
                flight: Some(inbox),
                error: None,
            },
        );
        platform::spawn(async move {
            let result = run_delete(backend, target, request, false).await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    pub fn retry_delete(&mut self, source: &Source, backend: Backend, wake: Wake) {
        let Some(intent) = self.deletes.get_mut(&source.mission) else {
            return;
        };
        if intent.target != source.target || intent.flight.is_some() {
            return;
        }
        let (out, inbox) = bounded(1);
        let target = intent.target.clone();
        let request = intent.request.clone();
        intent.flight = Some(inbox);
        intent.error = None;
        platform::spawn(async move {
            let result = run_delete(backend, target, request, true).await;
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

    pub fn cleanup_busy(&self, scope: &WorkspaceScope) -> bool {
        self.retries.contains_key(scope)
    }

    pub fn cleanup_retrying(&self, key: &CleanupKey) -> bool {
        self.retries
            .get(&key.scope)
            .is_some_and(|retry| &retry.key == key)
    }

    pub fn cleanup_error(&self, scope: &WorkspaceScope) -> Option<&'static str> {
        self.retry_errors.get(scope).copied()
    }

    pub fn start_cleanup_retry(
        &mut self,
        scope: WorkspaceScope,
        cleanup: Cleanup,
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
            let result = run_cleanup_retry(backend, project, cleanup).await;
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
            polled
                .refreshed_missions
                .push((mission.clone(), intent.target.clone()));
            match result {
                DeleteResult::Deleted => false,
                DeleteResult::Failed(key) => {
                    intent.error = Some(key);
                    true
                }
            }
        });
        let mut finished_retries = Vec::new();
        for (scope, retry) in &self.retries {
            if let Ok(result) = retry.flight.try_recv() {
                finished_retries.push((scope.clone(), result));
            }
        }
        for (scope, result) in finished_retries {
            self.retries.remove(&scope);
            match result {
                Ok(()) => {
                    self.retry_errors.remove(&scope);
                }
                Err(key) => {
                    self.retry_errors.insert(scope.clone(), key);
                }
            }
            polled.refreshed_scopes.push(scope);
        }
        polled
    }
}

async fn run_delete(
    backend: Backend,
    target: LifecycleTarget,
    request: DeletionRequest,
    reconcile_first: bool,
) -> DeleteResult {
    if reconcile_first {
        let Ok(snapshot) = backend
            .read_mission_reconciliation(&target.project, &target.mission)
            .await
        else {
            return DeleteResult::Failed("missions.cleanup.error.unconfirmed");
        };
        if snapshot.cleanup_unavailable {
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
) -> Result<(), &'static str> {
    let Ok(snapshot) = backend
        .read_mission_reconciliation(&project, &saved.mission_id)
        .await
    else {
        return Err("missions.cleanup.error.unconfirmed");
    };
    if snapshot.cleanup_unavailable {
        return Err("missions.cleanup.error.unconfirmed");
    }
    let Some(fresh) = snapshot
        .cleanups
        .iter()
        .find(|item| item.matches_saved(&saved))
    else {
        return Err("missions.cleanup.error.unconfirmed");
    };
    if !fresh.is_pending() {
        return Ok(());
    }
    let Ok(request) = DeletionRequest::from_cleanup(fresh) else {
        return Err("missions.cleanup.error.unconfirmed");
    };
    let outcome = backend
        .delete_mission(&fresh.mission_id, &request)
        .await
        .unwrap_or(DeletionOutcome::Unconfirmed);
    if outcome == DeletionOutcome::Deleted {
        return Ok(());
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
        return Ok(());
    }
    Err(outcome.error_key())
}

pub(crate) type CleanupAct = fn(&mut State, Cleanup);

pub(crate) fn cleanup_view<S: 'static>(
    panel: &Panel,
    owner: &CleanupOwner,
    retry: fn(&mut S, Cleanup),
) -> El {
    if panel.cleanups.is_empty() {
        return rune::el();
    }
    let scope = panel.cleanup_scope();
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
            let saved = cleanup.clone();
            row = row.child(
                layout::button_tx(label, false, move |state: &mut S, tx| {
                    if !disabled {
                        retry(state, saved.clone());
                        tx.instant();
                    }
                })
                .disabled(disabled)
                .focusable(true)
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
    section
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
