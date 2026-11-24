use super::{Preferences, contrast};
use crate::strings::t;
use rune::{El, col};
use rune_theme_codenomad::{
    catalogue::LANGUAGE_NAMES,
    layout::{self, Layout},
    palettes, settings as chrome,
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

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

#[derive(Default)]
pub(super) struct Controls {
    picker: Cell<Option<Picker>>,
    palette_choice: Cell<Option<&'static palettes::Palette>>,
    contrast_help: bool,
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

impl Controls {
    pub(super) fn close(&mut self) {
        self.picker.set(None);
        self.palette_choice.set(None);
        self.contrast_help = false;
    }

    pub(super) fn close_palette_on_slot_change(&self, dark: bool) {
        // Removing the kit modal returns focus to its trigger.
        if self.picker.get() == Some(Picker::Palette(!dark)) {
            self.picker.set(None);
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub(super) fn discard_palette(&self) {
        self.palette_choice.set(None);
    }

    pub(super) fn commit_palette(&self, shared: &RefCell<Preferences>, system_dark: bool) {
        let Some(palette) = self.palette_choice.take() else {
            return;
        };
        let mut prefs = shared.borrow_mut();
        // Pointer actions can be queued on the previous tree when the system appearance changes.
        if palette.dark == prefs.dark(system_dark) {
            prefs.set_palette(palette);
            for wake in [&prefs.main_wake, &prefs.window_wake].into_iter().flatten() {
                wake();
            }
        }
    }

    fn toggle_picker(&self, picker: Picker) {
        self.picker
            .set((self.picker.get() != Some(picker)).then_some(picker));
    }

    pub(super) fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        system_dark: bool,
        system_more: bool,
        layers: &mut Vec<El>,
        access: fn(&mut S) -> &mut Self,
    ) -> El {
        let prefs = shared.borrow();
        let locale = prefs
            .locale_display()
            .unwrap_or_else(crate::strings::locale);
        let language = t("folderSelection.language.ariaLabel");
        let labels: Vec<_> = LANGUAGE_NAMES.iter().map(|(_, label)| *label).collect();
        let locale_shared = shared.clone();
        let language_picker = self.select(
            Picker::Locale,
            language,
            &labels,
            LANGUAGE_NAMES
                .iter()
                .find(|(id, _)| *id == locale)
                .map(|(_, label)| *label),
            !prefs.locale_ready(),
            layers,
            access,
            move |_, value| {
                if let Some((id, _)) = LANGUAGE_NAMES.iter().find(|(_, label)| *label == value) {
                    locale_shared.borrow_mut().set_locale(id);
                }
            },
        );
        let mode = t("settings.appearance.palette.mode");
        let mode_shared = shared.clone();
        let segments = chrome::segments(
            mode,
            &MODES.map(|(_, label)| t(label)),
            MODES.iter().position(|(id, _)| *id == prefs.mode_display()),
            !prefs.mode_ready(),
            move |_: &mut S, i| {
                if let Some((mode, _)) = MODES.get(i) {
                    mode_shared.borrow_mut().set_mode(mode);
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
        let palette_picker = self.select(
            Picker::Palette(dark),
            palette,
            &labels,
            current,
            !prefs.palette_ready(),
            layers,
            access,
            move |s, value| {
                if let Some(palette) = palettes::built_in()
                    .iter()
                    .find(|p| p.dark == dark && t(p.label) == value)
                {
                    access(s).palette_choice.set(Some(palette));
                }
            },
        );
        let key_shared = shared.clone();
        let contrast_shared = shared.clone();
        col()
            .full_width()
            .on_key(move |s: &mut S, event, tx| {
                if event.mods != rune::Mods::default() || access(s).picker.get().is_some() {
                    return false;
                }
                if event.key == rune::Key::Enter && !tx.key_repeat() {
                    match tx.focused() {
                        Some("locale-trigger") if key_shared.borrow().locale_ready() => {
                            access(s).toggle_picker(Picker::Locale);
                            return true;
                        }
                        Some("palette-trigger") if key_shared.borrow().palette_ready() => {
                            access(s).toggle_picker(Picker::Palette(dark));
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
                let mut prefs = key_shared.borrow_mut();
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
                contrast::view(
                    &prefs,
                    system_more,
                    self.contrast_help,
                    move |s: &mut S| {
                        let controls = access(s);
                        controls.contrast_help = !controls.contrast_help;
                    },
                    move |_: &mut S, value| contrast_shared.borrow_mut().set_contrast(value),
                ),
                palette_picker,
            )))
    }

    #[allow(clippy::too_many_arguments)]
    fn select<S: 'static>(
        &self,
        picker: Picker,
        label: &str,
        options: &[&str],
        current: Option<&str>,
        disabled: bool,
        layers: &mut Vec<El>,
        access: fn(&mut S) -> &mut Self,
        choose: impl FnOnce(&mut S, &str) + Clone + 'static,
    ) -> El {
        if disabled && self.picker.get() == Some(picker) {
            self.picker.set(None);
        }
        // Pick callbacks run outside the scoped render.
        let locale = crate::strings::locale();
        let control = chrome::picker(picker.key(), label, options)
            .current(current)
            .disabled(disabled)
            .open(self.picker.get() == Some(picker))
            .on_toggle(move |s: &mut S| access(s).toggle_picker(picker))
            .on_close(move |s: &mut S| access(s).picker.set(None))
            .on_choose(move |s: &mut S, value, _| {
                if access(s).picker.get() == Some(picker) {
                    access(s).picker.set(None);
                    crate::strings::with_locale(locale, || choose.clone()(s, value));
                }
            });
        let trigger = chrome::build_picker(control, layers);
        // The browser mirror exposes the select trigger as a button without its native value.
        #[cfg(target_arch = "wasm32")]
        let trigger = trigger.description(current.unwrap_or(""));
        trigger
    }
}
