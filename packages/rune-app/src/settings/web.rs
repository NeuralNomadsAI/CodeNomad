use super::{
    Preferences, info, notification_settings, opencode,
    providers::{self, Catalog, Target},
    remote,
};
use crate::{State, platform, screen, strings::t};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
    settings as chrome,
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    General,
    Conversation,
    OpenCode,
    Notifications,
    Voice,
    Shortcuts,
    Providers,
    Missions,
    Integrations,
    Stats,
    Remote,
    ConfigFiles,
    Advanced,
    Info,
}

impl Section {
    fn label(self) -> &'static str {
        t(match self {
            Self::General => "settings.nav.general",
            Self::Conversation => "settings.nav.chat",
            Self::OpenCode => "settings.nav.opencode",
            Self::Notifications => "settings.nav.notifications",
            Self::Voice => "settings.nav.voice",
            Self::Shortcuts => "settings.nav.hotkeys",
            Self::Providers => "settings.nav.providers",
            Self::Missions => "settings.nav.missions",
            Self::Integrations => "settings.nav.integrations",
            Self::Stats => "settings.usage.title",
            Self::Remote => "settings.nav.remote",
            Self::ConfigFiles => "settings.nav.configFiles",
            Self::Advanced => "settings.nav.advanced",
            Self::Info => "settings.nav.info",
        })
    }
}

