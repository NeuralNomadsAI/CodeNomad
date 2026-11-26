//! Bridge from the daemon's event stream to the workspaces: one FIFO lane per session (or
//! location) so a slow ownership or location read never holds the others, as the TS
//! `InstanceEventQueue` does, with its budget and the reference's session location cache.
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicI64, AtomicUsize, Ordering::Relaxed},
    },
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::upstream;
use crate::{App, Shared};

/// Integration notifications carry invalidation only (`integrations/events.ts:4-10`).
static INTEGRATION_RPC_EVENT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^rpc\.neuralnomads\.[a-z][a-z0-9-]{0,31}\.(status_changed|hosts_changed)$").unwrap()
});

#[derive(Debug, PartialEq)]
enum IntegrationRelay {
    Relay(Value),
    Drop,
    Malformed,
}

fn valid_location_str(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.trim().is_empty() && !s.contains('\0'))
}

fn integration_event_for_relay(event: Value) -> IntegrationRelay {
    let Some(kind) = event["type"].as_str() else {
        return IntegrationRelay::Malformed;
    };
    if !kind.starts_with("rpc.neuralnomads.") {
        return IntegrationRelay::Relay(event);
    }
    if !INTEGRATION_RPC_EVENT.is_match(kind) {
        return IntegrationRelay::Drop;
    }
    let Some(raw_location) = event.get("location") else {
        return IntegrationRelay::Drop;
    };
    // Match TS `if (!event.location) return undefined` (falsy values drop).
    let falsy = match raw_location {
        Value::Null | Value::Bool(false) => true,
        Value::String(s) if s.is_empty() => true,
        Value::Number(n) if n.as_f64() == Some(0.0) => true,
        _ => false,
    };
    if falsy {
        return IntegrationRelay::Drop;
    }
    // Match TS `readLocationRef(event.location)` (`location.ts:5-12`): malformed truthy
    // location objects throw in `eventKey()` and reconnect the upstream stream.
    let Some(location) = raw_location.as_object() else {
        return IntegrationRelay::Malformed;
    };
    let Some(directory) = location.get("directory").and_then(valid_location_str) else {
        return IntegrationRelay::Malformed;
    };
    let mut sanitized_location = serde_json::Map::new();
    sanitized_location.insert("directory".into(), Value::String(directory.to_owned()));
    if let Some(workspace_id) = location.get("workspaceID") {
        let Some(ws) = valid_location_str(workspace_id) else {
            return IntegrationRelay::Malformed;
        };
        sanitized_location.insert("workspaceID".into(), Value::String(ws.to_owned()));
    }
    IntegrationRelay::Relay(json!({
        "type": kind,
        "location": Value::Object(sanitized_location),
        "data": {},
    }))
}

/// Native events without a location that every workspace receives.
const GLOBAL: &str = "agent.updated command.updated config.updated credential.switched credential.updated \
    integration.updated installation.update-available installation.updated mcp.resources.changed \
    mcp.status.changed models-dev.refreshed model.updated plugin.updated provider.updated \
    reference.updated server.connected skill.updated websearch.updated worktree.updated";
/// Routing work one upstream connection may hold, and one event's routing time, before it
/// reconnects: the UI then reconciles every workspace (TS `InstanceEventQueue` limits).
const ROUTING_JOBS: usize = 2048;
const ROUTING_BYTES: usize = 32 << 20;
const ROUTING_TIMEOUT: Duration = Duration::from_secs(60);
/// A session's directory from its last located event or native read (TS `sessionLocations`).
const LOCATION_TTL: Duration = Duration::from_secs(2);

/// Estimates the in-memory footprint of a retained `serde_json::Value` so dense numeric/object
/// arrays cannot exceed `ROUTING_BYTES` even when their serialized JSON text is compact.
fn value_bytes(value: &Value) -> usize {
    let mut total = std::mem::size_of::<Value>();
    let mut stack = vec![value];
    while let Some(v) = stack.pop() {
        match v {
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
            Value::String(s) => total = total.saturating_add(s.capacity()),
            Value::Array(items) => {
                total = total.saturating_add(items.capacity().saturating_mul(std::mem::size_of::<Value>()));
                for item in items {
                    stack.push(item);
                }
            }
            Value::Object(map) => {
                // Account for `BTreeMap` node/entry overhead plus owned key strings.
                total = total.saturating_add(map.len().saturating_mul(std::mem::size_of::<Value>() + 64));
                for (k, val) in map {
                    total = total.saturating_add(k.capacity());
                    stack.push(val);
                }
            }
        }
        if total > ROUTING_BYTES {
            return total;
        }
    }
    total
}

