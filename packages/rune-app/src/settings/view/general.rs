use super::*;
use rune_theme_codenomad::catalogue::LANGUAGE_NAMES;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Picker {
    Locale,
    Palette(bool),
    Usage,
}

impl Window {
    fn toggle_picker(&self, picker: Picker) {
        self.picker
            .set((self.picker.get() != Some(picker)).then_some(picker));
    }

    pub(super) fn close_palette_on_slot_change(&self, dark: bool) {
        // Removing the kit modal returns focus to its trigger.
        if self.picker.get() == Some(Picker::Palette(!dark)) {
            self.picker.set(None);
        }
    }
}

impl Picker {
    fn key(self) -> &'static str {
        match self {
            Self::Locale => "locale",
            Self::Palette(_) => "palette",
            Self::Usage => "usage-visibility",
        }
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

pub(super) fn view(
    s: &Window,
    prefs: &Preferences,
    system_dark: bool,
    system_more: bool,
    layers: &mut Vec<El>,
) -> El {
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
            super::super::contrast::view(
                prefs,
                system_more,
                s.contrast_help,
                |s: &mut Window| s.contrast_help = !s.contrast_help,
                |s: &mut Window, value| s.shared.borrow_mut().set_contrast(value),
            ),
            palette_picker,
        )))
        .child(super::super::memory::view(
            prefs,
            s.memory_help_failed,
            |s: &mut Window, desired| {
                super::super::memory::action(&mut s.shared.borrow_mut(), desired)
            },
            |s: &mut Window, failed| s.memory_help_failed = failed,
            |s: &mut Window, edit| s.memory_editor.open(edit),
            |s: &mut Window, action| {
                super::super::memory::review_action(&mut s.shared.borrow_mut(), action);
            },
        ))
        .child(
            s.permissions
                .view(&s.shared, layers, |s: &mut Window| &mut s.permissions),
        )
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
