#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
mod view;

use crate::{
    State,
    backend::Backend,
    launcher, platform,
    shell::{Panels, shortcuts},
    strings::t,
    workspace::{self, Tab},
};
use codenomad_client::{
    Receiver, bounded,
    folders::{Folder, Folders},
};
use rune::{Key, KeyEvent, Mods, Tx, edit::TextEdit};
use std::rc::Rc;

pub(crate) use view::append_overlay;

pub(crate) type SelectCallback = Rc<dyn Fn(&mut State, String, &mut Tx)>;

pub(super) const DIALOG_KEY: &str = "directory-browser";
pub(super) const PATH_FIELD: &str = "directory-browser-path";
pub(super) const PATH_FOCUS: &str = "directory-browser-path/value/input";
pub(super) const LIST_KEY: &str = "directory-browser-list";
pub(super) const PARENT_BUTTON: &str = "directory-browser-parent";
pub(super) const HOME_BUTTON: &str = "directory-browser-home";
pub(super) const GO_BUTTON: &str = "directory-browser-go";
pub(super) const RETRY_BUTTON: &str = "directory-browser-retry";
pub(super) const CANCEL_BUTTON: &str = "directory-browser-cancel";
pub(super) const OPEN_BUTTON: &str = "directory-browser-open";
pub(super) const UP_ROW: &str = "directory-browser-row-up";

