//! Editable Form drafts and native conditional answer construction.
use crate::agent_api::Form;
use rune::edit::TextEdit;
use serde_json::{Value, json};
use std::cell::Cell;
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NormalizedOption<'a> {
    pub value: &'a str,
    pub label: Option<&'a str>,
    pub description: Option<&'a str>,
}

/// Normalize form options once for rendering, focus resolution, and validation:
/// enforce the 64-option bound, skip empty values on scalar string choices (while
/// preserving explicitly declared empty multiselect values), deduplicate by exact
/// value (preserving first), and keep only authored non-blank labels so raw protocol
/// values never leak into copy.
pub fn normalized_options(field: &Value) -> Vec<NormalizedOption<'_>> {
    let Some(options) = field["options"].as_array() else {
        return Vec::new();
    };
    let allow_empty = field["type"] == "multiselect";
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for option in options.iter().take(64) {
        let Some(value) = option["value"].as_str() else {
            continue;
        };
        if (!allow_empty && value.is_empty()) || !seen.insert(value) {
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
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()).map(Some).ok_or(()),
        Some(Value::String(s)) => match s.as_str() {
            "Infinity" => Ok(Some(f64::INFINITY)),
            "-Infinity" => Ok(Some(f64::NEG_INFINITY)),
            _ => Err(()),
        },
        Some(_) => Err(()),
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
            field["required"] == true && {
                let min = parse_f64_bound(field, "minimum").ok().flatten();
                let max = parse_f64_bound(field, "maximum").ok().flatten();
                min == Some(f64::INFINITY)
                    || max == Some(f64::NEG_INFINITY)
                    || matches!((min, max), (Some(a), Some(b)) if a > b)
            }
        }
        Some("integer") => {
            field["required"] == true && {
                let min = parse_f64_bound(field, "minimum").ok().flatten();
                let max = parse_f64_bound(field, "maximum").ok().flatten();
                min == Some(f64::INFINITY)
                    || max == Some(f64::NEG_INFINITY)
                    || matches!((min, max), (Some(a), Some(b)) if a.ceil() > b.floor())
            }
        }
        _ => false,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ValidationError {
    Unsupported,
    Required,
    SelectDeclaredOption,
    DuplicateCustomOption,
    TooShort { min: u64 },
    TooLong { max: u64 },
    NotNumber,
    NotInteger,
    BelowMin { min: f64 },
    AboveMax { max: f64 },
    TooFewItems { min: u64 },
    TooManyItems { max: u64 },
}

fn remove_promoted_lines(edit: &mut TextEdit, mut should_remove: impl FnMut(&str) -> bool) -> bool {
    let text = edit.text.as_str();
    let bytes = text.as_bytes();
    let mut lines: Vec<(usize, usize, usize, bool)> = Vec::new();
    let mut pos = 0;
    while pos < bytes.len() {
        let start = pos;
        while pos < bytes.len() && bytes[pos] != b'\n' {
            pos += 1;
        }
        let content_end = if pos > start && bytes[pos - 1] == b'\r' {
            pos - 1
        } else {
            pos
        };
        let full_end = if pos < bytes.len() && bytes[pos] == b'\n' {
            pos + 1
        } else {
            pos
        };
        let trimmed = text[start..content_end].trim();
        let remove = !trimmed.is_empty() && should_remove(trimmed);
        lines.push((start, content_end, full_end, remove));
        pos = full_end;
    }
    if !lines.iter().any(|&(_, _, _, remove)| remove) {
        return false;
    }
    // Delete only the byte spans of promoted lines (never rebuilding or dropping a trailing
    // newline on kept lines), and merge adjacent deletions before remapping selection offsets.
    let mut deletions: Vec<(usize, usize)> = Vec::new();
    for (idx, &(start, content_end, full_end, remove)) in lines.iter().enumerate() {
        if !remove {
            continue;
        }
        let del_start = if full_end > content_end {
            start
        } else if idx > 0 && !lines[idx - 1].3 {
            // Removing the final line (without a trailing newline) also removes the newline
            // separating it from the immediately preceding kept line.
            lines[idx - 1].1
        } else {
            start
        };
        let del_end = full_end;
        if let Some(last) = deletions.last_mut()
            && del_start <= last.1
        {
            last.1 = last.1.max(del_end);
        } else {
            deletions.push((del_start, del_end));
        }
    }
    let mut new_text = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for &(ds, de) in &deletions {
        new_text.push_str(&text[cursor..ds]);
        cursor = de;
    }
    new_text.push_str(&text[cursor..]);
    let map_pos = |old: usize| -> usize {
        let mut removed = 0usize;
        for &(ds, de) in &deletions {
            if old <= ds {
                break;
            }
            if old < de {
                return ds - removed;
            }
            removed += de - ds;
        }
        old - removed
    };
    let next_anchor = map_pos(edit.anchor).min(new_text.len());
    let next_focus = map_pos(edit.focus).min(new_text.len());
    edit.text = new_text;
    edit.anchor = next_anchor;
    edit.focus = next_focus;
    true
}

