mod general;
#[cfg(test)]
mod tests;

use super::{
    notification_settings, opencode,
    preferences::{Owner, Preferences},
    providers, remote, render_with,
};
use crate::strings::t;
use general::Picker;
use rune::{AppSpec, Cx, El, col, text};
use rune_theme_codenomad::{
    layout::{self, Layout},
    palettes, settings as chrome,
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
    picker: Cell<Option<Picker>>,
    palette_choice: Cell<Option<&'static palettes::Palette>>,
    contrast_help: bool,
    permissions: super::behavior::Permissions,
    memory_help_failed: bool,
    memory_editor: super::memory::editor::Editor,
    seen_revision: u64,
    section: Section,
    recording_shortcut: bool,
    shortcut_capture: super::shortcuts::editor::Capture,
    shortcut_filter: rune::TextEdit,
    pub(super) opencode: opencode::Status,
    logging: opencode::logging::Logging,
    pub(super) providers: providers::Catalog,
    remote: remote::Remote,
    notification_permission: notification_settings::Permission,
    pub(super) focused: Rc<Cell<bool>>,
}

#[derive(Default)]
pub(super) struct CloseRequest {
    pub requested: Cell<bool>,
    pub reopen: RefCell<Option<super::memory::editor::Editor>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    General,
    Conversation,
    OpenCode,
    Notifications,
    Providers,
    Shortcuts,
    Remote,
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
        self
    }

    fn request_close(&mut self, tx: &mut rune::Tx) {
        self.shared.borrow_mut().hide_opencode();
        self.logging.close();
        self.remote.close();
        if self.memory_editor.has_unsaved() {
            self.confirm_close = true;
        } else {
            self.closing = true;
            tx.close_window();
        }
    }

    fn retain_editor_on_native_close(&mut self) -> bool {
        if !self.memory_editor.has_unsaved() || self.token.as_ref().is_some_and(|token| token.get())
        {
            return false;
        }
        let Some(request) = &self.close_request else {
            return false;
        };
        *request.reopen.borrow_mut() = Some(std::mem::take(&mut self.memory_editor));
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
            prefs.window_wake = None;
            prefs.hide_opencode();
            prefs.memory.show(false);
            prefs.provider_target = None;
        }
        if !self.token.take().is_some_and(|token| token.get()) {
            super::settle_close(&self.shared, warn);
        }
    }
}

pub(super) fn focus(s: &mut Window, focused: bool, _: &mut rune::Tx) {
    s.focused.set(focused);
}

pub(super) fn closed(s: &mut Window, _: &mut rune::Tx) {
    s.focused.set(false);
    #[cfg(target_os = "windows")]
    crate::platform::preferences_placement::closed();
    s.shared.borrow_mut().hide_opencode();
    if !s.retain_editor_on_native_close() {
        s.close(super::warn_save_failed);
    }
}

pub(super) fn save_warning(locale: &&'static str, cx: &mut Cx<&'static str>) -> El {
    use rune_theme_codenomad::Space;
    crate::strings::with_locale(locale, || {
        layout::render(cx, |_| {
            col()
                .full_width()
                .full_height()
                .reading_surface()
                .pad(Space::Lg)
                .separate(Space::Md)
                .child(text(t("settings.preferenceSaveFailed")).role("alert"))
                .child(layout::button_tx(
                    t("alertDialog.actions.ok"),
                    false,
                    |_: &mut &str, tx| {
                        tx.close_window();
                    },
                ))
        })
        .locale_direction(locale)
    })
}

pub(super) fn spec() -> AppSpec<Window> {
    AppSpec {
        setup: Some(|s, wake| {
            let mut prefs = s.shared.borrow_mut();
            prefs.window_wake = Some(wake);
            prefs.memory.show(s.section == Section::General);
            if prefs.backend.is_some() {
                prefs.refresh();
            }
        }),
        poll: Some(|s, _, tx| {
            let locale = s
                .shared
                .borrow()
                .locale()
                .unwrap_or_else(crate::strings::locale);
            crate::strings::with_locale(locale, || {
                let close_requested = s
                    .close_request
                    .as_ref()
                    .is_some_and(|request| request.requested.replace(false));
                if close_requested {
                    s.request_close(tx);
                    return true;
                }
                let mut prefs = s.shared.borrow_mut();
                let changed = prefs.poll();
                let recording_ended = s.section == Section::Shortcuts
                    && s.shortcut_capture
                        .poll(&mut s.recording_shortcut, &prefs, tx);
                if changed && let Some(wake) = &prefs.main_wake {
                    wake();
                }
                let updated =
                    prefs.revision != std::mem::replace(&mut s.seen_revision, prefs.revision);
                let editor_changed = prefs.memory.poll_editor(&mut s.memory_editor);
                if updated {
                    tx.set_title(crate::strings::with_locale(
                        prefs.locale().unwrap_or_else(crate::strings::locale),
                        || t("settings.title"),
                    ));
                }
                let status_changed = s.section == Section::OpenCode
                    && !s.confirm_close
                    && !s.closing
                    && prefs.window_wake.clone().is_some_and(|wake| {
                        prefs.show_opencode() | s.opencode.step(&mut prefs, &wake)
                    });
                let remote_changed = s.section == Section::Remote
                    && !s.confirm_close
                    && !s.closing
                    && prefs
                        .window_wake
                        .as_ref()
                        .is_some_and(|wake| s.remote.poll(&prefs, wake));
                drop(prefs);
                let providers_changed = if s.section == Section::Providers {
                    let prefs = s.shared.borrow();
                    let target = prefs.provider_target.as_ref().filter(|_| prefs.can_retry());
                    s.providers.poll(target, prefs.window_wake.as_ref())
                } else {
                    false
                };
                updated
                    | status_changed
                    | remote_changed
                    | providers_changed
                    | editor_changed
                    | recording_ended
            })
        }),
        on_key: Some(|s, event, tx| {
            if event.key != rune::Key::Escape {
                return false;
            }
            if s.confirm_close {
                s.confirm_close = false;
            } else if s.memory_editor.shown() {
                s.memory_editor.dismiss();
            } else {
                let cancelled = s.shared.borrow_mut().memory.cancel_cleanup_confirmation();
                if !cancelled {
                    s.request_close(tx);
                }
            }
            true
        }),
        #[cfg(any(test, feature = "test-support"))]
        scenes: &[
            ("settings", |s| s.shared.borrow_mut().fixture()),
            ("opencode", |s| {
                s.shared
                    .borrow_mut()
                    .fixture_locale(crate::strings::locale());
                s.section = Section::OpenCode;
                s.opencode.fixture();
            }),
        ],
        ..chrome::spec(t("settings.title"), Window::default, view)
    }
}

