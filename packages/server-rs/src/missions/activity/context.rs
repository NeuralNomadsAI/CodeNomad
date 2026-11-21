//! Strict shapes of the observation transport (reference
//! `missions/mission-panel-observation.ts` `contextSchema`/`marksSchema`,
//! `mission-panel-page.ts` request and output schemas). Validators return the
//! value rebuilt in schema key order, as zod's parse output is.
use super::ojson::{J, utf16_len};

pub const ACTIVITY_ACTORS: usize = 160;
pub const MARK_MISSIONS: usize = 16;
pub const MARK_ACTORS: usize = 10;
pub const DAMAGE: [&str; 4] = [
    "discardedEvents",
    "controlUnavailable",
    "notificationUnavailable",
    "cleanupUnavailable",
];

/// Keys of `value` are all in `allowed`; output follows `allowed` order.
fn strict<'a>(value: &'a J, allowed: &[&str]) -> Option<&'a [(String, J)]> {
    let entries = value.obj()?;
    entries
        .iter()
        .all(|(k, _)| allowed.contains(&k.as_str()))
        .then_some(entries)
}

type Check = fn(&J) -> Option<J>;
/// Rebuilds a strict object: `fields` are (key, required, check) in schema order.
fn shape(value: &J, fields: &[(&str, bool, Check)]) -> Option<J> {
    let names: Vec<&str> = fields.iter().map(|f| f.0).collect();
    strict(value, &names)?;
    let mut out = Vec::new();
    for (key, required, check) in fields {
        match value.get(key) {
            Some(v) => out.push(((*key).to_owned(), check(v)?)),
            None if *required => return None,
            None => {}
        }
    }
    Some(J::O(out))
}

