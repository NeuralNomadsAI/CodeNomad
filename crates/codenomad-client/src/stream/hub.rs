//! Connection-scoped SSE multiplexer: one physical `/api/events` stream per `(Http, base)`
//! shared across all open tabs, `CatalogueWatch`, and `PreferencesWatch`.
use super::{
    Backend, Input, Result, Sender, State, dispatch,
    limits::{FRAME_LIMIT, reread},
    opened, resync_preferences,
};
use crate::{Receiver, bounded, http::StreamDropGuard, runtime, transport::WorkspaceEvent};
use std::{
    collections::{HashMap, VecDeque},
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
    Skipped { overflow: bool },
    Closed { auth_expired: bool },
}

#[derive(Default)]
struct SubQueue {
    items: VecDeque<HubItem>,
    bytes: usize,
    closed: bool,
}

impl SubQueue {
    fn max_items(&self) -> usize {
        MAX_SUBSCRIBER_FRAMES + usize::from(matches!(self.items.front(), Some(HubItem::Opened)))
    }
}

struct CloseRevocation {
    http: crate::http::Http,
    guard: Arc<StreamDropGuard>,
    client_id: String,
}

impl CloseRevocation {
    fn revoke(&self) {
        let was_open = self.guard.release_open();
        if !self.guard.mark_drop_recorded() {
            self.http.record_transport_drop(&self.client_id, was_open);
        }
    }
}

struct Subscriber {
    id: u64,
    queue: Mutex<SubQueue>,
    wake_tx: Sender<()>,
    wake_rx: Receiver<()>,
    quota: Option<crate::provider_usage::Ingress>,
    close_revocation: Option<CloseRevocation>,
}

impl Subscriber {
    fn new(
        id: u64,
        quota: Option<crate::provider_usage::Ingress>,
        close_revocation: Option<CloseRevocation>,
    ) -> Arc<Self> {
        let (wake_tx, wake_rx) = bounded(1);
        Arc::new(Self {
            id,
            queue: Mutex::new(SubQueue::default()),
            wake_tx,
            wake_rx,
            quota,
            close_revocation,
        })
    }

