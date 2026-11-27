use crate::{
    State, launcher,
    platform::workspace_open::{Editor, WorkspaceTarget},
    settings,
    shell::{
        launcher_replaces_project, notifications, shortcuts, sidebar, tab_rename, temporary,
        workspace_open,
    },
    strings::{locale, t},
    workspace,
};
use rune::Tx;
use rune_theme_codenomad::catalogue;
use std::borrow::Cow;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Category {
    Instance,
    Session,
    InputFocus,
    System,
}

impl Category {
    pub(super) const ORDER: [Self; 4] = [
        Self::Instance,
        Self::Session,
        Self::InputFocus,
        Self::System,
    ];

    pub(super) fn label(self) -> &'static str {
        t(match self {
            Self::Instance => "commandPalette.category.instance",
            Self::Session => "commandPalette.category.session",
            Self::InputFocus => "commandPalette.category.inputFocus",
            Self::System => "commandPalette.category.system",
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct CommandItem {
    pub id: &'static str,
    pub label: Cow<'static, str>,
    pub description: Option<Cow<'static, str>>,
    pub keywords: Cow<'static, str>,
    pub category: Category,
    pub shortcut_id: Option<&'static str>,
    pub disabled: bool,
}

impl CommandItem {
    pub(super) fn shortcut(&self, s: &State) -> Option<String> {
        let id = self.shortcut_id?;
        let label = settings::shortcut_label(s, id);
        (!label.is_empty()).then_some(label)
    }

    fn matches(&self, needle: &str) -> bool {
        if self.label.to_lowercase().contains(needle) {
            return true;
        }
        if self
            .description
            .as_deref()
            .is_some_and(|desc| desc.to_lowercase().contains(needle))
        {
            return true;
        }
        if self.category.label().to_lowercase().contains(needle) {
            return true;
        }
        self.keywords
            .split(',')
            .map(str::trim)
            .filter(|kw| !kw.is_empty())
            .any(|kw| kw.to_lowercase().contains(needle))
    }
}

fn static_item(
    id: &'static str,
    label: &'static str,
    description: Option<&'static str>,
    keywords: &'static str,
    category: Category,
    shortcut_id: Option<&'static str>,
    disabled: bool,
) -> CommandItem {
    CommandItem {
        id,
        label: Cow::Borrowed(label),
        description: description.map(Cow::Borrowed),
        keywords: Cow::Borrowed(keywords),
        category,
        shortcut_id,
        disabled,
    }
}

pub(super) fn collect(s: &State) -> Vec<CommandItem> {
    let mut items = Vec::new();
    let has_workspace = s.workspace.is_some();
    let tab_count = s.workspace.as_ref().map_or(0, workspace::Ui::tab_count);
    let workspace_ready = workspace::input_ready(s);
    let project_open = shortcuts::has_project(s);
    let session_open = shortcuts::has_active_session(s);
    let launcher_pending = s.screen.launcher().is_some_and(|l| l.pending);
    let session_nav_allowed = launcher::can_change_session(s) && !launcher_pending;

    // Instance commands
    if has_workspace {
        items.push(static_item(
            "new-instance",
            t("commands.newInstance.label"),
            None,
            t("commands.newInstance.keywords"),
            Category::Instance,
            Some("new-instance"),
            !workspace::can_new(s),
        ));
        items.push(static_item(
            "new-temporary-instance",
            t("commands.newTemporaryInstance.label"),
            None,
            t("commands.newTemporaryInstance.keywords"),
            Category::Instance,
            Some("new-temporary-instance"),
            !temporary::can_create(s),
        ));
        if temporary::can_keep_active(s) {
            items.push(static_item(
                "keep-temporary-instance",
                t("instanceTab.actions.keepTemporary"),
                None,
                t("commands.newTemporaryInstance.keywords"),
                Category::Instance,
                None,
                false,
            ));
        }
        items.push(static_item(
            "close-instance",
            t("commands.closeInstance.label"),
            None,
            t("commands.closeInstance.keywords"),
            Category::Instance,
            Some("close-instance"),
            !workspace::can_close_active(s),
        ));
        if tab_rename::can_rename_active(s) {
            items.push(static_item(
                "rename-instance",
                t("hotkeys.action.instance-rename"),
                None,
                t("instanceTab.actions.rename"),
                Category::Instance,
                Some("instance-rename"),
                false,
            ));
        }
        if tab_count > 1 {
            let can_switch = workspace::can_switch_tabs(s);
            items.push(static_item(
                "next-instance",
                t("commands.nextInstance.label"),
                None,
                t("commands.nextInstance.keywords"),
                Category::Instance,
                Some("instance-next"),
                !can_switch,
            ));
            items.push(static_item(
                "previous-instance",
                t("commands.previousInstance.label"),
                None,
                t("commands.previousInstance.keywords"),
                Category::Instance,
                Some("instance-prev"),
                !can_switch,
            ));
        }
    }
    if workspace_open::available() {
        let can_open_workspace = workspace_open::can_open(s);
        let lang = locale();
        items.push(static_item(
            "open-workspace-folder",
            t("commands.openWorkspace.folder.label"),
            Some(t("commands.openWorkspace.folder.description")),
            t("commands.openWorkspace.folder.keywords"),
            Category::Instance,
            Some("open-workspace-folder"),
            !can_open_workspace,
        ));
        items.push(static_item(
            "open-workspace-terminal",
            t("commands.openWorkspace.terminal.label"),
            Some(t("commands.openWorkspace.terminal.description")),
            t("commands.openWorkspace.terminal.keywords"),
            Category::Instance,
            Some("open-workspace-terminal"),
            !can_open_workspace,
        ));
        let editor_keywords = t("commands.openWorkspace.editor.keywords");
        for editor in Editor::ALL {
            let name = editor.display_name();
            items.push(CommandItem {
                id: editor.command_id(),
                label: Cow::Owned(catalogue::format(
                    lang,
                    "commands.openWorkspace.editor.label",
                    &[("editor", name)],
                )),
                description: Some(Cow::Owned(catalogue::format(
                    lang,
                    "commands.openWorkspace.editor.description",
                    &[("editor", name)],
                ))),
                keywords: Cow::Owned(format!("{name},{editor_keywords}")),
                category: Category::Instance,
                shortcut_id: Some(editor.command_id()),
                disabled: !can_open_workspace,
            });
        }
    }
    if crate::platform::folder_picker_available()
        && launcher_replaces_project(s)
        && s.screen
            .launcher()
            .is_some_and(|l| l.connection.is_some() && !l.authentication_required)
    {
        items.push(static_item(
            "browse-folder",
            t("hotkeys.action.browse-folder"),
            None,
            t("commands.newInstance.keywords"),
            Category::Instance,
            Some("browse-folder"),
            !workspace_ready || launcher_pending,
        ));
    }

    // Session commands
    if project_open {
        let can_create_session = session_nav_allowed
            && !crate::git::placement_unconfirmed(s)
            && s.screen.launcher().is_some_and(|l| {
                !l.creation_uncertain && l.connection.is_some() && l.project.is_some()
            });
        items.push(static_item(
            "new-session",
            t("commands.newSession.label"),
            Some(t("commands.newSession.description")),
            t("commands.newSession.keywords"),
            Category::Session,
            Some("session-new"),
            !can_create_session,
        ));
        if session_open {
            let tab_key = s.workspace.as_ref().map(|ui| ui.active_key()).or_else(|| {
                s.screen
                    .launcher()
                    .and_then(|l| l.project.as_ref())
                    .map(|p| p.id.as_str())
            });
            let can_close_session = session_nav_allowed
                && !s.composer.device.busy()
                && !tab_key.is_some_and(|key| s.documents.has_tab_edits(key))
                && !s
                    .files
                    .as_ref()
                    .is_some_and(|ui| ui.document.pending() || ui.document.dirty())
                && (s.workspace.is_some()
                    || (s.draft.text.is_empty()
                        && s.composer.draft.attachments.is_empty()
                        && s.composer.unconfirmed_id().is_none()));
            items.push(static_item(
                "close-session",
                t("commands.closeSession.label"),
                Some(t("commands.closeSession.description")),
                t("commands.closeSession.keywords"),
                Category::Session,
                Some("close-session"),
                !can_close_session,
            ));
        }
        items.push(static_item(
            "cleanup-blank-sessions",
            t("commands.scrubSessions.label"),
            Some(t("commands.scrubSessions.description")),
            t("commands.scrubSessions.keywords"),
            Category::Session,
            Some("cleanup-blank-sessions"),
            !super::super::blank_cleanup::can_start(s),
        ));
        if s.screen
            .launcher()
            .is_some_and(|l| sidebar::visible_session_ids(l).len() > 1)
        {
            items.push(static_item(
                "next-session",
                t("commands.nextSession.label"),
                None,
                t("commands.nextSession.keywords"),
                Category::Session,
                Some("session-next"),
                !session_nav_allowed,
            ));
            items.push(static_item(
                "previous-session",
                t("commands.previousSession.label"),
                None,
                t("commands.previousSession.keywords"),
                Category::Session,
                Some("session-prev"),
                !session_nav_allowed,
            ));
        }
    }
    if crate::timeline::search::available(s) {
        items.push(static_item(
            "session-search",
            t("hotkeys.action.session-search"),
            None,
            t("messageSection.search.ariaLabel"),
            Category::Session,
            Some("session-search"),
            false,
        ));
    }

    // Input & Focus commands
    if session_open {
        items.push(static_item(
            "clear-input",
            t("commands.clearInput.label"),
            None,
            t("commands.clearInput.keywords"),
            Category::InputFocus,
            None,
            !crate::composer::menu::can_clear(s),
        ));
    }

    // System commands
    if project_open {
        items.push(static_item(
            "toggle-left-panel",
            t("window.menu.leftPanel"),
            None,
            "",
            Category::System,
            None,
            false,
        ));
        items.push(static_item(
            "toggle-right-panel",
            t("window.menu.rightPanel"),
            None,
            "",
            Category::System,
            None,
            false,
        ));
    }
    items.push(static_item(
        "open-notifications",
        t("toastHistory.title"),
        None,
        "",
        Category::System,
        None,
        false,
    ));
    if has_workspace || settings::bound_backend(s).is_some() {
        items.push(static_item(
            "open-settings",
            t("settings.title"),
            None,
            t("commands.openAbout.keywords"),
            Category::System,
            None,
            false,
        ));
    }
    if crate::platform::titlebar::available() {
        items.push(static_item(
            "toggle-fullscreen",
            t("window.menu.native.fullScreen"),
            None,
            "",
            Category::System,
            None,
            false,
        ));
    }

    items
}

pub(super) fn filter(query: &str, items: Vec<CommandItem>) -> Vec<CommandItem> {
    let trimmed = query.trim().to_lowercase();
    let filtered: Vec<CommandItem> = if trimmed.is_empty() {
        items
    } else {
        items
            .into_iter()
            .filter(|item| item.matches(&trimmed))
            .collect()
    };
    let mut ordered = Vec::with_capacity(filtered.len());
    for category in Category::ORDER {
        ordered.extend(
            filtered
                .iter()
                .filter(|item| item.category == category)
                .cloned(),
        );
    }
    ordered
}

pub(super) fn execute(s: &mut State, id: &str, tx: &mut Tx) {
    match id {
        "new-instance" => {
            if workspace::can_new(s) {
                workspace::new_tab(s, tx);
            }
        }
        "new-temporary-instance" => {
            temporary::create(s, tx);
        }
        "keep-temporary-instance" => {
            temporary::keep_active(s, tx);
        }
        "close-instance" => {
            if let Some(key) = s.workspace.as_ref().map(|ui| ui.active_key().to_owned()) {
                workspace::close(s, &key, tx);
            }
        }
        "rename-instance" => {
            tab_rename::open_active(s, tx);
        }
        "next-instance" => workspace::select_relative(s, true, tx),
        "previous-instance" => workspace::select_relative(s, false, tx),
        "open-workspace-folder" => {
            workspace_open::open(s, WorkspaceTarget::Folder);
        }
        "open-workspace-terminal" => {
            workspace_open::open(s, WorkspaceTarget::Terminal);
        }
        "open-workspace-editor-vscode" => {
            workspace_open::open(s, WorkspaceTarget::Editor(Editor::VsCode));
        }
        "open-workspace-editor-cursor" => {
            workspace_open::open(s, WorkspaceTarget::Editor(Editor::Cursor));
        }
        "open-workspace-editor-zed" => {
            workspace_open::open(s, WorkspaceTarget::Editor(Editor::Zed));
        }
        "open-workspace-editor-vscodium" => {
            workspace_open::open(s, WorkspaceTarget::Editor(Editor::VsCodium));
        }
        "browse-folder" => {
            if crate::platform::folder_picker_available()
                && workspace::input_ready(s)
                && s.screen.launcher().is_some_and(|l| !l.pending)
            {
                crate::platform::browse(s, tx);
            }
        }
        "new-session" => launcher::create_blank(s),
        "close-session" => {
            launcher::close_session(s, tx);
        }
        "cleanup-blank-sessions" => {
            super::super::blank_cleanup::open_confirm(s, None, tx);
        }
        "next-session" => shortcuts::select_relative_session(s, true, tx),
        "previous-session" => shortcuts::select_relative_session(s, false, tx),
        "session-search" => crate::timeline::search::open(s, tx),
        "clear-input" => crate::composer::menu::clear(s, tx),
        "toggle-left-panel" => crate::shell::toggle_panel(s, 0, tx),
        "toggle-right-panel" => crate::shell::toggle_panel(s, 1, tx),
        "open-notifications" => notifications::open_history(s, tx),
        "open-settings" => settings::open_preferences(s),
        "toggle-fullscreen" if crate::platform::titlebar::available() => {
            tx.toggle_full_screen();
        }
        _ => {}
    }
}
