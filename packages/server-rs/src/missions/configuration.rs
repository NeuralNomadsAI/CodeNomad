//! `missionConfigurationSchema` of the reference (`missions/launch-policy.ts` and
//! its codecs): strict validation and the exact normalization the native plugin
//! recomputes before its payload digest. `Err(())` is the schema's refusal.
//! Parity cases are generated from the reference zod schema by
//! `generate-config-cases.mjs` (`config-cases.json`).
use serde_json::{Map, Value, json};

type R<T> = Result<T, ()>;
const TIMESTAMP_MAX: u64 = 253_401_955_200_000; // Date.parse("9999-12-28T00:00:00Z")
const MIN_INTERVAL_MS: u64 = 15 * 60_000;
const CALENDAR_LIMIT: usize = 8;
pub const CONFIGURATION_MAX_BYTES: usize = 64 * 1024;
pub(super) const TEMPLATES: [&str; 5] = ["custom", "debug", "wayfinder", "delivery", "compare"];

pub(super) fn template_roles(template: &str) -> &'static [&'static str] {
    match template {
        "custom" => &["specialist"],
        "debug" => &["review-standards", "review-spec", "validator", "diagnostician", "implementer", "resolver"],
        "wayfinder" => &["cartographer", "research", "prototype", "grilling", "decision"],
        "delivery" => &["business-analyst", "technical-architect", "tech-lead", "developer", "qa-engineer", "ui-ux-designer"],
        "compare" => &["model-a", "model-b", "comparator"],
        _ => &[],
    }
}
fn allowed_role(role: &str) -> bool {
    TEMPLATES.iter().any(|t| template_roles(t).contains(&role))
}
const ALLOWED_ROLE_COUNT: usize = 21;

/// JavaScript `\s` / `String.prototype.trim` white space.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}
/// JavaScript `.length` (UTF-16 units), used by the hand-written codecs.
fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}
/// zod v4 string `min`/`max`/`length` count code points.
fn zlen(s: &str) -> usize {
    s.chars().count()
}
fn obj<'a>(v: &'a Value, keys: &[&str]) -> R<&'a Map<String, Value>> {
    let o = v.as_object().ok_or(())?;
    if o.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err(());
    }
    Ok(o)
}
fn text<'a>(v: Option<&'a Value>, min: usize, max: usize) -> R<&'a str> {
    let s = v.and_then(Value::as_str).ok_or(())?;
    let n = zlen(s);
    if n < min || n > max {
        return Err(());
    }
    Ok(s)
}
fn integer(v: Option<&Value>, min: u64, max: u64) -> R<u64> {
    let n = v.ok_or(())?;
    let x = n.as_u64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && *f >= 0.0).map(|f| f as u64)).ok_or(())?;
    if x < min || x > max {
        return Err(());
    }
    Ok(x)
}
fn ascii_set(s: &str, extra: &[u8]) -> bool {
    s.bytes().all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
}
fn document_id(v: Option<&Value>) -> R<String> {
    let s = v.and_then(Value::as_str).ok_or(())?;
    if !(3..=100).contains(&s.len()) || !ascii_set(s, b"_-") {
        return Err(());
    }
    Ok(s.into())
}
fn native_id(v: Option<&Value>) -> R<String> {
    let s = v.and_then(Value::as_str).ok_or(())?;
    if s.is_empty() || s.len() > 240 || !ascii_set(s, b"_.:-") {
        return Err(());
    }
    Ok(s.into())
}
fn nullable(v: Option<&Value>, f: impl Fn(Option<&Value>) -> R<String>) -> R<Value> {
    match v {
        Some(Value::Null) => Ok(Value::Null),
        other => Ok(json!(f(other)?)),
    }
}

/// Byte length of the reference `canonicalAuthority` text (sorted keys, no spaces).
pub fn canonical_bytes(v: &Value) -> usize {
    serde_json::to_vec(v).map_or(usize::MAX, |b| b.len())
}
fn canonical(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}
fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

