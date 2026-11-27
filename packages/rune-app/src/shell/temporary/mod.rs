#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;

use crate::{
    State,
    backend::Backend,
    components::window_close_button::{WindowCloseState, close_button},
    launcher, platform, screen,
    shell::{notifications, shortcuts, status_usage},
    strings::{locale, t, with_locale},
    workspace::{self, StashedTemporary},
};
use codenomad_client::{
    Receiver, bounded,
    temporary_workspaces::{CreatedTemporaryFolder, TemporaryError},
};
use rune::{El, Key, KeyEvent, Mods, Tx};
use rune_theme_codenomad::{catalogue, layout, shell::temporary_close as theme};
use std::rc::Rc;

struct CloseDialog {
    scope: Rc<()>,
    tab_key: String,
    return_focus: Option<String>,
    close_control: WindowCloseState,
}

struct PendingCreate {
    generation: u64,
    connection_generation: u64,
    backend: Backend,
    rx: Receiver<Result<CreatedTemporaryFolder, TemporaryError>>,
}

struct PendingKeep {
    generation: u64,
    backend: Backend,
    tab_key: String,
    folder: String,
    backend_id: Option<String>,
    server_id: Option<String>,
    close_after: bool,
    rx: Receiver<Result<(), TemporaryError>>,
}

struct PendingDiscard {
    generation: u64,
    stashed: Box<StashedTemporary>,
    quiet: bool,
    rx: Receiver<Result<(), TemporaryError>>,
}

struct PendingReconcile {
    connection_generation: u64,
    epoch: u64,
    backend: Backend,
    rx: Receiver<Result<Vec<String>, TemporaryError>>,
}

struct QueuedAbandon {
    backend: Backend,
    path: String,
    request_id: Option<String>,
}

struct InFlightAbandon {
    backend: Backend,
    path: String,
    request_id: Option<String>,
    rx: Receiver<Result<(), TemporaryError>>,
}

#[derive(Default)]
pub(crate) struct Host {
    dialog: Option<Box<CloseDialog>>,
    viewport: (f32, f32),
    generation: u64,
    reconcile_epoch: u64,
    pending_return_focus: Option<String>,
    creating: Option<Box<PendingCreate>>,
    stale_creates: Vec<PendingCreate>,
    pending_abandons: Vec<QueuedAbandon>,
    in_flight_abandons: Vec<InFlightAbandon>,
    keeping: Option<Box<PendingKeep>>,
    discarding: Option<Box<PendingDiscard>>,
    pending_restore: Option<Box<StashedTemporary>>,
    stopped_queue: Vec<(String, bool, bool)>,
    pending_temporary_folders: Option<Vec<String>>,
    reconcile_folders: Option<Box<PendingReconcile>>,
}

impl Host {
    pub(crate) fn dismiss_dialog(&mut self) {
        self.dialog = None;
    }

    pub(crate) fn in_flight(&self) -> bool {
        self.creating.is_some()
            || self.keeping.is_some()
            || self.discarding.is_some()
            || self.pending_restore.is_some()
    }

    pub(crate) fn stashed_for_snapshot(&self) -> Option<&StashedTemporary> {
        self.discarding
            .as_deref()
            .map(|pending| pending.stashed.as_ref())
            .or(self.pending_restore.as_deref())
    }

    pub(crate) fn stashed_for_snapshot_mut(&mut self) -> Option<&mut StashedTemporary> {
        self.discarding
            .as_deref_mut()
            .map(|pending| pending.stashed.as_mut())
            .or(self.pending_restore.as_deref_mut())
    }

    #[cfg(test)]
    pub(crate) fn fixture_stash(&mut self, stashed: StashedTemporary) {
        self.pending_restore = Some(Box::new(stashed));
    }

    pub(crate) fn cancel_for_auth(&mut self) {
        self.dialog = None;
        if let Some(pending) = self.creating.take()
            && self.stale_creates.len() < 8
        {
            self.stale_creates.push(*pending);
        }
        self.keeping = None;
        self.stopped_queue.clear();
        self.pending_temporary_folders = None;
        self.reconcile_folders = None;
        self.pending_return_focus = None;
        self.generation = self.generation.wrapping_add(1);
        self.reconcile_epoch = self.reconcile_epoch.wrapping_add(1);
        if let Some(pending) = self.discarding.take() {
            self.pending_restore = Some(pending.stashed);
        }
    }

