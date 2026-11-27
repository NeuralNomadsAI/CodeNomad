//! Connection-scoped SSE multiplexer: one physical `/api/events` stream per `(Http, base)`
//! shared across all open tabs, `CatalogueWatch`, and `PreferencesWatch`.
use super::{
    Backend, Input, Result, Sender, State,
    limits::{FRAME_LIMIT, reread_marked},
    opened,
    routing::dispatch_marked,
};
use crate::{Receiver, bounded, http::StreamDropGuard, runtime};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fmt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering::SeqCst},
    },
};

const MAX_SUBSCRIBER_FRAMES: usize = 256;
const MAX_SUBSCRIBER_BYTES: usize = 2 * FRAME_LIMIT;
const MAX_REPLAY_STATUSES: usize = 256;

#[derive(Debug)]
pub(crate) struct AuthenticationExpired;

impl fmt::Display for AuthenticationExpired {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("event stream authentication expired")
    }
}

impl std::error::Error for AuthenticationExpired {}

#[derive(Clone)]
pub(super) enum HubItem {
    Opened,
    Frame(Arc<(String, String)>),
    Skipped,
    Closed { auth_expired: bool },
}

#[derive(Default)]
struct SubQueue {
    items: VecDeque<(HubItem, u64)>,
    bytes: usize,
    closed: bool,
    pending_session_moved: Option<(Arc<(String, String)>, u64)>,
}

impl SubQueue {
    fn max_items(&self) -> usize {
        MAX_SUBSCRIBER_FRAMES
            + usize::from(matches!(self.items.front(), Some((HubItem::Opened, _))))
    }
}

struct GuardHook {
    http: crate::http::Http,
    guard: Arc<StreamDropGuard>,
    count_open_stream: bool,
}

impl GuardHook {
    fn mark_open(&self) {
        self.guard.try_mark_open(&self.http, self.count_open_stream);
    }

    fn revoke(&self, record_drop: bool) {
        self.guard
            .close_and_revoke(&self.http, self.count_open_stream, record_drop);
    }
}

#[derive(Default)]
struct SubscriberSignals {
    conversation: Option<(String, String)>,
    closed: Option<Sender<()>>,
    placement: Option<Sender<()>>,
    inbox: Option<crate::inbox::InboxWire>,
}

struct Subscriber {
    id: u64,
    queue: Mutex<SubQueue>,
    wake_tx: Sender<()>,
    wake_rx: Receiver<()>,
    quota: Option<crate::provider_usage::Ingress>,
    guard_hook: Option<GuardHook>,
    signals: SubscriberSignals,
}

impl Subscriber {
    #[cfg(all(test, not(target_arch = "wasm32")))]
    fn new(
        id: u64,
        quota: Option<crate::provider_usage::Ingress>,
        guard_hook: Option<GuardHook>,
    ) -> Arc<Self> {
        Self::with_signals(id, quota, guard_hook, SubscriberSignals::default())
    }

    fn with_signals(
        id: u64,
        quota: Option<crate::provider_usage::Ingress>,
        guard_hook: Option<GuardHook>,
        signals: SubscriberSignals,
    ) -> Arc<Self> {
        let (wake_tx, wake_rx) = bounded(1);
        Arc::new(Self {
            id,
            queue: Mutex::new(SubQueue::default()),
            wake_tx,
            wake_rx,
            quota,
            guard_hook,
            signals,
        })
    }

    fn matches_conversation(&self, workspace: &str, session: &str) -> bool {
        self.signals
            .conversation
            .as_ref()
            .is_some_and(|(w, s)| w == workspace && s == session)
    }

    fn signal_closed(&self) {
        if let Some(inbox) = &self.signals.inbox {
            inbox.invalidate_closed();
        }
        if let Some(tx) = &self.signals.closed {
            tx.close();
        }
    }