pub(super) fn folder_row_key(index: usize) -> String {
    format!("directory-browser-row-{index}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum RowSelection {
    Parent,
    Folder(usize),
}

struct InFlight {
    request_id: u64,
    connection_generation: u64,
    requested_path: Option<String>,
    fallback_on_error: bool,
    rx: Receiver<Result<Folders, String>>,
}

#[derive(Default)]
pub(crate) struct Browser {
    open: bool,
    scope: Option<Rc<()>>,
    backend: Option<Backend>,
    connection_generation: u64,
    request_id: u64,
    in_flight: Option<InFlight>,
    current_path: String,
    parent_path: Option<String>,
    home_path: Option<String>,
    folders: Vec<Folder>,
    path_input: TextEdit,
    selected: Option<RowSelection>,
    ignore_pointer_hover: bool,
    last_pointer_pos: Option<(f32, f32)>,
    error: Option<String>,
    return_focus: Option<String>,
    pending_restore_focus: Option<String>,
    on_select: Option<SelectCallback>,
    viewport: (f32, f32),
}

impl Browser {
    pub(crate) fn dismiss(&mut self) {
        self.open = false;
        self.scope = None;
        self.backend = None;
        self.in_flight = None;
        self.current_path.clear();
        self.parent_path = None;
        self.home_path = None;
        self.folders.clear();
        self.path_input = TextEdit::new("");
        self.selected = None;
        self.ignore_pointer_hover = false;
        self.last_pointer_pos = None;
        self.error = None;
        self.return_focus = None;
        self.pending_restore_focus = None;
        self.on_select = None;
    }

    pub(super) fn dismiss_from_dialog(&mut self) {
        let restore = self.return_focus.take();
        self.dismiss();
        self.pending_restore_focus = restore;
    }

    pub(super) fn is_loading(&self) -> bool {
        self.in_flight.is_some()
    }

    pub(super) fn effective_target_path(&self) -> Option<String> {
        let typed = self.path_input.text.trim();
        if !typed.is_empty() {
            Some(typed.to_owned())
        } else if !self.current_path.is_empty() {
            Some(self.current_path.clone())
        } else {
            None
        }
    }
}

pub(super) fn blocked_by_higher_modal(s: &State) -> bool {
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

fn blocked_for_open(s: &State) -> bool {
    blocked_by_higher_modal(s) || shortcuts::modal_open(s)
}

pub(crate) fn is_open(s: &State) -> bool {
    s.shell.directory_browser.open
        && s.shell
            .directory_browser
            .scope
            .as_ref()
            .is_some_and(|scope| s.current_scope(scope))
}

pub(crate) fn is_composing(s: &State) -> bool {
    is_open(s) && s.shell.directory_browser.path_input.is_composing()
}

pub(crate) fn can_open(s: &State) -> bool {
    !blocked_by_higher_modal(s)
        && workspace::input_ready(s)
        && s.screen
            .launcher()
            .is_some_and(|l| l.connection.is_some() && !l.authentication_required && !l.pending)
}

pub(crate) fn measure(s: &mut State, [_, _, width, height]: [f32; 4], tx: &mut Tx) -> bool {
    let viewport = &mut s.shell.directory_browser.viewport;
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

pub(crate) fn open(s: &mut State, initial_path: Option<String>, tx: &mut Tx) -> bool {
    open_with_callback(s, initial_path, None, None, tx)
}

pub(crate) fn open_with_return_focus(
    s: &mut State,
    initial_path: Option<String>,
    return_focus: Option<String>,
    tx: &mut Tx,
) -> bool {
    open_with_callback(s, initial_path, return_focus, None, tx)
}

pub(crate) fn open_with_callback(
    s: &mut State,
    initial_path: Option<String>,
    explicit_return: Option<String>,
    on_select: Option<SelectCallback>,
    tx: &mut Tx,
) -> bool {
    if is_open(s) || blocked_for_open(s) || !can_open(s) {
        return false;
    }
    let Some((backend, connection_generation, default_seed)) = s.screen.launcher().and_then(|l| {
        let backend = l.connection.clone()?;
        let seed = l.project.as_ref().map(|p| p.path.clone()).or_else(|| {
            let typed = l.folder.text.trim();
            (!typed.is_empty()).then(|| typed.to_owned())
        });
        Some((backend, l.connection_generation(), seed))
    }) else {
        return false;
    };
    let return_focus = if explicit_return.is_some() {
        explicit_return
    } else {
        let prior = tx
            .focused()
            .filter(|key| !key.starts_with("command-palette-"))
            .map(str::to_owned);
        let floating_fallback = if s.shell.floating_sessions().is_some() {
            Some("sessions-panel-toggle".to_owned())
        } else if s.shell.has_floating() {
            Some("right-panel-toggle".to_owned())
        } else {
            None
        };
        match floating_fallback {
            Some(toggle_key) => Some(toggle_key),
            None => prior,
        }
    };
    Panels::dismiss_outside(s, tx);
    let scope = s.input_scope.clone();
    let seed = initial_path
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty())
        .or(default_seed);
    let browser = &mut s.shell.directory_browser;
    browser.dismiss();
    browser.open = true;
    browser.scope = Some(scope);
    browser.backend = Some(backend);
    browser.connection_generation = connection_generation;
    browser.path_input = TextEdit::new(seed.as_deref().unwrap_or(""));
    browser.path_input.focused = true;
    browser.ignore_pointer_hover = true;
    browser.return_focus = return_focus;
    browser.on_select = on_select;
    let fallback_on_error = seed.is_some();
    start_load(s, seed, fallback_on_error);
    tx.scroll_to_instant(LIST_KEY, 0.0, 0.0);
    tx.focus_when_shown(PATH_FOCUS, true);
    tx.instant();
    true
}

pub(crate) fn close(s: &mut State, tx: &mut Tx) {
    if !is_open(s) {
        return;
    }
    let target = s.shell.directory_browser.return_focus.take();
    s.shell.directory_browser.dismiss();
    if let Some(target) = target {
        tx.return_focus(target, tx.focus_visible());
    }
    tx.instant();
}

pub(super) fn navigate(s: &mut State, path: Option<String>, tx: &mut Tx) {
    if !is_open(s) {
        return;
    }
    s.shell.directory_browser.selected = None;
    s.shell.directory_browser.ignore_pointer_hover = true;
    s.shell.directory_browser.error = None;
    start_load(s, path, false);
    tx.scroll_to_instant(LIST_KEY, 0.0, 0.0);
    tx.instant();
}

pub(super) fn submit_path_input(s: &mut State, tx: &mut Tx) {
    if !is_open(s) {
        return;
    }
    let trimmed = s.shell.directory_browser.path_input.text.trim().to_owned();
    if trimmed.is_empty() {
        navigate(s, None, tx);
    } else {
        navigate(s, Some(trimmed), tx);
    }
}

pub(super) fn retry(s: &mut State, tx: &mut Tx) {
    if !is_open(s) {
        return;
    }
    let target = s.shell.directory_browser.effective_target_path();
    navigate(s, target, tx);
}

pub(super) fn confirm_current(s: &mut State, tx: &mut Tx) {
    if !is_open(s) {
        return;
    }
    let Some(path) = s.shell.directory_browser.effective_target_path() else {
        return;
    };
    confirm_path(s, path, tx);
}

pub(super) fn confirm_path(s: &mut State, path: String, tx: &mut Tx) {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return;
    }
    let path = trimmed.to_owned();
    let callback = s.shell.directory_browser.on_select.take();
    let return_focus = s.shell.directory_browser.return_focus.take();
    s.shell.directory_browser.dismiss();
    if let Some(callback) = callback {
        callback(s, path, tx);
        if let Some(target) = return_focus {
            tx.return_focus(target, tx.focus_visible());
        }
    } else {
        open_workspace_folder(s, &path, tx);
    }
    tx.instant();
}

pub(crate) fn open_workspace_folder(s: &mut State, path: &str, tx: &mut Tx) {
    if let Some(index) = open_tab_index_for_path(s, path) {
        workspace::select_index(s, index, tx);
        return;
    }
    launcher::choose_project(s, path, tx);
}

pub(crate) fn normalize_folder_key(path: &str) -> String {
    let trimmed = path.trim();
    let stripped = trimmed.trim_end_matches(['/', '\\']);
    if stripped.is_empty() {
        return trimmed.to_owned();
    }
    if stripped.len() == 2 && stripped.as_bytes()[1] == b':' {
        return format!("{stripped}\\").to_ascii_lowercase();
    }
    if trimmed.contains('\\') || (stripped.len() >= 2 && stripped.as_bytes()[1] == b':') {
        stripped.replace('/', "\\").to_ascii_lowercase()
    } else {
        stripped.to_owned()
    }
}

pub(crate) fn open_tab_index_for_path(s: &State, path: &str) -> Option<usize> {
    let target = normalize_folder_key(path);
    let snapshot = s.workspace.as_ref()?.snapshot();
    snapshot.tabs.iter().position(|tab| match tab {
        Tab::Workspace(w) if !w.temporary => normalize_folder_key(&w.folder) == target,
        _ => false,
    })
}

fn start_load(s: &mut State, path: Option<String>, fallback_on_error: bool) {
    let Some(backend) = s.shell.directory_browser.backend.clone() else {
        return;
    };
    let connection_generation = s.shell.directory_browser.connection_generation;
    s.shell.directory_browser.request_id = s.shell.directory_browser.request_id.wrapping_add(1);
    let request_id = s.shell.directory_browser.request_id;
    let (out, rx) = bounded(1);
    let wake = s.wake.clone();
    let requested = path.clone();
    s.shell.directory_browser.error = None;
    s.shell.directory_browser.in_flight = Some(InFlight {
        request_id,
        connection_generation,
        requested_path: path.clone(),
        fallback_on_error,
        rx,
    });
    platform::spawn(async move {
        let result = backend
            .folders(requested.as_deref())
            .await
            .map_err(|err| err.to_string());
        let _ = out.send(result).await;
        wake();
    });
}

fn sort_folders(folders: &mut [Folder]) {
    folders.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.path.cmp(&b.path))
    });
}

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let mut changed = false;
    if let Some(target) = s.shell.directory_browser.pending_restore_focus.take() {
        if !is_open(s) && tx.focused().is_none() {
            tx.return_focus(target, tx.focus_visible());
        }
        changed = true;
    }
    if !is_open(s) {
        if s.shell.directory_browser.open {
            s.shell.directory_browser.dismiss();
            return true;
        }
        return changed;
    }
    let current_conn_gen = s
        .screen
        .launcher()
        .filter(|l| l.connection.is_some() && !l.authentication_required)
        .map(|l| l.connection_generation());
    if current_conn_gen != Some(s.shell.directory_browser.connection_generation) {
        s.shell.directory_browser.dismiss();
        tx.instant();
        return true;
    }
    let Some(in_flight) = s.shell.directory_browser.in_flight.as_ref() else {
        return changed;
    };
    let Ok(result) = in_flight.rx.try_recv() else {
        return changed;
    };
    let finished = s
        .shell
        .directory_browser
        .in_flight
        .take()
        .expect("in-flight directory listing");
    if finished.request_id != s.shell.directory_browser.request_id
        || finished.connection_generation != s.shell.directory_browser.connection_generation
    {
        return true;
    }
    match result {
        Ok(mut listing) => {
            sort_folders(&mut listing.folders);
            let next_path = listing.absolute.unwrap_or_default();
            let browser = &mut s.shell.directory_browser;
            browser.current_path = next_path.clone();
            browser.parent_path = listing.parent;
            browser.home_path = listing.home;
            browser.folders = listing.folders;
            browser.path_input = TextEdit::new(&next_path);
            browser.selected = None;
            browser.ignore_pointer_hover = true;
            browser.error = None;
        }
        Err(_) if finished.fallback_on_error && finished.requested_path.is_some() => {
            start_load(s, None, false);
        }
        Err(_) => {
            s.shell.directory_browser.error =
                Some(t("directoryBrowser.load.errorFallback").to_owned());
        }
    }
    tx.instant();
    true
}

