//! Per-subscriber event queues bounded in bytes: a slow subscriber's backlog folds the
//! events that supersede or extend each other, then trades a workspace's native events
//! for the resynchronization the UI runs after an upstream reconnect, never silently.
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering::Relaxed},
    },
};

use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// Backlog one subscriber may hold, and all subscribers together.
const SUBSCRIBER_BYTES: usize = 4 << 20;
const RETAINED_BYTES: usize = 32 << 20;
const BACKLOG: &str = "Event backlog exceeded";
const FOLD_BYTES: usize = 64 << 10;
/// Folded file changes beyond this collapse to one whole-directory change each.
const CHANGES: usize = 256;

#[derive(Clone, Copy, PartialEq)]
enum Fold {
    /// Concatenate this string field of the native event's data (volatile deltas).
    Append(&'static str),
    /// The later event carries the whole state.
    Replace,
    /// Union of `workspace.filesChanged` changes.
    Changes,
}

pub struct Frame {
    text: String,
    /// Workspace of a native (`instance.event`) frame: what a targeted resync re-reads.
    workspace: Option<String>,
    /// Ordering domain: frames fold only into the latest queued frame of their scope; a
    /// frame without one (status, lifecycle) is a barrier no later frame folds across.
    scope: Option<String>,
    fold: Option<(String, Fold)>,
}

impl Frame {
    fn new(value: &Value) -> Self {
        let (workspace, scope, fold) = classify(value);
        Frame { text: value.to_string(), workspace, scope, fold }
    }
}

fn classify(v: &Value) -> (Option<String>, Option<String>, Option<(String, Fold)>) {
    let ty = v["type"].as_str().unwrap_or_default();
    if ty == "instance.event" {
        let workspace = v["instanceId"].as_str().map(str::to_owned);
        let (event, data) = (&v["event"], &v["event"]["data"]);
        let native = event["type"].as_str().unwrap_or_default();
        let (Some(ws), Some(session)) = (&workspace, data["sessionID"].as_str()) else {
            return (workspace, None, None);
        };
        let part = |k: &str| format!("{native}\0{}\0{}", data["assistantMessageID"], data[k]);
        let fold = match native {
            "session.text.delta" | "session.reasoning.delta" => Some((part("ordinal"), Fold::Append("delta"))),
            "session.tool.input.delta" => Some((part("id"), Fold::Append("delta"))),
            "session.compaction.delta" => Some((native.to_owned(), Fold::Append("text"))),
            "session.tool.progress" => Some((part("id"), Fold::Replace)),
            "session.usage.updated" => Some((native.to_owned(), Fold::Replace)),
            _ => None,
        };
        let fold = fold.filter(|(_, how)| {
            event.get("durable").is_none() && !matches!(how, Fold::Append(f) if !data[*f].is_string())
        });
        return (workspace.clone(), Some(format!("{ws}\0{session}")), fold);
    }
    let key = match ty {
        "workspace.filesChanged" | "workspace.worktreesChanged" => format!("{ty}\0{}", v["workspaceId"]),
        "instance.dataChanged" => format!("{ty}\0{}", v["instanceId"]),
        "memory.changed" => ty.to_owned(),
        _ if ty.starts_with("storage.") => format!("{ty}\0{}", v["owner"]),
        _ => return (None, None, None),
    };
    let how = if ty == "workspace.filesChanged" { Fold::Changes } else { Fold::Replace };
    (None, Some(key.clone()), Some((key, how)))
}

struct Item {
    frame: Arc<Frame>,
    /// This subscriber's fold of several frames, serialized when sent.
    folded: Option<Value>,
    bytes: usize,
    /// The resync of this workspace is delivered once this item is sent.
    settles: Option<String>,
}

#[derive(Default)]
struct Queue {
    items: VecDeque<Item>,
    bytes: usize,
    /// Absolute index of `items[0]`; `tails` holds absolute indices.
    base: u64,
    tails: HashMap<String, u64>,
    owed: HashSet<String>,
    closing: bool,
}

#[derive(Default)]
pub struct Sub {
    queue: Mutex<Queue>,
    pub ready: Notify,
    reference_files: bool,
}

pub enum Next {
    Frame(String),
    Empty,
    /// The backlog was replaced by a global resync: the stream ends once it is sent.
    Closed,
}

#[derive(Default)]
pub struct Hub {
    subs: Mutex<Vec<Arc<Sub>>>,
    /// Latest `instance.eventStatus` per workspace, replayed to new subscribers and
    /// closing a resync, as the TS bus does.
    statuses: Mutex<HashMap<String, (u64, Arc<Frame>)>>,
    retained: AtomicUsize,
    pub shutdown: CancellationToken,
}

impl Hub {
    #[cfg(test)]
    pub fn subscribe(&self) -> Arc<Sub> {
        self.subscribe_to(false)
    }
    pub fn subscribe_to(&self, reference_files: bool) -> Arc<Sub> {
        let sub = Arc::new(Sub { reference_files, ..Default::default() });
        let mut subs = self.subs.lock().unwrap();
        {
            let mut q = sub.queue.lock().unwrap();
            for (_, frame) in self.statuses.lock().unwrap().values() {
                q.push(Item::new(frame.clone()), &self.retained);
            }
        }
        subs.push(sub.clone());
        self.trim_shared(&subs);
        sub
    }