// ---- time zones and cron (Effect `Cron.parse`) ----
fn zone(v: Option<&Value>) -> R<String> {
    let z = text(v, 1, 100)?;
    if !crate::missions::time_zone::valid(z) {
        return Err(());
    }
    Ok(z.into())
}
/// Effect's `zoneFromString`: an offset needs minutes (`+01` is refused).
fn cron_zone(z: &str) -> bool {
    let offset = z.starts_with(['+', '-']) || z.starts_with("GMT+") || z.starts_with("GMT-");
    !offset || {
        let b = z.as_bytes();
        let n = b.len();
        n >= 5 && b[n - 2..].iter().all(u8::is_ascii_digit) && {
            let rest = &b[..n - 2];
            let rest = rest.strip_suffix(b":").unwrap_or(rest);
            rest.len() >= 3 && rest[rest.len() - 2..].iter().all(u8::is_ascii_digit) && matches!(rest[rest.len() - 3], b'+' | b'-')
        }
    }
}
fn cron_segment(input: &str, min: u32, max: u32, aliases: &[(&str, u32)], weekday: bool) -> R<(usize, bool)> {
    let decimal = |s: &str| (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse::<u64>().ok()).flatten();
    let value = |s: &str| -> Option<u64> {
        let lower = s.to_ascii_lowercase();
        aliases.iter().find(|(a, _)| *a == lower).map(|(_, v)| *v as u64).or_else(|| decimal(s))
    };
    let split_step = |s: &str| -> (String, Option<Option<u64>>) {
        match s.find('/') {
            Some(i) => (s[..i].into(), Some(decimal(&s[i + 1..]))),
            None => (s.into(), None),
        }
    };
    let mut values = std::collections::BTreeSet::new();
    let fields: Vec<&str> = input.split(',').collect();
    let (first_raw, first_step) = split_step(fields[0]);
    let wildcard = first_raw == "*";
    let skip_add = wildcard && matches!(first_step, None | Some(Some(1)));
    let mut add = |v: u64| {
        if !skip_add {
            values.insert(if weekday && v == 7 { 0 } else { v });
        }
    };
    for (index, field) in fields.iter().enumerate() {
        let (raw, step) = if index == 0 { (first_raw.clone(), first_step) } else { split_step(field) };
        let step = match step {
            None => None,
            Some(None) => return Err(()),
            Some(Some(s)) if s < 1 || s > max as u64 => return Err(()),
            Some(Some(s)) => Some(s),
        };
        if raw == "*" {
            if index == 0 && matches!(step, None | Some(1)) {
                continue;
            }
            let mut i = min as u64;
            while i <= max as u64 {
                add(i);
                i += step.unwrap_or(1);
            }
            continue;
        }
        let (left, right) = match raw.find('-') {
            Some(i) => (value(&raw[..i]), Some(value(&raw[i + 1..]))),
            None => (value(&raw), None),
        };
        let left = left.ok_or(())?;
        if left < min as u64 || left > max as u64 {
            return Err(());
        }
        let end = match right {
            None => if step.is_none() { left } else { max as u64 },
            Some(r) => {
                let r = r.ok_or(())?;
                if r < min as u64 || r > max as u64 || left > r {
                    return Err(());
                }
                r
            }
        };
        let mut i = left;
        while i <= end {
            add(i);
            i += step.unwrap_or(1);
        }
    }
    Ok((values.len(), wildcard))
}
/// Minute-resolution cron: Effect accepts it and its seconds field holds one value.
pub fn minute_cron(expression: &str, z: &str) -> bool {
    if !cron_zone(z) {
        return false;
    }
    let mut segments: Vec<&str> = expression.split(js_space).filter(|s| !s.is_empty()).collect();
    if segments.len() == 5 {
        segments.insert(0, "0");
    }
    if segments.len() != 6 {
        return false;
    }
    const MONTHS: [(&str, u32); 12] = [("jan", 1), ("feb", 2), ("mar", 3), ("apr", 4), ("may", 5), ("jun", 6),
        ("jul", 7), ("aug", 8), ("sep", 9), ("oct", 10), ("nov", 11), ("dec", 12)];
    const DAYS: [(&str, u32); 7] = [("sun", 0), ("mon", 1), ("tue", 2), ("wed", 3), ("thu", 4), ("fri", 5), ("sat", 6)];
    let checks = [
        cron_segment(segments[0], 0, 59, &[], false),
        cron_segment(segments[1], 0, 59, &[], false),
        cron_segment(segments[2], 0, 23, &[], false),
        cron_segment(segments[3], 1, 31, &[], false),
        cron_segment(segments[4], 1, 12, &MONTHS, false),
        cron_segment(segments[5], 0, 7, &DAYS, true),
    ];
    checks.iter().all(Result::is_ok) && matches!(checks[0], Ok((1, _)))
}
fn cron_item(o: &Map<String, Value>) -> R<(String, String)> {
    let expression = o.get("expression").and_then(Value::as_str).ok_or(())?;
    let z = o.get("zone").and_then(Value::as_str).ok_or(())?;
    let trimmed = js_trim(expression);
    if trimmed.is_empty() || zlen(trimmed) > 512 {
        return Err(());
    }
    let mut collapsed = String::with_capacity(trimmed.len());
    let mut space = false;
    for c in trimmed.chars() {
        if js_space(c) {
            if !space {
                collapsed.push(' ');
            }
            space = true;
        } else {
            collapsed.push(c);
            space = false;
        }
    }
    let z = zone(Some(&json!(z)))?;
    if !minute_cron(&collapsed, &z) {
        return Err(());
    }
    Ok((collapsed, z))
}
fn cron(v: &Value) -> R<Value> {
    let o = obj(v, &["expression", "zone"])?;
    let (expression, zone) = cron_item(o)?;
    Ok(json!({"expression":expression,"zone":zone}))
}
fn cron_criterion(v: &Value) -> R<Value> {
    let o = obj(v, &["kind", "expression", "zone"])?;
    if o.get("kind") != Some(&json!("cron")) {
        return Err(());
    }
    let (expression, zone) = cron_item(o)?;
    Ok(json!({"kind":"cron","expression":expression,"zone":zone}))
}