    fn signal_placement(&self) {
        if let Some(inbox) = &self.signals.inbox {
            inbox.invalidate_closed();
        }
        if let Some(tx) = &self.signals.placement {
            tx.close();
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn begin_inbox_chunk(&self) {
        if let Some(inbox) = &self.signals.inbox {
            inbox.begin_chunk();
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn end_inbox_chunk_quiet(&self, clean: bool) -> Option<crate::Wake> {
        self.signals
            .inbox
            .as_ref()
            .and_then(|inbox| inbox.end_chunk_quiet(clean))
    }

    fn note_inbox_frame(&self, kind: &str, data: &str) -> u64 {
        if kind != "codenomad.client.ping"
            && let Some((workspace, session)) = &self.signals.conversation
            && let Some(inbox) = &self.signals.inbox
        {
            super::sessions::note_inbox_frame(workspace, session, inbox, data)
        } else {
            0
        }
    }

    fn note_inbox_skipped(&self) -> u64 {
        self.signals
            .inbox
            .as_ref()
            .map_or(0, crate::inbox::InboxWire::record_ingress)
    }

    fn seed_opened(&self, replays: &[Arc<(String, String)>], force_skipped: bool) -> bool {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return false;
        }
        queue.items.push_back((HubItem::Opened, 0));
        let mut skipped = false;
        for frame in replays {
            let size = frame.0.len().saturating_add(frame.1.len());
            if queue.items.len() >= queue.max_items()
                || queue.bytes.saturating_add(size) > MAX_SUBSCRIBER_BYTES
            {
                queue.items.clear();
                queue.bytes = 0;
                queue.items.push_back((HubItem::Opened, 0));
                let mark = self.note_inbox_skipped();
                queue.items.push_back((HubItem::Skipped, mark));
                skipped = true;
                break;
            }
            let mark = self.note_inbox_frame(&frame.0, &frame.1);
            queue.bytes = queue.bytes.saturating_add(size);
            queue.items.push_back((HubItem::Frame(frame.clone()), mark));
        }
        if !skipped && force_skipped {
            let mark = self.note_inbox_skipped();
            queue.items.push_back((HubItem::Skipped, mark));
            skipped = true;
        }
        let _ = self.wake_tx.try_send(());
        skipped
    }

    fn push_opened(&self) {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return;
        }
        queue.items.push_back((HubItem::Opened, 0));
        let _ = self.wake_tx.try_send(());
    }

    /// Returns `false` if this subscriber exceeded its local queue budget.
    /// Caller revokes guard and quota before calling `close_overflow()`.
    fn try_push_frame(&self, frame: Arc<(String, String)>, session_moved: bool, mark: u64) -> bool {
        let size = frame.0.len().saturating_add(frame.1.len());
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return false;
        }
        if session_moved {
            queue.pending_session_moved = Some((frame.clone(), mark));
        }
        if queue.items.len() >= queue.max_items()
            || queue.bytes.saturating_add(size) > MAX_SUBSCRIBER_BYTES
        {
            false
        } else {
            queue.bytes = queue.bytes.saturating_add(size);
            queue.items.push_back((HubItem::Frame(frame), mark));
            let _ = self.wake_tx.try_send(());
            true
        }
    }

    fn close_overflow(&self) {
        self.signal_closed();
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return;
        }
        queue.closed = true;
        queue.items.clear();
        queue.bytes = 0;
        if let Some((moved, mark)) = queue.pending_session_moved.take() {
            queue.items.push_back((HubItem::Frame(moved), mark));
        }
        queue.items.push_back((
            HubItem::Closed {
                auth_expired: false,
            },
            0,
        ));
        let _ = self.wake_tx.try_send(());
    }