    pub fn unsubscribe(&self, sub: &Arc<Sub>) {
        self.subs.lock().unwrap().retain(|s| !Arc::ptr_eq(s, sub));
        let mut q = sub.queue.lock().unwrap();
        self.retained.fetch_sub(std::mem::take(&mut q.bytes), Relaxed);
        q.items.clear();
    }

    pub fn publish(&self, value: Value) {
        let status = value["type"] == "instance.eventStatus";
        let subs = self.subs.lock().unwrap();
        if !status && subs.is_empty() {
            return;
        }
        let frame = Arc::new(Frame::new(&value));
        let preprojected =
            value["type"] == "instance.event" && crate::sessions::user_files::is_projected_inbox(&value["event"]);
        let projected = if subs.iter().any(|sub| sub.reference_files) {
            crate::sessions::user_files::projected_event(&value).map(|value| Arc::new(Frame::new(&value)))
        } else {
            None
        };
        if status && let Some(id) = value["instanceId"].as_str() {
            let mut statuses = self.statuses.lock().unwrap();
            let reason = value["reason"].as_str().unwrap_or_default();
            if value["status"] == "disconnected" && matches!(reason, "workspace stopped" | "workspace error") {
                statuses.remove(id);
            } else {
                statuses.insert(id.to_owned(), (value["generation"].as_u64().unwrap_or(0), frame.clone()));
            }
        }
        for sub in subs.iter() {
            let frame = if sub.reference_files { projected.as_ref().unwrap_or(&frame) } else { &frame };
            let mut q = sub.queue.lock().unwrap();
            if q.closing {
                continue;
            }
            if preprojected && !sub.reference_files {
                if let Some(workspace) = frame.workspace.as_deref() {
                    q.resync(workspace, &self.statuses.lock().unwrap(), &self.retained);
                }
                q.closing = true;
                sub.ready.notify_one();
                continue;
            }
            if !q.fold(frame, &value, &self.retained) {
                q.push(Item::new(frame.clone()), &self.retained);
            }
            if q.over() {
                q.shed(&self.statuses.lock().unwrap(), &self.retained, false);
            }
            drop(q);
            sub.ready.notify_one();
        }
        self.trim_shared(&subs);
    }

    fn trim_shared(&self, subs: &[Arc<Sub>]) {
        while self.retained.load(Relaxed) > RETAINED_BYTES {
            let worst = subs
                .iter()
                .filter_map(|sub| {
                    let q = sub.queue.lock().unwrap();
                    (!q.closing && q.bytes > 0).then_some((q.bytes, sub))
                })
                .max_by_key(|(bytes, _)| *bytes);
            let Some((_, sub)) = worst else { break };
            sub.queue.lock().unwrap().shed(&self.statuses.lock().unwrap(), &self.retained, true);
            sub.ready.notify_one();
        }
    }