    fn seed_opened(&self, replays: &[Arc<(String, String)>], force_overflow: bool) -> bool {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return false;
        }
        queue.items.push_back(HubItem::Opened);
        let mut overflowed = false;
        for frame in replays {
            let size = frame.0.len().saturating_add(frame.1.len());
            if queue.items.len() >= queue.max_items()
                || queue.bytes.saturating_add(size) > MAX_SUBSCRIBER_BYTES
            {
                queue.items.clear();
                queue.bytes = 0;
                queue.items.push_back(HubItem::Opened);
                queue.items.push_back(HubItem::Skipped { overflow: true });
                overflowed = true;
                break;
            }
            queue.bytes = queue.bytes.saturating_add(size);
            queue.items.push_back(HubItem::Frame(frame.clone()));
        }
        if !overflowed && force_overflow {
            queue.items.push_back(HubItem::Skipped { overflow: true });
            overflowed = true;
        }
        let _ = self.wake_tx.try_send(());
        overflowed
    }

    fn push_opened(&self) {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return;
        }
        queue.items.push_back(HubItem::Opened);
        let _ = self.wake_tx.try_send(());
    }

    fn push_frame_quiet(&self, frame: Arc<(String, String)>) -> bool {
        let size = frame.0.len().saturating_add(frame.1.len());
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return false;
        }
        if queue.items.len() >= queue.max_items()
            || queue.bytes.saturating_add(size) > MAX_SUBSCRIBER_BYTES
        {
            let had_opened = matches!(queue.items.front(), Some(HubItem::Opened));
            queue.items.clear();
            queue.bytes = 0;
            if had_opened {
                queue.items.push_back(HubItem::Opened);
            }
            queue.items.push_back(HubItem::Skipped { overflow: true });
            let _ = self.wake_tx.try_send(());
            true
        } else {
            queue.bytes = queue.bytes.saturating_add(size);
            queue.items.push_back(HubItem::Frame(frame));
            let _ = self.wake_tx.try_send(());
            false
        }
    }

    fn push_skipped(&self, overflow: bool) {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return;
        }
        match queue.items.back_mut() {
            Some(HubItem::Skipped { overflow: existing }) => {
                *existing |= overflow;
            }
            _ => queue.items.push_back(HubItem::Skipped { overflow }),
        }
        let _ = self.wake_tx.try_send(());
    }

    fn push_closed(&self, auth_expired: bool) {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return;
        }
        queue.closed = true;
        queue.items.push_back(HubItem::Closed { auth_expired });
        let _ = self.wake_tx.try_send(());
    }

    fn pop(&self) -> Option<HubItem> {
        let mut queue = self.queue.lock().unwrap();
        let item = queue.items.pop_front()?;
        if let HubItem::Frame(frame) = &item {
            let size = frame.0.len().saturating_add(frame.1.len());
            queue.bytes = queue.bytes.saturating_sub(size);
        }
        Some(item)
    }

    async fn recv(&self) -> HubItem {
        loop {
            if let Some(item) = self.pop() {
                return item;
            }
            if self.wake_rx.recv().await.is_err() {
                return self.pop().unwrap_or(HubItem::Closed {
                    auth_expired: false,
                });
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Connecting,
    Open,
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
            if inner.subscribers.is_empty() || matches!(inner.phase, Phase::Closed { .. }) {
                return false;
            }
            inner.phase = Phase::Open;
            for sub in &inner.subscribers {
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
        if !matches!(inner.phase, Phase::Closed { .. }) {
            inner.chunk_active = true;
            for sub in &inner.subscribers {
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
        {
            let mut inner = self.inner.lock().unwrap();
            inner.chunk_active = false;
            for sub in &inner.subscribers {
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
        for quota in wakes {
            quota.wake();
        }
    }

    pub(super) fn broadcast_frame(&self, kind: String, data: String) {
        let frame = Arc::new((kind, data));
        let replay_update = classify_replay(&frame.0, &frame.1);
        let notify_quota = frame.0.is_empty() || frame.0 == "message";
        let mut wakes = Vec::new();
        {
            let mut inner = self.inner.lock().unwrap();
            if matches!(inner.phase, Phase::Closed { .. }) {
                return;
            }
            match replay_update {
                ReplayUpdate::Status(id) => {
                    if inner.replays.len() < MAX_REPLAY_STATUSES || inner.replays.contains_key(&id)
                    {
                        inner.replays.insert(id, frame.clone());
                    } else {
                        inner.replays_overflowed = true;
                    }
                }
                ReplayUpdate::Stopped(id) => {
                    inner.replays.remove(&id);
                }
                ReplayUpdate::None => {}
            }
            for sub in &inner.subscribers {
                let overflowed = sub.push_frame_quiet(frame.clone());
                if let Some(quota) = &sub.quota {
                    let mut wake = false;
                    if notify_quota {
                        wake |= quota.frame_quiet(&frame.1);
                    }
                    if overflowed {
                        wake |= quota.skipped_quiet();
                    }
                    if wake {
                        wakes.push(quota.clone());
                    }
                }
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
            if matches!(inner.phase, Phase::Closed { .. }) {
                return;
            }
            for sub in &inner.subscribers {
                sub.push_skipped(false);
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

    fn replay_for(&self, workspace: &str) -> Option<Arc<(String, String)>> {
        if workspace.is_empty() {
            return None;
        }
        let inner = self.inner.lock().unwrap();
        inner.replays.get(workspace).cloned()
    }

    pub(super) fn finish(&self, hub: &Hub, auth_expired: bool) {
        let mut wakes = Vec::new();
        let mut revocations = Vec::new();
        {
            let mut streams = hub.streams.lock().unwrap();
            if streams
                .get(&self.base)
                .is_some_and(|entry| std::ptr::eq(Arc::as_ptr(&entry.stream), self))
            {
                streams.remove(&self.base);
            }
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
                if let Some(quota) = &sub.quota
                    && quota.transport_quiet(false)
                {
                    wakes.push(quota.clone());
                }
                sub.push_closed(auth_expired);
                if sub.close_revocation.is_some() {
                    revocations.push(sub);
                }
            }
        }
        for sub in revocations {
            if let Some(revocation) = &sub.close_revocation {
                revocation.revoke();
            }
        }
        for quota in wakes {
            quota.wake();
        }
    }
}

enum ReplayUpdate {
    None,
    Status(String),
    Stopped(String),
}

fn classify_replay(kind: &str, data: &str) -> ReplayUpdate {
    if !(kind.is_empty() || kind == "message") {
        return ReplayUpdate::None;
    }
    let is_status = data.contains("\"instance.eventStatus\"");
    let is_stopped = !is_status && data.contains("\"workspace.stopped\"");
    if !is_status && !is_stopped {
        return ReplayUpdate::None;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data.trim()) else {
        return ReplayUpdate::None;
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
            return ReplayUpdate::Stopped(id.to_owned());
        }
        return ReplayUpdate::Status(id.to_owned());
    }
    if value["type"] == "workspace.stopped"
        && let Some(id) = value["workspaceId"].as_str()
        && crate::history::valid_id(id)
    {
        return ReplayUpdate::Stopped(id.to_owned());
    }
    ReplayUpdate::None
}

struct StreamEntry {
    stream: Arc<SharedStream>,
    active: bool,
}

#[derive(Default)]
pub(crate) struct Hub {
    streams: Mutex<HashMap<String, StreamEntry>>,
    next_id: AtomicU64,
    next_connection: AtomicU64,
}

impl Hub {
    async fn subscribe(
        self: &Arc<Self>,
        backend: &Backend,
        quota: Option<crate::provider_usage::Ingress>,
        close_revocation: Option<CloseRevocation>,
    ) -> Subscription {
        let id = self.next_id.fetch_add(1, SeqCst) + 1;
        let sub = Subscriber::new(id, quota, close_revocation);
        loop {
            let wait_done = {
                let mut streams = self.streams.lock().unwrap();
                if let Some(entry) = streams.get(&backend.base) {
                    if !entry.active {
                        Some(entry.stream.done.clone())
                    } else {
                        let existing = entry.stream.clone();
                        let mut inner = existing.inner.lock().unwrap();
                        if !matches!(inner.phase, Phase::Closed { .. })
                            && !inner.subscribers.is_empty()
                        {
                            let mut wake_quota = None;
                            if inner.phase == Phase::Open {
                                let replays: Vec<_> = inner.replays.values().cloned().collect();
                                let missing_replay = inner.replays_overflowed
                                    && !backend.workspace.is_empty()
                                    && !inner.replays.contains_key(&backend.workspace);
                                let overflowed = sub.seed_opened(&replays, missing_replay);
                                if let Some(quota) = &sub.quota {
                                    let mut changed = quota.transport_quiet(true);
                                    for frame in &replays {
                                        if frame.0.is_empty() || frame.0 == "message" {
                                            changed |= quota.frame_quiet(&frame.1);
                                        }
                                    }
                                    if overflowed {
                                        changed |= quota.skipped_quiet();
                                    }
                                    #[cfg(not(target_arch = "wasm32"))]
                                    if inner.chunk_active {
                                        quota.begin_chunk();
                                    }
                                    if changed {
                                        wake_quota = Some(quota.clone());
                                    }
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
        if let Some(quota) = &self.sub.quota {
            quota.transport(false);
        }
        let last = {
            let mut streams = self.hub.streams.lock().unwrap();
            let mut inner = self.shared.inner.lock().unwrap();
            inner.subscribers.retain(|s| s.id != self.sub.id);
            if inner.subscribers.is_empty() {
                if let Some(entry) = streams.get_mut(&self.shared.base)
                    && Arc::ptr_eq(&entry.stream, &self.shared)
                {
                    entry.active = false;
                }
                inner.stop.take();
                true
            } else {
                false
            }
        };
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

async fn resync_after_skip(
    shared: &SharedStream,
    backend: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    connection: &str,
    overflow: bool,
) -> Result<()> {
    backend.client.children().invalidate_all(backend);
    reread(epoch, out, state).await?;
    if !overflow {
        return Ok(());
    }
    resync_preferences(epoch, out, state).await?;
    if let Some(status) = shared.replay_for(&backend.workspace) {
        dispatch(backend, epoch, out, state, connection, &status.0, &status.1).await?;
    }
    if state.catalogue.is_none() {
        out.send(Input::Workspace(epoch, WorkspaceEvent::MemoryChanged))
            .await?;
        if crate::history::valid_id(&backend.workspace) {
            out.send(Input::Workspace(
                epoch,
                WorkspaceEvent::MissionsReconnected {
                    workspace_id: backend.workspace.clone(),
                },
            ))
            .await?;
            out.send(Input::Workspace(
                epoch,
                WorkspaceEvent::WorktreesChanged {
                    workspace_id: backend.workspace.clone(),
                },
            ))
            .await?;
            out.send(Input::Workspace(
                epoch,
                WorkspaceEvent::ProvidersChanged {
                    workspace_id: backend.workspace.clone(),
                },
            ))
            .await?;
            if !backend.session.is_empty() {
                out.send(Input::Workspace(
                    epoch,
                    WorkspaceEvent::PermissionReceiptsChanged { message: None },
                ))
                .await?;
            }
        }
    }
    Ok(())
}

pub(super) async fn read_shared(
    backend: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    stream_guard: Arc<StreamDropGuard>,
) -> Result<()> {
    let hub = backend.client.sse_hub();
    let quota = state.quota_ingress(backend);
    let close_revocation = Some(CloseRevocation {
        http: backend.client.clone(),
        guard: stream_guard,
        client_id: backend.client_id.clone(),
    });
    enum SubscribeStep {
        Ready(Subscription),
        Cancelled,
    }
    let sub = match futures_lite::future::or(
        async {
            state.wait_cancelled(out).await;
            SubscribeStep::Cancelled
        },
        async { SubscribeStep::Ready(hub.subscribe(backend, quota, close_revocation).await) },
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
                match sub.sub.recv().await {
                    HubItem::Opened => {
                        backend.client.children().invalidate_all(backend);
                        opened(epoch, out, state).await?;
                    }
                    HubItem::Frame(frame) => {
                        dispatch(backend, epoch, out, state, &connection, &frame.0, &frame.1)
                            .await?;
                    }
                    HubItem::Skipped { overflow } => {
                        resync_after_skip(
                            &sub.shared,
                            backend,
                            epoch,
                            out,
                            state,
                            &connection,
                            overflow,
                        )
                        .await?;
                    }
                    HubItem::Closed { auth_expired } => {
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