fn navigable_rows(browser: &Browser) -> Vec<RowSelection> {
    let mut rows =
        Vec::with_capacity(browser.folders.len() + usize::from(browser.parent_path.is_some()));
    if browser.parent_path.is_some() {
        rows.push(RowSelection::Parent);
    }
    for index in 0..browser.folders.len() {
        rows.push(RowSelection::Folder(index));
    }
    rows
}

fn row_key(selection: &RowSelection) -> String {
    match selection {
        RowSelection::Parent => UP_ROW.to_owned(),
        RowSelection::Folder(index) => folder_row_key(*index),
    }
}

fn move_selection(s: &mut State, delta: isize, tx: &mut Tx) {
    let rows = navigable_rows(&s.shell.directory_browser);
    if rows.is_empty() {
        s.shell.directory_browser.selected = None;
        return;
    }
    let next_index = match s
        .shell
        .directory_browser
        .selected
        .as_ref()
        .and_then(|sel| rows.iter().position(|item| item == sel))
    {
        Some(current) => (current as isize + delta).rem_euclid(rows.len() as isize) as usize,
        None if delta >= 0 => 0,
        None => rows.len() - 1,
    };
    let next = rows[next_index].clone();
    let key = row_key(&next);
    s.shell.directory_browser.selected = Some(next);
    s.shell.directory_browser.ignore_pointer_hover = true;
    tx.scroll_into_view_in(LIST_KEY, key);
}