fn status(app: &App, next: &'static str, reason: Option<&str>) {
    let mut store = app.inner.lock().unwrap();
    if next == "connecting" {
        store.generation += 1;
    }
    store.status = next;
    for w in &store.workspaces {
        app.emit_status(w.id, next, store.generation, reason);
    }
}

/// Workspaces that received a session's events (TS `sessionRecipients`, same
/// bound): a move reaches them even when its envelope names only the destination.
#[derive(Default)]
struct Held {
    order: VecDeque<String>,
    sessions: HashMap<String, HashSet<Uuid>>,
}
const SESSION_RECIPIENT_LIMIT: usize = 4096;
impl Held {
    fn has(&self, session: &str, w: Uuid) -> bool {
        self.sessions.get(session).is_some_and(|s| s.contains(&w))
    }
    fn remember(&mut self, session: &str, w: Uuid) {
        if !self.sessions.contains_key(session) {
            self.order.push_back(session.to_owned());
            if self.order.len() > SESSION_RECIPIENT_LIMIT
                && let Some(oldest) = self.order.pop_front()
            {
                self.sessions.remove(&oldest);
            }
        }
        self.sessions.entry(session.to_owned()).or_default().insert(w);
    }
    fn forget(&mut self, session: &str, w: Uuid) {
        if let Some(set) = self.sessions.get_mut(session) {
            set.remove(&w);
            if set.is_empty() {
                self.sessions.remove(session);
                self.order.retain(|s| s != session);
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum CachedLocation {
    Directory(String),
    ForeignWorkspace,
}

#[derive(Default)]
struct Routes {
    held: Mutex<Held>,
    locations: Mutex<(u64, HashMap<String, (Instant, CachedLocation)>)>,
}

impl Routes {
    /// Clears cached session directories for a new SSE subscription while preserving `held`
    /// recipients (so `session.moved` after reconnect still notifies the old workspace, TS
    /// `instance-events.ts:143-147, 282-309`) and bumps the generation so late workers from an
    /// earlier subscription cannot repopulate stale locations.
    fn reset_locations(&self) -> u64 {
        let mut guard = self.locations.lock().unwrap();
        guard.0 = guard.0.wrapping_add(1);
        guard.1.clear();
        guard.0
    }
    /// The location a session event is routed by: its envelope's, else a fresh cached one.
    /// Preserves native `workspaceID` selectors so events for foreign workspaces are never
    /// delivered to local workspaces (TS `instance-events.ts:375-386`, `manager.ts:337-342`).
    fn location(&self, generation: u64, kind: &str, session: Option<&str>, event: &Value) -> Option<CachedLocation> {
        let located = if event["location"].get("workspaceID").is_some() {
            Some(CachedLocation::ForeignWorkspace)
        } else {
            event["location"]["directory"].as_str().map(|dir| CachedLocation::Directory(dir.to_owned()))
        };
        let Some(session) = session else { return located };
        let mut guard = self.locations.lock().unwrap();
        if guard.0 != generation {
            return located;
        }
        let cache = &mut guard.1;
        let now = Instant::now();
        if matches!(kind, "session.moved" | "session.deleted") {
            cache.remove(session);
        } else if let Some(loc) = &located {
            Self::cache(cache, session, loc.clone(), now);
        } else {
            return cache.get(session).filter(|(until, _)| *until > now).map(|(_, loc)| loc.clone());
        }
        located
    }
    fn learn(&self, generation: u64, session: &str, loc: CachedLocation) {
        let mut guard = self.locations.lock().unwrap();
        if guard.0 == generation {
            Self::cache(&mut guard.1, session, loc, Instant::now());
        }
    }

    fn cache(cache: &mut HashMap<String, (Instant, CachedLocation)>, session: &str, loc: CachedLocation, now: Instant) {
        if cache.len() >= SESSION_RECIPIENT_LIMIT && !cache.contains_key(session) {
            cache.retain(|_, (until, _)| *until > now);
            if cache.len() >= SESSION_RECIPIENT_LIMIT {
                return;
            }
        }
        cache.insert(session.to_owned(), (now + LOCATION_TTL, loc));
    }
}

/// FIFO key of a native event (TS `eventKey`): its session, PTY or shell, else its location.
fn lane(event: &Value) -> String {
    let (kind, data) = (event["type"].as_str().unwrap_or_default(), &event["data"]);
    let entity = |prefix: &str| data["id"].as_str().or(data["info"]["id"].as_str()).map(|id| format!("{prefix}:{id}"));
    data["sessionID"]
        .as_str()
        .or(data["form"]["sessionID"].as_str().filter(|_| kind == "form.created"))
        .filter(|s| !s.is_empty() && *s != "global")
        .map(|s| format!("session:{s}"))
        .or_else(|| kind.starts_with("pty.").then(|| entity("pty")).flatten())
        .or_else(|| kind.starts_with("shell.").then(|| entity("shell")).flatten())
        .unwrap_or_else(|| format!("location:{}\0{}", event["location"]["directory"], event["location"]["workspaceID"]))
}

struct BytesLease {
    lanes: std::sync::Weak<Lanes>,
    bytes: usize,
}

impl Drop for BytesLease {
    fn drop(&mut self) {
        if let Some(lanes) = self.lanes.upgrade() {
            lanes.bytes.fetch_sub(self.bytes, Relaxed);
        }
    }
}

enum JobWork {
    Route {
        lane_key: String,
        event: Arc<Value>,
        endpoint: Arc<crate::opencode::Endpoint>,
        received: (Instant, i64),
        generation: u64,
    },
    Deliver {
        workspace: crate::Workspace,
        event: Arc<Value>,
        endpoint: Arc<crate::opencode::Endpoint>,
        received: (Instant, i64),
        directory: Option<Arc<str>>,
        foreign_workspace: bool,
        session_id: Option<Arc<str>>,
    },
}

struct Job {
    received_at: Instant,
    lease: Arc<BytesLease>,
    work: JobWork,
}

/// One upstream connection's lanes; `failed` ends the connection.
#[derive(Default)]
struct Lanes {
    queues: Mutex<HashMap<String, VecDeque<Job>>>,
    jobs: AtomicUsize,
    bytes: AtomicUsize,
    failed: CancellationToken,
    receipts: Arc<crate::sessions::receipts::Recovery>,
}

impl Lanes {
    /// Queues a root event job behind its lane, starting the lane when idle; false past the budget.
    fn enqueue_root(
        self: &Arc<Self>,
        app: &Shared,
        routes: &Arc<Routes>,
        key: String,
        bytes: usize,
        event: Value,
        endpoint: Arc<crate::opencode::Endpoint>,
        received: (Instant, i64),
        generation: u64,
    ) -> bool {
        if self.bytes.fetch_add(bytes, Relaxed) + bytes > ROUTING_BYTES {
            self.bytes.fetch_sub(bytes, Relaxed);
            return false;
        }
        let lease = Arc::new(BytesLease { lanes: Arc::downgrade(self), bytes });
        let job = Job {
            received_at: received.0,
            lease,
            work: JobWork::Route { lane_key: key.clone(), event: Arc::new(event), endpoint, received, generation },
        };
        self.enqueue_job(app, routes, key, job)
    }

    fn enqueue_job(self: &Arc<Self>, app: &Shared, routes: &Arc<Routes>, key: String, job: Job) -> bool {
        if self.jobs.fetch_add(1, Relaxed) >= ROUTING_JOBS {
            self.jobs.fetch_sub(1, Relaxed);
            return false;
        }
        let mut queues = self.queues.lock().unwrap();
        if let Some(queue) = queues.get_mut(&key) {
            queue.push_back(job);
            return true;
        }
        queues.insert(key.clone(), VecDeque::from([job]));
        tokio::spawn(self.clone().drain(app.clone(), routes.clone(), key));
        true
    }
    async fn drain(self: Arc<Self>, app: Shared, routes: Arc<Routes>, key: String) {
        loop {
            let job = {
                let mut queues = self.queues.lock().unwrap();
                let Some(job) = queues.get_mut(&key).and_then(VecDeque::pop_front) else {
                    queues.remove(&key);
                    return;
                };
                job
            };
            let timeout = ROUTING_TIMEOUT.saturating_sub(job.received_at.elapsed());
            let done = tokio::select! {
                biased;
                _ = self.failed.cancelled() => {
                    self.jobs.fetch_sub(1, Relaxed);
                    return;
                }
                done = tokio::time::timeout(timeout, async {
                    match job.work {
                        JobWork::Route { lane_key, event, endpoint, received, generation } => {
                            route(&app, &routes, &self, lane_key, event, endpoint, received, generation, job.lease).await;
                        }
                        JobWork::Deliver {
                            workspace,
                            event,
                            endpoint,
                            received,
                            directory,
                            foreign_workspace,
                            session_id,
                        } => {
                            let _lease = job.lease;
                            deliver(
                                &app,
                                &routes,
                                workspace,
                                event,
                                endpoint,
                                received,
                                directory,
                                foreign_workspace,
                                session_id,
                            )
                            .await;
                        }
                    }
                }) => done,
            };
            self.jobs.fetch_sub(1, Relaxed);
            if done.is_err() {
                return self.failed.cancel();
            }
        }
    }
}

pub async fn bridge(app: Shared, shutdown: CancellationToken) {
    // Rotate the `server.connected` daemon token whenever the underlying daemon endpoint/credentials
    // change (TS `instance-events.ts:203-210`).
    let mut daemon_source: Option<(String, String)> = None;
    let routes = Arc::new(Routes::default());
    loop {
        if shutdown.is_cancelled() {
            return;
        }
        let generation = routes.reset_locations();
        while {
            let store = app.inner.lock().unwrap();
            store.workspaces.is_empty() && store.generation == 0
        } {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => return,
                _ = app.opened.notified() => {}
            }
        }
        status(&app, "connecting", None);
        // Reacquire the shared daemon on every subscription and prepare its bundled plugins.
        let deadline = tokio::time::Instant::now() + crate::opencode::daemon::TIMEOUT;
        let endpoint = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return,
            acquired = app.native.acquire(deadline) => match acquired {
                Ok(endpoint) => endpoint,
                Err(refusal) => {
                    eprintln!("Shared OpenCode event stream disconnected: {refusal}");
                    status(&app, "error", Some(&refusal.to_string()));
                    tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => return,
                        _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                    }
                    continue;
                }
            },
        };
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => return,
            _ = app.native.wait_retired(&endpoint) => continue,
            _ = tokio::time::timeout(Duration::from_secs(20), crate::extensions::lifecycle::prepare(&app, &endpoint)) => {}
        }
        let mut keep_connection = false;
        let mut disconnect_reason = String::from("Shared OpenCode event stream ended");
        let Ok(event_url) = endpoint.url.join("/api/event") else {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => return,
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
            continue;
        };
        let response = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return,
            _ = app.native.wait_retired(&endpoint) => continue,
            res = app
                .native
                .client
                .get(event_url)
                .basic_auth("opencode", Some(&endpoint.password))
                .header("accept", "text/event-stream")
                .send() => res,
        };
        if let Ok(response) = response
            && response.status().is_success()
            && response.headers().get("content-type").is_some_and(|v| v.as_bytes().starts_with(b"text/event-stream"))
        {
            // Any chunk, including the daemon's `: heartbeat` comments (every 15 s when idle),
            // proves the stream alive: only 60 s without a byte reconnects and resynchronizes the UI.
            let now = || chrono::Utc::now().timestamp_millis();
            let seen = Arc::new(AtomicI64::new(now()));
            let mark = seen.clone();
            let mut stream = Box::pin(upstream::events::<Value, _, _>(Box::pin(response.bytes_stream()), move || {
                mark.store(now(), Relaxed)
            }));
            let lanes = Arc::new(Lanes::default());
            let permissions = Arc::new(crate::sessions::permission_mode::RefreshQueue::default());
            let mut connected = false;
            loop {
                let next = tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => break,
                    _ = lanes.failed.cancelled() => {
                        keep_connection = true;
                        break;
                    }
                    _ = app.native.wait_retired(&endpoint) => break,
                    _ = app.opened.notified(), if connected => {
                        lanes.receipts.schedule();
                        continue;
                    }
                    next = tokio::time::timeout(Duration::from_secs(60), stream.next()) => next,
                };
                let next = match next {
                    Ok(next) => next,
                    Err(_) if now() - seen.load(Relaxed) < 60_000 => continue,
                    Err(_) => break,
                };
                let Some(Ok(event)) = next else { break };
                if event["type"].as_str().is_none() {
                    break;
                }
                let mut event = match integration_event_for_relay(event) {
                    IntegrationRelay::Relay(event) => event,
                    IntegrationRelay::Drop => continue,
                    IntegrationRelay::Malformed => {
                        keep_connection = true;
                        disconnect_reason = "Invalid location".into();
                        break;
                    }
                };
                let Some(kind) = event["type"].as_str().map(str::to_owned) else { break };
                let received = (Instant::now(), now());
                if !connected {
                    if kind != "server.connected" {
                        keep_connection = true;
                        disconnect_reason =
                            format!("Expected initial OpenCode event \"server.connected\", received \"{kind}\"");
                        break;
                    }
                    connected = true;
                    status(&app, "connected", None);
                    // Reference: bundled plugins are provisioned on every OpenCode connection.
                    crate::extensions::lifecycle::connected();
                    tokio::spawn(lanes.receipts.clone().run(app.clone(), endpoint.clone(), lanes.failed.clone()));
                }
                permissions.enqueue(&app, &endpoint, &lanes.failed, &event);
                if kind == "server.connected" {
                    let source_key =
                        format!("{}\0{}\0{}\0{}", endpoint.url, endpoint.password, endpoint.pid, endpoint.version);
                    let daemon = match &daemon_source {
                        Some((key, token)) if *key == source_key => token.clone(),
                        _ => {
                            let token = Uuid::new_v4().simple().to_string();
                            daemon_source = Some((source_key, token.clone()));
                            token
                        }
                    };
                    if !event["data"].is_object() {
                        event["data"] = json!({});
                    }
                    event["data"]["daemon"] = json!(daemon);
                }
                if kind.starts_with("worktree.") || kind == "server.connected" {
                    // Match TS `instance-events.ts:170-173` & `manager.ts:506-511`: any worktree
                    // event invalidates every workspace's cached worktree inventory.
                    crate::worktrees::linked::invalidate(&app);
                    lanes.receipts.schedule();
                }
                if kind == "session.deleted"
                    && let Some(id) = event["data"]["sessionID"].as_str()
                {
                    lanes.receipts.retire(id);
                }
                const SDK_FRAME_UNITS: usize = 16 * 1024 * 1024;
                let wire = event.to_string();
                let mut bytes = wire.len().max(value_bytes(&event));
                if bytes > ROUTING_BYTES {
                    break;
                }
                if wire.len() > SDK_FRAME_UNITS && wire.encode_utf16().count() > SDK_FRAME_UNITS {
                    drop(wire);
                    // Matches TS `native-event-stream.ts:30-38`: an oversized upstream SSE event
                    // fails the stream and invalidates the shared connection (`keep_connection = false`).
                    let Some(files) = crate::sessions::user_files::projected_inbox_files(&event) else {
                        break;
                    };
                    event["data"]["item"]["payload"]["files"] = files;
                    let projected = event.to_string();
                    bytes = projected.len().max(value_bytes(&event));
                    if bytes > ROUTING_BYTES
                        || (projected.len() > SDK_FRAME_UNITS && projected.encode_utf16().count() > SDK_FRAME_UNITS)
                    {
                        break;
                    }
                }
                let key = lane(&event);
                if !lanes.enqueue_root(&app, &routes, key, bytes, event, endpoint.clone(), received, generation) {
                    keep_connection = true;
                    break;
                }
            }
            lanes.failed.cancel();
        }
        if shutdown.is_cancelled() {
            return;
        }
        // Only invalidate the shared daemon connection on transport disconnect/timeout, not on
        // local SSE backpressure or an unexpected initial event (TS `instance-events.ts:150-168`).
        if !keep_connection {
            app.native.invalidate(&endpoint);
        }
        eprintln!("Shared OpenCode event stream disconnected: {disconnect_reason}");
        status(&app, "error", Some(&disconnect_reason));
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn route(
    app: &Shared,
    routes: &Arc<Routes>,
    lanes: &Arc<Lanes>,
    lane_key: String,
    event: Arc<Value>,
    endpoint: Arc<crate::opencode::Endpoint>,
    received: (Instant, i64),
    generation: u64,
    lease: Arc<BytesLease>,
) {
    let kind = event["type"].as_str().unwrap_or_default();
    let session = event["data"]["sessionID"]
        .as_str()
        .or_else(|| event["data"]["form"]["sessionID"].as_str())
        .filter(|s| crate::opencode::valid_id(s));
    let mut resolved = routes.location(generation, kind, session, &event);
    if resolved.is_none()
        && let Some(session) = session
    {
        if let Ok(found) = crate::opencode::session_location(app, session).await {
            let loc = match found {
                Some(dir) => CachedLocation::Directory(dir),
                None => CachedLocation::ForeignWorkspace,
            };
            if kind != "session.deleted" {
                routes.learn(generation, session, loc.clone());
            }
            resolved = Some(loc);
        }
    }
    let foreign_workspace = matches!(resolved, Some(CachedLocation::ForeignWorkspace));
    let directory: Option<Arc<str>> = match resolved {
        Some(CachedLocation::Directory(dir)) => Some(Arc::from(dir)),
        _ => None,
    };
    let session_id = event["data"]["sessionID"].as_str();
    let session_id: Option<Arc<str>> =
        session_id.filter(|s| *s != "global" && crate::opencode::valid_id(s)).map(Arc::from);
    crate::sessions::favorites::deleted(app, &event);
    let is_moved = kind == "session.moved"
        && session_id.is_some()
        && event["data"]["location"]["directory"]
            .as_str()
            .filter(|_| event["data"]["location"].get("workspaceID").is_none())
            .is_some();
    let eligible = is_moved
        || (!foreign_workspace
            && event["location"].get("workspaceID").is_none()
            && (directory.is_some() || GLOBAL.split(' ').any(|g| g == kind) || kind == "session.deleted"));
    if !eligible {
        return;
    }
    // Fan out onto per-(workspace, lane) delivery queues (matching TS `instance-events.ts:288-311`)
    // so a slow ownership check on one workspace never stalls subsequent deltas for another.
    let workspaces = app.inner.lock().unwrap().workspaces.clone();
    for workspace in workspaces {
        let deliver_key = format!("deliver:{}:{lane_key}", workspace.id);
        let deliver_job = Job {
            received_at: received.0,
            lease: Arc::clone(&lease),
            work: JobWork::Deliver {
                workspace,
                event: Arc::clone(&event),
                endpoint: Arc::clone(&endpoint),
                received,
                directory: directory.clone(),
                foreign_workspace,
                session_id: session_id.clone(),
            },
        };
        if !lanes.enqueue_job(app, routes, deliver_key, deliver_job) {
            lanes.failed.cancel();
            return;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn deliver(
    app: &Shared,
    routes: &Routes,
    workspace: crate::Workspace,
    event: Arc<Value>,
    endpoint: Arc<crate::opencode::Endpoint>,
    (routed, received): (Instant, i64),
    directory: Option<Arc<str>>,
    foreign_workspace: bool,
    session_id: Option<Arc<str>>,
) {
    let kind = event["type"].as_str().unwrap_or_default();
    let inbox = kind.starts_with("session.inbox.");
    let receipt_event = matches!(kind, "permission.asked" | "permission.replied" | "session.deleted");
    let mut delivered = false;
    // Match TS `instance-events.ts:288-328`: resolve ownership for this workspace, retrying
    // whenever `worktree.updated` bumps `inventory_revision` while the route stays current
    // (bounded by the lane's `ROUTING_TIMEOUT`).
    if kind == "session.moved"
        && let Some(sid) = session_id.as_deref()
        && let Some(destination) = event["data"]["location"]["directory"]
            .as_str()
            .filter(|_| event["data"]["location"].get("workspaceID").is_none())
            .map(str::to_owned)
    {
        loop {
            if !app.native.current(&endpoint) || app.workspace(&workspace.id.to_string()).is_err() {
                break;
            }
            let rev = crate::worktrees::event_inventory_revision(app, workspace.id);
            let source = match directory.as_deref() {
                Some(dir) if !foreign_workspace && event["location"].get("workspaceID").is_none() => {
                    crate::worktrees::owns_event(app, &workspace, dir).await
                }
                _ => false,
            };
            let owns_destination = crate::worktrees::owns_event(app, &workspace, &destination).await;
            if crate::worktrees::event_inventory_revision(app, workspace.id) != rev {
                continue;
            }
            if !app.native.current(&endpoint) || app.workspace(&workspace.id.to_string()).is_err() {
                break;
            }
            let send = {
                let mut held = routes.held.lock().unwrap();
                if owns_destination {
                    held.remember(sid, workspace.id);
                }
                if held.has(sid, workspace.id) || source || owns_destination {
                    if !owns_destination {
                        held.forget(sid, workspace.id);
                    }
                    true
                } else {
                    false
                }
            };
            if send {
                let envelope = json!({"type":"instance.event","instanceId":workspace.id,"event":&*event});
                app.emit(envelope);
                delivered = true;
            }
            break;
        }
    } else if !foreign_workspace
        && event["location"].get("workspaceID").is_none()
        && (directory.is_some() || GLOBAL.split(' ').any(|g| g == kind) || kind == "session.deleted")
    {
        loop {
            if !app.native.current(&endpoint) || app.workspace(&workspace.id.to_string()).is_err() {
                break;
            }
            let rev = crate::worktrees::event_inventory_revision(app, workspace.id);
            let mut inbox_proof = None;
            let owned = if let Some(dir) = directory.as_deref() {
                if inbox {
                    let resolved = {
                        let scope = app.scope.clone();
                        let dir = directory.clone().unwrap();
                        tokio::task::spawn_blocking(move || {
                            let physical = crate::files::paths::canonical(&scope, &*dir)?;
                            // Use `directory_identity` (stat-only on Unix) so a replaced FIFO
                            // never blocks a worker thread on open().
                            let identity = crate::files::directory_identity(&physical).ok()?;
                            Some((physical, identity))
                        })
                        .await
                        .ok()
                        .flatten()
                    };
                    if let Some((physical, identity)) = resolved
                        && let Some(proof) =
                            crate::worktrees::ownership::capture_event_directory(app, &workspace, &endpoint, &physical)
                                .await
                    {
                        inbox_proof = Some((physical, identity, proof));
                        true
                    } else {
                        false
                    }
                } else {
                    crate::worktrees::owns_event(app, &workspace, dir).await
                        || (receipt_event
                            && crate::worktrees::ownership::owns_loaded(app, &workspace, &endpoint, dir).await)
                }
            } else {
                true
            };
            if crate::worktrees::event_inventory_revision(app, workspace.id) != rev {
                continue;
            }
            if !owned {
                break;
            }
            if inbox {
                let Some((physical, identity, proof)) = inbox_proof else { break };
                let scope = app.scope.clone();
                let Some(dir) = directory.clone() else { break };
                let still_live = tokio::task::spawn_blocking(move || {
                    crate::files::paths::canonical(&scope, &*dir).as_ref() == Some(&physical)
                        && crate::files::directory_identity(&physical).ok().as_ref() == Some(&identity)
                        && proof.live(&physical)
                })
                .await
                .unwrap_or(false);
                if crate::worktrees::event_inventory_revision(app, workspace.id) != rev {
                    continue;
                }
                if !still_live
                    || !crate::sessions::permission_mode::workspace_current(app, &workspace)
                    || !app.native.current(&endpoint)
                {
                    break;
                }
            } else if !app.native.current(&endpoint) || app.workspace(&workspace.id.to_string()).is_err() {
                break;
            }
            if let Some(sid) = session_id.as_deref() {
                let mut held = routes.held.lock().unwrap();
                if kind == "session.deleted" || kind == "session.moved" {
                    held.forget(sid, workspace.id);
                } else {
                    held.remember(sid, workspace.id);
                }
            }
            let envelope = json!({"type":"instance.event","instanceId":workspace.id,"event":&*event});
            app.emit(envelope);
            delivered = true;
            break;
        }
    }
    if delivered {
        let sid = session_id.as_deref().or(event["data"]["session"]["id"].as_str()).or(event["data"]["id"].as_str());
        let (took, sid) = (routed.elapsed().as_millis(), sid.unwrap_or("-"));
        crate::bench::route_trace(format_args!("event {kind} {took}ms to 1 at {received} sid {sid}"));
        if crate::sessions::receipts::observe(app, &endpoint, &event, std::slice::from_ref(&workspace)).await.is_err() {
            eprintln!("Permission receipt persistence unavailable");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_recipients_follow_the_reference_bound() {
        let mut held = Held::default();
        let w = Uuid::new_v4();
        for i in 0..=SESSION_RECIPIENT_LIMIT {
            held.remember(&format!("ses_{i}"), w);
        }
        assert!(!held.has("ses_0", w), "oldest session evicted");
        assert!(held.has(&format!("ses_{SESSION_RECIPIENT_LIMIT}"), w));
        assert_eq!(held.sessions.len(), SESSION_RECIPIENT_LIMIT);
        held.forget(&format!("ses_{SESSION_RECIPIENT_LIMIT}"), w);
        assert!(!held.has(&format!("ses_{SESSION_RECIPIENT_LIMIT}"), w));
        assert_eq!(held.order.len(), held.sessions.len());
    }

    #[test]
    fn lanes_follow_the_reference_event_keys() {
        let key = |event: Value| lane(&event);
        assert_eq!(key(json!({"type":"session.text.delta","data":{"sessionID":"ses_a"}})), "session:ses_a");
        assert_eq!(key(json!({"type":"form.created","data":{"form":{"sessionID":"ses_a"}}})), "session:ses_a");
        assert_eq!(key(json!({"type":"pty.updated","data":{"info":{"id":"pty_1"}}})), "pty:pty_1");
        assert_eq!(key(json!({"type":"shell.created","data":{"id":"sh_1"}})), "shell:sh_1");
        let located =
            |dir: &str| json!({"type":"file.edited","location":{"directory":dir},"data":{"sessionID":"global"}});
        assert_eq!(key(located("/a")), key(located("/a")));
        assert_ne!(key(located("/a")), key(located("/b")));
    }

    #[test]
    fn located_events_feed_the_session_location_cache_until_a_move() {
        let routes = Routes::default();
        let gen0 = routes.reset_locations();
        let at = |dir: &str| json!({"location":{"directory":dir}});
        let dir = |s: &str| Some(CachedLocation::Directory(s.to_owned()));
        assert_eq!(routes.location(gen0, "session.execution.started", Some("ses_a"), &json!({})), None);
        assert_eq!(routes.location(gen0, "session.text.delta", Some("ses_a"), &at("/w")), dir("/w"));
        assert_eq!(routes.location(gen0, "session.usage.updated", Some("ses_a"), &json!({})), dir("/w"));
        let scoped = json!({"location":{"directory":"/remote","workspaceID":"x"}});
        assert_eq!(
            routes.location(gen0, "session.text.delta", Some("ses_b"), &scoped),
            Some(CachedLocation::ForeignWorkspace)
        );
        assert_eq!(
            routes.location(gen0, "session.usage.updated", Some("ses_b"), &json!({})),
            Some(CachedLocation::ForeignWorkspace),
            "a scoped location is remembered as foreign rather than routed locally"
        );
        assert_eq!(routes.location(gen0, "session.moved", Some("ses_a"), &at("/w")), dir("/w"));
        assert_eq!(
            routes.location(gen0, "session.usage.updated", Some("ses_a"), &json!({})),
            None,
            "a move forgets the location"
        );
        routes.learn(gen0, "ses_a", CachedLocation::Directory("/v".to_owned()));
        routes.locations.lock().unwrap().1.get_mut("ses_a").unwrap().0 = Instant::now() - Duration::from_millis(1);
        assert_eq!(
            routes.location(gen0, "session.usage.updated", Some("ses_a"), &json!({})),
            None,
            "expired after 2 s"
        );
        let gen1 = routes.reset_locations();
        routes.learn(gen0, "ses_a", CachedLocation::Directory("/stale".to_owned()));
        assert_eq!(
            routes.location(gen1, "session.usage.updated", Some("ses_a"), &json!({})),
            None,
            "stale subscription worker cannot repopulate locations after reconnect"
        );
    }

    #[test]
    fn integration_event_filter_sanitizes_rpc_and_preserves_integration_updated() {
        assert!(GLOBAL.split_whitespace().any(|kind| kind == "integration.updated"));
        let updated = json!({"type": "integration.updated", "data": {"id": "app-1"}});
        assert_eq!(integration_event_for_relay(updated.clone()), IntegrationRelay::Relay(updated));

        let allowed = json!({
            "type": "rpc.neuralnomads.my-app1.status_changed",
            "location": {"directory": "/repo", "extra": "secret"},
            "data": {"token": "do-not-leak", "nested": [1, 2]}
        });
        assert_eq!(
            integration_event_for_relay(allowed),
            IntegrationRelay::Relay(json!({
                "type": "rpc.neuralnomads.my-app1.status_changed",
                "location": {"directory": "/repo"},
                "data": {}
            }))
        );

        let hosts_with_ws = json!({
            "type": "rpc.neuralnomads.a.hosts_changed",
            "location": {"directory": "/repo", "workspaceID": "ws_remote", "extra": true},
            "data": {"hosts": ["internal"]}
        });
        assert_eq!(
            integration_event_for_relay(hosts_with_ws),
            IntegrationRelay::Relay(json!({
                "type": "rpc.neuralnomads.a.hosts_changed",
                "location": {"directory": "/repo", "workspaceID": "ws_remote"},
                "data": {}
            }))
        );

        for dropped in [
            json!({"type": "rpc.neuralnomads.my-app.other_event", "location": {"directory": "/repo"}, "data": {}}),
            json!({"type": "rpc.neuralnomads.BadApp.status_changed", "location": {"directory": "/repo"}, "data": {}}),
            json!({"type": "rpc.neuralnomads.9app.status_changed", "location": {"directory": "/repo"}, "data": {}}),
            json!({"type": "rpc.neuralnomads.my-app.status_changed", "data": {}}),
            json!({"type": "rpc.neuralnomads.my-app.status_changed", "location": null, "data": {}}),
        ] {
            assert_eq!(
                integration_event_for_relay(dropped.clone()),
                IntegrationRelay::Drop,
                "expected drop for {dropped}"
            );
        }

        for malformed in [
            json!({"type": "rpc.neuralnomads.my-app.status_changed", "location": {"workspaceID": "w"}, "data": {}}),
            json!({"type": "rpc.neuralnomads.my-app.status_changed", "location": {"directory": "   "}, "data": {}}),
            json!({"type": "rpc.neuralnomads.my-app.status_changed", "location": {"directory": 123}, "data": {}}),
            json!({"type": "rpc.neuralnomads.my-app.status_changed", "location": {"directory": "/repo", "workspaceID": null}, "data": {}}),
            json!({"type": "rpc.neuralnomads.my-app.status_changed", "location": {"directory": "/repo", "workspaceID": ""}, "data": {}}),
            json!({"type": "rpc.neuralnomads.my-app.status_changed", "location": ["/repo"], "data": {}}),
        ] {
            assert_eq!(
                integration_event_for_relay(malformed.clone()),
                IntegrationRelay::Malformed,
                "expected malformed for {malformed}"
            );
        }
    }
}