fn string(v: &J, min: usize, max: usize) -> Option<J> {
    let s = v.str()?;
    let n = utf16_len(s);
    (min..=max).contains(&n).then(|| v.clone())
}
fn id(v: &J) -> Option<J> {
    string(v, 1, 240)
}
fn count(v: &J) -> Option<J> {
    v.count().map(J::U)
}
fn boolean(v: &J) -> Option<J> {
    v.bool().map(J::Bool)
}
fn order(v: &J) -> Option<J> {
    v.str().filter(|s| utf16_len(s) == 43).map(J::s)
}
fn digest(s: &str) -> bool {
    s.len() == 43
        && s
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn one_of(v: &J, values: &[&str]) -> Option<J> {
    v.str().filter(|s| values.contains(s)).map(J::s)
}

fn location(v: &J) -> Option<J> {
    shape(
        v,
        &[
            ("directory", true, |v| string(v, 1, 20_000)),
            ("workspaceID", false, id),
        ],
    )
}
fn task_context(v: &J) -> Option<J> {
    shape(
        v,
        &[
            ("invalid", true, boolean),
            ("taskKey", false, |v| string(v, 0, 64)),
            ("parentSessionID", false, id),
        ],
    )
}
fn actor(v: &J) -> Option<J> {
    shape(
        v,
        &[
            ("sessionId", true, id),
            ("title", true, |v| string(v, 0, 240)),
            ("location", true, location),
            ("reportOwed", true, boolean),
            ("callOpen", true, boolean),
            ("taskContext", false, task_context),
        ],
    )
}
fn page(v: &J) -> Option<J> {
    shape(
        v,
        &[
            ("order", true, order),
            ("offset", true, count),
            ("end", true, count),
            ("total", true, count),
        ],
    )
}
fn control(v: &J) -> Option<J> {
    shape(
        v,
        &[
            ("id", true, id),
            ("requestID", true, id),
            ("expectedRevision", true, count),
            ("completedRevision", false, count),
            ("action", true, |v| one_of(v, &["start", "pause", "stop"])),
            ("graceful", false, |v| (v == &J::Bool(true)).then(|| v.clone())),
            ("pending", true, count),
            ("receipts", true, count),
            ("unconfirmedReceipts", true, count),
            ("partialDescendants", true, count),
        ],
    )
}
fn page_valid(p: &J, rows: usize) -> bool {
    let n = |k| p.get(k).and_then(J::count).unwrap_or(0);
    let (offset, end, total) = (n("offset"), n("end"), n("total"));
    offset <= end && end <= total && (offset == total || end > offset) && (end - offset) as usize == rows
}

/// `contextSchema`, including its refinement.
pub fn context(v: &J) -> Option<J> {
    let out = shape(
        v,
        &[
            ("id", true, id),
            ("projectID", true, id),
            ("revision", true, count),
            ("status", true, |v| one_of(v, &["active", "completed", "failed", "stopped"])),
            ("runState", false, |v| one_of(v, &["prepared", "running", "paused", "stopped"])),
            ("coordinatorSessionId", true, id),
            ("actors", true, |v| {
                let items = v.arr()?;
                (items.len() <= ACTIVITY_ACTORS)
                    .then(|| items.iter().map(actor).collect::<Option<Vec<_>>>().map(J::A))?
            }),
            ("actorPage", true, page),
            ("control", false, control),
            ("discardedEvents", true, count),
            ("controlUnavailable", true, boolean),
            ("notificationUnavailable", true, boolean),
            ("cleanupUnavailable", true, boolean),
        ],
    )?;
    let actors = out.get("actors")?.arr()?;
    let mut ids = std::collections::HashSet::new();
    (page_valid(out.get("actorPage")?, actors.len())
        && actors
            .iter()
            .all(|a| ids.insert(a.get("sessionId").and_then(J::str).unwrap_or_default())))
    .then_some(out)
}

/// `marksSchema`, including its refinement.
pub fn marks(v: &J) -> Option<J> {
    let out = shape(
        v,
        &[
            ("contexts", true, |v| {
                let items = v.arr()?;
                (items.len() <= MARK_MISSIONS)
                    .then(|| items.iter().map(context).collect::<Option<Vec<_>>>().map(J::A))?
            }),
            ("missionPage", true, page),
        ],
    )?;
    let contexts = out.get("contexts")?.arr()?;
    let mut ids = std::collections::HashSet::new();
    (contexts
        .iter()
        .all(|c| c.get("actors").and_then(J::arr).is_some_and(|a| a.len() <= MARK_ACTORS))
        && contexts
            .iter()
            .all(|c| ids.insert(c.get("id").and_then(J::str).unwrap_or_default()))
        && page_valid(out.get("missionPage")?, contexts.len()))
    .then_some(out)
}

/// One observation selector (`missionPanelPageRequestSchema`, activity/marks).
#[derive(Debug, PartialEq)]
pub struct Request {
    pub activity: bool,
    pub mission: Option<String>,
    pub offset: Option<u64>,
    pub order: Option<String>,
    pub cursor: Option<super::ojson::Cursor>,
}
pub fn request(v: &serde_json::Value) -> Option<Request> {
    let o = v.as_object()?;
    let activity = v["source"] == "activity";
    let (offset_key, order_key) = if activity {
        ("actorOffset", "actorOrder")
    } else {
        ("missionOffset", "missionOrder")
    };
    let count = |v: &serde_json::Value| {
        serde_json::from_value::<J>(v.clone()).ok().and_then(|j| j.count())
    };
    let allowed = ["source", "missionID", offset_key, order_key, "cursor"];
    if !o.keys().all(|k| allowed.contains(&k.as_str())) || !activity && o.contains_key("missionID") {
        return None;
    }
    let mission = match v.get("missionID") {
        Some(m) => Some(m.as_str().filter(|s| (1..=100).contains(&utf16_len(s)))?.to_owned()),
        None if activity => return None,
        None => None,
    };
    let offset = match v.get(offset_key) {
        Some(n) => Some(count(n)?),
        None => None,
    };
    let order = match v.get(order_key) {
        Some(s) => Some(s.as_str().filter(|s| digest(s))?.to_owned()),
        None => None,
    };
    let cursor = match v.get("cursor") {
        Some(c) => {
            let c = c.as_object()?;
            if c.len() != 3 {
                return None;
            }
            Some(super::ojson::Cursor {
                digest: c.get("digest")?.as_str().filter(|s| digest(s))?.to_owned(),
                index: count(c.get("index")?)?,
                offset: count(c.get("offset")?)?,
            })
        }
        None => None,
    };
    Some(Request { activity, mission, offset, order, cursor })
}

const SOURCES: [&str; 7] = ["summaries", "cleanups", "mission", "tasks", "activity", "marks", "task-marks"];
const REASONS: [&str; 7] = [
    "invalid-request",
    "changed",
    "mission-not-found",
    "field-not-found",
    "invalid-cursor",
    "damaged",
    "observation-unavailable",
];
fn integer(v: &J, min: u64) -> Option<J> {
    v.count().filter(|n| *n >= min).map(|_| v.clone())
}
pub(super) fn passage(v: &J) -> Option<J> {
    shape(
        v,
        &[
            ("owner", true, |v| one_of(v, &["daily", "scheduled"])),
            ("projectID", true, |v| string(v, 1, 240)),
            ("scheduleID", true, |v| string(v, 3, 100)),
            ("passageID", true, |v| string(v, 3, 100)),
            ("missionID", true, |v| string(v, 3, 100)),
            ("digest", true, |v| string(v, 43, 43)),
            ("configurationGeneration", false, |v| integer(v, 1)),
            ("timeGeneration", false, |v| integer(v, 1)),
        ],
    )
}
fn piece(v: &J) -> Option<J> {
    shape(
        v,
        &[
            ("index", true, |v| integer(v, 0)),
            ("offset", true, |v| integer(v, 0)),
            ("characters", true, |v| integer(v, 0)),
            ("text", true, |v| string(v, 0, super::ojson::PAGE_BYTES)),
        ],
    )
}
fn cursor_wire(v: &J) -> Option<J> {
    shape(
        v,
        &[
            ("digest", true, |v| string(v, 43, 43)),
            ("index", true, |v| integer(v, 0)),
            ("offset", true, |v| integer(v, 0)),
        ],
    )
}

/// `isMissionPanelPageResult`: the registered output schema, excess fields refused.
pub fn page_result(v: &J) -> bool {
    if v.get("available") == Some(&J::Bool(false)) {
        return v.obj().is_some_and(|o| o.len() == 2)
            && v.get("reason").and_then(J::str).is_some_and(|r| REASONS.contains(&r));
    }
    shape(
        v,
        &[
            ("available", true, |v| (v == &J::Bool(true)).then(|| v.clone())),
            ("version", true, |v| (v.count() == Some(1)).then(|| v.clone())),
            ("projectID", true, |v| string(v, 0, 240)),
            ("passage", false, passage),
            ("source", true, |v| one_of(v, &SOURCES)),
            ("missionID", false, |v| string(v, 0, 100)),
            ("field", false, |v| string(v, 0, 64)),
            ("part", false, |v| one_of(v, &["receipts", "pending"])),
            ("text", false, |v| (v == &J::Bool(true)).then(|| v.clone())),
            ("revision", false, |v| integer(v, 0)),
            ("discardedEvents", false, |v| integer(v, 0)),
            ("window", false, |v| {
                shape(
                    v,
                    &[
                        ("offset", true, |v| integer(v, 0)),
                        ("end", true, |v| integer(v, 0)),
                        ("total", true, |v| integer(v, 0)),
                        ("order", true, |v| string(v, 43, 43)),
                    ],
                )
            }),
            ("header", false, |v| (v == &J::Bool(true)).then(|| v.clone())),
            ("finishHighWater", false, |v| integer(v, 0)),
            ("phase", false, |v| one_of(v, &["context", "observed"])),
            ("observedAt", false, |v| v.is_number().then(|| v.clone())),
            ("taskMarksThrough", false, |v| {
                (v.is_number() && !matches!(v, J::I(_)) && !matches!(v, J::F(f) if *f < 0.0)).then(|| v.clone())
            }),
            ("controlUnavailable", false, boolean),
            ("notificationUnavailable", false, boolean),
            ("cleanupUnavailable", false, boolean),
            ("page", true, |v| {
                shape(
                    v,
                    &[
                        ("digest", true, |v| string(v, 43, 43)),
                        ("total", true, |v| integer(v, 0)),
                        ("next", false, cursor_wire),
                        ("pieces", true, |v| {
                            let items = v.arr()?;
                            (items.len() <= super::ojson::PAGE_ROWS)
                                .then(|| items.iter().map(piece).collect::<Option<Vec<_>>>().map(J::A))?
                        }),
                    ],
                )
            }),
        ],
    )
    .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::missions::activity::ojson::parse;
    use serde_json::json;

    const ORDER: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    fn sample() -> String {
        format!(
            r#"{{"cleanupUnavailable":false,"actors":[{{"title":"t","sessionId":"ses_a","callOpen":false,"reportOwed":true,"location":{{"directory":"D:\\p"}}}}],"id":"m","projectID":"p","revision":3,"status":"active","coordinatorSessionId":"ses_a","actorPage":{{"order":"{ORDER}","offset":0,"end":1,"total":1}},"discardedEvents":0,"controlUnavailable":false,"notificationUnavailable":false}}"#
        )
    }

    #[test]
    fn context_is_strict_and_reordered_like_zod() {
        let parsed = context(&parse(sample().as_bytes()).unwrap()).unwrap();
        assert!(parsed.stringify().starts_with(r#"{"id":"m","projectID":"p","revision":3,"status":"active","coordinatorSessionId":"ses_a","actors":[{"sessionId":"ses_a","title":"t","location":{"directory":"D:\\p"},"reportOwed":true,"callOpen":false}]"#));
        let extra = sample().replacen(r#""id":"m""#, r#""id":"m","taskMarks":[]"#, 1);
        assert!(context(&parse(extra.as_bytes()).unwrap()).is_none());
        let page = sample().replacen(r#""end":1"#, r#""end":0"#, 1);
        assert!(context(&parse(page.as_bytes()).unwrap()).is_none());
        let foreign = sample().replacen(r#""directory":"D:\\p""#, r#""directory":"D:\\p","workspaceID":"w","x":1"#, 1);
        assert!(context(&parse(foreign.as_bytes()).unwrap()).is_none());
    }

    #[test]
    fn requests_follow_the_selector_schema() {
        assert!(request(&json!({"source":"activity","missionID":"m","actorOffset":0})).is_some());
        assert!(request(&json!({"source":"activity"})).is_none());
        assert!(request(&json!({"source":"marks","missionID":"m"})).is_none());
        assert!(request(&json!({"source":"marks","actorOffset":1})).is_none());
        assert!(request(&json!({"source":"marks","missionOrder":"short"})).is_none());
        assert!(request(&json!({"source":"marks","cursor":{"digest":ORDER,"index":0,"offset":-1}})).is_none());
        assert_eq!(request(&json!({"source":"marks","missionOffset":2})).unwrap().offset, Some(2));
    }
}
