//! User palette presets, built-in overrides, legacy custom schemes, and Owner::State patches.
use crate::strings::t;
use rune_theme_codenomad::palettes::{
    ColorField, ColorSchemeColors, Palette, ResolvedPalette, built_in, custom, increased_contrast,
    luminance, parse_rgb,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(super) const MAX_PRESETS: usize = 50;
pub(super) const MAX_PRESET_NAME_LEN: usize = 80;
pub(super) const MAX_PRESET_ID_LEN: usize = 128;

#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) struct LegacyScheme {
    pub dark: bool,
    pub id: &'static str,
    pub colors: Option<ColorSchemeColors>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) struct UserPreset {
    pub id: String,
    pub name: String,
    pub dark: bool,
    pub colors: ColorSchemeColors,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) struct PaletteOption {
    pub key: String,
    pub builtin_id: Option<&'static str>,
    pub preset_id: Option<String>,
    pub name: String,
    pub dark: bool,
    pub colors: ColorSchemeColors,
    pub original_colors: ColorSchemeColors,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) struct SlotSelection {
    pub key: String,
    pub builtin_id: Option<&'static str>,
    pub preset_id: Option<String>,
    pub dark: bool,
    pub colors: Option<ColorSchemeColors>,
}

impl SlotSelection {
    pub(super) fn resolve(&self, high_contrast: bool) -> Option<ResolvedPalette> {
        if let Some(colors) = &self.colors {
            let id = self.builtin_id.filter(|id| *id != "custom");
            return Some(custom(id, self.dark, high_contrast, colors.clone()));
        }
        let palette = self
            .builtin_id
            .and_then(|id| {
                built_in()
                    .iter()
                    .find(|p| p.dark == self.dark && p.id == id)
            })
            .or_else(|| default_built_in(self.dark))?;
        let palette = if high_contrast {
            increased_contrast(Some(palette), self.dark).unwrap_or(palette)
        } else {
            palette
        };
        Some(ResolvedPalette::BuiltIn(palette))
    }

    pub(super) fn display_signature(&self) -> String {
        match &self.colors {
            Some(colors) => format!("{}|{}", self.key, colors.to_json()),
            None => self.key.clone(),
        }
    }

    pub(super) fn to_slot_json(&self) -> Value {
        let mode = mode_str(self.dark);
        let id = self.builtin_id.unwrap_or(if self.preset_id.is_some() {
            "custom"
        } else if self.dark {
            "mist"
        } else {
            "porcelain"
        });
        let colors_json = self
            .colors
            .as_ref()
            .map_or(Value::Null, ColorSchemeColors::to_json);
        json!({
            "scheme": {
                "id": id,
                "appearance": mode,
                "colors": colors_json,
            },
            "presetId": self.preset_id,
        })
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) enum PaletteOp {
    SelectBuiltIn {
        id: &'static str,
        dark: bool,
    },
    SelectCustom {
        dark: bool,
    },
    SelectPreset {
        preset_id: String,
        dark: bool,
        colors: ColorSchemeColors,
    },
    SaveOverride {
        id: &'static str,
        dark: bool,
        colors: ColorSchemeColors,
    },
    ResetOverride {
        id: &'static str,
        dark: bool,
        default_colors: ColorSchemeColors,
    },
    SaveCustom {
        dark: bool,
        colors: ColorSchemeColors,
    },
    SavePreset {
        preset_id: String,
        name: String,
        dark: bool,
        colors: ColorSchemeColors,
        allow_new: bool,
        edited_fields: Option<Vec<ColorField>>,
    },
    DeletePreset {
        preset_id: String,
    },
    SetMode {
        mode: &'static str,
    },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) struct PaletteMutation {
    pub op: PaletteOp,
    pub legacy_config: Value,
}

impl PaletteOp {
    pub(super) fn target_dark(&self) -> Option<bool> {
        match self {
            Self::SelectBuiltIn { dark, .. }
            | Self::SelectCustom { dark, .. }
            | Self::SelectPreset { dark, .. }
            | Self::SaveOverride { dark, .. }
            | Self::ResetOverride { dark, .. }
            | Self::SaveCustom { dark, .. }
            | Self::SavePreset { dark, .. } => Some(*dark),
            Self::DeletePreset { .. } | Self::SetMode { .. } => None,
        }
    }
}

fn is_valid_mode(value: &Value) -> bool {
    matches!(value.as_str(), Some("light" | "dark" | "system"))
}

impl PaletteMutation {
    pub(super) fn target_dark(&self) -> Option<bool> {
        self.op.target_dark()
    }

    pub(super) fn needs_fresh_snapshot(&self, snapshot: &Value) -> bool {
        match &self.op {
            PaletteOp::SelectPreset { .. }
            | PaletteOp::SelectCustom { .. }
            | PaletteOp::SavePreset { .. } => true,
            PaletteOp::SelectBuiltIn { dark, .. } => {
                needs_slot_migration(snapshot, &self.legacy_config, *dark, None)
            }
            PaletteOp::SaveOverride { id, dark, .. }
            | PaletteOp::ResetOverride { id, dark, .. } => {
                let sibling_dark = !*dark;
                let sibling_mode = mode_str(sibling_dark);
                !is_valid_mode(&snapshot["appearancePreferences"]["mode"])
                    || (snapshot["appearancePreferences"][sibling_mode].is_null()
                        && legacy_scheme(snapshot, &self.legacy_config)
                            .is_some_and(|l| l.dark == sibling_dark))
                    || needs_slot_migration(snapshot, &self.legacy_config, *dark, Some(*id))
            }
            PaletteOp::SaveCustom { dark, .. } => {
                let sibling_dark = !*dark;
                let sibling_mode = mode_str(sibling_dark);
                !is_valid_mode(&snapshot["appearancePreferences"]["mode"])
                    || (snapshot["appearancePreferences"][sibling_mode].is_null()
                        && legacy_scheme(snapshot, &self.legacy_config)
                            .is_some_and(|l| l.dark == sibling_dark))
                    || needs_slot_migration(snapshot, &self.legacy_config, *dark, Some("custom"))
            }
            PaletteOp::DeletePreset { .. } | PaletteOp::SetMode { .. } => false,
        }
    }

