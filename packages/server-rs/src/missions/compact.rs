//! Compact Mission display maps (`compactMissionMap` parity with `packages/server`).
use super::recovery::{NativeCall, execution_evidence};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const MISSION_EXCERPT_MAX: usize = 240;
const MISSION_SUMMARY_OBJECTIVE: usize = 502;
const MISSION_TASK_PAGE: usize = 50;
const MISSION_TASK_PINS: usize = 20;
const MISSION_LATE_REPORT_ROWS: usize = 1;
const MISSION_TASK_REPORT_ROWS: usize = 3;
const MISSION_PINNED_REPORTS: usize = 8;

const MISSION_BODY_FIELDS: &[&str] = &["objective", "notes", "summary", "briefing"];
const TASK_BODY_FIELDS: &[&str] = &["brief", "executionMode", "report", "lateReports"];
const REPORT_BODY_FIELDS: &[&str] = &["summary", "next", "evidence", "artifact"];
const CHANGE_BODY_FIELDS: &[&str] = &[
    "reason",
    "objective",
    "notes",
    "addedTaskKeys",
    "retiredTasks",
    "dependencyUpdates",
];
const BRIEFING_CONTENT_FIELDS: &[&str] = &["summary", "achieved", "ongoing", "obstacles", "next"];

fn content_digest(text: &str) -> String {
    let mut hasher = Sha256::new();
    for unit in text.encode_utf16() {
        hasher.update(unit.to_le_bytes());
    }
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

fn content_text(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        s.to_owned()
    } else {
        serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned())
    }
}

fn describe(owner: &Map<String, Value>, fields: &[&str]) -> Map<String, Value> {
    let mut bodies = Map::new();
    for &field in fields {
        let Some(value) = owner.get(field) else { continue };
        let text = content_text(value);
        let characters = text.encode_utf16().count();
        bodies.insert(field.to_owned(), json!({ "characters": characters, "digest": content_digest(&text) }));
    }
    bodies
}

fn described(owner: &Map<String, Value>, fields: &[&str]) -> Map<String, Value> {
    let own = owner.get("bodies").and_then(Value::as_object);
    let missing: Vec<&str> =
        fields.iter().copied().filter(|field| own.is_none_or(|b| !b.contains_key(*field))).collect();
    let mut out = describe(owner, &missing);
    if let Some(own) = own {
        for (k, v) in own {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

fn without(owner: &Map<String, Value>, fields: &[&str]) -> Map<String, Value> {
    let mut copy = owner.clone();
    for &field in fields {
        copy.remove(field);
    }
    copy
}

fn mission_excerpt(text: &str, max: usize) -> String {
    let mut points = Vec::new();
    let mut gap = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            gap = !points.is_empty();
            continue;
        }
        if gap {
            points.push(' ');
            gap = false;
        }
        points.push(ch);
        if points.len() > max {
            let cut: String = points[..max].iter().collect();
            return format!("{}…", cut.trim_end());
        }
    }
    points.into_iter().collect()
}

fn mission_objective_label(objective: &str) -> String {
    let trimmed = objective.trim();
    let mut out = String::new();
    let mut count = 0usize;
    let mut ws_run = false;
    let mut ws_newline = false;
    for ch in trimmed.chars() {
        if ch.is_whitespace() {
            ws_run = true;
            if ch == '\n' {
                ws_newline = true;
            }
            continue;
        }
        if ws_run {
            if count < MISSION_SUMMARY_OBJECTIVE {
                out.push(if ws_newline { '\n' } else { ' ' });
                count += 1;
            }
            ws_run = false;
            ws_newline = false;
        }
        if count >= MISSION_SUMMARY_OBJECTIVE {
            break;
        }
        out.push(ch);
        count += 1;
    }
    out
}

fn is_full_mission_map(map: &Value) -> bool {
    map.get("objective").is_some_and(Value::is_string)
}

fn is_full_mission_report(report: &Value) -> bool {
    report.get("summary").is_some_and(Value::is_string)
}

fn mission_is_running(map: &Value) -> bool {
    map["status"] == "active" && matches!(map["runState"].as_str(), None | Some("running"))
}

fn is_coordinator_notification_report(report: &Value) -> bool {
    matches!(report.get("delivery").and_then(Value::as_str), None | Some("coordinator-notification"))
}

fn valid_native_id(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 240
            && !s.chars().any(|c| c.is_whitespace() || c.is_control())
    })
}

