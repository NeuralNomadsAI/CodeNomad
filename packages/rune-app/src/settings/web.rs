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
    Shortcuts,
    Providers,
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
            Self::Shortcuts => "settings.nav.hotkeys",
            Self::Providers => "settings.nav.providers",
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

#[derive(Default)]
pub(super) struct Panel {
    shown: bool,
    section: Section,
    general: super::general::Controls,
    behavior: super::behavior::General,
    memory_help_failed: bool,
    memory_editor: super::memory::editor::Editor,
    transcript_picker: Option<super::TranscriptRow>,
    catalog: Catalog,
    scope: super::host_support::HostSupport,
    config_files: super::config_files::Editor,
    environment: super::advanced::environment::Editor,
    advanced_help: Option<super::advanced::Toggle>,
    confirm_config_close: bool,
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
        }
    }

    pub(super) fn poll_window_actions(&mut self, prefs: &Preferences, tx: &mut rune::Tx) -> bool {
        if self.shown && self.section == Section::Info {
            self.info.announce(prefs, tx);
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
        self.stats.poll(
            prefs.provider_target.as_ref().filter(|_| prefs.can_retry()),
            self.shown && paired && self.section == Section::Stats,
            wake,
            now,
            tx,
        ) | leave
    }

    pub fn shown(&self) -> bool {
        self.shown
    }

    pub fn poll(&mut self, prefs: &mut Preferences, wake: &rune::Waker, paired: bool) -> bool {
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
        let editor = prefs.memory.poll_editor(&mut self.memory_editor);
        editor
            | scope_changed
            | environment
            | opencode
            | self.poll_notification_permission()
            | (self.shown && paired && self.section == Section::Info && self.info.poll(prefs, wake))
            | (self.section == Section::Remote
                && self.local(prefs)
                && self.remote.poll(prefs, wake))
            | (self.shown
                && self.section == Section::Providers
                && self.catalog.poll(
                    prefs.provider_target.as_ref().filter(|_| prefs.can_retry()),
                    Some(wake),
                ))
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
        if matches!(self.section, Section::OpenCode | Section::Remote) && !self.local(prefs) {
            prefs.hide_opencode();
            self.logging.close();
            self.remote.close();
            self.opencode = opencode::Status::default();
            self.section = Section::General;
            prefs.memory.show(true);
            changed = true;
        }
        let capable = self.scope.config_files(prefs);
        if self.section == Section::ConfigFiles && !capable {
            self.section = Section::General;
            prefs.memory.show(true);
            changed = true;
        }
        changed
            | self.config_files.poll(
                prefs,
                wake,
                shown && capable && self.section == Section::ConfigFiles,
            )
    }

    fn local(&self, prefs: &Preferences) -> bool {
        self.scope.local(prefs)
    }
}

pub(super) fn entry(touch: bool) -> El {
    rune_theme_codenomad::tabs::BarAction::Settings
        .button(touch, t("settings.title"), open)
        .key("open-preferences")
}

fn open(s: &mut State) {
    let target = Target::capture(s);
    let mut prefs = s.settings.shared.borrow_mut();
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
    panel.section = Section::Providers;
    panel.general.close();
    panel.behavior.close();
    panel.transcript_picker = None;
    panel.advanced_help = None;
    panel.recording_shortcut = false;
    panel.shortcut_capture = Default::default();
    panel.memory_help_failed = false;
    open(s);
}