    pub(super) fn reject_before_send(&self, snapshot: &Value) -> bool {
        match &self.op {
            PaletteOp::SelectPreset {
                preset_id, dark, ..
            } => !normalize_presets(snapshot)
                .iter()
                .any(|p| p.id == *preset_id && p.dark == *dark),
            PaletteOp::SavePreset {
                preset_id,
                allow_new,
                ..
            } => {
                let presets = normalize_presets(snapshot);
                let existing = presets.iter().any(|p| p.id == *preset_id);
                if *allow_new {
                    !existing && presets.len() >= MAX_PRESETS
                } else {
                    // Never resurrect a preset that was deleted elsewhere while editing.
                    !existing
                }
            }
            _ => false,
        }
    }

    pub(super) fn put(&self, patch: &mut Value, snapshot: &Value) {
        if let PaletteOp::SetMode { mode } = &self.op {
            patch["appearancePreferences"]["mode"] = json!(mode);
            return;
        }
        if let PaletteOp::DeletePreset { preset_id } = &self.op {
            patch["colorSchemePresets"][preset_id] = Value::Null;
            return;
        }
        if let PaletteOp::SelectBuiltIn { id, dark } = &self.op {
            let legacy = legacy_scheme(snapshot, &self.legacy_config);
            migrate_active_builtin_override(
                patch,
                snapshot,
                &self.legacy_config,
                legacy.as_ref(),
                *dark,
                None,
            );
            let mode = mode_str(*dark);
            patch["appearancePreferences"][mode] = json!({
                "scheme": { "id": id, "appearance": mode, "colors": Value::Null },
                "presetId": Value::Null,
            });
            return;
        }
        if let PaletteOp::SelectCustom { dark } = &self.op {
            let legacy = legacy_scheme(snapshot, &self.legacy_config);
            migrate_active_builtin_override(
                patch,
                snapshot,
                &self.legacy_config,
                legacy.as_ref(),
                *dark,
                None,
            );
            let mode = mode_str(*dark);
            let (_, live_colors) = custom_scheme(snapshot, &self.legacy_config);
            patch["appearancePreferences"][mode] = json!({
                "scheme": { "id": "custom", "appearance": mode, "colors": live_colors.to_json() },
                "presetId": Value::Null,
            });
            return;
        }
        let legacy = legacy_scheme(snapshot, &self.legacy_config);
        if !is_valid_mode(&snapshot["appearancePreferences"]["mode"])
            && !is_valid_mode(&patch["appearancePreferences"]["mode"])
        {
            let mode = legacy
                .as_ref()
                .map_or("system", |scheme| mode_str(scheme.dark));
            patch["appearancePreferences"]["mode"] = json!(mode);
        }
        if let Some(target_dark) = self.op.target_dark() {
            let sibling_dark = !target_dark;
            let sibling_mode = mode_str(sibling_dark);
            if snapshot["appearancePreferences"][sibling_mode].is_null()
                && patch["appearancePreferences"][sibling_mode].is_null()
                && legacy.as_ref().is_some_and(|l| l.dark == sibling_dark)
            {
                let resolved =
                    resolve_slot(snapshot, &self.legacy_config, legacy.as_ref(), sibling_dark);
                patch["appearancePreferences"][sibling_mode] = resolved.to_slot_json();
            }
            let skip_builtin = match &self.op {
                PaletteOp::SaveOverride { id, .. } | PaletteOp::ResetOverride { id, .. } => {
                    Some(*id)
                }
                PaletteOp::SaveCustom { .. } => Some("custom"),
                _ => None,
            };
            migrate_active_builtin_override(
                patch,
                snapshot,
                &self.legacy_config,
                legacy.as_ref(),
                target_dark,
                skip_builtin,
            );
        }
        // Materialize a legacy inline custom scheme into customColorScheme before overwriting
        // top-level colorScheme so selecting a preset or built-in does not lose those colors.
        if !matches!(
            self.op,
            PaletteOp::SelectCustom { .. }
                | PaletteOp::SaveCustom { .. }
                | PaletteOp::DeletePreset { .. }
        ) && snapshot["customColorScheme"].is_null()
            && self.legacy_config["customColorScheme"].is_null()
            && snapshot["activeColorSchemePresetId"].is_null()
            && let Some(LegacyScheme {
                id: "custom",
                dark,
                colors: Some(legacy_colors),
            }) = legacy.as_ref()
        {
            patch["customColorScheme"] = json!({
                "id": "custom",
                "appearance": mode_str(*dark),
                "colors": legacy_colors.to_json(),
            });
        }
        match &self.op {
            PaletteOp::SaveCustom { dark, colors } => {
                let mode = mode_str(*dark);
                let scheme = json!({
                    "id": "custom",
                    "appearance": mode,
                    "colors": colors.to_json(),
                });
                patch["colorScheme"] = scheme.clone();
                patch["customColorScheme"] = scheme.clone();
                patch["activeColorSchemePresetId"] = Value::Null;
                patch["appearancePreferences"][mode] = json!({
                    "scheme": scheme,
                    "presetId": Value::Null,
                });
            }
            PaletteOp::SelectPreset {
                preset_id,
                dark,
                colors,
            } => {
                let mode = mode_str(*dark);
                let live_colors = normalize_presets(snapshot)
                    .into_iter()
                    .find(|p| p.id == *preset_id && p.dark == *dark)
                    .map(|p| p.colors)
                    .unwrap_or_else(|| colors.clone());
                let scheme = json!({
                    "id": "custom",
                    "appearance": mode,
                    "colors": live_colors.to_json(),
                });
                patch["colorScheme"] = scheme.clone();
                patch["activeColorSchemePresetId"] = json!(preset_id);
                patch["appearancePreferences"][mode] = json!({
                    "scheme": scheme,
                    "presetId": preset_id,
                });
            }
            PaletteOp::SaveOverride { id, dark, colors } => {
                let mode = mode_str(*dark);
                let colors_json = colors.to_json();
                let scheme = json!({
                    "id": id,
                    "appearance": mode,
                    "colors": colors_json,
                });
                patch["colorScheme"] = scheme.clone();
                patch["colorSchemeOverrides"][*id] = colors_json;
                patch["activeColorSchemePresetId"] = Value::Null;
                patch["appearancePreferences"][mode] = json!({
                    "scheme": scheme,
                    "presetId": Value::Null,
                });
            }
            PaletteOp::ResetOverride {
                id,
                dark,
                default_colors,
            } => {
                let mode = mode_str(*dark);
                patch["colorScheme"] = json!({
                    "id": id,
                    "appearance": mode,
                    "colors": default_colors.to_json(),
                });
                patch["colorSchemeOverrides"][*id] = Value::Null;
                patch["activeColorSchemePresetId"] = Value::Null;
                patch["appearancePreferences"][mode] = json!({
                    "scheme": {
                        "id": id,
                        "appearance": mode,
                        "colors": Value::Null,
                    },
                    "presetId": Value::Null,
                });
            }
            PaletteOp::SavePreset {
                preset_id,
                name,
                dark,
                colors,
                allow_new,
                edited_fields,
            } => {
                let mode = mode_str(*dark);
                let live_preset = (!*allow_new)
                    .then(|| {
                        normalize_presets(snapshot)
                            .into_iter()
                            .find(|p| p.id == *preset_id)
                    })
                    .flatten();
                let effective_name = live_preset
                    .as_ref()
                    .map_or(name.as_str(), |p| p.name.as_str());
                let delta_fields = match (live_preset.as_ref(), edited_fields.as_deref()) {
                    (Some(live), Some(fields)) if live.dark == *dark && !fields.is_empty() => {
                        Some((live, fields))
                    }
                    _ => None,
                };
                if let Some((live, fields)) = delta_fields {
                    let mut delta = serde_json::Map::new();
                    let mut merged = live.colors.clone();
                    for &field in fields {
                        let hex = colors.get(field);
                        delta.insert(field.key().to_owned(), json!(hex));
                        if let Some(updated) = merged.with(field, hex) {
                            merged = updated;
                        }
                    }
                    let delta_colors = Value::Object(delta);
                    let full_colors = merged.to_json();
                    let top_matches_live = snapshot["activeColorSchemePresetId"].as_str()
                        == Some(preset_id.as_str())
                        && snapshot["colorScheme"]["id"].as_str() == Some("custom")
                        && snapshot["colorScheme"]["appearance"].as_str() == Some(mode)
                        && ColorSchemeColors::from_json(&snapshot["colorScheme"]["colors"])
                            .as_ref()
                            == Some(&live.colors);
                    let slot = &snapshot["appearancePreferences"][mode];
                    let slot_matches_live = slot["presetId"].as_str() == Some(preset_id.as_str())
                        && slot["scheme"]["id"].as_str() == Some("custom")
                        && slot["scheme"]["appearance"].as_str() == Some(mode)
                        && ColorSchemeColors::from_json(&slot["scheme"]["colors"]).as_ref()
                            == Some(&live.colors);
                    patch["colorScheme"] = json!({
                        "id": "custom",
                        "appearance": mode,
                        "colors": if top_matches_live { &delta_colors } else { &full_colors },
                    });
                    patch["colorSchemePresets"][preset_id] = json!({
                        "colors": delta_colors,
                    });
                    patch["activeColorSchemePresetId"] = json!(preset_id);
                    patch["appearancePreferences"][mode] = json!({
                        "scheme": {
                            "id": "custom",
                            "appearance": mode,
                            "colors": if slot_matches_live { &delta_colors } else { &full_colors },
                        },
                        "presetId": preset_id,
                    });
                } else {
                    let merged_colors = match (live_preset.as_ref(), edited_fields.as_deref()) {
                        (Some(live), Some(fields)) if !fields.is_empty() => {
                            let mut merged = live.colors.clone();
                            for &field in fields {
                                if let Some(updated) = merged.with(field, colors.get(field)) {
                                    merged = updated;
                                }
                            }
                            merged
                        }
                        _ => colors.clone(),
                    };
                    let colors_json = merged_colors.to_json();
                    let scheme = json!({
                        "id": "custom",
                        "appearance": mode,
                        "colors": colors_json,
                    });
                    patch["colorScheme"] = scheme.clone();
                    patch["colorSchemePresets"][preset_id] = json!({
                        "name": effective_name,
                        "appearance": mode,
                        "colors": colors_json,
                    });
                    patch["activeColorSchemePresetId"] = json!(preset_id);
                    patch["appearancePreferences"][mode] = json!({
                        "scheme": scheme,
                        "presetId": preset_id,
                    });
                }
            }
            PaletteOp::SelectBuiltIn { .. }
            | PaletteOp::SelectCustom { .. }
            | PaletteOp::DeletePreset { .. }
            | PaletteOp::SetMode { .. } => {}
        }
    }

