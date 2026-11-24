//! Child transcript readers reuse the parent's multiplexed connection.
use crate::{Receiver, Sender, backend::Backend, history, http::Http, runtime::Instant};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

const MAX_ANCESTOR_HOPS: usize = 5;
const MAX_OWED_CALLS: usize = 64;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const OWNERSHIP_BUDGET: Duration = Duration::from_secs(10);

#[derive(Clone, Debug)]
pub struct ChildToolEnd {
    pub message: Option<String>,
    pub call: String,
    pub ended: Option<u64>,
}

#[derive(Default)]
pub struct ChildSettlement(Mutex<SettlementState>);

#[derive(Default)]
struct SettlementState {
    calls: HashMap<(Option<String>, String), Option<u64>>,
    execution_ended: bool,
    execution_ended_at: Option<u64>,
}

impl ChildSettlement {
    fn record(&self, signal: &ChildSignal) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        match signal {
            ChildSignal::Dirty => {}
            ChildSignal::ToolEnded(Some(end)) => {
                let key = (end.message.clone(), end.call.clone());
                if state.calls.contains_key(&key) || state.calls.len() < MAX_OWED_CALLS {
                    state.calls.insert(key, end.ended);
                }
            }
            ChildSignal::ToolEnded(None) => {
                state.execution_ended = true;
            }
            ChildSignal::ExecutionEnded(at) => {
                state.execution_ended = true;
                if at.is_some() {
                    state.execution_ended_at = *at;
                }
            }
        }
    }

    pub fn take(&self) -> (Vec<ChildToolEnd>, bool, Option<u64>) {
        let Ok(mut state) = self.0.lock() else {
            return (Vec::new(), false, None);
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
        let execution_ended = std::mem::take(&mut state.execution_ended);
        let execution_ended_at = state.execution_ended_at.take();
        (calls, execution_ended, execution_ended_at)
    }
}

pub(crate) enum ChildSignal {
    Dirty,
    ToolEnded(Option<ChildToolEnd>),
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

    async fn child_page_checked(
        &self,
        child: &str,
        expected_parent: Option<&str>,
    ) -> history::Result<Option<history::Page>> {
        if child == self.session || !history::valid_id(child) {
            return Err("invalid task child".into());
        }
        let record = |client: &Http, id: &str, timeout: Duration| {
            client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{id}",
                    self.base, self.workspace
                ))
                .timeout(timeout)
        };
        let owned = || async {
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
                    return Ok::<_, history::Error>(None);
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
        };
        let Some(location) = owned().await? else {
            return Ok(None);
        };
        let mut target = self.clone();
        target.session = child.into();
        let page = target.page(serde_json::json!({"kind":"latest"})).await?;
        Ok((owned().await? == Some(location)).then_some(page))
    }
}

pub(super) fn observe(b: &Backend, event: &Value) {
    let kind = event["type"].as_str();
    match kind {
        Some(
            "session.tool.called"
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
                let signal = match kind {
                    Some("session.tool.success" | "session.tool.failed") => {
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
                        ChildSignal::ToolEnded(end)
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
