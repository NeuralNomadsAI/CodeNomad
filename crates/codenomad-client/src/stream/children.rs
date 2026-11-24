//! Child transcript readers reuse the parent's multiplexed connection.
use crate::{Receiver, Sender, backend::Backend, history, http::Http, runtime::Instant};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering::SeqCst},
    },
    time::Duration,
};

const MAX_ANCESTOR_HOPS: usize = 5;
const MAX_OWED_CALLS: usize = 64;
const MAX_LIVE_EVENTS: usize = 64;
const MAX_EVENT_BYTES: usize = 256 * 1024;
const MAX_QUEUE_BYTES: usize = 512 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const OWNERSHIP_BUDGET: Duration = Duration::from_secs(10);

#[derive(Clone, Debug)]
pub struct ChildToolEnd {
    pub message: Option<String>,
    pub call: String,
    pub ended: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct ChildToolEvent {
    pub message: Option<String>,
    pub kind: String,
    pub data: Value,
    pub at: Option<u64>,
    pub bytes: usize,
}

#[derive(Default)]
pub struct ChildSettlement {
    state: Mutex<SettlementState>,
    revocation_gen: AtomicU64,
}

#[derive(Default)]
struct SettlementState {
    calls: HashMap<(Option<String>, String), Option<u64>>,
    events: Vec<ChildToolEvent>,
    event_bytes: usize,
    execution_ended: bool,
    execution_ended_at: Option<u64>,
    revoked: bool,
}

impl ChildSettlement {
    pub fn revocation_gen(&self) -> u64 {
        self.revocation_gen.load(SeqCst)
    }

    fn record(&self, signal: &ChildSignal) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        match signal {
            ChildSignal::Dirty => {}
            ChildSignal::Revoked => {
                self.revocation_gen.fetch_add(1, SeqCst);
                state.revoked = true;
                state.events.clear();
                state.event_bytes = 0;
                state.calls.clear();
                state.execution_ended = false;
                state.execution_ended_at = None;
            }
            ChildSignal::ToolEvent(ev) => {
                if !state.revoked {
                    Self::push_event(&mut state, ev);
                }
            }
            ChildSignal::ToolEnded(end, ev) => {
                if !state.revoked {
                    if let Some(ev) = ev {
                        Self::push_event(&mut state, ev);
                    }
                    if let Some(end) = end {
                        let key = (end.message.clone(), end.call.clone());
                        if state.calls.contains_key(&key) || state.calls.len() < MAX_OWED_CALLS {
                            state.calls.insert(key, end.ended);
                        }
                    } else {
                        state.execution_ended = true;
                    }
                }
            }
            ChildSignal::ExecutionEnded(at) => {
                if !state.revoked {
                    state.execution_ended = true;
                    if at.is_some() {
                        state.execution_ended_at = *at;
                    }
                }
            }
        }
    }

    fn push_event(state: &mut SettlementState, ev: &ChildToolEvent) {
        if ev.bytes > MAX_EVENT_BYTES {
            return;
        }
        if ev.kind == "session.tool.progress"
            && let Some(call) = ev.data["id"].as_str()
        {
            let already_ended = state
                .calls
                .keys()
                .any(|(msg, c)| c == call && (msg.is_none() || *msg == ev.message))
                || state.events.iter().any(|prev| {
                    matches!(
                        prev.kind.as_str(),
                        "session.tool.success" | "session.tool.failed"
                    ) && prev.message == ev.message
                        && prev.data["id"].as_str() == Some(call)
                });
            if already_ended {
                return;
            }
            if let Some(pos) = state.events.iter().rposition(|prev| {
                prev.kind == "session.tool.progress"
                    && prev.message == ev.message
                    && prev.data["id"].as_str() == Some(call)
            }) {
                let removed = state.events.remove(pos);
                state.event_bytes = state.event_bytes.saturating_sub(removed.bytes);
            }
        }
        let next_bytes = state.event_bytes.saturating_add(ev.bytes);
        if state.events.len() < MAX_LIVE_EVENTS && next_bytes <= MAX_QUEUE_BYTES {
            state.events.push(ev.clone());
            state.event_bytes = next_bytes;
        }
    }