impl Default for Section {
    fn default() -> Self {
        Self::General
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AfterPaletteSave {
    Close,
    Section(Section),
}

#[derive(Default)]
pub(super) struct Panel {
    shown: bool,
    section: Section,
    pending_section: Option<Section>,
    after_palette_save: Option<(u64, AfterPaletteSave)>,
    general: super::general::Controls,
    behavior: super::behavior::General,
    memory_help: super::ExternalLink,
    memory_editor: super::memory::editor::Editor,
    transcript_picker: Option<super::TranscriptRow>,
    announced_transcript_error: Option<&'static str>,
    catalog: Catalog,
    missions: super::missions::Missions,
    speech: super::speech::Speech,
    integrations: super::integrations::Panel,
    scope: super::host_support::HostSupport,
    config_files: super::config_files::Editor,
    environment: super::advanced::environment::Editor,
    advanced_help: Option<super::advanced::Toggle>,
    confirm_config_close: bool,
    confirm_palette_close: bool,
    stats: super::stats::Dashboard,
    opencode: opencode::Status,
    logging: opencode::logging::Logging,
    remote: remote::Remote,
    info: info::Info,
    recording_shortcut: bool,
    shortcut_capture: super::shortcuts::editor::Capture,
    shortcut_filter: rune::TextEdit,
    notification_permission: Rc<Cell<PermissionRequest>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PermissionRequest {
    Idle,
    Pending,
    Finished(bool),
    Refused,
}

impl Default for PermissionRequest {
    fn default() -> Self {
        Self::Idle
    }
}

impl Panel {
    pub(super) fn commit_palette(
        &self,
        shared: &RefCell<Preferences>,
        system_dark: bool,
        paired: bool,
    ) {
        if self.shown && self.section == Section::General && paired {
            self.general.commit_palette(shared, system_dark);
        } else {
            self.general.discard_palette();
            if !self.shown || !paired {
                shared.borrow_mut().set_palette_preview(None);
            }
        }
    }

    pub(super) fn poll_window_actions(
        &mut self,
        prefs: &Preferences,
        filters_open: bool,
        paired: bool,
        tx: &mut rune::Tx,
    ) -> bool {
        if paired && self.shown && self.section == Section::Info {
            self.info.announce(prefs, tx);
        }
        let transcript_error = ((self.shown && self.section == Section::Conversation)
            || filters_open)
            .then(|| prefs.transcript_error())
            .flatten()
            .filter(|error| *error == "rune.connect_error");
        if transcript_error != self.announced_transcript_error {
            self.announced_transcript_error = transcript_error;
            if let Some(error) = transcript_error {
                let locale = prefs.locale().unwrap_or_else(crate::strings::locale);
                crate::strings::with_locale(locale, || layout::announce_alert(tx, t(error)));
            }
        }
        self.shown
            && self.section == Section::Shortcuts
            && self
                .shortcut_capture
                .poll(&mut self.recording_shortcut, prefs, tx)
    }

    pub fn poll_stats(
        &mut self,
        prefs: &mut Preferences,
        wake: &rune::Waker,
        paired: bool,
        now: f64,
        tx: &mut rune::Tx,
    ) -> bool {
        let leave = self.section == Section::Stats && !super::stats::supported(prefs);
        if leave {
            self.section = Section::General;
            prefs.memory.show(self.shown && paired);
        }
        let target = prefs.provider_target.as_ref().filter(|_| prefs.can_retry());
        let stats_changed = self.stats.poll(
            target,
            self.shown && paired && self.section == Section::Stats,
            wake,
            now,
            tx,
        );
        let providers_changed = if self.shown && paired && self.section == Section::Providers {
            self.catalog.poll(
                target,
                now,
                Some(wake),
                tx,
                document_visible(),
                |s: &mut State| &mut s.settings.web.catalog,
            )
        } else {
            self.catalog.cancel_on_hide()
        };
        let integrations_changed = self.integrations.poll(
            target,
            self.shown && paired && self.section == Section::Integrations,
            wake,
            now,
            tx,
        );
        stats_changed | providers_changed | integrations_changed | leave
    }

    pub fn shown(&self) -> bool {
        self.shown
    }

    pub fn poll(&mut self, prefs: &mut Preferences, wake: &rune::Waker, paired: bool) -> bool {
        let mut picker_closed = false;
        if !paired {
            self.general.close();
            self.behavior.close();
            picker_closed = self.transcript_picker.take().is_some();
        } else if !prefs.transcript_ready() {
            picker_closed = self.transcript_picker.take().is_some();
        }
        let scope_changed = self.poll_scope(prefs, wake, paired);
        let environment = self.environment.poll(
            prefs,
            self.shown && paired && self.section == Section::Advanced,
        );
        let opencode = if self.section == Section::OpenCode && self.local(prefs) {
            prefs.show_opencode() | self.opencode.step(prefs, wake)
        } else {
            false
        };
        let editor = prefs
            .memory
            .poll_editor(prefs.backend.as_ref(), &mut self.memory_editor);
        let missions = self.missions.poll(
            prefs,
            wake,
            self.shown && paired && self.section == Section::Missions,
        );
        let speech = self.speech.poll(
            prefs,
            wake,
            self.shown && paired && self.section == Section::Voice,
        );
        let mut palette_settled = self.general.settle_save(prefs);
        if !self.general.dirty() {
            if self.confirm_palette_close || self.pending_section.is_some() {
                self.confirm_palette_close = false;
                self.pending_section = None;
                palette_settled = true;
            }
        } else if self
            .pending_section
            .is_some_and(|next| !self.can_open_section(prefs, next))
        {
            self.pending_section = None;
            palette_settled = true;
        }
        if self.confirm_config_close && !self.config_files.dirty() {
            self.confirm_config_close = false;
            palette_settled = true;
        }
        if let Some((epoch, _)) = self.after_palette_save
            && epoch != prefs.binding_epoch()
        {
            self.after_palette_save = None;
            palette_settled = true;
        }
        if !self.general.busy(prefs)
            && let Some((epoch, after)) = self.after_palette_save.take()
            && epoch == prefs.binding_epoch()
            && !self.general.dirty()
            && !prefs.palette_save_failed()
        {
            match after {
                AfterPaletteSave::Close => {
                    request_close_panel(self, prefs);
                    palette_settled = true;
                }
                AfterPaletteSave::Section(section) => {
                    if self.can_open_section(prefs, section) {
                        apply_web_section(self, prefs, section);
                        palette_settled = true;
                    }
                }
            }
        }
        picker_closed
            | editor
            | palette_settled
            | scope_changed
            | environment
            | opencode
            | missions
            | speech
            | self.poll_notification_permission()
            | (self.shown && paired && self.section == Section::Info && self.info.poll(prefs, wake))
            | (self.section == Section::Remote
                && self.local(prefs)
                && self.remote.poll(prefs, wake))
    }

    fn poll_notification_permission(&self) -> bool {
        let PermissionRequest::Finished(granted) = self.notification_permission.get() else {
            return false;
        };
        self.notification_permission.set(if granted {
            PermissionRequest::Idle
        } else {
            PermissionRequest::Refused
        });
        self.shown && self.section == Section::Notifications
    }

    fn poll_scope(&mut self, prefs: &mut Preferences, wake: &rune::Waker, paired: bool) -> bool {
        let shown = self.shown && paired;
        let mut changed = self.scope.poll(prefs, wake, shown);
        if matches!(self.section, Section::OpenCode | Section::Remote)
            && (self.scope.local_unsupported(prefs) || prefs.backend.is_none())
        {
            prefs.hide_opencode();
            self.logging.close();
            self.remote.close();
            self.opencode = opencode::Status::default();
            self.section = Section::General;
            prefs.memory.show(true);
            changed = true;
        }
        let capable = self.scope.config_files(prefs);
        changed |= self.config_files.poll(
            prefs,
            wake,
            shown && capable && self.section == Section::ConfigFiles,
        );
        if self.section == Section::ConfigFiles
            && (self.scope.config_files_unsupported(prefs) || prefs.backend.is_none())
            && !self.config_files.dirty()
        {
            self.section = Section::General;
            prefs.memory.show(true);
            changed = true;
        }
        changed
    }

    fn local(&self, prefs: &Preferences) -> bool {
        self.scope.local(prefs)
    }

    fn can_open_section(&self, prefs: &Preferences, section: Section) -> bool {
        match section {
            Section::Stats => super::stats::supported(prefs),
            Section::OpenCode | Section::Remote => {
                self.local(prefs)
                    || (self.section == section
                        && prefs.backend.is_some()
                        && !self.scope.local_unsupported(prefs))
            }
            Section::ConfigFiles => {
                self.scope.config_files(prefs)
                    || self.config_files.dirty()
                    || (self.section == Section::ConfigFiles
                        && prefs.backend.is_some()
                        && !self.scope.config_files_unsupported(prefs))
            }
            _ => true,
        }
    }
}

fn document_visible() -> bool {
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::window()
            .and_then(|window| window.document())
            .is_none_or(|doc| doc.visibility_state() == web_sys::VisibilityState::Visible)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        true
    }
}

pub(super) fn entry(touch: bool, skip_tab: bool) -> El {
    rune_theme_codenomad::tabs::BarAction::Settings
        .button(touch, t("settings.title"), open)
        .tab_index(if skip_tab { -1 } else { 0 })
        .key("open-preferences")
}

pub(super) fn open(s: &mut State) {
    s.shell.leave_project();
    let target = Target::capture(s);
    let opener = super::missions::opener_directory(s);
    let mut prefs = s.settings.shared.borrow_mut();
    prefs.missions.capture_opener(opener, target.as_ref());
    prefs.provider_target = target;
    prefs
        .memory
        .show(s.settings.web.section == Section::General);
    s.settings.web.shown = true;
    (s.wake)();
}

pub(super) fn open_providers(s: &mut State) {
    let panel = &mut s.settings.web;
    if panel.config_files.busy() {
        return;
    }
    if panel.section != Section::Providers {
        let prefs = s.settings.shared.borrow();
        if panel.general.busy(&prefs) {
            panel.after_palette_save = Some((
                prefs.binding_epoch(),
                AfterPaletteSave::Section(Section::Providers),
            ));
            drop(prefs);
            open(s);
            return;
        }
        drop(prefs);
        if panel.general.dirty() {
            panel.pending_section = Some(Section::Providers);
            open(s);
            return;
        }
    }
    panel.section = Section::Providers;
    panel.general.close();
    panel.behavior.close();
    panel.missions.close();
    panel.speech.close();
    panel.integrations.suspend();
    s.settings.shared.borrow_mut().show_speech(false);
    panel.transcript_picker = None;
    panel.advanced_help = None;
    panel.recording_shortcut = false;
    panel.shortcut_capture = Default::default();
    panel.memory_help.clear();
    open(s);
}

fn close(s: &mut State) {
    let panel = &mut s.settings.web;
    if panel.config_files.busy() {
        return;
    }
    if panel.general.dismiss_overlay() {
        return;
    }
    let mut prefs = s.settings.shared.borrow_mut();
    request_close_panel(panel, &mut prefs);
}

fn request_close_panel(panel: &mut Panel, prefs: &mut Preferences) {
    if panel.config_files.busy() {
        return;
    }
    panel.general.settle_save(prefs);
    if panel.general.busy(prefs) {
        panel.after_palette_save = Some((prefs.binding_epoch(), AfterPaletteSave::Close));
        return;
    }
    if panel.config_files.dirty() {
        panel.confirm_config_close = true;
        return;
    }
    if panel.general.dirty() {
        panel.confirm_palette_close = true;
        return;
    }
    close_panel(panel, prefs);
}

fn close_panel(panel: &mut Panel, prefs: &mut Preferences) {
    panel.shown = false;
    panel.confirm_config_close = false;
    panel.confirm_palette_close = false;
    panel.pending_section = None;
    panel.after_palette_save = None;
    prefs.set_palette_preview(None);
    panel.general.close();
    panel.advanced_help = None;
    panel.behavior.close();
    panel.catalog.suspend();
    panel.integrations.suspend();
    panel.stats.suspend();
    prefs.hide_opencode();
    prefs.show_environment(false);
    prefs.show_speech(false);
    panel.environment = Default::default();
    panel.logging.close();
    panel.remote.close();
    panel.info.close();
    panel.missions.close();
    panel.speech.close();
    panel.recording_shortcut = false;
    panel.shortcut_capture = Default::default();
    if panel.notification_permission.get() != PermissionRequest::Pending {
        panel.notification_permission.set(PermissionRequest::Idle);
    }
    panel.opencode = opencode::Status::default();
    panel.scope = Default::default();
    panel.config_files = Default::default();
    if matches!(
        panel.section,
        Section::OpenCode | Section::Remote | Section::ConfigFiles
    ) {
        panel.section = Section::General;
    }
    prefs.provider_target = None;
    prefs.memory.show(false);
    panel.memory_help.clear();
    panel.transcript_picker = None;
}

fn request_notification_permission(s: &mut State) {
    let panel = &s.settings.web;
    if !panel.shown
        || panel.section != Section::Notifications
        || panel.notification_permission.get() == PermissionRequest::Pending
    {
        return;
    }
    let Some(request) = platform::notifications::request_permission() else {
        return;
    };
    let state = panel.notification_permission.clone();
    state.set(PermissionRequest::Pending);
    let wake = s.wake.clone();
    wasm_bindgen_futures::spawn_local(async move {
        use notification_settings::Permission;
        let _ = wasm_bindgen_futures::JsFuture::from(request).await;
        state.set(PermissionRequest::Finished(
            notification_settings::web_permission() == Permission::Granted,
        ));
        wake();
    });
}

pub(super) fn view(
    s: &State,
    prefs: &Preferences,
    system_more: bool,
    cx: &rune::Cx<State>,
) -> Option<El> {
    let panel = &s.settings.web;
    if !panel.shown || crate::platform::pairing::required(s) {
        return None;
    }
    let local = panel.local(prefs);
    let sections: Vec<_> = [
        Section::General,
        Section::Conversation,
        Section::OpenCode,
        Section::Notifications,
        Section::Voice,
        Section::Shortcuts,
        Section::Providers,
        Section::Missions,
        Section::Integrations,
        Section::Stats,
        Section::Remote,
        Section::ConfigFiles,
        Section::Advanced,
        Section::Info,
    ]
    .into_iter()
    .filter(|section| match section {
        Section::OpenCode | Section::Remote => panel.can_open_section(prefs, *section),
        Section::ConfigFiles => panel.can_open_section(prefs, Section::ConfigFiles),
        Section::Stats => super::stats::supported(prefs),
        _ => true,
    })
    .collect();
    let labels: Vec<_> = sections.iter().map(|section| section.label()).collect();
    let navigation = chrome::segments(
        t("settings.navigationAriaLabel"),
        &labels,
        sections
            .iter()
            .position(|section| *section == panel.section),
        false,
        move |s: &mut State, index| {
            let panel = &mut s.settings.web;
            let mut prefs = s.settings.shared.borrow_mut();
            let Some(&section) = sections.get(index) else {
                return;
            };
            if !panel.shown
                || (section == Section::Stats && !super::stats::supported(&prefs))
                || (matches!(section, Section::OpenCode | Section::Remote)
                    && !panel.can_open_section(&prefs, section))
                || (section == Section::ConfigFiles
                    && !panel.can_open_section(&prefs, Section::ConfigFiles))
                || panel.config_files.busy()
            {
                return;
            }
            if section != panel.section {
                if panel.general.busy(&prefs) {
                    panel.after_palette_save =
                        Some((prefs.binding_epoch(), AfterPaletteSave::Section(section)));
                    return;
                }
                if panel.general.dirty() {
                    panel.pending_section = Some(section);
                    return;
                }
            }
            apply_web_section(panel, &mut prefs, section);
        },
    );
    let mut layers = Vec::new();
    let body = match panel.section {
        Section::General => {
            let system_dark = cx.system_dark();
            let workbench_width = cx
                .window_layout_with("palette-workbench", |rect| rect[2])
                .unwrap_or(0.0);
            let actions_width = cx
                .window_layout_with("palette-actions", |rect| rect[2])
                .unwrap_or(0.0);
            let coarse = cx.touch_controls();
            panel
                .general
                .close_palette_on_slot_change(prefs.dark(system_dark));
            col()
                .full_width()
                .children(prefs.general_error().map(|error| {
                    layout::action_row()
                        .child(text(t(error)).wrap().role("alert"))
                        .child(layout::button(
                            t("sessionList.loadError.retry"),
                            !prefs.can_retry(),
                            |s: &mut State| {
                                s.settings.shared.borrow_mut().retry_general();
                            },
                        ))
                }))
                .child(panel.general.view(
                    &s.settings.shared,
                    system_dark,
                    system_more,
                    workbench_width,
                    actions_width,
                    coarse,
                    &mut layers,
                    |s: &mut State| &mut s.settings.web.general,
                ))
                .child(super::memory::view(
                    prefs,
                    &panel.memory_help,
                    |s: &mut State, desired| {
                        super::memory::action(&mut s.settings.shared.borrow_mut(), desired)
                    },
                    |s: &mut State| {
                        let paired = !crate::platform::pairing::required(s);
                        let panel = &mut s.settings.web;
                        (paired && panel.shown && panel.section == Section::General)
                            .then_some(&mut panel.memory_help)
                    },
                    |s: &mut State, edit| s.settings.web.memory_editor.open(edit),
                    |s: &mut State, action| {
                        super::memory::review_action(&mut s.settings.shared.borrow_mut(), action);
                    },
                ))
                .child(super::startup_state::view(
                    &s.settings.shared,
                    panel.general.startup_help,
                    |s: &mut State| {
                        s.settings.web.general.startup_help = !s.settings.web.general.startup_help;
                    },
                ))
                .child(panel.behavior.view(
                    &s.settings.shared,
                    false,
                    &mut layers,
                    |s: &mut State| &mut s.settings.web.behavior,
                ))
        }
        Section::Providers => {
            let available =
                prefs.can_retry() && prefs.provider_target.as_ref().is_some_and(Target::online);
            providers::content(&panel.catalog, available, &mut layers, |s: &mut State| {
                &mut s.settings.web.catalog
            })
        }
        Section::Integrations => {
            super::integrations::view(&panel.integrations, &mut layers, |s: &mut State| {
                let paired = !crate::platform::pairing::required(s);
                let panel = &mut s.settings.web;
                (paired && panel.shown && panel.section == Section::Integrations)
                    .then_some(&mut panel.integrations)
            })
        }
        Section::Conversation => col()
            .full_width()
            .separate(Space::Sm)
            .children(prefs.transcript_error().map(|error| {
                layout::action_row()
                    .child(text(t(error)).wrap().role("alert"))
                    .child(layout::button(
                        t("sessionList.loadError.retry"),
                        !prefs.can_retry(),
                        |s: &mut State| {
                            s.settings.shared.borrow_mut().retry_transcript();
                        },
                    ))
            }))
            .child(super::conversation::content(
                prefs,
                panel.transcript_picker,
                cx.window_layout_with("transcript-presets", |rect| chrome::preset_columns(rect[2]))
                    .unwrap_or_else(|| chrome::preset_columns(s.window_size[0])),
                &mut layers,
                |s: &mut State, row| s.settings.web.transcript_picker = row,
                |s: &mut State, row, mode| s.settings.shared.borrow_mut().set_transcript(row, mode),
            )),
        Section::Shortcuts => super::shortcuts::editor::view(
            &s.settings.shared,
            &panel.shortcut_filter,
            |s: &mut State| &mut s.settings.web.shortcut_filter,
            panel.recording_shortcut,
            &panel.shortcut_capture,
            |s| {
                let panel = &mut s.settings.web;
                (panel.shown && panel.section == Section::Shortcuts)
                    .then_some((&mut panel.recording_shortcut, &mut panel.shortcut_capture))
            },
        )
        .on_window_focus(|s: &mut State, focused, _| {
            if !focused {
                s.settings.web.recording_shortcut = false;
            }
        }),
        Section::Stats => super::stats::view(cx, &panel.stats, &mut layers, |s: &mut State| {
            let panel = &mut s.settings.web;
            (panel.shown && panel.section == Section::Stats).then_some(&mut panel.stats)
        }),
        Section::Missions => panel.missions.view(
            &s.settings.shared,
            panel.shown && panel.section == Section::Missions,
            &mut layers,
            |s: &mut State| {
                let paired = !crate::platform::pairing::required(s);
                let panel = &mut s.settings.web;
                (paired && panel.shown && panel.section == Section::Missions)
                    .then_some(&mut panel.missions)
            },
        ),
        Section::Voice => panel.speech.view(
            &s.settings.shared,
            panel.shown && panel.section == Section::Voice,
            &mut layers,
            |s: &mut State| &mut s.settings.web.speech,
        ),
        Section::Notifications => col()
            .full_width()
            .child(notification_settings::view(
                &s.settings.shared,
                notification_settings::web_permission(),
                request_notification_permission,
            ))
            .children(
                (panel.notification_permission.get() == PermissionRequest::Refused
                    && notification_settings::web_permission()
                        == notification_settings::Permission::Ask)
                    .then(|| {
                        text(t("settings.notifications.messages.permissionNotGranted"))
                            .role("alert")
                            .wrap()
                    }),
            ),
        Section::OpenCode
            if local || (prefs.backend.is_some() && !panel.scope.local_unsupported(prefs)) =>
        {
            let transport_issue = prefs.transport_lost()
                || !prefs.can_retry()
                || prefs
                    .backend
                    .as_ref()
                    .is_some_and(|b| !super::ServerOwner::backend_verified(b));
            let wake = Some(s.wake.clone());
            let mut body = col()
                .full_width()
                .children(
                    (!local && (transport_issue || panel.scope.local_failed(prefs))).then(|| {
                        layout::action_row()
                            .child(text(t("rune.connect_error")).role("alert").wrap())
                            .child(layout::button(
                                t("sessionList.loadError.retry"),
                                !prefs.can_retry(),
                                |s: &mut State| {
                                    s.settings.shared.borrow_mut().retry_general();
                                    s.settings.web.scope.retry();
                                    (s.wake)();
                                },
                            ))
                    }),
                )
                .child(opencode::view(
                    &panel.opencode,
                    prefs,
                    |s: &mut State| {
                        let panel = &s.settings.web;
                        let mut prefs = s.settings.shared.borrow_mut();
                        if panel.shown && panel.section == Section::OpenCode && panel.local(&prefs)
                        {
                            panel.opencode.start(&mut prefs, Some(s.wake.clone()));
                        }
                    },
                    |s: &mut State| {
                        let panel = &mut s.settings.web;
                        let mut prefs = s.settings.shared.borrow_mut();
                        if panel.shown && panel.section == Section::OpenCode && panel.local(&prefs)
                        {
                            panel.opencode.read(&mut prefs, Some(&s.wake), Some(true));
                        }
                    },
                    |s| &mut s.settings.web.opencode,
                ));
            if local {
                let logs_action = opencode::logs_action_view(
                    &panel.opencode,
                    prefs,
                    &s.settings.shared,
                    wake.clone(),
                    &mut layers,
                    |s: &mut State| &mut s.settings.web.opencode,
                );
                body = body
                    .child(opencode::executable_view(
                        &panel.opencode,
                        prefs,
                        &s.settings.shared,
                        wake.clone(),
                        |s: &mut State| &mut s.settings.web.opencode,
                    ))
                    .child(opencode::login_start_view(
                        &panel.opencode,
                        prefs,
                        &s.settings.shared,
                        wake,
                        |s: &mut State| &mut s.settings.web.opencode,
                    ))
                    .child(panel.logging.view(
                        &s.settings.shared,
                        &mut layers,
                        logs_action,
                        |s: &mut State| &mut s.settings.web.logging,
                    ));
            }
            body
        }
        Section::Remote
            if local || (prefs.backend.is_some() && !panel.scope.local_unsupported(prefs)) =>
        {
            let transport_issue = prefs.transport_lost()
                || !prefs.can_retry()
                || prefs
                    .backend
                    .as_ref()
                    .is_some_and(|b| !super::ServerOwner::backend_verified(b));
            col()
                .full_width()
                .separate(Space::Sm)
                .children(
                    (!local && (transport_issue || panel.scope.local_failed(prefs))).then(|| {
                        layout::action_row()
                            .child(text(t("rune.connect_error")).role("alert").wrap())
                            .child(layout::button(
                                t("sessionList.loadError.retry"),
                                !prefs.can_retry(),
                                |s: &mut State| {
                                    s.settings.shared.borrow_mut().retry_general();
                                    s.settings.web.scope.retry();
                                    (s.wake)();
                                },
                            ))
                    }),
                )
                .child(panel.remote.view_gated(
                    &s.settings.shared,
                    local,
                    |s: &mut State| {
                        let paired = !crate::platform::pairing::required(s);
                        let panel = &mut s.settings.web;
                        (paired
                            && panel.shown
                            && panel.section == Section::Remote
                            && panel.local(&s.settings.shared.borrow()))
                        .then_some(&mut panel.remote)
                    },
                    |s: &mut State| &mut s.settings.web.remote,
                ))
        }
        Section::ConfigFiles => {
            if panel.scope.config_files(prefs) {
                panel
                    .config_files
                    .view(&mut layers, &s.settings.shared, |s: &mut State| {
                        &mut s.settings.web.config_files
                    })
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
                                |s: &mut State| {
                                    s.settings.shared.borrow_mut().retry_general();
                                    s.settings.web.scope.retry();
                                    (s.wake)();
                                },
                            )),
                    )
                    .children(panel.config_files.has_editor().then(|| {
                        panel
                            .config_files
                            .view(&mut layers, &s.settings.shared, |s: &mut State| {
                                &mut s.settings.web.config_files
                            })
                    }))
            } else if panel.scope.config_files_failed(prefs) {
                layout::action_row()
                    .child(text(t("rune.connect_error")).role("alert").wrap())
                    .child(layout::button(
                        t("sessionList.loadError.retry"),
                        false,
                        |s: &mut State| {
                            s.settings.web.scope.retry();
                            (s.wake)();
                        },
                    ))
            } else if panel.scope.config_files_unsupported(prefs) {
                text(t("settings.configFiles.errors.loadList"))
                    .role("alert")
                    .wrap()
            } else {
                text(t("rune.loading")).role("status")
            }
        }
        Section::Advanced => col()
            .full_width()
            .child(super::advanced::view(
                prefs,
                false,
                panel.advanced_help,
                |s: &mut State, choice| {
                    let help = &mut s.settings.web.advanced_help;
                    *help = (*help != Some(choice)).then_some(choice);
                },
                |s: &mut State, toggle, checked| {
                    s.settings
                        .shared
                        .borrow_mut()
                        .set_advanced_toggle(toggle, checked);
                },
                |s: &mut State| s.settings.shared.borrow_mut().retry_advanced(),
            ))
            .child(
                panel
                    .environment
                    .view(prefs, &s.settings.shared, |s: &mut State| {
                        &mut s.settings.web.environment
                    }),
            ),
        Section::Info => panel.info.view(
            &s.settings.shared,
            |s: &mut State| {
                let paired = !crate::platform::pairing::required(s);
                let panel = &mut s.settings.web;
                (paired && panel.shown && panel.section == Section::Info).then_some(&mut panel.info)
            },
            local.then_some(open_remote),
        ),
        Section::OpenCode | Section::Remote => rune::el(),
    };
    if let Some(editor) = prefs.memory.editor_view(
        &panel.memory_editor,
        |s: &mut State| &mut s.settings.web.memory_editor,
        |s: &mut State, action| {
            super::memory::review_action(&mut s.settings.shared.borrow_mut(), action)
        },
    ) {
        layers.push(editor);
    }
    let palette_dirty = panel.general.dirty() && !panel.general.busy(prefs);
    if panel.confirm_config_close {
        layers.push(super::config_files::confirm_discard(
            |s: &mut State, accept, _| {
                s.settings.web.confirm_config_close = false;
                if accept {
                    s.settings.web.config_files = Default::default();
                    let mut prefs = s.settings.shared.borrow_mut();
                    request_close_panel(&mut s.settings.web, &mut prefs);
                }
            },
        ));
    } else if panel.confirm_palette_close && palette_dirty {
        layers.push(super::config_files::confirm_discard(
            |s: &mut State, accept, _| {
                s.settings.web.confirm_palette_close = false;
                if accept {
                    let mut prefs = s.settings.shared.borrow_mut();
                    s.settings.web.general.discard_draft(&mut prefs);
                    request_close_panel(&mut s.settings.web, &mut prefs);
                }
            },
        ));
    } else if let Some(next_section) = panel
        .pending_section
        .filter(|&next| palette_dirty && panel.can_open_section(prefs, next))
    {
        layers.push(super::config_files::confirm_discard(
            move |s: &mut State, accept, _| {
                s.settings.web.pending_section = None;
                if accept && !s.settings.web.config_files.busy() {
                    let mut prefs = s.settings.shared.borrow_mut();
                    if !s.settings.web.general.busy(&prefs)
                        && s.settings.web.can_open_section(&prefs, next_section)
                    {
                        s.settings.web.general.discard_draft(&mut prefs);
                        apply_web_section(&mut s.settings.web, &mut prefs, next_section);
                    }
                }
            },
        ));
    }
    Some(
        chrome::embedded_section(
            t("settings.title"),
            col()
                .full_width()
                .separate(Space::Md)
                .child(navigation)
                .child(body),
            layout::button(
                t("settings.close"),
                false,
                screen::action(&s.input_scope, close),
            )
            .key("close-preferences"),
            close_or_dismiss_overlay,
        )
        .children(layers),
    )
}

