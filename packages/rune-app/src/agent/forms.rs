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
            None => true,
            Some(Value::Array(v)) => v.len() <= 64,
            Some(_) => false,
        },
    }
}

pub fn has_declared_options(field: &Value) -> bool {
    field.get("options").is_some_and(Value::is_array)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldKind {
    StringFree,
    StringOptions,
    Number,
    Integer,
    Boolean,
    Multiselect,
    Unsupported,
}

fn field_kind(field: &Value) -> FieldKind {
    match field["type"].as_str() {
        Some("string") if has_declared_options(field) => FieldKind::StringOptions,
        Some("string") => FieldKind::StringFree,
        Some("number") => FieldKind::Number,
        Some("integer") => FieldKind::Integer,
        Some("boolean") => FieldKind::Boolean,
        Some("multiselect") => FieldKind::Multiselect,
        _ => FieldKind::Unsupported,
    }
}

fn is_line_editable_custom(value: &str) -> bool {
    !value.contains(['\n', '\r']) && value.trim() == value
}

fn parse_u64_bound(field: &Value, key: &str) -> Result<Option<u64>, ()> {
    match field.get(key) {
        None => Ok(None),
        Some(v) => v.as_u64().map(Some).ok_or(()),
    }
}

fn parse_f64_bound(field: &Value, key: &str) -> Result<Option<f64>, ()> {
    match field.get(key) {
        None => Ok(None),
        Some(v) => v.as_f64().filter(|n| n.is_finite()).map(Some).ok_or(()),
    }
}

/// Validate that any declared length/item/numeric bounds have legal JSON types and finite values.
pub fn valid_bounds(field: &Value) -> bool {
    match field["type"].as_str() {
        Some("string") => {
            parse_u64_bound(field, "minLength").is_ok()
                && parse_u64_bound(field, "maxLength").is_ok()
        }
        Some("multiselect") => {
            parse_u64_bound(field, "minItems").is_ok() && parse_u64_bound(field, "maxItems").is_ok()
        }
        Some("number" | "integer") => {
            parse_f64_bound(field, "minimum").is_ok() && parse_f64_bound(field, "maximum").is_ok()
        }
        Some("boolean") => true,
        _ => false,
    }
}

fn string_value_satisfies_bounds(field: &Value, raw: &str) -> bool {
    let Ok(min_len) = parse_u64_bound(field, "minLength") else {
        return false;
    };
    let Ok(max_len) = parse_u64_bound(field, "maxLength") else {
        return false;
    };
    let n = raw.encode_utf16().count() as u64;
    n <= 20_000 && min_len.is_none_or(|m| n >= m) && max_len.is_none_or(|m| n <= m)
}

/// Whether an active field requires a non-empty answer before submission.
pub fn field_required(field: &Value) -> bool {
    field["required"] == true
        || (field["type"] == "multiselect"
            && parse_u64_bound(field, "minItems")
                .ok()
                .flatten()
                .is_some_and(|m| m > 0))
}

/// Whether a custom-enabled string radio field currently holds text matching a declared option's
/// wire value while that radio remains unchecked.
pub fn custom_matches_declared_option(field: &Value, d: &Draft) -> bool {
    field["type"] == "string"
        && has_declared_options(field)
        && field["custom"] == true
        && !d.custom.text.is_empty()
        && normalized_options(field)
            .iter()
            .any(|opt| opt.value == d.custom.text.as_str())
}

/// Whether an active field cannot be satisfied by any valid user action using the exact same
/// validated bounds enforced by `value()` (malformed bounds, empty/normalized-away required closed
/// choices, contradictory `minItems`/`maxItems` or `minLength`/`maxLength`, or closed options
/// exceeding the 20,000 UTF-16 code-unit limit).
pub fn field_unanswerable(field: &Value) -> bool {
    if !valid_options_shape(field) || !valid_bounds(field) {
        return true;
    }
    match field["type"].as_str() {
        Some("string") if has_declared_options(field) && field["custom"] != true => {
            field["required"] == true
                && !normalized_options(field)
                    .iter()
                    .any(|opt| string_value_satisfies_bounds(field, opt.value))
        }
        Some("string") => {
            if field["required"] != true {
                return false;
            }
            let min_len = parse_u64_bound(field, "minLength")
                .ok()
                .flatten()
                .unwrap_or(1)
                .max(1);
            let max_len = parse_u64_bound(field, "maxLength")
                .ok()
                .flatten()
                .unwrap_or(20_000)
                .min(20_000);
            min_len > max_len
        }
        Some("multiselect") => {
            let min_needed = parse_u64_bound(field, "minItems")
                .ok()
                .flatten()
                .unwrap_or(0)
                .max(u64::from(field["required"] == true));
            let max_allowed = parse_u64_bound(field, "maxItems")
                .ok()
                .flatten()
                .unwrap_or(32)
                .min(32);
            if field["custom"] == true {
                min_needed > max_allowed
            } else {
                let valid_count = normalized_options(field)
                    .iter()
                    .filter(|opt| opt.value.encode_utf16().count() <= 20_000)
                    .count() as u64;
                min_needed > valid_count.min(max_allowed)
            }
        }
        Some("number") => {
            field["required"] == true
                && matches!(
                    (
                        parse_f64_bound(field, "minimum").ok().flatten(),
                        parse_f64_bound(field, "maximum").ok().flatten()
                    ),
                    (Some(min), Some(max)) if min > max
                )
        }
        Some("integer") => {
            field["required"] == true
                && matches!(
                    (
                        parse_f64_bound(field, "minimum").ok().flatten(),
                        parse_f64_bound(field, "maximum").ok().flatten()
                    ),
                    (Some(min), Some(max)) if min.ceil() > max.floor()
                )
        }
        _ => false,
    }
}

pub struct Draft {
    pub edit: TextEdit,
    pub custom: TextEdit,
    pub choice: Option<String>,
    pub selected: BTreeSet<String>,
    pub preserved_custom: Vec<String>,
    pub preserved_custom_selected: BTreeSet<String>,
    pub declared_options: Option<BTreeSet<String>>,
    pub prior_choice_values: BTreeSet<String>,
    pub hidden_value: Option<String>,
    pub kind: Option<FieldKind>,
    pub dirty: bool,
}
impl Draft {
    pub fn choose(&mut self, value: &str) {
        self.edit = TextEdit::new(value);
        self.dirty = true;
    }
    pub fn choose_option(&mut self, value: &str) {
        self.choice = Some(value.into());
        if !self.custom.text.is_empty() {
            self.custom = TextEdit::new("");
        }
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
    pub fn toggle_preserved_custom(&mut self, value: &str) {
        if !self.preserved_custom_selected.remove(value) {
            self.preserved_custom_selected.insert(value.into());
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
            preserved_custom: Vec::new(),
            preserved_custom_selected: BTreeSet::new(),
            declared_options: None,
            prior_choice_values: BTreeSet::new(),
            hidden_value: None,
            kind: None,
            dirty: false,
        }
    }
}
pub type Drafts = HashMap<(String, String), Draft>;

fn declared_option_set(field: &Value) -> Option<BTreeSet<String>> {
    has_declared_options(field).then(|| {
        normalized_options(field)
            .into_iter()
            .map(|o| o.value.to_string())
            .collect()
    })
}

fn fresh_draft(field: &Value) -> Draft {
    let declared = declared_option_set(field);
    let mut d = Draft {
        kind: Some(field_kind(field)),
        declared_options: declared.clone(),
        ..Default::default()
    };
    let value = &field["default"];
    if field["type"] == "multiselect" {
        if let Some(values) = value.as_array() {
            let allowed = normalized_options(field);
            let allow_custom = field["custom"] == true;
            let hidden = field["hidden"] == true;
            let mut seen_custom = HashSet::new();
            let mut editable_custom = Vec::new();
            for raw in values.iter().filter_map(Value::as_str) {
                if raw.is_empty() {
                    continue;
                }
                if allowed.iter().any(|opt| opt.value == raw) {
                    d.selected.insert(raw.to_string());
                } else if allow_custom && seen_custom.insert(raw.to_string()) {
                    if hidden || !is_line_editable_custom(raw) {
                        d.preserved_custom.push(raw.to_string());
                        d.preserved_custom_selected.insert(raw.to_string());
                    } else {
                        editable_custom.push(raw);
                    }
                }
            }
            if !editable_custom.is_empty() {
                d.custom = TextEdit::new(editable_custom.join("\n"));
            }
        }
    } else if field["type"] == "string" && has_declared_options(field) {
        if let Some(opts) = &declared {
            d.prior_choice_values.extend(opts.iter().cloned());
        }
        if let Some(raw) = value.as_str().filter(|v| !v.is_empty()) {
            let allowed = normalized_options(field);
            if allowed.iter().any(|opt| opt.value == raw) {
                d.choice = Some(raw.to_string());
                d.prior_choice_values.insert(raw.to_string());
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
}

pub fn seed(forms: &[Form], drafts: &mut Drafts) {
    drafts.retain(|(id, key), _| {
        forms
            .iter()
            .any(|f| f.id == *id && f.fields.iter().any(|v| v["key"] == key.as_str()))
    });
    for form in forms {
        for field in &form.fields {
            let key = field["key"].as_str().unwrap_or_default().to_string();
            let id = (form.id.clone(), key);
            let kind = field_kind(field);
            let Some(draft) = drafts.get_mut(&id) else {
                drafts.insert(id, fresh_draft(field));
                continue;
            };
            // Reseed incompatible drafts on field-kind transitions, carry choice provenance across
            // the field's lifetime, and keep hidden protocol defaults separate from display copy.
            if let Some(prev) = draft.kind
                && prev != kind
            {
                let mut choice_provenance = std::mem::take(&mut draft.prior_choice_values);
                if prev == FieldKind::StringOptions {
                    if let Some(prev_opts) = draft.declared_options.take() {
                        choice_provenance.extend(prev_opts);
                    }
                    if let Some(prev_choice) = draft.choice.take() {
                        choice_provenance.insert(prev_choice);
                    }
                }
                match (prev, kind) {
                    (FieldKind::StringOptions, FieldKind::StringFree) => {
                        let authored = std::mem::take(&mut draft.custom.text);
                        if !authored.is_empty() {
                            draft.edit = TextEdit::new(authored);
                            draft.custom = TextEdit::new("");
                            draft.selected.clear();
                            draft.preserved_custom.clear();
                            draft.preserved_custom_selected.clear();
                            draft.hidden_value = None;
                            draft.prior_choice_values = choice_provenance;
                            draft.kind = Some(kind);
                            continue;
                        }
                        let mut next = fresh_draft(field);
                        if let Some(raw) = field["default"].as_str()
                            && choice_provenance.contains(raw)
                        {
                            next.edit = TextEdit::new("");
                            if field["hidden"] == true {
                                next.hidden_value = Some(raw.to_string());
                            }
                        }
                        next.prior_choice_values.extend(choice_provenance);
                        *draft = next;
                        continue;
                    }
                    (FieldKind::StringFree, FieldKind::StringOptions) => {
                        if !draft.dirty && draft.edit.text.is_empty() {
                            let mut next = fresh_draft(field);
                            next.prior_choice_values.extend(choice_provenance);
                            *draft = next;
                            continue;
                        }
                        draft.hidden_value = None;
                        draft.prior_choice_values = choice_provenance;
                        draft.kind = Some(kind);
                    }
                    _ => {
                        let mut next = fresh_draft(field);
                        next.prior_choice_values.extend(choice_provenance);
                        *draft = next;
                        continue;
                    }
                }
            } else {
                draft.kind = Some(kind);
            }

            // Reconcile retained drafts against the field's current schema without mutating
            // untouched editors or selecting options that were already declared before refresh.
            let current_options = declared_option_set(field);
            if kind == FieldKind::Multiselect {
                if !draft.edit.text.is_empty() {
                    draft.edit = TextEdit::new("");
                }
                draft.choice = None;
                let allowed = normalized_options(field);
                let allow_custom = field["custom"] == true;
                let hidden = field["hidden"] == true;
                let prev_options = draft.declared_options.as_ref();
                let is_newly_declared = |val: &str| {
                    allowed.iter().any(|opt| opt.value == val)
                        && prev_options.is_none_or(|prev| !prev.contains(val))
                };
                if has_declared_options(field) {
                    draft.selected.retain(|selected| {
                        allowed.iter().any(|opt| opt.value == selected.as_str())
                    });
                }
                let mut remaining_preserved = Vec::new();
                let mut remaining_preserved_selected = BTreeSet::new();
                let mut newly_editable = Vec::new();
                for item in std::mem::take(&mut draft.preserved_custom) {
                    let was_selected = draft.preserved_custom_selected.contains(&item);
                    if is_newly_declared(&item) {
                        if was_selected {
                            draft.selected.insert(item);
                        }
                    } else if allowed.iter().any(|opt| opt.value == item.as_str()) {
                        // Already declared: declared checkboxes own its selection state.
                    } else if allow_custom {
                        if !hidden
                            && !draft.dirty
                            && draft.custom.text.is_empty()
                            && is_line_editable_custom(&item)
                        {
                            if was_selected {
                                newly_editable.push(item);
                            }
                        } else {
                            if was_selected {
                                remaining_preserved_selected.insert(item.clone());
                            }
                            remaining_preserved.push(item);
                        }
                    }
                }
                draft.preserved_custom = remaining_preserved;
                draft.preserved_custom_selected = remaining_preserved_selected;
                if !newly_editable.is_empty() {
                    draft.custom = TextEdit::new(newly_editable.join("\n"));
                }
                if !draft.custom.text.is_empty() {
                    if !allow_custom {
                        draft.custom = TextEdit::new("");
                    } else {
                        let mut kept = Vec::new();
                        let mut promoted = false;
                        for line in draft.custom.text.lines() {
                            let trimmed = line.trim();
                            if !trimmed.is_empty() && is_newly_declared(trimmed) {
                                draft.selected.insert(trimmed.to_string());
                                promoted = true;
                            } else {
                                kept.push(line);
                            }
                        }
                        if promoted {
                            let next = kept.join("\n");
                            if draft.custom.text != next {
                                draft.custom = TextEdit::new(next);
                            }
                        }
                    }
                }
            } else if kind == FieldKind::StringOptions {
                draft.selected.clear();
                draft.preserved_custom.clear();
                draft.preserved_custom_selected.clear();
                let allowed = normalized_options(field);
                let allow_custom = field["custom"] == true;
                let prev_options = draft.declared_options.as_ref();
                let is_newly_declared = |val: &str| {
                    allowed.iter().any(|opt| opt.value == val)
                        && prev_options.is_none_or(|prev| !prev.contains(val))
                };
                if let Some(opts) = &current_options {
                    draft.prior_choice_values.extend(opts.iter().cloned());
                }
                if draft
                    .choice
                    .as_deref()
                    .is_some_and(|chosen| !allowed.iter().any(|opt| opt.value == chosen))
                {
                    draft.choice = None;
                }
                if !draft.edit.text.is_empty() {
                    let prior = std::mem::take(&mut draft.edit.text);
                    draft.edit = TextEdit::new("");
                    if allowed.iter().any(|opt| opt.value == prior.as_str()) {
                        draft.choice = Some(prior);
                        if !draft.custom.text.is_empty() {
                            draft.custom = TextEdit::new("");
                        }
                    } else if allow_custom && draft.custom.text.is_empty() {
                        draft.custom = TextEdit::new(prior);
                    }
                }
                if !draft.custom.text.is_empty() {
                    if is_newly_declared(draft.custom.text.as_str()) {
                        draft.choice = Some(draft.custom.text.clone());
                        draft.custom = TextEdit::new("");
                    } else if !allow_custom {
                        draft.custom = TextEdit::new("");
                    }
                }
            } else {
                draft.selected.clear();
                draft.preserved_custom.clear();
                draft.preserved_custom_selected.clear();
                draft.choice = None;
                if kind == FieldKind::StringFree {
                    if field["hidden"] != true {
                        if let Some(hidden) = draft.hidden_value.take()
                            && draft.edit.text.is_empty()
                            && !draft.prior_choice_values.contains(&hidden)
                        {
                            draft.edit = TextEdit::new(hidden);
                        }
                    } else if draft.hidden_value.is_none()
                        && draft.edit.text.is_empty()
                        && let Some(raw) = field["default"].as_str()
                        && draft.prior_choice_values.contains(raw)
                    {
                        draft.hidden_value = Some(raw.to_string());
                    }
                    if draft.edit.text.is_empty() && !draft.custom.text.is_empty() {
                        draft.edit = TextEdit::new(&draft.custom.text);
                    }
                } else {
                    draft.hidden_value = None;
                }
                if !draft.custom.text.is_empty() {
                    draft.custom = TextEdit::new("");
                }
            }
            draft.declared_options = current_options;
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
            && valid_bounds(f)
            && !(f["when"].as_array().is_none() && field_unanswerable(f))
    })
}
pub fn value(field: &Value, d: &Draft) -> Result<Option<Value>, ()> {
    if !valid_options_shape(field) || !valid_bounds(field) {
        return Err(());
    }
    let text = d.edit.text.as_str();
    if text.encode_utf16().count() > 20_000
        || d.custom.text.encode_utf16().count() > 20_000
        || d.choice
            .as_deref()
            .is_some_and(|c| c.encode_utf16().count() > 20_000)
        || d.hidden_value
            .as_deref()
            .is_some_and(|h| h.encode_utf16().count() > 20_000)
    {
        return Err(());
    }
    match field["type"].as_str() {
        Some("string") => {
            let min_len = parse_u64_bound(field, "minLength")?;
            let max_len = parse_u64_bound(field, "maxLength")?;
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
                    || min_len.is_some_and(|m| n < m)
                    || max_len.is_some_and(|m| n > m)
                {
                    return Err(());
                }
                let options = normalized_options(field);
                let is_declared = options.iter().any(|o| o.value == selected_text);
                if (from_custom && is_declared) || (!from_custom && !is_declared) {
                    return Err(());
                }
                return Ok(Some(json!(selected_text)));
            }
            let effective = if field["hidden"] == true && text.is_empty() {
                d.hidden_value.as_deref().unwrap_or("")
            } else {
                text
            };
            if effective.is_empty() && field["required"] != true {
                return Ok(None);
            }
            let n = effective.encode_utf16().count() as u64;
            if (field["required"] == true && effective.is_empty())
                || min_len.is_some_and(|m| n < m)
                || max_len.is_some_and(|m| n > m)
            {
                return Err(());
            }
            Ok(Some(json!(effective)))
        }
        Some("number" | "integer") => {
            let minimum = parse_f64_bound(field, "minimum")?;
            let maximum = parse_f64_bound(field, "maximum")?;
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
                || minimum.is_some_and(|m| n < m)
                || maximum.is_some_and(|m| n > m)
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
            let min_items = parse_u64_bound(field, "minItems")?;
            let max_items = parse_u64_bound(field, "maxItems")?;
            let options = normalized_options(field);
            let is_declared = |entry: &str| options.iter().any(|o| o.value == entry);
            let mut values = d.selected.clone();
            if field["custom"] == true {
                for item in &d.preserved_custom {
                    if !d.preserved_custom_selected.contains(item) {
                        continue;
                    }
                    if item.encode_utf16().count() > 20_000 {
                        return Err(());
                    }
                    if !item.is_empty() && !is_declared(item) {
                        values.insert(item.clone());
                    }
                }
                values.extend(
                    d.custom
                        .text
                        .lines()
                        .map(str::trim)
                        .filter(|v| !v.is_empty() && !is_declared(v))
                        .map(str::to_string),
                );
            }
            if values
                .iter()
                .any(|item| item.encode_utf16().count() > 20_000)
            {
                return Err(());
            }
            let count = values.len() as u64;
            if count > 32
                || (field["required"] == true && count == 0)
                || min_items.is_some_and(|m| count < m)
                || max_items.is_some_and(|m| count > m)
            {
                return Err(());
            }
            if field["options"].as_array().is_some()
                && d.selected.iter().any(|value| !is_declared(value))
            {
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
