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
use codenomad_client::{Receiver, TryRecvError, blank_session_cleanup::BlankCleanupError, bounded};
use rune::{El, Key, KeyEvent, Mods, Tx};
use rune_theme_codenomad::{catalogue, shell::blank_cleanup as theme};
use std::{
    collections::{HashSet, VecDeque},
    rc::Rc,
};

const MAX_MANUAL_CANDIDATES: usize = 2_000;

struct ConfirmDialog {
    scope: Rc<()>,
    project_id: String,
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

struct Sweep {
    generation: u64,
    backend: Backend,
    project: Project,
    connection_generation: u64,
    stream_generation: (u64, u64),
    candidates: VecDeque<String>,
    in_flight: Option<Receiver<StepOutcome>>,
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
        self.sweep = None;
        self.generation = self.generation.wrapping_add(1);
    }

    pub(crate) fn is_sweeping(&self) -> bool {
        self.sweep.is_some()
    }
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
    let Some(project_id) = s
        .screen
        .launcher()
        .and_then(|l| l.project.as_ref())
        .map(|project| project.id.clone())
    else {
        return false;
    };
    let return_focus = explicit_return.or_else(|| tx.focused().map(str::to_owned));
    super::Panels::dismiss_outside(s, tx);
    let scope = s.input_scope.clone();
    s.blank_cleanup.dialog = Some(Box::new(ConfirmDialog {
        scope,
        project_id,
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
    let Some((backend, project, connection_generation, stream_generation, raw_ids)) =
        s.screen.launcher().and_then(|l| {
            let project = l.project.clone()?;
            if project.id != dialog.project_id {
                return None;
            }
            let backend = l.connection.clone()?;
            let stream_generation = (l.catalogue_generation, l.workspace_stream_generation);
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
            Some((
                backend,
                project,
                l.connection_generation(),
                stream_generation,
                ids,
            ))
        })
    else {
        return;
    };

    let candidates: VecDeque<String> = raw_ids
        .into_iter()
        .filter(|id| !workspace::session_cleanup_protected(s, &project.id, id))
        .collect();
    if candidates.is_empty() {
        return;
    }

    s.blank_cleanup.generation = s.blank_cleanup.generation.wrapping_add(1);
    let generation = s.blank_cleanup.generation;
    s.blank_cleanup.sweep = Some(Box::new(Sweep {
        generation,
        backend,
        project,
        connection_generation,
        stream_generation,
        candidates,
        in_flight: None,
        deleted_count: 0,
    }));
    let _ = advance(s, tx);
}

fn sweep_current(s: &State, sweep: &Sweep) -> bool {
    if s.blank_cleanup.generation != sweep.generation {
        return false;
    }
    let Some(l) = s.screen.launcher() else {
        return false;
    };
    if l.authentication_required
        || l.connection_generation() != sweep.connection_generation
        || (l.catalogue_generation, l.workspace_stream_generation) != sweep.stream_generation
    {
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

fn spawn_verify(
    s: &State,
    backend: Backend,
    project: Project,
    session_id: String,
) -> Receiver<StepOutcome> {
    let (out, rx) = bounded(1);
    let wake = s.wake.clone();
    platform::spawn(async move {
        let result = backend.verify_blank_session(&project, &session_id).await;
        if out
            .try_send(StepOutcome::Verified { session_id, result })
            .is_ok()
        {
            wake();
        }
    });
    rx
}

fn spawn_delete(
    s: &State,
    backend: Backend,
    project: Project,
    session_id: String,
) -> Receiver<StepOutcome> {
    let (out, rx) = bounded(1);
    let wake = s.wake.clone();
    platform::spawn(async move {
        let result = backend.delete_blank_session(&project, &session_id).await;
        if out
            .try_send(StepOutcome::Deleted { session_id, result })
            .is_ok()
        {
            wake();
        }
    });
    rx
}

fn finish_sweep(s: &mut State, sweep: Sweep, tx: &mut Tx) {
    if sweep.deleted_count == 0 || !sweep_current(s, &sweep) {
        return;
    }
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
    tx.instant();
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
        let rx = spawn_verify(s, sweep.backend.clone(), sweep.project.clone(), session_id);
        sweep.in_flight = Some(rx);
        s.blank_cleanup.sweep = Some(sweep);
        return true;
    }
    finish_sweep(s, *sweep, tx);
    true
}

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let Some(mut sweep) = s.blank_cleanup.sweep.take() else {
        return false;
    };
    if !sweep_current(s, &sweep) {
        return true;
    }
    let Some(rx) = sweep.in_flight.take() else {
        s.blank_cleanup.sweep = Some(sweep);
        return advance(s, tx);
    };
    match rx.try_recv() {
        Err(TryRecvError::Empty) => {
            sweep.in_flight = Some(rx);
            s.blank_cleanup.sweep = Some(sweep);
            false
        }
        Err(TryRecvError::Closed) => true,
        Ok(StepOutcome::Verified { session_id, result }) => match result {
            Err(BlankCleanupError::Unauthorized) => {
                let backend = sweep.backend.clone();
                handle_unauthorized(s, &backend);
                true
            }
            Ok(true) => {
                if !workspace::session_cleanup_protected(s, &sweep.project.id, &session_id) {
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
            Ok(false) | Err(BlankCleanupError::RouteUnavailable | BlankCleanupError::Other(_)) => {
                s.blank_cleanup.sweep = Some(sweep);
                advance(s, tx)
            }
        },
        Ok(StepOutcome::Deleted { session_id, result }) => match result {
            Err(BlankCleanupError::Unauthorized) => {
                let backend = sweep.backend.clone();
                handle_unauthorized(s, &backend);
                true
            }
            Err(BlankCleanupError::RouteUnavailable) => {
                // Route unavailable or workspace missing: degrade gracefully and stop sweeping.
                finish_sweep(s, *sweep, tx);
                true
            }
            Ok(true) => {
                sweep.deleted_count += 1;
                let _ = workspace::remove_cleaned_session(s, &sweep.project.id, &session_id);
                s.blank_cleanup.sweep = Some(sweep);
                advance(s, tx)
            }
            Ok(false) | Err(BlankCleanupError::Other(_)) => {
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
    if event.key == Key::Escape && event.mods == Mods::default() {
        if !tx.key_repeat() {
            cancel(s, tx);
        }
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