    fn push_skipped(&self, mark: u64) {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return;
        }
        if let Some((HubItem::Skipped, existing)) = queue.items.back_mut() {
            *existing = (*existing).max(mark);
        } else {
            queue.items.push_back((HubItem::Skipped, mark));
        }
        let _ = self.wake_tx.try_send(());
    }

    fn push_closed(&self, auth_expired: bool) {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return;
        }
        queue.closed = true;
        queue.items.push_back((HubItem::Closed { auth_expired }, 0));
        let _ = self.wake_tx.try_send(());
    }

    #[cfg(all(test, not(target_arch = "wasm32")))]
    fn pop(&self) -> Option<HubItem> {
        self.pop_marked().map(|(item, _)| item)
    }

    fn pop_marked(&self) -> Option<(HubItem, u64)> {
        let mut queue = self.queue.lock().unwrap();
        let (item, mark) = queue.items.pop_front()?;
        if let HubItem::Frame(frame) = &item {
            let size = frame.0.len().saturating_add(frame.1.len());
            queue.bytes = queue.bytes.saturating_sub(size);
            if queue
                .pending_session_moved
                .as_ref()
                .is_some_and(|(moved, _)| Arc::ptr_eq(moved, frame))
            {
                queue.pending_session_moved = None;
            }
        }
        Some((item, mark))
    }

    #[cfg(all(test, not(target_arch = "wasm32")))]
    async fn recv(&self) -> HubItem {
        self.recv_marked().await.0
    }

    async fn recv_marked(&self) -> (HubItem, u64) {
        loop {
            if let Some(item) = self.pop_marked() {
                return item;
            }
            if self.wake_rx.recv().await.is_err() {
                return self.pop_marked().unwrap_or((
                    HubItem::Closed {
                        auth_expired: false,
                    },
                    0,
                ));
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Connecting,
    Open,
    Closing,
    Closed { auth_expired: bool },
}

struct StreamInner {
    phase: Phase,
    subscribers: Vec<Arc<Subscriber>>,
    replays: HashMap<String, Arc<(String, String)>>,
    replays_overflowed: bool,
    #[cfg(not(target_arch = "wasm32"))]
    chunk_active: bool,
    stop: Option<Sender<()>>,
}

pub(super) struct SharedStream {
    base: String,
    inner: Mutex<StreamInner>,
    done: Receiver<()>,
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) struct ChunkGuard<'a> {
    shared: Option<&'a SharedStream>,
}

#[cfg(not(target_arch = "wasm32"))]
impl ChunkGuard<'_> {
    pub(super) fn finish(mut self) {
        if let Some(shared) = self.shared.take() {
            shared.end_chunk(true);
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for ChunkGuard<'_> {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.take() {
            shared.end_chunk(false);
        }
    }
}

