mod general;
mod lifecycle;
pub(super) use lifecycle::{closed, focus, save_warning, spec};
#[cfg(test)]
mod tests;

use super::{
    info, notification_settings, opencode,
    preferences::{Owner, Preferences},
    providers, remote, render_with,
};
use crate::strings::t;
use rune::{Cx, El, col, text};
use rune_theme_codenomad::{
    layout::{self, Layout},
    settings as chrome,
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

#[derive(Default)]
pub(super) struct Window {
    shared: Rc<RefCell<Preferences>>,
    token: Option<Rc<Cell<bool>>>,
    close_request: Option<Rc<CloseRequest>>,
    confirm_close: bool,
    closing: bool,
    general: super::general::Controls,
    transcript_picker: Cell<Option<super::TranscriptRow>>,
    behavior: super::behavior::General,
    memory_help_failed: bool,
    memory_editor: super::memory::editor::Editor,
    seen_revision: u64,
    section: Section,
    pending_section: Option<Section>,
    recording_shortcut: bool,
    shortcut_capture: super::shortcuts::editor::Capture,
    shortcut_filter: rune::TextEdit,
    pub(super) opencode: opencode::Status,
    logging: opencode::logging::Logging,
    pub(super) providers: providers::Catalog,
    stats: super::stats::Dashboard,
    remote: remote::Remote,
    info: info::Info,
    host_support: super::host_support::HostSupport,
    config_files: super::config_files::Editor,
    environment: super::advanced::environment::Editor,
    advanced_help: Option<super::advanced::Toggle>,
    notification_permission: notification_settings::Permission,
    pub(super) focused: Rc<Cell<bool>>,
}

#[derive(Default)]
pub(super) struct CloseRequest {
    pub requested: Cell<bool>,
    pub reopen: RefCell<Option<super::memory::editor::Editor>>,
    pub config_reopen: RefCell<Option<super::config_files::Editor>>,
    pub palette_reopen: RefCell<Option<super::general::Controls>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Section {
    General,
    Conversation,
    OpenCode,
    Notifications,
    Providers,
    Shortcuts,
    Stats,
    Remote,
    ConfigFiles,
    Advanced,
    Info,
}

impl Default for Section {
    fn default() -> Self {
        Self::General
    }
}

impl Window {
    pub(super) fn with_notification_permission(
        mut self,
        permission: notification_settings::Permission,
    ) -> Self {
        self.notification_permission = permission;
        self
    }

    pub(super) fn check_opencode(&mut self, refresh: Option<bool>) {
        let mut prefs = self.shared.borrow_mut();
        let wake = prefs.window_wake.clone();
        self.opencode.read(&mut prefs, wake.as_ref(), refresh);
    }

    fn start_opencode_install(&mut self) {
        if self.section == Section::OpenCode && !self.confirm_close && !self.closing {
            let mut prefs = self.shared.borrow_mut();
            let wake = prefs.window_wake.clone();
            self.opencode.start(&mut prefs, wake);
        }
    }

    pub fn new(shared: Rc<RefCell<Preferences>>, token: Rc<Cell<bool>>) -> Self {
        Self {
            shared,
            token: Some(token),
            ..Self::default()
        }
    }

    pub fn with_close_request(
        mut self,
        request: Rc<CloseRequest>,
        editor: Option<super::memory::editor::Editor>,
    ) -> Self {
        self.close_request = Some(request);
        if let Some(editor) = editor {
            self.memory_editor = editor;
            self.confirm_close = true;
        }
        if let Some(editor) = self
            .close_request
            .as_ref()
            .and_then(|request| request.config_reopen.borrow_mut().take())
        {
            self.config_files = editor;
            self.section = Section::ConfigFiles;
            self.confirm_close = self.config_files.dirty() && !self.config_files.busy();
        }
        if let Some(general) = self
            .close_request
            .as_ref()
            .and_then(|request| request.palette_reopen.borrow_mut().take())
        {
            self.general = general;
            self.section = Section::General;
            self.confirm_close = self.general.dirty();
        }
        self
    }

    fn switch_section(&mut self, next: Section) {
        self.general.close();
        self.transcript_picker.set(None);
        self.advanced_help = None;
        self.recording_shortcut = false;
        self.shortcut_capture = Default::default();
        self.behavior.close();
        self.section = next;
        if self.section != Section::OpenCode {
            self.opencode = opencode::Status::default();
            self.logging.close();
            self.shared.borrow_mut().hide_opencode();
        }
        self.shared
            .borrow_mut()
            .memory
            .show(self.section == Section::General);
        self.memory_help_failed = false;
        if self.section != Section::Providers {
            self.providers.suspend();
        }
        if self.section != Section::Remote {
            self.remote.close();
        }
        if self.section != Section::Info {
            self.info.close();
        }
    }

    fn request_close(&mut self, tx: &mut rune::Tx) {
        if self.config_files.busy() {
            return;
        }
        self.info.close();
        {
            let mut prefs = self.shared.borrow_mut();
            prefs.hide_opencode();
            prefs.show_environment(false);
        }
        self.logging.close();
        self.remote.close();
        if self.memory_editor.has_unsaved() || self.config_files.dirty() || self.general.dirty() {
            self.confirm_close = true;
        } else {
            self.closing = true;
            tx.close_window();
        }
    }

    fn retain_editor_on_native_close(&mut self) -> bool {
        if (!self.memory_editor.has_unsaved()
            && !self.config_files.dirty()
            && !self.config_files.busy()
            && !self.general.dirty())
            || self.token.as_ref().is_some_and(|token| token.get())
        {
            return false;
        }
        let Some(request) = &self.close_request else {
            return false;
        };
        if self.memory_editor.has_unsaved() {
            *request.reopen.borrow_mut() = Some(std::mem::take(&mut self.memory_editor));
        }
        if self.config_files.dirty() || self.config_files.busy() {
            self.config_files.suspend();
            *request.config_reopen.borrow_mut() = Some(std::mem::take(&mut self.config_files));
        }
        if self.general.dirty() {
            *request.palette_reopen.borrow_mut() = Some(std::mem::take(&mut self.general));
        }
        let mut prefs = self.shared.borrow_mut();
        prefs.window_wake = None;
        if let Some(wake) = &prefs.main_wake {
            wake();
        }
        true
    }

    pub(super) fn close(&mut self, warn: impl FnOnce(&'static str)) {
        {
            let mut prefs = self.shared.borrow_mut();
            prefs.set_palette_preview(None);
            prefs.window_wake = None;
            prefs.hide_opencode();
            prefs.show_environment(false);
            prefs.memory.show(false);
            prefs.provider_target = None;
            prefs.open_providers = false;
        }
        if !self.token.take().is_some_and(|token| token.get()) {
            super::settle_close(&self.shared, warn);
        }
    }
}

pub(super) fn view(s: &Window, cx: &mut Cx<Window>) -> El {
    s.general.commit_palette(&s.shared, cx.system_dark());
    let prefs = s.shared.borrow();
    if prefs.awaiting_appearance() {
        return rune::el().key("preferences-bootstrap");
    }
    let system_dark = cx.system_dark();
    let system_more = cx.system_increased_contrast();
    s.general
        .close_palette_on_slot_change(prefs.dark(system_dark));
    render_with(cx, &prefs, system_more, true, |cx| {
        let general_label = t("settings.nav.general");
        let opencode_label = t("settings.nav.opencode");
        let notifications_label = t("settings.nav.notifications");
        let providers_label = t("settings.nav.providers");
        let stats_label = t("settings.usage.title");
        let conversation_label = t("settings.nav.chat");
        let shortcuts_label = t("settings.nav.hotkeys");
        let remote_label = t("settings.nav.remote");
        let config_label = t("settings.nav.configFiles");
        let advanced_label = t("settings.nav.advanced");
        let info_label = t("settings.nav.info");
        let section = match s.section {
            Section::General => general_label,
            Section::Conversation => conversation_label,
            Section::OpenCode => opencode_label,
            Section::Notifications => notifications_label,
            Section::Providers => providers_label,
            Section::Shortcuts => shortcuts_label,
            Section::Stats => stats_label,
            Section::Remote => remote_label,
            Section::ConfigFiles => config_label,
            Section::Advanced => advanced_label,
            Section::Info => info_label,
        };
        let nav = chrome::nav(
            t("settings.title"),
            t("settings.navigationAriaLabel"),
            [
                (
                    "settings-general",
                    general_label,
                    s.section == Section::General,
                ),
                (
                    "settings-conversation",
                    conversation_label,
                    s.section == Section::Conversation,
                ),
                (
                    "settings-opencode",
                    opencode_label,
                    s.section == Section::OpenCode,
                ),
                (
                    "settings-notifications",
                    notifications_label,
                    s.section == Section::Notifications,
                ),
                (
                    "settings-providers",
                    providers_label,
                    s.section == Section::Providers,
                ),
                ("settings-stats", stats_label, s.section == Section::Stats),
                (
                    "settings-hotkeys",
                    shortcuts_label,
                    s.section == Section::Shortcuts,
                ),
                (
                    "settings-remote",
                    remote_label,
                    s.section == Section::Remote,
                ),
                (
                    "settings-advanced",
                    advanced_label,
                    s.section == Section::Advanced,
                ),
            ]
            .into_iter()
            .filter(|(key, _, _)| *key != "settings-stats" || super::stats::supported(&prefs))
            .chain(s.host_support.config_files(&prefs).then_some((
                "settings-config-files",
                config_label,
                s.section == Section::ConfigFiles,
            )))
            .chain([("settings-info", info_label, s.section == Section::Info)]),
            |s: &mut Window, key| {
                if key == "settings-config-files"
                    && !s.host_support.config_files(&s.shared.borrow())
                {
                    return;
                }
                if s.config_files.busy() {
                    return;
                }
                let next = match key {
                    "settings-opencode" => Section::OpenCode,
                    "settings-conversation" => Section::Conversation,
                    "settings-notifications" => Section::Notifications,
                    "settings-providers" => Section::Providers,
                    "settings-hotkeys" => Section::Shortcuts,
                    "settings-stats" if super::stats::supported(&s.shared.borrow()) => {
                        Section::Stats
                    }
                    "settings-remote" => Section::Remote,
                    "settings-config-files" => Section::ConfigFiles,
                    "settings-advanced" => Section::Advanced,
                    "settings-info" => Section::Info,
                    _ => Section::General,
                };
                if next != s.section && s.general.dirty() {
                    s.pending_section = Some(next);
                    return;
                }
                s.switch_section(next);
            },
        );
        let mut layers = Vec::new();
        let status = if let Some(error) = match s.section {
            Section::General => prefs.general_error(),
            Section::Conversation => prefs.transcript_error(),
            _ => None,
        }
        .or_else(|| {
            (prefs.backend.is_none() && prefs.saved(Owner::Config).is_none())
                .then_some("rune.connect_error")
        }) {
            layout::action_row()
                .child(text(t(error)).role("alert"))
                .child(layout::button(
                    t("sessionList.loadError.retry"),
                    !prefs.can_retry(),
                    |s: &mut Window| match s.section {
                        Section::Conversation => s.shared.borrow_mut().retry_transcript(),
                        _ => s.shared.borrow_mut().retry_general(),
                    },
                ))
        } else if prefs.saved(Owner::Config).is_none() {
            text(t("rune.loading")).role("status")
        } else {
            rune::el()
        };
        let (key, controls) = match s.section {
            Section::Shortcuts => (
                "hotkeys",
                super::shortcuts::editor::view(
                    &s.shared,
                    &s.shortcut_filter,
                    |s: &mut Window| &mut s.shortcut_filter,
                    s.recording_shortcut,
                    &s.shortcut_capture,
                    |s| {
                        (s.section == Section::Shortcuts && !s.closing && !s.confirm_close)
                            .then_some((&mut s.recording_shortcut, &mut s.shortcut_capture))
                    },
                ),
            ),
            Section::OpenCode => (
                "opencode",
                col()
                    .full_width()
                    .child(opencode::view(
                        &s.opencode,
                        &prefs,
                        Window::start_opencode_install,
                        |s: &mut Window| s.check_opencode(Some(true)),
                        |s| &mut s.opencode,
                    ))
                    .child(
                        s.logging
                            .view(&s.shared, &mut layers, |s: &mut Window| &mut s.logging),
                    ),
            ),
            Section::Conversation => {
                if !prefs.transcript_ready() {
                    s.transcript_picker.set(None);
                }
                (
                    "conversation",
                    super::conversation::content(
                        &prefs,
                        s.transcript_picker.get(),
                        cx.window_layout_with("transcript-presets", |rect| {
                            chrome::preset_columns(rect[2])
                        })
                        .unwrap_or(4),
                        &mut layers,
                        |s: &mut Window, row| s.transcript_picker.set(row),
                        |s: &mut Window, row, mode| s.shared.borrow_mut().set_transcript(row, mode),
                    ),
                )
            }
            Section::General => (
                "general",
                general::view(s, cx, &prefs, system_dark, system_more, &mut layers),
            ),
            Section::Notifications => (
                "notifications",
                notification_settings::view(
                    &s.shared,
                    s.notification_permission,
                    |_: &mut Window| {},
                ),
            ),
            Section::Providers => (
                "providers",
                providers::view(
                    s,
                    prefs.can_retry()
                        && prefs
                            .provider_target
                            .as_ref()
                            .is_some_and(providers::Target::online),
                ),
            ),
            Section::Stats => (
                "stats",
                super::stats::view(cx, &s.stats, &mut layers, |s: &mut Window| {
                    (s.section == Section::Stats && !s.closing && !s.confirm_close)
                        .then_some(&mut s.stats)
                }),
            ),
            Section::Remote => (
                "remote",
                s.remote.view(&s.shared, |s: &mut Window| {
                    (s.section == Section::Remote && !s.closing && !s.confirm_close)
                        .then_some(&mut s.remote)
                }),
            ),
            Section::ConfigFiles => (
                "config-files",
                if s.host_support.config_files(&prefs) {
                    s.config_files
                        .view(&mut layers, &s.shared, |s: &mut Window| &mut s.config_files)
                } else {
                    text(t("rune.loading")).role("status")
                },
            ),
            Section::Advanced => (
                "advanced",
                col()
                    .full_width()
                    .child(super::advanced::view(
                        &prefs,
                        true,
                        s.advanced_help,
                        |s: &mut Window, choice| {
                            s.advanced_help = (s.advanced_help != Some(choice)).then_some(choice);
                        },
                        |s: &mut Window, toggle, checked| {
                            s.shared.borrow_mut().set_advanced_toggle(toggle, checked);
                        },
                        |s: &mut Window| s.shared.borrow_mut().retry_advanced(),
                    ))
                    .child(
                        s.environment
                            .view(&prefs, &s.shared, |s: &mut Window| &mut s.environment),
                    ),
            ),
            Section::Info => (
                "info",
                s.info.view(
                    &s.shared,
                    |s: &mut Window| {
                        (s.section == Section::Info && !s.confirm_close && !s.closing)
                            .then_some(&mut s.info)
                    },
                    Some(|s: &mut Window| {
                        if s.section == Section::Info && !s.confirm_close && !s.closing {
                            s.info.close();
                            s.section = Section::Remote;
                        }
                    }),
                ),
            ),
        };
        if let Some(editor) = prefs.memory.editor_view(
            &s.memory_editor,
            |s: &mut Window| &mut s.memory_editor,
            |s: &mut Window, action| {
                super::memory::review_action(&mut s.shared.borrow_mut(), action)
            },
        ) {
            layers.push(editor);
        }
        if s.confirm_close && s.config_files.dirty() {
            layers.push(super::config_files::confirm_discard(
                |s: &mut Window, accept, tx| {
                    s.confirm_close = false;
                    if accept {
                        s.config_files = Default::default();
                        s.request_close(tx);
                    }
                },
            ));
        } else if s.confirm_close && s.general.dirty() {
            layers.push(super::config_files::confirm_discard(
                |s: &mut Window, accept, tx| {
                    s.confirm_close = false;
                    if accept {
                        let mut prefs = s.shared.borrow_mut();
                        s.general.discard_draft(&mut prefs);
                        drop(prefs);
                        s.request_close(tx);
                    }
                },
            ));
        } else if s.confirm_close {
            layers.push(rune_theme_codenomad::document_reader::editor::confirmation(
                layout::dark(),
                t("settings.memory.discard"),
                t("settings.memory.cancel"),
                t("settings.memory.discardConfirm"),
                |s: &mut Window, accept, tx| {
                    s.confirm_close = false;
                    if accept {
                        s.memory_editor = Default::default();
                        s.request_close(tx);
                    }
                },
            ));
        } else if let Some(next_section) = s.pending_section {
            layers.push(super::config_files::confirm_discard(
                move |s: &mut Window, accept, _| {
                    s.pending_section = None;
                    if accept {
                        let mut prefs = s.shared.borrow_mut();
                        s.general.discard_draft(&mut prefs);
                        drop(prefs);
                        s.switch_section(next_section);
                    }
                },
            ));
        }
        chrome::frame(nav, chrome::pane(key, section, [status, controls]), layers).on_window_focus(
            |s: &mut Window, focused, _| {
                if !focused {
                    s.recording_shortcut = false;
                } else if s.section == Section::OpenCode {
                    s.check_opencode(Some(false));
                } else if focused && s.section == Section::General {
                    s.shared.borrow_mut().memory.invalidate();
                }
            },
        )
    })
}
