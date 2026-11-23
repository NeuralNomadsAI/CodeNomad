use super::{Backend, Duration, Input, SeqCst, State, runtime, start};
use crate::{Wake, bounded, history::valid_id, transport::WorkspaceEvent};
use serde_json::Value;
use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex},
};

pub struct AttentionHint {
    pub workspace: String,
    pub session: String,
    pub event: WorkspaceEvent,
}

#[derive(Default)]
pub enum CatalogueChanges {
    #[default]
    None,
    Workspaces(HashSet<String>),
    All,
}

pub(super) struct Signals {
    pending: Mutex<CatalogueChanges>,
    providers: Mutex<CatalogueChanges>,
    stopped: Mutex<CatalogueChanges>,
    attention: Mutex<VecDeque<AttentionHint>>,
    wake: Wake,
    generation: std::sync::atomic::AtomicU64,
}

impl Signals {
    pub(super) fn invalidate_all(&self) {
        if self.mark(&self.pending, None) | self.mark(&self.providers, None) {
            (self.wake)();
        }
    }

    pub(super) fn reconnected(&self) {
        self.mark(&self.pending, None);
        self.mark(&self.providers, None);
        self.generation.fetch_add(1, SeqCst);
        (self.wake)();
    }

    fn disconnected(&self) {
        self.attention.lock().unwrap().clear();
        if self.generation.load(SeqCst) % 2 == 1 {
            self.generation.fetch_add(1, SeqCst);
            (self.wake)();
        }
    }

    fn mark(&self, lane: &Mutex<CatalogueChanges>, workspace: Option<&str>) -> bool {
        {
            let mut pending = lane.lock().unwrap();
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
        }
    }

    pub(super) fn observe(&self, frame: &Value) {
        let provider_changed = crate::settings::provider_change(frame)
            .is_some_and(|id| self.mark(&self.providers, Some(id)));
        let kind = frame["type"].as_str();
        let workspace = match kind {
            Some("workspace.worktreesChanged" | "workspace.stopped") => &frame["workspaceId"],
            _ => &frame["instanceId"],
        };
        let Some(id) = workspace.as_str().filter(|id| valid_id(id)) else {
            return;
        };
        let stopped = kind == Some("workspace.stopped") && self.mark(&self.stopped, Some(id));
        let attention =
            kind == Some("instance.event") && self.observe_attention(id, &frame["event"]);
        let invalidates = match kind {
            Some("workspace.worktreesChanged" | "workspace.stopped") => true,
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
        if (invalidates && self.mark(&self.pending, Some(id)))
            | provider_changed
            | stopped
            | attention
        {
            (self.wake)();
        }
    }

    fn observe_attention(&self, workspace: &str, event: &Value) -> bool {
        let data = &event["data"];
        let session = if event["type"] == "form.created" {
            &data["form"]["sessionID"]
        } else {
            &data["sessionID"]
        };
        let other = super::notifications::other_notice(event);
        let Some(session) = session
            .as_str()
            .filter(|id| valid_id(id))
            .or_else(|| matches!(other, Some(WorkspaceEvent::OpenCodeNotice { .. })).then_some(""))
        else {
            return false;
        };
        let terminal = match event["type"].as_str() {
            Some("form.replied" | "form.cancelled") => Some((true, &data["id"])),
            Some("permission.replied") => Some((false, &data["requestID"])),
            _ => None,
        };
        let mapped = if let Some((form, id)) = terminal {
            id.as_str()
                .filter(|id| valid_id(id))
                .map(|id| WorkspaceEvent::SessionRequestResolved {
                    form,
                    id: id.into(),
                })
        } else {
            other.or_else(|| super::session_attention(event, session))
        };
        let Some(event) = mapped else { return false };
        let mut pending = self.attention.lock().unwrap();
        if pending.len() >= 128 {
            pending.pop_front();
        }
        pending.push_back(AttentionHint {
            workspace: workspace.into(),
            session: session.into(),
            event,
        });
        true
    }
}

/// One scoped catalogue observer per backend attachment, independent of message recovery.
pub struct CatalogueWatch {
    signals: Arc<Signals>,
    _stop: crate::Sender<()>,
}

impl CatalogueWatch {
    pub fn new(
        backend: Backend,
        wake: Wake,
    ) -> (Self, impl std::future::Future<Output = ()> + 'static) {
        let signals = Arc::new(Signals {
            pending: Mutex::default(),
            providers: Mutex::default(),
            stopped: Mutex::default(),
            attention: Mutex::default(),
            generation: Default::default(),
            wake,
        });
        let (stop, cancelled) = bounded(1);
        let observer = signals.clone();
        let task = async move {
            let (out, events) = bounded(2);
            let mut epoch = 0;
            let mut delay = 250;
            'watch: while !cancelled.is_closed() {
                epoch += 1;
                let state = Arc::new(State {
                    catalogue: Some(observer.clone()),
                    ..State::default()
                });
                start(backend.clone(), epoch, out.clone(), state.clone());
                let expired = futures_lite::future::race(
                    async {
                        while let Ok(event) = events.recv().await {
                            match event {
                                Input::Opened(_) => delay = 250,
                                Input::AuthenticationRequired(_) => return true,
                                Input::Closed(_) => break,
                                _ => {}
                            }
                        }
                        false
                    },
                    async {
                        let _ = cancelled.recv().await;
                        false
                    },
                )
                .await;
                state.cancelled.store(true, SeqCst);
                observer.disconnected();
                if expired {
                    break 'watch;
                }
                futures_lite::future::race(runtime::sleep(Duration::from_millis(delay)), async {
                    let _ = cancelled.recv().await;
                })
                .await;
                delay = (delay * 2).min(4000);
            }
        };
        (
            Self {
                signals,
                _stop: stop,
            },
            task,
        )
    }