fn strip_leaked_choice_default(field: &Value, next: &mut Draft, provenance: &BTreeSet<String>) {
    if field["hidden"] == true || provenance.is_empty() {
        return;
    }
    if let Some(raw) = field["default"].as_str()
        && provenance.contains(raw)
    {
        if next.edit.text == raw {
            next.edit = TextEdit::new("");
            next.edit_baseline.clear();
        }
        if next.custom.text == raw {
            next.custom = TextEdit::new("");
            next.custom_baseline.clear();
        }
    }
    if field["type"] == "multiselect" {
        next.preserved_custom
            .retain(|item| !provenance.contains(item));
        next.preserved_custom_selected
            .retain(|item| !provenance.contains(item));
        if !next.custom.text.is_empty()
            && remove_promoted_lines(&mut next.custom, |trimmed| provenance.contains(trimmed))
        {
            next.custom_baseline = next.custom.text.clone();
        }
    }
}

fn collect_choice_provenance(draft: &mut Draft) -> BTreeSet<String> {
    let mut provenance = std::mem::take(&mut draft.prior_choice_values);
    if matches!(
        draft.kind,
        Some(FieldKind::StringOptions | FieldKind::Multiselect)
    ) {
        if let Some(prev_opts) = draft.declared_options.take() {
            provenance.extend(prev_opts);
        }
        if let Some(prev_choice) = draft.choice.take() {
            provenance.insert(prev_choice);
        }
        provenance.extend(draft.selected.iter().cloned());
    }
    provenance
}

