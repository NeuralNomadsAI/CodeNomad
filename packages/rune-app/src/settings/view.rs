use super::{
    opencode,
    preferences::{Owner, Preferences},
    render_with,
};
use crate::strings::t;
use rune::{AppSpec, Cx, El, col, text};
use rune_theme_codenomad::{
    catalogue::LANGUAGE_NAMES,
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Picker {
    Locale,
    Palette(bool),
}

impl Picker {
    fn key(self) -> &'static str {
        match self {
            Self::Locale => "locale",
            Self::Palette(_) => "palette",
        }
    }
}

impl Window {
    pub(super) fn check_opencode(&mut self, recheck: bool) {
        let prefs = self.shared.borrow();
        let backend = prefs.backend.as_ref().filter(|_| prefs.can_retry());
        self.opencode
            .read(backend, prefs.window_wake.as_ref(), recheck);
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

    fn toggle_picker(&self, picker: Picker) {
        self.picker
            .set((self.picker.get() != Some(picker)).then_some(picker));
    }

    fn close_palette_on_slot_change(&self, dark: bool) {
        // Removing the kit modal returns focus to its trigger.
        if self.picker.get() == Some(Picker::Palette(!dark)) {
            self.picker.set(None);
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
            if s.open_code_section {
                s.check_opencode(false);
            }
            updated | s.opencode.poll()
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
                s.shared.borrow_mut().fixture();
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
            ("general", general(s, &prefs, system_dark, &mut layers))
        };
        chrome::frame(nav, chrome::pane(key, section, [status, controls]), layers)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime};
    use serde_json::Value;

    fn node<'a>(tree: &'a Value, key: &str) -> Option<&'a Value> {
        if tree["key"] == key {
            return Some(tree);
        }
        tree["children"]
            .as_array()?
            .iter()
            .find_map(|child| node(child, key))
    }

    #[test]
    fn settings_shutdown_failure_warning_requires_visible_acknowledgement() {
        let mut runtime = Runtime::new("en", save_warning, (460.0, 150.0), Env::new(false, 1.0));
        runtime.frame(0.0);
        let tree = runtime.accessibility_json().to_string();
        assert!(tree.contains("Could not save the preference."));
        assert!(tree.contains("\"role\":\"alert\""));
        assert!(tree.contains("\"name\":\"OK\""));
    }

    #[test]
    fn settings_opencode_versions_and_fold_use_the_runtime() {
        let mut state = Window::default();
        state.shared.borrow_mut().fixture();
        state.opencode.fixture();
        let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
        rt.frame(0.0);
        let click = |rt: &mut Runtime<Window>, key| {
            let (x, y) = rt.find(key).unwrap();
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            rt.frame(0.02);
        };
        assert!(
            !rt.accessibility_json()
                .to_string()
                .contains("Installed version")
        );
        click(&mut rt, "settings-opencode");
        let before = rt.accessibility_json().to_string();
        assert!(before.contains("2.3.0") && before.contains("2.2.5"));
        assert!(!before.contains("Minimum version"));
        click(&mut rt, "trigger");
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("Minimum version")
        );
        click(&mut rt, "settings-general");
        assert!(
            !rt.accessibility_json()
                .to_string()
                .contains("Installed version")
        );
    }

    #[test]
    fn settings_palette_selector_uses_active_appearance_and_returns_focus_on_escape() {
        for (dark, option, absent) in [(false, "Linen", "Basalt"), (true, "Basalt", "Linen")] {
            let state = Window::default();
            state.shared.borrow_mut().fixture();
            let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(dark, 1.0));
            runtime.frame(0.0);
            let tree = runtime.accessibility_json();
            assert_eq!(node(&tree, "locale-trigger").unwrap()["value"], "English");
            let (x, y) = runtime.find("palette-trigger").unwrap();
            runtime.pointer_down(x, y);
            runtime.pointer_up(x, y);
            runtime.frame(0.02);
            let tree = runtime.accessibility_json();
            let list = node(&tree, "listbox").expect("open palette menu");
            assert!(list.to_string().contains(option));
            assert!(!list.to_string().contains(absent));
            runtime.key(rune::KeyEvent {
                key: rune::Key::Escape,
                mods: rune::Mods::default(),
            });
            runtime.frame(0.02);
            let tree = runtime.accessibility_json();
            assert!(node(&tree, "listbox").is_none());
            let trigger = node(&tree, "palette-trigger").unwrap();
            assert!(trigger["states"].to_string().contains("collapsed"));
            assert!(trigger["states"].to_string().contains("focused"));
        }
    }

    #[test]
    fn settings_palette_menu_tracks_effective_appearance_and_returns_keyboard_focus() {
        let state = Window::default();
        state.shared.borrow_mut().fixture();
        let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
        let press = |rt: &mut Runtime<Window>, key| {
            let event = rune::KeyEvent {
                key,
                mods: rune::Mods::default(),
            };
            rt.key(event.clone());
            rt.key_up(event);
            rt.frame(0.02);
        };
        runtime.frame(0.0);
        runtime.update(|_, tx| tx.focus("palette-trigger", true));
        runtime.frame(0.02);
        press(&mut runtime, rune::Key::Enter);
        press(&mut runtime, rune::Key::Down);
        let tree = runtime.accessibility_json();
        let menu = node(&tree, "listbox").unwrap();
        assert!(menu.to_string().contains("Linen"));
        assert!(menu.to_string().contains("focused"));

        runtime.update(|s, _| s.shared.borrow_mut().fixture_mode("light"));
        runtime.frame(0.02);
        let tree_after_same_slot = runtime.accessibility_json();
        assert_eq!(node(&tree_after_same_slot, "listbox").unwrap(), menu);
        runtime.update(|s, _| s.shared.borrow_mut().fixture_mode("system"));
        runtime.set_system_dark(true);
        runtime.frame(0.02);
        let tree = runtime.accessibility_json();
        assert!(node(&tree, "listbox").is_none());
        assert!(
            node(&tree, "palette-trigger").unwrap()["states"]
                .to_string()
                .contains("focused")
        );
        press(&mut runtime, rune::Key::Enter);
        let tree = runtime.accessibility_json();
        assert!(
            node(&tree, "listbox")
                .unwrap()
                .to_string()
                .contains("Basalt")
        );
        runtime.update(|s, _| s.shared.borrow_mut().fixture_mode("light"));
        runtime.frame(0.02);
        assert!(node(&runtime.accessibility_json(), "listbox").is_none());
    }

    #[test]
    fn settings_palette_pointer_release_cannot_commit_a_stale_system_slot() {
        for change_theme in [false, true] {
            let state = Window::default();
            let mut prefs = state.shared.borrow_mut();
            prefs.fixture();
            prefs.backend = Some(
                crate::platform::block_on(crate::backend::Backend::connect(
                    "http://127.0.0.1:9/",
                    "",
                ))
                .unwrap(),
            );
            drop(prefs);
            let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
            runtime.frame(0.0);
            let (x, y) = runtime.find("palette-trigger").unwrap();
            runtime.pointer_down(x, y);
            runtime.pointer_up(x, y);
            runtime.frame(0.02);
            let (x, y) = runtime.find("option1").unwrap();
            runtime.pointer_down(x, y);
            runtime.frame(0.02);
            runtime.pointer_up(x, y);
            runtime.set_system_dark(change_theme);
            runtime.frame(0.02);
            let prefs = runtime.state.shared.borrow();
            assert_eq!(
                prefs.palette_display(false).unwrap().id == "light",
                change_theme
            );
            assert!(node(&runtime.accessibility_json(), "listbox").is_none());
        }
    }

    #[test]
    fn settings_closed_palette_arrow_keeps_focus_and_advances_the_display() {
        let state = Window::default();
        let mut prefs = state.shared.borrow_mut();
        prefs.fixture();
        prefs.backend = Some(
            crate::platform::block_on(crate::backend::Backend::connect("http://127.0.0.1:9/", ""))
                .unwrap(),
        );
        drop(prefs);
        let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(true, 1.0));
        runtime.frame(0.0);
        runtime.update(|_, tx| tx.focus("palette-trigger", true));
        runtime.frame(0.02);
        for name in ["Mist", "Slate", "Clay"] {
            let event = rune::KeyEvent {
                key: rune::Key::Down,
                mods: rune::Mods::default(),
            };
            runtime.key(event.clone());
            runtime.key_up(event);
            runtime.frame(0.02);
            let tree = runtime.accessibility_json();
            let trigger = node(&tree, "palette-trigger").unwrap();
            assert_eq!(trigger["value"], name);
            assert!(trigger["states"].to_string().contains("focused"));
            assert!(node(&tree, "listbox").is_none());
        }
    }

    #[test]
    fn settings_mode_keeps_keyboard_focus_while_the_choice_is_unconfirmed() {
        let state = Window::default();
        let mut prefs = state.shared.borrow_mut();
        prefs.fixture();
        prefs.backend = Some(
            crate::platform::block_on(crate::backend::Backend::connect("http://127.0.0.1:9/", ""))
                .unwrap(),
        );
        drop(prefs);
        let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
        runtime.frame(0.0);
        runtime.update(|_, tx| tx.focus("segment0", true));
        runtime.frame(0.02);
        for key in ["segment1", "segment2"] {
            let event = rune::KeyEvent {
                key: rune::Key::Right,
                mods: rune::Mods::default(),
            };
            runtime.key(event.clone());
            runtime.key_up(event);
            runtime.frame(0.02);
            let tree = runtime.accessibility_json();
            assert!(
                node(&tree, key).unwrap()["states"]
                    .to_string()
                    .contains("focused")
            );
        }
        let prefs = runtime.state.shared.borrow();
        assert_eq!(prefs.mode(), "system");
        assert_eq!(prefs.mode_display(), "light");
        assert!(!prefs.palette_ready());
    }

    #[test]
    fn settings_language_picker_opens_with_enter() {
        let state = Window::default();
        state.shared.borrow_mut().fixture();
        let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
        runtime.frame(0.0);
        runtime.update(|_, tx| tx.focus("locale-trigger", true));
        runtime.frame(0.02);
        runtime.key(rune::KeyEvent {
            key: rune::Key::Enter,
            mods: rune::Mods::default(),
        });
        runtime.frame(0.02);
        let tree = runtime.accessibility_json();
        assert!(
            node(&tree, "listbox")
                .unwrap()
                .to_string()
                .contains("Français")
        );
    }
}