    pub fn take(
        &self,
    ) -> (
        Vec<ChildToolEnd>,
        Vec<ChildToolEvent>,
        bool,
        Option<u64>,
        bool,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return (Vec::new(), Vec::new(), false, None, false);
        };
        let calls = state
            .calls
            .drain()
            .map(|((message, call), ended)| ChildToolEnd {
                message,
                call,
                ended,
            })
            .collect();
        let events = std::mem::take(&mut state.events);
        state.event_bytes = 0;
        let execution_ended = std::mem::take(&mut state.execution_ended);
        let execution_ended_at = state.execution_ended_at.take();
        let revoked = std::mem::take(&mut state.revoked);
        (calls, events, execution_ended, execution_ended_at, revoked)
    }
}

pub(crate) enum ChildSignal {
    Dirty,
    Revoked,
    ToolEvent(ChildToolEvent),
    ToolEnded(Option<ChildToolEnd>, Option<ChildToolEvent>),
    ExecutionEnded(Option<u64>),
}

#[derive(Default)]
pub(crate) struct Children(Mutex<Vec<Watch>>);

struct Watch {
    workspace: String,
    root: String,
    child: String,
    dirty: Sender<()>,
    settlement: Arc<ChildSettlement>,
}

impl Children {
    pub(crate) fn invalidate_all(&self, b: &Backend) {
        self.invalidate(b, None, ChildSignal::Dirty);
    }

    pub(crate) fn invalidate(&self, b: &Backend, child: Option<&str>, signal: ChildSignal) {
        if let Ok(mut watches) = self.0.lock() {
            watches.retain(|watch| !watch.dirty.is_closed());
            for watch in watches.iter().filter(|watch| {
                watch.workspace == b.workspace
                    && watch.root == b.session
                    && child.is_none_or(|id| watch.child == id)
            }) {
                watch.settlement.record(&signal);
                let _ = watch.dirty.try_send(());
            }
        }
    }
}

impl Backend {
    pub fn watch_child(&self, child: &str) -> Option<(Receiver<()>, Arc<ChildSettlement>)> {
        if child == self.session || !history::valid_id(child) {
            return None;
        }
        let mut watches = self.client.children().0.lock().ok()?;
        watches.retain(|watch| !watch.dirty.is_closed());
        if watches.len() >= 32 {
            return None;
        }
        let (dirty, rx) = crate::bounded(1);
        let settlement = Arc::new(ChildSettlement::default());
        watches.push(Watch {
            workspace: self.workspace.clone(),
            root: self.session.clone(),
            child: child.into(),
            dirty,
            settlement: settlement.clone(),
        });
        Some((rx, settlement))
    }

    pub async fn child_page(&self, child: &str) -> history::Result<Option<history::Page>> {
        self.child_page_checked(child, None).await
    }

    pub async fn child_page_under(
        &self,
        child: &str,
        expected_parent: &str,
    ) -> history::Result<Option<history::Page>> {
        if !history::valid_id(expected_parent) {
            return Err("invalid task child".into());
        }
        self.child_page_checked(child, Some(expected_parent)).await
    }

    async fn verify_child_ownership(
        &self,
        child: &str,
        expected_parent: Option<&str>,
    ) -> history::Result<Option<Value>> {
        let record = |client: &Http, id: &str, timeout: Duration| {
            client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{id}",
                    self.base, self.workspace
                ))
                .timeout(timeout)
        };
        let deadline = Instant::now() + OWNERSHIP_BUDGET;
        let mut current = child.to_owned();
        let mut visited = HashSet::new();
        let mut leaf_location = None;
        for hop in 0..MAX_ANCESTOR_HOPS {
            let now = Instant::now();
            if now >= deadline {
                return Err("child ownership check timed out".into());
            }
            if !visited.insert(current.clone()) {
                return Ok(None);
            }
            let remaining = (deadline - now).min(PROBE_TIMEOUT);
            let response = record(&self.client, &current, remaining).send().await?;
            if matches!(response.status().as_u16(), 403 | 404 | 410) {
                return Ok(None);
            }
            let response = crate::backend::read_json(response.error_for_status()?).await?;
            let native = response.get("data").unwrap_or(&response);
            if native["id"] != current {
                return Ok(None);
            }
            let Some(parent) = native["parentID"].as_str().filter(|id| !id.is_empty()) else {
                return Ok(None);
            };
            if hop == 0 {
                if expected_parent.is_some_and(|expected| parent != expected) {
                    return Ok(None);
                }
                leaf_location = Some(native["location"].clone());
            }
            if parent == self.session {
                return Ok(leaf_location);
            }
            if !history::valid_id(parent) {
                return Ok(None);
            }
            current = parent.to_owned();
        }
        Ok(None)
    }

    async fn child_page_checked(
        &self,
        child: &str,
        expected_parent: Option<&str>,
    ) -> history::Result<Option<history::Page>> {
        if child == self.session || !history::valid_id(child) {
            return Err("invalid task child".into());
        }
        let Some(location) = self.verify_child_ownership(child, expected_parent).await? else {
            return Ok(None);
        };
        let mut target = self.clone();
        target.session = child.into();
        let page = target.page(serde_json::json!({"kind":"latest"})).await?;
        Ok(
            (self.verify_child_ownership(child, expected_parent).await? == Some(location))
                .then_some(page),
        )
    }

    pub async fn child_ownership_token(
        &self,
        child: &str,
        expected_parent: &str,
    ) -> history::Result<Option<Value>> {
        if child == self.session || !history::valid_id(child) || !history::valid_id(expected_parent)
        {
            return Err("invalid task child".into());
        }
        self.verify_child_ownership(child, Some(expected_parent))
            .await
    }

    pub async fn child_page_request(
        &self,
        child: &str,
        request: Value,
    ) -> history::Result<history::Page> {
        if child == self.session || !history::valid_id(child) {
            return Err("invalid task child".into());
        }
        let mut target = self.clone();
        target.session = child.into();
        target.page(request).await
    }

    pub async fn child_raw_tools_request(
        &self,
        child: &str,
        request: Value,
    ) -> history::Result<(Vec<(String, Vec<Value>)>, Option<Value>)> {
        if child == self.session || !history::valid_id(child) {
            return Err("invalid task child".into());
        }
        let mut target = self.clone();
        target.session = child.into();
        target.page_raw_tools(request).await
    }
}