    pub(super) fn confirmed(&self, snapshot: &Value) -> bool {
        let appearance = &snapshot["appearancePreferences"];
        match &self.op {
            PaletteOp::SelectBuiltIn { id, dark } => {
                let mode = mode_str(*dark);
                let slot = &appearance[mode];
                slot["scheme"]["id"] == *id
                    && slot["scheme"]["appearance"] == mode
                    && slot["scheme"]["colors"].is_null()
                    && slot["presetId"].is_null()
            }
            PaletteOp::SelectCustom { dark } => {
                let mode = mode_str(*dark);
                let slot = &appearance[mode];
                slot["scheme"]["id"] == "custom"
                    && slot["scheme"]["appearance"] == mode
                    && slot["presetId"].is_null()
            }
            PaletteOp::SaveCustom { dark, colors } => {
                let mode = mode_str(*dark);
                let slot = &appearance[mode];
                slot["scheme"]["id"] == "custom"
                    && slot["scheme"]["appearance"] == mode
                    && ColorSchemeColors::from_json(&slot["scheme"]["colors"]).as_ref()
                        == Some(colors)
                    && slot["presetId"].is_null()
                    && snapshot["activeColorSchemePresetId"].is_null()
                    && ColorSchemeColors::from_json(&snapshot["customColorScheme"]["colors"])
                        .as_ref()
                        == Some(colors)
            }
            PaletteOp::SelectPreset {
                preset_id, dark, ..
            } => {
                let mode = mode_str(*dark);
                let slot = &appearance[mode];
                let preset = &snapshot["colorSchemePresets"][preset_id];
                let preset_colors = ColorSchemeColors::from_json(&preset["colors"]);
                preset["appearance"] == mode
                    && preset_colors.is_some()
                    && snapshot["activeColorSchemePresetId"] == *preset_id
                    && slot["presetId"] == *preset_id
                    && slot["scheme"]["id"] == "custom"
                    && slot["scheme"]["appearance"] == mode
                    && ColorSchemeColors::from_json(&slot["scheme"]["colors"]) == preset_colors
            }
            PaletteOp::SaveOverride { id, dark, colors } => {
                let mode = mode_str(*dark);
                let slot = &appearance[mode];
                ColorSchemeColors::from_json(&snapshot["colorSchemeOverrides"][*id]).as_ref()
                    == Some(colors)
                    && slot["scheme"]["id"] == *id
                    && slot["scheme"]["appearance"] == mode
                    && ColorSchemeColors::from_json(&slot["scheme"]["colors"]).as_ref()
                        == Some(colors)
                    && slot["presetId"].is_null()
                    && snapshot["activeColorSchemePresetId"].is_null()
            }
            PaletteOp::ResetOverride { id, dark, .. } => {
                let mode = mode_str(*dark);
                let slot = &appearance[mode];
                snapshot["colorSchemeOverrides"][*id].is_null()
                    && slot["scheme"]["id"] == *id
                    && slot["scheme"]["appearance"] == mode
                    && slot["scheme"]["colors"].is_null()
                    && slot["presetId"].is_null()
                    && snapshot["activeColorSchemePresetId"].is_null()
            }
            PaletteOp::SavePreset {
                preset_id,
                name,
                dark,
                colors,
                allow_new,
                edited_fields,
            } => {
                let mode = mode_str(*dark);
                let slot = &appearance[mode];
                let preset = &snapshot["colorSchemePresets"][preset_id];
                let preset_colors = ColorSchemeColors::from_json(&preset["colors"]);
                let slot_colors = ColorSchemeColors::from_json(&slot["scheme"]["colors"]);
                let name_ok = if *allow_new {
                    preset["name"] == *name
                } else {
                    preset["name"]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty())
                };
                let colors_ok = match (preset_colors, slot_colors, edited_fields.as_deref()) {
                    (Some(saved_preset), Some(saved_slot), Some(fields))
                        if !*allow_new && !fields.is_empty() =>
                    {
                        saved_preset == saved_slot
                            && fields
                                .iter()
                                .all(|&field| saved_preset.get(field) == colors.get(field))
                    }
                    (Some(saved_preset), Some(saved_slot), _) => {
                        saved_preset == *colors && saved_slot == *colors
                    }
                    _ => false,
                };
                name_ok
                    && preset["appearance"] == mode
                    && colors_ok
                    && snapshot["activeColorSchemePresetId"] == *preset_id
                    && slot["presetId"] == *preset_id
                    && slot["scheme"]["id"] == "custom"
                    && slot["scheme"]["appearance"] == mode
            }
            PaletteOp::DeletePreset { preset_id } => {
                snapshot["colorSchemePresets"][preset_id].is_null()
            }
            PaletteOp::SetMode { mode } => appearance["mode"] == *mode,
        }
    }
}

