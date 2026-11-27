#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;

use crate::{
    State,
    backend::Backend,
    catalog::Project,
    platform, screen,
    shell::{notifications, shortcuts},
    strings::{locale, t, with_locale},
    workspace,
};
use codenomad_client::{
    Receiver, Sender, TryRecvError, blank_session_cleanup::BlankCleanupError, bounded,
};
use rune::{El, Key, KeyEvent, Mods, Tx};
use rune_theme_codenomad::{catalogue, shell::blank_cleanup as theme};
use std::{
    collections::{HashSet, VecDeque},
    rc::Rc,
};

const MAX_MANUAL_CANDIDATES: usize = 2_000;

struct ConfirmDialog {
    scope: Rc<()>,
    backend: Backend,
    project: Project,
    connection_generation: u64,
    candidates: VecDeque<String>,
    return_focus: Option<String>,
}

enum StepOutcome {
    Verified {
        session_id: String,
        result: Result<bool, BlankCleanupError>,
    },
    Deleted {
        session_id: String,
        result: Result<bool, BlankCleanupError>,
    },
}

struct InFlight {
    session_id: String,
    deleting: bool,
    aborted: bool,
    cancel: Option<Sender<()>>,
    rx: Receiver<StepOutcome>,
}

struct Sweep {
    generation: u64,
    backend: Backend,
    project: Project,
    connection_generation: u64,
    candidates: VecDeque<String>,
    in_flight: Option<InFlight>,
    deleted_count: usize,
}

#[derive(Default)]
pub(crate) struct Host {
    dialog: Option<Box<ConfirmDialog>>,
    sweep: Option<Box<Sweep>>,
    viewport: (f32, f32),
    generation: u64,
}

impl Host {
    pub(crate) fn dismiss_dialog(&mut self) {
        self.dialog = None;
    }

    pub(crate) fn cancel(&mut self) {
        self.dialog = None;
        // Dropping `sweep` drops `InFlight::cancel`, aborting any active HTTP request.
        self.sweep = None;
        self.generation = self.generation.wrapping_add(1);
    }

    pub(crate) fn is_sweeping(&self) -> bool {
        self.sweep.is_some()
    }
}

/// Returns `true` while a `POST /session-cleanup/:sessionId` deletion is already in flight
/// on the server for `(project_id, session_id)` (manual or automatic), so callers do not
/// open a session mid-delete.
pub(crate) fn is_deleting_session(s: &State, project_id: &str, session_id: &str) -> bool {
    s.blank_cleanup.sweep.as_ref().is_some_and(|sweep| {
        sweep.project.id == project_id
            && sweep
                .in_flight
                .as_ref()
                .is_some_and(|active| active.deleting && active.session_id == session_id)
    }) || workspace::auto_cleanup_is_deleting_session(s, project_id, session_id)
}

/// Synchronously aborts any in-flight blank-cleanup preflight targeting `session_id`
/// (and removes it from pending candidates) the moment the user selects or edits it.
/// Once the server `POST` deletion has already been dispatched, keep waiting for its outcome.
pub(crate) fn abort_for_session(s: &mut State, session_id: &str) {
    if let Some(sweep) = s.blank_cleanup.sweep.as_mut() {
        sweep.candidates.retain(|id| id != session_id);
        if let Some(active) = sweep.in_flight.as_mut()
            && !active.deleting
            && active.session_id == session_id
        {
            // Drop `cancel` to abort any in-flight HTTP preflight and atomically close `rx`
            // before checking emptiness so no producer can race a 401 in after the check.
            active.cancel = None;
            active.rx.close();
            active.aborted = true;
            if active.rx.is_empty() {
                sweep.in_flight = None;
            }
            (s.wake)();
        }
    }
    workspace::auto_cleanup_abort_for_session(s, session_id);
}

/// Synchronously aborts any dialog or sweep bound to `project_id` (for example right
/// before a project tab is closed and released on the server).
pub(crate) fn abort_for_project(s: &mut State, project_id: &str) {
    if s.blank_cleanup
        .dialog
        .as_ref()
        .is_some_and(|dialog| dialog.project.id == project_id)
    {
        s.blank_cleanup.dialog = None;
    }
    if s.blank_cleanup
        .sweep
        .as_ref()
        .is_some_and(|sweep| sweep.project.id == project_id)
    {
        s.blank_cleanup.cancel();
    }
    workspace::auto_cleanup_abort_for_project(s, project_id);
}

