//! Native family control: deepest-first interruption, queue ownership and exact receipts.
use crate::{App, Error, error, worktrees::linked::native};
use axum::http::{Method, StatusCode as Status};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    future::Future,
    time::Duration,
};
use tokio::time::Instant;

/// `MAX_CONTROL_FAMILY_SESSIONS` of the reference.
const LIMIT: usize = 4096;
fn unavailable() -> Error {
    error(
        Status::SERVICE_UNAVAILABLE,
        "Mission family observation unavailable",
    )
}
struct Tree {
    rows: Vec<(String, Value, usize)>,
    complete: bool,
}
async fn walk(app: &App, root: &Value, deadline: Instant) -> Result<Tree, Error> {
    let sid = root["id"]
        .as_str()
        .filter(|s| crate::opencode::valid_id(s))
        .ok_or_else(unavailable)?;
    let mut t = Tree {
        rows: vec![(sid.into(), root.clone(), 0)],
        complete: true,
    };
    let mut seen = HashSet::from([sid.to_string()]);
    let mut index = 0;
    let mut reads = 0;
    while index < t.rows.len() {
        let (parent, _, depth) = &t.rows[index];
        let (parent, level) = (parent.clone(), depth + 1);
        let mut cursor = None::<String>;
        let mut previous = HashSet::new();
        loop {
            reads += 1;
            if reads > 2 * (LIMIT + 1) || Instant::now() > deadline {
                return Ok(Tree {
                    complete: false,
                    ..t
                });
            }
            let first = [("parentID", parent.as_str()), ("limit", "200")];
            let next = [("cursor", cursor.as_deref().unwrap_or_default())];
            let Ok(value) = native(
                app,
                Method::GET,
                "/api/session",
                if cursor.is_some() { &next } else { &first },
                None,
                2 * 1024 * 1024,
            )
            .await
            else {
                t.complete = false;
                break;
            };
            let (Some(rows), Some(c)) = (value["data"].as_array(), value["cursor"].as_object())
            else {
                t.complete = false;
                break;
            };
            if rows.len() > 200 {
                return Ok(Tree {
                    complete: false,
                    ..t
                });
            }
            for row in rows {
                let Some(id) = row["id"].as_str().filter(|s| crate::opencode::valid_id(s)) else {
                    t.complete = false;
                    continue;
                };
                if row["parentID"] != parent
                    || row["projectID"] != root["projectID"]
                    || row["location"] != root["location"]
                    || !seen.insert(id.into())
                {
                    t.complete = false;
                    continue;
                }
                if t.rows.len() >= LIMIT {
                    return Ok(Tree {
                        complete: false,
                        ..t
                    });
                }
                t.rows.push((id.into(), row.clone(), level));
            }
            match c.get("next") {
                None | Some(Value::Null) => break,
                Some(Value::String(next))
                    if !rows.is_empty()
                        && !next.is_empty()
                        && next.len() <= 8192
                        && previous.insert(next.clone()) =>
                {
                    cursor = Some(next.clone())
                }
                _ => {
                    t.complete = false;
                    break;
                }
            }
        }
        index += 1;
    }
    t.rows
        .sort_by_key(|(_, _, depth)| std::cmp::Reverse(*depth));
    Ok(t)
}
async fn active(app: &App) -> Result<serde_json::Map<String, Value>, Error> {
    native(
        app,
        Method::GET,
        "/api/session/active",
        &[],
        None,
        256 * 1024,
    )
    .await?["data"]
        .as_object()
        .cloned()
        .ok_or_else(unavailable)
}
fn is_active(sessions: &serde_json::Map<String, Value>, id: &str) -> bool {
    sessions.get(id).is_some_and(|v| !v.is_null() && v != false)
}
async fn interrupt(app: &App, id: &str) -> Result<Value, Error> {
    let v = native(
        app,
        Method::POST,
        &format!("/api/session/{id}/interrupt"),
        &[("resume", "false")],
        None,
        4096,
    )
    .await?;
    let v = v.get("data").unwrap_or(&v);
    if !v["interrupted"].is_boolean() || v.as_object().is_none_or(|o| o.len() != 1) {
        return Err(unavailable());
    }
    Ok(v.clone())
}
async fn inbox(app: &App, id: &str) -> Result<Vec<Value>, Error> {
    let v = native(
        app,
        Method::GET,
        &format!("/api/session/{id}/inbox"),
        &[],
        None,
        512 * 1024,
    )
    .await?;
    let rows = v["data"].as_array().ok_or_else(unavailable)?;
    let mut seen = HashSet::new();
    if rows.iter().any(|x| {
        !x["id"]
            .as_str()
            .is_some_and(|s| crate::opencode::valid_id(s) && seen.insert(s))
    }) {
        return Err(unavailable());
    }
    Ok(rows.clone())
}

