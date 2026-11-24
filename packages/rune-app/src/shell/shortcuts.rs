use super::{launcher_replaces_project, notifications, sidebar, toggle_panel};
use crate::{State, launcher, settings, workspace};
use rune::{KeyEvent, Tx, edit::TextEdit};

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

fn focused_text_field(tx: &Tx) -> bool {
    tx.focused() == Some("input")
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

fn can_browse_home(s: &State, tx: &Tx) -> bool {
    crate::platform::folder_picker_available()
        && launcher_replaces_project(s)
        && !focused_text_field(tx)
        && s.screen
            .launcher()
            .is_some_and(|l| l.connection.is_some() && !l.authentication_required)
}

pub(super) fn dispatch(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if overlay_open(s) || any_editor_composing(s) {
        return false;
    }
    if can_browse_home(s, tx) && settings::matches_shortcut(s, "browse-folder", event, tx) {
        let ready = workspace::input_ready(s) && s.screen.launcher().is_some_and(|l| !l.pending);
        if ready {
            crate::platform::browse(s, tx);
        }
        return true;
    }
    if !authentication_required(s)
        && s.workspace.is_some()
        && settings::matches_shortcut(s, "new-instance", event, tx)
    {
        if workspace::can_new(s) {
            workspace::new_tab(s, tx);
        }
        return true;
    }
    if s.workspace.is_some() {
        if settings::matches_shortcut(s, "close-instance", event, tx) {
            if let Some(key) = s.workspace.as_ref().map(|ui| ui.active_key().to_owned()) {
                workspace::close(s, &key, tx);
            }
            return true;
        }
        if settings::matches_shortcut(s, "instance-prev", event, tx) {
            workspace::select_relative(s, false, tx);
            return true;
        }
        if settings::matches_shortcut(s, "instance-next", event, tx) {
            workspace::select_relative(s, true, tx);
            return true;
        }
        for (index, id) in APP_TAB_IDS.iter().enumerate() {
            if settings::matches_shortcut(s, id, event, tx) {
                workspace::select_index(s, index, tx);
                return true;
            }
        }
    }
    if has_project(s) {
        if settings::matches_shortcut(s, "session-new", event, tx) {
            open_new_session(s, tx);
            return true;
        }
        if settings::matches_shortcut(s, "session-prev", event, tx) {
            select_relative_session(s, false, tx);
            return true;
        }
        if settings::matches_shortcut(s, "session-next", event, tx) {
            select_relative_session(s, true, tx);
            return true;
        }
        if has_active_session(s) && settings::matches_shortcut(s, "close-session", event, tx) {
            launcher::close_session(s, tx);
            return true;
        }
        for (index, id) in SESSION_TAB_IDS.iter().enumerate() {
            if settings::matches_shortcut(s, id, event, tx) {
                select_session_index(s, index, tx);
                return true;
            }
        }
    }
    false
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
        .then(|| workspace::active_session(s))
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