pub(super) fn legacy_scheme(state: &Value, config: &Value) -> Option<LegacyScheme> {
    let scheme = state
        .get("colorScheme")
        .filter(|v| !v.is_null())
        .or_else(|| config.get("colorScheme").filter(|v| !v.is_null()));
    if let Some(scheme) = scheme {
        let id = scheme.as_str().or_else(|| scheme["id"].as_str());
        if id == Some("system") {
            if let Some(colors) = ColorSchemeColors::from_legacy_json(&scheme["colors"]) {
                let dark = match scheme["appearance"].as_str() {
                    Some("light") => false,
                    Some("dark") => true,
                    _ => {
                        luminance(
                            parse_rgb(colors.get(ColorField::SurfaceBase)).unwrap_or([0, 0, 0]),
                        ) <= 0.4
                    }
                };
                return Some(LegacyScheme {
                    dark,
                    id: "custom",
                    colors: Some(colors),
                });
            }
            return None;
        }
        if id == Some("custom") {
            let dark = scheme["appearance"].as_str() != Some("light");
            let colors = ColorSchemeColors::from_legacy_json(&scheme["colors"]);
            return Some(LegacyScheme {
                dark,
                id: "custom",
                colors,
            });
        }
        if let Some(palette) = built_in().iter().find(|p| Some(p.id) == id) {
            let colors = ColorSchemeColors::from_legacy_json(&scheme["colors"]);
            return Some(LegacyScheme {
                dark: palette.dark,
                id: palette.id,
                colors,
            });
        }
    }
    let (dark, id) = match state
        .get("theme")
        .or_else(|| config.get("theme"))
        .and_then(Value::as_str)
    {
        Some("light") => (false, "light"),
        Some("dark") => (true, "classic"),
        _ => return None,
    };
    Some(LegacyScheme {
        dark,
        id,
        colors: None,
    })
}

