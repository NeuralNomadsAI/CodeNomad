//! `native-experimental-settings.ts`, `experimental-layers.ts` and `subagent-nesting.ts`.

use crate::files::node_path::Style;
use crate::subagent_depth::document::{self as doc, DocError, Document, R};
use crate::subagent_depth::jsonc::{J, Seg, Text, utf16};
use serde_json::Value;

/// `samePath` of `experimental-layers.ts`.
pub fn same_layer(a: &str, b: &str) -> bool {
    Style::of(a).same(a, b)
}

pub fn path_of(entry: &Value) -> Option<&str> {
    entry["path"].as_str()
}
fn is(entry: &Value, kind: &str) -> bool {
    entry["type"] == kind
}
/// `entry.type === "document" && entry.info.experimental !== undefined` (a missing `info` throws).
pub fn experimental_of(entry: &Value) -> R<Option<J>> {
    if !is(entry, "document") {
        return Ok(None);
    }
    match entry.get("info") {
        None | Some(Value::Null) => Err(DocError::Plain),
        Some(info) => Ok(info.get("experimental").map(J::from_json)),
    }
}

/// `settings()`: the Missions keys of an `experimental` block, validated.
pub fn settings(value: Option<J>) -> R<J> {
    let Some(block) = value else { return Ok(J::Obj(vec![])) };
    if !block.is_obj() {
        return Err(DocError::Invalid("OpenCode experimental setting must be an object"));
    }
    let bad_bool = |k: &str| block.get(k).is_some_and(|v| !matches!(v, J::Bool(_)));
    let bad_depth = block.get("subagent_depth").is_some_and(|v| v.safe_integer().is_none_or(|n| n < 0.0));
    if bad_bool("automations") || bad_bool("schedules") || bad_depth {
        return Err(DocError::Invalid("Invalid Missions experimental setting"));
    }
    Ok(block)
}
/// `block.automations ?? block.schedules`.
pub fn automation(block: &J) -> Option<bool> {
    [block.get("automations"), block.get("schedules")].into_iter().flatten().find_map(|v| match v {
        J::Bool(b) => Some(*b),
        _ => None,
    })
}
fn read_mission(d: &Document) -> R<J> {
    let mut block = J::Obj(vec![]);
    for key in ["automations", "schedules", "subagent_depth"] {
        if let Some(v) = doc::read(d, &["experimental", key])? {
            block.set(utf16(key), v);
        }
    }
    settings(Some(block))
}
/// `nativeExperimentalTargetPosition(...).before`.
fn position(entries: &[Value], target: &str, directory: &str) -> R<usize> {
    let p = Style::of(target);
    let same = |a: &str, b: &str| p.fold(&p.normalize(a)) == p.fold(&p.normalize(b));
    let mut pos =
        entries.iter().position(|e| is(e, "document") && path_of(e).is_some_and(|x| !x.is_empty() && same(x, target)));
    if pos.is_none() {
        for (i, e) in entries.iter().enumerate() {
            if is(e, "directory") {
                // Node's `path.normalize` throws on a non-string path.
                let x = path_of(e).ok_or(DocError::Plain)?;
                if same(x, &p.dirname(target)) {
                    pos = Some(i);
                    break;
                }
            }
        }
    }
    let parent = p.dirname(target);
    if pos.is_none() && p.basename(&parent) == ".opencode" && same(&p.dirname(&parent), directory) {
        let ancestor = |root: &str| p.contains(root, directory);
        let mut last: Option<usize> = None;
        for (i, e) in entries.iter().enumerate() {
            let Some(x) = path_of(e).filter(|x| !x.is_empty()) else { continue };
            let dir = if is(e, "directory") { x.to_string() } else { p.dirname(x) };
            let root = if p.basename(&dir) == ".opencode" { p.dirname(&dir) } else { dir };
            if ancestor(&root) {
                last = Some(i + 1);
            }
        }
        pos = last.or_else(|| entries.iter().position(|e| is(e, "directory")).map(|g| g + 1));
    }
    pos.ok_or(DocError::Invalid("OpenCode configuration precedence is unknown"))
}
/// `inheritedMissionExperimental`: the validated block OpenCode reads below `target`.
pub fn inherited(entries: &[Value], target: &str, directory: &str) -> R<J> {
    let before = position(entries, target, directory)?;
    for entry in entries[..before.min(entries.len())].iter().rev() {
        if let Some(block) = experimental_of(entry)? {
            return settings(Some(block));
        }
    }
    Ok(J::Obj(vec![]))
}
/// `editMissionExperimental(document, "subagent_depth", value, inherited)` for the project scope.
pub fn edit_depth(d: &Document, value: Option<f64>, inherited: &J) -> R<Text> {
    let local = read_mission(d)?;
    let mut current = d.clone();
    let apply = |current: &mut Document, field: &str, next: Option<J>| -> R<()> {
        let updated = doc::edit_setting(current, &["experimental", field], next)?;
        current.text = if current.bom { updated[1..].to_vec() } else { updated };
        Ok(())
    };
    if automation(&local).is_none() && automation(inherited) == Some(true) {
        let block = doc::read(d, &["experimental"])?;
        if value.is_some() || block.is_some_and(|b| b.keys().iter().any(|k| k != "subagent_depth")) {
            apply(&mut current, "automations", Some(J::Bool(true)))?;
        }
    }
    apply(&mut current, "subagent_depth", value.map(J::Num))?;
    Ok(doc::remove_empty_object(&current, &["experimental"], &doc::no_properties)?
        .unwrap_or_else(|| doc::full(&current)))
}
/// `withoutRedundantExperimental`.
pub fn without_redundant(d: &Document, inherited: Option<bool>, removing: Option<&str>) -> R<Option<Text>> {
    doc::remove_empty_object(d, &["experimental"], &|value| {
        let properties: Vec<String> = value.keys().into_iter().filter(|k| Some(k.as_str()) != removing).collect();
        properties.is_empty()
            || inherited.is_some_and(|i| properties == ["media_blob"] && value.get("media_blob") == Some(&J::Bool(i)))
    })
}
/// `maskedBy(entries, target, false)`: the lower document whose `experimental` a new one in `target` hides.
pub fn masked_by(entries: &[Value], target: &str) -> Option<usize> {
    let p = Style::of(target);
    let own = entries.iter().position(|e| is(e, "document") && path_of(e).is_some_and(|x| same_layer(x, target)));
    let dir = entries
        .iter()
        .position(|e| is(e, "directory") && path_of(e).is_some_and(|x| same_layer(x, &p.dirname(target))));
    let order = own.map(|o| o as f64).or(dir.map(|d| d as f64 - 0.5)).unwrap_or(entries.len() as f64);
    let has = |e: &Value| is(e, "document") && e["info"].get("experimental").is_some();
    entries.iter().enumerate().filter(|(i, e)| (*i as f64) < order && has(e)).map(|(i, _)| i).last()
}