    pub(crate) fn queue_stopped(
        &mut self,
        workspace_id: String,
        deleted: bool,
        temporary_retained: bool,
    ) {
        if let Some(existing) = self
            .stopped_queue
            .iter_mut()
            .find(|(id, _, _)| id == &workspace_id)
        {
            existing.1 = deleted;
            existing.2 = temporary_retained;
        } else if self.stopped_queue.len() < 128 {
            self.stopped_queue
                .push((workspace_id, deleted, temporary_retained));
        }
    }

    pub(crate) fn queue_temporary_folders(&mut self, folders: Vec<String>) {
        self.pending_temporary_folders = Some(folders);
    }
}

pub(crate) fn is_open(s: &State) -> bool {
    s.temporary
        .dialog
        .as_ref()
        .is_some_and(|dialog| s.current_scope(&dialog.scope))
}

pub(crate) fn dismiss_for_tab(s: &mut State, tab_key: &str) {
    if s.temporary
        .dialog
        .as_ref()
        .is_some_and(|dialog| dialog.tab_key == tab_key)
    {
        s.temporary.dialog = None;
    }
}

pub(crate) fn measure(s: &mut State, [_, _, width, height]: [f32; 4], tx: &mut Tx) -> bool {
    let viewport = &mut s.temporary.viewport;
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

pub(crate) fn base_name() -> String {
    let now = platform::storage::unix_millis() as f64;
    let lang = locale();
    let stamp = status_usage::date::short_local(now, lang).unwrap_or_default();
    if stamp.is_empty() {
        catalogue::message(lang, "instanceTab.temporary.title")
            .unwrap_or("Temporary")
            .to_owned()
    } else {
        catalogue::format(lang, "temporaryInstance.name", &[("time", &stamp)])
    }
}

pub(crate) fn localized_error(err: &TemporaryError) -> String {
    match err.code() {
        Some("temporary_running") => t("temporaryInstance.error.running").to_owned(),
        Some("temporary_open_elsewhere") => t("temporaryInstance.error.openElsewhere").to_owned(),
        Some("temporary_not_temporary" | "temporary_not_found") => {
            t("temporaryInstance.error.notTemporary").to_owned()
        }
        _ => err
            .message()
            .filter(|msg| !msg.trim().is_empty() && !matches!(err, TemporaryError::Other(_)))
            .map(str::to_owned)
            .unwrap_or_else(|| t("rune.open_error").to_owned()),
    }
}

fn emit_temporary_error(s: &mut State, title_key: &'static str, err: &TemporaryError) {
    notifications::emit_outcome(
        s,
        notifications::Category::Projects,
        Some(t(title_key).to_owned()),
        localized_error(err),
        true,
    );
}

pub(crate) fn host_supports_temporary(s: &State) -> bool {
    s.screen
        .launcher()
        .and_then(|l| l.connection.as_ref())
        .is_some_and(|backend| backend.client.supports("temporary-workspaces"))
}

pub(crate) fn bump_reconcile_epoch(s: &mut State) {
    s.temporary.reconcile_epoch = s.temporary.reconcile_epoch.wrapping_add(1);
}

pub(crate) fn set_pending_return_focus(s: &mut State, target: Option<String>) {
    s.temporary.pending_return_focus = target;
}

pub(crate) fn clear_pending_return_focus(s: &mut State) {
    s.temporary.pending_return_focus = None;
}

pub(crate) fn trigger_reconnect_reconcile(s: &mut State) {
    if !workspace::has_temporary_tabs(s) || !host_supports_temporary(s) {
        return;
    }
    let Some((backend, connection_generation)) = s.screen.launcher().and_then(|l| {
        (!l.authentication_required)
            .then(|| Some((l.connection.clone()?, l.connection_generation())))
            .flatten()
    }) else {
        return;
    };
    let epoch = s.temporary.reconcile_epoch;
    let (out, rx) = bounded(1);
    let wake = s.wake.clone();
    let req_backend = backend.clone();
    platform::spawn(async move {
        let result = req_backend.temporary_folders().await;
        if out.try_send(result).is_ok() {
            wake();
        }
    });
    s.temporary.reconcile_folders = Some(Box::new(PendingReconcile {
        connection_generation,
        epoch,
        backend,
        rx,
    }));
}

pub(crate) fn can_create(s: &State) -> bool {
    if s.temporary.in_flight() || !workspace::input_ready(s) || !host_supports_temporary(s) {
        return false;
    }
    let Some(l) = s.screen.launcher() else {
        return false;
    };
    if l.connection.is_none() || l.authentication_required || l.pending {
        return false;
    }
    match &s.workspace {
        Some(ui) => {
            workspace::active_workspace(s).is_none() || ui.tab_count() < workspace::MAX_TABS_LIMIT
        }
        None => true,
    }
}

pub(crate) fn create(s: &mut State, _tx: &mut Tx) -> bool {
    if !can_create(s) {
        return false;
    }
    let Some((backend, connection_generation)) = s
        .screen
        .launcher()
        .and_then(|l| Some((l.connection.clone()?, l.connection_generation())))
    else {
        return false;
    };
    s.temporary.generation = s.temporary.generation.wrapping_add(1);
    let generation = s.temporary.generation;
    let (out, rx) = bounded(1);
    let wake = s.wake.clone();
    let req_backend = backend.clone();
    platform::spawn(async move {
        let result = req_backend.create_temporary_folder().await;
        match out.try_send(result) {
            Ok(()) => wake(),
            Err(err) => {
                if let Ok(created) = err.into_inner() {
                    let _ = req_backend
                        .abandon_temporary_folder(&created.path, None)
                        .await;
                }
            }
        }
    });
    s.temporary.creating = Some(Box::new(PendingCreate {
        generation,
        connection_generation,
        backend,
        rx,
    }));
    true
}

pub(crate) fn can_keep_active(s: &State) -> bool {
    !s.temporary.in_flight()
        && !blocked_by_higher_modal(s)
        && workspace::active_temporary_workspace(s).is_some()
}

pub(crate) fn keep_active(s: &mut State, tx: &mut Tx) -> bool {
    if !can_keep_active(s) {
        return false;
    }
    let Some(info) = workspace::active_temporary_workspace(s) else {
        return false;
    };
    start_keep(s, info, false, tx)
}

pub(crate) fn request_close(s: &mut State, tab_key: &str, tx: &mut Tx) {
    if s.temporary.in_flight() || blocked_by_higher_modal(s) {
        return;
    }
    let Some(info) = workspace::temporary_tab_info(s, tab_key) else {
        workspace::close_ordinary(s, tab_key, tx);
        return;
    };
    if info.untouched {
        start_discard(s, tab_key, true, None, tx);
    } else {
        let _ = open_dialog(s, tab_key, None, tx);
    }
}

fn is_palette_internal_focus(key: &str) -> bool {
    key.starts_with("command-palette-")
        && key != rune_theme_codenomad::shell::command_palette::TRIGGER
}

fn capture_return_focus(s: &mut State, tab_key: &str, tx: &Tx) -> Option<String> {
    s.temporary
        .pending_return_focus
        .take()
        .filter(|key| !is_palette_internal_focus(key))
        .or_else(|| {
            tx.focused()
                .filter(|key| !is_palette_internal_focus(key))
                .map(str::to_owned)
        })
        .or_else(|| Some(format!("t-{tab_key}")))
}

fn same_abandon_target(current: &Backend, orig: &Backend) -> bool {
    current.base == orig.base
        && match (
            current.client.server_identity(),
            orig.client.server_identity(),
        ) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        }
}