pub(super) fn legacy_config_fields(config: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for key in ["colorScheme", "customColorScheme", "theme"] {
        if let Some(val) = config.get(key).filter(|v| !v.is_null()) {
            out.insert(key.to_owned(), val.clone());
        }
    }
    if out.is_empty() {
        Value::Null
    } else {
        Value::Object(out)
    }
}

/// Returns true when replacing `target_dark`'s active slot would migrate unmigrated slot-only or
/// legacy inline colors into `colorSchemeOverrides` or `customColorScheme`.
pub(super) fn needs_slot_migration(
    snapshot: &Value,
    legacy_config: &Value,
    target_dark: bool,
    skip_builtin: Option<&str>,
) -> bool {
    let legacy = legacy_scheme(snapshot, legacy_config);
    let current = resolve_slot(snapshot, legacy_config, legacy.as_ref(), target_dark);
    if current.preset_id.is_some() {
        return false;
    }
    let Some(prev_id) = current.builtin_id else {
        return false;
    };
    if skip_builtin == Some(prev_id) {
        return false;
    }
    let Some(prev_colors) = current.colors else {
        return false;
    };
    if prev_id == "custom" {
        return snapshot["customColorScheme"].is_null()
            && legacy_config["customColorScheme"].is_null()
            && (!prev_colors.is_default_custom() || !target_dark);
    }
    if !snapshot["colorSchemeOverrides"][prev_id].is_null() {
        return false;
    }
    !built_in()
        .iter()
        .find(|p| p.id == prev_id && p.dark == target_dark)
        .is_some_and(|p| p.colors() == prev_colors)
}

/// Migrates slot-only or legacy inline built-in custom colors into `colorSchemeOverrides`
/// before replacing the active slot, without overwriting an existing override or explicit reset.
pub(super) fn migrate_active_builtin_override(
    patch: &mut Value,
    snapshot: &Value,
    legacy_config: &Value,
    legacy: Option<&LegacyScheme>,
    target_dark: bool,
    skip_builtin: Option<&str>,
) {
    let current = resolve_slot(snapshot, legacy_config, legacy, target_dark);
    if current.preset_id.is_some() {
        return;
    }
    let Some(prev_id) = current.builtin_id else {
        return;
    };
    if skip_builtin == Some(prev_id) {
        return;
    }
    let Some(prev_colors) = current.colors else {
        return;
    };
    if prev_id == "custom" {
        if snapshot["customColorScheme"].is_null()
            && legacy_config["customColorScheme"].is_null()
            && patch["customColorScheme"].is_null()
            && (!prev_colors.is_default_custom() || !target_dark)
        {
            patch["customColorScheme"] = json!({
                "id": "custom",
                "appearance": mode_str(target_dark),
                "colors": prev_colors.to_json(),
            });
        }
        return;
    }
    if !snapshot["colorSchemeOverrides"][prev_id].is_null()
        || !patch["colorSchemeOverrides"][prev_id].is_null()
    {
        return;
    }
    if built_in()
        .iter()
        .find(|p| p.id == prev_id && p.dark == target_dark)
        .is_some_and(|p| p.colors() == prev_colors)
    {
        return;
    }
    patch["colorSchemeOverrides"][prev_id] = prev_colors.to_json();
}

pub(super) fn mode_str(dark: bool) -> &'static str {
    if dark { "dark" } else { "light" }
}

pub(super) fn default_built_in(dark: bool) -> Option<&'static Palette> {
    let default_id = if dark { "mist" } else { "porcelain" };
    built_in().iter().find(|p| p.id == default_id)
}

pub(super) fn normalize_presets(state: &Value) -> Vec<UserPreset> {
    let Some(map) = state["colorSchemePresets"].as_object() else {
        return Vec::new();
    };
    let mut presets = Vec::new();
    for (id, candidate) in map {
        if id.is_empty() || id.len() > MAX_PRESET_ID_LEN {
            continue;
        }
        let Some(obj) = candidate.as_object() else {
            continue;
        };
        let Some(raw_name) = obj.get("name").and_then(Value::as_str) else {
            continue;
        };
        let name: String = raw_name.trim().chars().take(MAX_PRESET_NAME_LEN).collect();
        if name.is_empty() {
            continue;
        }
        let dark = match obj.get("appearance").and_then(Value::as_str) {
            Some("dark") => true,
            Some("light") => false,
            _ => continue,
        };
        let Some(colors) = obj.get("colors").and_then(ColorSchemeColors::from_json) else {
            continue;
        };
        presets.push(UserPreset {
            id: id.clone(),
            name,
            dark,
            colors,
        });
    }
    presets
}

pub(super) fn normalize_overrides(state: &Value) -> BTreeMap<&'static str, ColorSchemeColors> {
    let Some(map) = state["colorSchemeOverrides"].as_object() else {
        return BTreeMap::new();
    };
    let mut overrides = BTreeMap::new();
    for (id, value) in map {
        let Some(palette) = built_in().iter().find(|p| p.id == id) else {
            continue;
        };
        if let Some(colors) = ColorSchemeColors::from_json(value) {
            overrides.insert(palette.id, colors);
        }
    }
    overrides
}

pub(super) fn custom_scheme(state: &Value, config: &Value) -> (bool, ColorSchemeColors) {
    let candidate = state
        .get("customColorScheme")
        .filter(|v| !v.is_null())
        .or_else(|| config.get("customColorScheme").filter(|v| !v.is_null()));
    if let Some(candidate) = candidate {
        let dark = candidate["appearance"].as_str() != Some("light");
        let colors = ColorSchemeColors::from_legacy_json(&candidate["colors"])
            .unwrap_or_else(ColorSchemeColors::default_custom);
        return (dark, colors);
    }
    if state["activeColorSchemePresetId"].is_null()
        && let Some(LegacyScheme {
            id: "custom",
            dark,
            colors: Some(colors),
        }) = legacy_scheme(state, config)
    {
        return (dark, colors);
    }
    (true, ColorSchemeColors::default_custom())
}

