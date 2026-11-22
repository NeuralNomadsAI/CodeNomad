use super::{Backend, Duration, Input, SeqCst, State, runtime, start};
use crate::{Wake, bounded, history::valid_id};
use serde_json::Value;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub enum CatalogueChanges {
    #[default]
    None,
    Workspaces(HashSet<String>),
    All,
}

pub(super) struct Signals {
    pending: Mutex<CatalogueChanges>,
    wake: Wake,
}

impl Signals {
    pub(super) fn invalidate(&self, workspace: Option<&str>) {
        let changed = {
            let mut pending = self.pending.lock().unwrap();
            match (&mut *pending, workspace) {
                (CatalogueChanges::All, _) => false,
                (_, None) => {
                    *pending = CatalogueChanges::All;
                    true
                }
                (CatalogueChanges::None, Some(id)) => {
                    *pending = CatalogueChanges::Workspaces(HashSet::from([id.to_owned()]));
                    true
                }
                (CatalogueChanges::Workspaces(ids), Some(id)) if ids.len() < 128 => {
                    ids.insert(id.to_owned())
                }
                (CatalogueChanges::Workspaces(_), Some(_)) => {
                    *pending = CatalogueChanges::All;
                    true
                }
            }
        };
        if changed {
            (self.wake)();
        }
    }

    pub(super) fn observe(&self, frame: &Value) {
        let Some(id) = frame["instanceId"].as_str().filter(|id| valid_id(id)) else {
            return;
        };
        let invalidates = match frame["type"].as_str() {
            Some("instance.eventStatus") => frame["status"] == "connected",
            Some("instance.event") => matches!(
                frame["event"]["type"].as_str(),
                Some(
                    "server.connected"
                        | "session.created"
                        | "session.forked"
                        | "session.renamed"
                        | "session.archived"
                        | "session.unarchived"
                        | "session.moved"
                        | "session.deleted"
                        | "worktree.updated"
                )
            ),
            _ => false,
        };
        if invalidates {
            self.invalidate(Some(id));
        }
    }
}

/// One scoped catalogue observer per backend attachment, independent of message recovery.
pub struct CatalogueWatch {
    signals: Arc<Signals>,
    _stop: crate::Sender<()>,
}

impl CatalogueWatch {
    pub fn new(backend: Backend, wake: Wake) -> Self {
        let signals = Arc::new(Signals {
            pending: Mutex::default(),
            wake,
        });
        let (stop, cancelled) = bounded(1);
        let observer = signals.clone();
        runtime::spawn(async move {
            let (out, events) = bounded(2);
            let mut epoch = 0;
            let mut delay = 250;
            while !cancelled.is_closed() {
                epoch += 1;
                let state = Arc::new(State {
                    catalogue: Some(observer.clone()),
                    ..State::default()
                });
                start(backend.clone(), epoch, out.clone(), state.clone());
                futures_lite::future::race(
                    async {
                        while let Ok(event) = events.recv().await {
                            match event {
                                Input::Opened(_) => delay = 250,
                                Input::Closed(_) => break,
                                _ => {}
                            }
                        }
                    },
                    async {
                        let _ = cancelled.recv().await;
                    },
                )
                .await;
                state.cancelled.store(true, SeqCst);
                futures_lite::future::race(runtime::sleep(Duration::from_millis(delay)), async {
                    let _ = cancelled.recv().await;
                })
                .await;
                delay = (delay * 2).min(4000);
            }
        });
        Self {
            signals,
            _stop: stop,
        }
    }

    pub fn take(&self) -> CatalogueChanges {
        std::mem::take(&mut *self.signals.pending.lock().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn independent_catalogue_signals_coalesce_and_ignore_transcript_frames() {
        let signals = Signals {
            pending: Mutex::default(),
            wake: Arc::new(|| {}),
        };
        for (id, kind) in [
            ("a", "session.created"),
            ("a", "session.renamed"),
            ("b", "worktree.updated"),
            ("c", "session.text.delta"),
        ] {
            signals
                .observe(&json!({"type":"instance.event","instanceId":id,"event":{"type":kind}}));
        }
        let mut pending = signals.pending.lock().unwrap();
        assert!(
            matches!(&*pending, CatalogueChanges::Workspaces(ids) if ids == &HashSet::from(["a".into(), "b".into()]))
        );
        *pending = CatalogueChanges::None;
        drop(pending);
        signals.invalidate(None);
        assert!(matches!(
            *signals.pending.lock().unwrap(),
            CatalogueChanges::All
        ));
    }
}
