//! Editable Form drafts and native conditional answer construction.
use crate::agent_api::Form;
use rune::edit::TextEdit;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NormalizedOption<'a> {
    pub value: &'a str,
    pub label: Option<&'a str>,
    pub description: Option<&'a str>,
}

/// Normalize form options once for rendering, focus resolution, and validation:
/// enforce the 64-option bound, skip empty values that cannot be submitted as
/// explicit string choices, deduplicate by exact value (preserving first), and
/// keep only authored non-blank labels so raw protocol values never leak into copy.
pub fn normalized_options(field: &Value) -> Vec<NormalizedOption<'_>> {
    let Some(options) = field["options"].as_array() else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for option in options.iter().take(64) {
        let Some(value) = option["value"].as_str() else {
            continue;
        };
        if value.is_empty() || !seen.insert(value) {
            continue;
        }
        let label = option["label"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let description = option["description"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        out.push(NormalizedOption {
            value,
            label,
            description,
        });
    }
    out
}

pub fn bool_option_key(field_key: &str, value: &str) -> String {
    format!("bool-{field_key}-{value}")
}

pub fn string_option_key(field_key: &str, value: &str) -> String {
    format!(
        "option:{}:{field_key}:{}:{value}",
        field_key.len(),
        value.len()
    )
}

pub fn multi_option_key(field_key: &str, value: &str) -> String {
    format!(
        "multi:{}:{field_key}:{}:{value}",
        field_key.len(),
        value.len()
    )
}

pub fn field_group_key(field_key: &str) -> String {
    format!("form-group:{}:{field_key}", field_key.len())
}

pub fn clear_option_key(field_key: &str) -> String {
    format!("clear:{}:{field_key}", field_key.len())
}

pub fn valid_options_shape(field: &Value) -> bool {
    match field["type"].as_str() {
        Some("multiselect") => field
            .get("options")
            .and_then(Value::as_array)
            .is_some_and(|v| v.len() <= 64),
        _ => match field.get("options") {
            None | Some(Value::Null) => true,
            Some(Value::Array(v)) => v.len() <= 64,
            Some(_) => false,
        },
    }
}

pub fn has_declared_options(field: &Value) -> bool {
    field.get("options").is_some_and(Value::is_array)
}

pub struct Draft {
    pub edit: TextEdit,
    pub custom: TextEdit,
    pub choice: Option<String>,
    pub selected: BTreeSet<String>,
    pub dirty: bool,
}
impl Draft {
    pub fn choose(&mut self, value: &str) {
        self.edit = TextEdit::new(value);
        self.dirty = true;
    }
    pub fn choose_option(&mut self, value: &str) {
        self.choice = Some(value.into());
        self.custom = TextEdit::new("");
        self.dirty = true;
    }
    pub fn clear_choice(&mut self) {
        if self.choice.take().is_some() {
            self.dirty = true;
        }
    }
    pub fn toggle(&mut self, value: &str) {
        if !self.selected.remove(value) {
            self.selected.insert(value.into());
        }
        self.dirty = true;
    }
    pub fn editor(&mut self) -> &mut TextEdit {
        self.dirty = true;
        &mut self.edit
    }
    pub fn custom_editor(&mut self) -> &mut TextEdit {
        if !self.custom.text.is_empty() {
            self.choice = None;
        }
        self.dirty = true;
        &mut self.custom
    }
}
impl Default for Draft {
    fn default() -> Self {
        Self {
            edit: TextEdit::new(""),
            custom: TextEdit::new(""),
            choice: None,
            selected: BTreeSet::new(),
            dirty: false,
        }
    }
}
pub type Drafts = HashMap<(String, String), Draft>;
pub fn seed(forms: &[Form], drafts: &mut Drafts) {
    drafts.retain(|(id, key), _| {
        forms
            .iter()
            .any(|f| f.id == *id && f.fields.iter().any(|v| v["key"] == key.as_str()))
    });
    for form in forms {
        for field in &form.fields {
            let key = field["key"].as_str().unwrap_or_default().to_string();
            let draft = drafts.entry((form.id.clone(), key)).or_insert_with(|| {
                let mut d = Draft::default();
                let value = &field["default"];
                if field["type"] == "multiselect" {
                    if let Some(values) = value.as_array() {
                        let allowed = normalized_options(field);
                        let allow_custom = field["custom"] == true;
                        let mut custom_defaults = Vec::new();
                        let mut seen_custom = HashSet::new();
                        for raw in values.iter().filter_map(Value::as_str) {
                            if raw.is_empty() {
                                continue;
                            }
                            if allowed.iter().any(|opt| opt.value == raw) {
                                d.selected.insert(raw.to_string());
                            } else if allow_custom {
                                let trimmed = raw.trim();
                                if !trimmed.is_empty() && seen_custom.insert(trimmed.to_string()) {
                                    custom_defaults.push(trimmed.to_string());
                                }
                            }
                        }
                        if !custom_defaults.is_empty() {
                            d.custom = TextEdit::new(custom_defaults.join("\n"));
                        }
                    }
                } else if field["type"] == "string" && has_declared_options(field) {
                    if let Some(raw) = value.as_str().filter(|v| !v.is_empty()) {
                        let allowed = normalized_options(field);
                        if allowed.iter().any(|opt| opt.value == raw) {
                            d.choice = Some(raw.to_string());
                        } else if field["custom"] == true {
                            d.custom = TextEdit::new(raw);
                        }
                    }
                } else if !value.is_null() {
                    d.edit = TextEdit::new(
                        value
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| value.to_string()),
                    );
                } else if field["type"] == "boolean" && field["hidden"] != true {
                    d.edit = TextEdit::new("false");
                }
                d
            });
            // Keep seeded and retained option-backed selections aligned with normalized options
            // so removed or empty-valued entries cannot leave an invisible un-clearable choice,
            // while leaving custom free-text entries untouched.
            if field["type"] == "multiselect" && has_declared_options(field) {
                let allowed = normalized_options(field);
                draft
                    .selected
                    .retain(|selected| allowed.iter().any(|opt| opt.value == selected.as_str()));
            } else if field["type"] == "string" && has_declared_options(field) {
                let allowed = normalized_options(field);
                if draft
                    .choice
                    .as_deref()
                    .is_some_and(|chosen| !allowed.iter().any(|opt| opt.value == chosen))
                {
                    draft.choice = None;
                }
            }
        }
    }
}
pub fn active(field: &Value, values: &serde_json::Map<String, Value>) -> bool {
    field["when"].as_array().is_none_or(|rules| {
        rules.iter().all(|rule| {
            let Some(value) = rule["key"].as_str().and_then(|k| values.get(k)) else {
                return false;
            };
            let equal = if let Some(items) = value.as_array() {
                items.contains(&rule["value"])
            } else {
                *value == rule["value"]
            };
            if rule["op"] == "eq" {
                equal
            } else if rule["op"] == "neq" {
                !equal
            } else {
                false
            }
        })
    })
}
pub fn supported(form: &Form) -> bool {
    let mut keys = BTreeSet::new();
    form.fields.iter().all(|f| {
        f["key"].as_str().is_some_and(|k| {
            !k.is_empty()
                && k.len() <= 256
                && !matches!(k, "__proto__" | "constructor" | "prototype")
                && keys.insert(k)
        }) && matches!(
            f["type"].as_str(),
            Some("string" | "number" | "integer" | "boolean" | "multiselect")
        ) && valid_options_shape(f)
    })
}
pub fn value(field: &Value, d: &Draft) -> Result<Option<Value>, ()> {
    if !valid_options_shape(field) {
        return Err(());
    }
    let text = d.edit.text.as_str();
    if text.encode_utf16().count() > 20_000
        || d.custom.text.encode_utf16().count() > 20_000
        || d.choice
            .as_deref()
            .is_some_and(|c| c.encode_utf16().count() > 20_000)
    {
        return Err(());
    }
    match field["type"].as_str() {
        Some("string") => {
            if has_declared_options(field) {
                if !text.is_empty() {
                    return Err(());
                }
                let allow_custom = field["custom"] == true;
                let custom_text = d.custom.text.as_str();
                if !allow_custom && !custom_text.is_empty() {
                    return Err(());
                }
                let (selected_text, from_custom) = if allow_custom && !custom_text.is_empty() {
                    (custom_text, true)
                } else {
                    (d.choice.as_deref().unwrap_or(""), false)
                };
                if selected_text.is_empty() && field["required"] != true {
                    return Ok(None);
                }
                let n = selected_text.encode_utf16().count() as u64;
                if (field["required"] == true && selected_text.is_empty())
                    || field["minLength"].as_u64().is_some_and(|m| n < m)
                    || field["maxLength"].as_u64().is_some_and(|m| n > m)
                {
                    return Err(());
                }
                if !from_custom {
                    let options = normalized_options(field);
                    if !options.iter().any(|o| o.value == selected_text) {
                        return Err(());
                    }
                }
                return Ok(Some(json!(selected_text)));
            }
            if text.is_empty() && field["required"] != true {
                return Ok(None);
            }
            let n = text.encode_utf16().count() as u64;
            if (field["required"] == true && text.is_empty())
                || field["minLength"].as_u64().is_some_and(|m| n < m)
                || field["maxLength"].as_u64().is_some_and(|m| n > m)
            {
                return Err(());
            }
            Ok(Some(json!(text)))
        }
        Some("number" | "integer") => {
            if text.trim().is_empty() {
                return if field["required"] == true {
                    Err(())
                } else {
                    Ok(None)
                };
            }
            let n = text.parse::<f64>().map_err(|_| ())?;
            if !n.is_finite()
                || (field["type"] == "integer" && n.fract() != 0.0)
                || field["minimum"].as_f64().is_some_and(|m| n < m)
                || field["maximum"].as_f64().is_some_and(|m| n > m)
            {
                return Err(());
            }
            Ok(Some(json!(n)))
        }
        Some("boolean") => match text {
            "true" => Ok(Some(json!(true))),
            "false" => Ok(Some(json!(false))),
            _ => {
                if field["required"] == true {
                    Err(())
                } else {
                    Ok(None)
                }
            }
        },
        Some("multiselect") => {
            let mut values = d.selected.clone();
            if field["custom"] == true {
                values.extend(
                    d.custom
                        .text
                        .lines()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                        .map(str::to_string),
                );
            }
            let count = values.len() as u64;
            if count > 32
                || (field["required"] == true && count == 0)
                || field["minItems"].as_u64().is_some_and(|m| count < m)
                || field["maxItems"].as_u64().is_some_and(|m| count > m)
            {
                return Err(());
            }
            if field["options"].as_array().is_some() {
                let options = normalized_options(field);
                if d.selected
                    .iter()
                    .any(|value| !options.iter().any(|o| o.value == value.as_str()))
                {
                    return Err(());
                }
            }
            Ok(Some(json!(values)))
        }
        _ => Err(()),
    }
}
pub fn values(form: &Form, drafts: &Drafts) -> serde_json::Map<String, Value> {
    form.fields
        .iter()
        .filter_map(|f| {
            let key = f["key"].as_str()?;
            let d = drafts.get(&(form.id.clone(), key.into()))?;
            value(f, d).ok().flatten().map(|v| (key.into(), v))
        })
        .collect()
}
pub fn answer(form: &Form, drafts: &Drafts) -> Result<Value, ()> {
    if !supported(form) {
        return Err(());
    }
    let all = values(form, drafts);
    let mut out = serde_json::Map::new();
    for field in &form.fields {
        if !active(field, &all) {
            continue;
        }
        let key = field["key"].as_str().ok_or(())?;
        let d = drafts.get(&(form.id.clone(), key.into())).ok_or(())?;
        if let Some(value) = value(field, d)? {
            out.insert(key.into(), value);
        }
    }
    Ok(Value::Object(out))
}