const MODES: [(&str, &str); 3] = [
    ("system", "settings.appearance.palette.auto"),
    (
        "dark",
        "settings.appearance.colorScheme.custom.appearance.dark",
    ),
    (
        "light",
        "settings.appearance.colorScheme.custom.appearance.light",
    ),
];

fn general(s: &Window, prefs: &Preferences, system_dark: bool, layers: &mut Vec<El>) -> El {
    let locale = prefs
        .locale_display()
        .unwrap_or_else(crate::strings::locale);
    let language = t("folderSelection.language.ariaLabel");
    let labels: Vec<_> = LANGUAGE_NAMES.iter().map(|(_, label)| *label).collect();
    let language_picker = select(
        s,
        Picker::Locale,
        language,
        &labels,
        LANGUAGE_NAMES
            .iter()
            .find(|(id, _)| *id == locale)
            .map(|(_, label)| *label),
        !prefs.locale_ready(),
        layers,
        |s, value| {
            if let Some((id, _)) = LANGUAGE_NAMES.iter().find(|(_, label)| *label == value) {
                s.shared.borrow_mut().set_locale(id);
            }
        },
    );
    let mode = t("settings.appearance.palette.mode");
    let segments = chrome::segments(
        mode,
        &MODES.map(|(_, label)| t(label)),
        MODES.iter().position(|(id, _)| *id == prefs.mode_display()),
        !prefs.mode_ready(),
        |s: &mut Window, i| {
            if let Some((mode, _)) = MODES.get(i) {
                s.shared.borrow_mut().set_mode(mode);
            }
        },
    );
    let dark = layout::dark();
    let palette = t("settings.appearance.colorScheme.title");
    let labels: Vec<_> = palettes::built_in()
        .iter()
        .filter(|p| p.dark == dark)
        .map(|p| t(p.label))
        .collect();
    let current = prefs.palette_display(dark).map(|p| t(p.label));
    let palette_picker = select(
        s,
        Picker::Palette(dark),
        palette,
        &labels,
        current,
        !prefs.palette_ready(),
        layers,
        move |s, value| {
            if let Some(palette) = palettes::built_in()
                .iter()
                .find(|p| p.dark == dark && t(p.label) == value)
            {
                s.palette_choice.set(Some(palette));
            }
        },
    );
    col()
        .full_width()
        .on_key(move |s: &mut Window, event, tx| {
            if event.mods != rune::Mods::default() || s.picker.get().is_some() {
                return false;
            }
            if event.key == rune::Key::Enter && !tx.key_repeat() {
                match tx.focused() {
                    Some("locale-trigger") if s.shared.borrow().locale_ready() => {
                        s.toggle_picker(Picker::Locale);
                        return true;
                    }
                    Some("palette-trigger") if s.shared.borrow().palette_ready() => {
                        s.toggle_picker(Picker::Palette(dark));
                        return true;
                    }
                    _ => {}
                }
            }
            if tx.focused() != Some("palette-trigger") {
                return false;
            }
            let step = match event.key {
                rune::Key::Up => -1,
                rune::Key::Down => 1,
                _ => return false,
            };
            let mut prefs = s.shared.borrow_mut();
            if prefs.dark(system_dark) == dark {
                prefs.step_palette(dark, step);
            }
            true
        })
        .child(chrome::card(chrome::setting_row(language, language_picker)))
        .child(chrome::card(chrome::color_scheme(
            palette,
            mode,
            segments,
            palette_picker,
        )))
}

fn select(
    s: &Window,
    picker: Picker,
    label: &str,
    options: &[&str],
    current: Option<&str>,
    disabled: bool,
    layers: &mut Vec<El>,
    choose: impl FnOnce(&mut Window, &str) + Clone + 'static,
) -> El {
    // Pick callbacks run outside the scoped render.
    let locale = crate::strings::locale();
    let control = chrome::picker(picker.key(), label, options)
        .current(current)
        .disabled(disabled)
        .open(s.picker.get() == Some(picker))
        .on_toggle(move |s: &mut Window| s.toggle_picker(picker))
        .on_close(|s: &mut Window| s.picker.set(None))
        .on_choose(move |s: &mut Window, value, _| {
            if s.picker.get() == Some(picker) {
                s.picker.set(None);
                crate::strings::with_locale(locale, || choose.clone()(s, value));
            }
        });
    chrome::build_picker(control, layers)
}
