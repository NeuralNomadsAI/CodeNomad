//! Daily recurrence wire contract (reference `missions/recurrence-*.ts`,
//! `mission-current-source.ts`): strict validators of every native output the
//! routes publish, with the reference's cross-field refinements, plus the
//! canonical JSON/digest helpers shared with the native plugin.
use hmac::{Hmac, Mac};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub(crate) const SAFE: u64 = 9_007_199_254_740_991;
pub(crate) const PANEL_PAGE_BYTES: usize = 64 * 1024;
pub(crate) const PANEL_REQUEST_BYTES: usize = 16 * 1024;
pub(crate) const ACTIONS: [&str; 6] = ["play", "pause", "stop", "resume", "run-now", "check"];

/// `canonicalAuthority`: sorted keys at every depth, JSON.stringify scalars.
pub(crate) fn canonical(v: &Value) -> String {
    fn visit(v: &Value, out: &mut String) {
        match v {
            Value::Object(o) => {
                let mut keys: Vec<&String> = o.keys().collect();
                keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                out.push('{');
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap_or_default());
                    out.push(':');
                    visit(&o[*k], out);
                }
                out.push('}');
            }
            Value::Array(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    visit(x, out);
                }
                out.push(']');
            }
            other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
        }
    }
    let mut out = String::new();
    visit(v, &mut out);
    out
}
pub(crate) fn sha(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
/// `authorityDigest` / `recurrenceConfigDigest`.
pub(crate) fn digest(v: &Value) -> String {
    sha(&canonical(v))
}
/// `signNativeRecurrenceControl`.
pub(crate) fn sign(v: &Value, key: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC key");
    mac.update(canonical(v).as_bytes());
    format!("{:x}", mac.finalize().into_bytes())
}
/// `stableToken`: hex SHA-256 prefix.
pub(crate) fn token(text: &str, n: usize) -> String {
    sha(text)[..n].to_owned()
}
pub(crate) fn schedule_id(project: &str, canonical: &str, request: &str) -> String {
    format!("rcs_{}", token(&format!("{project}\0{canonical}\0{request}"), 40))
}
/// `missionPanelBytes`: UTF-8 bytes of the JSON encoding.
pub(crate) fn bytes(v: &Value) -> usize {
    serde_json::to_string(v).map_or(usize::MAX, |s| s.len())
}
pub(crate) fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `recurrenceIDSchema`: `^[A-Za-z0-9_-]{3,100}$`.
pub(crate) fn rid(s: &str) -> bool {
    (3..=100).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
/// Stored native identifiers: `^[A-Za-z0-9_.:-]+$`, 1..240.
pub(crate) fn nid(s: &str) -> bool {
    (1..=240).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}
fn digest43(s: &str) -> bool {
    s.len() == 43 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn text(v: &Value, min: usize, max: usize) -> bool {
    v.as_str().is_some_and(|s| (min..=max).contains(&units(s)))
}
fn counter(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n <= SAFE)
}
fn positive(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| (1..=SAFE).contains(&n))
}
fn one_of(v: &Value, items: &[&str]) -> bool {
    v.as_str().is_some_and(|s| items.contains(&s))
}
fn object<'a>(v: &'a Value, keys: &[&str], required: &[&str]) -> Option<&'a Map<String, Value>> {
    let o = v.as_object()?;
    (o.keys().all(|k| keys.contains(&k.as_str())) && required.iter().all(|k| o.contains_key(*k))).then_some(o)
}
/// Optional field: absent, or present and valid.
fn opt(o: &Map<String, Value>, key: &str, check: impl Fn(&Value) -> bool) -> bool {
    o.get(key).is_none_or(check)
}
/// `{ directory, workspaceID? }`, strict.
pub(crate) fn location(v: &Value, max: usize) -> bool {
    object(v, &["directory", "workspaceID"], &["directory"])
        .is_some_and(|o| text(&o["directory"], 1, max) && opt(o, "workspaceID", Value::is_string))
}
/// `sameLocation`.
pub(crate) fn same_location(a: &Value, directory: &str) -> bool {
    a["directory"] == directory && a.get("workspaceID").is_none()
}

