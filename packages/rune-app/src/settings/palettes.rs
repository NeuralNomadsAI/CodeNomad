//! User palette presets, built-in overrides, legacy custom schemes, and Owner::State patches.
use crate::strings::t;
use rune_theme_codenomad::palettes::{
    ColorSchemeColors, Palette, ResolvedPalette, built_in, custom, increased_contrast,
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
        colors: Option<ColorSchemeColors>,
    },
    SelectCustom {
        dark: bool,
        colors: ColorSchemeColors,
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
    },
    DeletePreset {
        preset_id: String,
        fallback_light: Option<Value>,
        fallback_dark: Option<Value>,
        clear_active: bool,
    },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) struct PaletteMutation {
    pub op: PaletteOp,
    pub preserve_mode: Option<&'static str>,
    pub preserve_sibling: Option<(bool, Value)>,
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
            Self::DeletePreset { .. } => None,
        }
    }
}

impl PaletteMutation {
    pub(super) fn target_dark(&self) -> Option<bool> {
        self.op.target_dark()
    }

    pub(super) fn put(&self, patch: &mut Value) {
        if let Some(mode) = self.preserve_mode {
            patch["appearancePreferences"]["mode"] = json!(mode);
        }
        if let Some((sibling_dark, slot)) = &self.preserve_sibling {
            patch["appearancePreferences"][mode_str(*sibling_dark)] = slot.clone();
        }
        match &self.op {
            PaletteOp::SelectBuiltIn { id, dark, colors } => {
                let mode = mode_str(*dark);
                let scheme_colors = colors
                    .as_ref()
                    .map_or(Value::Null, ColorSchemeColors::to_json);
                let scheme = json!({
                    "id": id,
                    "appearance": mode,
                    "colors": scheme_colors,
                });
                patch["colorScheme"] = scheme.clone();
                patch["activeColorSchemePresetId"] = Value::Null;
                patch["appearancePreferences"][mode] = json!({
                    "scheme": scheme,
                    "presetId": Value::Null,
                });
            }
            PaletteOp::SelectCustom { dark, colors } | PaletteOp::SaveCustom { dark, colors } => {
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
                let scheme = json!({
                    "id": "custom",
                    "appearance": mode,
                    "colors": colors.to_json(),
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
            } => {
                let mode = mode_str(*dark);
                let colors_json = colors.to_json();
                let scheme = json!({
                    "id": "custom",
                    "appearance": mode,
                    "colors": colors_json,
                });
                patch["colorScheme"] = scheme.clone();
                patch["colorSchemePresets"][preset_id] = json!({
                    "name": name,
                    "appearance": mode,
                    "colors": colors_json,
                });
                patch["activeColorSchemePresetId"] = json!(preset_id);
                patch["appearancePreferences"][mode] = json!({
                    "scheme": scheme,
                    "presetId": preset_id,
                });
            }
            PaletteOp::DeletePreset {
                preset_id,
                fallback_light,
                fallback_dark,
                clear_active,
            } => {
                patch["colorSchemePresets"][preset_id] = Value::Null;
                if let Some(light) = fallback_light {
                    patch["appearancePreferences"]["light"] = light.clone();
                }
                if let Some(dark) = fallback_dark {
                    patch["appearancePreferences"]["dark"] = dark.clone();
                }
                if *clear_active {
                    patch["activeColorSchemePresetId"] = Value::Null;
                }
            }
        }
    }

    pub(super) fn confirmed(&self, snapshot: &Value) -> bool {
        let appearance = &snapshot["appearancePreferences"];
        if let Some(mode) = self.preserve_mode
            && appearance["mode"].as_str() != Some(mode)
        {
            return false;
        }
        if let Some((sibling_dark, expected_slot)) = &self.preserve_sibling
            && !slot_matches(&appearance[mode_str(*sibling_dark)], expected_slot)
        {
            return false;
        }
        match &self.op {
            PaletteOp::SelectBuiltIn { id, dark, colors } => {
                let mode = mode_str(*dark);
                let slot = &appearance[mode];
                let colors_match = match colors {
                    Some(colors) => {
                        ColorSchemeColors::from_json(&slot["scheme"]["colors"]).as_ref()
                            == Some(colors)
                    }
                    None => slot["scheme"]["colors"].is_null(),
                };
                slot["scheme"]["id"] == *id
                    && slot["scheme"]["appearance"] == mode
                    && colors_match
                    && slot["presetId"].is_null()
                    && snapshot["activeColorSchemePresetId"].is_null()
            }
            PaletteOp::SelectCustom { dark, colors } | PaletteOp::SaveCustom { dark, colors } => {
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
                preset_id,
                dark,
                colors,
            } => {
                let mode = mode_str(*dark);
                let slot = &appearance[mode];
                let preset = &snapshot["colorSchemePresets"][preset_id];
                preset["appearance"] == mode
                    && ColorSchemeColors::from_json(&preset["colors"]).as_ref() == Some(colors)
                    && snapshot["activeColorSchemePresetId"] == *preset_id
                    && slot["presetId"] == *preset_id
                    && slot["scheme"]["id"] == "custom"
                    && slot["scheme"]["appearance"] == mode
                    && ColorSchemeColors::from_json(&slot["scheme"]["colors"]).as_ref()
                        == Some(colors)
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
            } => {
                let mode = mode_str(*dark);
                let slot = &appearance[mode];
                let preset = &snapshot["colorSchemePresets"][preset_id];
                preset["name"] == *name
                    && preset["appearance"] == mode
                    && ColorSchemeColors::from_json(&preset["colors"]).as_ref() == Some(colors)
                    && snapshot["activeColorSchemePresetId"] == *preset_id
                    && slot["presetId"] == *preset_id
                    && slot["scheme"]["id"] == "custom"
                    && slot["scheme"]["appearance"] == mode
                    && ColorSchemeColors::from_json(&slot["scheme"]["colors"]).as_ref()
                        == Some(colors)
            }
            PaletteOp::DeletePreset {
                preset_id,
                fallback_light,
                fallback_dark,
                clear_active,
            } => {
                let deleted = snapshot["colorSchemePresets"][preset_id].is_null();
                let light_ok = fallback_light
                    .as_ref()
                    .is_none_or(|expected| slot_matches(&appearance["light"], expected));
                let dark_ok = fallback_dark
                    .as_ref()
                    .is_none_or(|expected| slot_matches(&appearance["dark"], expected));
                let active_ok = !*clear_active
                    || snapshot["activeColorSchemePresetId"].as_str() != Some(preset_id.as_str());
                deleted && light_ok && dark_ok && active_ok
            }
        }
    }
}

fn slot_matches(actual: &Value, expected: &Value) -> bool {
    let id_ok = actual["scheme"]["id"] == expected["scheme"]["id"];
    let appearance_ok = actual["scheme"]["appearance"] == expected["scheme"]["appearance"];
    let preset_ok = actual["presetId"] == expected["presetId"];
    let colors_ok = match ColorSchemeColors::from_json(&expected["scheme"]["colors"]) {
        Some(expected_colors) => {
            ColorSchemeColors::from_json(&actual["scheme"]["colors"]).as_ref()
                == Some(&expected_colors)
        }
        None => actual["scheme"]["colors"].is_null(),
    };
    id_ok && appearance_ok && preset_ok && colors_ok
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
        if presets.len() >= MAX_PRESETS {
            break;
        }
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
        .or_else(|| config.get("customColorScheme"))
        .unwrap_or(&Value::Null);
    let dark = candidate["appearance"].as_str() != Some("light");
    let colors = ColorSchemeColors::from_legacy_json(&candidate["colors"])
        .unwrap_or_else(ColorSchemeColors::default_custom);
    (dark, colors)
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

pub(super) fn next_preset_name(source_name: &str, existing_names: &[String]) -> String {
    let source = source_name.trim();
    let source = if source.is_empty() { "Custom" } else { source };
    let (base, mut suffix) = split_numeric_suffix(source);
    let used: std::collections::HashSet<String> = existing_names
        .iter()
        .map(|name| name.trim().to_lowercase())
        .collect();
    while used.contains(&format!("{base} {suffix}").to_lowercase()) {
        suffix += 1;
    }
    format!("{base} {suffix}")
}

fn split_numeric_suffix(source: &str) -> (&str, u32) {
    if let Some((prefix, tail)) = source.rsplit_once(char::is_whitespace) {
        let base = prefix.trim_end();
        if !base.is_empty()
            && !tail.is_empty()
            && tail.bytes().all(|b| b.is_ascii_digit())
            && let Ok(num) = tail.parse::<u32>()
        {
            return (base, num.saturating_add(1));
        }
    }
    (source, 2)
}

/// Matches Solid's `deleteColorSchemePreset`: preserves the slot's resolved colors as an unnamed
/// custom scheme while clearing `presetId` and removing the named preset entry.
pub(super) fn delete_slot_patch(
    state: &Value,
    config: &Value,
    legacy: Option<&LegacyScheme>,
    dark: bool,
    deleting_preset_id: &str,
) -> Option<Value> {
    let mode = mode_str(dark);
    if state["appearancePreferences"][mode]["presetId"].as_str() != Some(deleting_preset_id) {
        return None;
    }
    let current = resolve_slot(state, config, legacy, dark);
    let colors = current.colors.unwrap_or_else(|| {
        default_built_in(dark)
            .map(Palette::colors)
            .unwrap_or_else(ColorSchemeColors::default_custom)
    });
    Some(json!({
        "scheme": {
            "id": "custom",
            "appearance": mode,
            "colors": colors.to_json(),
        },
        "presetId": Value::Null,
    }))
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
    }

    #[test]
    fn normalize_presets_enforces_limit_and_validates_fields() {
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
        assert_eq!(parsed.len(), MAX_PRESETS);
        assert!(!parsed.iter().any(|p| p.id == "bad"));
    }
}