// ---- conditions ----
fn branch_ref(s: &str) -> bool {
    (12..=1024).contains(&zlen(s))
        && s.starts_with("refs/heads/")
        && !s.chars().any(|c| js_space(c) || "~^:?*[\\".contains(c) || (c as u32) < 0x20 || c == '\u{7f}')
        && !s.contains("..")
        && !s.contains("@{")
        && s.split('/').all(|p| !p.is_empty() && !p.starts_with('.') && !p.ends_with('.') && !p.ends_with(".lock"))
}
fn relative_path(s: &str) -> bool {
    (1..=4096).contains(&zlen(s))
        && !s.contains(['\\', ':'])
        && !s.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}')
        && s.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
}
fn github_repository(v: Option<&Value>) -> R<String> {
    let s = js_trim(v.and_then(Value::as_str).ok_or(())?);
    let (owner, name) = s.split_once('/').ok_or(())?;
    let owner_ok = !owner.is_empty() && owner.len() <= 39 && owner.as_bytes()[0].is_ascii_alphanumeric() && ascii_set(owner, b"-");
    let name_ok = (1..=100).contains(&name.len()) && ascii_set(name, b"_.-") && name != "." && name != "..";
    if zlen(s) > 140 || !owner_ok || !name_ok {
        return Err(());
    }
    Ok(s.to_ascii_lowercase())
}
fn author(v: Option<&Value>, github: bool) -> R<String> {
    let s = js_trim(v.and_then(Value::as_str).ok_or(())?);
    if zlen(s) > 100 {
        return Err(());
    }
    let bare = s.strip_prefix('@').unwrap_or(s);
    let core = bare.strip_suffix("[bot]").unwrap_or(bare);
    let ok = if github {
        !core.is_empty() && core.len() <= 39 && core.as_bytes()[0].is_ascii_alphanumeric() && ascii_set(core, b"-")
    } else {
        !core.is_empty() && (core.as_bytes()[0].is_ascii_alphanumeric() || core.as_bytes()[0] == b'_') && ascii_set(core, b"_.-")
    };
    if !ok {
        return Err(());
    }
    Ok(bare.to_ascii_lowercase())
}
/// `new URL("https://" + host)` keeps exactly this host with no path, user or query.
fn repository_host(s: &str) -> bool {
    if s.is_empty() || zlen(s) > 253 {
        return false;
    }
    let (name, port) = match s.rsplit_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (s, None),
    };
    let port_ok = port.is_none_or(|p| {
        !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()) && !p.starts_with('0')
            && p.parse::<u32>().is_ok_and(|n| n <= 65535 && n != 443)
    });
    let labels: Vec<&str> = name.split('.').collect();
    let last = labels.iter().rev().find(|l| !l.is_empty()).copied().unwrap_or("");
    // A numeric final label is parsed (and normalized) as IPv4 by the URL parser.
    let ipv4 = labels.len() == 4 && labels.iter().all(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_digit())
        && (l.len() == 1 || !l.starts_with('0')) && l.parse::<u32>().is_ok_and(|n| n <= 255));
    let numeric_last = !last.is_empty() && last.bytes().all(|b| b.is_ascii_digit());
    !name.is_empty() && port_ok
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'_'))
        && (!numeric_last || ipv4)
}
fn condition(v: &Value) -> R<Value> {
    let kind = v.get("kind").and_then(Value::as_str).ok_or(())?;
    match kind {
        "schedule-success" | "mission-completed" => {
            let o = obj(v, &["kind", "missionID"])?;
            Ok(json!({"kind":kind,"missionID":document_id(o.get("missionID"))?}))
        }
        "branch-commits" => {
            let o = obj(v, &["kind", "directory", "ref"])?;
            let directory = text(o.get("directory"), 1, 4096)?;
            let r = o.get("ref").and_then(Value::as_str).ok_or(())?;
            if !branch_ref(r) {
                return Err(());
            }
            Ok(json!({"kind":kind,"directory":directory,"ref":r}))
        }
        "conversation-message" => {
            let o = obj(v, &["kind", "conversationID"])?;
            Ok(json!({"kind":kind,"conversationID":native_id(o.get("conversationID"))?}))
        }
        "files-changed" => {
            let o = obj(v, &["kind", "paths"])?;
            let paths = o.get("paths").and_then(Value::as_array).ok_or(())?;
            let mut list = Vec::new();
            for p in paths {
                let s = p.as_str().ok_or(())?;
                if !relative_path(s) {
                    return Err(());
                }
                list.push(s.to_owned());
            }
            if list.is_empty() || list.len() > 128 || list.iter().collect::<std::collections::HashSet<_>>().len() != list.len() {
                return Err(());
            }
            list.sort_by(|a, b| utf16_cmp(a, b));
            Ok(json!({"kind":kind,"paths":list}))
        }
        "github-notification" | "github-security-alert" | "github-pull-request" | "github-issue" => {
            let with_author = matches!(kind, "github-pull-request" | "github-issue");
            let o = obj(v, if with_author { &["kind", "repository", "author"] } else { &["kind", "repository"] })?;
            let mut out = json!({"kind":kind});
            match o.get("repository") {
                None if kind == "github-notification" => {}
                r => out["repository"] = json!(github_repository(r)?),
            }
            if let Some(a) = o.get("author") {
                out["author"] = json!(author(Some(a), true)?);
            }
            Ok(out)
        }
        "repository-activity" | "remote-branch-commits" => {
            let o = obj(v, if kind == "repository-activity" { &["kind", "provider", "host", "repository", "event", "author"] }
                else { &["kind", "provider", "host", "repository", "ref"] })?;
            let provider = o.get("provider").and_then(Value::as_str).filter(|p| matches!(*p, "github" | "gitlab" | "gitea")).ok_or(())?;
            let host = o.get("host").and_then(Value::as_str).filter(|h| repository_host(h)).ok_or(())?;
            let repository = text(o.get("repository"), 3, 1024)?;
            let parts: Vec<&str> = repository.split('/').collect();
            if parts.len() < 2 || parts.iter().any(|p| p.is_empty() || !ascii_set(p, b"_.-") || p.bytes().all(|b| b == b'.')) {
                return Err(());
            }
            if kind == "remote-branch-commits" {
                let reference = o.get("ref").and_then(Value::as_str).filter(|value| branch_ref(value)).ok_or(())?;
                return Ok(json!({"kind":kind,"provider":provider,"host":host,"repository":repository,"ref":reference}));
            }
            let event = o.get("event").and_then(Value::as_str)
                .filter(|e| matches!(*e, "pull-request-created" | "pull-request-merged" | "issue-created")).ok_or(())?;
            let mut out = json!({"provider":provider,"host":host,"repository":repository,"kind":kind,"event":event});
            if let Some(a) = o.get("author") {
                out["author"] = json!(author(Some(a), false)?);
            }
            Ok(out)
        }
        _ => Err(()),
    }
}

