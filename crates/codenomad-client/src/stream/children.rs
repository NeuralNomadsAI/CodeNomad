//! Child transcript readers reuse the parent's multiplexed connection.
use crate::{Receiver, Sender, backend::Backend, history, http::Http};
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering::SeqCst},
};

#[derive(Default)]
pub(crate) struct Children(Mutex<Vec<Watch>>);

struct Watch {
    workspace: String,
    root: String,
    child: String,
    dirty: Sender<()>,
    terminal: Arc<AtomicBool>,
}

impl Children {
    pub(crate) fn invalidate(&self, b: &Backend, child: Option<&str>, terminal: bool) {
        if let Ok(mut watches) = self.0.lock() {
            watches.retain(|watch| !watch.dirty.is_closed());
            for watch in watches.iter().filter(|watch| {
                watch.workspace == b.workspace
                    && watch.root == b.session
                    && child.is_none_or(|id| watch.child == id)
            }) {
                if terminal {
                    watch.terminal.store(true, SeqCst);
                }
                let _ = watch.dirty.try_send(());
            }
        }
    }
}

impl Backend {
    pub fn watch_child(&self, child: &str) -> Option<(Receiver<()>, Arc<AtomicBool>)> {
        if child == self.session || !history::valid_id(child) {
            return None;
        }
        let mut watches = self.client.children().0.lock().ok()?;
        watches.retain(|watch| !watch.dirty.is_closed());
        if watches.len() >= 32 {
            return None;
        }
        let (dirty, rx) = crate::bounded(1);
        let terminal = Arc::new(AtomicBool::new(false));
        watches.push(Watch {
            workspace: self.workspace.clone(),
            root: self.session.clone(),
            child: child.into(),
            dirty,
            terminal: terminal.clone(),
        });
        Some((rx, terminal))
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
            let response = record(&self.client, child).send().await?;
            if matches!(response.status().as_u16(), 403 | 404 | 410) {
                return Ok::<_, history::Error>(None);
            }
            let response = crate::backend::read_json(response.error_for_status()?).await?;
            let native = response.get("data").unwrap_or(&response);
            Ok(
                (native["id"] == child && native["parentID"] == self.session)
                    .then(|| native["location"].clone()),
            )
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
                let terminal = matches!(
                    kind,
                    Some(
                        "session.tool.success"
                            | "session.tool.failed"
                            | "session.execution.succeeded"
                            | "session.execution.failed"
                            | "session.execution.interrupted"
                    )
                );
                b.client.children().invalidate(b, Some(id), terminal);
            }
        }
        Some("server.connected") => b.client.children().invalidate(b, None, false),
        _ => {}
    }
}