fn valid_decision_text(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        let len = s.encode_utf16().count();
        (1..=20_000).contains(&len)
    })
}

fn valid_field_key(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        let Some(rest) = s.strip_prefix('q') else { return false };
        rest == "0"
            || ((1..=2).contains(&rest.len())
                && rest.bytes().next().is_some_and(|b| (b'1'..=b'9').contains(&b))
                && rest.bytes().all(|b| b.is_ascii_digit()))
    })
}

fn valid_safe_pos_int(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| (1..=9_007_199_254_740_991).contains(&n))
}

fn valid_contract_ref(v: &Value) -> bool {
    v.as_object().is_some_and(|o| {
        o.len() == 3
            && o.get("missionID").is_some_and(valid_native_id)
            && o.get("taskKey").is_some_and(valid_native_id)
            && o.get("generation").is_some_and(valid_safe_pos_int)
    })
}

fn valid_human_decision_artifact(v: &Value, require_native_form: bool) -> bool {
    let Some(o) = v.as_object() else { return false };
    if o.keys().any(|k| !matches!(k.as_str(), "kind" | "decidedBy" | "question" | "answer" | "provenance"))
        || o.get("kind").and_then(Value::as_str) != Some("decision")
        || o.get("decidedBy").is_some_and(|d| d != "human")
        || !o.get("question").is_some_and(valid_decision_text)
    {
        return false;
    }
    let answer_ok = o.get("answer").is_some_and(|a| {
        valid_decision_text(a)
            || a.as_array().is_some_and(|arr| (1..=32).contains(&arr.len()) && arr.iter().all(valid_decision_text))
    });
    if !answer_ok {
        return false;
    }
    let Some(prov) = o.get("provenance").and_then(Value::as_object) else { return false };
    let kind = prov.get("kind").and_then(Value::as_str);
    let base_ok = prov.get("contract").is_some_and(valid_contract_ref)
        && prov.get("sessionID").is_some_and(valid_native_id)
        && prov.get("formID").is_some_and(valid_native_id)
        && prov.get("messageID").is_some_and(valid_native_id)
        && prov.get("toolCallID").is_some_and(valid_native_id)
        && prov.get("fieldKey").is_some_and(valid_field_key);
    match kind {
        Some("native-form-answer") => {
            prov.len() == 8
                && base_ok
                && prov.get("nativeCall").and_then(Value::as_object).is_some_and(|nc| {
                    nc.len() == 4
                        && nc.get("generation").is_some_and(valid_safe_pos_int)
                        && nc.get("parentSessionID").is_some_and(valid_native_id)
                        && nc.get("parentMessageID").is_some_and(valid_native_id)
                        && nc.get("toolCallID").is_some_and(valid_native_id)
                })
        }
        Some("coordinator-form-answer") if !require_native_form => prov.len() == 7 && base_ok,
        _ => false,
    }
}

fn valid_coordinator_decision_artifact(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    o.keys().all(|k| {
        matches!(k.as_str(), "kind" | "decidedBy" | "question" | "decision" | "rationale" | "alternatives" | "reversal")
    }) && o.get("kind").and_then(Value::as_str) == Some("decision")
        && o.get("decidedBy").and_then(Value::as_str) == Some("coordinator")
        && o.get("question").is_some_and(valid_decision_text)
        && o.get("decision").is_some_and(valid_decision_text)
        && o.get("rationale").is_some_and(valid_decision_text)
        && o.get("alternatives").is_none_or(|a| {
            a.as_array().is_some_and(|arr| arr.len() <= 16 && arr.iter().all(valid_decision_text))
        })
        && o.get("reversal").is_none_or(valid_decision_text)
}

fn mission_decision_maker(template: &str, task: Option<&Value>, report: &Value) -> Option<&'static str> {
    let task = task?;
    if template != "wayfinder"
        || task["role"] != "decision"
        || task["executionMode"]["kind"] != "native"
        || report["outcome"] != "completed"
    {
        return None;
    }
    let artifact = report.get("artifact")?;
    match report["delivery"].as_str() {
        Some("coordinator-readout") => {
            if valid_coordinator_decision_artifact(artifact) {
                Some("coordinator")
            } else if valid_human_decision_artifact(artifact, false) {
                Some("human")
            } else {
                None
            }
        }
        Some("native-return") => valid_human_decision_artifact(artifact, true).then_some("human"),
        _ => None,
    }
}