#[test]
fn remote_branch_uses_the_shared_repository_identity_and_exact_head_ref() {
    let valid = json!({"kind":"remote-branch-commits","provider":"gitea","host":"forge.example:8443",
        "repository":"org/project","ref":"refs/heads/main"});
    assert_eq!(condition(&valid), Ok(valid.clone()));
    for (key, bad) in [("host", "forge.example/path"), ("ref", "refs/tags/v1"), ("ref", "refs/heads/x.lock"),
        ("repository", "org/.."), ("provider", "git")] {
        let mut input = valid.clone();
        input[key] = json!(bad);
        assert!(condition(&input).is_err());
    }
}

// ---- launch policies ----
fn duration(v: Option<&Value>, min: u64) -> R<u64> {
    integer(v, min.max(1), TIMESTAMP_MAX)
}
fn timing(v: &Value) -> R<Value> {
    let kind = v.get("kind").and_then(Value::as_str).ok_or(())?;
    match kind {
        "immediate" => {
            obj(v, &["kind"])?;
            Ok(json!({"kind":kind}))
        }
        "at" => {
            let o = obj(v, &["kind", "at", "zone"])?;
            Ok(json!({"kind":kind,"at":integer(o.get("at"), 0, TIMESTAMP_MAX)?,"zone":zone(o.get("zone"))?}))
        }
        "in" => {
            let o = obj(v, &["kind", "delayMs"])?;
            Ok(json!({"kind":kind,"delayMs":duration(o.get("delayMs"), 1)?}))
        }
        "every" => {
            let o = obj(v, &["kind", "intervalMs"])?;
            Ok(json!({"kind":kind,"intervalMs":duration(o.get("intervalMs"), MIN_INTERVAL_MS)?}))
        }
        "cron" => cron_criterion(v),
        "multi" => {
            let o = obj(v, &["kind", "calendars"])?;
            let items = o.get("calendars").and_then(Value::as_array).ok_or(())?;
            if items.is_empty() || items.len() > CALENDAR_LIMIT {
                return Err(());
            }
            let mut unique = std::collections::BTreeMap::new();
            for item in items {
                let c = cron(item)?;
                unique.insert(canonical(&c), c);
            }
            // Map keeps the last duplicate; values are equal under the canonical key.
            let mut calendars: Vec<(String, Value)> = unique.into_iter().collect();
            calendars.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
            Ok(json!({"kind":kind,"calendars":calendars.into_iter().map(|(_, v)| v).collect::<Vec<_>>()}))
        }
        _ => Err(()),
    }
}
fn is_schedule(v: &Value) -> bool {
    matches!(v["kind"].as_str(), Some("cron" | "now"))
}
/// Reference `missionCriteriaStructure`: event roles (trigger or condition).
fn trigger_roles(items: &[Value]) -> Vec<bool> {
    let mut roles = vec![true; items.len()];
    let mut run = 0usize;
    for i in 0..items.len() {
        if i > 0 && is_schedule(&items[i]) != is_schedule(&items[i - 1]) {
            run += 1;
        }
        if !is_schedule(&items[i]) && run > 0 {
            roles[i] = false;
        }
    }
    roles
}
fn criteria(v: &Value) -> R<Value> {
    let o = obj(v, &["when"])?;
    let when = o.get("when").and_then(Value::as_array).ok_or(())?;
    if when.len() > CALENDAR_LIMIT * 2 {
        return Err(());
    }
    let mut out = Vec::new();
    for item in when {
        out.push(match item.get("kind").and_then(Value::as_str) {
            Some("now") => {
                obj(item, &["kind"])?;
                json!({"kind":"now"})
            }
            Some("cron") => cron_criterion(item)?,
            _ => condition(item)?,
        });
    }
    let schedules: Vec<&Value> = out.iter().filter(|v| is_schedule(v)).collect();
    let events: Vec<&Value> = out.iter().filter(|v| !is_schedule(v)).collect();
    let roles = trigger_roles(&out);
    let triggers = out.iter().zip(&roles).filter(|(v, t)| !is_schedule(v) && **t).count();
    let unique = |items: &[&Value]| items.iter().map(|v| canonical(v)).collect::<std::collections::HashSet<_>>().len() == items.len();
    if !unique(&schedules) || !unique(&events) || events.len() > CALENDAR_LIMIT
        || schedules.len() + usize::from(triggers > 0) > CALENDAR_LIMIT
    {
        return Err(());
    }
    Ok(json!({"when":out}))
}
fn legacy(v: &Value) -> R<Value> {
    let o = obj(v, &["timing", "condition", "ends"])?;
    let timing = timing(o.get("timing").ok_or(())?)?;
    let condition = match o.get("condition").ok_or(())? {
        Value::Null => Value::Null,
        c => condition(c)?,
    };
    let ends = obj(o.get("ends").ok_or(())?, &["maxLaunches", "afterMs", "at"])?;
    let nullable_int = |k: &str, min: u64| -> R<Value> {
        match ends.get(k).ok_or(())? {
            Value::Null => Ok(Value::Null),
            n => Ok(json!(integer(Some(n), min, TIMESTAMP_MAX.max(9_007_199_254_740_991).min(if k == "maxLaunches" { 9_007_199_254_740_991 } else { TIMESTAMP_MAX }))?)),
        }
    };
    Ok(json!({"timing":timing,"condition":condition,"ends":{
        "maxLaunches":nullable_int("maxLaunches", 1)?,"afterMs":nullable_int("afterMs", 1)?,"at":nullable_int("at", 0)?}}))
}
pub(super) fn criteria_only(v: &Value) -> R<Value> {
    criteria(v)
}
pub(super) struct SchedulePlan {
    pub conditions: Vec<Value>,
    pub fallback: bool,
}
pub(super) struct LaunchModel {
    pub schedules: Vec<Value>,
    pub plans: Vec<SchedulePlan>,
    pub triggers: Vec<Value>,
    pub events: Vec<Value>,
    pub until: Option<u64>,
    pub end_after_ms: Option<u64>,
    pub max_launches: Option<u64>,
}
/// Full reading of both stored shapes (`missionLaunchModel` + `missionCriteriaStructure`).
pub(super) fn launch_model_full(launch: &Value) -> LaunchModel {
    if let Some(when) = launch["when"].as_array() {
        let items: &[Value] = if when.len() == 1 && when[0]["kind"] == "now" { &[] } else { when };
        let mut runs: Vec<(bool, Vec<usize>)> = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let sched = is_schedule(item);
            if runs.last().is_some_and(|(s, _)| *s == sched) {
                runs.last_mut().unwrap().1.push(index);
            } else {
                runs.push((sched, vec![index]));
            }
        }
        let mut trigger_role = vec![true; items.len()];
        let mut plan_by_index: std::collections::HashMap<usize, (Vec<usize>, bool)> = std::collections::HashMap::new();
        for (pos, (sched, indices)) in runs.iter().enumerate() {
            if !*sched {
                if pos > 0 {
                    for &index in indices {
                        trigger_role[index] = false;
                    }
                }
                continue;
            }
            let next_indices = runs.get(pos + 1).map(|(_, idx)| idx.clone()).unwrap_or_default();
            for &index in indices {
                plan_by_index.insert(index, (next_indices.clone(), pos > 0));
            }
        }
        let mut schedules = Vec::new();
        let mut plans = Vec::new();
        let mut events = Vec::new();
        let mut triggers = Vec::new();
        for (index, item) in items.iter().enumerate() {
            if is_schedule(item) {
                let (cond_idx, fallback) = plan_by_index.remove(&index).unwrap_or_default();
                schedules.push(item.clone());
                plans.push(SchedulePlan {
                    conditions: cond_idx.into_iter().map(|i| items[i].clone()).collect(),
                    fallback,
                });
            } else {
                events.push(item.clone());
                if trigger_role[index] {
                    triggers.push(item.clone());
                }
            }
        }
        return LaunchModel { schedules, plans, triggers, events, until: None, end_after_ms: None, max_launches: None };
    }
    let timing = &launch["timing"];
    let events = if launch["condition"].is_null() { vec![] } else { vec![launch["condition"].clone()] };
    let schedules: Vec<Value> = match timing["kind"].as_str() {
        Some("immediate") => vec![],
        Some("multi") => timing["calendars"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|c| json!({"kind":"cron","expression":c["expression"],"zone":c["zone"]}))
                    .collect()
            })
            .unwrap_or_default(),
        _ => vec![timing.clone()],
    };
    let plans = schedules.iter().map(|_| SchedulePlan { conditions: events.clone(), fallback: false }).collect();
    let triggers = if schedules.is_empty() { events.clone() } else { vec![] };
    let repeats = matches!(timing["kind"].as_str(), Some("every" | "cron" | "multi"));
    let ends = &launch["ends"];
    let max_launches = if repeats {
        ends["maxLaunches"].as_u64()
    } else if timing["kind"] == "immediate" && events.is_empty() {
        None
    } else {
        Some(1)
    };
    LaunchModel {
        schedules,
        plans,
        triggers,
        events,
        until: ends["at"].as_u64(),
        end_after_ms: ends["afterMs"].as_u64(),
        max_launches,
    }
}
pub(super) fn launch(v: &Value) -> R<Value> {
    criteria(v).or_else(|_| legacy(v))
}
/// Stored schedules and watched events of a launch policy (`missionLaunchModel`).
fn launch_model(launch: &Value) -> (usize, Vec<Value>) {
    let model = launch_model_full(launch);
    (model.schedules.len(), model.events)
}
pub fn requires_calendar(launch: &Value) -> bool {
    let (schedules, events) = launch_model(launch);
    schedules > 0 || !events.is_empty()
}