fn close(s: &mut State) {
    let panel = &mut s.settings.web;
    if panel.config_files.busy() {
        return;
    }
    if panel.config_files.dirty() {
        panel.confirm_config_close = true;
        return;
    }
    panel.shown = false;
    panel.general.close();
    panel.advanced_help = None;
    panel.behavior.close();
    panel.catalog.suspend();
    panel.stats.suspend();
    let mut prefs = s.settings.shared.borrow_mut();
    prefs.hide_opencode();
    prefs.show_environment(false);
    panel.environment = Default::default();
    panel.logging.close();
    panel.remote.close();
    panel.info.close();
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
    panel.memory_help_failed = false;
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
        Section::Shortcuts,
        Section::Providers,
        Section::Stats,
        Section::Remote,
        Section::ConfigFiles,
        Section::Advanced,
        Section::Info,
    ]
    .into_iter()
    .filter(|section| match section {
        Section::OpenCode | Section::Remote => local,
        Section::ConfigFiles => panel.scope.config_files(prefs),
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
                || (matches!(section, Section::OpenCode | Section::Remote) && !panel.local(&prefs))
                || section == Section::ConfigFiles && !panel.scope.config_files(&prefs)
                || panel.config_files.busy()
            {
                return;
            }
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
            if panel.section != Section::Remote {
                panel.remote.close();
            }
            if panel.section != Section::Info {
                panel.info.close();
            }
            panel.general.close();
            panel.advanced_help = None;
            panel.behavior.close();
            panel.memory_help_failed = false;
            prefs.memory.show(panel.section == Section::General);
        },
    );
    let mut layers = Vec::new();
    let body = match panel.section {
        Section::General => {
            let system_dark = cx.system_dark();
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
                    &mut layers,
                    |s: &mut State| &mut s.settings.web.general,
                ))
                .child(super::memory::view(
                    prefs,
                    panel.memory_help_failed,
                    |s: &mut State, desired| {
                        super::memory::action(&mut s.settings.shared.borrow_mut(), desired)
                    },
                    |s: &mut State, failed| s.settings.web.memory_help_failed = failed,
                    |s: &mut State, edit| s.settings.web.memory_editor.open(edit),
                    |s: &mut State, action| {
                        super::memory::review_action(&mut s.settings.shared.borrow_mut(), action);
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
            providers::content(&panel.catalog, available, |s: &mut State| {
                s.settings.web.catalog.toggle()
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
        Section::OpenCode if local => col()
            .full_width()
            .child(opencode::view(
                &panel.opencode,
                prefs,
                |s: &mut State| {
                    let panel = &s.settings.web;
                    let mut prefs = s.settings.shared.borrow_mut();
                    if panel.shown && panel.section == Section::OpenCode && panel.local(&prefs) {
                        panel.opencode.start(&mut prefs, Some(s.wake.clone()));
                    }
                },
                |s: &mut State| {
                    let panel = &mut s.settings.web;
                    let mut prefs = s.settings.shared.borrow_mut();
                    if panel.shown && panel.section == Section::OpenCode && panel.local(&prefs) {
                        panel.opencode.read(&mut prefs, Some(&s.wake), Some(true));
                    }
                },
                |s| &mut s.settings.web.opencode,
            ))
            .child(
                panel
                    .logging
                    .view(&s.settings.shared, &mut layers, |s: &mut State| {
                        &mut s.settings.web.logging
                    }),
            ),
        Section::Remote if local => panel.remote.view(&s.settings.shared, |s: &mut State| {
            let panel = &mut s.settings.web;
            (panel.shown
                && panel.section == Section::Remote
                && panel.local(&s.settings.shared.borrow()))
            .then_some(&mut panel.remote)
        }),
        Section::ConfigFiles if panel.scope.config_files(prefs) => {
            panel
                .config_files
                .view(&mut layers, &s.settings.shared, |s: &mut State| {
                    &mut s.settings.web.config_files
                })
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
                let panel = &mut s.settings.web;
                (panel.shown && panel.section == Section::Info).then_some(&mut panel.info)
            },
            local.then_some(open_remote),
        ),
        Section::OpenCode | Section::Remote | Section::ConfigFiles => rune::el(),
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
    if panel.confirm_config_close {
        layers.push(super::config_files::confirm_discard(
            |s: &mut State, accept, _| {
                s.settings.web.confirm_config_close = false;
                if accept {
                    s.settings.web.config_files = Default::default();
                    close(s);
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
            close,
        )
        .children(layers),
    )
}

fn open_remote(s: &mut State) {
    let prefs = s.settings.shared.borrow();
    let panel = &mut s.settings.web;
    if panel.shown && panel.section == Section::Info && panel.local(&prefs) {
        panel.info.close();
        panel.section = Section::Remote;
    }
}
