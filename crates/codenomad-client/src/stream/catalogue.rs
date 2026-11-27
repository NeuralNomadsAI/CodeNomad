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

#[derive(Default)]
pub enum ProviderMoves {
    #[default]
    None,
    Sessions(Vec<(String, String)>),
    All,
}

#[derive(Default)]
pub enum SessionCatalogueChanges {
    #[default]
    None,
    Sessions(HashSet<(String, String)>),
    All,
}

const MAX_WORKSPACE_EVENTS: usize = 256;
const MAX_WORKSPACE_EVENT_BYTES: usize = 512 * 1024;

#[derive(Default)]
struct WorkspaceEventQueue {
    events: VecDeque<(WorkspaceEvent, usize)>,
    bytes: usize,
}

impl WorkspaceEventQueue {
    fn clear(&mut self) {
        self.events.clear();
        self.bytes = 0;
    }

    fn push(&mut self, event: WorkspaceEvent) -> bool {
        let size = workspace_event_bytes(&event);
        if size > MAX_WORKSPACE_EVENT_BYTES {
            return true;
        }
        let mut overflow = false;
        while self.events.len() >= MAX_WORKSPACE_EVENTS
            || self.bytes.saturating_add(size) > MAX_WORKSPACE_EVENT_BYTES
        {
            let Some((_, dropped)) = self.events.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(dropped);
            overflow = true;
        }
        self.bytes = self.bytes.saturating_add(size);
        self.events.push_back((event, size));
        overflow
    }

    fn drain(&mut self) -> impl Iterator<Item = WorkspaceEvent> + '_ {
        self.bytes = 0;
        self.events.drain(..).map(|(event, _)| event)
    }
}

fn workspace_event_bytes(event: &WorkspaceEvent) -> usize {
    match event {
        WorkspaceEvent::FilesChanged {
            workspace_id,
            changes,
        } => changes.iter().fold(workspace_id.len() + 64, |acc, change| {
            acc.saturating_add(change.directory.len())
                .saturating_add(change.path.len())
                .saturating_add(64)
        }),
        WorkspaceEvent::NativeFilesystemChanged { workspace_id }
        | WorkspaceEvent::WorktreesChanged { workspace_id }
        | WorkspaceEvent::Stopped { workspace_id, .. } => workspace_id.len() + 64,
        WorkspaceEvent::TemporaryChanged { folders } => folders
            .iter()
            .fold(64usize, |acc, folder| acc.saturating_add(folder.len() + 32)),
        _ => 64,
    }
}

pub(super) struct Signals {
    pending: Mutex<CatalogueChanges>,
    providers: Mutex<CatalogueChanges>,
    provider_locations: Mutex<CatalogueChanges>,
    provider_moves: Mutex<ProviderMoves>,
    integrations: Mutex<CatalogueChanges>,
    integration_sessions: Mutex<SessionCatalogueChanges>,
    stopped: Mutex<CatalogueChanges>,
    stats: Mutex<StatsChanges>,
    attention: Mutex<VecDeque<AttentionHint>>,
    workspace_events: Mutex<WorkspaceEventQueue>,
    workspace_stopped: Mutex<std::collections::HashMap<String, (bool, bool)>>,
    temporary_folders: Mutex<Option<Vec<String>>>,
    workspace_overflow: std::sync::atomic::AtomicBool,
    disconnect_notice: std::sync::atomic::AtomicBool,
    authentication_required: std::sync::atomic::AtomicBool,
    wake: Wake,
    generation: std::sync::atomic::AtomicU64,
    workspace_generation: std::sync::atomic::AtomicU64,
}

#[derive(Default)]
struct StatsChanges {
    hints: [CatalogueChanges; 2],
    status: std::collections::HashMap<String, (bool, Option<u64>)>,
}

impl Signals {
    pub(super) fn invalidate_all(&self) {
        let workspace = !self.workspace_overflow.swap(true, SeqCst);
        if self.mark(&self.pending, None)
            | self.mark(&self.providers, None)
            | self.mark(&self.provider_locations, None)
            | self.mark(&self.integrations, None)
            | mark_session_changes(&mut self.integration_sessions.lock().unwrap(), None)
            | workspace
        {
            (self.wake)();
        }
    }