// Reference: `missions/native-family-interrupt.ts` and `native-actor-lifecycle.ts`.
const PASSES: usize = 3;
const CONCURRENCY: usize = 8;
const SETTLE: Duration = Duration::from_millis(250);
const FAMILY_CONTROL_BUDGET: Duration = Duration::from_secs(50);
const FAMILY_RECHECK_BUDGET: Duration = Duration::from_secs(10);
const MAX_STOP_CANCELLATIONS: usize = 128;
const MAX_REPORTED_DESCENDANTS: usize = 64;

fn queued_input(item: &Value) -> bool {
    matches!(item["type"].as_str(), Some("user" | "synthetic"))
}
/// Native subagent results are synthetic items tagged `source: "subagent"`.
fn subagent_delivery(item: &Value) -> bool {
    item["type"] == "synthetic" && item["payload"]["metadata"]["source"] == "subagent"
}
/// Root inputs a Stop may cancel: this Mission's own inputs and subagent results.
fn cancellable(item: &Value, mid: &str) -> bool {
    queued_input(item)
        && (item["payload"]["metadata"]["codenomad.mission"]["missionID"] == mid
            || subagent_delivery(item))
}

/// Distinct evidence shared by the passes and the post-root rechecks.
#[derive(Default)]
struct Ledger {
    observed: HashSet<String>,
    interrupted: Vec<String>,
    drained: HashSet<String>,
    failed_cancels: HashSet<String>,
    cancelled: usize,
}
impl Ledger {
    fn summary(&self, unconfirmed: usize, complete: bool) -> Value {
        json!({"observed":self.observed.len(),"interrupted":self.interrupted.len(),"cancelled":self.cancelled,
            "unconfirmed":unconfirmed,"complete":complete && unconfirmed == 0,
            "sessions":self.interrupted.iter().take(MAX_REPORTED_DESCENDANTS).collect::<Vec<_>>()})
    }
}
fn deepest_first(tree: &Tree) -> Vec<Vec<(String, Value)>> {
    let mut levels = BTreeMap::<usize, Vec<(String, Value)>>::new();
    for (id, row, depth) in &tree.rows {
        if *depth > 0 {
            levels.entry(*depth).or_default().push((id.clone(), row.clone()));
        }
    }
    levels.into_values().rev().collect()
}

