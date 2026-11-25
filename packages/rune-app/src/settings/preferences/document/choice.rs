use crate::settings::{
    notification_routing::{Category, Destination},
    palettes::PaletteMutation,
    transcript_preset::{self, Row},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(in crate::settings::preferences) enum Choice {
    Locale,
    Contrast,
    Shortcut(&'static str),
    ShortcutReset,
    GeneralBehavior(crate::settings::preferences::behavior::GeneralToggle),
    NewConversationPermissions,
    TranscriptPreset,
    TranscriptRow(Row),
    LogLevel,
    UpdateFeed,
    Advanced(crate::settings::advanced::Toggle),
    Environment,
    NotificationRoute(Category, Destination),
    NotificationsFocused,
    Mode,
    Palette(bool),
    PaletteMutation,
}

fn env_key_eq(a: &str, b: &str) -> bool {
    if a.is_ascii() && b.is_ascii() {
        a.eq_ignore_ascii_case(b)
    } else {
        a.to_uppercase() == b.to_uppercase()
    }
}

fn env_has_case_sibling(snapshot: &Value, name: &str) -> bool {
    snapshot["environmentVariables"]
        .as_object()
        .into_iter()
        .flatten()
        .any(|(k, v)| !v.is_null() && k != name && env_key_eq(k, name))
}

pub(in crate::settings) fn env_var_is_masked(snapshot: &Value, name: &str) -> bool {
    snapshot["secureEnvVars"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|key| env_key_eq(key, name))
}

impl Choice {
    pub(super) fn put(
        self,
        patch: &mut Value,
        value: &ChoiceValue,
        snapshot: &Value,
        atomic: bool,
    ) {
        if self == Self::ShortcutReset {
            patch["settings"]["hotkeyOverrides"] = Value::Null;
            return;
        }
        if let Self::Shortcut(id) = self {
            if let ChoiceValue::Shortcut(binding) = value {
                patch["settings"]["hotkeyOverrides"][id] = binding.clone();
            }
            return;
        }
        if let (
            Self::Environment,
            ChoiceValue::Environment {
                name,
                value,
                secret,
            },
        ) = (self, value)
        {
            patch["environmentVariables"][name] = value.clone().map_or(Value::Null, Value::String);
            let want_masked = match (value.is_some(), *secret) {
                (false, _) => Some(false),
                (true, Some(masked)) => Some(masked),
                (true, None) => None,
            };
            if let Some(want_masked) = want_masked
                && atomic
            {
                patch["secureEnvVarsMask"][name] = json!(want_masked);
            }
            return;
        }
        if let (Self::PaletteMutation, ChoiceValue::Palette(mutation)) = (self, value) {
            mutation.put(patch, snapshot);
            return;
        }
        let ChoiceValue::Text(value) = *value else {
            return;
        };
        match self {
            Self::Locale => patch["settings"]["locale"] = json!(value),
            Self::Contrast => patch["settings"]["highContrast"] = json!(value),
            Self::LogLevel => patch["logLevel"] = json!(value),
            Self::UpdateFeed => patch["updateFeed"] = json!(value),
            Self::Advanced(choice) => patch["settings"][choice.key()] = json!(value == "true"),
            Self::NotificationRoute(category, destination) => {
                patch["settings"]["notificationRouting"][category.key()][destination.key()] =
                    json!(value == "true");
            }
            Self::NotificationsFocused => {
                patch["settings"]["osNotificationsAllowWhenVisible"] = json!(value == "true");
            }
            Self::GeneralBehavior(toggle) => {
                patch["settings"][toggle.key()] = toggle.json_value(value == "true");
            }
            Self::NewConversationPermissions => {
                patch["settings"]["newConversationPermissions"] = json!(value)
            }
            Self::TranscriptPreset => {
                if let Value::Object(fields) = transcript_preset::patch(value) {
                    for (key, value) in fields {
                        patch["settings"][key] = value;
                    }
                }
            }
            Self::TranscriptRow(row) => {
                row.put(&mut patch["settings"], &snapshot["settings"], value, atomic)
            }
            Self::Mode => patch["appearancePreferences"]["mode"] = json!(value),
            Self::Shortcut(_) | Self::ShortcutReset | Self::Environment | Self::PaletteMutation => {
            }
            Self::Palette(dark) => {
                let mode = if dark { "dark" } else { "light" };
                patch["appearancePreferences"][mode] = json!({
                    "scheme":{"id":value,"appearance":mode,"colors":null},"presetId":null
                });
            }
        }
    }

    pub(super) fn confirmed(self, value: &ChoiceValue, snapshot: &Value) -> bool {
        if self == Self::ShortcutReset {
            let overrides = &snapshot["settings"]["hotkeyOverrides"];
            return overrides.is_null() || overrides.as_object().is_some_and(|map| map.is_empty());
        }
        if let Self::Shortcut(id) = self {
            return matches!(value, ChoiceValue::Shortcut(binding)
                if &snapshot["settings"]["hotkeyOverrides"][id] == binding);
        }
        if let (
            Self::Environment,
            ChoiceValue::Environment {
                name,
                value,
                secret,
            },
        ) = (self, value)
        {
            let saved = &snapshot["environmentVariables"][name];
            if value.is_none() && env_has_case_sibling(snapshot, name) {
                return saved.is_null();
            }
            let value_ok = value
                .as_ref()
                .map_or_else(|| saved.is_null(), |value| saved == value);
            let mask_ok = match (value.is_some(), *secret) {
                (false, _) => !env_var_is_masked(snapshot, name),
                (true, Some(masked)) => env_var_is_masked(snapshot, name) == masked,
                (true, None) => true,
            };
            return value_ok && mask_ok;
        }
        if let (Self::PaletteMutation, ChoiceValue::Palette(mutation)) = (self, value) {
            return mutation.confirmed(snapshot);
        }
        let ChoiceValue::Text(value) = *value else {
            return false;
        };
        let appearance = &snapshot["appearancePreferences"];
        match self {
            Self::Locale => snapshot["settings"]["locale"] == value,
            Self::Contrast => snapshot["settings"]["highContrast"] == value,
            Self::LogLevel => snapshot["logLevel"] == value,
            Self::UpdateFeed => snapshot["updateFeed"] == value,
            Self::Advanced(choice) => snapshot["settings"][choice.key()] == (value == "true"),
            Self::NotificationRoute(category, destination) => {
                snapshot["settings"]["notificationRouting"][category.key()][destination.key()]
                    == (value == "true")
            }
            Self::NotificationsFocused => {
                snapshot["settings"]["osNotificationsAllowWhenVisible"] == (value == "true")
            }
            Self::GeneralBehavior(toggle) => {
                snapshot["settings"][toggle.key()] == toggle.json_value(value == "true")
            }
            Self::NewConversationPermissions => {
                snapshot["settings"]["newConversationPermissions"] == value
            }
            Self::TranscriptPreset => transcript_preset::confirmed(value, &snapshot["settings"]),
            Self::TranscriptRow(row) => row.confirmed(value, &snapshot["settings"]),
            Self::Mode => appearance["mode"] == value,
            Self::Shortcut(_) | Self::ShortcutReset | Self::Environment | Self::PaletteMutation => {
                false
            }
            Self::Palette(dark) => {
                let mode = if dark { "dark" } else { "light" };
                let slot = &appearance[mode];
                slot["scheme"]["id"] == value
                    && slot["scheme"]["appearance"] == mode
                    // A newly created object can preserve explicit nulls in the merge.
                    && slot["scheme"]["colors"].is_null()
                    && slot["presetId"].is_null()
            }
        }
    }

    pub(super) fn has_dedicated_error(self) -> bool {
        matches!(
            self,
            Self::Contrast
                | Self::NewConversationPermissions
                | Self::Shortcut(_)
                | Self::ShortcutReset
                | Self::UpdateFeed
                | Self::PaletteMutation
        )
    }
}

#[derive(Clone, PartialEq)]
pub(super) enum ChoiceValue {
    Text(&'static str),
    Shortcut(Value),
    Palette(Box<PaletteMutation>),
    Environment {
        name: String,
        value: Option<String>,
        secret: Option<bool>,
    },
}

impl ChoiceValue {
    pub(super) fn needs_atomic_mask(&self) -> bool {
        matches!(
            self,
            Self::Environment { value, secret, .. } if value.is_none() || secret.is_some()
        )
    }
}

pub(super) type Choices = BTreeMap<Choice, ChoiceValue>;

pub(super) fn is_transcript(choice: Choice) -> bool {
    matches!(choice, Choice::TranscriptPreset | Choice::TranscriptRow(_))
}
