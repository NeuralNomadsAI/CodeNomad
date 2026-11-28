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

pub(super) fn modal_open_excluding_clone(s: &State) -> bool {
    #[cfg(target_arch = "wasm32")]
    if crate::platform::pairing::required(s) {
        return true;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if crate::chat::authentication::open(s) {
        return true;
    }
    settings::blocks_shell_shortcuts(s)
        || super::blank_cleanup::is_open(s)
        || super::temporary::is_open(s)
        || super::directory_browser::is_open(s)
        || super::new_instance_launcher::is_open(s)
        || super::tab_rename::is_open(s)
        || super::command_palette::is_open(s)
        || notifications::history_open(s)
        || crate::files::modal_open(s)
        || workspace::mission_confirmation(s).is_some()
        || s.status_services.confirm_open()
        || (!s.screen.is_launcher()
            && (s
                .transcript_display
                .messages
                .confirmation_open(&s.input_scope)
                || s.transcript_display.pictures.preview_open()))
}

pub(super) fn modal_open(s: &State) -> bool {
    modal_open_excluding_clone(s) || crate::launcher::clone_dialog::is_open(s)
}

fn overlay_open(s: &State) -> bool {
    s.composer.picker.open()
        || s.agent.as_ref().is_some_and(|a| a.picker)
        || crate::git::overlay_open(s)
        || crate::timeline::search::overlay_open(s)
        || crate::launcher::recent_menu_open(s)
        || (!s.screen.is_launcher() && s.transcript_display.messages.menu_open())
}

fn any_editor_composing(s: &State) -> bool {
    s.draft.is_composing()
        || super::directory_browser::is_composing(s)
        || super::new_instance_launcher::is_composing(s)
        || super::tab_rename::is_composing(s)
        || super::command_palette::is_composing(s)
        || s.files
            .as_ref()
            .is_some_and(|ui| ui.document.edit().is_composing())
        || crate::git::is_composing(s)
        || workspace::missions_composing(s)
        || crate::timeline::search::is_composing(s)
        || crate::launcher::clone_dialog::is_composing(s)
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

pub(super) fn field_key_blocked(s: &State, event: &KeyEvent, tx: &Tx) -> bool {
    let no_command_mod = !event.mods.ctrl && !event.mods.cmd && !event.mods.alt && !event.mods.logo;
    let is_field_nav = matches!(
        event.key,
        Key::PageUp | Key::PageDown | Key::Insert | Key::ContextMenu
    );
    let is_context_menu = event.mods.shift && event.key == Key::Function(10);
    no_command_mod && (is_field_nav || is_context_menu) && focused_text_field(s, tx)
}

pub(super) fn authentication_required(s: &State) -> bool {
    s.screen
        .launcher()
        .is_some_and(|l| l.authentication_required)
}

pub(super) fn has_project(s: &State) -> bool {
    !launcher_replaces_project(s) && s.screen.launcher().is_some_and(|l| l.project.is_some())
}

pub(super) fn has_active_session(s: &State) -> bool {
    !s.screen.is_launcher()
        && has_project(s)
        && (s.workspace.is_none() || workspace::active_session(s).is_some())
}

fn home_focus_allows_browse(tx: &Tx) -> bool {
    match tx.focused() {
        None => true,
        Some(key) if key.ends_with("/input") => false,
        Some("browse" | "new-temporary-tab" | "refresh-projects") => true,
        Some(key) => {
            (key.starts_with("project-") && !key.starts_with("project-tabs-"))
                || key.starts_with("recent-")
                || key.starts_with("launcher-")
        }
    }
}

fn can_browse_home(s: &State, tx: &Tx) -> bool {
    launcher_replaces_project(s)
        && !focused_text_field(s, tx)
        && home_focus_allows_browse(tx)
        && s.screen
            .launcher()
            .is_some_and(|l| l.connection.is_some() && !l.authentication_required)
}

enum Action {
    OpenCommandPalette,
    BrowseFolder,
    RenameInstance(String),
    OpenWorkspace(crate::platform::workspace_open::WorkspaceTarget),
    NewInstance,
    NewTemporaryInstance,
    CloseInstance,
    InstancePrev,
    InstanceNext,
    AppTab(usize),
    SessionTab(usize),
    SessionNew,
    SessionPrev,
    SessionNext,
    CloseSession,
    CleanupBlankSessions,
    OpenHelp,
    OpenSponsor,
}

#[derive(Clone, Copy)]
enum HelpPage {
    Home,
    Sponsor,
}

fn reserved_shell_key(event: &KeyEvent) -> bool {
    let no_command_mod = !event.mods.ctrl && !event.mods.cmd && !event.mods.alt && !event.mods.logo;
    no_command_mod && event.key == Key::Function(6)
}

pub(crate) fn global_blocked(s: &State, event: &KeyEvent, tx: &Tx) -> bool {
    authentication_required(s)
        || overlay_open(s)
        || any_editor_composing(s)
        || reserved_shell_key(event)
        || field_key_blocked(s, event, tx)
}

pub(super) fn dispatch(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if global_blocked(s, event, tx) {
        return false;
    }
    let browse_home = can_browse_home(s, tx);
    let rename_tab = tx
        .focused()
        .and_then(|key| key.strip_prefix("t-"))
        .filter(|tab_key| workspace::tab_rename_seed(s, tab_key).is_some())
        .map(str::to_owned);
    let can_open_workspace = super::workspace_open::can_open(s);
    let has_workspace = s.workspace.is_some();
    let project_open = has_project(s);
    let session_open = project_open && has_active_session(s);
    let can_cleanup_blank = super::blank_cleanup::can_start(s);
    let Some(action) = settings::match_shortcut(s, event, tx, |matches| {
        if matches("open-command-palette") {
            return Some(Action::OpenCommandPalette);
        }
        if browse_home && matches("browse-folder") {
            return Some(Action::BrowseFolder);
        }
        if let Some(tab_key) = rename_tab.as_ref()
            && matches("instance-rename")
        {
            return Some(Action::RenameInstance(tab_key.clone()));
        }
        if can_open_workspace {
            use crate::platform::workspace_open::{Editor, WorkspaceTarget};
            if matches("open-workspace-folder") {
                return Some(Action::OpenWorkspace(WorkspaceTarget::Folder));
            }
            if matches("open-workspace-terminal") {
                return Some(Action::OpenWorkspace(WorkspaceTarget::Terminal));
            }
            for editor in Editor::ALL {
                if matches(editor.command_id()) {
                    return Some(Action::OpenWorkspace(WorkspaceTarget::Editor(editor)));
                }
            }
        }
        // Match Solid's registration priority: setupTabKeyboardShortcuts,
        // then registerNavigationShortcuts, then commandHotkeyDefinitions.
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
        for index in 0..9 {
            if has_workspace && matches(APP_TAB_IDS[index]) {
                return Some(Action::AppTab(index));
            }
            if project_open && matches(SESSION_TAB_IDS[index]) {
                return Some(Action::SessionTab(index));
            }
        }
        if has_workspace {
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
        if has_workspace && matches("new-temporary-instance") {
            return Some(Action::NewTemporaryInstance);
        }
        if project_open && can_cleanup_blank && matches("cleanup-blank-sessions") {
            return Some(Action::CleanupBlankSessions);
        }
        if matches("open-help") {
            return Some(Action::OpenHelp);
        }
        if matches("open-sponsor") {
            return Some(Action::OpenSponsor);
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
        Action::OpenCommandPalette => super::command_palette::open(s, tx),
        Action::BrowseFolder => {
            let ready =
                workspace::input_ready(s) && s.screen.launcher().is_some_and(|l| !l.pending);
            if ready {
                if crate::platform::folder_picker_available() {
                    crate::platform::browse(s, tx);
                } else {
                    super::directory_browser::open(s, None, tx);
                }
            }
        }
        Action::RenameInstance(tab_key) => {
            super::tab_rename::open_for_tab(s, &tab_key, tx);
        }
        Action::OpenWorkspace(target) => {
            super::workspace_open::open(s, target);
        }
        Action::NewInstance => {
            if workspace::can_new(s) {
                workspace::new_tab(s, tx);
            }
        }
        Action::NewTemporaryInstance => {
            super::temporary::create(s, tx);
        }
        Action::CloseInstance => {
            if let Some(key) = s.workspace.as_ref().map(|ui| ui.active_key().to_owned()) {
                workspace::close(s, &key, tx);
            }
        }
        Action::InstancePrev => workspace::select_relative(s, false, tx),
        Action::InstanceNext => workspace::select_relative(s, true, tx),
        Action::AppTab(index) => workspace::select_index(s, index, tx),
        Action::SessionTab(index) => select_session_index(s, index, tx),
        Action::SessionNew => launcher::create_blank(s),
        Action::SessionPrev => select_relative_session(s, false, tx),
        Action::SessionNext => select_relative_session(s, true, tx),
        Action::CloseSession => {
            launcher::close_session(s, tx);
        }
        Action::CleanupBlankSessions => {
            super::blank_cleanup::open_confirm(s, None, tx);
        }
        Action::OpenHelp => open_help_page(s, tx, HelpPage::Home),
        Action::OpenSponsor => open_help_page(s, tx, HelpPage::Sponsor),
    }
    true
}

pub(crate) fn open_sponsor_page(s: &mut State, tx: &mut Tx) {
    open_help_page(s, tx, HelpPage::Sponsor);
}

fn open_help_page(s: &mut State, tx: &mut Tx, page: HelpPage) {
    let locale = settings::app_locale(s);
    let url = match page {
        HelpPage::Home => format!("https://neuralnomadsai.github.io/CodeNomad/{locale}/"),
        HelpPage::Sponsor => {
            format!("https://neuralnomadsai.github.io/CodeNomad/{locale}/sponsor.html")
        }
    };
    let report_failure = move |s: &mut State, url: &str| {
        let locale = settings::app_locale(s);
        crate::strings::with_locale(locale, || {
            let (title, body) = match page {
                HelpPage::Sponsor => (
                    crate::strings::t("commands.openSponsor.label").into(),
                    crate::strings::t("commands.openSponsor.failed").replace("{url}", url),
                ),
                HelpPage::Home => (
                    crate::strings::t("commands.openHelp.label").into(),
                    crate::strings::t("commands.openHelp.failed").into(),
                ),
            };
            notifications::emit_outcome(
                s,
                notifications::Category::Settings,
                Some(title),
                body,
                true,
            );
        });
    };
    let failed_url = url.clone();
    let launch = tx.open_url_then(&url, move |s: &mut State, result, _| {
        if result.is_err() {
            report_failure(s, &failed_url);
        }
    });
    if launch.is_err() {
        report_failure(s, &url);
    }
}

pub(super) fn select_session_index(s: &mut State, index: usize, tx: &mut Tx) {
    if !launcher::can_change_session(s) || s.screen.launcher().is_none_or(|l| l.pending) {
        return;
    }
    let Some(target) = s
        .screen
        .launcher()
        .and_then(|l| sidebar::visible_session_ids(l).into_iter().nth(index))
    else {
        return;
    };
    launcher::choose(s, target, tx);
}

pub(super) fn select_relative_session(s: &mut State, next: bool, tx: &mut Tx) {
    if !launcher::can_change_session(s) || s.screen.launcher().is_none_or(|l| l.pending) {
        return;
    }
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
