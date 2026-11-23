mod general;
#[cfg(test)]
mod tests;

use super::{
    opencode,
    preferences::{Owner, Preferences},
    render_with,
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
    seen_revision: u64,
    open_code_section: bool,
    pub(super) opencode: opencode::Status,
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
        self.shared.borrow_mut().window_wake = None;
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
            if updated {
                tx.set_title(crate::strings::with_locale(
                    prefs.locale().unwrap_or_else(crate::strings::locale),
                    || t("settings.title"),
                ));
            }
            drop(prefs);
            let status_changed = s.opencode.poll();
            if s.open_code_section {
                s.check_opencode(None);
            }
            updated | status_changed
        }),
        on_key: Some(|_, event, tx| {
            if event.key != rune::Key::Escape {
                return false;
            }
            tx.close_window();
            true
        }),
        #[cfg(any(test, feature = "test-support"))]
        scenes: &[
            ("settings", |s| s.shared.borrow_mut().fixture()),
            ("opencode", |s| {
                s.shared
                    .borrow_mut()
                    .fixture_locale(crate::strings::locale());
                s.open_code_section = true;
                s.opencode.fixture();
            }),
        ],
        ..chrome::spec(t("settings.title"), Window::default, view)
    }
}

fn view(s: &Window, cx: &mut Cx<Window>) -> El {
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
    let system_dark = cx.system_dark();
    s.close_palette_on_slot_change(prefs.dark(system_dark));
    render_with(cx, &prefs, |_| {
        let general_label = t("settings.nav.general");
        let opencode_label = t("settings.nav.opencode");
        let section = if s.open_code_section {
            opencode_label
        } else {
            general_label
        };
        let nav = chrome::nav(
            t("settings.title"),
            t("settings.navigationAriaLabel"),
            [
                ("settings-general", general_label, !s.open_code_section),
                ("settings-opencode", opencode_label, s.open_code_section),
            ],
            |s: &mut Window, key| {
                s.picker.set(None);
                s.open_code_section = key == "settings-opencode";
                if !s.open_code_section {
                    s.opencode = opencode::Status::default();
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
        let (key, controls) = if s.open_code_section {
            ("opencode", opencode::view(s))
        } else {
            (
                "general",
                general::view(s, &prefs, system_dark, &mut layers),
            )
        };
        chrome::frame(nav, chrome::pane(key, section, [status, controls]), layers).on_window_focus(
            |s: &mut Window, focused, _| {
                if focused && s.open_code_section {
                    s.check_opencode(Some(false));
                }
            },
        )
    })
}