impl SharedStream {
    pub(super) fn mark_open(&self) -> bool {
        let mut wakes = Vec::new();
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.subscribers.is_empty()
                || matches!(inner.phase, Phase::Closing | Phase::Closed { .. })
            {
                return false;
            }
            inner.phase = Phase::Open;
            for sub in &inner.subscribers {
                if let Some(hook) = &sub.guard_hook {
                    hook.mark_open();
                }
                if let Some(quota) = &sub.quota
                    && quota.transport_quiet(true)
                {
                    wakes.push(quota.clone());
                }
                sub.push_opened();
            }
        }
        for quota in wakes {
            quota.wake();
        }
        true
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn begin_chunk(&self) -> ChunkGuard<'_> {
        let mut inner = self.inner.lock().unwrap();
        if !matches!(inner.phase, Phase::Closing | Phase::Closed { .. }) {
            inner.chunk_active = true;
            for sub in &inner.subscribers {
                sub.begin_inbox_chunk();
                if let Some(quota) = &sub.quota {
                    quota.begin_chunk();
                }
            }
        }
        ChunkGuard { shared: Some(self) }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn end_chunk(&self, clean: bool) {
        let mut wakes = Vec::new();
        let mut inbox_wakes = Vec::new();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.chunk_active = false;
            for sub in &inner.subscribers {
                if let Some(wake) = sub.end_inbox_chunk_quiet(clean) {
                    inbox_wakes.push(wake);
                }
                if let Some(quota) = &sub.quota {
                    let wake = if clean {
                        quota.finish_chunk_quiet()
                    } else {
                        quota.transport_quiet(false)
                    };
                    if wake {
                        wakes.push(quota.clone());
                    }
                }
            }
        }
        for wake in inbox_wakes {
            wake();
        }
        for quota in wakes {
            quota.wake();
        }
    }

    pub(super) fn broadcast_frame(&self, hub: &Hub, kind: String, data: String) {
        let frame = Arc::new((kind, data));
        let class = classify_frame(&frame.0, &frame.1);
        let notify_quota = frame.0.is_empty() || frame.0 == "message";
        let mut wakes = Vec::new();
        let became_empty = {
            let mut inner = self.inner.lock().unwrap();
            if matches!(inner.phase, Phase::Closing | Phase::Closed { .. }) {
                return;
            }
            match &class {
                FrameClass::ReplayStatus { id, connected } => {
                    if inner.replays.len() < MAX_REPLAY_STATUSES || inner.replays.contains_key(id) {
                        inner.replays.insert(id.clone(), frame.clone());
                    } else {
                        inner.replays_overflowed = true;
                    }
                    hub.note_workspace_upstream_status(id, *connected);
                }
                FrameClass::ReplayStopped { id, error } => {
                    inner.replays.remove(id);
                    if *error {
                        hub.note_workspace_upstream_status(id, false);
                    } else {
                        hub.note_workspace_stopped(id);
                    }
                }
                FrameClass::WorkspaceLocationChanged(id) => {
                    hub.note_workspace_location_change(id);
                }
                FrameClass::SessionMoved { workspace, session } => {
                    hub.note_session_location_change(workspace, session);
                }
                FrameClass::None => {}
            }
            inner.subscribers.retain(|sub| {
                let session_moved = matches!(
                    &class,
                    FrameClass::SessionMoved { workspace, session }
                        if sub.matches_conversation(workspace, session)
                );
                if session_moved {
                    sub.signal_placement();
                }
                let mark = sub.note_inbox_frame(&frame.0, &frame.1);
                let kept = sub.try_push_frame(frame.clone(), session_moved, mark);
                if !kept {
                    if let Some(hook) = &sub.guard_hook {
                        hook.revoke(true);
                    }
                    if let Some(quota) = &sub.quota
                        && quota.transport_quiet(false)
                    {
                        wakes.push(quota.clone());
                    }
                    sub.close_overflow();
                    return false;
                }
                if notify_quota
                    && let Some(quota) = &sub.quota
                    && quota.frame_quiet(&frame.1)
                {
                    wakes.push(quota.clone());
                }
                true
            });
            inner.subscribers.is_empty()
        };
        if became_empty {
            let mut streams = hub.streams.lock().unwrap();
            let mut inner = self.inner.lock().unwrap();
            if inner.subscribers.is_empty() {
                if let Some(entry) = streams.get_mut(&self.base)
                    && std::ptr::eq(Arc::as_ptr(&entry.stream), self)
                {
                    entry.active = false;
                }
                inner.stop.take();
            }
        }
        for quota in wakes {
            quota.wake();
        }
    }

    pub(super) fn broadcast_skipped(&self) {
        let mut wakes = Vec::new();
        {
            let inner = self.inner.lock().unwrap();
            if matches!(inner.phase, Phase::Closing | Phase::Closed { .. }) {
                return;
            }
            for sub in &inner.subscribers {
                let mark = sub.note_inbox_skipped();
                sub.push_skipped(mark);
                if let Some(quota) = &sub.quota
                    && quota.skipped_quiet()
                {
                    wakes.push(quota.clone());
                }
            }
        }
        for quota in wakes {
            quota.wake();
        }
    }

    /// Immediately deactivates the hub entry and revokes all subscriber guards/quotas upon
    /// EOF/disconnect, before awaiting pong teardown and publishing `Closed` behind pre-EOF frames.
    pub(super) fn begin_close(&self, hub: &Hub) {
        let mut wakes = Vec::new();
        {
            let mut streams = hub.streams.lock().unwrap();
            let mut inner = self.inner.lock().unwrap();
            if matches!(inner.phase, Phase::Closing | Phase::Closed { .. }) {
                return;
            }
            inner.phase = Phase::Closing;
            inner.replays.clear();
            inner.replays_overflowed = false;
            #[cfg(not(target_arch = "wasm32"))]
            {
                inner.chunk_active = false;
            }
            inner.stop.take();
            if let Some(entry) = streams.get_mut(&self.base)
                && std::ptr::eq(Arc::as_ptr(&entry.stream), self)
            {
                entry.active = false;
            }
            for sub in &inner.subscribers {
                if let Some(hook) = &sub.guard_hook {
                    hook.revoke(true);
                }
                if let Some(quota) = &sub.quota
                    && quota.transport_quiet(false)
                {
                    wakes.push(quota.clone());
                }
                sub.signal_closed();
            }
        }
        for quota in wakes {
            quota.wake();
        }
    }

    pub(super) fn finish(&self, hub: &Hub, auth_expired: bool) {
        let mut wakes = Vec::new();
        {
            let mut streams = hub.streams.lock().unwrap();
            let mut inner = self.inner.lock().unwrap();
            if matches!(inner.phase, Phase::Closed { .. }) {
                return;
            }
            inner.phase = Phase::Closed { auth_expired };
            inner.replays.clear();
            inner.replays_overflowed = false;
            #[cfg(not(target_arch = "wasm32"))]
            {
                inner.chunk_active = false;
            }
            inner.stop.take();
            for sub in std::mem::take(&mut inner.subscribers) {
                if let Some(hook) = &sub.guard_hook {
                    hook.revoke(true);
                }
                if let Some(quota) = &sub.quota
                    && quota.transport_quiet(false)
                {
                    wakes.push(quota.clone());
                }
                sub.signal_closed();
                sub.push_closed(auth_expired);
            }
            if streams
                .get(&self.base)
                .is_some_and(|entry| std::ptr::eq(Arc::as_ptr(&entry.stream), self))
            {
                streams.remove(&self.base);
            }
        }
        for quota in wakes {
            quota.wake();
        }
    }
}