fn mission_task_order(tasks: &[Value]) -> Vec<usize> {
    let mut index: HashMap<&str, usize> = HashMap::new();
    let mut unique = Vec::new();
    for (pos, task) in tasks.iter().enumerate() {
        let key = task["key"].as_str().unwrap_or_default();
        if !index.contains_key(key) {
            index.insert(key, pos);
            unique.push((pos, key));
        }
    }
    let mut pending: HashMap<&str, usize> = HashMap::new();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
    for &(pos, key) in &unique {
        let mut seen = HashSet::new();
        let mut count = 0usize;
        if let Some(blocked) = tasks[pos]["blockedBy"].as_array() {
            for dep in blocked.iter().filter_map(Value::as_str) {
                if index.contains_key(dep) && seen.insert(dep) {
                    count += 1;
                    dependents.entry(dep).or_default().push(key);
                }
            }
        }
        pending.insert(key, count);
    }
    let mut round: HashMap<&str, usize> = HashMap::new();
    let mut ready: Vec<&str> = unique.iter().filter(|&&(_, k)| pending[k] == 0).map(|&(_, k)| k).collect();
    let mut level = 0usize;
    while !ready.is_empty() {
        let mut next = Vec::new();
        for key in ready {
            round.insert(key, level);
            if let Some(deps) = dependents.get(key) {
                for &dep in deps {
                    let left = pending.get_mut(dep).unwrap();
                    *left -= 1;
                    if *left == 0 {
                        next.push(dep);
                    }
                }
            }
        }
        ready = next;
        level += 1;
    }
    let mut ordered: Vec<(usize, &str)> = unique.iter().copied().filter(|&(_, k)| round.contains_key(k)).collect();
    ordered.sort_by(|&(lp, lk), &(rp, rk)| round[lk].cmp(&round[rk]).then_with(|| lp.cmp(&rp)));
    let cyclic: Vec<(usize, &str)> = unique.iter().copied().filter(|&(_, k)| !round.contains_key(k)).collect();
    ordered.into_iter().chain(cyclic).map(|(pos, _)| pos).collect()
}

fn report_row(template: &str, tasks_by_key: &HashMap<&str, &Value>, value: &Value, bodies: bool) -> Value {
    let Some(obj) = value.as_object() else { return value.clone() };
    if !is_full_mission_report(value) {
        return Value::Object(if bodies { obj.clone() } else { without(obj, &["bodies"]) });
    }
    let task = value["taskKey"].as_str().and_then(|k| tasks_by_key.get(k).copied());
    let decided_by = mission_decision_maker(template, task, value);
    let mut out = without(obj, REPORT_BODY_FIELDS);
    let summary = value["summary"].as_str().unwrap_or_default();
    out.insert("excerpt".to_owned(), Value::String(mission_excerpt(summary, MISSION_EXCERPT_MAX)));
    if let Some(maker) = decided_by {
        out.insert("decidedBy".to_owned(), Value::String(maker.to_owned()));
    }
    if bodies {
        out.insert("bodies".to_owned(), Value::Object(described(obj, REPORT_BODY_FIELDS)));
    }
    Value::Object(out)
}

