use crate::{
    State, launcher, settings,
    shell::{launcher_replaces_project, notifications, shortcuts, sidebar},
    strings::t,
    workspace,
};
use rune::Tx;

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
    pub label: &'static str,
    pub description: Option<&'static str>,
    pub keywords: &'static str,
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
        items.push(CommandItem {
            id: "new-instance",
            label: t("commands.newInstance.label"),
            description: Some(t("commands.newInstance.description")),
            keywords: t("commands.newInstance.keywords"),
            category: Category::Instance,
            shortcut_id: Some("new-instance"),
            disabled: !workspace::can_new(s),
        });
        items.push(CommandItem {
            id: "close-instance",
            label: t("commands.closeInstance.label"),
            description: None,
            keywords: t("commands.closeInstance.keywords"),
            category: Category::Instance,
            shortcut_id: Some("close-instance"),
            disabled: !workspace_ready,
        });
        if tab_count > 1 {
            items.push(CommandItem {
                id: "next-instance",
                label: t("commands.nextInstance.label"),
                description: None,
                keywords: t("commands.nextInstance.keywords"),
                category: Category::Instance,
                shortcut_id: Some("instance-next"),
                disabled: !workspace_ready,
            });
            items.push(CommandItem {
                id: "previous-instance",
                label: t("commands.previousInstance.label"),
                description: None,
                keywords: t("commands.previousInstance.keywords"),
                category: Category::Instance,
                shortcut_id: Some("instance-prev"),
                disabled: !workspace_ready,
            });
        }
    }
    if crate::platform::folder_picker_available()
        && launcher_replaces_project(s)
        && s.screen
            .launcher()
            .is_some_and(|l| l.connection.is_some() && !l.authentication_required)
    {
        items.push(CommandItem {
            id: "browse-folder",
            label: t("hotkeys.action.browse-folder"),
            description: None,
            keywords: t("commands.newInstance.keywords"),
            category: Category::Instance,
            shortcut_id: Some("browse-folder"),
            disabled: !workspace_ready || launcher_pending,
        });
    }

    // Session commands
    if project_open {
        items.push(CommandItem {
            id: "new-session",
            label: t("commands.newSession.label"),
            description: Some(t("commands.newSession.description")),
            keywords: t("commands.newSession.keywords"),
            category: Category::Session,
            shortcut_id: Some("session-new"),
            disabled: !session_nav_allowed,
        });
        if session_open {
            items.push(CommandItem {
                id: "close-session",
                label: t("commands.closeSession.label"),
                description: Some(t("commands.closeSession.description")),
                keywords: t("commands.closeSession.keywords"),
                category: Category::Session,
                shortcut_id: Some("close-session"),
                disabled: !session_nav_allowed,
            });
        }
        if s.screen
            .launcher()
            .is_some_and(|l| sidebar::visible_session_ids(l).len() > 1)
        {
            items.push(CommandItem {
                id: "next-session",
                label: t("commands.nextSession.label"),
                description: None,
                keywords: t("commands.nextSession.keywords"),
                category: Category::Session,
                shortcut_id: Some("session-next"),
                disabled: !session_nav_allowed,
            });
            items.push(CommandItem {
                id: "previous-session",
                label: t("commands.previousSession.label"),
                description: None,
                keywords: t("commands.previousSession.keywords"),
                category: Category::Session,
                shortcut_id: Some("session-prev"),
                disabled: !session_nav_allowed,
            });
        }
    }
    if crate::timeline::search::available(s) {
        items.push(CommandItem {
            id: "session-search",
            label: t("hotkeys.action.session-search"),
            description: None,
            keywords: t("messageSection.search.ariaLabel"),
            category: Category::Session,
            shortcut_id: Some("session-search"),
            disabled: false,
        });
    }

    // Input & Focus commands
    if session_open {
        let empty = s.draft.text.is_empty()
            && s.composer.draft.attachments.is_empty()
            && s.composer.draft.literal_spans.is_empty();
        items.push(CommandItem {
            id: "clear-input",
            label: t("commands.clearInput.label"),
            description: None,
            keywords: t("commands.clearInput.keywords"),
            category: Category::InputFocus,
            shortcut_id: None,
            disabled: empty || s.composer.pending() || s.composer.editing_locked(),
        });
    }

    // System commands
    if project_open {
        items.push(CommandItem {
            id: "toggle-left-panel",
            label: t("window.menu.leftPanel"),
            description: None,
            keywords: "",
            category: Category::System,
            shortcut_id: None,
            disabled: false,
        });
        items.push(CommandItem {
            id: "toggle-right-panel",
            label: t("window.menu.rightPanel"),
            description: None,
            keywords: "",
            category: Category::System,
            shortcut_id: None,
            disabled: false,
        });
    }
    items.push(CommandItem {
        id: "open-notifications",
        label: t("toastHistory.title"),
        description: None,
        keywords: "",
        category: Category::System,
        shortcut_id: None,
        disabled: false,
    });
    if has_workspace || settings::bound_backend(s).is_some() {
        items.push(CommandItem {
            id: "open-settings",
            label: t("settings.title"),
            description: None,
            keywords: t("commands.openAbout.keywords"),
            category: Category::System,
            shortcut_id: None,
            disabled: false,
        });
    }
    if crate::platform::titlebar::available() {
        items.push(CommandItem {
            id: "toggle-fullscreen",
            label: t("window.menu.native.fullScreen"),
            description: None,
            keywords: "",
            category: Category::System,
            shortcut_id: None,
            disabled: false,
        });
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
        "close-instance" => {
            if let Some(key) = s.workspace.as_ref().map(|ui| ui.active_key().to_owned()) {
                workspace::close(s, &key, tx);
            }
        }
        "next-instance" => workspace::select_relative(s, true, tx),
        "previous-instance" => workspace::select_relative(s, false, tx),
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
        "next-session" => shortcuts::select_relative_session(s, true, tx),
        "previous-session" => shortcuts::select_relative_session(s, false, tx),
        "session-search" => crate::timeline::search::open(s, tx),
        "clear-input" => {
            if !s.composer.pending() && !s.composer.editing_locked() {
                s.draft.clear();
                s.composer.draft = Default::default();
                s.composer.picker.reset();
                s.composer.recall = None;
                s.composer.mark_edited();
                workspace::draft_changed(s, tx);
            }
        }
        "toggle-left-panel" => crate::shell::toggle_panel(s, 0, tx),
        "toggle-right-panel" => crate::shell::toggle_panel(s, 1, tx),
        "open-notifications" => notifications::open_history(s, tx),
        "open-settings" => settings::open_preferences(s),
        "toggle-fullscreen" => {
            if crate::platform::titlebar::available() {
                tx.toggle_full_screen();
            }
        }
        _ => {}
    }
}