enum FrameClass {
    None,
    ReplayStatus { id: String, connected: bool },
    ReplayStopped { id: String, error: bool },
    WorkspaceLocationChanged(String),
    SessionMoved { workspace: String, session: String },
}

fn classify_frame(kind: &str, data: &str) -> FrameClass {
    if !(kind.is_empty() || kind == "message") {
        return FrameClass::None;
    }
    let is_status = data.contains("\"instance.eventStatus\"");
    let is_stopped = !is_status && data.contains("\"workspace.stopped\"");
    let is_worktrees = !is_status
        && !is_stopped
        && (data.contains("\"workspace.worktreesChanged\"")
            || data.contains("\"worktree.updated\""));
    let is_moved = !is_status && !is_stopped && !is_worktrees && data.contains("\"session.moved\"");
    if !is_status && !is_stopped && !is_worktrees && !is_moved {
        return FrameClass::None;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data.trim()) else {
        return FrameClass::None;
    };
    if value["type"] == "instance.eventStatus"
        && let Some(id) = value["instanceId"].as_str()
        && crate::history::valid_id(id)
    {
        if value["status"] == "disconnected"
            && matches!(
                value["reason"].as_str(),
                Some("workspace stopped" | "workspace error")
            )
        {
            return FrameClass::ReplayStopped {
                id: id.to_owned(),
                error: value["reason"] == "workspace error",
            };
        }
        return FrameClass::ReplayStatus {
            id: id.to_owned(),
            connected: value["status"] == "connected",
        };
    }
    if value["type"] == "workspace.stopped"
        && let Some(id) = value["workspaceId"].as_str()
        && crate::history::valid_id(id)
    {
        return FrameClass::ReplayStopped {
            id: id.to_owned(),
            error: false,
        };
    }
    if value["type"] == "workspace.worktreesChanged"
        && let Some(id) = value["workspaceId"].as_str()
        && crate::history::valid_id(id)
    {
        return FrameClass::WorkspaceLocationChanged(id.to_owned());
    }
    if value["type"] == "instance.event"
        && value["event"]["type"] == "worktree.updated"
        && let Some(id) = value["instanceId"].as_str()
        && crate::history::valid_id(id)
    {
        return FrameClass::WorkspaceLocationChanged(id.to_owned());
    }
    if value["type"] == "instance.event"
        && value["event"]["type"] == "session.moved"
        && let Some(workspace) = value["instanceId"].as_str()
    {
        let session = value["event"]["data"]["sessionID"]
            .as_str()
            .or_else(|| value["event"]["data"]["id"].as_str())
            .unwrap_or("");
        return FrameClass::SessionMoved {
            workspace: workspace.to_owned(),
            session: session.to_owned(),
        };
    }
    FrameClass::None
}

