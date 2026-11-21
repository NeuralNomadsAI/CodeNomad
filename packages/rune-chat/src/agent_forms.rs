//! Editable Form drafts and native conditional answer construction.
use crate::agent_api::Form;
use rune::edit::TextEdit;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
pub struct Draft {
    pub edit: TextEdit,
    pub custom: TextEdit,
    pub selected: BTreeSet<String>,
    pub dirty: bool,
}
impl Default for Draft {
    fn default() -> Self {
        Self {
            edit: TextEdit::new(""),
            custom: TextEdit::new(""),
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
            drafts.entry((form.id.clone(), key)).or_insert_with(|| {
                let mut d = Draft::default();
                let value = &field["default"];
                if let Some(values) = value.as_array() {
                    d.selected = values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect();
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
        ) && f["options"].as_array().is_none_or(|v| v.len() <= 64)
    })
}
pub fn value(field: &Value, d: &Draft) -> Result<Option<Value>, ()> {
    let text = d.edit.text.as_str();
    if text.encode_utf16().count() > 20_000 || d.custom.text.encode_utf16().count() > 20_000 {
        return Err(());
    }
    match field["type"].as_str() {
        Some("string") => {
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
            if field["custom"] != true
                && field["options"]
                    .as_array()
                    .is_some_and(|v| !v.is_empty() && !v.iter().any(|o| o["value"] == text))
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
            if field["options"].as_array().is_some_and(|options| {
                d.selected
                    .iter()
                    .any(|value| !options.iter().any(|o| o["value"] == value.as_str()))
            }) {
                return Err(());
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
