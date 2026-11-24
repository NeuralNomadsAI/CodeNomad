use super::{launcher_replaces_project, notifications, sidebar, toggle_panel};
use crate::{State, launcher, settings, workspace};
use rune::{Key, KeyEvent, Tx, edit::TextEdit};

const APP_TAB_IDS: [&str; 9] = [
    "app-tab-1",
    "app-tab-2",
    "app-tab-3",
    "app-tab-4",
    "app-tab-5",
    "app-tab-6",
    "app-tab-7",
    "app-tab-8",
    "app-tab-9",
];

const SESSION_TAB_IDS: [&str; 9] = [
    "session-tab-1",
    "session-tab-2",
    "session-tab-3",
    "session-tab-4",
    "session-tab-5",
    "session-tab-6",
    "session-tab-7",
    "session-tab-8",
    "session-tab-9",
];

pub(super) fn modal_open(s: &State) -> bool {
    #[cfg(target_arch = "wasm32")]
    if crate::platform::pairing::required(s) {
        return true;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if crate::chat::authentication::open(s) {
        return true;
    }
    settings::blocks_shell_shortcuts(s)
        || notifications::history_open(s)
        || crate::files::modal_open(s)
}

fn overlay_open(s: &State) -> bool {
    s.composer.picker.open()
        || s.agent.as_ref().is_some_and(|a| a.picker)
        || crate::git::overlay_open(s)
}

fn any_editor_composing(s: &State) -> bool {
    s.draft.is_composing()
        || s.files
            .as_ref()
            .is_some_and(|ui| ui.document.edit().is_composing())
        || crate::git::is_composing(s)
        || workspace::missions_composing(s)
        || s.screen.launcher().is_some_and(|l| {
            l.address.is_composing()
                || l.password.is_composing()
                || l.folder.is_composing()
                || l.title.is_composing()
                || l.search.is_composing()
        })
        || s.agent.as_ref().is_some_and(|a| {
            a.search.is_composing()
                || a.reasons.values().any(TextEdit::is_composing)
                || a.drafts
                    .values()
                    .any(|draft| draft.edit.is_composing() || draft.custom.is_composing())
        })
}

fn focused_text_field(s: &State, tx: &Tx) -> bool {
    let focused = tx.focused();
    if focused == Some("input") {
        return true;
    }
    #[cfg(target_arch = "wasm32")]
    if focused
        .and_then(|key| key.strip_prefix("input-"))
        .is_some_and(|epoch| epoch.parse().ok() == Some(s.web_composer_input_epoch))
    {
        return true;
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _ = s;
    false
}

fn field_key_blocked(s: &State, event: &KeyEvent, tx: &Tx) -> bool {
    let no_command_mod = !event.mods.ctrl && !event.mods.cmd && !event.mods.alt && !event.mods.logo;
    no_command_mod
        && matches!(event.key, Key::PageUp | Key::PageDown | Key::Insert)
        && focused_text_field(s, tx)
}

fn authentication_required(s: &State) -> bool {
    s.screen
        .launcher()
        .is_some_and(|l| l.authentication_required)
}

fn has_project(s: &State) -> bool {
    !launcher_replaces_project(s) && s.screen.launcher().is_some_and(|l| l.project.is_some())
}

fn has_active_session(s: &State) -> bool {
    !s.screen.is_launcher()
        && has_project(s)
        && (s.workspace.is_none() || workspace::active_session(s).is_some())
}

fn home_focus_allows_browse(tx: &Tx) -> bool {
    match tx.focused() {
        None => true,
        Some("browse" | "open-folder") => true,
        Some(key) => key.starts_with("project-") && !key.starts_with("project-tabs-"),
    }
}

fn can_browse_home(s: &State, tx: &Tx) -> bool {
    crate::platform::folder_picker_available()
        && launcher_replaces_project(s)
        && !focused_text_field(s, tx)
        && home_focus_allows_browse(tx)
        && s.screen
            .launcher()
            .is_some_and(|l| l.connection.is_some() && !l.authentication_required)
}

enum Action {
    BrowseFolder,
    NewInstance,
    CloseInstance,
    InstancePrev,
    InstanceNext,
    AppTab(usize),
    SessionNew,
    SessionPrev,
    SessionNext,
    CloseSession,
    SessionTab(usize),
}

pub(super) fn dispatch(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if authentication_required(s)
        || overlay_open(s)
        || any_editor_composing(s)
        || field_key_blocked(s, event, tx)
    {
        return false;
    }
    let browse_home = can_browse_home(s, tx);
    let has_workspace = s.workspace.is_some();
    let project_open = has_project(s);
    let session_open = project_open && has_active_session(s);
    let Some(action) = settings::match_shortcut(s, event, tx, |matches| {
        if browse_home && matches("browse-folder") {
            return Some(Action::BrowseFolder);
        }
        if has_workspace {
            if matches("new-instance") {
                return Some(Action::NewInstance);
            }
            if matches("close-instance") {
                return Some(Action::CloseInstance);
            }
            if matches("instance-prev") {
                return Some(Action::InstancePrev);
            }
            if matches("instance-next") {
                return Some(Action::InstanceNext);
            }
            if let Some(index) = APP_TAB_IDS.iter().position(|id| matches(id)) {
                return Some(Action::AppTab(index));
            }
        }
        if project_open {
            if matches("session-new") {
                return Some(Action::SessionNew);
            }
            if matches("session-prev") {
                return Some(Action::SessionPrev);
            }
            if matches("session-next") {
                return Some(Action::SessionNext);
            }
            if session_open && matches("close-session") {
                return Some(Action::CloseSession);
            }
            if let Some(index) = SESSION_TAB_IDS.iter().position(|id| matches(id)) {
                return Some(Action::SessionTab(index));
            }
        }
        None
    }) else {
        return false;
    };
    if tx.key_repeat() {
        return true;
    }
    match action {
        Action::BrowseFolder => {
            let ready =
                workspace::input_ready(s) && s.screen.launcher().is_some_and(|l| !l.pending);
            if ready {
                crate::platform::browse(s, tx);
            }
        }
        Action::NewInstance => {
            if workspace::can_new(s) {
                workspace::new_tab(s, tx);
            }
        }
        Action::CloseInstance => {
            if let Some(key) = s.workspace.as_ref().map(|ui| ui.active_key().to_owned()) {
                workspace::close(s, &key, tx);
            }
        }
        Action::InstancePrev => workspace::select_relative(s, false, tx),
        Action::InstanceNext => workspace::select_relative(s, true, tx),
        Action::AppTab(index) => workspace::select_index(s, index, tx),
        Action::SessionNew => open_new_session(s, tx),
        Action::SessionPrev => select_relative_session(s, false, tx),
        Action::SessionNext => select_relative_session(s, true, tx),
        Action::CloseSession => {
            launcher::close_session(s, tx);
        }
        Action::SessionTab(index) => select_session_index(s, index, tx),
    }
    true
}

fn open_new_session(s: &mut State, tx: &mut Tx) {
    if !launcher::can_change_session(s) || s.screen.launcher().is_none_or(|l| l.pending) {
        return;
    }
    if !s.shell.visible(0) {
        toggle_panel(s, 0, tx);
    }
    if let Some(l) = s.screen.launcher_mut() {
        l.show_title = true;
        tx.focus_when_shown("session-title", true);
        tx.instant();
    }
}

fn select_relative_session(s: &mut State, next: bool, tx: &mut Tx) {
    let Some(ids) = s.screen.launcher().map(sidebar::visible_session_ids) else {
        return;
    };
    if ids.is_empty() {
        return;
    }
    let current = (!s.screen.is_launcher())
        .then(|| {
            workspace::active_session(s)
                .or_else(|| s.screen.launcher().and_then(|l| l.visits.current()))
        })
        .flatten();
    let current_index = current.and_then(|id| ids.iter().position(|row| row == id));
    let target = if next {
        match current_index {
            Some(index) => (index + 1) % ids.len(),
            None => 0,
        }
    } else {
        match current_index {
            Some(index) if index > 0 => index - 1,
            _ => ids.len() - 1,
        }
    };
    launcher::choose(s, ids[target].clone(), tx);
}

fn select_session_index(s: &mut State, index: usize, tx: &mut Tx) {
    let Some(target) = s
        .screen
        .launcher()
        .and_then(|l| sidebar::visible_session_ids(l).into_iter().nth(index))
    else {
        return;
    };
    launcher::choose(s, target, tx);
}
