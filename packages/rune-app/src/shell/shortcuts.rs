use super::{launcher_replaces_project, notifications, sidebar};
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
        || workspace::mission_confirmation(s).is_some()
        || (!s.screen.is_launcher()
            && (s
                .transcript_display
                .messages
                .confirmation_open(&s.input_scope)
                || s.transcript_display.pictures.preview_open()))
}

fn overlay_open(s: &State) -> bool {
    s.composer.picker.open()
        || s.agent.as_ref().is_some_and(|a| a.picker)
        || crate::git::overlay_open(s)
        || crate::timeline::search::overlay_open(s)
        || (!s.screen.is_launcher() && s.transcript_display.messages.menu_open())
}

fn any_editor_composing(s: &State) -> bool {
    s.draft.is_composing()
        || s.files
            .as_ref()
            .is_some_and(|ui| ui.document.edit().is_composing())
        || crate::git::is_composing(s)
        || workspace::missions_composing(s)
        || crate::timeline::search::is_composing(s)
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
    // Every rune-kit TextInput/TextArea focuses its inner "input" leaf (file-editor included).
    if matches!(focused, Some("input" | "file-editor")) {
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
    let is_field_nav = matches!(
        event.key,
        Key::PageUp | Key::PageDown | Key::Insert | Key::ContextMenu
    );
    let is_context_menu = event.mods.shift && event.key == Key::Function(10);
    no_command_mod && (is_field_nav || is_context_menu) && focused_text_field(s, tx)
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
}

fn reserved_shell_key(event: &KeyEvent) -> bool {
    let no_command_mod = !event.mods.ctrl && !event.mods.cmd && !event.mods.alt && !event.mods.logo;
    no_command_mod && event.key == Key::Function(6)
}

pub(super) fn dispatch(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if authentication_required(s)
        || overlay_open(s)
        || any_editor_composing(s)
        || reserved_shell_key(event)
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
        // Match Solid's registration priority: setupTabKeyboardShortcuts, then registerNavigationShortcuts.
        if project_open && matches("session-new") {
            return Some(Action::SessionNew);
        }
        if has_workspace {
            if matches("new-instance") {
                return Some(Action::NewInstance);
            }
            if matches("close-instance") {
                return Some(Action::CloseInstance);
            }
        }
        if session_open && matches("close-session") {
            return Some(Action::CloseSession);
        }
        if has_workspace {
            if let Some(index) = APP_TAB_IDS.iter().position(|id| matches(id)) {
                return Some(Action::AppTab(index));
            }
            if matches("instance-prev") {
                return Some(Action::InstancePrev);
            }
            if matches("instance-next") {
                return Some(Action::InstanceNext);
            }
        }
        if project_open {
            if matches("session-prev") {
                return Some(Action::SessionPrev);
            }
            if matches("session-next") {
                return Some(Action::SessionNext);
            }
        }
        None
    }) else {
        return false;
    };
    if tx.key_repeat()
        && !matches!(
            action,
            Action::InstancePrev | Action::InstanceNext | Action::SessionPrev | Action::SessionNext
        )
    {
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
        Action::SessionNew => launcher::create_blank(s),
        Action::SessionPrev => select_relative_session(s, false, tx),
        Action::SessionNext => select_relative_session(s, true, tx),
        Action::CloseSession => {
            launcher::close_session(s, tx);
        }
    }
    true
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