/// Synchronously aborts the current in-flight blank-cleanup request if its target
/// just became locally protected (e.g. a draft, attachment, or unconfirmed prompt appeared).
pub(crate) fn abort_if_protected(s: &mut State) {
    let target = s.blank_cleanup.sweep.as_ref().and_then(|sweep| {
        let active = sweep.in_flight.as_ref()?;
        Some((sweep.project.id.clone(), active.session_id.clone()))
    });
    if let Some((project_id, session_id)) = target
        && workspace::session_cleanup_protected(s, &project_id, &session_id)
    {
        abort_for_session(s, &session_id);
    }
    workspace::auto_cleanup_abort_if_protected(s);
}

pub(crate) fn is_open(s: &State) -> bool {
    s.blank_cleanup
        .dialog
        .as_ref()
        .is_some_and(|dialog| s.current_scope(&dialog.scope))
}

pub(crate) fn measure(s: &mut State, [_, _, width, height]: [f32; 4], tx: &mut Tx) -> bool {
    let viewport = &mut s.blank_cleanup.viewport;
    if *viewport != (width, height) {
        *viewport = (width, height);
        if is_open(s) {
            tx.instant();
        }
        true
    } else {
        false
    }
}

fn blocked_by_higher_modal(s: &State) -> bool {
    #[cfg(target_arch = "wasm32")]
    if crate::platform::pairing::required(s) {
        return true;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if crate::chat::authentication::open(s) {
        return true;
    }
    shortcuts::authentication_required(s)
}

pub(crate) fn can_start(s: &State) -> bool {
    if !shortcuts::has_project(s)
        || s.blank_cleanup.is_sweeping()
        || !workspace::input_ready(s)
        || blocked_by_higher_modal(s)
    {
        return false;
    }
    s.screen.launcher().is_some_and(|l| {
        l.connection.is_some()
            && !l.authentication_required
            && l.project.is_some()
            && !l.pending
            && !l.creation_uncertain
    })
}

pub(crate) fn open_confirm(s: &mut State, explicit_return: Option<String>, tx: &mut Tx) -> bool {
    if !can_start(s) || is_open(s) || shortcuts::modal_open(s) {
        return false;
    }
    // Snapshot candidates before displaying the confirmation dialog (matching Solid
    // `runSessionCleanup`) so sessions created while the dialog is open are never swept.
    let Some((backend, project, connection_generation, candidates)) =
        s.screen.launcher().and_then(|l| {
            let project = l.project.clone()?;
            let backend = l.connection.clone()?;
            let mut seen = HashSet::new();
            let mut ids = VecDeque::new();
            for row in l.sessions.iter().chain(l.linked.rows.iter()) {
                if ids.len() >= MAX_MANUAL_CANDIDATES {
                    break;
                }
                if !row.id.starts_with("ses_cn_schedule_") && seen.insert(row.id.clone()) {
                    ids.push_back(row.id.clone());
                }
            }
            Some((backend, project, l.connection_generation(), ids))
        })
    else {
        return false;
    };
    let return_focus = explicit_return.or_else(|| tx.focused().map(str::to_owned));
    super::Panels::dismiss_outside(s, tx);
    let scope = s.input_scope.clone();
    s.blank_cleanup.dialog = Some(Box::new(ConfirmDialog {
        scope,
        backend,
        project,
        connection_generation,
        candidates,
        return_focus,
    }));
    tx.focus_when_shown(theme::CANCEL, true);
    tx.instant();
    true
}

fn close_dialog_with_focus(s: &mut State, tx: &mut Tx) {
    let target = s
        .blank_cleanup
        .dialog
        .take()
        .and_then(|dialog| dialog.return_focus);
    if let Some(target) = target {
        tx.return_focus(target, tx.focus_visible());
    }
    tx.instant();
}

pub(crate) fn cancel(s: &mut State, tx: &mut Tx) {
    if !is_open(s) {
        return;
    }
    close_dialog_with_focus(s, tx);
}

fn confirm(s: &mut State, tx: &mut Tx) {
    if !is_open(s) {
        return;
    }
    let Some(dialog) = s.blank_cleanup.dialog.take() else {
        return;
    };
    if let Some(target) = dialog.return_focus {
        tx.return_focus(target, tx.focus_visible());
    }
    tx.instant();
    if !can_start(s) {
        return;
    }
    let still_current = s.screen.launcher().is_some_and(|l| {
        l.project
            .as_ref()
            .is_some_and(|p| p.id == dialog.project.id)
            && l.connection_generation() == dialog.connection_generation
            && l.connection
                .as_ref()
                .is_some_and(|conn| conn.client.same_connection(&dialog.backend.client))
    });
    if !still_current {
        return;
    }

    let candidates: VecDeque<String> = dialog
        .candidates
        .into_iter()
        .filter(|id| !workspace::session_cleanup_protected(s, &dialog.project.id, id))
        .collect();
    if candidates.is_empty() {
        return;
    }

    s.blank_cleanup.generation = s.blank_cleanup.generation.wrapping_add(1);
    let generation = s.blank_cleanup.generation;
    s.blank_cleanup.sweep = Some(Box::new(Sweep {
        generation,
        backend: dialog.backend,
        project: dialog.project,
        connection_generation: dialog.connection_generation,
        candidates,
        in_flight: None,
        deleted_count: 0,
    }));
    let _ = advance(s, tx);
}

fn sweep_current(s: &State, sweep: &Sweep) -> bool {
    if s.blank_cleanup.generation != sweep.generation || blocked_by_higher_modal(s) {
        return false;
    }
    let Some(l) = s.screen.launcher() else {
        return false;
    };
    if l.authentication_required || l.connection_generation() != sweep.connection_generation {
        return false;
    }
    if !l
        .connection
        .as_ref()
        .is_some_and(|conn| conn.client.same_connection(&sweep.backend.client))
    {
        return false;
    }
    if s.workspace.is_some() {
        workspace::contains_project(s, &sweep.project.id)
            || l.project
                .as_ref()
                .is_some_and(|project| project.id == sweep.project.id)
    } else {
        l.project
            .as_ref()
            .is_some_and(|project| project.id == sweep.project.id)
    }
}

fn spawn_verify(s: &State, backend: Backend, project: Project, session_id: String) -> InFlight {
    let (cancel, cancelled) = bounded::<()>(1);
    let (out, rx) = bounded(1);
    let wake = s.wake.clone();
    let id = session_id.clone();
    platform::spawn(async move {
        if let Some(result) = backend
            .verify_blank_session_cancellable(&project, &id, &cancelled)
            .await
            && !cancelled.is_closed()
            && out
                .try_send(StepOutcome::Verified {
                    session_id: id,
                    result,
                })
                .is_ok()
        {
            wake();
        }
    });
    InFlight {
        session_id,
        deleting: false,
        aborted: false,
        cancel: Some(cancel),
        rx,
    }
}

fn spawn_delete(s: &State, backend: Backend, project: Project, session_id: String) -> InFlight {
    let (cancel, cancelled) = bounded::<()>(1);
    let (out, rx) = bounded(1);
    let wake = s.wake.clone();
    let id = session_id.clone();
    platform::spawn(async move {
        if let Some(result) = backend
            .delete_blank_session_cancellable(&project, &id, &cancelled)
            .await
            && !cancelled.is_closed()
            && out
                .try_send(StepOutcome::Deleted {
                    session_id: id,
                    result,
                })
                .is_ok()
        {
            wake();
        }
    });
    InFlight {
        session_id,
        deleting: true,
        aborted: false,
        cancel: Some(cancel),
        rx,
    }
}

fn finish_sweep(s: &mut State, sweep: Sweep, unavailable: Option<&BlankCleanupError>, tx: &mut Tx) {
    if !sweep_current(s, &sweep) {
        return;
    }
    let mut emitted = false;
    if sweep.deleted_count > 0 {
        let count = sweep.deleted_count.to_string();
        let key = if sweep.deleted_count == 1 {
            "sessionState.cleanup.toast.one"
        } else {
            "sessionState.cleanup.toast.other"
        };
        let message = catalogue::format(locale(), key, &[("count", &count)]);
        notifications::emit(s, notifications::Category::Sessions, None, message);
        if s.screen
            .launcher()
            .and_then(|l| l.project.as_ref())
            .is_some_and(|project| project.id == sweep.project.id)
        {
            workspace::schedule_catalogue_refresh(s);
        }
        emitted = true;
    }
    if let Some(err) = unavailable {
        let body = if err.is_route_unavailable() {
            t("instanceShell.worktree.unavailable")
        } else {
            t("remoteRestore.unreachable")
        };
        notifications::emit_outcome(
            s,
            notifications::Category::Sessions,
            Some(t("commands.scrubSessions.label").into()),
            body,
            true,
        );
        emitted = true;
    }
    if emitted {
        tx.instant();
    }
}

fn handle_unauthorized(s: &mut State, backend: &Backend) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = crate::settings::authentication_required(s, backend);
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = backend;
        crate::platform::pairing::observe(s);
    }
}

