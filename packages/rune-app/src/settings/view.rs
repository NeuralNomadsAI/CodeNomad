use super::{
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
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(super) struct Window {
    shared: Rc<RefCell<Preferences>>,
    #[cfg(not(target_arch = "wasm32"))]
    token: Option<Rc<()>>,
    picker: Option<&'static str>,
    seen_revision: u64,
}
impl Window {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(shared: Rc<RefCell<Preferences>>, token: Rc<()>) -> Self {
        Self {
            shared,
            token: Some(token),
            ..Self::default()
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn closed(s: &mut Window, _: &mut rune::Tx) {
    s.shared.borrow_mut().window_wake = None;
    s.token = None;
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
            updated
        }),
        on_key: Some(|_, event, tx| {
            if event.key != rune::Key::Escape {
                return false;
            }
            tx.close_window();
            true
        }),
        #[cfg(any(test, feature = "test-support"))]
        scenes: &[("settings", |s| s.shared.borrow_mut().fixture())],
        ..chrome::spec(t("settings.title"), Window::default, view)
    }
}

fn view(s: &Window, cx: &mut Cx<Window>) -> El {
    let prefs = s.shared.borrow();
    render_with(cx, &prefs, |_| {
        let section = t("settings.nav.general");
        let nav = chrome::nav(
            t("settings.title"),
            t("settings.navigationAriaLabel"),
            [("settings-general", section, true)],
            |s: &mut Window, _| s.picker = None,
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
                    prefs.backend.is_none(),
                    |s: &mut Window| {
                        s.shared.borrow_mut().refresh();
                    },
                ))
        } else if prefs.saved(Owner::Config).is_none() {
            text(t("rune.loading")).role("status")
        } else {
            rune::el()
        };
        let content = [status, general(s, &prefs, &mut layers)];
        chrome::frame(nav, chrome::pane("general", section, content), layers)
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

fn general(s: &Window, prefs: &Preferences, layers: &mut Vec<El>) -> El {
    let locale = prefs
        .locale_display()
        .unwrap_or_else(crate::strings::locale);
    let language = t("folderSelection.language.ariaLabel");
    let labels: Vec<_> = LANGUAGE_NAMES.iter().map(|(_, label)| *label).collect();
    let language_picker = select(
        s,
        "locale",
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
        "palette",
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
                s.shared.borrow_mut().set_palette(palette);
            }
        },
    );
    col()
        .full_width()
        .on_key(move |s: &mut Window, event, tx| {
            if event.mods != rune::Mods::default()
                || s.picker.is_some()
                || tx.focused() != Some("palette-trigger")
            {
                return false;
            }
            let step = match event.key {
                rune::Key::Up => -1,
                rune::Key::Down => 1,
                _ => return false,
            };
            s.shared.borrow_mut().step_palette(dark, step);
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
    key: &'static str,
    label: &str,
    options: &[&str],
    current: Option<&str>,
    disabled: bool,
    layers: &mut Vec<El>,
    choose: impl FnOnce(&mut Window, &str) + Clone + 'static,
) -> El {
    // Pick callbacks run outside the scoped render.
    let locale = crate::strings::locale();
    let control = chrome::picker(key, label, options)
        .current(current)
        .disabled(disabled)
        .open(s.picker == Some(key))
        .on_toggle(move |s: &mut Window| s.picker = (s.picker != Some(key)).then_some(key))
        .on_close(|s: &mut Window| s.picker = None)
        .on_choose(move |s: &mut Window, value, _| {
            if s.picker == Some(key) {
                s.picker = None;
                crate::strings::with_locale(locale, || choose.clone()(s, value));
            }
        });
    chrome::build_picker(control, layers)
}