    pub fn pop(&self, sub: &Sub) -> Next {
        let mut q = sub.queue.lock().unwrap();
        let Some(item) = q.items.pop_front() else { return if q.closing { Next::Closed } else { Next::Empty } };
        if let Some(scope) = &item.frame.scope
            && q.tails.get(scope) == Some(&q.base)
        {
            q.tails.remove(scope);
        }
        q.base += 1;
        q.bytes -= item.bytes;
        self.retained.fetch_sub(item.bytes, Relaxed);
        if let Some(ws) = &item.settles {
            q.owed.remove(ws);
        }
        if q.items.is_empty() {
            q.tails.clear();
        }
        Next::Frame(item.folded.map_or_else(|| item.frame.text.clone(), |v| v.to_string()))
    }
}

impl Item {
    fn new(frame: Arc<Frame>) -> Self {
        Item { bytes: frame.text.len(), frame, folded: None, settles: None }
    }
}

impl Queue {
    fn push(&mut self, item: Item, retained: &AtomicUsize) {
        let at = self.base + self.items.len() as u64;
        match &item.frame.scope {
            Some(scope) => _ = self.tails.insert(scope.clone(), at),
            None => self.tails.clear(),
        }
        self.bytes += item.bytes;
        retained.fetch_add(item.bytes, Relaxed);
        self.items.push_back(item);
    }

    /// Folds `frame` into the latest queued frame of its scope when that one has the same fold key.
    fn fold(&mut self, frame: &Arc<Frame>, value: &Value, retained: &AtomicUsize) -> bool {
        let (Some(scope), Some((key, how))) = (&frame.scope, &frame.fold) else { return false };
        let Some(item) =
            self.tails.get(scope).and_then(|at| at.checked_sub(self.base)).and_then(|i| self.items.get_mut(i as usize))
        else {
            return false;
        };
        if item.frame.fold.as_ref().map(|f| &f.0) != Some(key) {
            return false;
        }
        let before = item.bytes;
        match *how {
            Fold::Replace => *item = Item::new(frame.clone()),
            Fold::Append(field) => {
                let Some(next) = value["event"]["data"][field].as_str() else { return false };
                if item.bytes + frame.text.len() > FOLD_BYTES {
                    return false;
                }
                let folded =
                    item.folded.get_or_insert_with(|| serde_json::from_str(&item.frame.text).unwrap_or_default());
                let Some(Value::String(text)) = folded.pointer_mut(&format!("/event/data/{field}")) else {
                    return false;
                };
                text.push_str(next);
                item.bytes = item.frame.text.len() + folded.to_string().len();
            }
            Fold::Changes => {
                let Some(next) = value["changes"].as_array() else { return false };
                let folded =
                    item.folded.get_or_insert_with(|| serde_json::from_str(&item.frame.text).unwrap_or_default());
                let Some(changes) = folded["changes"].as_array_mut() else { return false };
                for change in next {
                    if !changes.contains(change) {
                        changes.push(change.clone());
                    }
                }
                if changes.len() > CHANGES {
                    let mut dirs = Vec::<Value>::new();
                    for change in changes.iter() {
                        let whole = json!({"directory": change["directory"], "path": "."});
                        if !dirs.contains(&whole) {
                            dirs.push(whole);
                        }
                    }
                    *changes = dirs;
                }
                item.bytes = item.frame.text.len() + folded.to_string().len();
            }
        }
        self.bytes = self.bytes + item.bytes - before;
        retained.fetch_add(item.bytes, Relaxed);
        retained.fetch_sub(before, Relaxed);
        true
    }

    /// One legal large frame may pass even when it exceeds the subscriber's backlog limit.
    fn over(&self) -> bool {
        self.bytes > SUBSCRIBER_BYTES
            && self.bytes - self.items.iter().map(|i| i.bytes).max().unwrap_or(0) > SUBSCRIBER_BYTES
    }