struct StreamEntry {
    stream: Arc<SharedStream>,
    active: bool,
}

const MAX_TRACKED_LOCATIONS: usize = 1024;

#[derive(Default)]
struct LocationRevisions {
    workspace: HashMap<String, u64>,
    session: HashMap<(String, String), u64>,
    overflow: u64,
    upstream_unhealthy: HashSet<String>,
    upstream_verified_healthy: HashSet<String>,
    overflow_unhealthy: bool,
}

#[derive(Default)]
pub(crate) struct Hub {
    streams: Mutex<HashMap<String, StreamEntry>>,
    next_id: AtomicU64,
    next_connection: AtomicU64,
    location_revisions: Mutex<LocationRevisions>,
}

impl Hub {
    fn bump_workspace_revision(rev: &mut LocationRevisions, workspace: &str) {
        if let Some(entry) = rev.workspace.get_mut(workspace) {
            *entry = entry.wrapping_add(1);
        } else if rev.workspace.len() < MAX_TRACKED_LOCATIONS {
            rev.workspace.insert(workspace.to_owned(), 1);
        } else {
            rev.overflow = rev.overflow.wrapping_add(1);
        }
    }

    pub(crate) fn note_workspace_location_change(&self, workspace: &str) {
        let mut rev = self.location_revisions.lock().unwrap();
        Self::bump_workspace_revision(&mut rev, workspace);
    }

    pub(crate) fn note_workspace_stopped(&self, workspace: &str) {
        let mut rev = self.location_revisions.lock().unwrap();
        Self::bump_workspace_revision(&mut rev, workspace);
        rev.upstream_unhealthy.remove(workspace);
        rev.upstream_verified_healthy.remove(workspace);
    }

    pub(crate) fn note_workspace_upstream_status(&self, workspace: &str, connected: bool) {
        let mut rev = self.location_revisions.lock().unwrap();
        Self::bump_workspace_revision(&mut rev, workspace);
        if connected {
            rev.upstream_unhealthy.remove(workspace);
            if rev.overflow_unhealthy {
                if rev.upstream_verified_healthy.len() >= MAX_TRACKED_LOCATIONS
                    && !rev.upstream_verified_healthy.contains(workspace)
                {
                    rev.upstream_verified_healthy.clear();
                }
                rev.upstream_verified_healthy.insert(workspace.to_owned());
            }
        } else {
            rev.upstream_verified_healthy.remove(workspace);
            if rev.upstream_unhealthy.len() < MAX_TRACKED_LOCATIONS {
                rev.upstream_unhealthy.insert(workspace.to_owned());
            } else if !rev.upstream_unhealthy.contains(workspace) {
                rev.overflow_unhealthy = true;
            }
        }
    }

    pub(crate) fn workspace_upstream_healthy(&self, workspace: &str) -> bool {
        let rev = self.location_revisions.lock().unwrap();
        if rev.upstream_unhealthy.contains(workspace) {
            return false;
        }
        if rev.overflow_unhealthy {
            return rev.upstream_verified_healthy.contains(workspace);
        }
        true
    }

    pub(crate) fn note_session_location_change(&self, workspace: &str, session: &str) {
        if session.is_empty() {
            self.note_workspace_location_change(workspace);
            return;
        }
        let mut rev = self.location_revisions.lock().unwrap();
        let key = (workspace.to_owned(), session.to_owned());
        if let Some(entry) = rev.session.get_mut(&key) {
            *entry = entry.wrapping_add(1);
        } else if rev.session.len() < MAX_TRACKED_LOCATIONS {
            rev.session.insert(key, 1);
        } else {
            rev.overflow = rev.overflow.wrapping_add(1);
        }
    }

