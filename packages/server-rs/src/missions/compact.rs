//! Compact Mission display maps (`compactMissionMap` parity with `packages/server`).
//! Operates directly on insertion-ordered `ojson::J` so object-valued body digests match
//! JavaScript `JSON.stringify`, and moves retained fields instead of cloning full maps.
use super::activity::ojson::{self, J};
use super::recovery::NativeCall;
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

fn j_f64(value: Option<&J>) -> f64 {
    match value {
        Some(J::U(n)) => *n as f64,
        Some(J::I(n)) => *n as f64,
        Some(J::F(f)) => *f,
        _ => 0.0,
    }
}

fn j_non_empty(value: Option<&J>) -> bool {
    value.and_then(J::str).is_some_and(|s| !s.trim().is_empty())
}

fn j_is_null(value: Option<&J>) -> bool {
    matches!(value, None | Some(J::Null))
}

fn take_field_ordered(entries: &mut Vec<(String, J)>, key: &str) -> Option<J> {
    let pos = entries.iter().position(|(k, _)| k == key)?;
    Some(entries.remove(pos).1)
}

fn set_field(entries: &mut Vec<(String, J)>, key: &str, value: J) {
    if let Some(slot) = entries.iter_mut().find(|(k, _)| k == key) {
        slot.1 = value;
    } else {
        entries.push((key.to_owned(), value));
    }
}

fn strip_fields(entries: &mut Vec<(String, J)>, fields: &[&str]) {
    entries.retain(|(k, _)| !fields.contains(&k.as_str()));
}

fn content_descriptor(text: &str) -> J {
    ojson::obj(vec![
        ("characters", J::U(ojson::utf16_len(text) as u64)),
        ("digest", J::S(ojson::content_digest(text))),
    ])
}

fn describe_entry(value: &J) -> J {
    if let Some(s) = value.str() {
        content_descriptor(s)
    } else {
        let text = value.stringify();
        content_descriptor(&text)
    }
}

fn describe(owner: &[(String, J)], fields: &[&str]) -> Vec<(String, J)> {
    let mut bodies = Vec::new();
    for &field in fields {
        let Some((_, value)) = owner.iter().find(|(k, _)| k == field) else { continue };
        bodies.push((field.to_owned(), describe_entry(value)));
    }
    bodies
}

fn described_owned(owner: &mut Vec<(String, J)>, fields: &[&str]) -> Vec<(String, J)> {
    let existing = take_field_ordered(owner, "bodies");
    let existing_entries = match existing {
        Some(J::O(entries)) => entries,
        _ => Vec::new(),
    };
    let missing: Vec<&str> = fields
        .iter()
        .copied()
        .filter(|field| !existing_entries.iter().any(|(k, _)| k == field))
        .collect();
    let mut out = describe(owner, &missing);
    for (k, v) in existing_entries {
        set_field(&mut out, &k, v);
    }
    out
}