    /// Drops the native frames of the workspace holding the most bytes, owing it a resync,
    /// until the backlog fits; what still overflows is replaced by a global resync.
    fn shed(&mut self, statuses: &HashMap<String, (u64, Arc<Frame>)>, retained: &AtomicUsize, shared: bool) {
        self.tails.clear();
        while self.over() || (shared && retained.load(Relaxed) > RETAINED_BYTES) {
            let mut native = HashMap::<&str, usize>::new();
            for item in &self.items {
                if let Some(ws) = &item.frame.workspace {
                    *native.entry(ws).or_default() += item.bytes;
                }
            }
            let Some(ws) = native.into_iter().max_by_key(|(_, bytes)| *bytes).map(|(ws, _)| ws.to_owned()) else {
                break;
            };
            let mut freed = 0;
            self.items.retain(|i| {
                let keep = i.frame.workspace.as_ref() != Some(&ws);
                if !keep {
                    freed += i.bytes;
                }
                keep
            });
            self.bytes -= freed;
            retained.fetch_sub(freed, Relaxed);
            self.resync(&ws, statuses, retained);
        }
        if self.over() || (shared && retained.load(Relaxed) > RETAINED_BYTES) {
            retained.fetch_sub(std::mem::take(&mut self.bytes), Relaxed);
            self.items.clear();
            self.owed.clear();
            for ws in statuses.keys() {
                self.resync(ws, statuses, retained);
            }
            self.closing = true;
        }
    }