/// `dailyClockSchema`: `HH:MM` and a standing civil zone (no offsets), as `Intl` accepts it.
pub(crate) fn clock(v: &Value) -> bool {
    let Some(o) = object(v, &["time", "zone"], &["time", "zone"]) else {
        return false;
    };
    let time = o["time"].as_str().is_some_and(|t| {
        let b = t.as_bytes();
        b.len() == 5
            && b[2] == b':'
            && matches!((b[0], b[1]), (b'0'..=b'1', b'0'..=b'9') | (b'2', b'0'..=b'3'))
            && (b'0'..=b'5').contains(&b[3])
            && b[4].is_ascii_digit()
    });
    time && o["zone"].as_str().is_some_and(zone)
}
/// `^[A-Za-z_]+(?:/[A-Za-z0-9_+-]+)*$`, then `Intl.DateTimeFormat` acceptance.
pub(crate) fn zone(z: &str) -> bool {
    let mut parts = z.split('/');
    let head = parts.next().unwrap_or_default();
    (1..=100).contains(&units(z))
        && !head.is_empty()
        && head.bytes().all(|b| b.is_ascii_alphabetic() || b == b'_')
        && parts.all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-')))
        && crate::missions::time_zone::valid(z)
}

/// `recurrenceControlStateMatches`.
pub(crate) fn state_matches(action: &str, state: &Value) -> bool {
    match action {
        "check" => state == "paused" || state == "stopped",
        "play" | "resume" => state == "running",
        "pause" => state == "paused",
        "stop" => state == "stopped",
        _ => false,
    }
}
/// `recurrenceControlStatusSchema` with its three refinements.
pub(crate) fn control_status(v: &Value) -> bool {
    const KEYS: [&str; 12] = [
        "version", "scheduleID", "requestID", "expectedRevision", "revision", "state", "controlsComplete",
        "schedulerCancellation", "targets", "outcome", "reason", "action",
    ];
    let Some(o) = object(v, &KEYS, &["version", "scheduleID", "requestID", "expectedRevision", "outcome"]) else {
        return false;
    };
    let target = |t: &Value| {
        object(t, &["sessionID", "outcome"], &["sessionID", "outcome"]).is_some_and(|t| {
            t["sessionID"].as_str().is_some_and(nid) && one_of(&t["outcome"], &["acknowledged", "unknown"])
        })
    };
    let shape = o["version"] == 1
        && o["scheduleID"].as_str().is_some_and(rid)
        && o["requestID"].as_str().is_some_and(rid)
        && counter(&o["expectedRevision"])
        && opt(o, "revision", counter)
        && opt(o, "state", |s| one_of(s, &["paused", "running", "stopped"]))
        && opt(o, "controlsComplete", Value::is_boolean)
        && opt(o, "schedulerCancellation", |s| one_of(s, &["acknowledged", "unknown"]))
        && opt(o, "targets", |t| t.as_array().is_some_and(|a| a.iter().all(target)))
        && one_of(&o["outcome"], &["committed", "unknown", "rejected"])
        && opt(o, "reason", |r| one_of(r, &["revision-conflict", "control-conflict"]))
        && opt(o, "action", |a| one_of(a, &ACTIONS));
    let rejected = o["outcome"] == "rejected";
    let complete = o.get("controlsComplete") == Some(&Value::Bool(true));
    shape
        && (o["outcome"] != "committed" || complete)
        && rejected == o.contains_key("reason")
        && (!rejected || !o.contains_key("revision") && !o.contains_key("controlsComplete"))
        && (!complete
            || o.get("schedulerCancellation").is_none_or(|s| s != "unknown")
                && o.get("targets").is_none_or(|t| {
                    t.as_array().is_some_and(|a| a.iter().all(|x| x["outcome"] == "acknowledged"))
                }))
}
fn reference(v: &Value) -> bool {
    const KEYS: [&str; 8] = ["passageID", "dueAt", "settledAt", "outcome", "reason", "trigger", "missionID", "conversationID"];
    object(v, &KEYS, &KEYS[..4]).is_some_and(|o| {
        o["passageID"].as_str().is_some_and(rid)
            && counter(&o["dueAt"])
            && counter(&o["settledAt"])
            && o["settledAt"].as_u64() >= o["dueAt"].as_u64()
            && one_of(&o["outcome"], &["completed", "failed", "ended-without-report"])
            && opt(o, "reason", |r| one_of(r, &["interrupted", "not-started"]))
            && opt(o, "trigger", |t| one_of(t, &["daily", "manual"]))
            && opt(o, "missionID", Value::is_string)
            && opt(o, "conversationID", Value::is_string)
    })
}
fn schedule(v: &Value) -> bool {
    const KEYS: [&str; 13] = [
        "id", "title", "revision", "state", "clock", "nextDueAt", "interruptionReason", "lastError", "pending",
        "latestResult", "history", "actions", "controls",
    ];
    const REQUIRED: [&str; 11] = [
        "id", "title", "revision", "state", "clock", "nextDueAt", "pending", "latestResult", "history", "actions", "controls",
    ];
    let Some(o) = object(v, &KEYS, &REQUIRED) else {
        return false;
    };
    let pending = |p: &Value| {
        p.is_null()
            || object(p, &["passageID", "status", "trigger", "reason", "missionID", "conversationID"], &["passageID", "status"])
                .is_some_and(|p| {
                    p["passageID"].as_str().is_some_and(rid)
                        && one_of(&p["status"], &["starting", "running", "settling", "uncertain"])
                        && opt(p, "trigger", |t| one_of(t, &["daily", "manual"]))
                        && opt(p, "reason", |r| one_of(r, &["not-observed", "admission-failing"]))
                        && opt(p, "missionID", Value::is_string)
                        && opt(p, "conversationID", Value::is_string)
                })
    };
    let last_error = |e: &Value| {
        object(e, &["code", "at"], &["code", "at"]).is_some_and(|e| {
            one_of(&e["code"], &["wake-failed", "admission-failed", "settlement-failed"]) && counter(&e["at"])
        })
    };
    let history = o["history"].as_array();
    let actions = o["actions"].as_array();
    let shape = o["id"].as_str().is_some_and(rid)
        && text(&o["title"], 1, 120)
        && counter(&o["revision"])
        && one_of(&o["state"], &["paused", "running", "interrupted", "stopped"])
        && clock(&o["clock"])
        && (o["nextDueAt"].is_null() || counter(&o["nextDueAt"]))
        && opt(o, "interruptionReason", |r| one_of(r, &["service-restart", "error"]))
        && opt(o, "lastError", last_error)
        && pending(&o["pending"])
        && (o["latestResult"].is_null() || reference(&o["latestResult"]))
        && history.is_some_and(|h| h.len() <= 30 && h.iter().all(reference))
        && actions.is_some_and(|a| {
            a.len() <= 6
                && a.iter().all(|x| one_of(x, &ACTIONS))
                && a.iter().enumerate().all(|(i, x)| !a[..i].contains(x))
        })
        && o["controls"].as_array().is_some_and(|c| c.len() <= 64 && c.iter().all(control_status));
    if !shape {
        return false;
    }
    let history = history.unwrap();
    (o["state"] == "running") == !o["nextDueAt"].is_null()
        && o["latestResult"] == history.last().cloned().unwrap_or(Value::Null)
        && history.iter().enumerate().all(|(i, x)| !history[..i].iter().any(|y| y["passageID"] == x["passageID"]))
        && !history.iter().any(|x| o["pending"].get("passageID").is_some_and(|p| *p == x["passageID"]))
        && o["controls"].as_array().unwrap().iter().all(|c| c["scheduleID"] == o["id"])
}
/// `recurrenceSnapshotSchema` (control contract), including every refinement.
pub(crate) fn snapshot(v: &Value) -> bool {
    object(v, &["version", "projectID", "projectCanonical", "location", "schedules"], &[
        "version", "projectID", "projectCanonical", "location", "schedules",
    ])
    .is_some_and(|o| {
        o["version"] == 1
            && text(&o["projectID"], 1, 240)
            && text(&o["projectCanonical"], 1, 4096)
            && location(&o["location"], 4096)
            && o["schedules"].as_array().is_some_and(|s| s.len() <= 64 && s.iter().all(schedule))
    })
}
/// `recurrenceManualResultSchema` with its refinement.
pub(crate) fn manual_result(v: &Value) -> bool {
    const KEYS: [&str; 12] = [
        "scheduleID", "requestID", "expectedRevision", "version", "projectID", "projectCanonical", "location",
        "outcome", "reason", "passageID", "messageID", "admission",
    ];
    let required: Vec<&str> = KEYS.iter().copied().filter(|k| *k != "reason").collect();
    let Some(o) = object(v, &KEYS, &required) else {
        return false;
    };
    let admission = |a: &Value| {
        a.is_null()
            || object(a, &["kind", "passageID", "messageID", "missionID", "conversationID"], &[
                "kind", "passageID", "messageID", "missionID", "conversationID",
            ])
            .is_some_and(|a| {
                a["kind"] == "accepted"
                    && a["passageID"].as_str().is_some_and(rid)
                    && a["messageID"].as_str().is_some_and(rid)
                    && a["missionID"].as_str().is_some_and(nid)
                    && a["conversationID"].as_str().is_some_and(nid)
            })
    };
    let nullable_id = |v: &Value| v.is_null() || v.as_str().is_some_and(rid);
    let shape = o["scheduleID"].as_str().is_some_and(rid)
        && o["requestID"].as_str().is_some_and(rid)
        && counter(&o["expectedRevision"])
        && o["version"] == 1
        && text(&o["projectID"], 1, 240)
        && text(&o["projectCanonical"], 1, 4096)
        && location(&o["location"], 4096)
        && one_of(&o["outcome"], &["accepted", "settled", "unknown", "rejected"])
        && opt(o, "reason", |r| one_of(r, &["revision-conflict", "control-conflict"]))
        && nullable_id(&o["passageID"])
        && nullable_id(&o["messageID"])
        && admission(&o["admission"]);
    let rejected = o["outcome"] == "rejected";
    let a = &o["admission"];
    shape
        && o["passageID"].is_null() == o["messageID"].is_null()
        && (a.is_null() || a["passageID"] == o["passageID"] && a["messageID"] == o["messageID"])
        && rejected == o.contains_key("reason")
        && (!rejected || o["passageID"].is_null())
}
/// `recurrenceReadPage` extended with the native provenance fields.
pub(crate) fn read_page(v: &Value) -> bool {
    const KEYS: [&str; 16] = [
        "version", "projectID", "scheduleID", "passageID", "missionID", "conversationID", "revision", "section",
        "sectionCount", "sections", "page", "pageCount", "sourceText", "markdownText", "projectCanonical", "location",
    ];
    const LABELS: [&str; 11] = [
        "summary", "objective", "notes", "evidence", "next", "brief", "artifact", "achieved", "ongoing", "obstacles",
        "comparison",
    ];
    let index = |v: &Value| v.as_u64().is_some_and(|n| n < 8_400);
    let section = |s: &Value| {
        object(s, &["index", "label", "title", "raw", "comparison"], &["index", "label", "title", "raw"]).is_some_and(|s| {
            index(&s["index"])
                && one_of(&s["label"], &LABELS)
                && text(&s["title"], 0, 240)
                && s["raw"].is_boolean()
                && opt(s, "comparison", |c| {
                    object(c, &["verdict", "models"], &["verdict", "models"]).is_some_and(|c| {
                        one_of(&c["verdict"], &["a", "b", "equivalent", "inconclusive"])
                            && c["models"].as_array().is_some_and(|m| m.len() == 2 && m.iter().all(|x| text(x, 0, 500)))
                    })
                })
        })
    };
    object(v, &KEYS, &KEYS).is_some_and(|o| {
        o["version"] == 1
            && text(&o["projectID"], 1, 240)
            && o["scheduleID"].as_str().is_some_and(rid)
            && o["passageID"].as_str().is_some_and(rid)
            && text(&o["missionID"], 1, 240)
            && text(&o["conversationID"], 1, 240)
            && positive(&o["revision"])
            && index(&o["section"])
            && o["sectionCount"].as_u64().is_some_and(|n| (1..=8_400).contains(&n))
            && o["sections"].as_array().is_some_and(|s| (1..=32).contains(&s.len()) && s.iter().all(section))
            && o["page"].as_u64().is_some_and(|n| n <= 63)
            && o["pageCount"].as_u64().is_some_and(|n| (1..=64).contains(&n))
            && text(&o["sourceText"], 0, 9_001)
            && (o["markdownText"].is_null() || text(&o["markdownText"], 0, 9_116))
            && text(&o["projectCanonical"], 1, 4096)
            && location(&o["location"], 4096)
    })
}
/// `missionCurrentSourceSchema`.
pub(crate) fn current_source(v: &Value) -> bool {
    const KEYS: [&str; 8] = [
        "owner", "projectID", "scheduleID", "passageID", "missionID", "digest", "configurationGeneration", "timeGeneration",
    ];
    object(v, &KEYS, &KEYS[..6]).is_some_and(|o| {
        one_of(&o["owner"], &["daily", "scheduled"])
            && text(&o["projectID"], 1, 240)
            && text(&o["scheduleID"], 3, 100)
            && text(&o["passageID"], 3, 100)
            && text(&o["missionID"], 3, 100)
            && o["digest"].as_str().is_some_and(digest43)
            && opt(o, "configurationGeneration", positive)
            && opt(o, "timeGeneration", positive)
    })
}
/// `missionCurrentIdentitySchema` with its consistency refinement.
pub(crate) fn current_identity(v: &Value) -> bool {
    const KEYS: [&str; 8] = [
        "version", "projectID", "ownerRevision", "projectCanonical", "location", "scheduleID", "passageID", "source",
    ];
    let Some(o) = object(v, &KEYS, &KEYS[..7]) else {
        return false;
    };
    let shape = o["version"] == 1
        && text(&o["projectID"], 1, 240)
        && counter(&o["ownerRevision"])
        && text(&o["projectCanonical"], 1, usize::MAX)
        && location(&o["location"], usize::MAX)
        && text(&o["scheduleID"], 3, 100)
        && (o["passageID"].is_null() || text(&o["passageID"], 3, 100))
        && opt(o, "source", current_source);
    shape
        && match o.get("source") {
            Some(s) => s["projectID"] == o["projectID"] && s["scheduleID"] == o["scheduleID"] && s["passageID"] == o["passageID"],
            None => o["passageID"].is_null(),
        }
}
/// `recurrenceCurrentContentPage`, optionally extended with native provenance.
pub(crate) fn content_page(v: &Value, provenance: bool) -> bool {
    const KEYS: [&str; 12] = [
        "version", "projectID", "scheduleID", "passageID", "missionID", "revision", "page", "pageCount", "sourceText",
        "markdownText", "projectCanonical", "location",
    ];
    let keys = if provenance { &KEYS[..] } else { &KEYS[..10] };
    object(v, keys, keys).is_some_and(|o| {
        o["version"] == 1
            && text(&o["projectID"], 1, 240)
            && o["scheduleID"].as_str().is_some_and(rid)
            && o["passageID"].as_str().is_some_and(rid)
            && text(&o["missionID"], 1, 240)
            && positive(&o["revision"])
            && counter(&o["page"])
            && positive(&o["pageCount"])
            && text(&o["sourceText"], 0, 3_001)
            && (o["markdownText"].is_null() || text(&o["markdownText"], 0, 3_116))
            && (!provenance || o["projectCanonical"].is_string() && location(&o["location"], usize::MAX))
    })
}
/// Native panel page results (reference `isMissionPanelPageResult`): the
/// refusal union exactly, or an available page whose envelope is well formed.
pub(crate) fn panel_page(v: &Value) -> bool {
    const REASONS: [&str; 7] = [
        "invalid-request", "changed", "mission-not-found", "field-not-found", "invalid-cursor", "damaged",
        "observation-unavailable",
    ];
    if v["available"] == false {
        return object(v, &["available", "reason"], &["available", "reason"]).is_some_and(|o| one_of(&o["reason"], &REASONS));
    }
    let piece = |p: &Value| {
        object(p, &["index", "offset", "characters", "text"], &["index", "offset", "characters", "text"]).is_some_and(|p| {
            counter(&p["index"]) && counter(&p["offset"]) && counter(&p["characters"]) && text(&p["text"], 0, PANEL_PAGE_BYTES)
        })
    };
    let o = v.as_object();
    v["available"] == true
        && v["version"] == 1
        && v["projectID"].is_string()
        && v["source"].is_string()
        && o.is_some_and(|o| ["available", "version", "projectID", "source", "page"].iter().all(|k| o.contains_key(*k)))
        && v["page"]["digest"].as_str().is_some_and(digest43)
        && counter(&v["page"]["total"])
        && v["page"]["pieces"].as_array().is_some_and(|p| p.len() <= 50 && p.iter().all(piece))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row() -> Value {
        json!({"id":"rcs_abc","title":"Daily","revision":3,"state":"running","clock":{"time":"02:30","zone":"Europe/Paris"},
            "nextDueAt":1_800_000_000_000u64,"pending":null,"latestResult":null,"history":[],"actions":["pause","stop"],
            "controls":[{"version":1,"scheduleID":"rcs_abc","requestID":"req_1","expectedRevision":2,"revision":3,
                "state":"running","controlsComplete":true,"targets":[],"outcome":"committed","action":"play"}]})
    }
    fn snap(rows: Vec<Value>) -> Value {
        json!({"version":1,"projectID":"p1","projectCanonical":"D:\\p","location":{"directory":"D:\\p"},"schedules":rows})
    }

    #[test]
    fn canonical_json_matches_the_reference_authority_encoding() {
        let v = json!({"b":[1,{"z":null,"a":"é\n"}],"a":true,"B":0});
        assert_eq!(canonical(&v), r#"{"B":0,"a":true,"b":[1,{"a":"é\n","z":null}]}"#);
        assert_eq!(schedule_id("p", "c", "r").len(), 44);
    }

    #[test]
    fn zones_follow_the_schema_pattern_then_intl() {
        for ok in ["Europe/Paris", "UTC", "Etc/GMT+1", "America/Argentina/Buenos_Aires", "europe/paris", "US/Pacific"] {
            assert!(zone(ok), "{ok}");
        }
        // Offsets and malformed names are refused by the pattern even where Intl accepts them.
        for bad in ["+01:00", "-05", "", "Europe//Paris", "Europe/Paris/", "Mars/Olympus", "Europe Paris", "/UTC"] {
            assert!(!zone(bad), "{bad}");
        }
        assert!(clock(&json!({"time":"23:59","zone":"UTC"})));
        for t in ["24:00", "2:30", "12:60", "12-30", "ab:cd"] {
            assert!(!clock(&json!({"time":t,"zone":"UTC"})), "{t}");
        }
        assert!(!clock(&json!({"time":"12:00","zone":"UTC","x":1})));
    }

    #[test]
    fn snapshot_rows_keep_every_cross_refinement() {
        assert!(snapshot(&snap(vec![row()])));
        let mut paused = row();
        paused["state"] = json!("paused");
        assert!(!snapshot(&snap(vec![paused.clone()])), "paused with a due time");
        paused["nextDueAt"] = Value::Null;
        assert!(snapshot(&snap(vec![paused])));
        let reference = json!({"passageID":"rcp_1","dueAt":1,"settledAt":2,"outcome":"completed","trigger":"manual"});
        let mut settled = row();
        settled["history"] = json!([reference.clone()]);
        assert!(!snapshot(&snap(vec![settled.clone()])), "latest result must be the last history entry");
        settled["latestResult"] = reference.clone();
        assert!(snapshot(&snap(vec![settled.clone()])));
        settled["pending"] = json!({"passageID":"rcp_1","status":"running"});
        assert!(!snapshot(&snap(vec![settled.clone()])), "pending passage already archived");
        settled["pending"] = Value::Null;
        settled["history"] = json!([reference.clone(), reference.clone()]);
        settled["latestResult"] = reference.clone();
        assert!(!snapshot(&snap(vec![settled])), "duplicate passage");
        let mut foreign = row();
        foreign["controls"][0]["scheduleID"] = json!("rcs_other");
        assert!(!snapshot(&snap(vec![foreign])));
        let mut zone = row();
        zone["clock"]["zone"] = json!("Moon/Base");
        assert!(!snapshot(&snap(vec![zone])));
        let mut extra = row();
        extra["more"] = json!(1);
        assert!(!snapshot(&snap(vec![extra])));
        let mut actions = row();
        actions["actions"] = json!(["stop", "stop"]);
        assert!(!snapshot(&snap(vec![actions])));
        assert!(!snapshot(&snap(vec![row(); 65])));
    }

    #[test]
    fn control_receipts_refine_outcome_and_completion() {
        let ok = json!({"version":1,"scheduleID":"rcs_a","requestID":"req_1","expectedRevision":2,"outcome":"unknown"});
        assert!(control_status(&ok));
        let mut committed = ok.clone();
        committed["outcome"] = json!("committed");
        assert!(!control_status(&committed), "committed needs completed controls");
        committed["controlsComplete"] = json!(true);
        assert!(control_status(&committed));
        committed["schedulerCancellation"] = json!("unknown");
        assert!(!control_status(&committed));
        let mut rejected = ok.clone();
        rejected["outcome"] = json!("rejected");
        assert!(!control_status(&rejected), "rejection needs its reason");
        rejected["reason"] = json!("revision-conflict");
        assert!(control_status(&rejected));
        rejected["revision"] = json!(3);
        assert!(!control_status(&rejected));
        let mut targets = committed.clone();
        targets["schedulerCancellation"] = json!("acknowledged");
        targets["targets"] = json!([{"sessionID":"ses_1","outcome":"unknown"}]);
        assert!(!control_status(&targets));
        let mut known = ok.clone();
        known["targetsKnown"] = json!(true);
        assert!(!control_status(&known), "targetsKnown is native-only");
    }

    /// The reference `dailyOccurrence` minute scan, on chrono-tz data.
    fn occurrence(time: &str, zone: &str, day: &str) -> Option<String> {
        use chrono::{DateTime, Datelike, NaiveDate, Timelike};
        let tz = crate::missions::time_zone::parse(zone)?;
        let date = NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
        let midnight = date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis();
        let mut observed = false;
        let mut at = midnight - 18 * 3_600_000;
        while at <= midnight + 42 * 3_600_000 {
            let local = DateTime::from_timestamp_millis(at)?.with_timezone(&tz);
            let local_day = NaiveDate::from_ymd_opt(local.year(), local.month(), local.day())?;
            let minute = format!("{:02}:{:02}", local.hour(), local.minute());
            if observed && local_day > date || local_day == date && minute.as_str() >= time {
                return Some(DateTime::from_timestamp_millis(at)?.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
            }
            observed |= local_day == date;
            at += 60_000;
        }
        None
    }

    #[test]
    fn zone_data_matches_the_native_civil_clock_across_daylight_saving() {
        // Expected instants printed by the plugin's own `dailyOccurrence` (Node ICU),
        // `daylightSaving()` in recurrence-tranche11.mjs.
        let cases = [
            ("02:30", "Europe/Paris", "2027-03-28", "2027-03-28T01:00:00.000Z"), // gap: first later minute
            ("03:30", "Europe/Paris", "2027-03-28", "2027-03-28T01:30:00.000Z"),
            ("02:30", "Europe/Paris", "2026-10-25", "2026-10-25T00:30:00.000Z"), // fold: first occurrence
            ("01:30", "Europe/Paris", "2026-10-25", "2026-10-24T23:30:00.000Z"),
            ("02:15", "Australia/Lord_Howe", "2026-10-04", "2026-10-03T15:30:00.000Z"), // half-hour shift
            ("02:30", "europe/paris", "2026-11-20", "2026-11-20T01:30:00.000Z"),
        ];
        for (time, zone, day, expected) in cases {
            assert!(clock(&json!({"time":time,"zone":zone})), "{zone}");
            assert_eq!(occurrence(time, zone, day).as_deref(), Some(expected), "{zone} {day} {time}");
        }
    }

    #[test]
    fn manual_and_current_results_are_consistent() {
        let base = json!({"scheduleID":"rcs_a","requestID":"req_1","expectedRevision":0,"version":1,"projectID":"p",
            "projectCanonical":"c","location":{"directory":"d"},"outcome":"accepted","passageID":"rcp_1","messageID":"msg_1",
            "admission":null});
        assert!(manual_result(&base));
        let mut half = base.clone();
        half["messageID"] = Value::Null;
        assert!(!manual_result(&half));
        let mut rejected = base.clone();
        rejected["outcome"] = json!("rejected");
        rejected["reason"] = json!("control-conflict");
        assert!(!manual_result(&rejected), "a rejected Run now reserved nothing");
        rejected["passageID"] = Value::Null;
        rejected["messageID"] = Value::Null;
        assert!(manual_result(&rejected));
        let identity = json!({"version":1,"projectID":"p","ownerRevision":2,"projectCanonical":"c","location":{"directory":"d"},
            "scheduleID":"rcs_a","passageID":null});
        assert!(current_identity(&identity));
        let mut sourced = identity.clone();
        sourced["passageID"] = json!("rcp_1");
        assert!(!current_identity(&sourced), "a passage needs its source");
        sourced["source"] = json!({"owner":"daily","projectID":"p","scheduleID":"rcs_a","passageID":"rcp_1","missionID":"msn_1",
            "digest":"a".repeat(43)});
        assert!(current_identity(&sourced));
        sourced["source"]["scheduleID"] = json!("rcs_b");
        assert!(!current_identity(&sourced));
    }
}