/// Cancels matching queued inputs of one session (bounded batch).
/// `Err` when a failed cancellation leaves the item queued or the read fails.
async fn cancel_queued(
    app: &App,
    sid: &str,
    matches: impl Fn(&Value) -> bool,
    mut on_cancelled: impl FnMut(&str, &'static str),
) -> Result<(usize, bool), ()> {
    let items = inbox(app, sid).await.map_err(|_| ())?;
    let queued = items
        .iter()
        .filter(|x| queued_input(x) && matches(x))
        .collect::<Vec<_>>();
    let mut count = 0;
    for item in queued.iter().take(128) {
        let key = item["id"].as_str().ok_or(())?;
        let disposition = if native(
            app,
            Method::DELETE,
            &format!("/api/session/{sid}/inbox/{key}"),
            &[],
            None,
            4096,
        )
        .await
        .is_ok()
        {
            "native-acknowledged"
        } else if inbox(app, sid)
            .await
            .is_ok_and(|items| items.iter().all(|i| i["id"] != key))
        {
            "observed-absent"
        } else {
            return Err(());
        };
        on_cancelled(key, disposition);
        count += 1;
    }
    Ok((count, queued.len() <= 128))
}

struct Controlled {
    id: String,
    interrupted: bool,
    drain: Option<Result<(usize, bool), ()>>,
}
/// Interrupts one active descendant and, on Stop, cancels its queued inputs.
/// Like the reference `controlSession`, membership comes from this pass's
/// validated family read (same parent, project and Location); the caller's
/// checkpoint rechecks the Mission authority before each level.
async fn control_session(app: &App, id: String, _row: Value, active: bool, drain: bool) -> Controlled {
    let mut out = Controlled { id, interrupted: false, drain: None };
    if active {
        out.interrupted = interrupt(app, &out.id)
            .await
            .is_ok_and(|v| v["interrupted"] == true);
    }
    if drain {
        out.drain = Some(cancel_queued(app, &out.id, |_| true, |_, _| {}).await);
    }
    out
}
/// False when the deadline stopped workers before every target started.
async fn bounded(
    app: &App,
    ledger: &mut Ledger,
    targets: Vec<(String, Value, bool, bool)>,
    deadline: Instant,
) -> bool {
    use futures_util::StreamExt;
    let expired = std::sync::atomic::AtomicBool::new(false);
    let results = futures_util::stream::iter(targets)
        .map(|(id, row, active, drain)| {
            let expired = &expired;
            async move {
                if Instant::now() > deadline {
                    expired.store(true, std::sync::atomic::Ordering::Relaxed);
                    return None;
                }
                Some(control_session(app, id, row, active, drain).await)
            }
        })
        .buffer_unordered(CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    for done in results.into_iter().flatten() {
        if done.interrupted && !ledger.interrupted.contains(&done.id) {
            ledger.interrupted.push(done.id.clone());
        }
        if let Some(drain) = done.drain {
            ledger.drained.insert(done.id.clone());
            match drain {
                Ok((count, complete)) => {
                    ledger.cancelled += count;
                    if complete {
                        ledger.failed_cancels.remove(&done.id);
                    } else {
                        ledger.failed_cancels.insert(done.id);
                    }
                }
                Err(()) => _ = ledger.failed_cancels.insert(done.id),
            }
        }
    }
    !expired.into_inner()
}

/// Interrupts every active descendant deepest level first; Stop drains each
/// descendant inbox once and again whenever it is seen active. The root is left
/// to the caller. Native failures yield an honest partial result.
async fn interrupt_family<C, F>(
    app: &App,
    root: &Value,
    stop: bool,
    checkpoint: &C,
    ledger: &mut Ledger,
    deadline: Instant,
) -> Result<Value, Error>
where
    C: Fn() -> F,
    F: Future<Output = Result<(), Error>>,
{
    let (mut expired, mut unknown, mut complete) = (false, false, false);
    let mut residual = Vec::new();
    for pass in 0..=PASSES {
        let (tree, live) = match (walk(app, root, deadline).await, active(app).await) {
            (Ok(tree), Ok(live)) => (tree, live),
            _ => {
                unknown = true;
                break;
            }
        };
        complete = tree.complete;
        let order = deepest_first(&tree);
        for (id, _) in order.iter().flatten() {
            ledger.observed.insert(id.clone());
        }
        residual = order
            .iter()
            .flatten()
            .filter(|(id, _)| is_active(&live, id))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let drain = order
            .iter()
            .flatten()
            .filter(|(id, _)| stop && (!ledger.drained.contains(id) || is_active(&live, id)))
            .map(|(id, _)| id.clone())
            .collect::<HashSet<_>>();
        if (residual.is_empty() && drain.is_empty()) || pass == PASSES {
            break;
        }
        for level in order {
            if Instant::now() > deadline {
                expired = true;
                break;
            }
            checkpoint().await?;
            let targets = level
                .into_iter()
                .filter(|(id, _)| is_active(&live, id) || drain.contains(id))
                .map(|(id, row)| {
                    let (a, d) = (is_active(&live, &id), drain.contains(&id));
                    (id, row, a, d)
                })
                .collect();
            if !bounded(app, ledger, targets, deadline).await {
                expired = true;
                break;
            }
        }
        if expired {
            break;
        }
        tokio::time::sleep(SETTLE).await;
    }
    let unconfirmed = ledger
        .failed_cancels
        .iter()
        .chain(&residual)
        .collect::<HashSet<_>>()
        .len();
    Ok(ledger.summary(unconfirmed, complete && !expired && !unknown))
}

/// Post-root recheck. With `interrupt` it stops what was missed or launched
/// meanwhile; otherwise it verifies a whole, inactive family with no input
/// that could re-wake it (Pause: only inputs parked behind an interruption).
async fn recheck<C, F>(
    app: &App,
    root: &Value,
    stop: bool,
    checkpoint: &C,
    ledger: &mut Ledger,
    descendants: &Value,
    interrupting: bool,
    deadline: Instant,
) -> Result<Value, Error>
where
    C: Fn() -> F,
    F: Future<Output = Result<(), Error>>,
{
    let previous = descendants["unconfirmed"].as_u64().unwrap_or(1) as usize;
    let was_complete = descendants["complete"] == true;
    let (tree, live) = match (walk(app, root, deadline).await, active(app).await) {
        (Ok(tree), Ok(live)) => (tree, live),
        _ => return Ok(ledger.summary(previous, false)),
    };
    let order = deepest_first(&tree);
    for (id, _) in order.iter().flatten() {
        ledger.observed.insert(id.clone());
    }
    if interrupting {
        let mut expired = false;
        for level in order {
            let targets = level
                .into_iter()
                .filter(|(id, _)| is_active(&live, id) || stop && !ledger.drained.contains(id))
                .map(|(id, row)| {
                    let a = is_active(&live, &id);
                    (id, row, a, stop)
                })
                .collect::<Vec<_>>();
            if targets.is_empty() {
                continue;
            }
            if Instant::now() > deadline {
                expired = true;
                break;
            }
            checkpoint().await?;
            if !bounded(app, ledger, targets, deadline).await {
                expired = true;
                break;
            }
        }
        let unconfirmed = ledger.failed_cancels.len();
        return Ok(ledger.summary(previous.max(unconfirmed), was_complete && tree.complete && !expired));
    }
    let mut awake = order
        .iter()
        .flatten()
        .filter(|(id, _)| is_active(&live, id))
        .map(|(id, _)| id.clone())
        .collect::<HashSet<_>>();
    let mut unknown = ledger.failed_cancels.clone();
    for (id, row) in order.iter().flatten() {
        if awake.contains(id) {
            continue;
        }
        if Instant::now() > deadline {
            return Ok(ledger.summary(previous.max(awake.len() + unknown.len()).max(1), false));
        }
        match inbox(app, id).await {
            Ok(items) => {
                let queued = items.iter().any(queued_input);
                let parked = row["outcome"] == "interrupted";
                if items.len() > 128 || queued && (stop || !parked) {
                    awake.insert(id.clone());
                }
            }
            Err(_) => _ = unknown.insert(id.clone()),
        }
    }
    let unconfirmed = previous.max(awake.union(&unknown).count());
    Ok(ledger.summary(unconfirmed, was_complete && tree.complete))
}

/// After the root's own interrupt, late subagent deliveries may re-wake it:
/// re-interrupt boundedly and, on Stop, cancel the matching queued items.
async fn settle_root<C, F>(
    app: &App,
    sid: &str,
    stop: bool,
    checkpoint: &C,
    cancel: impl Fn(&Value) -> bool,
    cancellations: &mut Vec<(String, &'static str)>,
) -> Result<bool, Error>
where
    C: Fn() -> F,
    F: Future<Output = Result<(), Error>>,
{
    let (mut failed, mut overflowing) = (false, false);
    for _ in 0..PASSES {
        tokio::time::sleep(SETTLE).await;
        checkpoint().await?;
        let mut changed = false;
        if stop {
            match cancel_queued(app, sid, &cancel, |id, disposition| {
                if cancellations.len() < MAX_STOP_CANCELLATIONS
                    && !cancellations.iter().any(|(known, _)| known == id)
                {
                    cancellations.push((id.to_owned(), disposition));
                }
            })
            .await
            {
                Ok((count, complete)) => {
                    overflowing = !complete;
                    changed = count > 0 || overflowing;
                }
                Err(()) => failed = true,
            }
        }
        if is_active(&active(app).await?, sid) {
            interrupt(app, sid).await?;
            changed = true;
        }
        if !changed {
            return Ok(!failed);
        }
    }
    Ok(!failed && !overflowing && !is_active(&active(app).await?, sid))
}

/// Stops one retired native task conversation and its whole native family, deepest first,
/// then drains all queued inputs on that conversation and confirms a quiet family.
pub(super) async fn interrupt_task_root<C, F>(
    app: &App,
    root: &Value,
    started: Instant,
    deadline: Instant,
    checkpoint: &C,
) -> Result<Value, Error>
where
    C: Fn() -> F,
    F: Future<Output = Result<(), Error>>,
{
    let sid = root["id"].as_str().ok_or_else(unavailable)?;
    let total_deadline = started + Duration::from_secs(75);
    let mut ledger = Ledger::default();
    let descendants = interrupt_family(app, root, true, checkpoint, &mut ledger, deadline).await?;
    checkpoint().await?;
    let root_ack = interrupt(app, sid).await?;
    let recheck_deadline = || (Instant::now() + FAMILY_RECHECK_BUDGET).min(total_deadline);
    let caught = recheck(app, root, true, checkpoint, &mut ledger, &descendants, true, recheck_deadline()).await?;
    let mut cancellations = Vec::new();
    let settled = settle_root(app, sid, true, checkpoint, |_| true, &mut cancellations).await?;
    let verified = recheck(app, root, true, checkpoint, &mut ledger, &caught, false, recheck_deadline()).await?;
    let mut descendants = verified;
    if !settled {
        descendants["unconfirmed"] = json!(descendants["unconfirmed"].as_u64().unwrap_or(0) + 1);
        descendants["complete"] = json!(false);
    }
    Ok(json!({
        "sessionID": sid,
        "interrupted": root_ack["interrupted"] == true,
        "settled": settled,
        "descendants": descendants,
    }))
}

pub async fn apply<C, F>(
    app: &App,
    root: &Value,
    action: &str,
    mid: &str,
    checkpoint: C,
) -> Result<Value, Error>
where
    C: Fn() -> F,
    F: Future<Output = Result<(), Error>>,
{
    let sid = root["id"].as_str().ok_or_else(unavailable)?;
    let stop = action == "stop";
    let mut ledger = Ledger::default();
    let descendants =
        interrupt_family(app, root, stop, &checkpoint, &mut ledger, Instant::now() + FAMILY_CONTROL_BUDGET).await?;
    checkpoint().await?;
    let root_ack = interrupt(app, sid).await?;
    let mut cancellations = Vec::<(String, &'static str)>::new();
    let mut overflow = false;
    if stop {
        let queued = inbox(app, sid)
            .await?
            .into_iter()
            .filter(|x| cancellable(x, mid))
            .collect::<Vec<_>>();
        overflow = queued.len() > MAX_STOP_CANCELLATIONS;
        for item in queued.iter().take(MAX_STOP_CANCELLATIONS) {
            checkpoint().await?;
            let key = item["id"].as_str().ok_or_else(unavailable)?;
            let acknowledged = native(
                app,
                Method::DELETE,
                &format!("/api/session/{sid}/inbox/{key}"),
                &[],
                None,
                4096,
            )
            .await
            .is_ok();
            if !acknowledged && inbox(app, sid).await?.iter().any(|i| i["id"] == key) {
                return Err(unavailable());
            }
            cancellations.push((
                key.to_owned(),
                if acknowledged { "native-acknowledged" } else { "observed-absent" },
            ));
        }
    }
    let caught = recheck(
        app,
        root,
        stop,
        &checkpoint,
        &mut ledger,
        &descendants,
        true,
        Instant::now() + FAMILY_RECHECK_BUDGET,
    )
    .await?;
    let settled = settle_root(app, sid, stop, &checkpoint, |x| cancellable(x, mid), &mut cancellations).await?;
    let verified = recheck(
        app,
        root,
        stop,
        &checkpoint,
        &mut ledger,
        &caught,
        false,
        Instant::now() + FAMILY_RECHECK_BUDGET,
    )
    .await?;
    let drained = !overflow
        || inbox(app, sid)
            .await
            .is_ok_and(|items| !items.iter().any(|x| cancellable(x, mid)));
    let mut descendants = verified;
    if !(settled && drained) {
        descendants["unconfirmed"] = json!(descendants["unconfirmed"].as_u64().unwrap_or(0) + 1);
        descendants["complete"] = json!(false);
    }
    checkpoint().await?;
    Ok(json!({"disposition":"interrupt-observed","interrupt":root_ack,
        "cancellations":cancellations.iter().map(|(id,kind)|json!({"inboxID":id,"disposition":kind})).collect::<Vec<_>>(),
        "descendants":descendants}))
}

pub async fn paused_context(
    app: &App,
    root: &Value,
    tasks: &Value,
    paused: &Value,
) -> Result<String, Error> {
    if paused["graceful"] == true {
        return Ok("\n\nThe mission was paused gracefully: you and your sub-agents were asked to finish the step in progress and stop. Delegated work may have stopped early. Read their last results, continue unfinished sub-agent conversations where they stopped rather than restarting them, and do not assume their work completed.".into());
    }
    let sessions = paused["sessions"].as_array();
    if sessions.is_none_or(Vec::is_empty) && paused["partial"] != true {
        return Ok(String::new());
    }
    let tree = walk(app, root, Instant::now() + Duration::from_secs(15)).await?;
    if crate::bench::family_trace() {
        eprintln!(
            "family resume inventory: total={} complete={} interrupted={}",
            tree.rows.len(),
            tree.complete,
            tree.rows
                .iter()
                .filter(|(_, r, d)| *d > 0 && r["outcome"] == "interrupted")
                .count()
        );
    }
    let found = tree
        .rows
        .iter()
        .filter(|(id, row, depth)| {
            *depth > 0
                && row["outcome"] == "interrupted"
                && sessions.is_some_and(|s| s.contains(&json!(id)))
        })
        .map(|(id, _, _)| id)
        .collect::<Vec<_>>();
    if found.is_empty() {
        return Ok(if paused["partial"]==true{"\n\nThe mission was paused while sub-agents may have been running; inspect the mission map for unfinished delegated work."}else{""}.into());
    }
    let detail = found
        .iter()
        .take(32)
        .map(|id| {
            tasks
                .as_array()
                .and_then(|t| t.iter().find(|t| t["actorSessionId"] == id.as_str()))
                .and_then(|t| t["key"].as_str())
                .map_or_else(|| id.to_string(), |key| format!("task {key} ({id})"))
        })
        .collect::<Vec<_>>()
        .join(", ");
    let more = if found.len() > 32 {
        format!(" and {} more", found.len() - 32)
    } else {
        String::new()
    };
    let partial = if !tree.complete || paused["partial"] == true {
        " The sub-agent inventory was incomplete; inspect the mission map for others."
    } else {
        ""
    };
    Ok(format!(
        "\n\nThese sub-agent conversations were interrupted when the mission was paused: {detail}{more}. Re-delegate or continue their unfinished tasks as needed; do not assume their work completed.{partial}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_never_cancels_a_foreign_root_input() {
        let mission = json!({"id":"a","type":"synthetic","payload":{"metadata":{"codenomad.mission":{"missionID":"msn_1"}}}});
        let subagent = json!({"id":"b","type":"synthetic","payload":{"metadata":{"source":"subagent"}}});
        let foreign = json!({"id":"c","type":"synthetic","payload":{"metadata":{}}});
        let other = json!({"id":"d","type":"user","payload":{"metadata":{"codenomad.mission":{"missionID":"msn_2"}}}});
        let user_subagent = json!({"id":"e","type":"user","payload":{"metadata":{"source":"subagent"}}});
        assert!(cancellable(&mission, "msn_1"));
        assert!(cancellable(&subagent, "msn_1"));
        assert!(!cancellable(&foreign, "msn_1"));
        assert!(!cancellable(&other, "msn_1"));
        assert!(!cancellable(&user_subagent, "msn_1"));
    }

    #[test]
    fn descendants_are_controlled_deepest_first() {
        let tree = Tree {
            rows: vec![
                ("root".into(), json!({}), 0),
                ("one".into(), json!({}), 1),
                ("three".into(), json!({}), 3),
                ("two".into(), json!({}), 2),
            ],
            complete: true,
        };
        let order = deepest_first(&tree)
            .into_iter()
            .map(|level| level.into_iter().map(|(id, _)| id).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        assert_eq!(order, vec![vec!["three"], vec!["two"], vec!["one"]]);
    }
}
