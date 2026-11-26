//! JSONC `plugins` document editing (`opencode/plugin-control-document.ts` and
//! `opencode/plugin-source-document.ts`): parses `plugins`, appends rules/sources preserving
//! comments/BOM/EOL/indentation, and deletes targeted entries with deep-equality verification.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::subagent_depth::{
    document::{DocError, Document, R},
    jsonc::{self, Edit, Formatting, J, Kind, NodeType, Scanner, Seg, Text, edit, slice, utf16},
};

const BOM: u16 = 0xfeff;

#[derive(Clone, Debug)]
pub(super) enum PluginConfigEntry {
    Str(String),
    Obj { package: String, options: Option<J> },
}

impl PluginConfigEntry {
    pub(super) fn target(&self) -> &str {
        match self {
            Self::Str(s) => s,
            Self::Obj { package, .. } => package,
        }
    }

    pub(super) fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(s) => Some(s),
            Self::Obj { .. } => None,
        }
    }

    pub(super) fn has_options(&self) -> bool {
        matches!(self, Self::Obj { options: Some(_), .. })
    }
}

impl PartialEq for PluginConfigEntry {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Str(a), Self::Str(b)) => a == b,
            (Self::Obj { package: pa, options: oa }, Self::Obj { package: pb, options: ob }) => pa == pb && oa == ob,
            _ => false,
        }
    }
}