fn close_or_dismiss_overlay(s: &mut State) {
    if s.settings.web.section == Section::Missions && s.settings.web.missions.cancel_confirm() {
        return;
    }
    if s.settings.web.section == Section::Integrations
        && s.settings.web.integrations.dismiss_overlay()
    {
        return;
    }
    if s.settings.web.section == Section::Missions && s.settings.web.missions.cancel_confirm() {
        return;
    }
    if s.settings.web.section == Section::Voice && s.settings.web.speech.cancel_overlays() {
        return;
    }
    close(s);
}

fn apply_web_section(panel: &mut Panel, prefs: &mut Preferences, section: Section) {
    panel.section = section;
    panel.transcript_picker = None;
    panel.recording_shortcut = false;
    panel.shortcut_capture = Default::default();
    if section != Section::OpenCode {
        prefs.hide_opencode();
        panel.logging.close();
        panel.opencode = opencode::Status::default();
    }
    if panel.section != Section::Providers {
        panel.catalog.suspend();
    }
    if panel.section != Section::Missions {
        panel.missions.close();
    }
    if panel.section != Section::Voice {
        panel.speech.close();
        prefs.show_speech(false);
    }
    if panel.section != Section::Integrations {
        panel.integrations.suspend();
    }
    if panel.section != Section::Remote {
        panel.remote.close();
    }
    if panel.section != Section::Info {
        panel.info.close();
    }
    panel.general.close();
    panel.advanced_help = None;
    panel.behavior.close();
    panel.memory_help.clear();
    prefs.memory.show(panel.section == Section::General);
}

fn open_remote(s: &mut State) {
    let prefs = s.settings.shared.borrow();
    let panel = &mut s.settings.web;
    if panel.shown && panel.section == Section::Info && panel.local(&prefs) {
        panel.info.close();
        panel.section = Section::Remote;
    }
}