pub(super) fn observe(b: &Backend, event: &Value) {
    let kind = event["type"].as_str();
    match kind {
        Some(
            "session.tool.input.started"
            | "session.tool.input.delta"
            | "session.tool.input.ended"
            | "session.tool.called"
            | "session.tool.progress"
            | "session.tool.success"
            | "session.tool.failed"
            | "session.step.ended"
            | "session.synthetic"
            | "session.moved"
            | "session.deleted"
            | "session.revert.committed"
            | "session.execution.succeeded"
            | "session.execution.failed"
            | "session.execution.interrupted",
        ) => {
            if let Some(id) = event["data"]["sessionID"].as_str()
                && id != b.session
            {
                let tool_event = |kind: &str| -> Option<ChildToolEvent> {
                    let data = &event["data"];
                    data["id"]
                        .as_str()
                        .filter(|c| !c.is_empty() && c.len() <= 256)?;
                    let bytes = crate::content::json_bytes(data);
                    if bytes > MAX_EVENT_BYTES {
                        return None;
                    }
                    Some(ChildToolEvent {
                        message: data["assistantMessageID"]
                            .as_str()
                            .filter(|m| history::valid_id(m))
                            .map(str::to_owned),
                        kind: kind.to_owned(),
                        data: data.clone(),
                        at: event["created"].as_u64(),
                        bytes,
                    })
                };
                let signal = match kind {
                    Some("session.moved" | "session.deleted" | "session.revert.committed") => {
                        ChildSignal::Revoked
                    }
                    Some(
                        k @ ("session.tool.input.started"
                        | "session.tool.input.delta"
                        | "session.tool.input.ended"
                        | "session.tool.called"
                        | "session.tool.progress"),
                    ) => tool_event(k).map_or(ChildSignal::Dirty, ChildSignal::ToolEvent),
                    Some(k @ ("session.tool.success" | "session.tool.failed")) => {
                        let end = event["data"]["id"]
                            .as_str()
                            .filter(|c| !c.is_empty() && c.len() <= 256)
                            .map(|call| ChildToolEnd {
                                message: event["data"]["assistantMessageID"]
                                    .as_str()
                                    .filter(|m| history::valid_id(m))
                                    .map(str::to_owned),
                                call: call.to_owned(),
                                ended: event["created"].as_u64(),
                            });
                        ChildSignal::ToolEnded(end, tool_event(k))
                    }
                    Some(
                        "session.execution.succeeded"
                        | "session.execution.failed"
                        | "session.execution.interrupted",
                    ) => ChildSignal::ExecutionEnded(event["created"].as_u64()),
                    _ => ChildSignal::Dirty,
                };
                b.client.children().invalidate(b, Some(id), signal);
            }
        }
        Some("server.connected") => b.client.children().invalidate_all(b),
        _ => {}
    }
}