pub(super) fn json_to_j(value: &Value) -> J {
    match value {
        Value::Null => J::Null,
        Value::Bool(b) => J::Bool(*b),
        Value::Number(n) => J::Num(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => J::s(s),
        Value::Array(items) => J::Arr(items.iter().map(json_to_j).collect()),
        Value::Object(map) => J::Obj(map.iter().map(|(k, v)| (utf16(k), json_to_j(v))).collect()),
    }
}

pub(super) fn normalize_plugin_entries(input: Option<&Value>) -> Vec<PluginConfigEntry> {
    let Some(items) = input.and_then(Value::as_array) else { return Vec::new() };
    let mut output = Vec::new();
    for entry in items {
        if let Some(s) = entry.as_str() {
            output.push(PluginConfigEntry::Str(s.to_owned()));
        } else if let Some(obj) = entry.as_object()
            && let Some(package) = obj.get("package").and_then(Value::as_str)
        {
            let options = obj.get("options").filter(|v| v.is_object()).map(json_to_j);
            output.push(PluginConfigEntry::Obj { package: package.to_owned(), options });
        }
    }
    output
}

/// Reads the already-validated `plugins` array from a decoded `Document`.
pub(super) fn document_plugins(doc: &Document) -> R<Vec<PluginConfigEntry>> {
    let (Some(root), false) = jsonc::parse(&doc.text, true) else {
        return Err(DocError::Invalid("OpenCode configuration is malformed"));
    };
    let Some(J::Arr(items)) = root.get("plugins") else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(items.len());
    for entry in items {
        match entry {
            J::Str(s) => {
                let s = jsonc::string(s);
                if s.is_empty() || s == "-" {
                    return Err(DocError::Invalid("OpenCode plugin entry is invalid"));
                }
                out.push(PluginConfigEntry::Str(s));
            }
            J::Obj(_) => {
                let Some(J::Str(pkg)) = entry.get("package") else {
                    return Err(DocError::Invalid("OpenCode plugin source is invalid"));
                };
                let package = jsonc::string(pkg);
                if package.is_empty() {
                    return Err(DocError::Invalid("OpenCode plugin source is invalid"));
                }
                let options = match entry.get("options") {
                    None => None,
                    Some(opt) if opt.is_obj() => Some(opt.clone()),
                    Some(_) => return Err(DocError::Invalid("OpenCode plugin options must be an object")),
                };
                out.push(PluginConfigEntry::Obj { package, options });
            }
            _ => return Err(DocError::Invalid("OpenCode plugin source is invalid")),
        }
    }
    Ok(out)
}

pub(super) fn contains_config_variable_entry(entry: &PluginConfigEntry) -> bool {
    match entry {
        PluginConfigEntry::Str(s) => has_config_var_str(s),
        PluginConfigEntry::Obj { package, options } => {
            has_config_var_str(package) || options.as_ref().is_some_and(has_config_var_j)
        }
    }
}

fn has_config_var_str(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            let rest = &s[i + 1..];
            let prefix_len = if rest.starts_with("env:") {
                Some(4)
            } else if rest.starts_with("file:") {
                Some(5)
            } else {
                None
            };
            if let Some(len) = prefix_len {
                let after = &rest[len..];
                if let Some(close) = after.find('}')
                    && close > 0
                {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

fn has_config_var_j(v: &J) -> bool {
    match v {
        J::Str(s) => has_config_var_str(&jsonc::string(s)),
        J::Arr(items) => items.iter().any(has_config_var_j),
        J::Obj(pairs) => pairs.iter().any(|(_, val)| has_config_var_j(val)),
        _ => false,
    }
}

fn infer_formatting(text: &[u16]) -> Formatting {
    let eol = jsonc::eol_of(text).to_vec();
    let indent = jsonc::first_indent(text).unwrap_or_else(|| utf16("  "));
    let has_tab = indent.contains(&9);
    Formatting { eol, insert_spaces: !has_tab, tab_size: if has_tab { 1 } else { indent.len().max(1) } }
}

fn finish(doc: &Document, mut updated: Text, eol: &[u16]) -> Text {
    if !jsonc::ends_with_lf(&updated) {
        updated.extend_from_slice(eol);
    }
    if doc.bom {
        updated.insert(0, BOM);
    }
    updated
}

fn find_plugins_array(tree: &jsonc::Tree) -> Option<usize> {
    let root = tree.root?;
    let key = utf16("plugins");
    let prop = tree.node(root).children.iter().copied().find(|p| tree.key_of(*p) == Some(&key))?;
    let val = *tree.node(prop).children.get(1)?;
    (tree.node(val).kind == NodeType::Array).then_some(val)
}

fn has_plugins_property(text: &[u16]) -> bool {
    let tree = jsonc::parse_tree(text, true);
    let Some(root) = tree.root else { return false };
    let key = utf16("plugins");
    tree.node(root).children.iter().any(|p| tree.key_of(*p) == Some(&key))
}

fn line_start(text: &[u16], offset: i64) -> i64 {
    if offset <= 0 {
        return 0;
    }
    let from = (offset - 1).min(text.len() as i64 - 1);
    (0..=from).rev().find(|&i| text[i as usize] == 10).map_or(0, |i| i + 1)
}

fn index_of_lf(text: &[u16], from: i64) -> Option<i64> {
    let start = from.max(0) as usize;
    text.get(start..)?.iter().position(|&c| c == 10).map(|rel| (start + rel) as i64)
}

fn is_horizontal_ws(slice: &[u16]) -> bool {
    slice.iter().all(|&c| c == 32 || c == 9)
}

fn is_blank_line_tail(slice: &[u16]) -> bool {
    slice.iter().all(|&c| c == 32 || c == 9 || c == 13)
}

/// Checks if `tail` (between element end and `\n`) matches `/^([ \t]*,)?[ \t]*\/\/[^\r\n]*\r?$/`,
/// returning `Some(has_comma)`.
fn trailing_line_comment(tail: &[u16]) -> Option<bool> {
    let mut i = 0;
    while i < tail.len() && (tail[i] == 32 || tail[i] == 9) {
        i += 1;
    }
    let has_comma = tail.get(i) == Some(&44);
    if has_comma {
        i += 1;
        while i < tail.len() && (tail[i] == 32 || tail[i] == 9) {
            i += 1;
        }
    }
    if tail.get(i) == Some(&47) && tail.get(i + 1) == Some(&47) {
        let rest = &tail[i + 2..];
        let trimmed = rest.strip_suffix(&[13]).unwrap_or(rest);
        if !trimmed.contains(&13) && !trimmed.contains(&10) {
            return Some(has_comma);
        }
    }
    None
}

fn append_plugin_entry(text: &[u16], index: usize, rule: &str, options: &Formatting) -> R<Text> {
    let tree = jsonc::parse_tree(text, true);
    let array_id = find_plugins_array(&tree)
        .ok_or(DocError::Invalid("Unable to update OpenCode plugins without replacing the document"))?;
    let array = tree.node(array_id);

    if let Some(&last_id) = array.children.last() {
        let last = tree.node(last_id);
        let end = last.offset + last.length;
        // Trailing inline comment right after the last element (`plugin-control-document.ts:161-172`).
        if let Some(line_end) = index_of_lf(text, end)
            && let Some(has_comma) = trailing_line_comment(slice(text, end, line_end))
        {
            let quoted = jsonc::stringify(&J::s(rule), None);
            let start = line_start(text, last.offset);
            let indent: Text =
                slice(text, start, last.offset).iter().take_while(|&&c| c == 32 || c == 9).copied().collect();
            let mut out = Vec::with_capacity(text.len() + quoted.len() + indent.len() + 8);
            out.extend_from_slice(slice(text, 0, end));
            if !has_comma {
                out.push(44);
            }
            out.extend_from_slice(slice(text, end, line_end + 1));
            out.extend_from_slice(&indent);
            out.extend_from_slice(&quoted);
            if has_comma {
                out.push(44);
            }
            out.extend_from_slice(&options.eol);
            out.extend_from_slice(slice(text, line_end + 1, i64::MAX));
            return Ok(out);
        }
    }

    let edits = jsonc::modify(text, &[Seg::Key(utf16("plugins")), Seg::Index(index as i64)], Some(J::s(rule)), options)
        .map_err(|_| DocError::Invalid("Unable to update OpenCode plugins without replacing the document"))?;
    jsonc::apply_edits(text, &edits)
        .ok_or(DocError::Invalid("Unable to update OpenCode plugins without replacing the document"))
}

/// Appends one string entry (activation rule or source spec) at the end of `plugins`.
pub(super) fn append_plugin_control_rule(doc: &Document, rule: &str) -> R<Text> {
    let plugins = document_plugins(doc)?;
    let options = infer_formatting(&doc.text);
    let updated = if !plugins.is_empty() || has_plugins_property(&doc.text) {
        append_plugin_entry(&doc.text, plugins.len(), rule, &options)?
    } else {
        let edits =
            jsonc::modify(&doc.text, &[Seg::Key(utf16("plugins"))], Some(J::Arr(vec![J::s(rule)])), &options)
                .map_err(|_| DocError::Invalid("Unable to update OpenCode plugins without replacing the document"))?;
        jsonc::apply_edits(&doc.text, &edits)
            .ok_or(DocError::Invalid("Unable to update OpenCode plugins without replacing the document"))?
    };
    let (Some(mut expected), false) = jsonc::parse(&doc.text, true) else {
        return Err(DocError::Invalid("Unable to update OpenCode plugins without changing other settings"));
    };
    let mut next_plugins = match expected.get("plugins").cloned() {
        Some(J::Arr(items)) => items,
        None => Vec::new(),
        Some(_) => return Err(DocError::Invalid("Unable to update OpenCode plugins without changing other settings")),
    };
    next_plugins.push(J::s(rule));
    expected.set(utf16("plugins"), J::Arr(next_plugins));
    let (result, errors) = jsonc::parse(&updated, true);
    if errors || result.as_ref() != Some(&expected) {
        return Err(DocError::Invalid("Unable to update OpenCode plugins without changing other settings"));
    }
    Ok(finish(doc, updated, &options.eol))
}

/// Port of `deletePluginEntries` (`plugin-control-document.ts:180-217`).
pub(super) fn delete_plugin_entries(text: &[u16], indexes: &[usize]) -> R<Text> {
    let tree = jsonc::parse_tree(text, true);
    let array_id = find_plugins_array(&tree)
        .ok_or(DocError::Invalid("Unable to update OpenCode plugins without replacing the document"))?;
    let children = &tree.node(array_id).children;
    let removed: BTreeSet<usize> = indexes.iter().copied().collect();
    if removed.iter().any(|&i| i >= children.len()) {
        return Err(DocError::Invalid("Unable to update OpenCode plugins without replacing the document"));
    }

    let mut scanner = Scanner::new(text);
    let mut commas: BTreeMap<usize, i64> = BTreeMap::new();
    let mut first = 0usize;
    while first < children.len() {
        if !removed.contains(&first) {
            first += 1;
            continue;
        }
        let mut last = first;
        while removed.contains(&(last + 1)) {
            last += 1;
        }
        let trailing = last == children.len() - 1 && first > 0;
        let shift = usize::from(trailing);
        for (index, &child_id) in children.iter().enumerate().take(last - shift + 1).skip(first - shift) {
            let node = tree.node(child_id);
            scanner.set_position((node.offset + node.length).max(0) as usize);
            let mut tok = scanner.scan();
            while tok.trivia() {
                tok = scanner.scan();
            }
            if tok == Kind::Comma {
                commas.insert(index, scanner.offset() as i64);
            }
        }
        first = last + 1;
    }

    let mut edits: Vec<Edit> = Vec::new();
    for &index in &removed {
        let node = tree.node(children[index]);
        let (offset, length) = (node.offset, node.length);
        let end = offset + length;
        let comma = commas.get(&index).copied();
        let start = line_start(text, offset);
        let line_end = index_of_lf(text, end);
        let can_remove_line = if let Some(le) = line_end {
            let line_tail = if let Some(c) = comma.filter(|&c| c < le) {
                [slice(text, end, c), slice(text, c + 1, le)].concat()
            } else {
                slice(text, end, le).to_vec()
            };
            is_horizontal_ws(slice(text, start, offset)) && is_blank_line_tail(&line_tail)
        } else {
            false
        };
        if can_remove_line && let Some(le) = line_end {
            edits.push(edit(start, le + 1 - start, Vec::new()));
            if comma.is_some_and(|c| c < le) {
                commas.remove(&index);
            }
        } else {
            edits.push(edit(offset, length, Vec::new()));
        }
    }
    for &comma_offset in commas.values() {
        edits.push(edit(comma_offset, 1, Vec::new()));
    }
    jsonc::apply_edits(text, &edits)
        .ok_or(DocError::Invalid("Unable to update OpenCode plugins without replacing the document"))
}

fn verify_plugins_mutation(
    original_text: &[u16],
    updated_text: &[u16],
    removed: &BTreeSet<usize>,
    appended: Option<&str>,
    mismatch_message: &'static str,
) -> R<()> {
    let (Some(mut expected), false) = jsonc::parse(original_text, true) else {
        return Err(DocError::Invalid(mismatch_message));
    };
    let Some(J::Arr(orig_plugins)) = expected.get("plugins").cloned() else {
        return Err(DocError::Invalid(mismatch_message));
    };
    let mut next_plugins: Vec<J> =
        orig_plugins.into_iter().enumerate().filter(|(i, _)| !removed.contains(i)).map(|(_, v)| v).collect();
    if let Some(rule) = appended {
        next_plugins.push(J::s(rule));
    }
    expected.set(utf16("plugins"), J::Arr(next_plugins));

    let (result, errors) = jsonc::parse(updated_text, true);
    if errors || result.as_ref() != Some(&expected) {
        return Err(DocError::Invalid(mismatch_message));
    }
    Ok(())
}

/// Port of `replacePluginControlRules` (`plugin-control-document.ts:118-155`).
pub(super) fn replace_plugin_control_rules(
    doc: &Document,
    remove_indexes: &[usize],
    expected: &[&str],
    rule: Option<&str>,
) -> R<Text> {
    let removed: BTreeSet<usize> = remove_indexes.iter().copied().collect();
    if removed.is_empty() {
        let Some(rule) = rule else {
            return Err(DocError::Invalid("OpenCode plugins edit is empty"));
        };
        return append_plugin_control_rule(doc, rule);
    }
    let plugins = document_plugins(doc)?;
    for &index in &removed {
        let Some(PluginConfigEntry::Str(entry)) = plugins.get(index) else {
            return Err(DocError::Conflict("OpenCode plugin entry changed since it was read"));
        };
        if !expected.iter().any(|exp| *exp == entry) {
            return Err(DocError::Conflict("OpenCode plugin entry changed since it was read"));
        }
    }
    let options = infer_formatting(&doc.text);
    let removed_vec: Vec<usize> = removed.iter().copied().collect();
    let mut updated = delete_plugin_entries(&doc.text, &removed_vec)?;
    if let Some(rule) = rule {
        updated = append_plugin_entry(&updated, plugins.len() - removed.len(), rule, &options)?;
    }
    verify_plugins_mutation(
        &doc.text,
        &updated,
        &removed,
        rule,
        "Unable to update OpenCode plugins without changing other settings",
    )?;
    Ok(finish(doc, updated, &options.eol))
}

/// Port of `removePluginSourceEntry` (`plugin-source-document.ts:114-137`).
pub(super) fn remove_plugin_source_entry(
    doc: &Document,
    entry_index: usize,
    target: &str,
    rule_indexes: &[usize],
    rule_expected: &[&str],
) -> R<Text> {
    let plugins = document_plugins(doc)?;
    let Some(entry) = plugins.get(entry_index) else {
        return Err(DocError::Conflict("OpenCode plugin entry changed since it was displayed"));
    };
    if entry.target() != target {
        return Err(DocError::Conflict("OpenCode plugin entry changed since it was displayed"));
    }
    for &index in rule_indexes {
        if index == entry_index {
            return Err(DocError::Conflict("OpenCode plugin entry changed since it was displayed"));
        }
        let Some(PluginConfigEntry::Str(s)) = plugins.get(index) else {
            return Err(DocError::Conflict("OpenCode plugin entry changed since it was displayed"));
        };
        if !rule_expected.iter().any(|exp| *exp == s) {
            return Err(DocError::Conflict("OpenCode plugin entry changed since it was displayed"));
        }
    }
    let mut removed: BTreeSet<usize> = rule_indexes.iter().copied().collect();
    removed.insert(entry_index);
    let options = infer_formatting(&doc.text);
    let removed_vec: Vec<usize> = removed.iter().copied().collect();
    let updated = delete_plugin_entries(&doc.text, &removed_vec)?;
    verify_plugins_mutation(
        &doc.text,
        &updated,
        &removed,
        None,
        "Unable to remove the OpenCode plugin entry without changing other settings",
    )?;
    Ok(finish(doc, updated, &options.eol))
}

/// Converts a `J` value back to `serde_json::Value` when needed for tests or comparisons.
#[allow(dead_code)]
pub(super) fn j_to_json(value: &J) -> Value {
    match value {
        J::Null => Value::Null,
        J::Bool(b) => Value::Bool(*b),
        J::Num(n) => {
            if n.is_finite() && n.fract() == 0.0 && (i64::MIN as f64..=i64::MAX as f64).contains(n) {
                Value::Number(serde_json::Number::from(*n as i64))
            } else {
                serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number)
            }
        }
        J::Str(s) => Value::String(jsonc::string(s)),
        J::Arr(items) => Value::Array(items.iter().map(j_to_json).collect()),
        J::Obj(pairs) => {
            let mut map = Map::new();
            for (k, v) in pairs {
                map.insert(jsonc::string(k), j_to_json(v));
            }
            Value::Object(map)
        }
    }
}