    pub(super) fn reconnected(&self) {
        self.mark(&self.pending, None);
        self.mark(&self.providers, None);
        self.mark(&self.provider_locations, None);
        self.mark(&self.integrations, None);
        mark_session_changes(&mut self.integration_sessions.lock().unwrap(), None);
        self.generation.fetch_add(1, SeqCst);
        let _ = self
            .workspace_generation
            .try_update(SeqCst, SeqCst, |generation| {
                Some(if generation % 2 == 0 {
                    generation + 1
                } else {
                    generation + 2
                })
            });
        (self.wake)();
    }

    fn disconnected(&self) {
        self.attention.lock().unwrap().clear();
        self.workspace_events.lock().unwrap().clear();
        *self.temporary_folders.lock().unwrap() = None;
        *self.stats.lock().unwrap() = StatsChanges::default();
        let gen_changed = self
            .generation
            .try_update(SeqCst, SeqCst, |generation| {
                (generation % 2 == 1).then_some(generation + 1)
            })
            .is_ok();
        let ws_changed = self
            .workspace_generation
            .try_update(SeqCst, SeqCst, |generation| {
                if generation == 0 {
                    Some(2)
                } else if generation % 2 == 1 {
                    Some(generation + 1)
                } else {
                    None
                }
            })
            .is_ok();
        let disconnect_notified = !self.disconnect_notice.swap(true, SeqCst);
        if gen_changed || ws_changed || disconnect_notified {
            (self.wake)();
        }
    }

    fn mark(&self, lane: &Mutex<CatalogueChanges>, workspace: Option<&str>) -> bool {
        mark_changes(&mut lane.lock().unwrap(), workspace)
    }

    fn mark_provider_move(&self, workspace: &str, session: &str) -> bool {
        let mut moves = self.provider_moves.lock().unwrap();
        match &mut *moves {
            ProviderMoves::All => false,
            ProviderMoves::None => {
                *moves = ProviderMoves::Sessions(vec![(workspace.to_owned(), session.to_owned())]);
                true
            }
            ProviderMoves::Sessions(entries) => {
                if entries
                    .iter()
                    .any(|(ws, ses)| ws == workspace && (ses.is_empty() || ses == session))
                {
                    return false;
                }
                if entries.len() >= 128 {
                    *moves = ProviderMoves::All;
                    return true;
                }
                entries.push((workspace.to_owned(), session.to_owned()));
                true
            }
        }
    }
}