fn spawn_abandon(s: &mut State, backend: Backend, path: String, request_id: Option<String>) {
    let (out, rx) = bounded(1);
    let wake = s.wake.clone();
    let req_backend = backend.clone();
    let req_path = path.clone();
    let req_id = request_id.clone();
    platform::spawn(async move {
        let result = req_backend
            .abandon_temporary_folder(&req_path, req_id.as_deref())
            .await;
        if out.try_send(result).is_ok() {
            wake();
        }
    });
    s.temporary.in_flight_abandons.push(InFlightAbandon {
        backend,
        path,
        request_id,
        rx,
    });
}

pub(crate) fn queue_abandon(
    s: &mut State,
    backend: Backend,
    path: String,
    request_id: Option<String>,
) {
    if let Some(l) = s.screen.launcher() {
        if l.authentication_required || s.temporary.in_flight_abandons.len() >= 16 {
            if s.temporary.pending_abandons.len() < 16 {
                s.temporary.pending_abandons.push(QueuedAbandon {
                    backend,
                    path,
                    request_id,
                });
            }
            return;
        }
        if let Some(conn) = l
            .connection
            .as_ref()
            .filter(|c| same_abandon_target(c, &backend))
        {
            let cleanup = conn.clone();
            spawn_abandon(s, cleanup, path, request_id);
            return;
        }
    }
    if s.temporary.in_flight_abandons.len() < 16 {
        spawn_abandon(s, backend, path, request_id);
    } else if s.temporary.pending_abandons.len() < 16 {
        s.temporary.pending_abandons.push(QueuedAbandon {
            backend,
            path,
            request_id,
        });
    }
}