    pub(crate) fn location_revision(&self, workspace: &str, session: Option<&str>) -> u64 {
        let rev = self.location_revisions.lock().unwrap();
        let ws = rev.workspace.get(workspace).copied().unwrap_or(0);
        let ses = session
            .and_then(|s| {
                rev.session
                    .get(&(workspace.to_owned(), s.to_owned()))
                    .copied()
            })
            .unwrap_or(0);
        rev.overflow.wrapping_add(ws).wrapping_add(ses)
    }
    async fn subscribe(
        self: &Arc<Self>,
        backend: &Backend,
        quota: Option<crate::provider_usage::Ingress>,
        guard_hook: Option<GuardHook>,
        signals: SubscriberSignals,
    ) -> Subscription {
        let id = self.next_id.fetch_add(1, SeqCst) + 1;
        let sub = Subscriber::with_signals(id, quota, guard_hook, signals);
        loop {
            let wait_done = {
                let mut streams = self.streams.lock().unwrap();
                if let Some(entry) = streams.get(&backend.base) {
                    if !entry.active {
                        Some(entry.stream.done.clone())
                    } else {
                        let existing = entry.stream.clone();
                        let mut inner = existing.inner.lock().unwrap();
                        if !matches!(inner.phase, Phase::Closing | Phase::Closed { .. })
                            && !inner.subscribers.is_empty()
                        {
                            let mut wake_quota = None;
                            if inner.phase == Phase::Open {
                                if let Some(hook) = &sub.guard_hook {
                                    hook.mark_open();
                                }
                                let replays: Vec<_> = inner.replays.values().cloned().collect();
                                let missing_replay = inner.replays_overflowed
                                    && !backend.workspace.is_empty()
                                    && !inner.replays.contains_key(&backend.workspace);
                                let skipped = sub.seed_opened(&replays, missing_replay);
                                #[cfg(not(target_arch = "wasm32"))]
                                let chunk_active = inner.chunk_active;
                                #[cfg(target_arch = "wasm32")]
                                let chunk_active = false;
                                #[cfg(not(target_arch = "wasm32"))]
                                if chunk_active {
                                    sub.begin_inbox_chunk();
                                }
                                if let Some(quota) = &sub.quota
                                    && quota.attach_open_quiet(&replays, skipped, chunk_active)
                                {
                                    wake_quota = Some(quota.clone());
                                }
                            }
                            inner.subscribers.push(sub.clone());
                            drop(inner);
                            drop(streams);
                            if let Some(quota) = wake_quota {
                                quota.wake();
                            }
                            return Subscription {
                                hub: self.clone(),
                                shared: existing,
                                sub,
                                closed: false,
                            };
                        }
                        Some(existing.done.clone())
                    }
                } else {
                    let seq = self.next_connection.fetch_add(1, SeqCst) + 1;
                    let connection = format!("hub-{seq}");
                    let (stop_tx, stop_rx) = bounded(1);
                    let (done_tx, done_rx) = bounded(1);
                    let shared = Arc::new(SharedStream {
                        base: backend.base.clone(),
                        inner: Mutex::new(StreamInner {
                            phase: Phase::Connecting,
                            subscribers: vec![sub.clone()],
                            replays: HashMap::new(),
                            replays_overflowed: false,
                            #[cfg(not(target_arch = "wasm32"))]
                            chunk_active: false,
                            stop: Some(stop_tx),
                        }),
                        done: done_rx,
                    });
                    streams.insert(
                        backend.base.clone(),
                        StreamEntry {
                            stream: shared.clone(),
                            active: true,
                        },
                    );
                    drop(streams);

                    let hub = self.clone();
                    let backend = backend.clone();
                    let pump_shared = shared.clone();
                    runtime::spawn(async move {
                        let _done = done_tx;
                        #[cfg(not(target_arch = "wasm32"))]
                        super::native::pump_shared(hub, pump_shared, backend, connection, stop_rx)
                            .await;
                        #[cfg(target_arch = "wasm32")]
                        super::browser::pump_shared(hub, pump_shared, backend, connection, stop_rx)
                            .await;
                    });

                    return Subscription {
                        hub: self.clone(),
                        shared,
                        sub,
                        closed: false,
                    };
                }
            };
            if let Some(done) = wait_done {
                let _ = done.recv().await;
            }
        }
    }
}