pub(super) fn resolve_slot(
    state: &Value,
    config: &Value,
    legacy: Option<&LegacyScheme>,
    dark: bool,
) -> SlotSelection {
    let mode = mode_str(dark);
    let presets = normalize_presets(state);
    let overrides = normalize_overrides(state);
    let slot = &state["appearancePreferences"][mode];

    let slot_preset_id = slot["presetId"].as_str().or_else(|| {
        slot.is_null()
            .then(|| state["activeColorSchemePresetId"].as_str())
            .flatten()
    });
    if let Some(preset_id) = slot_preset_id
        && let Some(preset) = presets.iter().find(|p| p.id == preset_id && p.dark == dark)
    {
        return SlotSelection {
            key: format!("preset:{}", preset.id),
            builtin_id: None,
            preset_id: Some(preset.id.clone()),
            dark,
            colors: Some(preset.colors.clone()),
        };
    }

    let matching_legacy = legacy.filter(|l| l.dark == dark);
    let slot_id = slot["scheme"]["id"].as_str();
    let raw_id = slot_id.or_else(|| matching_legacy.map(|l| l.id));

    if raw_id == Some("custom") {
        let (custom_dark, custom_colors) = custom_scheme(state, config);
        let legacy_colors = matching_legacy
            .filter(|l| l.id == "custom")
            .and_then(|l| l.colors.clone());
        let colors = ColorSchemeColors::from_legacy_json(&slot["scheme"]["colors"])
            .or(legacy_colors)
            .or_else(|| (custom_dark == dark).then_some(custom_colors))
            .unwrap_or_else(ColorSchemeColors::default_custom);
        return SlotSelection {
            key: "builtin:custom".to_owned(),
            builtin_id: Some("custom"),
            preset_id: None,
            dark,
            colors: Some(colors),
        };
    }

    let builtin = raw_id
        .and_then(|id| built_in().iter().find(|p| p.dark == dark && p.id == id))
        .or_else(|| default_built_in(dark));
    if let Some(palette) = builtin {
        let override_colors = overrides
            .get(palette.id)
            .cloned()
            .or_else(|| {
                (slot_id == Some(palette.id))
                    .then(|| ColorSchemeColors::from_legacy_json(&slot["scheme"]["colors"]))
                    .flatten()
            })
            .or_else(|| {
                (slot_id.is_none())
                    .then(|| {
                        matching_legacy
                            .filter(|l| l.id == palette.id)
                            .and_then(|l| l.colors.clone())
                    })
                    .flatten()
            });
        return SlotSelection {
            key: format!("builtin:{}", palette.id),
            builtin_id: Some(palette.id),
            preset_id: None,
            dark,
            colors: override_colors,
        };
    }

    SlotSelection {
        key: format!("builtin:{}", if dark { "mist" } else { "porcelain" }),
        builtin_id: Some(if dark { "mist" } else { "porcelain" }),
        preset_id: None,
        dark,
        colors: None,
    }
}

pub(super) fn options(
    state: &Value,
    config: &Value,
    active: &SlotSelection,
    dark: bool,
) -> Vec<PaletteOption> {
    let overrides = normalize_overrides(state);
    let presets = normalize_presets(state);
    let (custom_dark, custom_colors) = custom_scheme(state, config);
    let active_custom = active.builtin_id == Some("custom") && active.preset_id.is_none();
    let show_legacy_custom = !custom_colors.is_default_custom() || !custom_dark || active_custom;

    let mut out = Vec::new();
    for palette in built_in().iter().filter(|p| p.dark == dark) {
        let original_colors = palette.colors();
        let saved_colors = overrides.get(palette.id).cloned().or_else(|| {
            (active.builtin_id == Some(palette.id))
                .then(|| active.colors.clone())
                .flatten()
        });
        out.push(PaletteOption {
            key: format!("builtin:{}", palette.id),
            builtin_id: Some(palette.id),
            preset_id: None,
            name: t(palette.label).to_owned(),
            dark: palette.dark,
            colors: saved_colors.unwrap_or_else(|| original_colors.clone()),
            original_colors,
        });
    }

    if show_legacy_custom {
        let appearance_dark = if active_custom {
            active.dark
        } else {
            custom_dark
        };
        if appearance_dark == dark {
            let colors = if active_custom {
                active
                    .colors
                    .clone()
                    .unwrap_or_else(|| custom_colors.clone())
            } else {
                custom_colors
            };
            out.push(PaletteOption {
                key: "builtin:custom".to_owned(),
                builtin_id: Some("custom"),
                preset_id: None,
                name: t("settings.appearance.palette.saved").to_owned(),
                dark,
                colors,
                original_colors: ColorSchemeColors::default_custom(),
            });
        }
    }

    for preset in presets.into_iter().filter(|p| p.dark == dark) {
        out.push(PaletteOption {
            key: format!("preset:{}", preset.id),
            builtin_id: None,
            preset_id: Some(preset.id),
            name: preset.name,
            dark: preset.dark,
            colors: preset.colors.clone(),
            original_colors: preset.colors,
        });
    }
    out
}

pub(super) fn option_has_override(option: &PaletteOption, has_saved_override: bool) -> bool {
    let Some(id) = option.builtin_id else {
        return false;
    };
    if id == "custom" {
        option.colors != option.original_colors
    } else {
        has_saved_override || option.colors != option.original_colors
    }
}