pub struct Draft {
    pub edit: TextEdit,
    pub custom: TextEdit,
    pub edit_baseline: String,
    pub custom_baseline: String,
    pub choice: Option<String>,
    pub selected: BTreeSet<String>,
    pub preserved_custom: Vec<String>,
    pub preserved_custom_selected: BTreeSet<String>,
    pub hidden_multiselect: Vec<String>,
    pub hidden_multiselect_invalid: bool,
    pub declared_options: Option<BTreeSet<String>>,
    pub prior_choice_values: BTreeSet<String>,
    pub hidden_value: Option<String>,
    pub hidden_only: bool,
    pub kind: Option<FieldKind>,
    pub dirty: bool,
    pub text_dirty: Cell<bool>,
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
            self.custom_baseline.clear();
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
        if self.edit.text != self.edit_baseline {
            self.text_dirty.set(true);
        }
        &mut self.edit
    }
    pub fn custom_editor(&mut self) -> &mut TextEdit {
        if self.custom.text != self.custom_baseline {
            self.text_dirty.set(true);
        }
        if !self.custom.text.is_empty() {
            self.choice = None;
        }
        &mut self.custom
    }
    pub fn is_dirty(&self) -> bool {
        if self.edit.text != self.edit_baseline || self.custom.text != self.custom_baseline {
            self.text_dirty.set(true);
        }
        self.dirty || self.text_dirty.get()
    }
}
impl Default for Draft {
    fn default() -> Self {
        Self {
            edit: TextEdit::new(""),
            custom: TextEdit::new(""),
            edit_baseline: String::new(),
            custom_baseline: String::new(),
            choice: None,
            selected: BTreeSet::new(),
            preserved_custom: Vec::new(),
            preserved_custom_selected: BTreeSet::new(),
            hidden_multiselect: Vec::new(),
            hidden_multiselect_invalid: false,
            declared_options: None,
            prior_choice_values: BTreeSet::new(),
            hidden_value: None,
            hidden_only: false,
            kind: None,
            dirty: false,
            text_dirty: Cell::new(false),
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
    let hidden = field["hidden"] == true;
    let mut d = Draft {
        kind: Some(field_kind(field)),
        declared_options: declared.clone(),
        hidden_only: hidden,
        ..Default::default()
    };
    let value = &field["default"];
    if field["type"] == "multiselect" {
        if let Some(opts) = &declared {
            d.prior_choice_values.extend(opts.iter().cloned());
        }
        if hidden {
            if let Some(values) = value.as_array() {
                let allowed = normalized_options(field);
                for entry in values {
                    if let Some(raw) = entry.as_str() {
                        if allowed.iter().any(|opt| opt.value == raw) {
                            d.prior_choice_values.insert(raw.to_string());
                        }
                        d.hidden_multiselect.push(raw.to_string());
                    } else {
                        d.hidden_multiselect_invalid = true;
                    }
                }
            } else if !value.is_null() {
                d.hidden_multiselect_invalid = true;
            }
        } else if let Some(values) = value.as_array() {
            let allowed = normalized_options(field);
            let allow_custom = field["custom"] == true;
            let mut seen = HashSet::new();
            let mut editable_custom = Vec::new();
            for raw in values.iter().filter_map(Value::as_str) {
                let is_declared = allowed.iter().any(|opt| opt.value == raw);
                if is_declared {
                    d.selected.insert(raw.to_string());
                    d.prior_choice_values.insert(raw.to_string());
                } else if allow_custom && !raw.is_empty() && seen.insert(raw.to_string()) {
                    if !is_line_editable_custom(raw) {
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
            } else if hidden {
                d.hidden_value = Some(raw.to_string());
            } else if field["custom"] == true {
                d.custom = TextEdit::new(raw);
            }
        }
    } else if matches!(field["type"].as_str(), Some("number" | "integer")) {
        if let Some(n) = value.as_f64().filter(|n| n.is_finite()) {
            let formatted = value.to_string();
            if hidden {
                d.hidden_value = Some(formatted);
            } else {
                let _ = n;
                d.edit = TextEdit::new(formatted);
            }
        }
    } else if field["type"] == "string" {
        if let Some(raw) = value.as_str() {
            if hidden {
                d.hidden_value = Some(raw.to_string());
            } else {
                d.edit = TextEdit::new(raw);
            }
        }
    } else if !value.is_null() {
        let formatted = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        if hidden {
            d.hidden_value = Some(formatted);
        } else {
            d.edit = TextEdit::new(formatted);
        }
    } else if field["type"] == "boolean" && !hidden {
        d.edit = TextEdit::new("false");
    }
    d.edit_baseline = d.edit.text.clone();
    d.custom_baseline = d.custom.text.clone();
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
            let hidden = field["hidden"] == true;
            let draft_empty = draft.edit.text.is_empty()
                && draft.custom.text.is_empty()
                && draft.choice.is_none()
                && draft.selected.is_empty()
                && draft.preserved_custom_selected.is_empty();
            // Fields seeded while hidden, or untouched/empty visible fields that become hidden,
            // reseed cleanly from the current schema while preserving lifetime choice provenance
            // and never leaking hidden defaults into visible editors.
            if draft.hidden_only || (hidden && (!draft.is_dirty() || draft_empty)) {
                let choice_provenance = collect_choice_provenance(draft);
                let mut next = fresh_draft(field);
                strip_leaked_choice_default(field, &mut next, &choice_provenance);
                next.prior_choice_values.extend(choice_provenance);
                *draft = next;
                continue;
            }
            // Reseed incompatible drafts on field-kind transitions, carry choice provenance across
            // the field's lifetime, and keep hidden protocol defaults separate from display copy.
            if let Some(prev) = draft.kind
                && prev != kind
            {
                let choice_provenance = collect_choice_provenance(draft);
                match (prev, kind) {
                    (FieldKind::StringOptions, FieldKind::StringFree) => {
                        let authored = std::mem::take(&mut draft.custom.text);
                        if !authored.is_empty() {
                            draft.edit = TextEdit::new(authored);
                            draft.edit_baseline = draft.edit.text.clone();
                            draft.custom = TextEdit::new("");
                            draft.custom_baseline.clear();
                            draft.selected.clear();
                            draft.preserved_custom.clear();
                            draft.preserved_custom_selected.clear();
                            draft.hidden_multiselect.clear();
                            draft.hidden_multiselect_invalid = false;
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
                            next.edit_baseline.clear();
                            if hidden {
                                next.hidden_value = Some(raw.to_string());
                            }
                        }
                        next.prior_choice_values.extend(choice_provenance);
                        *draft = next;
                        continue;
                    }
                    (FieldKind::StringFree, FieldKind::StringOptions) => {
                        if !draft.is_dirty() && draft.edit.text.is_empty() {
                            let mut next = fresh_draft(field);
                            strip_leaked_choice_default(field, &mut next, &choice_provenance);
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
                        strip_leaked_choice_default(field, &mut next, &choice_provenance);
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
                if let Some(opts) = &current_options {
                    draft.prior_choice_values.extend(opts.iter().cloned());
                }
                if !draft.edit.text.is_empty() {
                    draft.edit = TextEdit::new("");
                    draft.edit_baseline.clear();
                }
                draft.choice = None;
                let allowed = normalized_options(field);
                let allow_custom = field["custom"] == true;
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
                for item in std::mem::take(&mut draft.preserved_custom) {
                    let was_selected = draft.preserved_custom_selected.contains(&item);
                    if is_newly_declared(&item) {
                        if was_selected {
                            draft.selected.insert(item);
                        }
                    } else if allowed.iter().any(|opt| opt.value == item.as_str()) {
                        // Already declared: declared checkboxes own its selection state.
                    } else if allow_custom {
                        if was_selected {
                            remaining_preserved_selected.insert(item.clone());
                        }
                        remaining_preserved.push(item);
                    }
                }
                draft.preserved_custom = remaining_preserved;
                draft.preserved_custom_selected = remaining_preserved_selected;
                if !draft.custom.text.is_empty() {
                    // Promote newly declared custom lines first, then discard any remaining
                    // custom text when custom input is disabled.
                    let mut newly_selected = Vec::new();
                    let was_dirty = draft.is_dirty();
                    if remove_promoted_lines(&mut draft.custom, |trimmed| {
                        if is_newly_declared(trimmed) {
                            newly_selected.push(trimmed.to_string());
                            true
                        } else {
                            false
                        }
                    }) {
                        draft.custom_baseline = draft.custom.text.clone();
                        if was_dirty {
                            draft.text_dirty.set(true);
                        }
                    }
                    draft.selected.extend(newly_selected);
                    if !allow_custom && !draft.custom.text.is_empty() {
                        draft.custom = TextEdit::new("");
                        draft.custom_baseline.clear();
                    }
                }
            } else if kind == FieldKind::StringOptions {
                draft.selected.clear();
                draft.preserved_custom.clear();
                draft.preserved_custom_selected.clear();
                draft.hidden_multiselect.clear();
                draft.hidden_multiselect_invalid = false;
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
                    draft.edit_baseline.clear();
                    if allowed.iter().any(|opt| opt.value == prior.as_str()) {
                        draft.choice = Some(prior);
                        if !draft.custom.text.is_empty() {
                            draft.custom = TextEdit::new("");
                            draft.custom_baseline.clear();
                        }
                    } else if allow_custom && draft.custom.text.is_empty() {
                        draft.custom = TextEdit::new(prior);
                        draft.custom_baseline = draft.custom.text.clone();
                    }
                }
                if !draft.custom.text.is_empty() {
                    if is_newly_declared(draft.custom.text.as_str()) {
                        draft.choice = Some(draft.custom.text.clone());
                        draft.custom = TextEdit::new("");
                        draft.custom_baseline.clear();
                    } else if !allow_custom {
                        draft.custom = TextEdit::new("");
                        draft.custom_baseline.clear();
                    }
                }
            } else {
                draft.selected.clear();
                draft.preserved_custom.clear();
                draft.preserved_custom_selected.clear();
                draft.hidden_multiselect.clear();
                draft.hidden_multiselect_invalid = false;
                draft.choice = None;
                if kind == FieldKind::StringFree {
                    if !hidden {
                        draft.hidden_value = None;
                    } else if draft.edit.text.is_empty() {
                        draft.hidden_value = field["default"].as_str().map(str::to_string);
                    }
                    if draft.edit.text.is_empty() && !draft.custom.text.is_empty() {
                        draft.edit = TextEdit::new(&draft.custom.text);
                        draft.edit_baseline = draft.edit.text.clone();
                    }
                } else if hidden && draft.edit.text.is_empty() {
                    let seeded = fresh_draft(field);
                    draft.hidden_value = seeded.hidden_value;
                } else {
                    draft.hidden_value = None;
                }
                if !draft.custom.text.is_empty() {
                    draft.custom = TextEdit::new("");
                    draft.custom_baseline.clear();
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
pub fn validate(field: &Value, d: &Draft) -> Result<Option<Value>, ValidationError> {
    if !valid_options_shape(field) || !valid_bounds(field) {
        return Err(ValidationError::Unsupported);
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
        return Err(ValidationError::TooLong { max: 20_000 });
    }
    match field["type"].as_str() {
        Some("string") => {
            let min_len =
                parse_u64_bound(field, "minLength").map_err(|()| ValidationError::Unsupported)?;
            let max_len =
                parse_u64_bound(field, "maxLength").map_err(|()| ValidationError::Unsupported)?;
            if has_declared_options(field) {
                if !text.is_empty() {
                    return Err(ValidationError::Unsupported);
                }
                let allow_custom = field["custom"] == true;
                let custom_text = if field["hidden"] == true && d.custom.text.is_empty() {
                    d.hidden_value.as_deref().unwrap_or("")
                } else {
                    d.custom.text.as_str()
                };
                if !allow_custom && !custom_text.is_empty() {
                    return Err(ValidationError::Unsupported);
                }
                let (selected_text, from_custom) = if allow_custom && !custom_text.is_empty() {
                    (custom_text, true)
                } else {
                    (d.choice.as_deref().unwrap_or(""), false)
                };
                if selected_text.is_empty() {
                    return if field["required"] == true {
                        Err(ValidationError::Required)
                    } else {
                        Ok(None)
                    };
                }
                let options = normalized_options(field);
                let is_declared = options.iter().any(|o| o.value == selected_text);
                if (from_custom && is_declared) || (!from_custom && !is_declared) {
                    return Err(ValidationError::SelectDeclaredOption);
                }
                let n = selected_text.encode_utf16().count() as u64;
                if let Some(m) = min_len
                    && n < m
                {
                    return Err(ValidationError::TooShort { min: m });
                }
                if let Some(m) = max_len
                    && n > m
                {
                    return Err(ValidationError::TooLong { max: m });
                }
                return Ok(Some(json!(selected_text)));
            }
            let effective = if field["hidden"] == true && text.is_empty() {
                d.hidden_value.as_deref().unwrap_or("")
            } else {
                text
            };
            if effective.is_empty() {
                return if field["required"] == true {
                    Err(ValidationError::Required)
                } else {
                    Ok(None)
                };
            }
            let n = effective.encode_utf16().count() as u64;
            if let Some(m) = min_len
                && n < m
            {
                return Err(ValidationError::TooShort { min: m });
            }
            if let Some(m) = max_len
                && n > m
            {
                return Err(ValidationError::TooLong { max: m });
            }
            Ok(Some(json!(effective)))
        }
        Some("number" | "integer") => {
            let minimum =
                parse_f64_bound(field, "minimum").map_err(|()| ValidationError::Unsupported)?;
            let maximum =
                parse_f64_bound(field, "maximum").map_err(|()| ValidationError::Unsupported)?;
            let effective = if field["hidden"] == true && text.is_empty() {
                d.hidden_value.as_deref().unwrap_or("")
            } else {
                text
            };
            if effective.trim().is_empty() {
                return if field["required"] == true {
                    Err(ValidationError::Required)
                } else {
                    Ok(None)
                };
            }
            let n = effective
                .parse::<f64>()
                .map_err(|_| ValidationError::NotNumber)?;
            if !n.is_finite() {
                return Err(ValidationError::NotNumber);
            }
            if field["type"] == "integer" && n.fract() != 0.0 {
                return Err(ValidationError::NotInteger);
            }
            if let Some(m) = minimum
                && n < m
            {
                return Err(ValidationError::BelowMin { min: m });
            }
            if let Some(m) = maximum
                && n > m
            {
                return Err(ValidationError::AboveMax { max: m });
            }
            Ok(Some(json!(n)))
        }
        Some("boolean") => {
            let effective = if field["hidden"] == true && text.is_empty() {
                d.hidden_value.as_deref().unwrap_or("")
            } else {
                text
            };
            match effective {
                "true" => Ok(Some(json!(true))),
                "false" => Ok(Some(json!(false))),
                _ => {
                    if field["required"] == true {
                        Err(ValidationError::Required)
                    } else {
                        Ok(None)
                    }
                }
            }
        }
        Some("multiselect") => {
            let min_items =
                parse_u64_bound(field, "minItems").map_err(|()| ValidationError::Unsupported)?;
            let max_items =
                parse_u64_bound(field, "maxItems").map_err(|()| ValidationError::Unsupported)?;
            let options = normalized_options(field);
            let is_declared = |entry: &str| options.iter().any(|o| o.value == entry);
            let allow_custom = field["custom"] == true;
            let mut values = BTreeSet::new();
            if field["hidden"] == true && d.hidden_only {
                if d.hidden_multiselect_invalid {
                    return Err(ValidationError::Unsupported);
                }
                for item in &d.hidden_multiselect {
                    if item.encode_utf16().count() > 20_000 {
                        return Err(ValidationError::TooLong { max: 20_000 });
                    }
                    if is_declared(item) {
                        values.insert(item.clone());
                    } else if allow_custom {
                        if !item.is_empty() {
                            values.insert(item.clone());
                        }
                    } else {
                        return Err(ValidationError::SelectDeclaredOption);
                    }
                }
            } else {
                values = d.selected.clone();
                if allow_custom {
                    for item in &d.preserved_custom {
                        if !d.preserved_custom_selected.contains(item) {
                            continue;
                        }
                        if item.encode_utf16().count() > 20_000 {
                            return Err(ValidationError::TooLong { max: 20_000 });
                        }
                        if !item.is_empty() && !is_declared(item) {
                            values.insert(item.clone());
                        }
                    }
                    for line in d.custom.text.lines() {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if is_declared(trimmed) {
                            return Err(ValidationError::DuplicateCustomOption);
                        }
                        values.insert(trimmed.to_string());
                    }
                }
            }
            if values
                .iter()
                .any(|item| item.encode_utf16().count() > 20_000)
            {
                return Err(ValidationError::TooLong { max: 20_000 });
            }
            if field["options"].as_array().is_some()
                && d.selected.iter().any(|value| !is_declared(value))
            {
                return Err(ValidationError::SelectDeclaredOption);
            }
            let count = values.len() as u64;
            if count > 32 {
                return Err(ValidationError::TooManyItems { max: 32 });
            }
            if let Some(m) = max_items
                && count > m
            {
                return Err(ValidationError::TooManyItems { max: m });
            }
            if let Some(m) = min_items
                && count < m
            {
                return Err(ValidationError::TooFewItems { min: m });
            }
            if field["required"] == true && count == 0 {
                return Err(ValidationError::Required);
            }
            Ok(Some(json!(values)))
        }
        _ => Err(ValidationError::Unsupported),
    }
}

pub fn visible_validation_error(field: &Value, d: &Draft) -> Option<ValidationError> {
    let Err(err) = validate(field, d) else {
        return None;
    };
    if !d.is_dirty() {
        if err == ValidationError::Required {
            return None;
        }
        if matches!(err, ValidationError::TooFewItems { .. })
            && d.selected.is_empty()
            && d.preserved_custom_selected.is_empty()
            && d.custom.text.trim().is_empty()
        {
            return None;
        }
    }
    Some(err)
}

pub fn value(field: &Value, d: &Draft) -> Result<Option<Value>, ()> {
    validate(field, d).map_err(|_| ())
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