// ---- profiles ----
fn plain_object(v: &Value) -> R<&Map<String, Value>> {
    v.as_object().ok_or(())
}
fn execution_text(v: Option<&Value>) -> R<String> {
    let s = v.and_then(Value::as_str).ok_or(())?;
    if js_trim(s).is_empty() || len16(s) > 240 {
        return Err(());
    }
    Ok(s.into())
}
fn selection(v: &Value) -> R<Value> {
    let o = plain_object(v)?;
    if o.keys().any(|k| k != "agent" && k != "model") {
        return Err(());
    }
    let mut out = Map::new();
    if let Some(a) = o.get("agent") {
        out.insert("agent".into(), json!(execution_text(Some(a))?));
    }
    if let Some(m) = o.get("model") {
        let m = plain_object(m)?;
        if m.keys().any(|k| !matches!(k.as_str(), "providerID" | "id" | "variant")) {
            return Err(());
        }
        let mut model = json!({"providerID":execution_text(m.get("providerID"))?,"id":execution_text(m.get("id"))?});
        if let Some(variant) = m.get("variant") {
            model["variant"] = json!(execution_text(Some(variant))?);
        }
        out.insert("model".into(), model);
    }
    Ok(Value::Object(out))
}
pub(super) fn profiles(v: &Value) -> R<Value> {
    let o = plain_object(v)?;
    if o.keys().any(|k| k != "coordinator" && k != "roles") {
        return Err(());
    }
    let mut out = Map::new();
    if let Some(c) = o.get("coordinator") {
        out.insert("coordinator".into(), selection(c)?);
    }
    if let Some(r) = o.get("roles") {
        let roles = plain_object(r)?;
        if roles.len() > ALLOWED_ROLE_COUNT || roles.keys().any(|k| !allowed_role(k)) {
            return Err(());
        }
        let mut parsed = Map::new();
        for (role, s) in roles {
            parsed.insert(role.clone(), selection(s)?);
        }
        out.insert("roles".into(), Value::Object(parsed));
    }
    Ok(Value::Object(out))
}