fn mark_changes(pending: &mut CatalogueChanges, workspace: Option<&str>) -> bool {
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

fn mark_session_changes(
    pending: &mut SessionCatalogueChanges,
    target: Option<(&str, &str)>,
) -> bool {
    match (&mut *pending, target) {
        (SessionCatalogueChanges::All, _) => false,
        (_, None) => {
            *pending = SessionCatalogueChanges::All;
            true
        }
        (SessionCatalogueChanges::None, Some((ws, ses))) => {
            *pending =
                SessionCatalogueChanges::Sessions(HashSet::from([(ws.to_owned(), ses.to_owned())]));
            true
        }
        (SessionCatalogueChanges::Sessions(pairs), Some((ws, ses))) if pairs.len() < 128 => {
            pairs.insert((ws.to_owned(), ses.to_owned()))
        }
        (SessionCatalogueChanges::Sessions(_), Some(_)) => {
            *pending = SessionCatalogueChanges::All;
            true
        }
    }
}

impl Signals {
    pub(super) fn observe(&self, frame: &Value) {
        let workspace_event =
            super::routing::parse_detached_workspace_event(frame).is_some_and(|event| {
                match event {
                    WorkspaceEvent::Stopped {
                        workspace_id,
                        deleted,
                        temporary_retained,
                    } => {
                        let mut stopped = self.workspace_stopped.lock().unwrap();
                        if stopped.len() < 128 || stopped.contains_key(&workspace_id) {
                            stopped.insert(workspace_id, (deleted, temporary_retained));
                        } else {
                            self.workspace_overflow.store(true, SeqCst);
                        }
                    }
                    WorkspaceEvent::TemporaryChanged { folders } => {
                        *self.temporary_folders.lock().unwrap() = Some(folders);
                    }
                    other => {
                        if self.workspace_events.lock().unwrap().push(other) {
                            self.workspace_overflow.store(true, SeqCst);
                        }
                    }
                }
                true
            });
        let session_moved = frame["type"] == "instance.event"
            && frame["event"]["type"] == "session.moved"
            && frame["instanceId"]
                .as_str()
                .filter(|id| valid_id(id))
                .is_some_and(|id| {
                    let ses = frame["event"]["data"]["sessionID"]
                        .as_str()
                        .filter(|s| valid_id(s))
                        .or_else(|| {
                            frame["event"]["data"]["id"]
                                .as_str()
                                .filter(|s| valid_id(s))
                        })
                        .unwrap_or("");
                    self.mark_provider_move(id, ses) | self.mark(&self.providers, Some(id))
                });
        let account_config_changed = frame["type"] == "storage.configChanged"
            && matches!(frame["owner"].as_str(), Some("providerAccounts" | "*"))
            && self.mark(&self.providers, None);
        let provider_changed = crate::settings::provider_change(frame).is_some_and(|id| {
            let mut marked = self.mark(&self.providers, Some(id));
            if frame["type"] == "instance.eventStatus"
                || (frame["type"] == "instance.event"
                    && frame["event"]["type"] == "server.connected")
            {
                marked |= self.mark(&self.provider_locations, Some(id));
            }
            marked
        }) | (frame["type"] == "instance.eventStatus"
            && frame["instanceId"]
                .as_str()
                .filter(|id| valid_id(id))
                .is_some_and(|id| self.mark(&self.provider_locations, Some(id))))
            | session_moved
            | account_config_changed;
        let integration_changed = match crate::settings::integrations::change_event(frame) {
            Some((ws, None)) => self.mark(&self.integrations, Some(ws)),
            Some((ws, Some(ses))) => mark_session_changes(
                &mut self.integration_sessions.lock().unwrap(),
                Some((ws, ses)),
            ),
            None => false,
        };
        let kind = frame["type"].as_str();
        let workspace = match kind {
            Some("workspace.worktreesChanged" | "workspace.stopped" | "workspace.filesChanged") => {
                &frame["workspaceId"]
            }
            _ => &frame["instanceId"],
        };
        let Some(id) = workspace.as_str().filter(|id| valid_id(id)) else {
            if workspace_event || provider_changed || integration_changed {
                (self.wake)();
            }
            return;
        };
        let stopped = kind == Some("workspace.stopped") && self.mark(&self.stopped, Some(id));
        let stats = match kind {
            Some("instance.event") => frame["event"]["type"]
                .as_str()
                .and_then(crate::settings::stats::event)
                .is_some_and(|urgent| {
                    mark_changes(
                        &mut self.stats.lock().unwrap().hints[usize::from(!urgent)],
                        Some(id),
                    )
                }),
            Some("instance.eventStatus") => {
                let mut stats = self.stats.lock().unwrap();
                let state = (frame["status"] == "connected", frame["generation"].as_u64());
                if !stats.status.contains_key(id) && stats.status.len() >= 128 {
                    stats.status.clear();
                }
                stats.status.insert(id.to_owned(), state) != Some(state)
            }
            Some("workspace.stopped") => self.stats.lock().unwrap().status.remove(id).is_some(),
            _ => false,
        };
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
            | integration_changed
            | workspace_event
            | stopped
            | attention
            | stats
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
        let Some(event) = other.or_else(|| super::session_attention(event, session)) else {
            return false;
        };
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
            provider_locations: Mutex::default(),
            provider_moves: Mutex::default(),
            integrations: Mutex::default(),
            integration_sessions: Mutex::default(),
            stopped: Mutex::default(),
            stats: Mutex::default(),
            attention: Mutex::default(),
            workspace_events: Mutex::default(),
            workspace_stopped: Mutex::default(),
            temporary_folders: Mutex::default(),
            workspace_overflow: std::sync::atomic::AtomicBool::new(false),
            disconnect_notice: std::sync::atomic::AtomicBool::new(false),
            authentication_required: std::sync::atomic::AtomicBool::new(false),
            generation: Default::default(),
            workspace_generation: Default::default(),
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
                state.cancel();
                observer.disconnected();
                if expired {
                    observer.authentication_required.store(true, SeqCst);
                    (observer.wake)();
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

    pub fn take_authentication_required(&self) -> bool {
        self.signals.authentication_required.swap(false, SeqCst)
    }

    pub fn take_disconnect(&self) -> bool {
        self.signals.disconnect_notice.swap(false, SeqCst)
    }

    pub fn take(&self) -> CatalogueChanges {
        std::mem::take(&mut *self.signals.pending.lock().unwrap())
    }

    pub fn take_temporary_folders(&self) -> Option<Vec<String>> {
        self.signals.temporary_folders.lock().unwrap().take()
    }

    pub fn take_workspace_events(&self) -> (u64, bool, VecDeque<WorkspaceEvent>) {
        let generation = self.signals.workspace_generation.load(SeqCst);
        let overflow = self.signals.workspace_overflow.swap(false, SeqCst);
        let mut events = VecDeque::new();
        let mut stopped_ids = HashSet::new();
        for (workspace_id, (deleted, temporary_retained)) in
            self.signals.workspace_stopped.lock().unwrap().drain()
        {
            stopped_ids.insert(workspace_id.clone());
            events.push_back(WorkspaceEvent::Stopped {
                workspace_id,
                deleted,
                temporary_retained,
            });
        }
        for event in self.signals.workspace_events.lock().unwrap().drain() {
            let superseded = match &event {
                WorkspaceEvent::NativeFilesystemChanged { workspace_id }
                | WorkspaceEvent::FilesChanged { workspace_id, .. }
                | WorkspaceEvent::WorktreesChanged { workspace_id }
                | WorkspaceEvent::SessionMoved { workspace_id, .. }
                | WorkspaceEvent::ServicesConfigChanged { workspace_id }
                | WorkspaceEvent::NativeStreamStatus { workspace_id, .. }
                | WorkspaceEvent::Stopped { workspace_id, .. } => {
                    stopped_ids.contains(workspace_id)
                }
                WorkspaceEvent::PluginsChanged { workspace_id, .. }
                | WorkspaceEvent::McpStatusChanged { workspace_id } => workspace_id
                    .as_ref()
                    .is_some_and(|id| stopped_ids.contains(id)),
                _ => false,
            };
            if !superseded {
                events.push_back(event);
            }
        }
        (generation, overflow, events)
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

    pub fn take_provider_location_changes(&self) -> CatalogueChanges {
        std::mem::take(&mut *self.signals.provider_locations.lock().unwrap())
    }

    pub fn take_provider_moves(&self) -> ProviderMoves {
        std::mem::take(&mut *self.signals.provider_moves.lock().unwrap())
    }

    pub fn native_connected(&self, workspace: &str) -> Option<bool> {
        self.signals
            .stats
            .lock()
            .unwrap()
            .status
            .get(workspace)
            .map(|(connected, _)| *connected)
    }

    pub fn take_integration_changes(&self) -> (CatalogueChanges, SessionCatalogueChanges) {
        (
            std::mem::take(&mut *self.signals.integrations.lock().unwrap()),
            std::mem::take(&mut *self.signals.integration_sessions.lock().unwrap()),
        )
    }
    pub fn take_stats_changes(
        &self,
        workspace: Option<&str>,
    ) -> ([CatalogueChanges; 2], Option<(bool, Option<u64>)>) {
        let mut stats = self.signals.stats.lock().unwrap();
        (
            std::mem::take(&mut stats.hints),
            workspace.and_then(|id| stats.status.get(id).copied()),
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
    fn workspace_observer_forwards_files_changed_events() {
        let (watch, _task) = CatalogueWatch::new(
            Backend::unauthenticated("http://127.0.0.1:1/").unwrap(),
            Arc::new(|| {}),
        );
        watch.signals.observe(&json!({
            "type": "workspace.filesChanged",
            "workspaceId": "proj-1",
            "changes": [{"directory": "/repo", "path": "new.txt"}]
        }));
        watch.signals.observe(&json!({
            "type": "instance.event",
            "instanceId": "proj-1",
            "event": {"type": "vcs.branch.updated"}
        }));
        watch.signals.observe(&json!({
            "type": "instance.event",
            "instanceId": "proj-1",
            "event": {"type": "filesystem.changed"}
        }));
        watch.signals.observe(&json!({
            "type": "storage.configChanged",
            "owner": "ui"
        }));
        let (generation, overflow, events) = watch.take_workspace_events();
        assert_eq!(generation, 0);
        assert!(!overflow);
        assert_eq!(events.len(), 4);
        assert!(matches!(
            &events[0],
            WorkspaceEvent::FilesChanged { workspace_id, changes }
                if workspace_id == "proj-1"
                    && changes.len() == 1
                    && changes[0].directory == "/repo"
                    && changes[0].path == "new.txt"
        ));
        assert!(matches!(
            &events[1],
            WorkspaceEvent::WorktreesChanged { workspace_id } if workspace_id == "proj-1"
        ));
        assert!(matches!(
            &events[2],
            WorkspaceEvent::NativeFilesystemChanged { workspace_id } if workspace_id == "proj-1"
        ));
        assert!(matches!(&events[3], WorkspaceEvent::UiPreferencesChanged));
        watch.signals.reconnected();
        assert_eq!(watch.take_workspace_events().0, 1);
        watch.signals.observe(&json!({
            "type": "workspace.stopped",
            "workspaceId": "proj-1"
        }));
        watch.signals.disconnected();
        let (generation, _, events) = watch.take_workspace_events();
        assert_eq!(generation, 2);
        assert!(matches!(
            events.front(),
            Some(WorkspaceEvent::Stopped { workspace_id, .. }) if workspace_id == "proj-1"
        ));
        for _ in 0..260 {
            watch.signals.observe(&json!({
                "type": "instance.event",
                "instanceId": "proj-1",
                "event": {"type": "filesystem.changed"}
            }));
        }
        let (_, overflow, events) = watch.take_workspace_events();
        assert!(overflow);
        assert_eq!(events.len(), 256);
        watch.signals.reconnected();
        assert_eq!(watch.take_workspace_events().0, 3);
        watch.signals.observe(&json!({
            "type": "instance.eventStatus",
            "instanceId": "proj-1",
            "status": "disconnected"
        }));
        let (_, _, events) = watch.take_workspace_events();
        assert!(matches!(
            events.front(),
            Some(WorkspaceEvent::NativeStreamStatus {
                workspace_id,
                connected: false
            }) if workspace_id == "proj-1"
        ));
        watch.signals.observe(&json!({
            "type": "instance.eventStatus",
            "instanceId": "proj-1",
            "status": "connected"
        }));
        let (_, _, events) = watch.take_workspace_events();
        assert!(matches!(
            events.front(),
            Some(WorkspaceEvent::NativeStreamStatus {
                workspace_id,
                connected: true
            }) if workspace_id == "proj-1"
        ));

        watch.signals.observe(&json!({
            "type": "instance.event",
            "instanceId": "proj-1",
            "event": {"type": "worktree.updated"}
        }));
        let (_, _, events) = watch.take_workspace_events();
        assert!(matches!(
            events.front(),
            Some(WorkspaceEvent::WorktreesChanged { workspace_id }) if workspace_id == "proj-1"
        ));

        let (failed_watch, _) = CatalogueWatch::new(
            Backend::unauthenticated("http://127.0.0.1:9/").unwrap(),
            Arc::new(|| {}),
        );
        failed_watch.signals.disconnected();
        assert!(failed_watch.take_disconnect());
        assert_eq!(failed_watch.take_workspace_events().0, 2);
        assert_eq!(failed_watch.take_attention().0, 0);
        assert_eq!(failed_watch.take_provider_changes().2, 0);
        // Subsequent disconnects while still offline still raise disconnect_notice for Web pairing checks.
        failed_watch.signals.disconnected();
        assert!(failed_watch.take_disconnect());
        assert_eq!(failed_watch.take_workspace_events().0, 2);
        failed_watch.signals.reconnected();
        assert_eq!(failed_watch.take_workspace_events().0, 3);
        assert_eq!(failed_watch.take_attention().0, 1);
        assert_eq!(failed_watch.take_provider_changes().2, 1);
    }

    #[test]
    fn dropped_frame_invalidates_both_catalogues_without_changing_connection() {
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let wakes = count.clone();
        let signals = Signals {
            pending: Mutex::default(),
            providers: Mutex::default(),
            provider_locations: Mutex::default(),
            provider_moves: Mutex::default(),
            integrations: Mutex::default(),
            integration_sessions: Mutex::default(),
            stopped: Mutex::default(),
            stats: Mutex::default(),
            attention: Mutex::default(),
            workspace_events: Mutex::default(),
            workspace_stopped: Mutex::default(),
            temporary_folders: Mutex::default(),
            workspace_overflow: std::sync::atomic::AtomicBool::new(false),
            disconnect_notice: std::sync::atomic::AtomicBool::new(false),
            authentication_required: std::sync::atomic::AtomicBool::new(false),
            generation: 3.into(),
            workspace_generation: 3.into(),
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
        assert!(signals.workspace_overflow.load(SeqCst));
        assert_eq!(signals.generation.load(SeqCst), 3);
        assert_eq!(count.load(SeqCst), 1);
    }

    #[test]
    fn workspace_event_queue_bounds_bytes_and_flags_overflow() {
        let (watch, _task) = CatalogueWatch::new(
            Backend::unauthenticated("http://127.0.0.1:1/").unwrap(),
            Arc::new(|| {}),
        );
        let batch: Vec<_> = (0..2500)
            .map(|i| json!({"directory": "/repo", "path": format!("src/module/file_{i:04}.rs")}))
            .collect();
        for index in 0..4 {
            watch.signals.observe(&json!({
                "type": "workspace.filesChanged",
                "workspaceId": format!("ws-{index}"),
                "changes": batch,
            }));
        }
        let (_, overflow, events) = watch.take_workspace_events();
        assert!(overflow);
        assert!(!events.is_empty() && events.len() < 4);
        assert!(
            watch.signals.workspace_events.lock().unwrap().bytes == 0,
            "draining must reset tracked queue bytes"
        );
        // A single valid event larger than the queue byte budget is dropped and flags overflow.
        let huge_batch: Vec<_> = (0..7000)
            .map(|i| json!({"directory": "/repo", "path": format!("src/module/file_{i:04}.rs")}))
            .collect();
        watch.signals.observe(&json!({
            "type": "workspace.filesChanged",
            "workspaceId": "ws-huge",
            "changes": huge_batch,
        }));
        let (_, overflow, events) = watch.take_workspace_events();
        assert!(overflow);
        assert!(events.is_empty());
    }

    #[test]
    fn provider_updates_and_project_stops_keep_separate_scopes() {
        let signals = Signals {
            pending: Mutex::default(),
            providers: Mutex::default(),
            provider_locations: Mutex::default(),
            provider_moves: Mutex::default(),
            integrations: Mutex::default(),
            integration_sessions: Mutex::default(),
            stopped: Mutex::default(),
            stats: Mutex::default(),
            attention: Mutex::default(),
            workspace_events: Mutex::default(),
            workspace_stopped: Mutex::default(),
            temporary_folders: Mutex::default(),
            workspace_overflow: std::sync::atomic::AtomicBool::new(false),
            disconnect_notice: std::sync::atomic::AtomicBool::new(false),
            authentication_required: std::sync::atomic::AtomicBool::new(false),
            generation: Default::default(),
            workspace_generation: Default::default(),
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
        assert!(matches!(
            *signals.provider_locations.lock().unwrap(),
            CatalogueChanges::None
        ));
        signals.observe(
            &json!({"type":"instance.event","instanceId":"first","event":{"type":"session.moved"}}),
        );
        assert!(matches!(
            *signals.provider_locations.lock().unwrap(),
            CatalogueChanges::None
        ));
        assert!(matches!(
            &*signals.provider_moves.lock().unwrap(),
            ProviderMoves::Sessions(entries) if entries.contains(&("first".into(), String::new()))
        ));
        *signals.provider_moves.lock().unwrap() = ProviderMoves::None;
        signals.observe(
            &json!({"type":"instance.eventStatus","instanceId":"first","status":"disconnected"}),
        );
        assert!(
            matches!(&*signals.provider_locations.lock().unwrap(), CatalogueChanges::Workspaces(ids) if ids == &HashSet::from(["first".into()]))
        );
        *signals.provider_locations.lock().unwrap() = CatalogueChanges::None;
        signals.observe(
            &json!({"type":"instance.eventStatus","instanceId":"first","status":"connected"}),
        );
        assert!(
            matches!(&*signals.provider_locations.lock().unwrap(), CatalogueChanges::Workspaces(ids) if ids == &HashSet::from(["first".into()]))
        );
        *signals.provider_locations.lock().unwrap() = CatalogueChanges::None;
        signals.observe(
            &json!({"type":"instance.event","instanceId":"first","event":{"type":"server.connected"}}),
        );
        assert!(
            matches!(&*signals.provider_locations.lock().unwrap(), CatalogueChanges::Workspaces(ids) if ids == &HashSet::from(["first".into()]))
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
            provider_locations: Mutex::default(),
            provider_moves: Mutex::default(),
            integrations: Mutex::default(),
            integration_sessions: Mutex::default(),
            stopped: Mutex::default(),
            stats: Mutex::default(),
            attention: Mutex::default(),
            workspace_events: Mutex::default(),
            workspace_stopped: Mutex::default(),
            temporary_folders: Mutex::default(),
            workspace_overflow: std::sync::atomic::AtomicBool::new(false),
            disconnect_notice: std::sync::atomic::AtomicBool::new(false),
            authentication_required: std::sync::atomic::AtomicBool::new(false),
            generation: Default::default(),
            workspace_generation: Default::default(),
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

    #[test]
    fn workspace_stopped_overflow_flags_reconciliation() {
        let signals = Signals {
            pending: Mutex::default(),
            providers: Mutex::default(),
            provider_locations: Mutex::default(),
            provider_moves: Mutex::default(),
            integrations: Mutex::default(),
            integration_sessions: Mutex::default(),
            stopped: Mutex::default(),
            stats: Mutex::default(),
            attention: Mutex::default(),
            workspace_events: Mutex::default(),
            workspace_stopped: Mutex::default(),
            temporary_folders: Mutex::default(),
            workspace_overflow: std::sync::atomic::AtomicBool::new(false),
            disconnect_notice: std::sync::atomic::AtomicBool::new(false),
            authentication_required: std::sync::atomic::AtomicBool::new(false),
            generation: Default::default(),
            workspace_generation: Default::default(),
            wake: Arc::new(|| {}),
        };
        for i in 0..128 {
            signals.observe(&json!({"type":"workspace.stopped","workspaceId":format!("w-{i}")}));
        }
        assert!(!signals.workspace_overflow.load(SeqCst));
        signals.observe(&json!({"type":"workspace.stopped","workspaceId":"w-0"}));
        assert!(!signals.workspace_overflow.load(SeqCst));
        signals.observe(&json!({"type":"workspace.stopped","workspaceId":"w-128"}));
        assert!(signals.workspace_overflow.load(SeqCst));
    }

    #[test]
    fn temporary_changed_coalesces_latest_folders_and_clears_on_disconnect() {
        let signals = Signals {
            pending: Mutex::default(),
            providers: Mutex::default(),
            provider_locations: Mutex::default(),
            provider_moves: Mutex::default(),
            integrations: Mutex::default(),
            integration_sessions: Mutex::default(),
            stopped: Mutex::default(),
            stats: Mutex::default(),
            attention: Mutex::default(),
            workspace_events: Mutex::default(),
            workspace_stopped: Mutex::default(),
            temporary_folders: Mutex::default(),
            workspace_overflow: std::sync::atomic::AtomicBool::new(false),
            disconnect_notice: std::sync::atomic::AtomicBool::new(false),
            authentication_required: std::sync::atomic::AtomicBool::new(false),
            generation: Default::default(),
            workspace_generation: Default::default(),
            wake: Arc::new(|| {}),
        };
        signals.observe(&json!({
            "type": "workspace.temporaryChanged",
            "folders": ["/tmp/cn-a", "/tmp/cn-b"]
        }));
        signals.observe(&json!({
            "type": "workspace.temporaryChanged",
            "folders": ["/tmp/cn-b"]
        }));
        assert_eq!(
            signals.temporary_folders.lock().unwrap().take(),
            Some(vec!["/tmp/cn-b".to_owned()])
        );
        signals.observe(&json!({
            "type": "workspace.temporaryChanged",
            "folders": ["relative/invalid"]
        }));
        assert_eq!(*signals.temporary_folders.lock().unwrap(), None);
        signals.observe(&json!({
            "type": "workspace.temporaryChanged",
            "folders": ["/tmp/cn-c"]
        }));
        signals.disconnected();
        assert_eq!(*signals.temporary_folders.lock().unwrap(), None);
    }

    #[test]
    fn session_moved_records_provider_move_and_provider_accounts_config_invalidates_all() {
        let (watch, _task) = CatalogueWatch::new(
            Backend::unauthenticated("http://127.0.0.1:1/").unwrap(),
            Arc::new(|| {}),
        );
        watch.signals.observe(&json!({
            "type": "instance.event",
            "instanceId": "ws1",
            "event": { "type": "session.moved", "data": { "sessionID": "ses1" } }
        }));
        assert!(matches!(
            watch.take_provider_moves(),
            ProviderMoves::Sessions(entries) if entries == vec![("ws1".to_owned(), "ses1".to_owned())]
        ));
        let (changes, _, _) = watch.take_provider_changes();
        assert!(
            matches!(changes, CatalogueChanges::Workspaces(ids) if ids == HashSet::from(["ws1".into()]))
        );

        watch.signals.observe(&json!({
            "type": "storage.configChanged",
            "owner": "providerAccounts"
        }));
        let (changes, _, _) = watch.take_provider_changes();
        assert!(matches!(changes, CatalogueChanges::All));

        watch.signals.observe(&json!({
            "type": "storage.configChanged",
            "owner": "*"
        }));
        let (changes, _, _) = watch.take_provider_changes();
        assert!(matches!(changes, CatalogueChanges::All));
    }

    #[test]
    fn stopped_workspace_drops_earlier_events_in_same_batch() {
        let (watch, _task) = CatalogueWatch::new(
            Backend::unauthenticated("http://127.0.0.1:1/").unwrap(),
            Arc::new(|| {}),
        );
        watch.signals.observe(&json!({
            "type": "instance.eventStatus",
            "instanceId": "proj-1",
            "status": "connected"
        }));
        watch.signals.observe(&json!({
            "type": "workspace.stopped",
            "workspaceId": "proj-1"
        }));
        watch.signals.observe(&json!({
            "type": "instance.eventStatus",
            "instanceId": "proj-2",
            "status": "connected"
        }));
        let (_, overflow, events) = watch.take_workspace_events();
        assert!(!overflow);
        assert!(events.iter().any(|ev| matches!(
            ev,
            WorkspaceEvent::Stopped { workspace_id, .. } if workspace_id == "proj-1"
        )));
        assert!(!events.iter().any(|ev| matches!(
            ev,
            WorkspaceEvent::NativeStreamStatus { workspace_id, .. } if workspace_id == "proj-1"
        )));
        assert!(events.iter().any(|ev| matches!(
            ev,
            WorkspaceEvent::NativeStreamStatus { workspace_id, connected: true } if workspace_id == "proj-2"
        )));
    }
}