pub(super) fn view(s: &Window, cx: &mut Cx<Window>) -> El {
    if let Some(palette) = s.palette_choice.take() {
        let mut prefs = s.shared.borrow_mut();
        // Pointer actions can be queued on the previous tree when the system appearance changes.
        if palette.dark == prefs.dark(cx.system_dark()) {
            prefs.set_palette(palette);
            if let Some(wake) = &prefs.window_wake {
                wake();
            }
        }
    }
    let prefs = s.shared.borrow();
    if prefs.awaiting_appearance() {
        return rune::el().key("preferences-bootstrap");
    }
    let system_dark = cx.system_dark();
    let system_more = cx.system_increased_contrast();
    s.close_palette_on_slot_change(prefs.dark(system_dark));
    render_with(cx, &prefs, system_more, |_| {
        let general_label = t("settings.nav.general");
        let opencode_label = t("settings.nav.opencode");
        let notifications_label = t("settings.nav.notifications");
        let providers_label = t("settings.nav.providers");
        let conversation_label = t("settings.nav.chat");
        let shortcuts_label = t("settings.nav.hotkeys");
        let remote_label = t("settings.nav.remote");
        let section = match s.section {
            Section::General => general_label,
            Section::Conversation => conversation_label,
            Section::OpenCode => opencode_label,
            Section::Notifications => notifications_label,
            Section::Providers => providers_label,
            Section::Shortcuts => shortcuts_label,
            Section::Remote => remote_label,
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
            ],
            |s: &mut Window, key| {
                s.picker.set(None);
                s.contrast_help = false;
                s.recording_shortcut = false;
                s.shortcut_capture = Default::default();
                s.permissions.close();
                s.section = match key {
                    "settings-opencode" => Section::OpenCode,
                    "settings-conversation" => Section::Conversation,
                    "settings-notifications" => Section::Notifications,
                    "settings-providers" => Section::Providers,
                    "settings-hotkeys" => Section::Shortcuts,
                    "settings-remote" => Section::Remote,
                    _ => Section::General,
                };
                if s.section != Section::OpenCode {
                    s.opencode = opencode::Status::default();
                    s.logging.close();
                    s.shared.borrow_mut().hide_opencode();
                }
                s.shared
                    .borrow_mut()
                    .memory
                    .show(s.section == Section::General);
                s.memory_help_failed = false;
                if s.section != Section::Providers {
                    s.providers.suspend();
                }
                if s.section != Section::Remote {
                    s.remote.close();
                }
            },
        );
        let mut layers = Vec::new();
        let status = if let Some(error) = prefs.error().or_else(|| {
            (prefs.backend.is_none() && prefs.saved(Owner::Config).is_none())
                .then_some("rune.connect_error")
        }) {
            layout::action_row()
                .child(text(t(error)).role("alert"))
                .child(layout::button(
                    t("sessionList.loadError.retry"),
                    !prefs.can_retry(),
                    |s: &mut Window| {
                        s.shared.borrow_mut().retry();
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
            Section::Conversation => (
                "conversation",
                super::conversation::row(
                    &prefs,
                    s.picker.get() == Some(Picker::Usage),
                    &mut layers,
                    |s: &mut Window, open| s.picker.set(open.then_some(Picker::Usage)),
                    |s: &mut Window, mode| s.shared.borrow_mut().set_usage_visibility(mode),
                ),
            ),
            Section::General => (
                "general",
                general::view(s, &prefs, system_dark, system_more, &mut layers),
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
            Section::Remote => (
                "remote",
                s.remote.view(&s.shared, |s: &mut Window| {
                    (s.section == Section::Remote && !s.closing && !s.confirm_close)
                        .then_some(&mut s.remote)
                }),
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
        if s.confirm_close {
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