    /// `error` then the workspace's current status: the UI's `ConnectionResyncGate`
    /// re-reads this workspace once it is connected.
    fn resync(&mut self, ws: &str, statuses: &HashMap<String, (u64, Arc<Frame>)>, retained: &AtomicUsize) {
        if !self.owed.insert(ws.to_owned()) {
            return;
        }
        let status = statuses.get(ws);
        let error = json!({"type":"instance.eventStatus","instanceId":ws,"status":"error",
            "generation":status.map_or(0, |s| s.0),"reason":BACKLOG});
        let settles = |frame| Item { settles: Some(ws.to_owned()), ..Item::new(frame) };
        match status {
            Some((_, current)) => {
                self.push(Item::new(Arc::new(Frame::new(&error))), retained);
                self.push(settles(current.clone()), retained);
            }
            None => self.push(settles(Arc::new(Frame::new(&error))), retained),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WS: &str = "11111111-1111-1111-1111-111111111111";
    fn native(ws: &str, event: Value) -> Value {
        json!({"type":"instance.event","instanceId":ws,"event":event})
    }
    fn delta(session: &str, ordinal: u32, text: &str) -> Value {
        native(
            WS,
            json!({"type":"session.text.delta","data":{"sessionID":session,"assistantMessageID":"msg_1","ordinal":ordinal,"delta":text}}),
        )
    }
    fn status(status: &str) -> Value {
        json!({"type":"instance.eventStatus","instanceId":WS,"status":status,"generation":3})
    }
    fn drain(hub: &Hub, sub: &Sub) -> Vec<Value> {
        let mut out = vec![];
        while let Next::Frame(text) = hub.pop(sub) {
            out.push(serde_json::from_str(&text).unwrap());
        }
        out
    }
    fn text(events: &[Value], session: &str) -> String {
        events
            .iter()
            .filter(|e| e["event"]["data"]["sessionID"] == session)
            .filter_map(|e| e["event"]["data"]["delta"].as_str())
            .collect()
    }

    #[test]
    fn a_reading_subscriber_receives_every_frame_unchanged() {
        let hub = Hub::default();
        let sub = hub.subscribe();
        for i in 0..3 {
            hub.publish(delta("ses_a", 0, &i.to_string()));
            assert_eq!(drain(&hub, &sub), [delta("ses_a", 0, &i.to_string())]);
        }
    }

    #[test]
    fn a_large_inbox_attachment_projects_only_for_reference_subscribers() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let hub = Hub::default();
        let legacy = hub.subscribe();
        let references = hub.subscribe_to(true);
        let data = STANDARD.encode(vec![17; 255 * 1024]);
        let event = native(
            WS,
            json!({"type":"session.inbox.enqueued","data":{
                "sessionID":"ses_a","inboxID":"msg_seen","item":{"type":"user","payload":{
                    "files":[{"name":"example.bin","mime":"application/octet-stream","data":data}]
                }}
            }}),
        );
        hub.publish(event.clone());
        hub.publish(delta("ses_a", 1, "follow-up"));
        let raw = drain(&hub, &legacy);
        assert_eq!(&raw[0], &event);
        assert!(raw[0].to_string().len() > 256 * 1024);
        let projected = drain(&hub, &references);
        let file = &projected[0]["event"]["data"]["item"]["payload"]["files"][0];
        assert_eq!(file["source"]["type"], "deferred");
        assert!(file.get("data").is_none());
        assert!(projected[0].to_string().len() < 1024);
        assert_eq!(projected[1], delta("ses_a", 1, "follow-up"));
    }

    #[test]
    fn a_slow_subscriber_folds_deltas_without_crossing_other_events_of_the_session() {
        let hub = Hub::default();
        let (slow, fast) = (hub.subscribe(), hub.subscribe());
        let ended = native(
            WS,
            json!({"type":"session.text.ended","data":{"sessionID":"ses_a","assistantMessageID":"msg_1","ordinal":0,"text":"abcd"}}),
        );
        let mut sent = vec![];
        for event in [
            delta("ses_a", 0, "a"),
            delta("ses_b", 0, "x"),
            delta("ses_a", 0, "b"),
            delta("ses_a", 1, "c"),
            ended,
            delta("ses_a", 0, "d"),
        ] {
            hub.publish(event.clone());
            sent.push(event);
            assert_eq!(drain(&hub, &fast), [sent.last().unwrap().clone()]);
        }
        let got = drain(&hub, &slow);
        assert_eq!(got.len(), 5, "only a then b fold: another ordinal and the end are barriers");
        assert_eq!(got[0]["event"]["data"]["delta"], "ab");
        assert_eq!(got[2]["event"]["data"]["ordinal"], 1);
        assert_eq!(got[3]["event"]["type"], "session.text.ended");
        assert_eq!(text(&got, "ses_a"), text(&sent, "ses_a"), "no delta lost or doubled");
        assert_eq!(text(&got, "ses_b"), "x");
    }

    #[test]
    fn state_events_keep_only_the_latest_and_statuses_are_never_folded() {
        let hub = Hub::default();
        let sub = hub.subscribe();
        let usage = |n: u32| native(WS, json!({"type":"session.usage.updated","data":{"sessionID":"ses_a","cost":n}}));
        let stored = |n: u32| json!({"type":"storage.configChanged","owner":"ui","value":{"n":n}});
        for event in [usage(1), stored(1), usage(2), stored(2), status("error"), status("connected"), stored(3)] {
            hub.publish(event);
        }
        let got = drain(&hub, &sub);
        let types: Vec<_> = got.iter().map(|e| e["status"].as_str().unwrap_or(e["type"].as_str().unwrap())).collect();
        assert_eq!(types, ["instance.event", "storage.configChanged", "error", "connected", "storage.configChanged"]);
        assert_eq!(got[0]["event"]["data"]["cost"], 2);
        assert_eq!(got[1]["value"]["n"], 2, "a status is a barrier");
    }

    #[test]
    fn file_changes_fold_into_a_union_then_whole_directories() {
        let hub = Hub::default();
        let sub = hub.subscribe();
        let files = |paths: Vec<String>| {
            json!({"type":"workspace.filesChanged","workspaceId":WS,
            "changes": paths.into_iter().map(|p| json!({"directory":"/w","path":p})).collect::<Vec<_>>()})
        };
        hub.publish(files(vec!["a".into(), "b".into()]));
        hub.publish(files(vec!["b".into(), "c".into()]));
        assert_eq!(drain(&hub, &sub)[0]["changes"].as_array().unwrap().len(), 3);
        hub.publish(files(vec!["a".into()]));
        hub.publish(files((0..=CHANGES).map(|i| i.to_string()).collect()));
        assert_eq!(drain(&hub, &sub), [files(vec![".".into()])]);
    }

    #[test]
    fn overflow_trades_the_heaviest_workspace_for_a_targeted_resync() {
        let hub = Hub::default();
        let other = "22222222-2222-2222-2222-222222222222";
        hub.publish(status("connected"));
        let sub = hub.subscribe();
        let big = "x".repeat(64 << 10);
        let started = |ws: &str, i: u32| {
            native(ws, json!({"type":"session.text.started","data":{"sessionID":"ses_a","n":i,"pad":big}}))
        };
        hub.publish(native(other, json!({"type":"session.text.started","data":{"sessionID":"ses_b"}})));
        for i in 0..(SUBSCRIBER_BYTES / big.len() as usize + 8) as u32 {
            hub.publish(started(WS, i));
        }
        hub.publish(json!({"type":"memory.changed"}));
        let got = drain(&hub, &sub);
        let summary: Vec<_> =
            got.iter().map(|e| e["status"].as_str().or(e["instanceId"].as_str()).unwrap_or("-")).collect();
        let tail = summary.iter().position(|s| *s == "error").expect("a resync is owed");
        assert_eq!(&summary[..2], ["connected", other], "the replayed status and the other workspace stay");
        assert_eq!(summary[tail + 1], "connected", "error then the current status");
        assert_eq!(got[tail]["reason"], BACKLOG);
        assert_eq!(summary.iter().filter(|s| **s == "error").count(), 1, "one resync per workspace while owed");
        assert!(
            summary[tail + 2..].iter().all(|s| *s == WS || *s == "-"),
            "later frames of the workspace follow the resync"
        );
        assert!(got.iter().map(|e| e.to_string().len()).sum::<usize>() <= SUBSCRIBER_BYTES + (big.len() + 512) * 2);
        assert_eq!(hub.retained.load(Relaxed), 0, "sent frames release the shared budget");
    }

    #[test]
    fn untargetable_overflow_resyncs_every_workspace_and_closes() {
        let hub = Hub::default();
        hub.publish(status("connected"));
        let sub = hub.subscribe();
        drain(&hub, &sub);
        let big = "y".repeat(256 << 10);
        for i in 0..(SUBSCRIBER_BYTES / big.len() + 4) {
            hub.publish(json!({"type":"workspace.created","workspace":{"id":i,"pad":big}}));
        }
        hub.publish(json!({"type":"memory.changed"}));
        let got = drain(&hub, &sub);
        assert_eq!(
            got,
            [
                json!({"type":"instance.eventStatus","instanceId":WS,"status":"error","generation":3,"reason":BACKLOG}),
                status("connected")
            ]
        );
        assert!(matches!(hub.pop(&sub), Next::Closed));
        hub.unsubscribe(&sub);
        assert_eq!(hub.retained.load(Relaxed), 0);
    }

    #[test]
    fn statuses_replay_to_new_subscribers_until_the_workspace_stops() {
        let hub = Hub::default();
        hub.publish(status("connecting"));
        hub.publish(status("connected"));
        assert_eq!(drain(&hub, &hub.subscribe()), [status("connected")]);
        hub.publish(json!({"type":"instance.eventStatus","instanceId":WS,"status":"disconnected","generation":3,"reason":"workspace stopped"}));
        assert!(drain(&hub, &hub.subscribe()).is_empty());
    }

    #[test]
    fn shared_budget_recovers_the_slowest_queues_without_dropping_the_fast_stream() {
        let hub = Hub::default();
        hub.publish(status("connected"));
        let mut slow = Vec::new();
        for _ in 0..16 {
            slow.push(hub.subscribe());
        }
        let fast = hub.subscribe();
        assert_eq!(drain(&hub, &fast), [status("connected")]);
        let pad = "x".repeat(256 << 10);
        for i in 0..16 {
            let frame = native(WS, json!({"type":"session.text.started","data":{"sessionID":"ses_a","n":i,"pad":pad}}));
            hub.publish(frame.clone());
            assert!(hub.retained.load(Relaxed) <= RETAINED_BYTES);
            assert_eq!(drain(&hub, &fast), [frame]);
        }
        assert!(slow.iter().any(|s| drain(&hub, s).iter().any(|v| v["reason"] == BACKLOG)));
    }
}
