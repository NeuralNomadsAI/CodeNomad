//! Child transcript readers reuse the parent's multiplexed connection.
use crate::{Receiver, Sender, backend::Backend, history, http::Http};
use serde_json::Value;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

const MAX_INVALIDATED_IDS: usize = 64;

#[derive(Default)]
pub(crate) struct Children(Mutex<Watches>);

#[derive(Default)]
struct Watches {
    per_child: Vec<Watch>,
    sessions: Vec<SessionWatch>,
}

struct Watch {
    workspace: String,
    root: String,
    child: String,
    dirty: Sender<()>,
}

struct SessionWatch {
    workspace: String,
    root: String,
    queue: Arc<Mutex<Invalidations>>,
    notify: Sender<()>,
}

#[derive(Default)]
struct Invalidations {
    all: bool,
    ids: HashSet<String>,
    tracked: HashSet<String>,
}

#[derive(Clone)]
pub struct ChildInvalidations(Arc<Mutex<Invalidations>>);

impl ChildInvalidations {
    pub fn set_tracked(&self, tracked: HashSet<String>) {
        if let Ok(mut guard) = self.0.lock() {
            let guard = &mut *guard;
            guard.tracked = tracked;
            if guard.tracked.is_empty() {
                guard.all = false;
                guard.ids.clear();
            } else {
                guard.ids.retain(|id| guard.tracked.contains(id));
            }
        }
    }

    pub fn drain(&self) -> (bool, Vec<String>) {
        let Ok(mut guard) = self.0.lock() else {
            return (false, Vec::new());
        };
        let all = std::mem::replace(&mut guard.all, false);
        let ids = guard.ids.drain().collect();
        (all, ids)
    }
}

impl Children {
    pub(crate) fn invalidate(&self, b: &Backend, child: Option<&str>) {
        if let Ok(mut watches) = self.0.lock() {
            watches.per_child.retain(|watch| !watch.dirty.is_closed());
            for watch in watches.per_child.iter().filter(|watch| {
                watch.workspace == b.workspace
                    && watch.root == b.session
                    && child.is_none_or(|id| watch.child == id)
            }) {
                let _ = watch.dirty.try_send(());
            }
            watches.sessions.retain(|watch| !watch.notify.is_closed());
            for watch in watches
                .sessions
                .iter()
                .filter(|watch| watch.workspace == b.workspace && watch.root == b.session)
            {
                let mut wake = false;
                if let Ok(mut queue) = watch.queue.lock() {
                    match child {
                        None if !queue.tracked.is_empty() => {
                            queue.all = true;
                            queue.ids.clear();
                            wake = true;
                        }
                        None => {}
                        Some(id) if !queue.tracked.contains(id) => {}
                        Some(_) if queue.all => {
                            wake = true;
                        }
                        Some(_) if queue.ids.len() >= MAX_INVALIDATED_IDS => {
                            queue.all = true;
                            queue.ids.clear();
                            wake = true;
                        }
                        Some(id) => {
                            queue.ids.insert(id.to_owned());
                            wake = true;
                        }
                    }
                }
                if wake {
                    let _ = watch.notify.try_send(());
                }
            }
        }
    }
}

impl Backend {
    pub fn watch_children(&self) -> Option<(ChildInvalidations, Receiver<()>)> {
        let mut watches = self.client.children().0.lock().ok()?;
        watches.sessions.retain(|watch| !watch.notify.is_closed());
        let queue = Arc::new(Mutex::new(Invalidations::default()));
        let (notify, rx) = crate::bounded(1);
        watches.sessions.push(SessionWatch {
            workspace: self.workspace.clone(),
            root: self.session.clone(),
            queue: queue.clone(),
            notify,
        });
        Some((ChildInvalidations(queue), rx))
    }

    pub fn watch_child(&self, child: &str) -> Option<Receiver<()>> {
        if child == self.session || !history::valid_id(child) {
            return None;
        }
        let mut watches = self.client.children().0.lock().ok()?;
        watches.per_child.retain(|watch| !watch.dirty.is_closed());
        if watches.per_child.len() >= 32 {
            return None;
        }
        let (dirty, rx) = crate::bounded(1);
        watches.per_child.push(Watch {
            workspace: self.workspace.clone(),
            root: self.session.clone(),
            child: child.into(),
            dirty,
        });
        Some(rx)
    }

    pub async fn child_page(&self, child: &str) -> history::Result<Option<history::Page>> {
        self.child_page_for(&self.session, child).await
    }

    pub async fn child_page_for(
        &self,
        parent: &str,
        child: &str,
    ) -> history::Result<Option<history::Page>> {
        if child == parent
            || child == self.session
            || !history::valid_id(parent)
            || !history::valid_id(child)
        {
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
            Ok((native["id"] == child && native["parentID"] == parent)
                .then(|| native["location"].clone()))
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
    match event["type"].as_str() {
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
                b.client.children().invalidate(b, Some(id));
            }
        }
        Some("server.connected") => b.client.children().invalidate(b, None),
        _ => {}
    }
}