pub(super) fn valid_profile_roles(template: &str, profiles: &Value) -> bool {
    profiles["roles"].as_object().is_none_or(|roles| roles.keys().all(|r| template_roles(template).contains(&r.as_str())))
}

/// The reference schema's parse output, or `Err` for its refusal.
pub fn normalize(input: &Value) -> R<Value> {
    parse(input, true)
}
/// The schema's object shape alone (`z.object(missionConfigurationSchema.shape)`):
/// field-level rules and transforms, without the object-level refinement.
pub fn shape(input: &Value) -> R<Value> {
    parse(input, false)
}
fn parse(input: &Value, refine: bool) -> R<Value> {
    let o = obj(input, &["title", "objective", "notes", "template", "profiles", "taskMode", "profileID", "executionHost",
        "roots", "watchedConversationIDs", "coordinatorSessionID", "coordinatorSelectionAuthor", "coordinatorGoal", "launch"])?;
    let mut out = Map::new();
    let title = js_trim(o.get("title").and_then(Value::as_str).ok_or(())?);
    if !(1..=60).contains(&zlen(title)) || title.contains(['\r', '\n']) {
        return Err(());
    }
    out.insert("title".into(), json!(title));
    out.insert("objective".into(), json!(text(o.get("objective"), 1, 20_000)?));
    if let Some(n) = o.get("notes") {
        out.insert("notes".into(), json!(text(Some(n), 0, 20_000)?));
    }
    let template = o.get("template").and_then(Value::as_str).filter(|t| TEMPLATES.contains(t)).ok_or(())?;
    out.insert("template".into(), json!(template));
    let profiles = match o.get("profiles") {
        None => None,
        Some(p) => Some(profiles(p)?),
    };
    if let Some(p) = &profiles {
        out.insert("profiles".into(), p.clone());
    }
    let task_mode = o.get("taskMode").and_then(Value::as_str).filter(|m| matches!(*m, "native" | "independent")).ok_or(())?;
    out.insert("taskMode".into(), json!(task_mode));
    out.insert("profileID".into(), nullable(o.get("profileID"), native_id)?);
    out.insert("executionHost".into(), nullable(o.get("executionHost"), native_id)?);
    let roots = o.get("roots").and_then(Value::as_array).ok_or(())?;
    if roots.is_empty() || roots.len() > 32 {
        return Err(());
    }
    let mut parsed_roots = Vec::new();
    for root in roots {
        let mode = root.get("mode").and_then(Value::as_str).ok_or(())?;
        let id = |k: &str, r: &Map<String, Value>| text(r.get(k), 1, 240).map(str::to_owned);
        parsed_roots.push(match mode {
            "git" => {
                let r = obj(root, &["mode", "directory", "family", "checkout"])?;
                json!({"mode":"git","directory":text(r.get("directory"), 1, 4096)?,"family":id("family", r)?,"checkout":id("checkout", r)?})
            }
            "directory-only" => {
                let r = obj(root, &["mode", "directory"])?;
                json!({"mode":"directory-only","directory":text(r.get("directory"), 1, 4096)?})
            }
            _ => return Err(()),
        });
    }
    let directories: std::collections::HashSet<_> = parsed_roots.iter().map(|r| r["directory"].as_str().unwrap().to_owned()).collect();
    if directories.len() != parsed_roots.len() {
        return Err(());
    }
    out.insert("roots".into(), json!(parsed_roots));
    let watched = o.get("watchedConversationIDs").and_then(Value::as_array).ok_or(())?;
    let watched = watched.iter().map(|v| native_id(Some(v))).collect::<R<Vec<_>>>()?;
    if watched.len() > 64 || watched.iter().collect::<std::collections::HashSet<_>>().len() != watched.len() {
        return Err(());
    }
    out.insert("watchedConversationIDs".into(), json!(watched));
    let coordinator = match o.get("coordinatorSessionID") {
        None => None,
        Some(v) => {
            let id = native_id(Some(v))?;
            if id.starts_with("ses_cn_schedule_") {
                return Err(());
            }
            Some(id)
        }
    };
    if let Some(c) = &coordinator {
        out.insert("coordinatorSessionID".into(), json!(c));
    }
    if let Some(a) = o.get("coordinatorSelectionAuthor") {
        let a = obj(a, &["coordinatorSessionID"])?;
        out.insert("coordinatorSelectionAuthor".into(), json!({"coordinatorSessionID":native_id(a.get("coordinatorSessionID"))?}));
    }
    if let Some(g) = o.get("coordinatorGoal") {
        out.insert("coordinatorGoal".into(), json!(g.as_bool().ok_or(())?));
    }
    let launch = launch(o.get("launch").ok_or(())?)?;
    out.insert("launch".into(), launch.clone());
    let config = Value::Object(out);
    if !refine {
        return Ok(config);
    }
    // Object-level refinement.
    if canonical_bytes(&config) > CONFIGURATION_MAX_BYTES {
        return Err(());
    }
    let roles = template_roles(template);
    let role_map = profiles.as_ref().and_then(|p| p["roles"].as_object());
    if profiles.as_ref().is_some_and(|p| !valid_profile_roles(template, p)) {
        return Err(());
    }
    if template == "compare" {
        let model = |r: &str| role_map.and_then(|m| m.get(r)).map(|s| &s["model"]).filter(|m| m.is_object());
        match (model("model-a"), model("model-b")) {
            (Some(a), Some(b)) if !(a["providerID"] == b["providerID"] && a["id"] == b["id"]) => {}
            _ => return Err(()),
        }
    }
    if !requires_calendar(&launch) {
        return if coordinator.is_none() { Ok(config) } else { Err(()) };
    }
    if let Some(c) = &coordinator {
        let (_, events) = launch_model(&launch);
        if watched.contains(c) || events.iter().any(|e| e["kind"] == "conversation-message" && e["conversationID"] == c.as_str()) {
            return Err(());
        }
    }
    let complete = |s: &Value| s["agent"].as_str().is_some_and(|a| !a.is_empty())
        && s["model"]["providerID"].as_str().is_some_and(|p| !p.is_empty())
        && s["model"]["id"].as_str().is_some_and(|i| !i.is_empty());
    let profile_ok = config["profileID"].as_str().is_some_and(|s| !s.is_empty())
        && config["executionHost"].as_str().is_some_and(|s| !s.is_empty())
        && profiles.as_ref().is_some_and(|p| {
            p.get("coordinator").is_some_and(complete)
                && roles.iter().all(|r| role_map.and_then(|m| m.get(*r)).is_some())
                && role_map.is_none_or(|m| m.values().all(complete))
        });
    if profile_ok { Ok(config) } else { Err(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cases generated from the reference zod schema (`generate-config-cases.mjs`).
    #[test]
    fn matches_the_reference_schema() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../../tests/fixtures/config-cases.json")).unwrap();
        assert!(cases.len() > 100);
        let mut failures = Vec::new();
        for case in &cases {
            let got = normalize(&case["input"]).ok();
            let want = case.get("output").filter(|v| !v.is_null()).cloned();
            if got != want {
                failures.push(format!("{}: got {:?} want {:?}", case["name"], got.map(|v| v.to_string()), want.map(|v| v.to_string())));
            }
        }
        assert!(failures.is_empty(), "{} mismatches:\n{}", failures.len(), failures.join("\n"));
    }
}