fn advance(s: &mut State, tx: &mut Tx) -> bool {
    let Some(mut sweep) = s.blank_cleanup.sweep.take() else {
        return false;
    };
    if !sweep_current(s, &sweep) {
        return true;
    }
    while let Some(session_id) = sweep.candidates.pop_front() {
        if workspace::session_cleanup_protected(s, &sweep.project.id, &session_id) {
            continue;
        }
        let in_flight = spawn_verify(s, sweep.backend.clone(), sweep.project.clone(), session_id);
        sweep.in_flight = Some(in_flight);
        s.blank_cleanup.sweep = Some(sweep);
        return true;
    }
    finish_sweep(s, *sweep, None, tx);
    true
}

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let Some(mut sweep) = s.blank_cleanup.sweep.take() else {
        return false;
    };
    if !sweep_current(s, &sweep) {
        return true;
    }
    let Some(mut active) = sweep.in_flight.take() else {
        s.blank_cleanup.sweep = Some(sweep);
        return advance(s, tx);
    };
    if !active.deleting
        && workspace::session_cleanup_protected(s, &sweep.project.id, &active.session_id)
    {
        // Cancel HTTP preflight and close `rx` atomically before reading any queued outcome so
        // no producer can race a 401 in and a completed preflight never triggers POST.
        active.cancel = None;
        active.rx.close();
        active.aborted = true;
    }
    let outcome = match active.rx.try_recv() {
        Ok(outcome) => outcome,
        Err(TryRecvError::Empty) => {
            sweep.in_flight = Some(active);
            s.blank_cleanup.sweep = Some(sweep);
            return false;
        }
        Err(TryRecvError::Closed) => {
            if active.aborted {
                s.blank_cleanup.sweep = Some(sweep);
                return advance(s, tx);
            }
            return true;
        }
    };
    match outcome {
        StepOutcome::Verified { session_id, result } => match result {
            Err(BlankCleanupError::Unauthorized) => {
                let backend = sweep.backend.clone();
                handle_unauthorized(s, &backend);
                true
            }
            Err(err) if err.is_unavailable() => {
                finish_sweep(s, *sweep, Some(&err), tx);
                true
            }
            Ok(true) => {
                if !active.aborted
                    && !workspace::session_cleanup_protected(s, &sweep.project.id, &session_id)
                {
                    let next =
                        spawn_delete(s, sweep.backend.clone(), sweep.project.clone(), session_id);
                    sweep.in_flight = Some(next);
                    s.blank_cleanup.sweep = Some(sweep);
                    true
                } else {
                    s.blank_cleanup.sweep = Some(sweep);
                    advance(s, tx)
                }
            }
            Ok(false) | Err(_) => {
                s.blank_cleanup.sweep = Some(sweep);
                advance(s, tx)
            }
        },
        StepOutcome::Deleted { session_id, result } => match result {
            Err(BlankCleanupError::Unauthorized) => {
                let backend = sweep.backend.clone();
                handle_unauthorized(s, &backend);
                true
            }
            Err(err) if err.is_unavailable() => {
                // Route unavailable or server/network outage: stop sweeping and notify the user.
                finish_sweep(s, *sweep, Some(&err), tx);
                true
            }
            Ok(true) => {
                sweep.deleted_count += 1;
                let _ = workspace::remove_cleaned_session(s, &sweep.project.id, &session_id);
                s.blank_cleanup.sweep = Some(sweep);
                advance(s, tx)
            }
            Ok(false) | Err(_) => {
                s.blank_cleanup.sweep = Some(sweep);
                advance(s, tx)
            }
        },
    }
}

