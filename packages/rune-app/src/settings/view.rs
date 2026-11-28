mod general;
mod lifecycle;
pub(super) use lifecycle::{closed, focus, save_warning, spec};
#[cfg(test)]
mod tests;

use super::{
    info, notification_settings, opencode,
    preferences::{Owner, Preferences},
    providers, remote, render_with,
    responsive::{NarrowState, NarrowView, Section, resolve_requested_section},
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum CloseConfirm {
    ConfigFiles,
    Palette,
    Memory,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AfterPaletteSave {
    Close,
    Section(Section),
}

#[derive(Default)]
pub(super) struct Window {
    shared: Rc<RefCell<Preferences>>,
    token: Option<Rc<Cell<bool>>>,
    close_request: Option<Rc<CloseRequest>>,
    confirm_close: Option<CloseConfirm>,
    after_palette_save: Option<(u64, AfterPaletteSave)>,
    closing: bool,
    narrow: NarrowState,
    general: super::general::Controls,
    transcript_picker: Cell<Option<super::TranscriptRow>>,
    behavior: super::behavior::General,
    memory_help: super::ExternalLink,
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
    missions: super::missions::Missions,
    speech: super::speech::Speech,
    integrations: super::integrations::Panel,
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
    pub guard_close: Cell<bool>,
    pub close_main_after: Cell<bool>,
    pub close_main_now: Cell<bool>,
    pub reopen: RefCell<Option<super::memory::editor::Editor>>,
    pub config_reopen: RefCell<Option<super::config_files::Editor>>,
    pub palette_reopen: RefCell<Option<super::general::Controls>>,
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
        if self.section == Section::OpenCode && self.confirm_close.is_none() && !self.closing {
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
            self.narrow.open_detail();
            self.confirm_close = Some(CloseConfirm::Memory);
        }
        if let Some(editor) = self
            .close_request
            .as_ref()
            .and_then(|request| request.config_reopen.borrow_mut().take())
        {
            self.config_files = editor;
            self.section = Section::ConfigFiles;
            self.narrow.open_detail();
            self.confirm_close = (self.config_files.dirty() && !self.config_files.busy())
                .then_some(CloseConfirm::ConfigFiles);
        }
        if let Some(general) = self
            .close_request
            .as_ref()
            .and_then(|request| request.palette_reopen.borrow_mut().take())
        {
            self.general = general;
            self.section = Section::General;
            self.narrow.open_detail();
            let prefs = self.shared.borrow();
            let saving = self.general.busy(&prefs);
            if saving {
                self.after_palette_save = Some((prefs.binding_epoch(), AfterPaletteSave::Close));
            } else {
                self.confirm_close = self.general.dirty().then_some(CloseConfirm::Palette);
            }
        }
        self
    }

    fn is_narrow(&self) -> bool {
        self.narrow.is_narrow()
    }

    fn measure_viewport(&mut self, width: f32, tx: &mut rune::Tx) {
        self.narrow.measure(width, tx);
    }

    fn return_to_narrow_list(&mut self, tx: &mut rune::Tx) {
        self.narrow.return_to_list(self.section, tx);
    }

    fn apply_requested_section(&mut self, requested: Section, tx: Option<&mut rune::Tx>) -> bool {
        if self.config_files.busy() || self.confirm_close.is_some() || self.closing {
            return false;
        }
        let target = {
            let prefs = self.shared.borrow();
            resolve_requested_section(requested, self.can_open_section(&prefs, requested))
        };
        if target != self.section {
            {
                let prefs = self.shared.borrow();
                if self.general.busy(&prefs) {
                    self.after_palette_save =
                        Some((prefs.binding_epoch(), AfterPaletteSave::Section(target)));
                    self.narrow.open_detail();
                    return true;
                }
            }
            if self.general.dirty() {
                self.pending_section = Some(target);
                self.narrow.open_detail();
                return true;
            }
            self.switch_section(target);
        }
        if let Some(tx) = tx {
            self.narrow.open_detail_focus(tx);
        } else {
            self.narrow.open_detail();
        }
        true
    }

    fn select_nav_section(&mut self, key: &'static str, tx: Option<&mut rune::Tx>) {
        let Some(candidate) = Section::from_nav_key(key) else {
            return;
        };
        if candidate == Section::ConfigFiles
            && !self.can_open_section(&self.shared.borrow(), Section::ConfigFiles)
        {
            return;
        }
        let next = if candidate == Section::Stats && !super::stats::supported(&self.shared.borrow())
        {
            Section::General
        } else {
            candidate
        };
        if next != self.section && self.config_files.busy() {
            return;
        }
        if next != self.section {
            let prefs = self.shared.borrow();
            if self.general.busy(&prefs) {
                self.after_palette_save =
                    Some((prefs.binding_epoch(), AfterPaletteSave::Section(next)));
                return;
            }
            drop(prefs);
            if self.general.dirty() {
                self.pending_section = Some(next);
                return;
            }
            self.switch_section(next);
        } else if !self.is_narrow() {
            self.switch_section(next);
        }
        if self.is_narrow() {
            if let Some(tx) = tx {
                self.narrow.open_detail_focus(tx);
            } else {
                self.narrow.open_detail();
            }
        }
    }

    fn switch_section(&mut self, next: Section) {
        self.general.close();
        self.transcript_picker.set(None);
        self.advanced_help = None;
        self.recording_shortcut = false;
        self.shortcut_capture = Default::default();
        self.behavior.close();
        self.section = next;
        let mut prefs = self.shared.borrow_mut();
        if self.section != Section::OpenCode {
            self.opencode = opencode::Status::default();
            self.logging.close();
            prefs.hide_opencode();
        }
        prefs.memory.show(self.section == Section::General);
        self.memory_help.clear();
        if self.section != Section::Providers {
            self.providers.suspend();
        }
        if self.section != Section::Missions {
            self.missions.close();
        }
        if self.section != Section::Voice {
            self.speech.close();
            prefs.show_speech(false);
        }
        if self.section != Section::Integrations {
            self.integrations.suspend();
        }
        if self.section != Section::Remote {
            self.remote.close();
        }
        if self.section != Section::Info {
            self.info.close();
        }
    }

    fn can_open_section(&self, prefs: &Preferences, section: Section) -> bool {
        match section {
            Section::Stats => super::stats::supported(prefs),
            Section::ConfigFiles => {
                self.host_support.config_files(prefs)
                    || self.config_files.dirty()
                    || (self.section == Section::ConfigFiles
                        && prefs.backend.is_some()
                        && !self.host_support.config_files_unsupported(prefs))
            }
            _ => true,
        }
    }

    fn request_close(&mut self, tx: &mut rune::Tx) {
        if self.config_files.busy() {
            return;
        }
        {
            let mut prefs = self.shared.borrow_mut();
            self.general.settle_save(&mut prefs);
            if self.general.busy(&prefs) {
                self.after_palette_save = Some((prefs.binding_epoch(), AfterPaletteSave::Close));
                return;
            }
        }
        self.info.close();
        {
            let mut prefs = self.shared.borrow_mut();
            prefs.hide_opencode();
            prefs.show_environment(false);
            prefs.show_speech(false);
        }
        self.logging.close();
        self.remote.close();
        self.missions.close();
        self.speech.close();
        self.providers.suspend();
        self.integrations.suspend();
        if self.config_files.dirty() {
            self.confirm_close = Some(CloseConfirm::ConfigFiles);
        } else if self.general.dirty() {
            self.confirm_close = Some(CloseConfirm::Palette);
        } else if self.memory_editor.has_unsaved() {
            self.confirm_close = Some(CloseConfirm::Memory);
        } else {
            self.closing = true;
            if let Some(request) = &self.close_request
                && request.close_main_after.replace(false)
            {
                request.close_main_now.set(true);
                if let Some(wake) = &self.shared.borrow().main_wake {
                    wake();
                }
            }
            tx.close_window();
        }
    }

    pub(super) fn cancel_close_main(&self) {
        if let Some(request) = &self.close_request {
            request.close_main_after.set(false);
        }
    }

    pub(super) fn sync_close_guard(&self, prefs: &Preferences) {
        if let Some(request) = &self.close_request {
            let guarded = !self.closing
                && (self.memory_editor.has_unsaved()
                    || self.config_files.dirty()
                    || self.config_files.busy()
                    || self.general.dirty()
                    || self.general.busy(prefs));
            request.guard_close.set(guarded);
        }
    }

    fn retain_editor_on_native_close(&mut self) -> bool {
        let palette_saving = {
            let mut prefs = self.shared.borrow_mut();
            self.general.settle_save(&mut prefs);
            self.general.busy(&prefs)
        };
        if (!self.memory_editor.has_unsaved()
            && !self.config_files.dirty()
            && !self.config_files.busy()
            && !self.general.dirty()
            && !palette_saving)
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
        if self.general.dirty() || palette_saving {
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
        self.missions.close();
        self.speech.close();
        self.providers.suspend();
        self.integrations.suspend();
        {
            let mut prefs = self.shared.borrow_mut();
            prefs.set_palette_preview(None);
            prefs.window_wake = None;
            prefs.hide_opencode();
            prefs.show_environment(false);
            prefs.show_speech(false);
            prefs.memory.show(false);
            prefs.provider_target = None;
            prefs.open_section = None;
        }
        if !self.token.take().is_some_and(|token| token.get()) {
            super::settle_close(&self.shared, warn);
        }
    }
}

pub(super) fn view(s: &Window, cx: &mut Cx<Window>) -> El {
    s.general.commit_palette(&s.shared, cx.system_dark());
    let prefs = s.shared.borrow();
    s.sync_close_guard(&prefs);
    if prefs.awaiting_appearance() {
        return rune::el().key("preferences-bootstrap");
    }
    let system_dark = cx.system_dark();
    let system_more = cx.system_increased_contrast();
    s.general
        .close_palette_on_slot_change(prefs.dark(system_dark));
    render_with(cx, &prefs, system_more, true, |cx| {
        let section = s.section.label();
        let locale = prefs.locale().unwrap_or_else(crate::strings::locale);
        let rtl = rune_theme_codenomad::catalogue::direction(locale) == "rtl";
        let touch = cx.touch_controls();
        let narrow = s.is_narrow();
        let nav_items: Vec<_> = [
            Section::General,
            Section::Conversation,
            Section::OpenCode,
            Section::Notifications,
            Section::Voice,
            Section::Providers,
            Section::Missions,
            Section::Integrations,
            Section::Stats,
            Section::Shortcuts,
            Section::Remote,
            Section::Advanced,
        ]
        .into_iter()
        .filter(|&item| item != Section::Stats || super::stats::supported(&prefs))
        .chain(
            s.can_open_section(&prefs, Section::ConfigFiles)
                .then_some(Section::ConfigFiles),
        )
        .chain([Section::Info])
        .map(|item| (item.nav_key(), item.label(), s.section == item))
        .collect();
        let mut layers = Vec::new();
        let show_detail = !narrow || s.narrow.view() == NarrowView::Detail;
        let detail = show_detail.then(|| {
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
                            (s.section == Section::Shortcuts
                                && !s.closing
                                && s.confirm_close.is_none())
                            .then_some((&mut s.recording_shortcut, &mut s.shortcut_capture))
                        },
                    ),
                ),
                Section::OpenCode => {
                    let wake = prefs.window_wake.clone();
                    let logs_action = opencode::logs_action_view(
                        &s.opencode,
                        &prefs,
                        &s.shared,
                        wake.clone(),
                        &mut layers,
                        |s: &mut Window| &mut s.opencode,
                    );
                    (
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
                            .child(opencode::executable_view(
                                &s.opencode,
                                &prefs,
                                &s.shared,
                                wake.clone(),
                                |s: &mut Window| &mut s.opencode,
                            ))
                            .child(opencode::login_start_view(
                                &s.opencode,
                                &prefs,
                                &s.shared,
                                wake,
                                |s: &mut Window| &mut s.opencode,
                            ))
                            .child(s.logging.view(
                                &s.shared,
                                &mut layers,
                                logs_action,
                                |s: &mut Window| &mut s.logging,
                            )),
                    )
                }
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
                            .unwrap_or_else(|| chrome::preset_columns(s.narrow.width())),
                            &mut layers,
                            |s: &mut Window, row| s.transcript_picker.set(row),
                            |s: &mut Window, row, mode| {
                                s.shared.borrow_mut().set_transcript(row, mode)
                            },
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
                Section::Voice => (
                    "voice",
                    s.speech.view(
                        &s.shared,
                        !s.closing && s.confirm_close.is_none(),
                        &mut layers,
                        |s: &mut Window| &mut s.speech,
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
                        &mut layers,
                    ),
                ),
                Section::Missions => (
                    "missions",
                    s.missions.view(
                        &s.shared,
                        !s.closing && s.confirm_close.is_none(),
                        &mut layers,
                        |s: &mut Window| {
                            (s.section == Section::Missions
                                && !s.closing
                                && s.confirm_close.is_none())
                            .then_some(&mut s.missions)
                        },
                    ),
                ),
                Section::Integrations => (
                    "integrations",
                    super::integrations::view(&s.integrations, &mut layers, |s: &mut Window| {
                        (s.section == Section::Integrations
                            && !s.closing
                            && s.confirm_close.is_none())
                        .then_some(&mut s.integrations)
                    }),
                ),
                Section::Stats => (
                    "stats",
                    super::stats::view(cx, &s.stats, &mut layers, |s: &mut Window| {
                        (s.section == Section::Stats && !s.closing && s.confirm_close.is_none())
                            .then_some(&mut s.stats)
                    }),
                ),
                Section::Remote => (
                    "remote",
                    s.remote.view(
                        &s.shared,
                        |s: &mut Window| {
                            (s.section == Section::Remote
                                && !s.closing
                                && s.confirm_close.is_none())
                            .then_some(&mut s.remote)
                        },
                        |s: &mut Window| &mut s.remote,
                    ),
                ),
                Section::ConfigFiles => (
                    "config-files",
                    if s.host_support.config_files(&prefs) {
                        s.config_files
                            .view(&mut layers, &s.shared, |s: &mut Window| &mut s.config_files)
                    } else if prefs.transport_lost()
                        || !prefs.can_retry()
                        || prefs
                            .backend
                            .as_ref()
                            .is_some_and(|b| !super::ServerOwner::backend_verified(b))
                    {
                        col()
                            .full_width()
                            .child(
                                layout::action_row()
                                    .child(text(t("rune.connect_error")).role("alert").wrap())
                                    .child(layout::button(
                                        t("sessionList.loadError.retry"),
                                        !prefs.can_retry(),
                                        |s: &mut Window| {
                                            s.shared.borrow_mut().retry_general();
                                            s.host_support.retry();
                                        },
                                    )),
                            )
                            .children(s.config_files.has_editor().then(|| {
                                s.config_files
                                    .view(&mut layers, &s.shared, |s: &mut Window| {
                                        &mut s.config_files
                                    })
                            }))
                    } else if s.host_support.config_files_failed(&prefs) {
                        layout::action_row()
                            .child(text(t("rune.connect_error")).role("alert").wrap())
                            .child(layout::button(
                                t("sessionList.loadError.retry"),
                                false,
                                |s: &mut Window| s.host_support.retry(),
                            ))
                    } else if s.host_support.config_files_unsupported(&prefs) {
                        text(t("settings.configFiles.errors.loadList"))
                            .role("alert")
                            .wrap()
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
                                s.advanced_help =
                                    (s.advanced_help != Some(choice)).then_some(choice);
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
                            (s.section == Section::Info && s.confirm_close.is_none() && !s.closing)
                                .then_some(&mut s.info)
                        },
                        Some(|s: &mut Window| {
                            if s.section == Section::Info && s.confirm_close.is_none() && !s.closing
                            {
                                s.info.close();
                                s.section = Section::Remote;
                            }
                        }),
                    ),
                ),
            };
            (key, status, controls)
        });
        if let Some(editor) = prefs.memory.editor_view(
            &s.memory_editor,
            |s: &mut Window| &mut s.memory_editor,
            |s: &mut Window, action| {
                super::memory::review_action(&mut s.shared.borrow_mut(), action)
            },
        ) {
            layers.push(editor);
        }
        let palette_saving = s.general.busy(&prefs);
        let active_confirm_close = match s.confirm_close {
            Some(CloseConfirm::ConfigFiles) if s.config_files.dirty() => {
                Some(CloseConfirm::ConfigFiles)
            }
            Some(CloseConfirm::Palette) if s.general.dirty() && !palette_saving => {
                Some(CloseConfirm::Palette)
            }
            Some(CloseConfirm::Memory) if s.memory_editor.has_unsaved() => {
                Some(CloseConfirm::Memory)
            }
            _ => None,
        };
        if active_confirm_close == Some(CloseConfirm::ConfigFiles) {
            layers.push(super::config_files::confirm_discard(
                |s: &mut Window, accept, tx| {
                    s.confirm_close = None;
                    if accept {
                        s.config_files = Default::default();
                        s.request_close(tx);
                    } else {
                        s.cancel_close_main();
                    }
                },
            ));
        } else if active_confirm_close == Some(CloseConfirm::Palette) {
            layers.push(super::config_files::confirm_discard(
                |s: &mut Window, accept, tx| {
                    s.confirm_close = None;
                    if accept {
                        let mut prefs = s.shared.borrow_mut();
                        s.general.discard_draft(&mut prefs);
                        drop(prefs);
                        s.request_close(tx);
                    } else {
                        s.cancel_close_main();
                    }
                },
            ));
        } else if active_confirm_close == Some(CloseConfirm::Memory) {
            layers.push(rune_theme_codenomad::document_reader::editor::confirmation(
                layout::dark(),
                t("settings.memory.discard"),
                t("settings.memory.cancel"),
                t("settings.memory.discardConfirm"),
                |s: &mut Window, accept, tx| {
                    s.confirm_close = None;
                    if accept {
                        s.memory_editor = Default::default();
                        s.request_close(tx);
                    } else {
                        s.cancel_close_main();
                    }
                },
            ));
        } else if let Some(next_section) = s.pending_section.filter(|&next| {
            s.general.dirty() && !palette_saving && s.can_open_section(&prefs, next)
        }) {
            layers.push(super::config_files::confirm_discard(
                move |s: &mut Window, accept, tx| {
                    s.pending_section = None;
                    if accept && !s.config_files.busy() {
                        let mut prefs = s.shared.borrow_mut();
                        if !s.general.busy(&prefs) && s.can_open_section(&prefs, next_section) {
                            s.general.discard_draft(&mut prefs);
                            drop(prefs);
                            s.switch_section(next_section);
                            if s.is_narrow() {
                                s.narrow.open_detail_focus(tx);
                            }
                        }
                    }
                },
            ));
        }
        let frame = if narrow {
            let content = match detail {
                Some((key, status, controls)) => chrome::narrow_pane(
                    key,
                    chrome::narrow_header(
                        section,
                        Some((
                            t("sessionList.history.back"),
                            t("settings.navigationAriaLabel"),
                            rtl,
                            |s: &mut Window, tx: &mut rune::Tx| s.return_to_narrow_list(tx),
                        )),
                        t("settings.close"),
                        touch,
                        |s: &mut Window, tx: &mut rune::Tx| s.request_close(tx),
                    ),
                    [status, controls],
                ),
                None => chrome::narrow_list_screen(
                    chrome::narrow_header(
                        t("settings.title"),
                        None::<(&str, &str, bool, fn(&mut Window, &mut rune::Tx))>,
                        t("settings.close"),
                        touch,
                        |s: &mut Window, tx: &mut rune::Tx| s.request_close(tx),
                    ),
                    chrome::narrow_nav(
                        t("settings.navigationAriaLabel"),
                        nav_items,
                        touch,
                        |s: &mut Window, key, tx| s.select_nav_section(key, Some(tx)),
                    ),
                ),
            };
            chrome::narrow_frame(content, layers)
        } else {
            let nav = chrome::nav(
                t("settings.title"),
                t("settings.navigationAriaLabel"),
                nav_items,
                |s: &mut Window, key| s.select_nav_section(key, None),
            );
            let (key, status, controls) = detail.expect("wide layout always builds section");
            chrome::frame(nav, chrome::pane(key, section, [status, controls]), layers)
        }
        .key("preferences-frame")
        .on_layout_tx(|s: &mut Window, [_, _, width, _], tx| s.measure_viewport(width, tx));
        // On Android this window is a page of the phone's one window: clear of its bars and
        // keyboard, as the shell is.
        #[cfg(target_os = "android")]
        let frame = layout::safe_area(cx, frame);
        frame.on_window_focus(|s: &mut Window, focused, _| {
            if !focused {
                s.recording_shortcut = false;
            } else {
                codenomad_client::stream::probe_stale();
                if s.section == Section::OpenCode {
                    s.check_opencode(Some(false));
                } else if s.section == Section::General {
                    s.shared.borrow_mut().memory.invalidate();
                }
            }
        })
    })
}