fn select_edge(s: &mut State, last: bool, tx: &mut Tx) {
    let rows = navigable_rows(&s.shell.directory_browser);
    let next = if last { rows.last() } else { rows.first() }.cloned();
    if let Some(selection) = next {
        let key = row_key(&selection);
        s.shell.directory_browser.selected = Some(selection);
        s.shell.directory_browser.ignore_pointer_hover = true;
        tx.scroll_into_view_in(LIST_KEY, key);
    }
}

fn activate_selection(s: &mut State, tx: &mut Tx) -> bool {
    let Some(selection) = s.shell.directory_browser.selected.clone() else {
        return false;
    };
    match selection {
        RowSelection::Parent => {
            if let Some(parent) = s.shell.directory_browser.parent_path.clone() {
                navigate(s, Some(parent), tx);
                return true;
            }
            false
        }
        RowSelection::Folder(index) => {
            if let Some(folder) = s.shell.directory_browser.folders.get(index) {
                let path = folder.path.clone();
                navigate(s, Some(path), tx);
                return true;
            }
            false
        }
    }
}

pub(crate) fn handle_key(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if !is_open(s) || is_composing(s) || blocked_by_higher_modal(s) {
        return false;
    }
    if event.key == Key::Escape && event.mods == Mods::default() {
        if !tx.key_repeat() {
            close(s, tx);
        }
        return true;
    }
    if event.mods != Mods::default() {
        return false;
    }
    match event.key {
        Key::Down => {
            move_selection(s, 1, tx);
            true
        }
        Key::Up => {
            move_selection(s, -1, tx);
            true
        }
        Key::Home if tx.focused() != Some(PATH_FOCUS) => {
            select_edge(s, false, tx);
            true
        }
        Key::End if tx.focused() != Some(PATH_FOCUS) => {
            select_edge(s, true, tx);
            true
        }
        Key::Enter
            if !matches!(
                tx.focused(),
                Some(
                    "close"
                        | PARENT_BUTTON
                        | HOME_BUTTON
                        | GO_BUTTON
                        | RETRY_BUTTON
                        | CANCEL_BUTTON
                        | OPEN_BUTTON
                )
            ) =>
        {
            if !tx.key_repeat() {
                let typed = s.shell.directory_browser.path_input.text.trim();
                let edited = typed != s.shell.directory_browser.current_path.as_str();
                if edited || s.shell.directory_browser.selected.is_none() {
                    submit_path_input(s, tx);
                } else {
                    activate_selection(s, tx);
                }
            }
            true
        }
        _ => false,
    }
}

#[cfg(test)]
pub(super) fn set_path_input_for_test(s: &mut State, path: &str) {
    s.shell.directory_browser.path_input = TextEdit::new(path);
}

#[cfg(test)]
pub(super) fn current_path_for_test(s: &State) -> &str {
    &s.shell.directory_browser.current_path
}