    pub fn take(&self) -> CatalogueChanges {
        std::mem::take(&mut *self.signals.pending.lock().unwrap())
    }

    pub fn take_attention(&self) -> (u64, VecDeque<AttentionHint>) {
        (
            self.signals.generation.load(SeqCst),
            std::mem::take(&mut *self.signals.attention.lock().unwrap()),
        )
    }

    pub fn take_provider_changes(&self) -> (CatalogueChanges, CatalogueChanges, u64) {
        (
            std::mem::take(&mut *self.signals.providers.lock().unwrap()),
            std::mem::take(&mut *self.signals.stopped.lock().unwrap()),
            self.signals.generation.load(SeqCst),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspace_observer_keeps_attention_from_unselected_sessions() {
        let (watch, _task) = CatalogueWatch::new(
            Backend::unauthenticated("http://127.0.0.1:1/").unwrap(),
            Arc::new(|| {}),
        );
        for event in [
            json!({"type":"form.created","data":{"form":{"sessionID":"ses_other","id":"form-1"}}}),
            json!({"type":"permission.replied","data":{"sessionID":"ses_other","requestID":"perm-1"}}),
            json!({"type":"session.execution.succeeded","id":"evt-1","data":{"sessionID":"ses_another"}}),
        ] {
            watch
                .signals
                .observe(&json!({"type":"instance.event","instanceId":"workspace","event":event}));
        }
        let (_, pending) = watch.take_attention();
        assert_eq!(pending.len(), 3);
        assert!(pending.iter().all(|hint| hint.workspace == "workspace"));
        assert!(
            matches!(&pending[0].event, WorkspaceEvent::SessionRequest { form: true, id } if id == "form-1")
        );
        assert_eq!(pending[0].session, "ses_other");
        assert!(
            matches!(&pending[1].event, WorkspaceEvent::SessionRequestResolved { form: false, id } if id == "perm-1")
        );
        assert!(
            matches!(&pending[2].event, WorkspaceEvent::SessionExecution { notice: Some(id) } if id == "evt-1")
        );
        assert_eq!(pending[2].session, "ses_another");
    }

    #[test]
    fn dropped_frame_invalidates_both_catalogues_without_changing_connection() {
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let wakes = count.clone();
        let signals = Signals {
            pending: Mutex::default(),
            providers: Mutex::default(),
            stopped: Mutex::default(),
            attention: Mutex::default(),
            generation: 3.into(),
            wake: Arc::new(move || {
                wakes.fetch_add(1, SeqCst);
            }),
        };
        signals.invalidate_all();
        signals.invalidate_all();
        assert!(matches!(
            *signals.pending.lock().unwrap(),
            CatalogueChanges::All
        ));
        assert!(matches!(
            *signals.providers.lock().unwrap(),
            CatalogueChanges::All
        ));
        assert!(matches!(
            *signals.stopped.lock().unwrap(),
            CatalogueChanges::None
        ));
        assert_eq!(signals.generation.load(SeqCst), 3);
        assert_eq!(count.load(SeqCst), 1);
    }

    #[test]
    fn provider_updates_and_project_stops_keep_separate_scopes() {
        let signals = Signals {
            pending: Mutex::default(),
            providers: Mutex::default(),
            stopped: Mutex::default(),
            attention: Mutex::default(),
            generation: Default::default(),
            wake: Arc::new(|| {}),
        };
        for frame in [
            json!({"type":"instance.event","instanceId":"first","event":{"type":"credential.switched"}}),
            json!({"type":"instance.event","instanceId":"ignored","event":{"type":"session.text.delta"}}),
            json!({"type":"workspace.stopped","workspaceId":"second"}),
        ] {
            signals.observe(&frame);
        }
        assert!(
            matches!(&*signals.providers.lock().unwrap(), CatalogueChanges::Workspaces(ids) if ids == &HashSet::from(["first".into()]))
        );
        assert!(
            matches!(&*signals.stopped.lock().unwrap(), CatalogueChanges::Workspaces(ids) if ids == &HashSet::from(["second".into()]))
        );
    }

    #[test]
    fn independent_catalogue_signals_coalesce_and_ignore_transcript_frames() {
        let signals = Signals {
            pending: Mutex::default(),
            providers: Mutex::default(),
            stopped: Mutex::default(),
            attention: Mutex::default(),
            generation: Default::default(),
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
        signals.reconnected();
        assert!(matches!(
            *signals.pending.lock().unwrap(),
            CatalogueChanges::All
        ));
    }
}