pub(crate) fn handle_key(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if !is_open(s) || blocked_by_higher_modal(s) {
        return false;
    }
    // Solid opens deepConfirm with dismissible: false, so Escape is consumed without dismissing.
    if event.key == Key::Escape && event.mods == Mods::default() {
        return true;
    }
    if event.key == Key::Tab && !event.mods.ctrl && !event.mods.cmd && !event.mods.alt {
        let next = match tx.focused() {
            Some(theme::CANCEL) => theme::CONFIRM,
            _ => theme::CANCEL,
        };
        tx.focus(next, true);
        return true;
    }
    if event.key == Key::Enter && event.mods == Mods::default() {
        if !tx.key_repeat() {
            match tx.focused() {
                Some(theme::CONFIRM) => confirm(s, tx),
                _ => cancel(s, tx),
            }
        }
        return true;
    }
    false
}

pub(crate) fn overlay(s: &State) -> Option<El> {
    if !is_open(s) || blocked_by_higher_modal(s) {
        return None;
    }
    let dialog = s.blank_cleanup.dialog.as_ref()?;
    let scope = dialog.scope.clone();
    let key_scope = scope.clone();
    let render_locale = locale();
    Some(theme::dialog(
        t("sessionState.cleanup.deepConfirm.title"),
        t("sessionState.cleanup.deepConfirm.message"),
        t("sessionState.cleanup.deepConfirm.detail"),
        t("sessionState.cleanup.deepConfirm.cancelLabel"),
        t("sessionState.cleanup.deepConfirm.confirmLabel"),
        s.blank_cleanup.viewport,
        move |s: &mut State, event, tx| {
            s.current_scope(&key_scope) && with_locale(render_locale, || handle_key(s, event, tx))
        },
        screen::action_tx(&scope, cancel),
        screen::action_tx(&scope, confirm),
    ))
}