fn mission_actor_evidence(map: &Value, tasks: &[Value], ordered: &[usize]) -> Value {
    let mut report_owed: Vec<String> = Vec::new();
    let mut report_owed_set: HashSet<String> = HashSet::new();
    let mut call_open: Vec<String> = Vec::new();
    let mut call_open_set: HashSet<String> = HashSet::new();
    let reports = map["reports"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if mission_is_running(map)
        && !reports.iter().any(|r| r["notificationStatus"] == "pending" && is_coordinator_notification_report(r))
        && let Some(coord) = map["coordinatorSessionId"].as_str()
        && report_owed_set.insert(coord.to_owned())
    {
        report_owed.push(coord.to_owned());
    }
    for &idx in ordered {
        let task = &tasks[idx];
        let Some(sid) = task["actorSessionId"].as_str().filter(|s| !s.is_empty()) else { continue };
        let (_, native_call, missing_report) = execution_evidence(task);
        if missing_report && report_owed_set.insert(sid.to_owned()) {
            report_owed.push(sid.to_owned());
        }
        if matches!(native_call, NativeCall::Active | NativeCall::Unknown) && call_open_set.insert(sid.to_owned()) {
            call_open.push(sid.to_owned());
        }
    }
    json!({ "reportOwed": report_owed, "callOpen": call_open })
}

/// Compact a Mission map for `GET /api/workspaces/:id/missions/:missionID` display reads.
/// Maps that are already compact with a `taskPage` are returned unchanged.
pub(super) fn compact_mission_map(map: Value) -> Value {
    if !is_full_mission_map(&map) && map.get("taskPage").is_some_and(|v| !v.is_null()) {
        return map;
    }
    let Some(map_obj) = map.as_object() else { return map };
    let tasks = map.get("tasks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let reports = map.get("reports").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let template = map["template"].as_str().unwrap_or_default();

    let ordered = mission_task_order(tasks);
    let mut position: HashMap<&str, usize> = HashMap::with_capacity(ordered.len());
    let mut ordered_keys: Vec<&str> = Vec::with_capacity(ordered.len());
    let mut by_key: HashMap<&str, usize> = HashMap::with_capacity(ordered.len());
    let mut tasks_by_key: HashMap<&str, &Value> = HashMap::with_capacity(tasks.len());
    for task in tasks {
        if let Some(k) = task["key"].as_str() {
            tasks_by_key.insert(k, task);
        }
    }
    for (pos, &idx) in ordered.iter().enumerate() {
        let key = tasks[idx]["key"].as_str().unwrap_or_default();
        position.insert(key, pos);
        ordered_keys.push(key);
        by_key.insert(key, idx);
    }
    let mut dependents: HashMap<&str, usize> = HashMap::new();
    let mut counts: Map<String, Value> = Map::new();
    for &idx in &ordered {
        let task = &tasks[idx];
        if let Some(status) = task["status"].as_str() {
            let next = counts.get(status).and_then(Value::as_u64).unwrap_or(0) + 1;
            counts.insert(status.to_owned(), Value::from(next));
        }
        if let Some(blocked) = task["blockedBy"].as_array() {
            let mut seen = HashSet::new();
            for dep in blocked.iter().filter_map(Value::as_str) {
                if position.contains_key(dep) && seen.insert(dep) {
                    *dependents.entry(dep).or_insert(0) += 1;
                }
            }
        }
    }
    let order_digest = content_digest(&serde_json::to_string(&ordered_keys).unwrap_or_else(|_| "[]".into()));

    // Attention priority: pending notifications, needs-input/failed (newest first), missing reports.
    let mut attention_keys: Vec<&str> = Vec::new();
    let mut attention_set: HashSet<&str> = HashSet::new();
    let mut notified: HashSet<&str> = HashSet::new();
    for r in reports {
        if r["notificationStatus"] == "pending"
            && let Some(k) = r["taskKey"].as_str()
            && position.contains_key(k)
        {
            if notified.insert(k) && attention_set.insert(k) {
                attention_keys.push(k);
            }
        }
    }
    let mut blocked_count = 0usize;
    let mut failed_count = 0usize;
    let mut blocked_or_failed: Vec<(usize, &Value)> = ordered
        .iter()
        .copied()
        .filter_map(|idx| {
            let task = &tasks[idx];
            matches!(task["status"].as_str(), Some("needs-input" | "failed")).then_some((idx, task))
        })
        .collect();
    blocked_or_failed.sort_by(|(_, a), (_, b)| {
        b["updatedAt"].as_f64().unwrap_or(0.0).total_cmp(&a["updatedAt"].as_f64().unwrap_or(0.0))
    });
    for (_, task) in blocked_or_failed {
        if task["status"] == "failed" {
            failed_count += 1;
        } else {
            blocked_count += 1;
        }
        if let Some(k) = task["key"].as_str() && attention_set.insert(k) {
            attention_keys.push(k);
        }
    }
    let mut recovery_count = 0usize;
    for &idx in &ordered {
        let task = &tasks[idx];
        if task["actorSessionId"].as_str().is_some_and(|s| !s.is_empty()) && execution_evidence(task).2 {
            recovery_count += 1;
            if let Some(k) = task["key"].as_str() && attention_set.insert(k) {
                attention_keys.push(k);
            }
        }
    }

    // Shown tasks: first MISSION_TASK_PAGE + up to MISSION_TASK_PINS pinned candidates.
    let window_len = ordered.len().min(MISSION_TASK_PAGE);
    let window = &ordered[..window_len];
    let in_window: HashSet<&str> =
        window.iter().filter_map(|&idx| tasks[idx]["key"].as_str()).collect();
    let mut candidates: Vec<&str> = Vec::new();
    let mut candidate_set: HashSet<&str> = HashSet::new();
    for &k in &attention_keys {
        if by_key.contains_key(k) && !in_window.contains(k) && candidate_set.insert(k) {
            candidates.push(k);
        }
    }
    let mut newest_reports: Vec<&Value> = reports.iter().collect();
    newest_reports.sort_by(|a, b| {
        b["createdAt"].as_f64().unwrap_or(0.0).total_cmp(&a["createdAt"].as_f64().unwrap_or(0.0))
    });
    for r in newest_reports.iter().take(MISSION_PINNED_REPORTS) {
        if let Some(k) = r["taskKey"].as_str()
            && by_key.contains_key(k)
            && !in_window.contains(k)
            && candidate_set.insert(k)
        {
            candidates.push(k);
        }
    }
    if is_full_mission_map(&map)
        && let Some(briefing) = map.get("briefing").and_then(Value::as_object)
    {
        for section in ["achieved", "ongoing", "obstacles", "next"] {
            if let Some(items) = briefing.get(section).and_then(Value::as_array) {
                for item in items {
                    if let Some(tkeys) = item.get("taskKeys").and_then(Value::as_array) {
                        for k in tkeys.iter().filter_map(Value::as_str) {
                            if by_key.contains_key(k) && !in_window.contains(k) && candidate_set.insert(k) {
                                candidates.push(k);
                            }
                        }
                    }
                }
            }
        }
    }
    let pinned_len = candidates.len().min(MISSION_TASK_PINS);
    let pinned_keys: HashSet<&str> = candidates[..pinned_len].iter().copied().collect();
    let pins_omitted = candidates.len().saturating_sub(MISSION_TASK_PINS);
    let omitted_attention: Vec<&str> = attention_keys
        .iter()
        .copied()
        .filter(|k| !in_window.contains(k) && !pinned_keys.contains(k))
        .collect();
    let omitted_seq = content_digest(&serde_json::to_string(&omitted_attention).unwrap_or_else(|_| "[]".into()));

    let mut selected_indices: Vec<usize> = Vec::with_capacity(window.len() + pinned_len);
    let mut selected_set: HashSet<usize> = HashSet::new();
    for &idx in window {
        if selected_set.insert(idx) {
            selected_indices.push(idx);
        }
    }
    for &k in &candidates[..pinned_len] {
        if let Some(&idx) = by_key.get(k) && selected_set.insert(idx) {
            selected_indices.push(idx);
        }
    }
    selected_indices.sort_by_key(|&idx| position[tasks[idx]["key"].as_str().unwrap_or_default()]);

    let mut reports_of: HashMap<&str, Vec<&Value>> = HashMap::new();
    for r in reports {
        if let Some(k) = r["taskKey"].as_str() {
            reports_of.entry(k).or_default().push(r);
        }
    }
    let mut kept_report_ids: HashSet<&str> = HashSet::new();
    let mut compact_tasks: Vec<Value> = Vec::with_capacity(selected_indices.len());
    for idx in selected_indices {
        let task = &tasks[idx];
        let Some(task_obj) = task.as_object() else { continue };
        let key = task["key"].as_str().unwrap_or_default();
        let own = reports_of.get(key).map(Vec::as_slice).unwrap_or(&[]);
        let mut newest: Vec<&Value> = own.to_vec();
        newest.sort_by(|a, b| {
            b["createdAt"].as_f64().unwrap_or(0.0).total_cmp(&a["createdAt"].as_f64().unwrap_or(0.0))
        });
        let late_arr = task.get("lateReports").and_then(Value::as_array);
        let late_slice: Option<&[Value]> = late_arr.map(|a| &a[a.len().saturating_sub(MISSION_LATE_REPORT_ROWS)..]);
        let mut held: Vec<&str> = Vec::new();
        let mut held_set: HashSet<&str> = HashSet::new();
        fn push_held<'a>(held: &mut Vec<&'a str>, held_set: &mut HashSet<&'a str>, id: &'a str) {
            if held.len() < MISSION_TASK_REPORT_ROWS && held_set.insert(id) {
                held.push(id);
            }
        }
        if let Some(rid) = task["report"]["id"].as_str() {
            push_held(&mut held, &mut held_set, rid);
        }
        for r in &newest {
            if r["notificationStatus"] == "pending"
                && let Some(rid) = r["id"].as_str()
            {
                push_held(&mut held, &mut held_set, rid);
            }
        }
        if let Some(slice) = late_slice {
            for r in slice {
                if let Some(rid) = r["id"].as_str() {
                    push_held(&mut held, &mut held_set, rid);
                }
            }
        }
        for r in &newest {
            if let Some(rid) = r["id"].as_str() {
                push_held(&mut held, &mut held_set, rid);
            }
        }
        for id in held {
            kept_report_ids.insert(id);
        }

        let mut bodies = Map::new();
        if own.iter().all(|r| is_full_mission_report(r)) {
            let stripped: Vec<Value> = own
                .iter()
                .map(|r| match r.as_object() {
                    Some(o) => Value::Object(without(o, &["bodies"])),
                    None => (*r).clone(),
                })
                .collect();
            let mut holder = Map::new();
            holder.insert("reports".to_owned(), Value::Array(stripped));
            bodies.extend(describe(&holder, &["reports"]));
        }
        bodies.extend(described(task_obj, TASK_BODY_FIELDS));

        let mut out = without(task_obj, TASK_BODY_FIELDS);
        out.insert("bodies".to_owned(), Value::Object(bodies));
        if let Some(mode) = task.get("executionMode") {
            let compact_mode = if mode["kind"] == "independent" && mode.get("explanation").is_some() {
                let mut m = without(mode.as_object().unwrap(), &["explanation"]);
                let expl = mode["explanation"].as_str().unwrap_or_default();
                m.insert("excerpt".to_owned(), Value::String(mission_excerpt(expl, MISSION_EXCERPT_MAX)));
                Value::Object(m)
            } else {
                mode.clone()
            };
            out.insert("executionMode".to_owned(), compact_mode);
        }
        if let Some(rep) = task.get("report").filter(|v| !v.is_null()) {
            out.insert("report".to_owned(), report_row(template, &tasks_by_key, rep, false));
        }
        if let (Some(slice), Some(full_late)) = (late_slice, late_arr) {
            out.insert(
                "lateReports".to_owned(),
                Value::Array(slice.iter().map(|r| report_row(template, &tasks_by_key, r, false)).collect()),
            );
            let late_count = task["lateReportCount"].as_u64().unwrap_or(full_late.len() as u64);
            out.insert("lateReportCount".to_owned(), Value::from(late_count));
        }
        if let Some(native) = task.get("nativeExecution").and_then(Value::as_object) {
            out.insert("nativeExecution".to_owned(), Value::Object(without(native, &["observations"])));
        }
        out.insert("order".to_owned(), Value::from(position[key] as u64));
        out.insert("dependents".to_owned(), Value::from(*dependents.get(key).unwrap_or(&0) as u64));
        out.insert("reportCount".to_owned(), Value::from(own.len() as u64));
        compact_tasks.push(Value::Object(out));
    }

    let mut compact_reports: Vec<Value> = reports
        .iter()
        .filter(|r| r["id"].as_str().is_some_and(|id| kept_report_ids.contains(id)))
        .map(|r| report_row(template, &tasks_by_key, r, true))
        .collect();
    let taskless: Vec<&Value> = reports
        .iter()
        .filter(|r| r["taskKey"].as_str().is_none_or(|k| !tasks_by_key.contains_key(k)))
        .collect();
    let taskless_start = taskless.len().saturating_sub(MISSION_PINNED_REPORTS);
    for r in &taskless[taskless_start..] {
        compact_reports.push(report_row(template, &tasks_by_key, r, true));
    }

    let mut header = if is_full_mission_map(&map) {
        let mut h = without(map_obj, &["objective", "notes", "summary", "briefing", "frontier", "claims"]);
        h.insert("bodies".to_owned(), Value::Object(described(map_obj, MISSION_BODY_FIELDS)));
        let obj_text = map["objective"].as_str().unwrap_or_default();
        h.insert("excerpt".to_owned(), Value::String(mission_objective_label(obj_text)));
        if let Some(briefing) = map.get("briefing").and_then(Value::as_object) {
            h.insert("briefing".to_owned(), Value::Object(without(briefing, BRIEFING_CONTENT_FIELDS)));
        }
        h
    } else {
        without(map_obj, &["frontier", "claims"])
    };

    let history = map
        .get("history")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|change| {
                    let Some(c_obj) = change.as_object() else { return change.clone() };
                    let mut out = without(c_obj, CHANGE_BODY_FIELDS);
                    out.insert("bodies".to_owned(), Value::Object(described(c_obj, CHANGE_BODY_FIELDS)));
                    if let Some(reason) = c_obj.get("reason").and_then(Value::as_str) {
                        out.insert("excerpt".to_owned(), Value::String(mission_excerpt(reason, MISSION_EXCERPT_MAX)));
                    }
                    Value::Object(out)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let actor_evidence = mission_actor_evidence(&map, tasks, &ordered);
    let mut task_page = json!({
        "order": order_digest,
        "offset": 0,
        "end": window_len,
        "total": ordered.len(),
        "counts": Value::Object(counts),
        "reports": reports.len(),
        "attention": {
            "counts": {
                "notifications": notified.len(),
                "blocked": blocked_count,
                "failed": failed_count,
                "recovery": recovery_count,
            },
            "omitted": omitted_attention.len(),
            "sequence": omitted_seq,
            "keys": omitted_attention.into_iter().take(MISSION_TASK_PAGE).collect::<Vec<_>>(),
        }
    });
    if pins_omitted > 0 {
        task_page["pinsOmitted"] = Value::from(pins_omitted as u64);
    }

    header.insert("tasks".to_owned(), Value::Array(compact_tasks));
    header.insert("reports".to_owned(), Value::Array(compact_reports));
    header.insert("history".to_owned(), Value::Array(history));
    header.insert("actorEvidence".to_owned(), actor_evidence);
    header.insert("taskPage".to_owned(), task_page);
    Value::Object(header)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_mission_map_strips_bodies_paginates_tasks_and_is_idempotent() {
        let mut tasks = Vec::new();
        for i in 0..55 {
            tasks.push(json!({
                "id": format!("tsk_{i}"),
                "key": format!("task-{i}"),
                "title": format!("Task {i}"),
                "brief": format!("Long brief {i}"),
                "role": "specialist",
                "blockedBy": [],
                "status": if i == 54 { "failed" } else { "completed" },
                "createdAt": i,
                "updatedAt": i,
            }));
        }
        let full = json!({
            "version": 1,
            "id": "msn_1",
            "projectID": "prj_1",
            "projectCanonical": "/repo",
            "objective": "Ship compact mission read\nwith clean label",
            "notes": "Large notes body",
            "template": "custom",
            "status": "active",
            "runState": "running",
            "coordinatorSessionId": "ses_coord",
            "revision": 4,
            "actors": [],
            "tasks": tasks,
            "reports": [],
            "frontier": ["task-54"],
            "claims": [],
            "createdAt": 1,
            "updatedAt": 2,
            "history": [{"revision": 2, "reason": "Add tasks", "at": 2}],
            "historyTruncated": false
        });
        let compact = compact_mission_map(full);
        assert!(compact.get("objective").is_none());
        assert!(compact.get("notes").is_none());
        assert!(compact.get("frontier").is_none());
        assert!(compact.get("claims").is_none());
        assert_eq!(compact["excerpt"], "Ship compact mission read\nwith clean label");
        assert!(compact["bodies"]["objective"]["digest"].is_string());
        assert_eq!(compact["taskPage"]["total"], 55);
        assert_eq!(compact["taskPage"]["end"], 50);
        // 50 in window + 1 pinned failed task (task-54)
        assert_eq!(compact["tasks"].as_array().unwrap().len(), 51);
        assert!(compact["tasks"][0].get("brief").is_none());
        assert!(compact["tasks"][0]["bodies"]["brief"]["digest"].is_string());
        assert_eq!(compact["history"][0]["excerpt"], "Add tasks");
        assert!(compact["history"][0].get("reason").is_none());
        // Already-compact map with taskPage passes through unchanged.
        assert_eq!(compact_mission_map(compact.clone()), compact);
    }
}