fn open_dialog(s: &mut State, tab_key: &str, captured_focus: Option<String>, tx: &mut Tx) -> bool {
    if is_open(s) || blocked_by_higher_modal(s) {
        return false;
    }
    let return_focus = captured_focus.or_else(|| capture_return_focus(s, tab_key, tx));
    super::Panels::dismiss_outside(s, tx);
    let scope = s.input_scope.clone();
    s.temporary.dialog = Some(Box::new(CloseDialog {
        scope,
        tab_key: tab_key.to_owned(),
        return_focus,
        close_control: WindowCloseState::default(),
    }));
    tx.focus_when_shown(theme::CANCEL, true);
    tx.instant();
    true
}

fn close_dialog_with_focus(s: &mut State, tx: &mut Tx) {
    let target = s.temporary.dialog.take().and_then(|dialog| {
        dialog
            .return_focus
            .or_else(|| Some(format!("t-{}", dialog.tab_key)))
    });
    if let Some(target) = target {
        tx.return_focus(target, tx.focus_visible());
    }
    tx.instant();
}

pub(crate) fn cancel(s: &mut State, tx: &mut Tx) {
    if !is_open(s) || s.temporary.in_flight() {
        return;
    }
    close_dialog_with_focus(s, tx);
}

fn choose_keep(s: &mut State, tx: &mut Tx) {
    if !is_open(s) || s.temporary.in_flight() {
        return;
    }
    let Some(tab_key) = s.temporary.dialog.as_ref().map(|d| d.tab_key.clone()) else {
        return;
    };
    s.temporary.dialog = None;
    let Some(info) = workspace::temporary_tab_info(s, &tab_key) else {
        let _ = workspace::close_after_keep(s, &tab_key, tx);
        return;
    };
    let _ = start_keep(s, info, true, tx);
}

fn choose_discard(s: &mut State, tx: &mut Tx) {
    if !is_open(s) || s.temporary.in_flight() {
        return;
    }
    let Some(dialog) = s.temporary.dialog.take() else {
        return;
    };
    start_discard(s, &dialog.tab_key, false, dialog.return_focus, tx);
}

fn start_keep(
    s: &mut State,
    info: workspace::TemporaryTabInfo,
    close_after: bool,
    tx: &mut Tx,
) -> bool {
    s.temporary.generation = s.temporary.generation.wrapping_add(1);
    let generation = s.temporary.generation;
    let (out, rx) = bounded(1);
    let wake = s.wake.clone();
    let backend = info.backend.clone();
    let req_backend = info.backend;
    let workspace_id = info.project.id;
    platform::spawn(async move {
        let result = req_backend.keep_temporary_workspace(&workspace_id).await;
        if out.try_send(result).is_ok() {
            wake();
        }
    });
    s.temporary.keeping = Some(Box::new(PendingKeep {
        generation,
        backend,
        tab_key: info.tab_key,
        folder: info.folder,
        backend_id: info.backend_id,
        server_id: info.server_id,
        close_after,
        rx,
    }));
    tx.instant();
    true
}

