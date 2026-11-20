//! Current-passage page request (reference `recurrenceCurrentPageInput`):
//! `missionCurrentSourceSchema`, the panel selector union with its
//! refinements, the optional body content request, the current-passage
//! restrictions and the 16 KiB request budget. Returns the normalized input
//! (trimmed identifiers, as zod outputs it) or `None`.
use crate::missions::recurrence_contract::{PANEL_REQUEST_BYTES, SAFE, bytes, current_source, units};
use serde_json::{Map, Value};

fn keys(o: &Map<String, Value>, allowed: &[&str], required: &[&str]) -> bool {
    o.keys().all(|k| allowed.contains(&k.as_str())) && required.iter().all(|k| o.contains_key(*k))
}
fn counter(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n <= SAFE)
}
fn digest(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| s.len() == 43 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')))
}
fn opt(o: &Map<String, Value>, k: &str, check: impl Fn(&Value) -> bool) -> bool {
    o.get(k).is_none_or(check)
}
fn sized(v: &Value, min: usize, max: usize) -> bool {
    v.as_str().is_some_and(|s| (min..=max).contains(&units(s)))
}
/// `z.string().trim().min(1).max(100)`, normalized in place.
fn trimmed(o: &mut Map<String, Value>, k: &str) -> bool {
    let Some(s) = o.get(k).and_then(Value::as_str).map(|s| s.trim().to_owned()) else { return false };
    let ok = (1..=100).contains(&units(&s));
    o.insert(k.into(), Value::String(s));
    ok
}
fn window(v: &Value) -> bool {
    v.as_object().is_some_and(|w| keys(w, &["offset", "order"], &["offset"]) && counter(&w["offset"]) && opt(w, "order", digest))
}
fn cursor(v: &Value) -> bool {
    v.as_object().is_some_and(|c| {
        keys(c, &["digest", "index", "offset"], &["digest", "index", "offset"])
            && digest(&c["digest"])
            && counter(&c["index"])
            && counter(&c["offset"])
    })
}
/// `missionTaskRequestSchema`.
fn task(v: &mut Value) -> bool {
    let Some(t) = v.as_object_mut() else { return false };
    let list = |v: &Value, max: usize| v.as_array().is_some_and(|a| a.len() <= 50 && a.iter().all(|x| sized(x, 1, max)));
    let ok = keys(t, &["missionID", "order", "offset", "attention", "keys", "ids", "reportIds"], &["missionID"])
        && trimmed(t, "missionID")
        && opt(t, "order", |v| sized(v, 1, 64))
        && opt(t, "offset", counter)
        && opt(t, "attention", counter)
        && opt(t, "keys", |v| list(v, 64))
        && opt(t, "ids", |v| list(v, 240))
        && opt(t, "reportIds", |v| list(v, 240));
    let named = ["keys", "ids", "reportIds"].iter().any(|k| t.contains_key(*k));
    ok && [t.contains_key("offset"), t.contains_key("attention"), named].iter().filter(|x| **x).count() == 1
}
/// `missionPanelPageRequestSchema` restricted to what a current passage admits.
fn selector(v: &mut Value) -> bool {
    let source = v["source"].as_str().unwrap_or_default().to_owned();
    let Some(s) = v.as_object_mut() else { return false };
    let ok = match source.as_str() {
        "mission" => {
            keys(s, &["source", "missionID", "field", "part", "text", "header", "window", "cursor"], &["source", "missionID"])
                && sized(&s["missionID"], 1, 100)
                && opt(s, "field", |f| {
                    f.as_str().is_some_and(|f| {
                        f.len() <= 64
                            && f.bytes().next().is_some_and(|b| b.is_ascii_alphabetic())
                            && f.bytes().all(|b| b.is_ascii_alphanumeric())
                    })
                })
                && opt(s, "part", |p| p == "receipts" || p == "pending")
                && opt(s, "text", |t| *t == true)
                && opt(s, "header", |h| *h == true)
                && opt(s, "window", window)
                && opt(s, "cursor", cursor)
                && (!s.contains_key("header") || !s.contains_key("field") && !s.contains_key("window"))
                && (!s.contains_key("part") || s.get("field").is_some_and(|f| f == "control") && !s.contains_key("header"))
                && (!s.contains_key("text") || s.contains_key("field") && s.contains_key("window") && !s.contains_key("header"))
        }
        "tasks" => {
            keys(s, &["source", "task", "cursor"], &["source", "task"])
                && opt(s, "cursor", cursor)
                && s.get_mut("task").is_some_and(task)
        }
        "activity" => {
            keys(s, &["source", "missionID", "actorOffset", "actorOrder", "cursor"], &["source", "missionID"])
                && sized(&s["missionID"], 1, 100)
                && opt(s, "actorOffset", counter)
                && opt(s, "actorOrder", digest)
                && opt(s, "cursor", cursor)
        }
        // summaries, cleanups, marks and task-marks never select a current passage.
        _ => false,
    };
    ok && bytes(v) <= PANEL_REQUEST_BYTES
}
/// `missionContentRequestSchema`.
fn content(v: &mut Value) -> bool {
    let Some(c) = v.as_object_mut() else { return false };
    let task_key = |k: &Value| {
        k.as_str().is_some_and(|k| {
            let b = k.as_bytes();
            (2..=64).contains(&b.len())
                && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
                && b[1..].iter().all(|x| x.is_ascii_lowercase() || x.is_ascii_digit() || matches!(x, b'.' | b'_' | b'-'))
        })
    };
    let kind = c.get("kind").and_then(Value::as_str).unwrap_or_default().to_owned();
    let ok = keys(c, &["missionID", "kind", "field", "taskKey", "reportId", "change", "digest", "offset"], &[
        "missionID", "kind", "field", "offset",
    ]) && trimmed(c, "missionID")
        && ["mission", "task", "report", "change"].contains(&kind.as_str())
        && sized(&c["field"], 1, 64)
        && opt(c, "taskKey", task_key)
        && opt(c, "reportId", |r| sized(r, 1, 240))
        && opt(c, "change", |n| n.as_u64().is_some_and(|n| (1..=SAFE).contains(&n)))
        && opt(c, "digest", digest)
        && counter(&c["offset"]);
    let wanted = |key: &str| match kind.as_str() {
        "task" => key == "taskKey",
        "report" => key == "reportId",
        "change" => key == "change",
        _ => false,
    };
    ok && ["taskKey", "reportId", "change"].iter().all(|k| wanted(k) == c.contains_key(*k))
        && (c["offset"] == 0 || c.contains_key("digest"))
}
pub(crate) fn page_input(raw: &Value) -> Option<Value> {
    let mut input = raw.clone();
    let o = input.as_object_mut()?;
    if !keys(o, &["source", "selector", "body"], &["source", "selector"]) || !current_source(&o["source"]) {
        return None;
    }
    if !selector(o.get_mut("selector")?) || o.get_mut("body").is_some_and(|b| !content(b)) {
        return None;
    }
    let (source, s) = (&o["source"], &o["selector"]);
    let mission = if s["source"] == "tasks" { &s["task"]["missionID"] } else { &s["missionID"] };
    let fits = *mission == source["missionID"]
        && (s["source"] != "mission" || (s.get("header").is_some() || s.get("field").is_some()) && (s.get("field").is_none() || s.get("window").is_some()))
        && o.get("body").is_none_or(|b| {
            b["missionID"] == source["missionID"]
                && s["source"] == "mission"
                && s["field"] == "body"
                && s["window"]["offset"] == 0
                && ["text", "header", "part"].iter().all(|k| s.get(*k).is_none())
        });
    (fits && bytes(&input) <= PANEL_REQUEST_BYTES).then_some(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source() -> Value {
        json!({"owner":"daily","projectID":"p","scheduleID":"rcs_a","passageID":"rcp_1","missionID":"msn_1","digest":"a".repeat(43)})
    }

    #[test]
    fn current_page_selectors_keep_the_reference_refinements() {
        let ok = |selector: Value| page_input(&json!({"source":source(),"selector":selector})).is_some();
        assert!(ok(json!({"source":"mission","missionID":"msn_1","header":true})));
        assert!(ok(json!({"source":"mission","missionID":"msn_1","field":"tasks","window":{"offset":0}})));
        assert!(!ok(json!({"source":"mission","missionID":"msn_1"})), "header or field");
        assert!(!ok(json!({"source":"mission","missionID":"msn_1","field":"tasks"})), "a field needs a window");
        assert!(!ok(json!({"source":"mission","missionID":"msn_2","header":true})), "foreign mission");
        assert!(!ok(json!({"source":"mission","missionID":"msn_1","header":true,"field":"x","window":{"offset":0}})));
        assert!(!ok(json!({"source":"summaries"})));
        assert!(!ok(json!({"source":"task-marks","missionID":"msn_1","window":{"offset":0}})));
        assert!(ok(json!({"source":"tasks","task":{"missionID":" msn_1 ","offset":0}})), "task mission IDs are trimmed");
        assert!(!ok(json!({"source":"tasks","task":{"missionID":"msn_1","offset":0,"attention":0}})));
        assert!(ok(json!({"source":"activity","missionID":"msn_1"})));
        let body = |b: Value| page_input(&json!({"source":source(),"selector":
            {"source":"mission","missionID":"msn_1","field":"body","window":{"offset":0}},"body":b})).is_some();
        assert!(body(json!({"missionID":"msn_1","kind":"mission","field":"objective","offset":0})));
        assert!(!body(json!({"missionID":"msn_1","kind":"task","field":"brief","offset":0})), "task needs its key");
        assert!(!body(json!({"missionID":"msn_1","kind":"mission","field":"objective","offset":4})), "later slice needs digest");
        assert!(page_input(&json!({"source":source(),"selector":{"source":"mission","missionID":"msn_1","header":true},"x":1})).is_none());
        let huge = "a".repeat(17_000);
        assert!(!ok(json!({"source":"tasks","task":{"missionID":"msn_1","ids":[huge]}})));
    }
}