// ---- subagent-nesting.ts ----
pub const AGENT: &str = "general";
const MARKER: &str = "Added by CodeNomad with the project subagent depth; Inherit removes it";
const LEGACY_KEYS: [&str; 2] = ["subagent", "task"];
struct Location {
    keys: [&'static str; 2],
    legacy: bool,
}
const LOCATIONS: [Location; 3] = [
    Location { keys: ["agents", AGENT], legacy: false },
    Location { keys: ["mode", AGENT], legacy: true },
    Location { keys: ["agent", AGENT], legacy: true },
];
fn rule() -> J {
    J::obj(&[("action", J::s("subagent")), ("resource", J::s("*")), ("effect", J::s("allow"))])
}
fn legacy_rule() -> J {
    J::obj(&[("*", J::s("allow"))])
}
fn container(l: &Location) -> [&'static str; 3] {
    [l.keys[0], l.keys[1], if l.legacy { "permission" } else { "permissions" }]
}

/// JS non-Unicode case-insensitive canonicalization of one code unit.
fn canon(u: u16) -> u16 {
    let Some(c) = char::from_u32(u as u32) else { return u };
    let mut up = c.to_uppercase();
    match (up.next(), up.next()) {
        (Some(f), None) if (f as u32) <= 0xffff && !(u >= 128 && (f as u32) < 128) => f as u32 as u16,
        _ => u,
    }
}
fn glob(value: &[u16], pattern: &[u16], ignore_case: bool) -> bool {
    let eq = |a: u16, b: u16| a == b || ignore_case && canon(a) == canon(b);
    // dp[j]: pattern[..j] matches value[..i]
    let mut dp = vec![false; pattern.len() + 1];
    dp[0] = true;
    for j in 1..=pattern.len() {
        dp[j] = dp[j - 1] && pattern[j - 1] == 42;
    }
    for &v in value {
        let mut next = vec![false; pattern.len() + 1];
        for j in 1..=pattern.len() {
            next[j] = match pattern[j - 1] {
                42 => next[j - 1] || dp[j],
                63 => dp[j - 1],
                p => dp[j - 1] && eq(v, p),
            };
        }
        dp = next;
    }
    dp[pattern.len()]
}
/// OpenCode's whole-value wildcard as the reference reproduces it for display.
fn wildcard(value: &str, pattern: &str, ignore_case: bool) -> bool {
    let value: Text = utf16(&value.replace('\\', "/"));
    let pattern: Text = utf16(&pattern.replace('\\', "/"));
    if pattern.ends_with(&[32, 42]) {
        let prefix = &pattern[..pattern.len() - 2];
        return glob(&value, prefix, ignore_case) || glob(&value, &[prefix, &[32, 42]].concat(), ignore_case);
    }
    glob(&value, &pattern, ignore_case)
}
fn subagent_action(rule: &Value, ignore_case: bool) -> bool {
    rule["action"].as_str().is_some_and(|a| wildcard("subagent", a, ignore_case))
}
pub fn nesting_effect(rules: &[Value], ignore_case: bool) -> Option<&'static str> {
    let rule = rules.iter().rev().find(|r| {
        subagent_action(r, ignore_case) && r["resource"].as_str().is_some_and(|x| wildcard(AGENT, x, ignore_case))
    })?;
    ["allow", "ask", "deny"].into_iter().find(|e| rule["effect"] == *e)
}
pub fn tool_hidden(rules: &[Value], ignore_case: bool) -> bool {
    rules
        .iter()
        .rev()
        .find(|r| subagent_action(r, ignore_case))
        .is_some_and(|r| r["resource"] == "*" && r["effect"] == "deny")
}