fn stringify_without_key(value: &J, skip_key: &str, out: &mut String) {
    match value {
        J::O(entries) => {
            out.push('{');
            let mut first = true;
            for (k, v) in entries {
                if k == skip_key {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                ojson::escape(k, out);
                out.push(':');
                out.push_str(&v.stringify());
            }
            out.push('}');
        }
        other => out.push_str(&other.stringify()),
    }
}

fn describe_task_reports(own: &[&J]) -> J {
    let mut out = String::from("[");
    for (idx, report) in own.iter().enumerate() {
        if idx > 0 {
            out.push(',');
        }
        stringify_without_key(report, "bodies", &mut out);
    }
    out.push(']');
    content_descriptor(&out)
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

fn is_full_mission_map(map: &J) -> bool {
    map.get("objective").and_then(J::str).is_some()
}

fn is_full_mission_report(report: &J) -> bool {
    report.get("summary").and_then(J::str).is_some()
}

fn mission_is_running(entries: &[(String, J)]) -> bool {
    let status = entries.iter().find(|(k, _)| k == "status").and_then(|(_, v)| v.str());
    let run_state = entries.iter().find(|(k, _)| k == "runState").and_then(|(_, v)| v.str());
    status == Some("active") && matches!(run_state, None | Some("running"))
}

fn is_coordinator_notification_report(report: &J) -> bool {
    matches!(report.get("delivery").and_then(J::str), None | Some("coordinator-notification"))
}

fn valid_binding_j(binding: &J) -> Option<(u64, &str, &str, &str)> {
    let generation = binding.get("generation")?.count().filter(|&g| g >= 1)?;
    let parent_sid = binding.get("parentSessionID")?.str().filter(|s| !s.trim().is_empty())?;
    let parent_msg = binding.get("parentMessageID")?.str().filter(|s| !s.trim().is_empty())?;
    let tool_call = binding.get("toolCallID")?.str().filter(|s| !s.trim().is_empty())?;
    Some((generation, parent_sid, parent_msg, tool_call))
}

fn execution_evidence_j(task: &J) -> (bool, NativeCall, bool) {
    let original = task.get("nativeBinding").filter(|v| !matches!(v, J::Null));
    let current = task.get("nativeExecution").filter(|v| !matches!(v, J::Null));
    let mut native_call = NativeCall::None;
    if original.is_some() || current.is_some() {
        native_call = NativeCall::Unknown;
        if let (Some(orig), Some(cur)) = (original, current)
            && let Some(cur_binding) = cur.get("binding")
            && let (Some((o_gen, o_psid, o_pmid, o_tcid)), Some((c_gen, c_psid, c_pmid, c_tcid))) =
                (valid_binding_j(orig), valid_binding_j(cur_binding))
            && task
                .get("contractGeneration")
                .filter(|v| !matches!(v, J::Null))
                .is_none_or(|cg| cg.count() == Some(o_gen))
            && c_gen == o_gen
            && c_psid == o_psid
            && (c_tcid == o_tcid) == (c_pmid == o_pmid)
        {
            let conflict = cur.get("observationConflict").and_then(J::bool) == Some(true);
            let non_foreground = cur
                .get("launch")
                .filter(|v| !matches!(v, J::Null))
                .is_some_and(|l| l.get("mode").and_then(J::str) != Some("foreground"));
            native_call = if conflict || non_foreground {
                NativeCall::Unknown
            } else if j_is_null(cur.get("ended")) {
                NativeCall::Active
            } else if matches!(cur.get("ended").and_then(J::str), Some("returned" | "error")) {
                NativeCall::Ended
            } else {
                NativeCall::Unknown
            };
        }
    }
    let outstanding = task.get("outstandingExecution").and_then(J::bool) == Some(true);
    let has_execution = j_non_empty(task.get("actorSessionId"))
        && (outstanding || j_non_empty(task.get("admissionId")) || original.and_then(valid_binding_j).is_some());
    let missing_report = has_execution
        && j_is_null(task.get("report"))
        && !task.get("lateReports").and_then(J::arr).is_some_and(|a| !a.is_empty())
        && (matches!(task.get("status").and_then(J::str), Some("queued" | "dispatching")) || outstanding);
    (has_execution, native_call, missing_report)
}

fn valid_native_id(v: &J) -> bool {
    v.str().is_some_and(|s| {
        !s.is_empty() && s.len() <= 240 && !s.chars().any(|c| c.is_whitespace() || c.is_control())
    })
}

fn valid_decision_text(v: &J) -> bool {
    v.str().is_some_and(|s| (1..=20_000).contains(&ojson::utf16_len(s)))
}

fn valid_field_key(v: &J) -> bool {
    v.str().is_some_and(|s| {
        let Some(rest) = s.strip_prefix('q') else { return false };
        rest == "0"
            || ((1..=2).contains(&rest.len())
                && rest.bytes().next().is_some_and(|b| (b'1'..=b'9').contains(&b))
                && rest.bytes().all(|b| b.is_ascii_digit()))
    })
}

fn valid_safe_pos_int(v: &J) -> bool {
    v.count().is_some_and(|n| n >= 1)
}

fn valid_contract_ref(v: &J) -> bool {
    v.obj().is_some_and(|o| {
        o.len() == 3
            && v.get("missionID").is_some_and(valid_native_id)
            && v.get("taskKey").is_some_and(valid_native_id)
            && v.get("generation").is_some_and(valid_safe_pos_int)
    })
}

fn valid_human_decision_artifact(v: &J, require_native_form: bool) -> bool {
    let Some(o) = v.obj() else { return false };
    if o.iter()
        .any(|(k, _)| !matches!(k.as_str(), "kind" | "decidedBy" | "question" | "answer" | "provenance"))
        || v.get("kind").and_then(J::str) != Some("decision")
        || v.get("decidedBy").is_some_and(|d| d.str() != Some("human"))
        || !v.get("question").is_some_and(valid_decision_text)
    {
        return false;
    }
    let answer_ok = v.get("answer").is_some_and(|a| {
        valid_decision_text(a)
            || a.arr().is_some_and(|arr| (1..=32).contains(&arr.len()) && arr.iter().all(valid_decision_text))
    });
    if !answer_ok {
        return false;
    }
    let Some(prov) = v.get("provenance") else { return false };
    let Some(prov_entries) = prov.obj() else { return false };
    let kind = prov.get("kind").and_then(J::str);
    let base_ok = prov.get("contract").is_some_and(valid_contract_ref)
        && prov.get("sessionID").is_some_and(valid_native_id)
        && prov.get("formID").is_some_and(valid_native_id)
        && prov.get("messageID").is_some_and(valid_native_id)
        && prov.get("toolCallID").is_some_and(valid_native_id)
        && prov.get("fieldKey").is_some_and(valid_field_key);
    match kind {
        Some("native-form-answer") => {
            prov_entries.len() == 8
                && base_ok
                && prov.get("nativeCall").is_some_and(|nc| {
                    nc.obj().is_some_and(|entries| entries.len() == 4)
                        && nc.get("generation").is_some_and(valid_safe_pos_int)
                        && nc.get("parentSessionID").is_some_and(valid_native_id)
                        && nc.get("parentMessageID").is_some_and(valid_native_id)
                        && nc.get("toolCallID").is_some_and(valid_native_id)
                })
        }
        Some("coordinator-form-answer") if !require_native_form => prov_entries.len() == 7 && base_ok,
        _ => false,
    }
}

fn valid_coordinator_decision_artifact(v: &J) -> bool {
    let Some(o) = v.obj() else { return false };
    o.iter().all(|(k, _)| {
        matches!(k.as_str(), "kind" | "decidedBy" | "question" | "decision" | "rationale" | "alternatives" | "reversal")
    }) && v.get("kind").and_then(J::str) == Some("decision")
        && v.get("decidedBy").and_then(J::str) == Some("coordinator")
        && v.get("question").is_some_and(valid_decision_text)
        && v.get("decision").is_some_and(valid_decision_text)
        && v.get("rationale").is_some_and(valid_decision_text)
        && v.get("alternatives").is_none_or(|a| {
            a.arr().is_some_and(|arr| arr.len() <= 16 && arr.iter().all(valid_decision_text))
        })
        && v.get("reversal").is_none_or(valid_decision_text)
}

struct TaskRoleMeta {
    is_wayfinder_native_decision: bool,
}

fn mission_decision_maker(template: &str, task: Option<&TaskRoleMeta>, report: &J) -> Option<&'static str> {
    let task = task?;
    if template != "wayfinder"
        || !task.is_wayfinder_native_decision
        || report.get("outcome").and_then(J::str) != Some("completed")
    {
        return None;
    }
    let artifact = report.get("artifact")?;
    match report.get("delivery").and_then(J::str) {
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

fn mission_task_order(tasks: &[J]) -> Vec<usize> {
    let mut index: HashMap<&str, usize> = HashMap::new();
    let mut unique = Vec::new();
    for (pos, task) in tasks.iter().enumerate() {
        let key = task.get("key").and_then(J::str).unwrap_or_default();
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
        if let Some(blocked) = tasks[pos].get("blockedBy").and_then(J::arr) {
            for dep in blocked.iter().filter_map(J::str) {
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

fn compact_report_owned(
    template: &str,
    task_roles: &HashMap<String, TaskRoleMeta>,
    mut value: J,
    bodies: bool,
) -> J {
    if !is_full_mission_report(&value) {
        if !bodies && let J::O(entries) = &mut value {
            strip_fields(entries, &["bodies"]);
        }
        return value;
    }
    let task_meta = value.get("taskKey").and_then(J::str).and_then(|k| task_roles.get(k));
    let decided_by = mission_decision_maker(template, task_meta, &value);
    let summary_excerpt = mission_excerpt(value.get("summary").and_then(J::str).unwrap_or_default(), MISSION_EXCERPT_MAX);
    let J::O(mut entries) = value else { return value };
    let body_descriptors = if bodies { Some(described_owned(&mut entries, REPORT_BODY_FIELDS)) } else { None };
    strip_fields(&mut entries, REPORT_BODY_FIELDS);
    set_field(&mut entries, "excerpt", J::S(summary_excerpt));
    if let Some(maker) = decided_by {
        set_field(&mut entries, "decidedBy", J::S(maker.to_owned()));
    }
    if let Some(desc) = body_descriptors {
        set_field(&mut entries, "bodies", J::O(desc));
    }
    J::O(entries)
}

fn mission_actor_evidence(entries: &[(String, J)], reports: &[J], tasks: &[J], ordered: &[usize]) -> J {
    let mut report_owed: Vec<J> = Vec::new();
    let mut report_owed_set: HashSet<String> = HashSet::new();
    let mut call_open: Vec<J> = Vec::new();
    let mut call_open_set: HashSet<String> = HashSet::new();
    if mission_is_running(entries)
        && !reports.iter().any(|r| {
            r.get("notificationStatus").and_then(J::str) == Some("pending") && is_coordinator_notification_report(r)
        })
        && let Some(coord) = entries.iter().find(|(k, _)| k == "coordinatorSessionId").and_then(|(_, v)| v.str())
        && report_owed_set.insert(coord.to_owned())
    {
        report_owed.push(J::S(coord.to_owned()));
    }
    for &idx in ordered {
        let task = &tasks[idx];
        let Some(sid) = task.get("actorSessionId").and_then(J::str).filter(|s| !s.is_empty()) else {
            continue;
        };
        let (_, native_call, missing_report) = execution_evidence_j(task);
        if missing_report && report_owed_set.insert(sid.to_owned()) {
            report_owed.push(J::S(sid.to_owned()));
        }
        if matches!(native_call, NativeCall::Active | NativeCall::Unknown) && call_open_set.insert(sid.to_owned()) {
            call_open.push(J::S(sid.to_owned()));
        }
    }
    ojson::obj(vec![("reportOwed", J::A(report_owed)), ("callOpen", J::A(call_open))])
}

/// Compact a Mission map (`ojson::J`) for `GET /api/workspaces/:id/missions/:missionID` display reads.
/// Maps that are already compact with a `taskPage` are returned unchanged.
pub(super) fn compact_mission_j(map: J) -> J {
    let full = is_full_mission_map(&map);
    if !full && !j_is_null(map.get("taskPage")) {
        return map;
    }
    let J::O(mut entries) = map else { return map };
    let mut tasks = match take_field_ordered(&mut entries, "tasks") {
        Some(J::A(items)) => items,
        _ => Vec::new(),
    };
    let reports = match take_field_ordered(&mut entries, "reports") {
        Some(J::A(items)) => items,
        _ => Vec::new(),
    };
    let template = entries
        .iter()
        .find(|(k, _)| k == "template")
        .and_then(|(_, v)| v.str())
        .unwrap_or_default()
        .to_owned();

    let ordered = mission_task_order(&tasks);
    let mut position: HashMap<String, usize> = HashMap::with_capacity(ordered.len());
    let mut ordered_keys: Vec<J> = Vec::with_capacity(ordered.len());
    let mut by_key: HashMap<String, usize> = HashMap::with_capacity(ordered.len());
    let mut task_roles: HashMap<String, TaskRoleMeta> = HashMap::with_capacity(tasks.len());
    for task in &tasks {
        if let Some(k) = task.get("key").and_then(J::str) {
            task_roles.insert(
                k.to_owned(),
                TaskRoleMeta {
                    is_wayfinder_native_decision: task.get("role").and_then(J::str) == Some("decision")
                        && task.get("executionMode").and_then(|m| m.get("kind")).and_then(J::str) == Some("native"),
                },
            );
        }
    }
    for (pos, &idx) in ordered.iter().enumerate() {
        let key = tasks[idx].get("key").and_then(J::str).unwrap_or_default();
        position.insert(key.to_owned(), pos);
        ordered_keys.push(J::S(key.to_owned()));
        by_key.insert(key.to_owned(), idx);
    }
    let mut dependents: HashMap<String, usize> = HashMap::new();
    let mut counts: Vec<(String, J)> = Vec::new();
    for &idx in &ordered {
        let task = &tasks[idx];
        if let Some(status) = task.get("status").and_then(J::str) {
            if let Some((_, J::U(n))) = counts.iter_mut().find(|(k, _)| k == status) {
                *n += 1;
            } else {
                counts.push((status.to_owned(), J::U(1)));
            }
        }
        if let Some(blocked) = task.get("blockedBy").and_then(J::arr) {
            let mut seen = HashSet::new();
            for dep in blocked.iter().filter_map(J::str) {
                if position.contains_key(dep) && seen.insert(dep) {
                    *dependents.entry(dep.to_owned()).or_insert(0) += 1;
                }
            }
        }
    }
    let order_digest = ojson::content_digest(&J::A(ordered_keys).stringify());

    // Attention priority: pending notifications, needs-input/failed (newest first), missing reports.
    let mut attention_keys: Vec<String> = Vec::new();
    let mut attention_set: HashSet<String> = HashSet::new();
    let mut notified: HashSet<String> = HashSet::new();
    for r in &reports {
        if r.get("notificationStatus").and_then(J::str) == Some("pending")
            && let Some(k) = r.get("taskKey").and_then(J::str)
            && position.contains_key(k)
        {
            if notified.insert(k.to_owned()) && attention_set.insert(k.to_owned()) {
                attention_keys.push(k.to_owned());
            }
        }
    }
    let mut blocked_count = 0usize;
    let mut failed_count = 0usize;
    let mut blocked_or_failed: Vec<(usize, f64, bool)> = ordered
        .iter()
        .copied()
        .filter_map(|idx| {
            let task = &tasks[idx];
            match task.get("status").and_then(J::str) {
                Some("failed") => Some((idx, j_f64(task.get("updatedAt")), true)),
                Some("needs-input") => Some((idx, j_f64(task.get("updatedAt")), false)),
                _ => None,
            }
        })
        .collect();
    blocked_or_failed.sort_by(|a, b| b.1.total_cmp(&a.1));
    for (idx, _, is_failed) in blocked_or_failed {
        if is_failed {
            failed_count += 1;
        } else {
            blocked_count += 1;
        }
        if let Some(k) = tasks[idx].get("key").and_then(J::str)
            && attention_set.insert(k.to_owned())
        {
            attention_keys.push(k.to_owned());
        }
    }
    let mut recovery_count = 0usize;
    for &idx in &ordered {
        let task = &tasks[idx];
        if task.get("actorSessionId").and_then(J::str).is_some_and(|s| !s.is_empty())
            && execution_evidence_j(task).2
        {
            recovery_count += 1;
            if let Some(k) = task.get("key").and_then(J::str)
                && attention_set.insert(k.to_owned())
            {
                attention_keys.push(k.to_owned());
            }
        }
    }

    // Shown tasks: first MISSION_TASK_PAGE + up to MISSION_TASK_PINS pinned candidates.
    let window_len = ordered.len().min(MISSION_TASK_PAGE);
    let window = &ordered[..window_len];
    let in_window: HashSet<String> = window
        .iter()
        .filter_map(|&idx| tasks[idx].get("key").and_then(J::str).map(str::to_owned))
        .collect();
    let mut candidates: Vec<String> = Vec::new();
    let mut candidate_set: HashSet<String> = HashSet::new();
    for k in &attention_keys {
        if by_key.contains_key(k) && !in_window.contains(k) && candidate_set.insert(k.clone()) {
            candidates.push(k.clone());
        }
    }
    let mut report_order: Vec<(usize, f64)> = reports
        .iter()
        .enumerate()
        .map(|(i, r)| (i, j_f64(r.get("createdAt"))))
        .collect();
    report_order.sort_by(|a, b| b.1.total_cmp(&a.1));
    for &(ri, _) in report_order.iter().take(MISSION_PINNED_REPORTS) {
        if let Some(k) = reports[ri].get("taskKey").and_then(J::str)
            && by_key.contains_key(k)
            && !in_window.contains(k)
            && candidate_set.insert(k.to_owned())
        {
            candidates.push(k.to_owned());
        }
    }
    if full
        && let Some((_, briefing)) = entries.iter().find(|(k, _)| k == "briefing")
    {
        for section in ["achieved", "ongoing", "obstacles", "next"] {
            if let Some(items) = briefing.get(section).and_then(J::arr) {
                for item in items {
                    if let Some(tkeys) = item.get("taskKeys").and_then(J::arr) {
                        for k in tkeys.iter().filter_map(J::str) {
                            if by_key.contains_key(k)
                                && !in_window.contains(k)
                                && candidate_set.insert(k.to_owned())
                            {
                                candidates.push(k.to_owned());
                            }
                        }
                    }
                }
            }
        }
    }
    let pinned_len = candidates.len().min(MISSION_TASK_PINS);
    let pinned_keys: HashSet<&str> = candidates[..pinned_len].iter().map(String::as_str).collect();
    let pins_omitted = candidates.len().saturating_sub(MISSION_TASK_PINS);
    let omitted_attention: Vec<String> = attention_keys
        .iter()
        .filter(|k| !in_window.contains(k.as_str()) && !pinned_keys.contains(k.as_str()))
        .cloned()
        .collect();
    let omitted_seq = ojson::content_digest(
        &J::A(omitted_attention.iter().map(|k| J::S(k.clone())).collect()).stringify(),
    );

    let mut selected_indices: Vec<usize> = Vec::with_capacity(window.len() + pinned_len);
    let mut selected_set: HashSet<usize> = HashSet::new();
    for &idx in window {
        if selected_set.insert(idx) {
            selected_indices.push(idx);
        }
    }
    for k in &candidates[..pinned_len] {
        if let Some(&idx) = by_key.get(k)
            && selected_set.insert(idx)
        {
            selected_indices.push(idx);
        }
    }
    selected_indices.sort_by_key(|&idx| position[tasks[idx].get("key").and_then(J::str).unwrap_or_default()]);

    let actor_evidence = mission_actor_evidence(&entries, &reports, &tasks, &ordered);

    let mut reports_of: HashMap<String, Vec<usize>> = HashMap::new();
    for (ri, r) in reports.iter().enumerate() {
        if let Some(k) = r.get("taskKey").and_then(J::str) {
            reports_of.entry(k.to_owned()).or_default().push(ri);
        }
    }

    let mut kept_report_ids: HashSet<String> = HashSet::new();
    let mut compact_tasks: Vec<J> = Vec::with_capacity(selected_indices.len());
    for idx in selected_indices {
        // Move the task out of `tasks` (replacing with Null) so retained fields are moved, not cloned.
        let task = std::mem::replace(&mut tasks[idx], J::Null);
        let J::O(mut task_entries) = task else { continue };
        let key = task_entries
            .iter()
            .find(|(k, _)| k == "key")
            .and_then(|(_, v)| v.str())
            .unwrap_or_default()
            .to_owned();
        let own_indices = reports_of.get(&key).map(Vec::as_slice).unwrap_or(&[]);
        let mut newest: Vec<(usize, f64)> = own_indices
            .iter()
            .map(|&ri| (ri, j_f64(reports[ri].get("createdAt"))))
            .collect();
        newest.sort_by(|a, b| b.1.total_cmp(&a.1));

        let mut held: Vec<String> = Vec::new();
        let mut held_set: HashSet<String> = HashSet::new();
        fn push_held(held: &mut Vec<String>, held_set: &mut HashSet<String>, id: &str) {
            if held.len() < MISSION_TASK_REPORT_ROWS && held_set.insert(id.to_owned()) {
                held.push(id.to_owned());
            }
        }
        if let Some(rid) = task_entries
            .iter()
            .find(|(k, _)| k == "report")
            .and_then(|(_, v)| v.get("id"))
            .and_then(J::str)
        {
            push_held(&mut held, &mut held_set, rid);
        }
        for &(ri, _) in &newest {
            if reports[ri].get("notificationStatus").and_then(J::str) == Some("pending")
                && let Some(rid) = reports[ri].get("id").and_then(J::str)
            {
                push_held(&mut held, &mut held_set, rid);
            }
        }
        let late_total = task_entries
            .iter()
            .find(|(k, _)| k == "lateReports")
            .and_then(|(_, v)| v.arr())
            .map(|a| {
                let start = a.len().saturating_sub(MISSION_LATE_REPORT_ROWS);
                for r in &a[start..] {
                    if let Some(rid) = r.get("id").and_then(J::str) {
                        push_held(&mut held, &mut held_set, rid);
                    }
                }
                a.len()
            });
        for &(ri, _) in &newest {
            if let Some(rid) = reports[ri].get("id").and_then(J::str) {
                push_held(&mut held, &mut held_set, rid);
            }
        }
        for id in held {
            kept_report_ids.insert(id);
        }

        let mut bodies: Vec<(String, J)> = Vec::new();
        let own_refs: Vec<&J> = own_indices.iter().map(|&ri| &reports[ri]).collect();
        if own_refs.iter().all(|r| is_full_mission_report(r)) {
            bodies.push(("reports".to_owned(), describe_task_reports(&own_refs)));
        }
        for (k, v) in described_owned(&mut task_entries, TASK_BODY_FIELDS) {
            set_field(&mut bodies, &k, v);
        }

        let execution_mode = take_field_ordered(&mut task_entries, "executionMode");
        let task_report = take_field_ordered(&mut task_entries, "report");
        let late_reports = take_field_ordered(&mut task_entries, "lateReports");
        let native_execution = take_field_ordered(&mut task_entries, "nativeExecution");
        strip_fields(&mut task_entries, TASK_BODY_FIELDS);
        set_field(&mut task_entries, "bodies", J::O(bodies));

        if let Some(mode) = execution_mode {
            let compact_mode = match mode {
                J::O(mut mode_entries)
                    if mode_entries.iter().any(|(k, v)| k == "kind" && v.str() == Some("independent"))
                        && mode_entries.iter().any(|(k, _)| k == "explanation") =>
                {
                    let expl = take_field_ordered(&mut mode_entries, "explanation");
                    let excerpt = mission_excerpt(
                        expl.as_ref().and_then(J::str).unwrap_or_default(),
                        MISSION_EXCERPT_MAX,
                    );
                    set_field(&mut mode_entries, "excerpt", J::S(excerpt));
                    J::O(mode_entries)
                }
                other => other,
            };
            set_field(&mut task_entries, "executionMode", compact_mode);
        }
        if let Some(rep) = task_report
            && !matches!(rep, J::Null)
        {
            set_field(
                &mut task_entries,
                "report",
                compact_report_owned(&template, &task_roles, rep, false),
            );
        }
        if let (Some(J::A(mut full_late)), Some(total)) = (late_reports, late_total) {
            let start = full_late.len().saturating_sub(MISSION_LATE_REPORT_ROWS);
            let compact_late: Vec<J> = full_late
                .drain(start..)
                .map(|r| compact_report_owned(&template, &task_roles, r, false))
                .collect();
            let late_count = task_entries
                .iter()
                .find(|(k, _)| k == "lateReportCount")
                .and_then(|(_, v)| v.count())
                .unwrap_or(total as u64);
            set_field(&mut task_entries, "lateReports", J::A(compact_late));
            set_field(&mut task_entries, "lateReportCount", J::U(late_count));
        }
        if let Some(J::O(mut native_entries)) = native_execution {
            strip_fields(&mut native_entries, &["observations"]);
            set_field(&mut task_entries, "nativeExecution", J::O(native_entries));
        }
        set_field(&mut task_entries, "order", J::U(position[&key] as u64));
        set_field(&mut task_entries, "dependents", J::U(*dependents.get(&key).unwrap_or(&0) as u64));
        set_field(&mut task_entries, "reportCount", J::U(own_indices.len() as u64));
        compact_tasks.push(J::O(task_entries));
    }
    drop(tasks);

    let report_total = reports.len() as u64;
    let taskless_indices: Vec<usize> = reports
        .iter()
        .enumerate()
        .filter(|(_, r)| r.get("taskKey").and_then(J::str).is_none_or(|k| !task_roles.contains_key(k)))
        .map(|(i, _)| i)
        .collect();
    let taskless_start = taskless_indices.len().saturating_sub(MISSION_PINNED_REPORTS);
    let taskless_keep: HashSet<usize> = taskless_indices[taskless_start..].iter().copied().collect();

    let mut compact_reports: Vec<J> = Vec::new();
    let mut compact_taskless: Vec<J> = Vec::new();
    for (idx, r) in reports.into_iter().enumerate() {
        let kept_by_id = r.get("id").and_then(J::str).is_some_and(|id| kept_report_ids.contains(id));
        let kept_taskless = taskless_keep.contains(&idx);
        if kept_by_id {
            if kept_taskless {
                let row = compact_report_owned(&template, &task_roles, r, true);
                compact_taskless.push(row.clone());
                compact_reports.push(row);
            } else {
                compact_reports.push(compact_report_owned(&template, &task_roles, r, true));
            }
        } else if kept_taskless {
            compact_taskless.push(compact_report_owned(&template, &task_roles, r, true));
        }
    }
    compact_reports.extend(compact_taskless);

    let history_raw = match take_field_ordered(&mut entries, "history") {
        Some(J::A(items)) => items,
        _ => Vec::new(),
    };
    let history: Vec<J> = history_raw
        .into_iter()
        .map(|change| match change {
            J::O(mut c_entries) => {
                let bodies = described_owned(&mut c_entries, CHANGE_BODY_FIELDS);
                let reason = take_field_ordered(&mut c_entries, "reason");
                strip_fields(&mut c_entries, CHANGE_BODY_FIELDS);
                set_field(&mut c_entries, "bodies", J::O(bodies));
                if let Some(J::S(text)) = reason {
                    set_field(&mut c_entries, "excerpt", J::S(mission_excerpt(&text, MISSION_EXCERPT_MAX)));
                }
                J::O(c_entries)
            }
            other => other,
        })
        .collect();

    if full {
        let bodies = described_owned(&mut entries, MISSION_BODY_FIELDS);
        let obj_text = take_field_ordered(&mut entries, "objective");
        let briefing = take_field_ordered(&mut entries, "briefing");
        strip_fields(&mut entries, &["objective", "notes", "summary", "briefing", "frontier", "claims"]);
        set_field(&mut entries, "bodies", J::O(bodies));
        let label = mission_objective_label(obj_text.as_ref().and_then(J::str).unwrap_or_default());
        set_field(&mut entries, "excerpt", J::S(label));
        if let Some(J::O(mut b_entries)) = briefing {
            strip_fields(&mut b_entries, BRIEFING_CONTENT_FIELDS);
            set_field(&mut entries, "briefing", J::O(b_entries));
        }
    } else {
        strip_fields(&mut entries, &["frontier", "claims"]);
    }

    let mut task_page_entries = vec![
        ("order", J::S(order_digest)),
        ("offset", J::U(0)),
        ("end", J::U(window_len as u64)),
        ("total", J::U(ordered.len() as u64)),
        ("counts", J::O(counts)),
        ("reports", J::U(report_total)),
        (
            "attention",
            ojson::obj(vec![
                (
                    "counts",
                    ojson::obj(vec![
                        ("notifications", J::U(notified.len() as u64)),
                        ("blocked", J::U(blocked_count as u64)),
                        ("failed", J::U(failed_count as u64)),
                        ("recovery", J::U(recovery_count as u64)),
                    ]),
                ),
                ("omitted", J::U(omitted_attention.len() as u64)),
                ("sequence", J::S(omitted_seq)),
                (
                    "keys",
                    J::A(omitted_attention.into_iter().take(MISSION_TASK_PAGE).map(J::S).collect()),
                ),
            ]),
        ),
    ];
    if pins_omitted > 0 {
        task_page_entries.push(("pinsOmitted", J::U(pins_omitted as u64)));
    }

    set_field(&mut entries, "tasks", J::A(compact_tasks));
    set_field(&mut entries, "reports", J::A(compact_reports));
    set_field(&mut entries, "history", J::A(history));
    set_field(&mut entries, "actorEvidence", actor_evidence);
    set_field(&mut entries, "taskPage", ojson::obj(task_page_entries));
    J::O(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_mission_map_strips_bodies_paginates_tasks_and_is_idempotent() {
        let mut tasks = Vec::new();
        for i in 0..55u64 {
            tasks.push(ojson::obj(vec![
                ("id", J::S(format!("tsk_{i}"))),
                ("key", J::S(format!("task-{i}"))),
                ("title", J::S(format!("Task {i}"))),
                ("brief", J::S(format!("Long brief {i}"))),
                ("role", J::S("specialist".into())),
                ("blockedBy", J::A(Vec::new())),
                ("status", J::S(if i == 54 { "failed" } else { "completed" }.into())),
                ("createdAt", J::U(i)),
                ("updatedAt", J::U(i)),
            ]));
        }
        let full = ojson::obj(vec![
            ("version", J::U(1)),
            ("id", J::S("msn_1".into())),
            ("projectID", J::S("prj_1".into())),
            ("projectCanonical", J::S("/repo".into())),
            ("objective", J::S("Ship compact mission read\nwith clean label".into())),
            ("notes", J::S("Large notes body".into())),
            ("template", J::S("custom".into())),
            ("status", J::S("active".into())),
            ("runState", J::S("running".into())),
            ("coordinatorSessionId", J::S("ses_coord".into())),
            ("revision", J::U(4)),
            ("actors", J::A(Vec::new())),
            ("tasks", J::A(tasks)),
            ("reports", J::A(Vec::new())),
            ("frontier", J::A(vec![J::S("task-54".into())])),
            ("claims", J::A(Vec::new())),
            ("createdAt", J::U(1)),
            ("updatedAt", J::U(2)),
            (
                "history",
                J::A(vec![ojson::obj(vec![
                    ("revision", J::U(2)),
                    ("reason", J::S("Add tasks".into())),
                    ("at", J::U(2)),
                ])]),
            ),
            ("historyTruncated", J::Bool(false)),
        ]);
        let compact = compact_mission_j(full);
        assert!(compact.get("objective").is_none());
        assert!(compact.get("notes").is_none());
        assert!(compact.get("frontier").is_none());
        assert!(compact.get("claims").is_none());
        assert_eq!(
            compact.get("excerpt").and_then(J::str),
            Some("Ship compact mission read\nwith clean label")
        );
        assert!(compact.get("bodies").and_then(|b| b.get("objective")).and_then(|o| o.get("digest")).and_then(J::str).is_some());
        assert_eq!(compact.get("taskPage").and_then(|p| p.get("total")).and_then(J::count), Some(55));
        assert_eq!(compact.get("taskPage").and_then(|p| p.get("end")).and_then(J::count), Some(50));
        assert_eq!(compact.get("tasks").and_then(J::arr).unwrap().len(), 51);
        assert!(compact.get("tasks").and_then(J::arr).unwrap()[0].get("brief").is_none());
        assert_eq!(
            compact.get("history").and_then(J::arr).unwrap()[0].get("excerpt").and_then(J::str),
            Some("Add tasks")
        );
        // Already-compact map with taskPage passes through unchanged.
        assert_eq!(compact_mission_j(compact.clone()), compact);
    }

    #[test]
    fn compact_mission_preserves_wire_key_order_for_structured_body_digests() {
        // Key order in wire JSON is NOT alphabetical: kind -> reason -> explanation.
        let raw_mode = r#"{"kind":"independent","reason":"lifetime","explanation":"Needs isolated root"}"#;
        let wire = format!(
            r#"{{"version":1,"id":"msn_1","projectID":"prj_1","projectCanonical":"/repo","objective":"Obj","template":"custom","status":"active","runState":"running","coordinatorSessionId":"ses_coord","revision":1,"actors":[],"tasks":[{{"id":"tsk_1","key":"k1","title":"T1","brief":"B1","role":"specialist","blockedBy":[],"status":"ready","executionMode":{raw_mode},"createdAt":1,"updatedAt":1}}],"reports":[],"frontier":[],"claims":[],"createdAt":1,"updatedAt":1,"history":[],"historyTruncated":false}}"#
        );
        let parsed = ojson::parse(wire.as_bytes()).expect("valid JSON");
        let compact = compact_mission_j(parsed);
        let digest = compact
            .get("tasks")
            .and_then(J::arr)
            .unwrap()[0]
            .get("bodies")
            .and_then(|b| b.get("executionMode"))
            .and_then(|d| d.get("digest"))
            .and_then(J::str)
            .unwrap();
        assert_eq!(
            digest,
            ojson::content_digest(raw_mode),
            "structured body digest must match JS JSON.stringify wire key order"
        );
    }
}
