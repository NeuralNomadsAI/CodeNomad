#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
mod view;

use crate::{
    State,
    shell::{Panels, directory_browser, shortcuts, temporary},
    workspace::{self, Tab},
};
use rune::{Key, KeyEvent, Mods, Tx, edit::TextEdit};
use std::{collections::HashSet, rc::Rc};

pub(crate) use view::append_overlay;

pub(super) const DIALOG_KEY: &str = "new-instance-launcher";
pub(super) const SEARCH_FIELD: &str = "new-instance-launcher-search";
pub(super) const LIST_KEY: &str = "new-instance-launcher-list";
pub(super) const BROWSE_BUTTON: &str = "new-instance-launcher-browse";
pub(super) const TEMPORARY_BUTTON: &str = "new-instance-launcher-temporary";
pub(crate) const NEW_TAB_KEY: &str = "project-tabs-new";

pub(super) fn item_key(index: usize) -> String {
    format!("new-instance-launcher-item-{index}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RecentEntry {
    pub(super) label: String,
    pub(super) path: String,
    pub(super) open_tab_index: Option<usize>,
}

#[derive(Default)]
pub(crate) struct LauncherMenu {
    open: bool,
    scope: Option<Rc<()>>,
    connection_generation: Option<u64>,
    query: TextEdit,
    selected_path: Option<String>,
    ignore_pointer_hover: bool,
    last_pointer_pos: Option<(f32, f32)>,
    return_focus: Option<String>,
    pending_restore_focus: Option<String>,
    viewport: (f32, f32),
}

impl LauncherMenu {
    pub(crate) fn dismiss(&mut self) {
        self.open = false;
        self.scope = None;
        self.connection_generation = None;
        self.query = TextEdit::new("");
        self.selected_path = None;
        self.ignore_pointer_hover = false;
        self.last_pointer_pos = None;
        self.return_focus = None;
        self.pending_restore_focus = None;
    }

    pub(super) fn dismiss_from_dialog(&mut self) {
        let restore = self.return_focus.take();
        self.dismiss();
        self.pending_restore_focus = restore;
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
    s.shell.new_instance_launcher.open
        && s.shell
            .new_instance_launcher
            .scope
            .as_ref()
            .is_some_and(|scope| s.current_scope(scope))
}

pub(crate) fn is_composing(s: &State) -> bool {
    is_open(s) && s.shell.new_instance_launcher.query.is_composing()
}

pub(crate) fn measure(s: &mut State, [_, _, width, height]: [f32; 4], tx: &mut Tx) -> bool {
    let viewport = &mut s.shell.new_instance_launcher.viewport;
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

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let mut changed = false;
    if let Some(target) = s.shell.new_instance_launcher.pending_restore_focus.take() {
        if !is_open(s) && tx.focused().is_none() {
            tx.return_focus(target, tx.focus_visible());
        }
        changed = true;
    }
    if !is_open(s) {
        if s.shell.new_instance_launcher.open {
            s.shell.new_instance_launcher.dismiss();
            return true;
        }
        return changed;
    }
    let current_conn_gen = s.screen.launcher().map(|l| l.connection_generation());
    if blocked_by_higher_modal(s)
        || current_conn_gen != s.shell.new_instance_launcher.connection_generation
    {
        s.shell.new_instance_launcher.dismiss();
        tx.instant();
        return true;
    }
    changed
}

pub(crate) fn open(s: &mut State, tx: &mut Tx) -> bool {
    open_with_return_focus(s, None, tx)
}

pub(crate) fn open_with_return_focus(
    s: &mut State,
    explicit_return: Option<String>,
    tx: &mut Tx,
) -> bool {
    if is_open(s) || blocked_for_open(s) || s.workspace.is_none() {
        return false;
    }
    let return_focus = explicit_return.or_else(|| {
        tx.focused()
            .filter(|key| !key.starts_with("command-palette-"))
            .map(str::to_owned)
            .or_else(|| Some(NEW_TAB_KEY.to_owned()))
    });
    Panels::dismiss_outside(s, tx);
    let scope = s.input_scope.clone();
    let connection_generation = s.screen.launcher().map(|l| l.connection_generation());
    let menu = &mut s.shell.new_instance_launcher;
    menu.dismiss();
    menu.open = true;
    menu.scope = Some(scope);
    menu.connection_generation = connection_generation;
    menu.query = TextEdit::new("");
    menu.query.focused = true;
    menu.ignore_pointer_hover = true;
    menu.return_focus = return_focus;
    tx.scroll_to_instant(LIST_KEY, 0.0, 0.0);
    tx.focus_when_shown(SEARCH_FIELD, true);
    tx.instant();
    true
}

pub(crate) fn close(s: &mut State, tx: &mut Tx) {
    if !is_open(s) {
        return;
    }
    let target = s.shell.new_instance_launcher.return_focus.take();
    s.shell.new_instance_launcher.dismiss();
    if let Some(target) = target {
        tx.return_focus(target, tx.focus_visible());
    }
    tx.instant();
}

pub(crate) fn handle_strip_secondary_press(s: &mut State, x: f32, y: f32, tx: &mut Tx) {
    if is_open(s) || blocked_for_open(s) || s.workspace.is_none() {
        return;
    }
    if tx.focused() == Some(NEW_TAB_KEY) && tx.by_keys() {
        open_with_return_focus(s, Some(NEW_TAB_KEY.to_owned()), tx);
        return;
    }
    let scope = s.input_scope.clone();
    tx.element_at(x, y, move |s: &mut State, picked, tx| {
        if !s.current_scope(&scope) {
            return;
        }
        let hit_new = picked
            .as_ref()
            .is_some_and(|el| el.key() == Some(NEW_TAB_KEY) || el.path().contains(NEW_TAB_KEY));
        if hit_new {
            open_with_return_focus(s, Some(NEW_TAB_KEY.to_owned()), tx);
        }
    });
}

pub(super) fn all_entries(s: &State) -> Vec<RecentEntry> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    if let Some(ui) = &s.workspace {
        let snapshot = ui.snapshot();
        for (index, tab) in snapshot.tabs.iter().enumerate() {
            if let Tab::Workspace(w) = tab
                && !w.temporary
                && !w.folder.trim().is_empty()
            {
                let key = directory_browser::normalize_folder_key(&w.folder);
                if seen.insert(key) {
                    let label = w
                        .project_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .unwrap_or_else(|| codenomad_client::server_path_basename(&w.folder))
                        .to_owned();
                    entries.push(RecentEntry {
                        label,
                        path: w.folder.clone(),
                        open_tab_index: Some(index),
                    });
                }
            }
        }
    }
    if let Some(l) = s.screen.launcher() {
        for project in &l.projects {
            if project.temporary || project.path.trim().is_empty() {
                continue;
            }
            let key = directory_browser::normalize_folder_key(&project.path);
            if seen.insert(key) {
                entries.push(RecentEntry {
                    label: codenomad_client::server_path_basename(&project.path).to_owned(),
                    path: project.path.clone(),
                    open_tab_index: None,
                });
            }
        }
    }
    entries
}

pub(super) fn filtered_entries(s: &State) -> (Vec<RecentEntry>, bool) {
    let all = all_entries(s);
    let has_any = !all.is_empty();
    let needle = s
        .shell
        .new_instance_launcher
        .query
        .text
        .trim()
        .to_lowercase();
    if needle.is_empty() {
        return (all, has_any);
    }
    let filtered = all
        .into_iter()
        .filter(|entry| {
            entry.label.to_lowercase().contains(&needle)
                || entry.path.to_lowercase().contains(&needle)
        })
        .collect();
    (filtered, has_any)
}

pub(super) fn resolved_selection(
    entries: &[RecentEntry],
    selected_path: Option<&str>,
) -> Option<usize> {
    if entries.is_empty() {
        return None;
    }
    selected_path
        .and_then(|path| entries.iter().position(|entry| entry.path == path))
        .or(Some(0))
}

pub(super) fn select_entry(s: &mut State, path: &str, tx: &mut Tx) {
    let (entries, _) = filtered_entries(s);
    let Some(entry) = entries.into_iter().find(|entry| entry.path == path) else {
        return;
    };
    let return_focus = s.shell.new_instance_launcher.return_focus.take();
    s.shell.new_instance_launcher.dismiss();
    if let Some(index) = entry.open_tab_index {
        workspace::select_index(s, index, tx);
    } else if !directory_browser::open_workspace_folder(s, &entry.path, tx)
        && let Some(target) = return_focus
    {
        tx.return_focus(target, tx.focus_visible());
    }
    tx.instant();
}

pub(super) fn open_browse(s: &mut State, tx: &mut Tx) {
    if !is_open(s) {
        return;
    }
    let return_focus = s.shell.new_instance_launcher.return_focus.take();
    s.shell.new_instance_launcher.dismiss();
    if !directory_browser::open_with_return_focus(s, None, return_focus.clone(), tx)
        && let Some(target) = return_focus
    {
        tx.return_focus(target, tx.focus_visible());
    }
    tx.instant();
}

pub(super) fn open_temporary(s: &mut State, tx: &mut Tx) {
    if !is_open(s) || !temporary::can_create(s) {
        return;
    }
    let return_focus = s.shell.new_instance_launcher.return_focus.take();
    s.shell.new_instance_launcher.dismiss();
    if !temporary::create(s, tx)
        && let Some(target) = return_focus
    {
        tx.return_focus(target, tx.focus_visible());
    }
    tx.instant();
}

fn move_selection(s: &mut State, delta: isize, tx: &mut Tx) {
    let (entries, _) = filtered_entries(s);
    if entries.is_empty() {
        s.shell.new_instance_launcher.selected_path = None;
        return;
    }
    let current = resolved_selection(
        &entries,
        s.shell.new_instance_launcher.selected_path.as_deref(),
    )
    .unwrap_or(0);
    let next = (current as isize + delta).rem_euclid(entries.len() as isize) as usize;
    s.shell.new_instance_launcher.selected_path = Some(entries[next].path.clone());
    s.shell.new_instance_launcher.ignore_pointer_hover = true;
    tx.scroll_into_view_in(LIST_KEY, item_key(next));
}

fn select_edge(s: &mut State, last: bool, tx: &mut Tx) {
    let (entries, _) = filtered_entries(s);
    if entries.is_empty() {
        return;
    }
    let next = if last { entries.len() - 1 } else { 0 };
    s.shell.new_instance_launcher.selected_path = Some(entries[next].path.clone());
    s.shell.new_instance_launcher.ignore_pointer_hover = true;
    tx.scroll_into_view_in(LIST_KEY, item_key(next));
}

pub(crate) fn handle_key(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if !is_open(s) {
        if !blocked_for_open(s)
            && s.workspace.is_some()
            && tx.focused() == Some(NEW_TAB_KEY)
            && ((event.key == Key::Down && event.mods == Mods::default())
                || (event.key == Key::ContextMenu && event.mods == Mods::default())
                || (event.key == Key::Function(10)
                    && event.mods.shift
                    && !event.mods.ctrl
                    && !event.mods.cmd
                    && !event.mods.alt
                    && !event.mods.logo))
        {
            if !tx.key_repeat() {
                open_with_return_focus(s, Some(NEW_TAB_KEY.to_owned()), tx);
            }
            return true;
        }
        return false;
    }
    if is_composing(s) || blocked_by_higher_modal(s) {
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
        Key::Home if !tx.focus_within(SEARCH_FIELD) => {
            select_edge(s, false, tx);
            true
        }
        Key::End if !tx.focus_within(SEARCH_FIELD) => {
            select_edge(s, true, tx);
            true
        }
        Key::Enter
            if !matches!(
                tx.focused(),
                Some("close" | BROWSE_BUTTON | TEMPORARY_BUTTON)
            ) =>
        {
            if !tx.key_repeat() {
                let (entries, _) = filtered_entries(s);
                if let Some(index) = resolved_selection(
                    &entries,
                    s.shell.new_instance_launcher.selected_path.as_deref(),
                ) {
                    let path = entries[index].path.clone();
                    select_entry(s, &path, tx);
                }
            }
            true
        }
        _ => false,
    }
}

#[cfg(test)]
pub(super) fn set_query_for_test(s: &mut State, text: &str) {
    s.shell.new_instance_launcher.query.replace_text(text);
    s.shell.new_instance_launcher.selected_path = None;
}
