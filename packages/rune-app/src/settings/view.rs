mod general;
#[cfg(test)]
mod tests;

use super::{
    opencode,
    preferences::{Owner, Preferences},
    providers, render_with,
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
    picker: Cell<Option<Picker>>,
    palette_choice: Cell<Option<&'static palettes::Palette>>,
    contrast_help: bool,
    permissions: super::behavior::Permissions,
    memory_help_failed: bool,
    memory_editor: super::memory::editor::Editor,
    seen_revision: u64,
    section: Section,
    pub(super) opencode: opencode::Status,
    pub(super) providers: providers::Catalog,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    General,
    OpenCode,
    Providers,
}

impl Default for Section {
    fn default() -> Self {
        Self::General
    }
}

impl Window {
    pub(super) fn check_opencode(&mut self, refresh: Option<bool>) {
        let prefs = self.shared.borrow();
        let backend = prefs.backend.as_ref().filter(|_| prefs.can_retry());
        self.opencode
            .read(backend, prefs.window_wake.as_ref(), refresh);
    }

    pub(super) fn has_backend(&self) -> bool {
        self.shared.borrow().can_retry()
    }

    pub fn new(shared: Rc<RefCell<Preferences>>, token: Rc<Cell<bool>>) -> Self {
        Self {
            shared,
            token: Some(token),
            ..Self::default()
        }
    }

    pub(super) fn close(&mut self, warn: impl FnOnce(&'static str)) {
        {
            let mut prefs = self.shared.borrow_mut();
            prefs.window_wake = None;
            prefs.memory.show(false);
            prefs.provider_target = None;
        }
        if !self.token.take().is_some_and(|token| token.get()) {
            super::settle_close(&self.shared, warn);
        }
    }
}

pub(super) fn closed(s: &mut Window, _: &mut rune::Tx) {
    #[cfg(target_os = "windows")]
    crate::platform::preferences_placement::closed();
    s.close(super::warn_save_failed);
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
            let mut prefs = s.shared.borrow_mut();
            let changed = prefs.poll();
            if changed && let Some(wake) = &prefs.main_wake {
                wake();
            }
            let updated = prefs.revision != std::mem::replace(&mut s.seen_revision, prefs.revision);
            let editor_changed = prefs.memory.poll_editor(&mut s.memory_editor);
            if updated {
                tx.set_title(crate::strings::with_locale(
                    prefs.locale().unwrap_or_else(crate::strings::locale),
                    || t("settings.title"),
                ));
            }
            drop(prefs);
            let status_changed = s.opencode.poll();
            if s.section == Section::OpenCode {
                s.check_opencode(None);
            }
            let providers_changed = if s.section == Section::Providers {
                let prefs = s.shared.borrow();
                let target = prefs.provider_target.as_ref().filter(|_| prefs.can_retry());
                s.providers.poll(target, prefs.window_wake.as_ref())
            } else {
                false
            };
            updated | status_changed | providers_changed | editor_changed
        }),
        on_key: Some(|s, event, tx| {
            if event.key != rune::Key::Escape {
                return false;
            }
            if s.memory_editor.shown() {
                s.memory_editor.dismiss();
            } else if !s.shared.borrow_mut().memory.cancel_cleanup_confirmation() {
                tx.close_window();
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
        let providers_label = t("settings.nav.providers");
        let section = match s.section {
            Section::General => general_label,
            Section::OpenCode => opencode_label,
            Section::Providers => providers_label,
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
                    "settings-opencode",
                    opencode_label,
                    s.section == Section::OpenCode,
                ),
                (
                    "settings-providers",
                    providers_label,
                    s.section == Section::Providers,
                ),
            ],
            |s: &mut Window, key| {
                s.picker.set(None);
                s.contrast_help = false;
                s.permissions.close();
                s.section = match key {
                    "settings-opencode" => Section::OpenCode,
                    "settings-providers" => Section::Providers,
                    _ => Section::General,
                };
                if s.section != Section::OpenCode {
                    s.opencode = opencode::Status::default();
                }
                s.shared
                    .borrow_mut()
                    .memory
                    .show(s.section == Section::General);
                s.memory_help_failed = false;
                if s.section != Section::Providers {
                    s.providers.suspend();
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
            Section::OpenCode => ("opencode", opencode::view(s)),
            Section::General => (
                "general",
                general::view(s, &prefs, system_dark, system_more, &mut layers),
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
        chrome::frame(nav, chrome::pane(key, section, [status, controls]), layers).on_window_focus(
            |s: &mut Window, focused, _| {
                if focused && s.section == Section::OpenCode {
                    s.check_opencode(Some(false));
                } else if focused && s.section == Section::General {
                    s.shared.borrow_mut().memory.invalidate();
                }
            },
        )
    })
}