pub(super) fn next_preset_name(source_name: &str, existing_names: &[String]) -> String {
    let source = source_name.trim();
    let source = if source.is_empty() { "Custom" } else { source };
    let (base, mut suffix) = split_numeric_suffix(source);
    let used: std::collections::HashSet<String> = existing_names
        .iter()
        .map(|name| name.trim().to_lowercase())
        .collect();
    let mut candidate = format_suffixed_name(base, suffix);
    while used.contains(&candidate.to_lowercase()) {
        let Some(next) = suffix.checked_add(1) else {
            break;
        };
        suffix = next;
        candidate = format_suffixed_name(base, suffix);
    }
    candidate
}

fn format_suffixed_name(base: &str, suffix: u64) -> String {
    let suffix_text = format!(" {suffix}");
    let budget = MAX_PRESET_NAME_LEN.saturating_sub(suffix_text.chars().count());
    let prefix: String = base.chars().take(budget).collect();
    let prefix = prefix.trim_end();
    if prefix.is_empty() {
        suffix.to_string()
    } else {
        format!("{prefix}{suffix_text}")
    }
}

fn split_numeric_suffix(source: &str) -> (&str, u64) {
    if let Some((prefix, tail)) = source.rsplit_once(char::is_whitespace) {
        let base = prefix.trim_end();
        if !base.is_empty()
            && !tail.is_empty()
            && tail.bytes().all(|b| b.is_ascii_digit())
            && let Ok(num) = tail.parse::<u64>()
            && let Some(next) = num.checked_add(1)
        {
            return (base, next);
        }
    }
    (source, 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_preset_name_matches_solid_numbering() {
        let existing = vec!["Mist 2".to_owned(), "mist 3".to_owned()];
        assert_eq!(next_preset_name("Mist", &existing), "Mist 4");
        assert_eq!(next_preset_name("Mist 2", &existing), "Mist 4");
        assert_eq!(next_preset_name("Slate 5", &[]), "Slate 6");
        assert_eq!(next_preset_name("   ", &[]), "Custom 2");
        let long = "a".repeat(MAX_PRESET_NAME_LEN);
        let copied = next_preset_name(&long, &[long.clone()]);
        assert!(copied.chars().count() <= MAX_PRESET_NAME_LEN);
        assert!(copied.ends_with(" 2"), "{copied}");
        assert_eq!(next_preset_name("Mist 4294967295", &[]), "Mist 4294967296");
        assert_eq!(
            next_preset_name("Mist 18446744073709551615", &[]),
            "Mist 18446744073709551615 2"
        );
    }

    #[test]
    fn normalize_presets_keeps_overflow_visible_and_validates_fields() {
        let colors = ColorSchemeColors::default_custom().to_json();
        let mut map = serde_json::Map::new();
        for i in 0..55 {
            map.insert(
                format!("p{i}"),
                json!({ "name": format!("Preset {i}"), "appearance": "dark", "colors": colors }),
            );
        }
        map.insert(
            "bad".to_owned(),
            json!({ "name": "   ", "appearance": "dark", "colors": colors }),
        );
        let state = json!({ "colorSchemePresets": map });
        let parsed = normalize_presets(&state);
        assert_eq!(parsed.len(), 55);
        assert!(!parsed.iter().any(|p| p.id == "bad"));
        let create = PaletteMutation {
            op: PaletteOp::SavePreset {
                preset_id: "p-new".to_owned(),
                name: "Overflow".to_owned(),
                dark: true,
                colors: ColorSchemeColors::default_custom(),
                allow_new: true,
                edited_fields: None,
            },
            legacy_config: Value::Null,
        };
        assert!(create.reject_before_send(&state));
    }

    fn merge_patch(target: &Value, patch: &Value) -> Value {
        let Some(patch_obj) = patch.as_object() else {
            return patch.clone();
        };
        let mut out = target.as_object().cloned().unwrap_or_default();
        for (key, value) in patch_obj {
            if value.is_null() {
                out.remove(key);
            } else {
                let base = out.get(key).cloned().unwrap_or(Value::Null);
                out.insert(key.clone(), merge_patch(&base, value));
            }
        }
        Value::Object(out)
    }

    #[test]
    fn save_preset_emits_per_key_color_delta_preserving_concurrent_edits() {
        let base = ColorSchemeColors::default_custom();
        let client_a_colors = base.with(ColorField::AccentPrimary, "#FF2266").unwrap();
        let client_b_colors = base.with(ColorField::BorderBase, "#33AA99").unwrap();
        let snapshot = json!({
            "appearancePreferences": {
                "mode": "dark",
                "dark": {
                    "scheme": { "id": "custom", "appearance": "dark", "colors": base.to_json() },
                    "presetId": "p1"
                }
            },
            "colorScheme": { "id": "custom", "appearance": "dark", "colors": base.to_json() },
            "activeColorSchemePresetId": "p1",
            "colorSchemePresets": {
                "p1": { "name": "Midnight", "appearance": "dark", "colors": base.to_json() }
            }
        });
        let op_a = PaletteMutation {
            op: PaletteOp::SavePreset {
                preset_id: "p1".to_owned(),
                name: "Midnight".to_owned(),
                dark: true,
                colors: client_a_colors,
                allow_new: false,
                edited_fields: Some(vec![ColorField::AccentPrimary]),
            },
            legacy_config: Value::Null,
        };
        let op_b = PaletteMutation {
            op: PaletteOp::SavePreset {
                preset_id: "p1".to_owned(),
                name: "Midnight".to_owned(),
                dark: true,
                colors: client_b_colors,
                allow_new: false,
                edited_fields: Some(vec![ColorField::BorderBase]),
            },
            legacy_config: Value::Null,
        };

        let mut patch_a = json!({});
        op_a.put(&mut patch_a, &snapshot);
        let mut patch_b = json!({});
        op_b.put(&mut patch_b, &snapshot);

        // Each client sends only its modified color key and omits name/unedited keys.
        assert!(patch_a["colorSchemePresets"]["p1"].get("name").is_none());
        assert_eq!(
            patch_a["colorSchemePresets"]["p1"]["colors"]
                .as_object()
                .map(|m| m.len()),
            Some(1)
        );
        assert_eq!(
            patch_a["colorSchemePresets"]["p1"]["colors"]["accentPrimary"],
            "#FF2266"
        );
        assert!(
            patch_a["appearancePreferences"]["dark"]["scheme"]["colors"]
                .get("borderBase")
                .is_none()
        );
        assert!(patch_a["colorScheme"]["colors"].get("borderBase").is_none());

        assert_eq!(
            patch_b["colorSchemePresets"]["p1"]["colors"]
                .as_object()
                .map(|m| m.len()),
            Some(1)
        );
        assert_eq!(
            patch_b["colorSchemePresets"]["p1"]["colors"]["borderBase"],
            "#33AA99"
        );

        // Simulate a third client renaming p1 before either color PATCH arrives; both apply orders
        // must keep the rename and both edited color keys without overwriting one another.
        let renamed_server = merge_patch(
            &snapshot,
            &json!({ "colorSchemePresets": { "p1": { "name": "Midnight Renamed" } } }),
        );
        for (first, second) in [(&patch_a, &patch_b), (&patch_b, &patch_a)] {
            let after_first = merge_patch(&renamed_server, first);
            let after_both = merge_patch(&after_first, second);
            assert_eq!(
                after_both["colorSchemePresets"]["p1"]["name"],
                "Midnight Renamed"
            );
            for path in [
                &after_both["colorSchemePresets"]["p1"]["colors"],
                &after_both["appearancePreferences"]["dark"]["scheme"]["colors"],
                &after_both["colorScheme"]["colors"],
            ] {
                assert_eq!(path["accentPrimary"], "#FF2266");
                assert_eq!(path["borderBase"], "#33AA99");
            }
            assert!(op_a.confirmed(&after_both));
            assert!(op_b.confirmed(&after_both));
        }

        // Editing a non-active preset still emits a per-key delta on colorSchemePresets while
        // writing a complete scheme to the newly activated slot.
        let inactive_snapshot = json!({
            "appearancePreferences": {
                "mode": "dark",
                "dark": {
                    "scheme": { "id": "mist", "appearance": "dark" },
                    "presetId": Value::Null
                }
            },
            "colorSchemePresets": {
                "p1": { "name": "Midnight", "appearance": "dark", "colors": base.to_json() }
            }
        });
        let mut inactive_patch = json!({});
        op_a.put(&mut inactive_patch, &inactive_snapshot);
        assert_eq!(
            inactive_patch["colorSchemePresets"]["p1"]["colors"]
                .as_object()
                .map(|m| m.len()),
            Some(1)
        );
        assert_eq!(
            inactive_patch["appearancePreferences"]["dark"]["scheme"]["colors"]
                .as_object()
                .map(|m| m.len()),
            Some(ColorField::ALL.len())
        );
    }

    #[test]
    fn legacy_modified_builtin_shows_override_and_reset_clears_it() {
        let mist = built_in()
            .iter()
            .find(|p| p.id == "mist" && p.dark)
            .expect("mist palette");
        let default_colors = mist.colors();
        let modified = default_colors
            .with(ColorField::AccentPrimary, "#FF2266")
            .unwrap();

        let cases = [
            (
                "slot-inline",
                json!({
                    "appearancePreferences": {
                        "mode": "dark",
                        "dark": {
                            "scheme": {
                                "id": "mist",
                                "appearance": "dark",
                                "colors": modified.to_json()
                            }
                        }
                    }
                }),
                Value::Null,
            ),
            (
                "legacy-config",
                json!({}),
                json!({
                    "colorScheme": {
                        "id": "mist",
                        "appearance": "dark",
                        "colors": modified.to_json()
                    }
                }),
            ),
        ];

        for (label, state, legacy_config) in cases {
            let legacy = legacy_scheme(&state, &legacy_config);
            let active = resolve_slot(&state, &legacy_config, legacy.as_ref(), true);
            let opts = options(&state, &legacy_config, &active, true);
            let mist_opt = opts
                .iter()
                .find(|o| o.builtin_id == Some("mist"))
                .expect("mist option");
            assert_eq!(mist_opt.colors, modified, "{label}");
            assert!(
                !normalize_overrides(&state).contains_key("mist"),
                "{label}: test requires no colorSchemeOverrides entry"
            );
            assert!(
                option_has_override(mist_opt, false),
                "{label}: Reset must appear for legacy modified built-in before migration"
            );

            let reset = PaletteMutation {
                op: PaletteOp::ResetOverride {
                    id: "mist",
                    dark: true,
                    default_colors: default_colors.clone(),
                },
                legacy_config: legacy_config_fields(&legacy_config),
            };
            let mut patch = json!({});
            reset.put(&mut patch, &state);
            let merged = merge_patch(&state, &patch);
            assert!(reset.confirmed(&merged), "{label}: reset must confirm");
            assert!(
                merged["colorSchemeOverrides"]["mist"].is_null(),
                "{label}: reset must not migrate legacy colors into colorSchemeOverrides"
            );
            assert!(
                merged["appearancePreferences"]["dark"]["scheme"]["colors"].is_null(),
                "{label}: reset must clear legacy slot colors"
            );

            let after_legacy = legacy_scheme(&merged, &legacy_config);
            let after_active = resolve_slot(&merged, &legacy_config, after_legacy.as_ref(), true);
            assert_eq!(after_active.colors, None, "{label}");
            let after_opts = options(&merged, &legacy_config, &after_active, true);
            let after_mist = after_opts
                .iter()
                .find(|o| o.builtin_id == Some("mist"))
                .expect("mist option after reset");
            assert_eq!(after_mist.colors, default_colors, "{label}");
            assert!(
                !option_has_override(after_mist, false),
                "{label}: Reset must hide once legacy override is cleared"
            );
            // An explicit colorSchemeOverrides entry still shows Reset even if colors match defaults.
            assert!(option_has_override(after_mist, true), "{label}");
        }
    }
}
