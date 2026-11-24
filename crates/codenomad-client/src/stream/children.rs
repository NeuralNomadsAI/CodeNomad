//! Child transcript readers reuse the parent's multiplexed connection.
use crate::{Receiver, Sender, backend::Backend, history, http::Http};
use serde_json::Value;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

const MAX_ANCESTOR_HOPS: usize = 8;
const MAX_OWED_CALLS: usize = 64;

#[derive(Default)]
pub struct ChildSettlement(Mutex<SettlementState>);

#[derive(Default)]
struct SettlementState {
    calls: HashSet<String>,
    execution_ended: bool,
}

impl ChildSettlement {
    fn record(&self, signal: &ChildSignal) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        match signal {
            ChildSignal::Dirty => {}
            ChildSignal::ToolEnded(Some(call)) => {
                if state.calls.len() < MAX_OWED_CALLS {
                    state.calls.insert(call.clone());
                }
            }
            ChildSignal::ToolEnded(None) | ChildSignal::ExecutionEnded => {
                state.execution_ended = true;
            }
        }
    }

    pub fn take(&self) -> (Vec<String>, bool) {
        let Ok(mut state) = self.0.lock() else {
            return (Vec::new(), false);
        };
        let calls = state.calls.drain().collect();
        let execution_ended = std::mem::take(&mut state.execution_ended);
        (calls, execution_ended)
    }
}

pub(crate) enum ChildSignal {
    Dirty,
    ToolEnded(Option<String>),
    ExecutionEnded,
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
        if child == self.session || !history::valid_id(child) {
            return Err("invalid task child".into());
        }
        let record = |client: &Http, id: &str| {
            client.get(format!(
                "{}workspaces/{}/instance/api/session/{id}",
                self.base, self.workspace
            ))
        };
        let owned = || async {
            let mut current = child.to_owned();
            let mut visited = HashSet::new();
            let mut leaf_location = None;
            for _ in 0..MAX_ANCESTOR_HOPS {
                if !visited.insert(current.clone()) {
                    return Ok::<_, history::Error>(None);
                }
                let response = record(&self.client, &current).send().await?;
                if matches!(response.status().as_u16(), 403 | 404 | 410) {
                    return Ok(None);
                }
                let response = crate::backend::read_json(response.error_for_status()?).await?;
                let native = response.get("data").unwrap_or(&response);
                if native["id"] != current {
                    return Ok(None);
                }
                if leaf_location.is_none() {
                    leaf_location = Some(native["location"].clone());
                }
                let Some(parent) = native["parentID"].as_str().filter(|id| !id.is_empty()) else {
                    return Ok(None);
                };
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
                        let call = event["data"]["id"]
                            .as_str()
                            .filter(|c| !c.is_empty() && c.len() <= 256)
                            .map(str::to_owned);
                        ChildSignal::ToolEnded(call)
                    }
                    Some(
                        "session.execution.succeeded"
                        | "session.execution.failed"
                        | "session.execution.interrupted",
                    ) => ChildSignal::ExecutionEnded,
                    _ => ChildSignal::Dirty,
                };
                b.client.children().invalidate(b, Some(id), signal);
            }
        }
        Some("server.connected") => b.client.children().invalidate_all(b),
        _ => {}
    }
}