struct Subscription {
    hub: Arc<Hub>,
    shared: Arc<SharedStream>,
    sub: Arc<Subscriber>,
    closed: bool,
}

impl Subscription {
    fn detach(&mut self) -> Option<Receiver<()>> {
        if self.closed {
            return None;
        }
        self.closed = true;
        let (last, wake_quota) = {
            let mut streams = self.hub.streams.lock().unwrap();
            let mut inner = self.shared.inner.lock().unwrap();
            if let Some(hook) = &self.sub.guard_hook {
                hook.revoke(false);
            }
            let wake_quota = self
                .sub
                .quota
                .as_ref()
                .filter(|quota| quota.transport_quiet(false))
                .cloned();
            inner.subscribers.retain(|s| s.id != self.sub.id);
            let last = if inner.subscribers.is_empty() {
                if let Some(entry) = streams.get_mut(&self.shared.base)
                    && Arc::ptr_eq(&entry.stream, &self.shared)
                {
                    entry.active = false;
                }
                inner.stop.take();
                true
            } else {
                false
            };
            (last, wake_quota)
        };
        if let Some(quota) = wake_quota {
            quota.wake();
        }
        last.then(|| self.shared.done.clone())
    }

    async fn close(mut self) {
        if let Some(done) = self.detach() {
            let _ = done.recv().await;
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let _ = self.detach();
    }
}

pub(super) async fn read_shared(
    backend: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    stream_guard: Arc<StreamDropGuard>,
    count_open_stream: bool,
) -> Result<()> {
    let hub = backend.client.sse_hub();
    let quota = state.quota_ingress(backend);
    let guard_hook = Some(GuardHook {
        http: backend.client.clone(),
        guard: stream_guard,
        count_open_stream,
    });
    let signals = SubscriberSignals {
        conversation: (!backend.workspace.is_empty() && !backend.session.is_empty())
            .then(|| (backend.workspace.clone(), backend.session.clone())),
        closed: Some(state.closed_signal()),
        placement: state.placement_signal(),
        inbox: state.catalogue.is_none().then(|| state.inbox.clone()),
    };
    enum SubscribeStep {
        Ready(Subscription),
        Cancelled,
    }
    let sub = match futures_lite::future::or(
        async {
            state.wait_cancelled(out).await;
            SubscribeStep::Cancelled
        },
        async { SubscribeStep::Ready(hub.subscribe(backend, quota, guard_hook, signals).await) },
    )
    .await
    {
        SubscribeStep::Ready(sub) => sub,
        SubscribeStep::Cancelled => return Ok(()),
    };
    let connection = format!("stream-{epoch}");
    let cancelled = AtomicBool::new(false);
    let result: Result<()> = futures_lite::future::or(
        async {
            state.wait_cancelled(out).await;
            cancelled.store(true, SeqCst);
            Ok(())
        },
        async {
            loop {
                match sub.sub.recv_marked().await {
                    (HubItem::Opened, _) => {
                        backend.client.children().invalidate_all(backend);
                        opened(epoch, out, state).await?;
                    }
                    (HubItem::Frame(frame), mark) => {
                        dispatch_marked(
                            backend,
                            epoch,
                            out,
                            state,
                            &connection,
                            &frame.0,
                            &frame.1,
                            mark,
                        )
                        .await?;
                    }
                    (HubItem::Skipped, mark) => {
                        backend.client.children().invalidate_all(backend);
                        reread_marked(epoch, out, state, mark).await?;
                    }
                    (HubItem::Closed { auth_expired }, _) => {
                        if auth_expired {
                            return Err(Box::new(AuthenticationExpired) as crate::history::Error);
                        }
                        return Err("event stream ended".into());
                    }
                }
            }
        },
    )
    .await;
    sub.close().await;
    if cancelled.load(SeqCst) {
        Ok(())
    } else {
        result
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "hub_tests.rs"]
mod tests;