fn start_discard(
    s: &mut State,
    tab_key: &str,
    quiet: bool,
    captured_focus: Option<String>,
    tx: &mut Tx,
) {
    let return_focus = captured_focus.or_else(|| capture_return_focus(s, tab_key, tx));
    let Some(stashed) = workspace::stash_for_discard(s, tab_key, return_focus, tx) else {
        return;
    };
    crate::shell::blank_cleanup::abort_for_project(s, &stashed.project.id);
    s.temporary.generation = s.temporary.generation.wrapping_add(1);
    let generation = s.temporary.generation;
    let (out, rx) = bounded(1);
    let wake = s.wake.clone();
    let backend = stashed.backend.clone();
    let workspace_id = stashed.project.id.clone();
    platform::spawn(async move {
        let result = backend
            .discard_temporary_workspace(&workspace_id, quiet)
            .await;
        if out.try_send(result).is_ok() {
            wake();
        }
    });
    s.temporary.discarding = Some(Box::new(PendingDiscard {
        generation,
        stashed: Box::new(stashed),
        quiet,
        rx,
    }));
    tx.instant();
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
    if event.key == Key::Enter && event.mods == Mods::default() {
        if !tx.key_repeat() {
            match tx.focused() {
                Some(theme::KEEP) => choose_keep(s, tx),
                Some(theme::DISCARD) => choose_discard(s, tx),
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
    let dialog = s.temporary.dialog.as_ref()?;
    let scope = dialog.scope.clone();
    let render_locale = locale();
    let close_control = close_button(
        &dialog.close_control,
        theme::CLOSE,
        layout::dark(),
        None,
        |s: &mut State| {
            &mut s
                .temporary
                .dialog
                .as_mut()
                .expect("temporary close dialog open")
                .close_control
        },
        screen::action_tx(&scope, cancel),
    );
    let key_scope = scope.clone();
    Some(theme::dialog(
        t("temporaryInstance.close.title"),
        t("temporaryInstance.close.message"),
        close_control,
        t("temporaryInstance.close.cancel"),
        t("temporaryInstance.close.keep"),
        t("temporaryInstance.close.discard"),
        s.temporary.in_flight(),
        s.temporary.viewport,
        move |s: &mut State, event, tx| {
            s.current_scope(&key_scope) && with_locale(render_locale, || handle_key(s, event, tx))
        },
        screen::action_tx(&scope, cancel),
        screen::action_tx(&scope, choose_keep),
        screen::action_tx(&scope, choose_discard),
    ))
}

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let mut changed = false;
    if !s.temporary.stale_creates.is_empty() {
        let mut remaining = Vec::new();
        for pending in std::mem::take(&mut s.temporary.stale_creates) {
            match pending.rx.try_recv() {
                Ok(Ok(created)) => {
                    queue_abandon(s, pending.backend, created.path, None);
                    changed = true;
                }
                Ok(Err(_)) | Err(codenomad_client::TryRecvError::Closed) => {}
                Err(codenomad_client::TryRecvError::Empty) => remaining.push(pending),
            }
        }
        s.temporary.stale_creates = remaining;
    }
    if !s.temporary.in_flight_abandons.is_empty() {
        let mut remaining = Vec::new();
        for pending in std::mem::take(&mut s.temporary.in_flight_abandons) {
            match pending.rx.try_recv() {
                Ok(Err(TemporaryError::Unauthorized)) => {
                    changed = true;
                    let _ = crate::settings::authentication_required(s, &pending.backend);
                    let should_requeue = s.screen.launcher().is_some_and(|l| {
                        l.authentication_required
                            || l.connection.as_ref().is_some_and(|conn| {
                                same_abandon_target(conn, &pending.backend)
                                    && !conn.client.same_connection(&pending.backend.client)
                            })
                    });
                    if should_requeue && s.temporary.pending_abandons.len() < 16 {
                        s.temporary.pending_abandons.push(QueuedAbandon {
                            backend: pending.backend,
                            path: pending.path,
                            request_id: pending.request_id,
                        });
                    }
                }
                Ok(_) | Err(codenomad_client::TryRecvError::Closed) => {
                    changed = true;
                }
                Err(codenomad_client::TryRecvError::Empty) => remaining.push(pending),
            }
        }
        s.temporary.in_flight_abandons = remaining;
    }
    if !s.temporary.pending_abandons.is_empty()
        && let Some(conn) = s
            .screen
            .launcher()
            .filter(|l| !l.authentication_required)
            .and_then(|l| l.connection.clone())
    {
        let mut keep = Vec::new();
        for item in std::mem::take(&mut s.temporary.pending_abandons) {
            if same_abandon_target(&conn, &item.backend) {
                if s.temporary.in_flight_abandons.len() < 16 {
                    spawn_abandon(s, conn.clone(), item.path, item.request_id);
                } else if keep.len() < 16 {
                    keep.push(item);
                }
            }
        }
        s.temporary.pending_abandons = keep;
        changed = true;
    }
    if let Some(stashed) = s.temporary.pending_restore.take() {
        let _ = workspace::restore_stashed(s, *stashed, false, tx);
        changed = true;
    }
    if !s.temporary.stopped_queue.is_empty() {
        let stopped = std::mem::take(&mut s.temporary.stopped_queue);
        for (workspace_id, deleted, temporary_retained) in stopped {
            changed |= workspace::detach_stopped_temporary(
                s,
                &workspace_id,
                deleted,
                temporary_retained,
                tx,
            );
        }
    }
    if let Some(folders) = s.temporary.pending_temporary_folders.take() {
        s.temporary.reconcile_epoch = s.temporary.reconcile_epoch.wrapping_add(1);
        changed |= workspace::reconcile_temporary_folders(s, &folders);
    }
    if let Some(result) = s
        .temporary
        .reconcile_folders
        .as_ref()
        .and_then(|pending| pending.rx.try_recv().ok())
    {
        let pending = s.temporary.reconcile_folders.take().unwrap();
        let same_connection = s.screen.launcher().is_some_and(|l| {
            l.connection.is_some()
                && !l.authentication_required
                && l.connection_generation() == pending.connection_generation
        });
        if same_connection && pending.epoch == s.temporary.reconcile_epoch {
            match result {
                Ok(folders) => {
                    changed |= workspace::reconcile_temporary_folders(s, &folders);
                }
                Err(TemporaryError::Unauthorized) => {
                    changed |= crate::settings::authentication_required(s, &pending.backend);
                }
                Err(_) => {}
            }
        }
    }
    if let Some(result) = s
        .temporary
        .creating
        .as_ref()
        .and_then(|pending| pending.rx.try_recv().ok())
    {
        let pending = s.temporary.creating.take().unwrap();
        if pending.generation == s.temporary.generation {
            changed = true;
            match result {
                Ok(created) => {
                    let same_connection = s.screen.launcher().is_some_and(|l| {
                        l.connection.is_some()
                            && !l.authentication_required
                            && l.connection_generation() == pending.connection_generation
                    });
                    if !same_connection || !launcher::open_temporary_folder(s, created.clone(), tx)
                    {
                        queue_abandon(s, pending.backend, created.path, None);
                    }
                }
                Err(TemporaryError::Unauthorized) => {
                    let _ = crate::settings::authentication_required(s, &pending.backend);
                }
                Err(err) => {
                    emit_temporary_error(s, "commands.newTemporaryInstance.label", &err);
                }
            }
        } else if let Ok(created) = result {
            queue_abandon(s, pending.backend, created.path, None);
        }
    }
    if let Some(result) = s
        .temporary
        .keeping
        .as_ref()
        .and_then(|pending| pending.rx.try_recv().ok())
    {
        let pending = s.temporary.keeping.take().unwrap();
        if pending.generation == s.temporary.generation {
            changed = true;
            match result {
                Ok(()) => {
                    s.temporary.reconcile_epoch = s.temporary.reconcile_epoch.wrapping_add(1);
                    workspace::clear_temporary_mark(
                        s,
                        &pending.folder,
                        pending.backend_id.as_deref(),
                        pending.server_id.as_deref(),
                    );
                    if pending.close_after {
                        let _ = workspace::close_after_keep(s, &pending.tab_key, tx);
                    }
                }
                Err(TemporaryError::Unauthorized) => {
                    let _ = crate::settings::authentication_required(s, &pending.backend);
                }
                Err(err) if err.is_not_temporary() => {
                    s.temporary.reconcile_epoch = s.temporary.reconcile_epoch.wrapping_add(1);
                    workspace::clear_temporary_mark(
                        s,
                        &pending.folder,
                        pending.backend_id.as_deref(),
                        pending.server_id.as_deref(),
                    );
                    if pending.close_after {
                        let _ = workspace::close_after_keep(s, &pending.tab_key, tx);
                    }
                }
                Err(err) if err.is_not_found() => {
                    if pending.close_after {
                        let _ = workspace::detach_dead_temporary(s, &pending.tab_key, tx);
                    }
                    emit_temporary_error(s, "temporaryInstance.keep.failedTitle", &err);
                }
                Err(err) => {
                    emit_temporary_error(s, "temporaryInstance.keep.failedTitle", &err);
                }
            }
        }
    }
    if let Some(result) = s
        .temporary
        .discarding
        .as_ref()
        .and_then(|pending| pending.rx.try_recv().ok())
    {
        let pending = *s.temporary.discarding.take().unwrap();
        if pending.generation == s.temporary.generation {
            changed = true;
            match result {
                Ok(()) => {
                    s.temporary.reconcile_epoch = s.temporary.reconcile_epoch.wrapping_add(1);
                    workspace::finish_discarded(s, *pending.stashed, false, false, tx);
                }
                Err(TemporaryError::Unauthorized) => {
                    let backend = pending.stashed.backend.clone();
                    let _ = workspace::restore_stashed(s, *pending.stashed, true, tx);
                    let _ = crate::settings::authentication_required(s, &backend);
                }
                Err(err) if err.is_not_temporary() => {
                    s.temporary.reconcile_epoch = s.temporary.reconcile_epoch.wrapping_add(1);
                    let folder = pending.stashed.folder.clone();
                    let backend_id = pending.stashed.backend_id.clone();
                    let server_id = pending.stashed.server_id.clone();
                    workspace::clear_temporary_mark(
                        s,
                        &folder,
                        backend_id.as_deref(),
                        server_id.as_deref(),
                    );
                    if !pending.quiet {
                        emit_temporary_error(s, "temporaryInstance.discard.failedTitle", &err);
                    }
                    let mut stashed = pending.stashed;
                    stashed.clear_temporary();
                    if workspace::stashed_has_in_memory_state(s, &stashed) {
                        let _ = workspace::restore_stashed(s, *stashed, !pending.quiet, tx);
                    } else {
                        workspace::finish_discarded(s, *stashed, true, true, tx);
                    }
                }
                Err(err) if err.is_not_found() => {
                    // The workspace occurrence is gone on the server (404 proves the occurrence is
                    // absent, not the folder). Preserve any in-memory-only drafts/attachments or
                    // unsaved file edits by restoring the tab without its dead server binding;
                    // otherwise detach locally without sending a duplicate DELETE or stripping
                    // sibling marks.
                    if !pending.quiet || workspace::stashed_has_in_memory_state(s, &pending.stashed)
                    {
                        emit_temporary_error(s, "temporaryInstance.discard.failedTitle", &err);
                    }
                    if workspace::stashed_has_in_memory_state(s, &pending.stashed) {
                        let mut stashed = pending.stashed;
                        stashed.clear_dead_binding();
                        let _ = workspace::restore_stashed(s, *stashed, !pending.quiet, tx);
                    } else {
                        workspace::finish_discarded(s, *pending.stashed, true, false, tx);
                    }
                }
                Err(err) => {
                    let tab_key = pending.stashed.tab_key.clone();
                    let return_focus = pending.stashed.return_focus.clone();
                    let still_temporary = pending.stashed.is_temporary();
                    let neighbour_idle = workspace::restore_stashed(
                        s,
                        *pending.stashed,
                        !pending.quiet || !still_temporary,
                        tx,
                    );
                    if !pending.quiet
                        || !still_temporary
                        || !neighbour_idle
                        || shortcuts::modal_open(s)
                        || !open_dialog(s, &tab_key, return_focus, tx)
                    {
                        emit_temporary_error(s, "temporaryInstance.discard.failedTitle", &err);
                    }
                }
            }
        }
    }
    changed
}
