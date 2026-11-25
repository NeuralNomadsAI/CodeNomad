//! Connection-scoped SSE multiplexer: one physical `/api/events` stream per `(Http, base)`
//! shared across all open tabs, `CatalogueWatch`, and `PreferencesWatch`.
use super::{
    Backend, Input, Result, Sender, State, dispatch, limits::FRAME_LIMIT, limits::reread, opened,
};
use crate::{Receiver, bounded, runtime};
use std::{
    collections::{HashMap, VecDeque},
    fmt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering::SeqCst},
    },
    time::Duration,
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
    items: VecDeque<HubItem>,
    bytes: usize,
    closed: bool,
}

struct Subscriber {
    id: u64,
    queue: Mutex<SubQueue>,
    wake_tx: Sender<()>,
    wake_rx: Receiver<()>,
    quota: Option<crate::provider_usage::Ingress>,
}

impl Subscriber {
    fn new(id: u64, quota: Option<crate::provider_usage::Ingress>) -> Arc<Self> {
        let (wake_tx, wake_rx) = bounded(1);
        Arc::new(Self {
            id,
            queue: Mutex::new(SubQueue::default()),
            wake_tx,
            wake_rx,
            quota,
        })
    }

    fn seed_opened(&self, replays: &[Arc<(String, String)>]) -> bool {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return false;
        }
        queue.items.push_back(HubItem::Opened);
        let mut overflowed = false;
        for frame in replays {
            let size = frame.0.len().saturating_add(frame.1.len());
            if queue.items.len() >= MAX_SUBSCRIBER_FRAMES
                || queue.bytes.saturating_add(size) > MAX_SUBSCRIBER_BYTES
            {
                queue.items.clear();
                queue.bytes = 0;
                queue.items.push_back(HubItem::Opened);
                queue.items.push_back(HubItem::Skipped);
                overflowed = true;
                break;
            }
            queue.bytes = queue.bytes.saturating_add(size);
            queue.items.push_back(HubItem::Frame(frame.clone()));
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

    fn push_frame(&self, frame: Arc<(String, String)>) {
        let size = frame.0.len().saturating_add(frame.1.len());
        let overflowed = {
            let mut queue = self.queue.lock().unwrap();
            if queue.closed {
                return;
            }
            if queue.items.len() >= MAX_SUBSCRIBER_FRAMES
                || queue.bytes.saturating_add(size) > MAX_SUBSCRIBER_BYTES
            {
                let had_opened = matches!(queue.items.front(), Some(HubItem::Opened));
                queue.items.clear();
                queue.bytes = 0;
                if had_opened {
                    queue.items.push_back(HubItem::Opened);
                }
                queue.items.push_back(HubItem::Skipped);
                let _ = self.wake_tx.try_send(());
                true
            } else {
                queue.bytes = queue.bytes.saturating_add(size);
                queue.items.push_back(HubItem::Frame(frame));
                let _ = self.wake_tx.try_send(());
                false
            }
        };
        if overflowed && let Some(quota) = &self.quota {
            quota.skipped();
        }
    }

    fn push_skipped(&self) {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return;
        }
        if !matches!(queue.items.back(), Some(HubItem::Skipped)) {
            queue.items.push_back(HubItem::Skipped);
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
    stop: Option<Sender<()>>,
}

pub(super) struct SharedStream {
    base: String,
    inner: Mutex<StreamInner>,
    done: Receiver<()>,
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

    pub(super) fn snapshot_quotas(&self) -> Vec<crate::provider_usage::Ingress> {
        let inner = self.inner.lock().unwrap();
        inner
            .subscribers
            .iter()
            .filter_map(|sub| sub.quota.clone())
            .collect()
    }

    pub(super) fn broadcast_frame(&self, kind: String, data: String) {
        let frame = Arc::new((kind, data));
        let replay_update = classify_replay(&frame.0, &frame.1);
        let subscribers = {
            let mut inner = self.inner.lock().unwrap();
            if matches!(inner.phase, Phase::Closed { .. }) {
                return;
            }
            match replay_update {
                ReplayUpdate::Status(id) => {
                    if inner.replays.len() < MAX_REPLAY_STATUSES || inner.replays.contains_key(&id)
                    {
                        inner.replays.insert(id, frame.clone());
                    }
                }
                ReplayUpdate::Stopped(id) => {
                    inner.replays.remove(&id);
                }
                ReplayUpdate::None => {}
            }
            inner.subscribers.clone()
        };
        for sub in &subscribers {
            sub.push_frame(frame.clone());
        }
    }

    pub(super) fn broadcast_skipped(&self) {
        let subscribers = {
            let inner = self.inner.lock().unwrap();
            if matches!(inner.phase, Phase::Closed { .. }) {
                return;
            }
            inner.subscribers.clone()
        };
        for sub in &subscribers {
            sub.push_skipped();
        }
    }

    pub(super) fn finish(&self, hub: &Hub, auth_expired: bool) {
        let mut wakes = Vec::new();
        {
            let mut streams = hub.streams.lock().unwrap();
            if streams
                .get(&self.base)
                .is_some_and(|existing| std::ptr::eq(Arc::as_ptr(existing), self))
            {
                streams.remove(&self.base);
            }
            let mut inner = self.inner.lock().unwrap();
            if matches!(inner.phase, Phase::Closed { .. }) {
                return;
            }
            inner.phase = Phase::Closed { auth_expired };
            inner.replays.clear();
            inner.stop.take();
            for sub in std::mem::take(&mut inner.subscribers) {
                if let Some(quota) = &sub.quota
                    && quota.transport_quiet(false)
                {
                    wakes.push(quota.clone());
                }
                sub.push_closed(auth_expired);
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

#[derive(Default)]
pub(crate) struct Hub {
    streams: Mutex<HashMap<String, Arc<SharedStream>>>,
    next_id: AtomicU64,
    next_connection: AtomicU64,
}

impl Hub {
    fn subscribe(
        self: &Arc<Self>,
        backend: &Backend,
        quota: Option<crate::provider_usage::Ingress>,
    ) -> Subscription {
        let id = self.next_id.fetch_add(1, SeqCst) + 1;
        let sub = Subscriber::new(id, quota);
        let mut streams = self.streams.lock().unwrap();
        if let Some(existing) = streams.get(&backend.base).cloned() {
            let mut inner = existing.inner.lock().unwrap();
            if !matches!(inner.phase, Phase::Closed { .. }) && !inner.subscribers.is_empty() {
                let mut wake_quota = None;
                if inner.phase == Phase::Open {
                    let replays: Vec<_> = inner.replays.values().cloned().collect();
                    let overflowed = sub.seed_opened(&replays);
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
        }
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
                stop: Some(stop_tx),
            }),
            done: done_rx,
        });
        streams.insert(backend.base.clone(), shared.clone());
        drop(streams);

        let hub = self.clone();
        let backend = backend.clone();
        let pump_shared = shared.clone();
        runtime::spawn(async move {
            let _done = done_tx;
            #[cfg(not(target_arch = "wasm32"))]
            super::native::pump_shared(hub, pump_shared, backend, connection, stop_rx).await;
            #[cfg(target_arch = "wasm32")]
            super::browser::pump_shared(hub, pump_shared, backend, connection, stop_rx).await;
        });

        Subscription {
            hub: self.clone(),
            shared,
            sub,
            closed: false,
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
                if streams
                    .get(&self.shared.base)
                    .is_some_and(|existing| Arc::ptr_eq(existing, &self.shared))
                {
                    streams.remove(&self.shared.base);
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
            let _ = runtime::timeout(Duration::from_millis(500), done.recv()).await;
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
) -> Result<()> {
    let hub = backend.client.sse_hub();
    let quota = state.quota_ingress(backend);
    let sub = hub.subscribe(backend, quota);
    let connection = format!("stream-{epoch}");
    let cancelled = AtomicBool::new(false);
    let result: Result<()> = futures_lite::future::race(
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
                    HubItem::Skipped => {
                        backend.client.children().invalidate_all(backend);
                        reread(epoch, out, state).await?;
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
        async {
            while !state.cancelled.load(SeqCst) && !out.is_closed() {
                runtime::sleep(Duration::from_millis(25)).await;
            }
            cancelled.store(true, SeqCst);
            Ok(())
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
mod tests {
    use super::*;
    use crate::{
        backend::Backend,
        settings::PreferencesWatch,
        stream::{CatalogueWatch, start},
        transport::WorkspaceEvent,
    };
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn tabs_catalogue_and_preferences_share_one_sse_connection_and_close_on_zero() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = format!("http://{}/", listener.local_addr().unwrap());
                let sse_opens = Arc::new(AtomicUsize::new(0));
                let pong_count = Arc::new(AtomicUsize::new(0));
                let (frame_tx, frame_rx) = bounded::<String>(16);
                let (closed_tx, closed_rx) = bounded::<()>(1);
                let sse_opens_srv = sse_opens.clone();
                let pong_count_srv = pong_count.clone();
                let server = tokio::spawn(async move {
                    loop {
                        let Ok((mut sock, _)) = listener.accept().await else {
                            break;
                        };
                        let sse_opens = sse_opens_srv.clone();
                        let pong_count = pong_count_srv.clone();
                        let frame_rx = frame_rx.clone();
                        let closed_tx = closed_tx.clone();
                        tokio::spawn(async move {
                            let mut buf = [0u8; 4096];
                            let n = sock.read(&mut buf).await.unwrap_or(0);
                            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                            if req.starts_with("GET /api/events?") {
                                sse_opens.fetch_add(1, SeqCst);
                                let init = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n\
                                     data: {}\n\n",
                                    json!({"type":"instance.eventStatus","instanceId":"ws-a","status":"connected","generation":1})
                                );
                                if sock.write_all(init.as_bytes()).await.is_err() {
                                    return;
                                }
                                let mut probe = [0u8; 1];
                                enum ServerStep {
                                    Frame(std::result::Result<String, async_channel::RecvError>),
                                    Read(std::io::Result<usize>),
                                }
                                loop {
                                    let step = futures_lite::future::race(
                                        async { ServerStep::Frame(frame_rx.recv().await) },
                                        async { ServerStep::Read(sock.read(&mut probe).await) },
                                    )
                                    .await;
                                    match step {
                                        ServerStep::Frame(Ok(msg)) => {
                                            if sock.write_all(msg.as_bytes()).await.is_err() {
                                                break;
                                            }
                                        }
                                        ServerStep::Frame(Err(_))
                                        | ServerStep::Read(Ok(0))
                                        | ServerStep::Read(Err(_)) => break,
                                        ServerStep::Read(Ok(_)) => {}
                                    }
                                }
                                let _ = closed_tx.try_send(());
                            } else if req.starts_with("POST /api/client-connections/pong") {
                                pong_count.fetch_add(1, SeqCst);
                                let _ = sock
                                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                                    .await;
                            }
                        });
                    }
                });

                let base = Backend::unauthenticated(&addr).unwrap();
                let mut tab_a = base.clone();
                tab_a.workspace = "ws-a".into();
                tab_a.session = "ses-a".into();
                let mut tab_b = base.clone();
                tab_b.workspace = "ws-b".into();
                tab_b.session = "ses-b".into();
                tab_b.client_id.push_str("-tab-b");

                let (out_a, in_a) = bounded(16);
                let state_a = Arc::new(State::default());
                start(tab_a, 1, out_a, state_a.clone());
                assert!(matches!(
                    tokio::time::timeout(Duration::from_secs(2), in_a.recv())
                        .await
                        .unwrap()
                        .unwrap(),
                    Input::Opened(1)
                ));
                assert_eq!(sse_opens.load(SeqCst), 1);

                // Attach second tab, CatalogueWatch, and PreferencesWatch on the same Http.
                let (out_b, in_b) = bounded(16);
                let state_b = Arc::new(State::default());
                start(tab_b, 1, out_b, state_b.clone());
                assert!(matches!(
                    tokio::time::timeout(Duration::from_secs(2), in_b.recv())
                        .await
                        .unwrap()
                        .unwrap(),
                    Input::Opened(1)
                ));

                let (catalogue, cat_task) = CatalogueWatch::new(base.clone(), Arc::new(|| {}));
                let cat_handle = tokio::spawn(cat_task);
                let (prefs, prefs_task) = PreferencesWatch::task(base.clone(), None, Arc::new(|| {}));
                let prefs_handle = tokio::spawn(prefs_task);
                tokio::time::timeout(Duration::from_secs(2), async {
                    while !prefs.is_connected() {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .expect("PreferencesWatch must open via shared SSE");

                // All 4 consumers must share exactly ONE physical /api/events connection.
                assert_eq!(sse_opens.load(SeqCst), 1);

                // A single ping from the server triggers exactly one pong.
                frame_tx
                    .send("event: codenomad.client.ping\ndata: {\"ts\":1}\n\n".into())
                    .await
                    .unwrap();
                tokio::time::timeout(Duration::from_secs(2), async {
                    while pong_count.load(SeqCst) == 0 {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap();
                tokio::time::sleep(Duration::from_millis(30)).await;
                assert_eq!(pong_count.load(SeqCst), 1);

                // Broadcast events reach each scoped subscriber cleanly.
                frame_tx
                    .send(format!(
                        "data: {}\n\ndata: {}\n\n",
                        json!({"type":"workspace.stopped","workspaceId":"ws-b"}),
                        json!({"type":"storage.configChanged","owner":"ui","value":{}})
                    ))
                    .await
                    .unwrap();
                assert!(matches!(
                    tokio::time::timeout(Duration::from_secs(2), in_b.recv())
                        .await
                        .unwrap()
                        .unwrap(),
                    Input::Workspace(1, WorkspaceEvent::Stopped { workspace_id }) if workspace_id == "ws-b"
                ));
                tokio::time::timeout(Duration::from_secs(2), async {
                    while !prefs.take().0 {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .expect("PreferencesWatch must receive storage.configChanged");

                // Closing 3 of 4 subscribers keeps the shared SSE open; closing the last closes it.
                state_a.cancelled.store(true, SeqCst);
                drop(catalogue);
                let _ = prefs.stop().recv().await;
                let _ = (cat_handle, prefs_handle);
                tokio::time::sleep(Duration::from_millis(60)).await;
                assert!(
                    closed_rx.try_recv().is_err(),
                    "physical SSE must stay open while tab B is still subscribed"
                );
                state_b.cancelled.store(true, SeqCst);
                tokio::time::timeout(Duration::from_secs(2), closed_rx.recv())
                    .await
                    .expect("physical SSE must close immediately when last subscriber leaves")
                    .unwrap();
                assert_eq!(sse_opens.load(SeqCst), 1);
                server.abort();
            });
    }

    #[test]
    fn physical_401_fans_out_authentication_required_to_all_subscribers() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = format!("http://{}/", listener.local_addr().unwrap());
                let server = tokio::spawn(async move {
                    if let Ok((mut sock, _)) = listener.accept().await {
                        let mut buf = [0u8; 4096];
                        let _ = sock.read(&mut buf).await;
                        let _ = sock
                            .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\n{}")
                            .await;
                    }
                });
                let base = Backend::unauthenticated(&addr).unwrap();
                let (out_a, in_a) = bounded(4);
                let (out_b, in_b) = bounded(4);
                start(base.clone(), 1, out_a, Arc::new(State::default()));
                start(base, 2, out_b, Arc::new(State::default()));
                assert!(matches!(
                    tokio::time::timeout(Duration::from_secs(2), in_a.recv())
                        .await
                        .unwrap()
                        .unwrap(),
                    Input::AuthenticationRequired(1)
                ));
                assert!(matches!(
                    tokio::time::timeout(Duration::from_secs(2), in_b.recv())
                        .await
                        .unwrap()
                        .unwrap(),
                    Input::AuthenticationRequired(2)
                ));
                server.abort();
            });
    }

    #[test]
    fn slow_subscriber_overflows_to_reread_without_blocking_sibling() {
        let hub = Arc::new(Hub::default());
        let (stop_tx, _stop_rx) = bounded(1);
        let (_done_tx, done_rx) = bounded(1);
        let slow = Subscriber::new(1, None);
        let fast = Subscriber::new(2, None);
        let shared = Arc::new(SharedStream {
            base: "http://127.0.0.1:1/".into(),
            inner: Mutex::new(StreamInner {
                phase: Phase::Connecting,
                subscribers: vec![slow.clone(), fast.clone()],
                replays: HashMap::new(),
                stop: Some(stop_tx),
            }),
            done: done_rx,
        });
        assert!(shared.mark_open());
        assert!(matches!(fast.pop(), Some(HubItem::Opened)));
        for i in 0..=MAX_SUBSCRIBER_FRAMES {
            shared.broadcast_frame(
                "message".into(),
                format!("{{\"type\":\"memory.changed\",\"seq\":{i}}}"),
            );
            assert!(
                matches!(fast.pop(), Some(HubItem::Frame(_))),
                "fast sibling must receive every frame immediately"
            );
        }
        assert!(
            matches!(slow.pop(), Some(HubItem::Opened)),
            "slow subscriber preserves initial Opened"
        );
        assert!(
            matches!(slow.pop(), Some(HubItem::Skipped)),
            "slow subscriber collapses backlog to Skipped without blocking fast sibling"
        );
        assert!(slow.pop().is_none());
        shared.finish(&hub, false);
    }

    #[test]
    fn late_subscriber_receives_cached_instance_event_status_and_quota_authority() {
        let hub = Arc::new(Hub::default());
        let (stop_tx, _stop_rx) = bounded(1);
        let (_done_tx, done_rx) = bounded(1);
        let first = Subscriber::new(1, None);
        let shared = Arc::new(SharedStream {
            base: "http://127.0.0.1:1/".into(),
            inner: Mutex::new(StreamInner {
                phase: Phase::Connecting,
                subscribers: vec![first.clone()],
                replays: HashMap::new(),
                stop: Some(stop_tx),
            }),
            done: done_rx,
        });
        hub.streams
            .lock()
            .unwrap()
            .insert("http://127.0.0.1:1/".into(), shared.clone());
        assert!(shared.mark_open());
        shared.broadcast_frame(
            "message".into(),
            json!({
                "type": "instance.eventStatus",
                "instanceId": "ws-live",
                "status": "disconnected",
                "generation": 7
            })
            .to_string(),
        );
        shared.broadcast_frame(
            "message".into(),
            json!({
                "type": "instance.eventStatus",
                "instanceId": "ws-stopped",
                "status": "connected",
                "generation": 1
            })
            .to_string(),
        );
        shared.broadcast_frame(
            "message".into(),
            json!({"type": "workspace.stopped", "workspaceId": "ws-stopped"}).to_string(),
        );

        let mut backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
        backend.workspace = "ws-live".into();
        backend.session = "ses-1".into();
        let watch = crate::provider_usage::Watch::default();
        let wakes = Arc::new(AtomicUsize::new(0));
        let wakes_cb = wakes.clone();
        let ingress = crate::provider_usage::Ingress::new(
            watch.clone(),
            Arc::new(move || {
                wakes_cb.fetch_add(1, SeqCst);
            }),
            backend.workspace.clone(),
            backend.session.clone(),
        );
        let late = hub.subscribe(&backend, Some(ingress));
        // Quota watch must have observed transport(true) AND replayed disconnected status.
        assert!(!watch.current().1);
        assert!(wakes.load(SeqCst) >= 1);
        assert!(matches!(late.sub.pop(), Some(HubItem::Opened)));
        let Some(HubItem::Frame(replayed)) = late.sub.pop() else {
            panic!("expected replayed instance.eventStatus for ws-live");
        };
        assert!(replayed.1.contains("\"ws-live\""));
        assert!(
            late.sub.pop().is_none(),
            "stopped workspace status must be evicted from replay cache"
        );
        // Live connected frame updates the late subscriber's quota authority synchronously.
        let connected = json!({
            "type": "instance.eventStatus",
            "instanceId": "ws-live",
            "status": "connected",
            "generation": 8
        })
        .to_string();
        for q in shared.snapshot_quotas() {
            q.frame(&connected);
        }
        assert!(watch.current().1);
        drop(late);
        shared.finish(&hub, false);
    }
}
