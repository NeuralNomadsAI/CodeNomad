use super::{
    Preferences, contrast,
    palettes::{self, MAX_PRESET_NAME_LEN, PaletteOption},
};
use crate::strings::t;
use rune::{El, TextEdit, col};
use rune_theme_codenomad::{
    catalogue::LANGUAGE_NAMES,
    layout::{self, Layout},
    palettes::{ColorField, ColorSchemeColors, format_hex, normalize_hex},
    settings::{self as chrome, palette as palette_ui},
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

#[derive(Clone, PartialEq, Eq)]
enum PendingDiscard {
    Mode(&'static str),
    Palette { dark: bool, key: String },
}

#[derive(Clone, PartialEq, Eq)]
enum SavedTarget {
    BuiltInOrCustom,
    Preset {
        key: String,
        name: String,
    },
    Reset {
        key: String,
        default_colors: ColorSchemeColors,
    },
    Select {
        key: String,
        name: String,
        dark: bool,
        colors: Box<ColorSchemeColors>,
    },
    Mode,
    Delete,
}

#[derive(Clone, PartialEq, Eq)]
struct ActiveSwatch {
    field: ColorField,
    dark: bool,
    key: String,
}

#[derive(Default)]
struct Draft {
    binding_epoch: u64,
    editing_key: String,
    source_name: String,
    dark: bool,
    colors: ColorSchemeColors,
    edited_fields: Vec<ColorField>,
    creating: bool,
    dirty: bool,
    pending_create_id: Option<String>,
    active_swatch: Option<ActiveSwatch>,
    local_error: bool,
    pending_delete: Option<(String, String)>,
    pending_discard: Option<PendingDiscard>,
    awaiting_save: Option<SavedTarget>,
}

#[derive(Default)]
pub(super) struct Controls {
    picker: Cell<Option<Picker>>,
    palette_choice: Cell<Option<String>>,
    contrast_help: bool,
    pub(super) startup_help: bool,
    name_input: TextEdit,
    hex_input: TextEdit,
    draft: RefCell<Draft>,
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

fn wake_all(prefs: &Preferences) {
    for wake in [&prefs.main_wake, &prefs.window_wake].into_iter().flatten() {
        wake();
    }
}

fn clamp_preset_name(mut edit: TextEdit) -> TextEdit {
    if edit.text.chars().count() > MAX_PRESET_NAME_LEN {
        let clamped: String = edit.text.chars().take(MAX_PRESET_NAME_LEN).collect();
        edit = TextEdit::new(&clamped);
    }
    edit
}

fn unique_picker_pairs(options: &[PaletteOption]) -> Vec<(String, String)> {
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(options.len());
    for option in options {
        let label = if used.insert(option.name.clone()) {
            option.name.clone()
        } else {
            let mut suffix = 2usize;
            let mut candidate = format!("{} ({})", option.name, suffix);
            while !used.insert(candidate.clone()) {
                suffix += 1;
                candidate = format!("{} ({})", option.name, suffix);
            }
            candidate
        };
        out.push((label, option.key.clone()));
    }
    out
}

impl Controls {
    pub(super) fn close(&mut self) {
        self.picker.set(None);
        self.palette_choice.set(None);
        self.contrast_help = false;
        self.startup_help = false;
        let draft = self.draft.get_mut();
        draft.active_swatch = None;
        draft.pending_delete = None;
        draft.pending_discard = None;
    }

    pub(super) fn dirty(&self) -> bool {
        self.draft.borrow().dirty
    }

    #[cfg(test)]
    pub(super) fn fixture_dirty(&mut self) {
        self.draft.get_mut().dirty = true;
    }

    pub(super) fn busy(&self, prefs: &Preferences) -> bool {
        prefs.palette_saving() || self.draft.borrow().awaiting_save.is_some()
    }

    pub(super) fn discard_draft(&mut self, prefs: &mut Preferences) {
        let draft = self.draft.get_mut();
        draft.dirty = false;
        draft.edited_fields.clear();
        draft.creating = false;
        draft.pending_create_id = None;
        draft.active_swatch = None;
        draft.local_error = false;
        draft.pending_delete = None;
        draft.pending_discard = None;
        draft.awaiting_save = None;
        prefs.set_palette_preview(None);
        prefs.clear_palette_save_failed();
    }

    pub(super) fn dismiss_overlay(&mut self) -> bool {
        let draft = self.draft.get_mut();
        if draft.pending_delete.take().is_some() {
            return true;
        }
        if draft.pending_discard.take().is_some() {
            return true;
        }
        if draft.active_swatch.take().is_some() {
            return true;
        }
        if self.picker.take().is_some() {
            return true;
        }
        false
    }

    pub(super) fn close_palette_on_slot_change(&self, dark: bool) {
        let mut draft = self.draft.borrow_mut();
        let active_dark = if draft.dirty || draft.awaiting_save.is_some() {
            draft.dark
        } else {
            dark
        };
        // Removing the kit modal returns focus to its trigger.
        if self.picker.get() == Some(Picker::Palette(!active_dark)) {
            self.picker.set(None);
        }
        if !draft.dirty
            && draft.awaiting_save.is_none()
            && draft
                .active_swatch
                .as_ref()
                .is_some_and(|swatch| swatch.dark != dark)
        {
            draft.active_swatch = None;
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub(super) fn discard_palette(&self) {
        self.palette_choice.set(None);
    }

    pub(super) fn commit_palette(&self, shared: &RefCell<Preferences>, system_dark: bool) {
        let mut prefs = shared.borrow_mut();
        let dark = prefs.dark(system_dark);
        self.settle_and_sync(&mut prefs, dark);
        if self.draft.borrow().dirty && !prefs.has_palette_preview() {
            let (draft_dark, creating, editing_key, colors) = {
                let draft = self.draft.borrow();
                (
                    draft.dark,
                    draft.creating,
                    draft.editing_key.clone(),
                    draft.colors.clone(),
                )
            };
            let builtin_id = (!creating)
                .then(|| {
                    if editing_key == "builtin:custom" {
                        Some("custom")
                    } else {
                        prefs
                            .palette_options(draft_dark)
                            .into_iter()
                            .find(|candidate| candidate.key == editing_key)
                            .and_then(|candidate| candidate.builtin_id)
                    }
                })
                .flatten();
            prefs.set_palette_preview(Some((draft_dark, builtin_id, colors)));
            wake_all(&prefs);
        }
        let Some(key) = self.palette_choice.take() else {
            return;
        };
        let active_dark = {
            let draft = self.draft.borrow();
            if draft.dirty || draft.awaiting_save.is_some() {
                draft.dark
            } else {
                dark
            }
        };
        let options = prefs.palette_options(active_dark);
        let Some(option) = options.iter().find(|candidate| candidate.key == key) else {
            return;
        };
        if self.draft.borrow().dirty {
            if self.draft.borrow().editing_key != option.key {
                self.draft.borrow_mut().pending_discard = Some(PendingDiscard::Palette {
                    dark: active_dark,
                    key,
                });
            }
            return;
        }
        if self.draft.borrow().editing_key == option.key {
            return;
        }
        self.apply_option_selection(&mut prefs, option);
    }

    pub(super) fn settle_save(&self, prefs: &mut Preferences) -> bool {
        let mut draft = self.draft.borrow_mut();
        let mut settled = false;
        let epoch = prefs.binding_epoch();
        if draft.binding_epoch != epoch {
            draft.binding_epoch = epoch;
            draft.dirty = false;
            draft.edited_fields.clear();
            draft.creating = false;
            draft.pending_create_id = None;
            draft.active_swatch = None;
            draft.local_error = false;
            draft.pending_delete = None;
            draft.pending_discard = None;
            draft.awaiting_save = None;
            prefs.set_palette_preview(None);
            settled = true;
        }
        if let Some(target) = draft.awaiting_save.clone()
            && !prefs.palette_saving()
        {
            draft.awaiting_save = None;
            settled = true;
            if !prefs.palette_save_failed() {
                draft.dirty = false;
                draft.edited_fields.clear();
                draft.creating = false;
                draft.pending_create_id = None;
                draft.active_swatch = None;
                draft.local_error = false;
                prefs.set_palette_preview(None);
                match target {
                    SavedTarget::Preset { key, name } => {
                        draft.editing_key = key;
                        draft.source_name = name;
                    }
                    SavedTarget::Reset {
                        key,
                        default_colors,
                    } => {
                        draft.editing_key = key;
                        draft.colors = default_colors;
                    }
                    SavedTarget::Select {
                        key,
                        name,
                        dark,
                        colors,
                    } => {
                        draft.editing_key = key;
                        draft.source_name = name;
                        draft.dark = dark;
                        draft.colors = *colors;
                    }
                    SavedTarget::BuiltInOrCustom | SavedTarget::Mode | SavedTarget::Delete => {}
                }
            }
        }
        if let Some(PendingDiscard::Palette { dark, ref key }) = draft.pending_discard
            && (!draft.dirty
                || draft.dark != dark
                || !prefs.palette_options(dark).iter().any(|o| &o.key == key))
        {
            draft.pending_discard = None;
            settled = true;
        } else if let Some(PendingDiscard::Mode(mode)) = draft.pending_discard
            && (!draft.dirty || !prefs.mode_ready() || prefs.mode_display() == mode)
        {
            draft.pending_discard = None;
            settled = true;
        }
        settled
    }

    fn settle_and_sync(&self, prefs: &mut Preferences, dark: bool) {
        self.settle_save(prefs);
        let mut draft = self.draft.borrow_mut();
        if draft.dirty || draft.awaiting_save.is_some() || prefs.palette_saving() {
            return;
        }
        let Some(active) = prefs.palette_slot(dark) else {
            return;
        };
        let options = prefs.palette_options(dark);
        let Some(option) = options.iter().find(|candidate| candidate.key == active.key) else {
            return;
        };
        let target_changed = draft.editing_key != option.key || draft.dark != option.dark;
        if target_changed || draft.colors != option.colors || draft.source_name != option.name {
            draft.editing_key = option.key.clone();
            draft.source_name = option.name.clone();
            draft.dark = option.dark;
            draft.colors = option.colors.clone();
            if target_changed {
                draft.active_swatch = None;
            }
        }
    }

    fn apply_option_selection(&self, prefs: &mut Preferences, option: &PaletteOption) {
        let was_dirty = self.draft.borrow().dirty;
        if !prefs.select_palette_option(option, was_dirty) {
            return;
        }
        if prefs.palette_saving() {
            let mut draft = self.draft.borrow_mut();
            draft.binding_epoch = prefs.binding_epoch();
            draft.local_error = false;
            draft.awaiting_save = Some(SavedTarget::Select {
                key: option.key.clone(),
                name: option.name.clone(),
                dark: option.dark,
                colors: Box::new(option.colors.clone()),
            });
            wake_all(prefs);
            return;
        }
        let mut draft = self.draft.borrow_mut();
        draft.editing_key = option.key.clone();
        draft.source_name = option.name.clone();
        draft.dark = option.dark;
        draft.colors = option.colors.clone();
        draft.creating = false;
        draft.dirty = false;
        draft.edited_fields.clear();
        draft.pending_create_id = None;
        draft.active_swatch = None;
        draft.local_error = false;
        draft.awaiting_save = None;
        prefs.set_palette_preview(None);
        prefs.clear_palette_save_failed();
        wake_all(prefs);
    }

    fn sync_preview(&self, prefs: &mut Preferences, option: Option<&PaletteOption>) {
        let draft = self.draft.borrow();
        if draft.dirty {
            let builtin_id = (!draft.creating)
                .then(|| option.and_then(|opt| opt.builtin_id))
                .flatten();
            prefs.set_palette_preview(Some((draft.dark, builtin_id, draft.colors.clone())));
        } else {
            prefs.set_palette_preview(None);
        }
        wake_all(prefs);
    }

    fn update_swatch_color(
        &self,
        prefs: &mut Preferences,
        option: &PaletteOption,
        field: ColorField,
        hex: &str,
    ) {
        let Some(next_colors) = self.draft.borrow().colors.with(field, hex) else {
            return;
        };
        {
            let mut draft = self.draft.borrow_mut();
            draft.editing_key = option.key.clone();
            draft.source_name = option.name.clone();
            draft.dark = option.dark;
            draft.colors = next_colors;
            if !draft.edited_fields.contains(&field) {
                draft.edited_fields.push(field);
            }
            draft.dirty = true;
            draft.local_error = false;
        }
        prefs.clear_palette_save_failed();
        self.sync_preview(prefs, Some(option));
    }

    fn toggle_picker(&self, picker: Picker) {
        self.picker
            .set((self.picker.get() != Some(picker)).then_some(picker));
    }

    fn start_new_preset(&mut self, prefs: &mut Preferences) {
        let existing = prefs.preset_names();
        let suggested = {
            let mut draft = self.draft.borrow_mut();
            let suggested = palettes::next_preset_name(&draft.source_name, &existing);
            draft.creating = true;
            draft.dirty = true;
            draft.pending_create_id = None;
            draft.local_error = false;
            suggested
        };
        self.name_input = TextEdit::new(&suggested);
        prefs.clear_palette_save_failed();
    }

    fn save_draft(&mut self, prefs: &mut Preferences, _dark: bool) {
        let (
            editing_key,
            creating,
            dirty,
            draft_dark,
            colors,
            edited_fields,
            source_name,
            pending_create_id,
        ) = {
            let draft = self.draft.borrow();
            (
                draft.editing_key.clone(),
                draft.creating,
                draft.dirty,
                draft.dark,
                draft.colors.clone(),
                draft.edited_fields.clone(),
                draft.source_name.clone(),
                draft.pending_create_id.clone(),
            )
        };
        let name_text = self.name_input.text.clone();
        if !dirty {
            return;
        }
        if creating {
            let name = name_text.trim().to_owned();
            if name.is_empty() {
                return;
            }
            if let Some(saved_id) =
                prefs.save_palette_preset(&name, draft_dark, colors, pending_create_id, true)
            {
                let mut draft = self.draft.borrow_mut();
                draft.local_error = false;
                draft.pending_create_id = Some(saved_id.clone());
                draft.awaiting_save = Some(SavedTarget::Preset {
                    key: format!("preset:{saved_id}"),
                    name,
                });
                wake_all(prefs);
            } else {
                self.draft.borrow_mut().local_error = true;
            }
            return;
        }
        let options = prefs.palette_options(draft_dark);
        let Some(option) = options
            .iter()
            .find(|candidate| candidate.key == editing_key)
        else {
            if editing_key == "builtin:custom" {
                if prefs.save_palette_override("custom", draft_dark, colors) {
                    let mut draft = self.draft.borrow_mut();
                    draft.local_error = false;
                    draft.awaiting_save = Some(SavedTarget::BuiltInOrCustom);
                    wake_all(prefs);
                } else {
                    self.draft.borrow_mut().local_error = true;
                }
                return;
            }
            if editing_key.starts_with("preset:") {
                // The preset disappeared externally; offer explicit creation as a new preset.
                let suggested = clamp_preset_name(TextEdit::new(&source_name));
                self.name_input = suggested;
                let mut draft = self.draft.borrow_mut();
                draft.creating = true;
                draft.pending_create_id = None;
                draft.local_error = true;
                wake_all(prefs);
            }
            return;
        };
        if let Some(id) = option.builtin_id {
            if prefs.save_palette_override(id, option.dark, colors) {
                let mut draft = self.draft.borrow_mut();
                draft.local_error = false;
                draft.awaiting_save = Some(SavedTarget::BuiltInOrCustom);
                wake_all(prefs);
            } else {
                self.draft.borrow_mut().local_error = true;
            }
            return;
        }
        let name = if option.preset_id.is_some() {
            option.name.clone()
        } else {
            palettes::next_preset_name(&source_name, &prefs.preset_names())
        };
        if name.is_empty() {
            return;
        }
        if let Some(saved_id) = prefs.save_palette_preset_fields(
            &name,
            draft_dark,
            colors,
            option.preset_id.clone(),
            false,
            Some(edited_fields),
        ) {
            let mut draft = self.draft.borrow_mut();
            draft.local_error = false;
            draft.awaiting_save = Some(SavedTarget::Preset {
                key: format!("preset:{saved_id}"),
                name,
            });
            wake_all(prefs);
        } else {
            self.draft.borrow_mut().local_error = true;
        }
    }

    fn reset_builtin(&self, prefs: &mut Preferences, _dark: bool) {
        let (editing_key, draft_dark) = {
            let draft = self.draft.borrow();
            (draft.editing_key.clone(), draft.dark)
        };
        let options = prefs.palette_options(draft_dark);
        let Some(option) = options
            .iter()
            .find(|candidate| candidate.key == editing_key)
        else {
            if editing_key == "builtin:custom" {
                if prefs.reset_palette_override("custom", draft_dark) {
                    let mut draft = self.draft.borrow_mut();
                    draft.local_error = false;
                    draft.awaiting_save = Some(SavedTarget::Reset {
                        key: editing_key,
                        default_colors: ColorSchemeColors::default_custom(),
                    });
                    wake_all(prefs);
                } else {
                    self.draft.borrow_mut().local_error = true;
                }
            }
            return;
        };
        let Some(id) = option.builtin_id else {
            return;
        };
        if prefs.reset_palette_override(id, option.dark) {
            let mut draft = self.draft.borrow_mut();
            draft.local_error = false;
            draft.awaiting_save = Some(SavedTarget::Reset {
                key: option.key.clone(),
                default_colors: option.original_colors.clone(),
            });
            wake_all(prefs);
        } else {
            self.draft.borrow_mut().local_error = true;
        }
    }

    fn confirm_delete_preset(&self, prefs: &mut Preferences) {
        let Some((preset_id, _)) = self.draft.borrow_mut().pending_delete.take() else {
            return;
        };
        if prefs.delete_palette_preset(&preset_id) {
            let mut draft = self.draft.borrow_mut();
            draft.local_error = false;
            draft.awaiting_save = Some(SavedTarget::Delete);
            wake_all(prefs);
        } else {
            self.draft.borrow_mut().local_error = true;
        }
    }

    fn step_target(&self, prefs: &Preferences, dark: bool, step: isize) -> Option<PaletteOption> {
        let options = prefs.palette_options(dark);
        let current_key = self.draft.borrow().editing_key.clone();
        options
            .iter()
            .position(|option| option.key == current_key)
            .and_then(|index| index.checked_add_signed(step))
            .and_then(|index| options.get(index))
            .cloned()
    }

    fn step_palette(&self, prefs: &mut Preferences, dark: bool, step: isize) {
        if let Some(option) = self.step_target(prefs, dark, step) {
            self.apply_option_selection(prefs, &option);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        system_dark: bool,
        system_more: bool,
        workbench_width: f32,
        actions_width: f32,
        coarse: bool,
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
        let saving = self.busy(&prefs);
        let mode = t("settings.appearance.palette.mode");
        let mode_shared = shared.clone();
        let segments = chrome::segments(
            mode,
            &MODES.map(|(_, label)| t(label)),
            MODES.iter().position(|(id, _)| *id == prefs.mode_display()),
            !prefs.mode_ready() || saving,
            move |s: &mut S, i| {
                let Some((mode, _)) = MODES.get(i) else {
                    return;
                };
                let controls = access(s);
                let mut prefs = mode_shared.borrow_mut();
                if prefs.mode_display() == *mode {
                    return;
                }
                if controls.draft.borrow().dirty {
                    controls.draft.borrow_mut().pending_discard = Some(PendingDiscard::Mode(mode));
                } else {
                    prefs.set_mode(mode);
                }
            },
        );
        let draft = self.draft.borrow();
        let dark = if draft.dirty || draft.awaiting_save.is_some() {
            draft.dark
        } else {
            layout::dark()
        };
        let options = prefs.palette_options(dark);
        let found_option = options
            .iter()
            .find(|option| option.key == draft.editing_key)
            .cloned();
        let missing_legacy_custom = draft.dirty
            && !draft.creating
            && draft.editing_key == "builtin:custom"
            && found_option.is_none();
        let missing_target = draft.dirty
            && !draft.creating
            && draft.editing_key.starts_with("preset:")
            && found_option.is_none();
        let editing_option = found_option.or_else(|| {
            if missing_legacy_custom {
                Some(PaletteOption {
                    key: "builtin:custom".to_owned(),
                    builtin_id: Some("custom"),
                    preset_id: None,
                    name: t("settings.appearance.palette.saved").to_owned(),
                    dark: draft.dark,
                    colors: draft.colors.clone(),
                    original_colors: ColorSchemeColors::default_custom(),
                })
            } else if missing_target || (draft.dirty && draft.creating) {
                Some(PaletteOption {
                    key: draft.editing_key.clone(),
                    builtin_id: None,
                    preset_id: None,
                    name: draft.source_name.clone(),
                    dark: draft.dark,
                    colors: draft.colors.clone(),
                    original_colors: draft.colors.clone(),
                })
            } else {
                options.first().cloned()
            }
        });
        let option_pairs = unique_picker_pairs(&options);
        let option_labels: Vec<&str> = option_pairs
            .iter()
            .map(|(label, _)| label.as_str())
            .collect();
        let current_label = editing_option.as_ref().and_then(|opt| {
            option_pairs
                .iter()
                .find(|(_, key)| *key == opt.key)
                .map(|(label, _)| label.as_str())
                .or_else(|| {
                    (missing_target || missing_legacy_custom || draft.creating)
                        .then_some(opt.name.as_str())
                })
        });
        let choose_pairs = option_pairs.clone();
        let palette_title = t("settings.appearance.colorScheme.title");
        let palette_picker = self.select(
            Picker::Palette(dark),
            palette_title,
            &option_labels,
            current_label,
            !prefs.palette_ready() || saving,
            layers,
            access,
            move |s, value| {
                if let Some((_, key)) = choose_pairs.iter().find(|(label, _)| label == value) {
                    access(s).palette_choice.set(Some(key.clone()));
                }
            },
        );

        let stacked = palette_ui::workbench_stacked(workbench_width, actions_width, coarse);
        let saved_builtin_override = editing_option.as_ref().is_some_and(|option| {
            let has_saved = option
                .builtin_id
                .is_some_and(|id| id != "custom" && prefs.has_saved_override(id));
            palettes::option_has_override(option, has_saved)
        });
        let display_colors = if draft.dirty {
            draft.colors.clone()
        } else {
            editing_option
                .as_ref()
                .map_or_else(|| draft.colors.clone(), |opt| opt.colors.clone())
        };
        let swatches = editing_option.as_ref().map(|option| {
            let option_key = option.key.clone();
            let items: Vec<palette_ui::SwatchItem<'_>> = ColorField::ALL
                .into_iter()
                .map(|field| {
                    let hex = display_colors.get(field);
                    let label = t(field.label_key());
                    palette_ui::SwatchItem {
                        key: field.key(),
                        hex,
                        label,
                        accessible_label: format!("{} · {} · {}", option.name, label, hex),
                        selected: draft.active_swatch.as_ref().is_some_and(|swatch| {
                            swatch.field == field && swatch.dark == dark && swatch.key == option_key
                        }),
                        disabled: !prefs.palette_ready() || saving,
                    }
                })
                .collect();
            let colors_for_pick = display_colors.clone();
            palette_ui::swatch_strip(&items, stacked, coarse, move |s: &mut S, index| {
                if let Some(&field) = ColorField::ALL.get(index) {
                    let controls = access(s);
                    let next_hex = {
                        let mut draft = controls.draft.borrow_mut();
                        let same = draft.active_swatch.as_ref().is_some_and(|swatch| {
                            swatch.field == field && swatch.dark == dark && swatch.key == option_key
                        });
                        if same {
                            draft.active_swatch = None;
                            None
                        } else {
                            let hex = if draft.dirty {
                                draft.colors.get(field).to_owned()
                            } else {
                                colors_for_pick.get(field).to_owned()
                            };
                            draft.active_swatch = Some(ActiveSwatch {
                                field,
                                dark,
                                key: option_key.clone(),
                            });
                            Some(hex)
                        }
                    };
                    if let Some(hex) = next_hex {
                        controls.hex_input = TextEdit::new(&hex);
                    }
                }
            })
        });

        let mut action_buttons = Vec::new();
        if let Some(option) = editing_option.as_ref()
            && let Some(preset_id) = &option.preset_id
        {
            let preset_id = preset_id.clone();
            let preset_name = option.name.clone();
            action_buttons.push(
                layout::button(
                    t("settings.appearance.colorScheme.custom.delete"),
                    draft.creating || saving,
                    move |s: &mut S| {
                        access(s).draft.borrow_mut().pending_delete =
                            Some((preset_id.clone(), preset_name.clone()));
                    },
                )
                .key("palette-delete"),
            );
        }
        if saved_builtin_override {
            let reset_shared = shared.clone();
            action_buttons.push(
                layout::button(
                    t("settings.appearance.colorScheme.custom.reset"),
                    draft.creating || saving,
                    move |s: &mut S| {
                        access(s).reset_builtin(&mut reset_shared.borrow_mut(), dark);
                    },
                )
                .key("palette-reset"),
            );
        }
        if !draft.creating {
            let new_shared = shared.clone();
            action_buttons.push(
                layout::button(
                    t("settings.appearance.colorScheme.custom.new"),
                    !prefs.palette_ready() || saving,
                    move |s: &mut S| {
                        access(s).start_new_preset(&mut new_shared.borrow_mut());
                    },
                )
                .key("palette-new"),
            );
        }
        if draft.dirty {
            let save_disabled = saving
                || !prefs.palette_ready()
                || (draft.creating && self.name_input.text.trim().is_empty());
            let save_shared = shared.clone();
            action_buttons.push(
                chrome::primary_action(
                    t("settings.appearance.colorScheme.custom.save"),
                    save_disabled,
                    move |s: &mut S| {
                        access(s).save_draft(&mut save_shared.borrow_mut(), dark);
                    },
                )
                .key("palette-save"),
            );
        }

        let workbench = palette_ui::workbench(
            palette_picker,
            swatches,
            palette_ui::action_bar(action_buttons, stacked),
            stacked,
        );
        let name_editor = draft.creating.then(|| {
            palette_ui::name_editor(
                t("settings.appearance.colorScheme.custom.name"),
                &self.name_input,
                saving,
                move |s: &mut S| &mut access(s).name_input,
                move |s: &mut S| {
                    let controls = access(s);
                    let edit = std::mem::take(&mut controls.name_input);
                    controls.name_input = clamp_preset_name(edit);
                },
            )
        });
        let error = (missing_target || draft.local_error || prefs.palette_save_failed())
            .then(|| palette_ui::save_error(t("settings.appearance.colorScheme.custom.saveError")));

        if let Some(ref swatch) = draft.active_swatch
            && let Some(option) = editing_option.as_ref()
            && swatch.dark == dark
            && swatch.key == option.key
        {
            let field = swatch.field;
            let hex = display_colors.get(field);
            let channels = display_colors.channels(field);
            let hex_shared = shared.clone();
            let chan_shared = shared.clone();
            let hex_opt = option.clone();
            let chan_opt = option.clone();
            layers.push(palette_ui::color_editor(
                t(field.label_key()),
                hex,
                channels,
                &self.hex_input,
                t("toastHistory.close"),
                move |s: &mut S| &mut access(s).hex_input,
                move |s: &mut S| {
                    let controls = access(s);
                    if let Some(hex) = normalize_hex(&controls.hex_input.text) {
                        controls.update_swatch_color(
                            &mut hex_shared.borrow_mut(),
                            &hex_opt,
                            field,
                            &hex,
                        );
                    }
                },
                move |s: &mut S, channel, value| {
                    let controls = access(s);
                    let mut next_channels = controls.draft.borrow().colors.channels(field);
                    next_channels[channel] = value;
                    let hex = format_hex(next_channels);
                    controls.hex_input = TextEdit::new(&hex);
                    controls.update_swatch_color(
                        &mut chan_shared.borrow_mut(),
                        &chan_opt,
                        field,
                        &hex,
                    );
                },
                move |s: &mut S| {
                    access(s).draft.borrow_mut().active_swatch = None;
                },
            ));
        }

        if let Some((_, ref name)) = draft.pending_delete {
            let delete_shared = shared.clone();
            let message =
                t("settings.appearance.colorScheme.custom.deleteConfirm").replace("{name}", name);
            layers.push(palette_ui::confirm_dialog(
                &message,
                t("settings.appearance.colorScheme.custom.delete"),
                t("alertDialog.actions.cancel"),
                move |s: &mut S, accept, _| {
                    let controls = access(s);
                    if accept {
                        controls.confirm_delete_preset(&mut delete_shared.borrow_mut());
                    } else {
                        controls.draft.borrow_mut().pending_delete = None;
                    }
                },
            ));
        } else if let Some(target) = draft.pending_discard.clone().filter(|target| {
            !saving
                && match target {
                    PendingDiscard::Mode(mode) => {
                        prefs.mode_ready() && prefs.mode_display() != *mode
                    }
                    PendingDiscard::Palette {
                        dark: slot_dark,
                        key,
                    } => {
                        *slot_dark == dark
                            && prefs.palette_ready()
                            && options.iter().any(|o| &o.key == key)
                    }
                }
        }) {
            let discard_shared = shared.clone();
            layers.push(palette_ui::confirm_dialog(
                t("settings.configFiles.confirmDiscard.message"),
                t("settings.configFiles.confirmDiscard.confirmLabel"),
                t("settings.configFiles.confirmDiscard.cancelLabel"),
                move |s: &mut S, accept, _| {
                    let controls = access(s);
                    controls.draft.borrow_mut().pending_discard = None;
                    if !accept {
                        return;
                    }
                    let mut prefs = discard_shared.borrow_mut();
                    if controls.busy(&prefs) {
                        return;
                    }
                    match &target {
                        PendingDiscard::Mode(mode) => {
                            if prefs.set_mode_confirmed(mode) {
                                let mut draft = controls.draft.borrow_mut();
                                draft.binding_epoch = prefs.binding_epoch();
                                draft.local_error = false;
                                draft.awaiting_save = Some(SavedTarget::Mode);
                                wake_all(&prefs);
                            }
                        }
                        PendingDiscard::Palette {
                            dark: slot_dark,
                            key,
                        } => {
                            if *slot_dark != dark || !prefs.palette_ready() {
                                return;
                            }
                            let options = prefs.palette_options(*slot_dark);
                            let Some(option) = options.iter().find(|o| &o.key == key) else {
                                return;
                            };
                            controls.apply_option_selection(&mut prefs, option);
                        }
                    }
                },
            ));
        }
        drop(draft);

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
                        Some("palette-trigger")
                            if key_shared.borrow().palette_ready()
                                && !access(s).busy(&key_shared.borrow()) =>
                        {
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
                let controls = access(s);
                let mut prefs = key_shared.borrow_mut();
                if (prefs.dark(system_dark) == dark || controls.dirty()) && !controls.busy(&prefs) {
                    if controls.dirty() {
                        if let Some(option) = controls.step_target(&prefs, dark, step) {
                            controls.draft.borrow_mut().pending_discard =
                                Some(PendingDiscard::Palette {
                                    dark,
                                    key: option.key,
                                });
                        }
                    } else {
                        controls.step_palette(&mut prefs, dark, step);
                    }
                }
                true
            })
            .child(chrome::card(chrome::setting_row(language, language_picker)))
            .child(chrome::card(chrome::color_scheme(
                palette_title,
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
                workbench,
                name_editor,
                error,
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
        let control = match picker {
            Picker::Locale => chrome::picker(picker.key(), label, options),
            Picker::Palette(_) => chrome::palette_picker(picker.key(), label, options),
        }
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