struct Owned {
    location: usize,
    path: Vec<Seg>,
    created: Option<String>,
}
/// `/removes it with `(\w+)`/`.
fn created_name(source: &str) -> Option<String> {
    let prefix = "removes it with `";
    let mut from = 0;
    while let Some(i) = source[from..].find(prefix) {
        let start = from + i + prefix.len();
        let run: String = source[start..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        if !run.is_empty() && source[start + run.len()..].starts_with('`') {
            return Some(run);
        }
        from = from + i + 1;
    }
    None
}
fn marked(d: &Document, path: &[Seg], expected: &J) -> Option<String> {
    let tree = crate::subagent_depth::jsonc::parse_tree(&d.text, true);
    let source = tree
        .find(tree.root, path)
        .map(|n| crate::subagent_depth::jsonc::slice(&d.text, tree.node(n).offset, tree.end(n)).to_vec())
        .unwrap_or_default();
    let source = crate::subagent_depth::jsonc::string(&source);
    (source.contains(MARKER) && crate::subagent_depth::jsonc::parse(&utf16(&source), true).0.as_ref() == Some(expected))
        .then_some(source)
}
fn owned_rules(d: &Document) -> Vec<Owned> {
    let mut out = Vec::new();
    for (index, location) in LOCATIONS.iter().enumerate() {
        let keys = container(location);
        let Ok(value) = doc::read(d, &keys) else { continue };
        let members: Vec<Seg> = match (location.legacy, &value) {
            (true, Some(v)) if v.is_obj() => LEGACY_KEYS.iter().map(|k| crate::subagent_depth::jsonc::key(k)).collect(),
            (false, Some(J::Arr(a))) => (0..a.len() as i64).map(Seg::Index).collect(),
            _ => vec![],
        };
        for member in members {
            let mut path = crate::subagent_depth::jsonc::keys(&keys);
            path.push(member);
            let expected = if location.legacy { legacy_rule() } else { rule() };
            if let Some(source) = marked(d, &path, &expected) {
                out.push(Owned { location: index, path, created: created_name(&source) });
            }
        }
    }
    out
}
fn winning(d: &Document) -> R<usize> {
    for (i, l) in LOCATIONS.iter().enumerate() {
        if doc::read(d, &l.keys)?.is_some() {
            return Ok(i);
        }
    }
    Ok(0)
}
fn remove_owned(d: &Document, owned: &Owned) -> R<Option<Text>> {
    let names: Vec<String> = owned.path[..3]
        .iter()
        .map(|s| match s {
            Seg::Key(k) => crate::subagent_depth::jsonc::string(k),
            Seg::Index(_) => String::new(),
        })
        .collect();
    let container: Vec<&str> = names.iter().map(String::as_str).collect();
    let removed = match &owned.path[3] {
        Seg::Index(i) => doc::remove_list_element(d, &container, *i as usize)?,
        Seg::Key(k) => {
            let member = crate::subagent_depth::jsonc::string(k);
            doc::remove_property(d, &[container[0], container[1], container[2], &member])?
        }
    };
    let Some(mut text) = removed else { return Ok(None) };
    if let Some(created) = &owned.created {
        for length in (1..=3).rev() {
            let keys = &container[..length];
            let current = doc::with_text(d, &text);
            let pruned = match doc::remove_empty_list(&current, keys)? {
                Some(t) => Some(t),
                None => doc::remove_empty_object(&current, keys, &doc::no_properties)?,
            };
            let Some(pruned) = pruned else { break };
            text = pruned;
            if keys.last() == Some(&created.as_str()) {
                break;
            }
        }
    }
    Ok(Some(text))
}
fn add_rule(d: &Document, l: &Location) -> R<Option<Text>> {
    let keys = container(l);
    let mut created = None;
    for i in 0..keys.len() {
        if doc::read(d, &keys[..=i])?.is_none() {
            created = Some(keys[i]);
            break;
        }
    }
    let marker = match created {
        None => format!("{MARKER}."),
        Some(c) => format!("{MARKER} with `{c}`."),
    };
    if !l.legacy {
        return doc::append(d, &keys, &rule(), Some(&marker), None).map(Some);
    }
    let permission = doc::read(d, &keys)?;
    let tools = doc::read(d, &[l.keys[0], l.keys[1], "tools"])?;
    if permission.as_ref().is_some_and(|p| !p.is_obj()) {
        return Ok(None);
    }
    let mut taken = permission.map(|p| p.keys()).unwrap_or_default();
    if let Some(t) = tools.filter(J::is_obj) {
        taken.extend(t.keys());
    }
    let Some(name) = LEGACY_KEYS.into_iter().find(|k| !taken.iter().any(|t| t == k)) else { return Ok(None) };
    doc::append(d, &keys, &legacy_rule(), Some(&marker), Some(name)).map(Some)
}
/// `withNestingRule`: CodeNomad's rule in the General block the document uses.
pub fn with_nesting_rule(d: &Document) -> R<Option<Text>> {
    let winner = winning(d)?;
    let mut current = d.clone();
    while let Some(stale) = owned_rules(&current).into_iter().find(|o| o.location != winner) {
        let Some(removed) = remove_owned(&current, &stale)? else { break };
        current = doc::with_text(d, &removed);
    }
    if owned_rules(&current).iter().any(|o| o.location == winner) {
        return Ok(Some(doc::full(&current)));
    }
    add_rule(&current, &LOCATIONS[winner])
}
pub fn nesting_rule_skipped(d: &Document) -> bool {
    (|| -> R<bool> {
        let winner = winning(d)?;
        Ok(!owned_rules(d).iter().any(|o| o.location == winner) && add_rule(d, &LOCATIONS[winner])?.is_none())
    })()
    .unwrap_or(false)
}
/// `withoutNestingRule`: no CodeNomad rule and none of the containers they created.
pub fn without_nesting_rule(d: &Document) -> R<Option<Text>> {
    let mut current = d.clone();
    let mut changed = false;
    while let Some(owned) = owned_rules(&current).into_iter().next() {
        let Some(removed) = remove_owned(&current, &owned)? else { break };
        current = doc::with_text(d, &removed);
        changed = true;
    }
    Ok(changed.then(|| doc::full(&current)))
}
