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
/// A PTY/shell/form entity's location from its last located event or `info.cwd` (TS `ptyLocations`/`shellLocations`/`formLocations`).
const ENTITY_LOCATION_TTL: Duration = Duration::from_secs(60);
const ENTITY_LOCATION_LIMIT: usize = 1024;
/// Per-workspace resync pulse backoff when routing fails (TS `ROUTING_RESYNC_{MIN,MAX}_MS`).
const ROUTING_RESYNC_MIN: Duration = Duration::from_secs(1);
const ROUTING_RESYNC_MAX: Duration = Duration::from_secs(30);

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

fn status(app: &App, next: &'static str, reason: Option<&str>) -> u64 {
    let mut store = app.inner.lock().unwrap();
    if next == "connecting" {
        store.generation += 1;
    }
    store.status = next;
    for w in &store.workspaces {
        app.emit_status(w.id, next, store.generation, reason);
    }
    store.generation
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

struct ResyncState {
    next: Instant,
    interval: Duration,
    timer: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
struct EntityLocations {
    order: VecDeque<String>,
    entries: HashMap<String, (Instant, CachedLocation)>,
}

impl EntityLocations {
    fn get(&mut self, id: &str, now: Instant) -> Option<CachedLocation> {
        match self.entries.get(id) {
            Some((until, loc)) if *until > now => Some(loc.clone()),
            Some(_) => {
                self.remove(id);
                None
            }
            None => None,
        }
    }

    fn insert(&mut self, id: &str, loc: CachedLocation, now: Instant) {
        if !self.entries.contains_key(id) {
            while self.entries.len() >= ENTITY_LOCATION_LIMIT {
                if let Some(oldest) = self.order.pop_front() {
                    self.entries.remove(&oldest);
                } else {
                    break;
                }
            }
            self.order.push_back(id.to_owned());
        }
        self.entries.insert(id.to_owned(), (now + ENTITY_LOCATION_TTL, loc));
    }

    fn remove(&mut self, id: &str) {
        if self.entries.remove(id).is_some() {
            self.order.retain(|k| k != id);
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }
}

#[derive(Default)]
struct LocationCaches {
    sessions: HashMap<String, (Instant, CachedLocation)>,
    pty: EntityLocations,
    shell: EntityLocations,
    form: EntityLocations,
}

impl LocationCaches {
    fn clear(&mut self) {
        self.sessions.clear();
        self.pty.clear();
        self.shell.clear();
        self.form.clear();
    }
}

fn pty_id<'a>(kind: &str, data: &'a Value) -> Option<&'a str> {
    if !kind.starts_with("pty.") {
        return None;
    }
    data["id"].as_str().or(data["info"]["id"].as_str()).filter(|s| !s.is_empty())
}

fn shell_id<'a>(kind: &str, data: &'a Value) -> Option<&'a str> {
    if !kind.starts_with("shell.") {
        return None;
    }
    data["id"].as_str().or(data["info"]["id"].as_str()).filter(|s| !s.is_empty())
}

fn form_id<'a>(kind: &str, data: &'a Value) -> Option<&'a str> {
    if !kind.starts_with("form.") {
        return None;
    }
    data["id"].as_str().or(data["form"]["id"].as_str()).filter(|s| !s.is_empty())
}

fn pty_info_location(kind: &str, data: &Value) -> Option<CachedLocation> {
    if !matches!(kind, "pty.created" | "pty.updated") {
        return None;
    }
    data["info"]["cwd"].as_str().filter(|s| !s.is_empty()).map(|dir| CachedLocation::Directory(dir.to_owned()))
}

fn shell_info_location(kind: &str, data: &Value) -> Option<CachedLocation> {
    if kind != "shell.created" {
        return None;
    }
    data["info"]["cwd"].as_str().filter(|s| !s.is_empty()).map(|dir| CachedLocation::Directory(dir.to_owned()))
}

#[derive(Default)]
struct Routes {
    held: Mutex<Held>,
    locations: Mutex<(u64, LocationCaches)>,
    resyncs: Mutex<(u64, HashMap<Uuid, ResyncState>)>,
}

impl Routes {
    /// Clears cached session directories for a new SSE subscription while preserving `held`
    /// recipients (so `session.moved` after reconnect still notifies the old workspace, TS
    /// `instance-events.ts:143-147, 282-309`) and bumps the generation so late workers from an
    /// earlier subscription cannot repopulate stale locations.
    fn reset_locations(&self) -> u64 {
        {
            let mut resyncs = self.resyncs.lock().unwrap();
            resyncs.0 = resyncs.0.wrapping_add(1);
            for (_, state) in resyncs.1.drain() {
                if let Some(handle) = state.timer {
                    handle.abort();
                }
            }
        }
        let mut guard = self.locations.lock().unwrap();
        guard.0 = guard.0.wrapping_add(1);
        guard.1.clear();
        guard.0
    }

    fn pulse_routing_resync(app: &App, workspace_id: Uuid, app_generation: u64) {
        let store = app.inner.lock().unwrap();
        if store.status != "connected"
            || store.generation != app_generation
            || !store.workspaces.iter().any(|w| w.id == workspace_id)
        {
            return;
        }
        app.emit_status(workspace_id, "error", app_generation, Some("event routing failed"));
        app.emit_status(workspace_id, "connected", app_generation, None);
    }

    /// Pulses one workspace's status (`error`, then `connected`) so its clients run reconnect
    /// reconciliation for an event that could not be routed (TS `instance-events.ts:448-468`).
    fn request_routing_resync(self: &Arc<Self>, app: &Shared, workspace_id: Uuid, app_generation: u64) {
        {
            let store = app.inner.lock().unwrap();
            if store.status != "connected" || store.generation != app_generation {
                return;
            }
        }
        let now = Instant::now();
        let immediate = {
            let mut resyncs = self.resyncs.lock().unwrap();
            let resync_gen = resyncs.0;
            match resyncs.1.get_mut(&workspace_id) {
                Some(state) if state.timer.is_some() => return,
                Some(state) if now < state.next => {
                    let wait = state.next.saturating_duration_since(now);
                    let next_interval = (state.interval * 2).min(ROUTING_RESYNC_MAX);
                    let routes = Arc::clone(self);
                    let app = Arc::clone(app);
                    state.timer = Some(tokio::spawn(async move {
                        tokio::time::sleep(wait).await;
                        {
                            let mut guard = routes.resyncs.lock().unwrap();
                            if guard.0 != resync_gen {
                                return;
                            }
                            guard.1.insert(
                                workspace_id,
                                ResyncState {
                                    next: Instant::now() + next_interval,
                                    interval: next_interval,
                                    timer: None,
                                },
                            );
                        }
                        Self::pulse_routing_resync(&app, workspace_id, app_generation);
                    }));
                    false
                }
                _ => {
                    resyncs.1.insert(
                        workspace_id,
                        ResyncState { next: now + ROUTING_RESYNC_MIN, interval: ROUTING_RESYNC_MIN, timer: None },
                    );
                    true
                }
            }
        };
        if immediate {
            Self::pulse_routing_resync(app, workspace_id, app_generation);
        }
    }

    /// An unresolvable session event pulses the recipients it reached before, or every open
    /// workspace when it reached none (TS `instance-events.ts:418-426`).
    fn request_session_resync(self: &Arc<Self>, app: &Shared, session_id: &str, app_generation: u64) {
        let known = self.held.lock().unwrap().sessions.get(session_id).cloned();
        let open: Vec<Uuid> = app.inner.lock().unwrap().workspaces.iter().map(|w| w.id).collect();
        for id in open {
            if known.as_ref().is_none_or(|set| set.contains(&id)) {
                self.request_routing_resync(app, id, app_generation);
            }
        }
    }
    /// The location an event is routed by: its envelope's, else cached PTY/shell/form/session
    /// locations or `info.cwd` fallbacks. Preserves native `workspaceID` selectors so events for
    /// foreign workspaces are never delivered to local workspaces (TS `instance-events.ts:288-324`).
    fn location(&self, generation: u64, kind: &str, session: Option<&str>, event: &Value) -> Option<CachedLocation> {
        let data = &event["data"];
        let located = if event["location"].get("workspaceID").is_some() {
            Some(CachedLocation::ForeignWorkspace)
        } else {
            event["location"]["directory"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|dir| CachedLocation::Directory(dir.to_owned()))
        };
        let pty = pty_id(kind, data);
        let shell = shell_id(kind, data);
        let form = form_id(kind, data);
        if session.is_none() && pty.is_none() && shell.is_none() && form.is_none() {
            return located;
        }
        let mut guard = self.locations.lock().unwrap();
        if guard.0 != generation {
            return located.or_else(|| pty_info_location(kind, data)).or_else(|| shell_info_location(kind, data));
        }
        let caches = &mut guard.1;
        let now = Instant::now();
        if let Some(sid) = session
            && matches!(kind, "session.moved" | "session.deleted")
        {
            caches.sessions.remove(sid);
        }
        let resolved = located
            .or_else(|| pty.and_then(|id| caches.pty.get(id, now)))
            .or_else(|| pty_info_location(kind, data))
            .or_else(|| shell.and_then(|id| caches.shell.get(id, now)))
            .or_else(|| shell_info_location(kind, data))
            .or_else(|| form.and_then(|id| caches.form.get(id, now)))
            .or_else(|| {
                session.filter(|_| !matches!(kind, "session.moved" | "session.deleted")).and_then(|sid| {
                    caches.sessions.get(sid).filter(|(until, _)| *until > now).map(|(_, loc)| loc.clone())
                })
            });
        if let Some(loc) = &resolved {
            if let Some(sid) = session
                && !matches!(kind, "session.moved" | "session.deleted")
            {
                Self::cache(&mut caches.sessions, sid, loc.clone(), now);
            }
            if let Some(id) = pty {
                if kind == "pty.deleted" {
                    caches.pty.remove(id);
                } else {
                    caches.pty.insert(id, loc.clone(), now);
                }
            }
            if let Some(id) = shell {
                if kind == "shell.deleted" {
                    caches.shell.remove(id);
                } else {
                    caches.shell.insert(id, loc.clone(), now);
                }
            }
            if let Some(id) = form {
                if matches!(kind, "form.cancelled" | "form.replied") {
                    caches.form.remove(id);
                } else {
                    caches.form.insert(id, loc.clone(), now);
                }
            }
        }
        resolved
    }
    fn learn(&self, generation: u64, session: &str, loc: CachedLocation) {
        let mut guard = self.locations.lock().unwrap();
        if guard.0 == generation {
            Self::cache(&mut guard.1.sessions, session, loc, Instant::now());
        }
    }
    fn learn_form(&self, generation: u64, kind: &str, form: &str, loc: CachedLocation) {
        let mut guard = self.locations.lock().unwrap();
        if guard.0 == generation {
            if matches!(kind, "form.cancelled" | "form.replied") {
                guard.1.form.remove(form);
            } else {
                guard.1.form.insert(form, loc, Instant::now());
            }
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

/// FIFO key of a native event (TS `eventKey`): its session, PTY, shell or form, else its location.
fn lane(event: &Value) -> String {
    let (kind, data) = (event["type"].as_str().unwrap_or_default(), &event["data"]);
    data["sessionID"]
        .as_str()
        .or(data["form"]["sessionID"].as_str().filter(|_| kind == "form.created"))
        .filter(|s| !s.is_empty() && *s != "global")
        .map(|s| format!("session:{s}"))
        .or_else(|| pty_id(kind, data).map(|id| format!("pty:{id}")))
        .or_else(|| shell_id(kind, data).map(|id| format!("shell:{id}")))
        .or_else(|| form_id(kind, data).map(|id| format!("form:{id}")))
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
        app_generation: u64,
    },
    Deliver {
        workspace: crate::Workspace,
        event: Arc<Value>,
        endpoint: Arc<crate::opencode::Endpoint>,
        received: (Instant, i64),
        directory: Option<Arc<str>>,
        foreign_workspace: bool,
        session_id: Option<Arc<str>>,
        app_generation: u64,
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
    #[allow(clippy::too_many_arguments)]
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
        app_generation: u64,
    ) -> bool {
        if self.bytes.fetch_add(bytes, Relaxed) + bytes > ROUTING_BYTES {
            self.bytes.fetch_sub(bytes, Relaxed);
            return false;
        }
        let lease = Arc::new(BytesLease { lanes: Arc::downgrade(self), bytes });
        let job = Job {
            received_at: received.0,
            lease,
            work: JobWork::Route {
                lane_key: key.clone(),
                event: Arc::new(event),
                endpoint,
                received,
                generation,
                app_generation,
            },
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
                        JobWork::Route { lane_key, event, endpoint, received, generation, app_generation } => {
                            route(
                                &app,
                                &routes,
                                &self,
                                lane_key,
                                event,
                                endpoint,
                                received,
                                generation,
                                app_generation,
                                job.lease,
                            )
                            .await;
                        }
                        JobWork::Deliver {
                            workspace,
                            event,
                            endpoint,
                            received,
                            directory,
                            foreign_workspace,
                            session_id,
                            app_generation,
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
                                app_generation,
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
        let app_generation = status(&app, "connecting", None);
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
                if !lanes.enqueue_root(
                    &app,
                    &routes,
                    key,
                    bytes,
                    event,
                    endpoint.clone(),
                    received,
                    generation,
                    app_generation,
                ) {
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

enum SessionLocationLookup {
    Found(CachedLocation),
    Missing,
    Unresolved,
}

async fn resolve_session_location(
    app: &App,
    endpoint: &Arc<crate::opencode::Endpoint>,
    session: &str,
) -> SessionLocationLookup {
    let to_loc = |found: Option<String>| match found {
        Some(dir) => CachedLocation::Directory(dir),
        None => CachedLocation::ForeignWorkspace,
    };
    match crate::opencode::session_location_at(app, endpoint, session).await {
        Ok(found) => SessionLocationLookup::Found(to_loc(found)),
        Err((axum::http::StatusCode::NOT_FOUND, _)) => SessionLocationLookup::Missing,
        Err(_) => {
            if !app.native.current(endpoint) {
                return SessionLocationLookup::Missing;
            }
            match crate::opencode::session_location_at(app, endpoint, session).await {
                Ok(found) => SessionLocationLookup::Found(to_loc(found)),
                Err((axum::http::StatusCode::NOT_FOUND, _)) => SessionLocationLookup::Missing,
                Err(_) => SessionLocationLookup::Unresolved,
            }
        }
    }
}

async fn check_event_ownership(
    app: &Shared,
    workspace: &crate::Workspace,
    endpoint: &Arc<crate::opencode::Endpoint>,
    directory: &str,
) -> crate::worktrees::EventOwnership {
    let first = crate::worktrees::event_ownership(app, workspace, endpoint, directory).await;
    if first != crate::worktrees::EventOwnership::Unavailable
        || !app.native.current(endpoint)
        || app.workspace(&workspace.id.to_string()).is_err()
    {
        return first;
    }
    crate::worktrees::event_ownership(app, workspace, endpoint, directory).await
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
    app_generation: u64,
    lease: Arc<BytesLease>,
) {
    let kind = event["type"].as_str().unwrap_or_default();
    let session = event["data"]["sessionID"]
        .as_str()
        .or_else(|| (kind == "form.created").then(|| event["data"]["form"]["sessionID"].as_str()).flatten())
        .filter(|s| *s != "global" && crate::opencode::valid_id(s));
    let form = form_id(kind, &event["data"]);
    let mut resolved = routes.location(generation, kind, session, &event);
    let mut unresolved_session = false;
    if resolved.is_none()
        && let Some(session) = session
    {
        match resolve_session_location(app, &endpoint, session).await {
            SessionLocationLookup::Found(loc) => {
                if kind != "session.deleted" {
                    routes.learn(generation, session, loc.clone());
                }
                if let Some(fid) = form {
                    routes.learn_form(generation, kind, fid, loc.clone());
                }
                resolved = Some(loc);
            }
            SessionLocationLookup::Missing => {}
            SessionLocationLookup::Unresolved => {
                unresolved_session = true;
            }
        }
    }
    let foreign_workspace = matches!(resolved, Some(CachedLocation::ForeignWorkspace));
    let directory: Option<Arc<str>> = match resolved {
        Some(CachedLocation::Directory(dir)) => Some(Arc::from(dir)),
        _ => None,
    };
    let session_id: Option<Arc<str>> = session.map(Arc::from);
    crate::sessions::favorites::deleted(app, &event);
    crate::sessions::cleanup::deleted(app, &event);
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
    let foreign_held_resync =
        !eligible && session_id.is_some() && (foreign_workspace || event["location"].get("workspaceID").is_some());
    if !eligible && !foreign_held_resync {
        if unresolved_session
            && let Some(sid) = session_id.as_deref()
            && app.native.current(&endpoint)
        {
            routes.request_session_resync(app, sid, app_generation);
        } else if session_id.is_none()
            && !foreign_workspace
            && event["location"].get("workspaceID").is_none()
            && (pty_id(kind, &event["data"]).is_some() || shell_id(kind, &event["data"]).is_some() || form.is_some())
            && app.native.current(&endpoint)
        {
            let open: Vec<Uuid> = app.inner.lock().unwrap().workspaces.iter().map(|w| w.id).collect();
            for wid in open {
                routes.request_routing_resync(app, wid, app_generation);
            }
        }
        return;
    }
    // Fan out onto per-(workspace, lane) delivery queues (matching TS `instance-events.ts:288-311`)
    // so a slow ownership check on one workspace never stalls subsequent deltas for another, and
    // foreign-workspace refusals stay strictly FIFO-ordered behind earlier local events of the lane.
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
                app_generation,
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
    routes: &Arc<Routes>,
    workspace: crate::Workspace,
    event: Arc<Value>,
    endpoint: Arc<crate::opencode::Endpoint>,
    (routed, received): (Instant, i64),
    directory: Option<Arc<str>>,
    foreign_workspace: bool,
    session_id: Option<Arc<str>>,
    app_generation: u64,
) {
    let kind = event["type"].as_str().unwrap_or_default();
    let inbox = kind.starts_with("session.inbox.");
    let receipt_event = matches!(kind, "permission.asked" | "permission.replied" | "session.deleted");
    let mut delivered = false;
    // Match TS `instance-events.ts:288-336`: resolve ownership for this workspace, retrying
    // whenever `worktree.updated` bumps `inventory_revision` while the route stays current
    // (bounded by the lane's `ROUTING_TIMEOUT`), and pulse a workspace resync when ownership
    // cannot be verified instead of dropping events silently.
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
            let mut lookup_failed = false;
            let source = match directory.as_deref() {
                Some(dir) if !foreign_workspace && event["location"].get("workspaceID").is_none() => {
                    match check_event_ownership(app, &workspace, &endpoint, dir).await {
                        crate::worktrees::EventOwnership::Owned => true,
                        crate::worktrees::EventOwnership::NotOwned => false,
                        crate::worktrees::EventOwnership::Unavailable => {
                            lookup_failed = true;
                            false
                        }
                    }
                }
                _ => false,
            };
            let owns_destination = match check_event_ownership(app, &workspace, &endpoint, &destination).await {
                crate::worktrees::EventOwnership::Owned => true,
                crate::worktrees::EventOwnership::NotOwned => false,
                crate::worktrees::EventOwnership::Unavailable => {
                    lookup_failed = true;
                    false
                }
            };
            if crate::worktrees::event_inventory_revision(app, workspace.id) != rev {
                continue;
            }
            if !app.native.current(&endpoint) || app.workspace(&workspace.id.to_string()).is_err() {
                break;
            }
            let send = {
                let store = app.inner.lock().unwrap();
                if store.status != "connected"
                    || store.generation != app_generation
                    || !store.workspaces.iter().any(|w| w.id == workspace.id)
                {
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
                send
            };
            if !send && lookup_failed {
                routes.request_routing_resync(app, workspace.id, app_generation);
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
            let mut lookup_failed = false;
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
                    if let Some((physical, identity)) = resolved {
                        let mut proof =
                            crate::worktrees::ownership::capture_event_directory(app, &workspace, &endpoint, &physical)
                                .await;
                        if proof.is_none() && app.native.current(&endpoint) {
                            match check_event_ownership(app, &workspace, &endpoint, dir).await {
                                crate::worktrees::EventOwnership::Owned => {
                                    proof = crate::worktrees::ownership::capture_event_directory(
                                        app, &workspace, &endpoint, &physical,
                                    )
                                    .await;
                                }
                                crate::worktrees::EventOwnership::Unavailable => {
                                    lookup_failed = true;
                                }
                                crate::worktrees::EventOwnership::NotOwned => {}
                            }
                        }
                        if let Some(proof) = proof {
                            inbox_proof = Some((physical, identity, proof));
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    match check_event_ownership(app, &workspace, &endpoint, dir).await {
                        crate::worktrees::EventOwnership::Owned => true,
                        crate::worktrees::EventOwnership::NotOwned => {
                            receipt_event
                                && crate::worktrees::ownership::owns_loaded(app, &workspace, &endpoint, dir).await
                        }
                        crate::worktrees::EventOwnership::Unavailable => {
                            lookup_failed = true;
                            receipt_event
                                && crate::worktrees::ownership::owns_loaded(app, &workspace, &endpoint, dir).await
                        }
                    }
                }
            } else {
                true
            };
            if crate::worktrees::event_inventory_revision(app, workspace.id) != rev {
                continue;
            }
            if !app.native.current(&endpoint) || app.workspace(&workspace.id.to_string()).is_err() {
                break;
            }
            if !owned {
                if lookup_failed
                    || (directory.is_some()
                        && session_id.as_deref().is_some_and(|sid| routes.held.lock().unwrap().has(sid, workspace.id)))
                {
                    routes.request_routing_resync(app, workspace.id, app_generation);
                }
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
                    if !still_live
                        && crate::sessions::permission_mode::workspace_current(app, &workspace)
                        && app.native.current(&endpoint)
                        && session_id.as_deref().is_some_and(|sid| routes.held.lock().unwrap().has(sid, workspace.id))
                    {
                        routes.request_routing_resync(app, workspace.id, app_generation);
                    }
                    break;
                }
            } else if !app.native.current(&endpoint) || app.workspace(&workspace.id.to_string()).is_err() {
                break;
            }
            {
                let store = app.inner.lock().unwrap();
                if store.status != "connected"
                    || store.generation != app_generation
                    || !store.workspaces.iter().any(|w| w.id == workspace.id)
                {
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
            }
            break;
        }
    } else if (foreign_workspace || event["location"].get("workspaceID").is_some())
        && let Some(sid) = session_id.as_deref()
        && app.native.current(&endpoint)
        && app.workspace(&workspace.id.to_string()).is_ok()
    {
        if routes.held.lock().unwrap().has(sid, workspace.id) {
            routes.request_routing_resync(app, workspace.id, app_generation);
        }
    }
    if delivered {
        app.provider_usage.accounts.observe_event(app, &endpoint, &event);
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
        routes.locations.lock().unwrap().1.sessions.get_mut("ses_a").unwrap().0 =
            Instant::now() - Duration::from_millis(1);
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
    fn pty_shell_and_form_locationless_events_cache_and_fallback_to_info_cwd() {
        let routes = Routes::default();
        let gen0 = routes.reset_locations();
        let dir = |s: &str| Some(CachedLocation::Directory(s.to_owned()));

        // PTY created without envelope location falls back to data.info.cwd and caches for exited/deleted.
        assert_eq!(
            routes.location(
                gen0,
                "pty.created",
                None,
                &json!({"type":"pty.created","data":{"info":{"id":"pty-1","cwd":"/repo-b"}}})
            ),
            dir("/repo-b")
        );
        assert_eq!(
            routes.location(gen0, "pty.exited", None, &json!({"type":"pty.exited","data":{"id":"pty-1","exitCode":0}})),
            dir("/repo-b")
        );
        assert_eq!(
            routes.location(gen0, "pty.deleted", None, &json!({"type":"pty.deleted","data":{"id":"pty-1"}})),
            dir("/repo-b")
        );
        assert_eq!(
            routes.location(gen0, "pty.exited", None, &json!({"type":"pty.exited","data":{"id":"pty-1"}})),
            None,
            "pty.deleted evicts cached location"
        );

        // Shell created without envelope location falls back to data.info.cwd and caches for exited/deleted.
        assert_eq!(
            routes.location(
                gen0,
                "shell.created",
                None,
                &json!({"type":"shell.created","data":{"info":{"id":"sh-1","cwd":"/repo-b"}}})
            ),
            dir("/repo-b")
        );
        assert_eq!(
            routes.location(gen0, "shell.exited", None, &json!({"type":"shell.exited","data":{"id":"sh-1","exit":0}})),
            dir("/repo-b")
        );
        assert_eq!(
            routes.location(gen0, "shell.deleted", None, &json!({"type":"shell.deleted","data":{"id":"sh-1"}})),
            dir("/repo-b")
        );
        assert_eq!(
            routes.location(gen0, "shell.exited", None, &json!({"type":"shell.exited","data":{"id":"sh-1"}})),
            None,
            "shell.deleted evicts cached location"
        );

        // Foreign workspaceID on located pty.created stays foreign even if follow-up pty.updated has local info.cwd.
        assert_eq!(
            routes.location(
                gen0,
                "pty.created",
                None,
                &json!({
                    "type":"pty.created",
                    "location":{"directory":"/repo","workspaceID":"ws_foreign"},
                    "data":{"info":{"id":"pty-f","cwd":"/repo"}}
                })
            ),
            Some(CachedLocation::ForeignWorkspace)
        );
        assert_eq!(
            routes.location(
                gen0,
                "pty.updated",
                None,
                &json!({"type":"pty.updated","data":{"info":{"id":"pty-f","cwd":"/repo/sub"}}})
            ),
            Some(CachedLocation::ForeignWorkspace)
        );
        assert_eq!(
            routes.location(gen0, "pty.deleted", None, &json!({"type":"pty.deleted","data":{"id":"pty-f"}})),
            Some(CachedLocation::ForeignWorkspace)
        );

        // Form location caches across locationless replied/cancelled and evicts on terminal event.
        assert_eq!(
            routes.location(
                gen0,
                "form.created",
                None,
                &json!({"type":"form.created","location":{"directory":"/repo"},"data":{"form":{"id":"frm-1","sessionID":"global"}}})
            ),
            dir("/repo")
        );
        assert_eq!(
            routes.location(gen0, "form.replied", None, &json!({"type":"form.replied","data":{"id":"frm-1"}})),
            dir("/repo")
        );
        assert_eq!(
            routes.location(gen0, "form.cancelled", None, &json!({"type":"form.cancelled","data":{"id":"frm-1"}})),
            None,
            "form.replied evicts cached form location"
        );
        assert_eq!(lane(&json!({"type":"form.replied","data":{"id":"frm-1"}})), "form:frm-1");

        // Reconnect resets all entity caches and FIFO bound caps entries at 1024.
        let mut bounded = EntityLocations::default();
        let now = Instant::now();
        for i in 0..=ENTITY_LOCATION_LIMIT {
            bounded.insert(&format!("sh-{i}"), CachedLocation::Directory("/repo".into()), now);
        }
        assert_eq!(bounded.entries.len(), ENTITY_LOCATION_LIMIT);
        assert_eq!(bounded.get("sh-0", now), None);
        assert_eq!(bounded.get(&format!("sh-{ENTITY_LOCATION_LIMIT}"), now), dir("/repo"));

        assert_eq!(
            routes.location(
                gen0,
                "shell.created",
                None,
                &json!({"type":"shell.created","data":{"info":{"id":"sh-keep","cwd":"/repo"}}})
            ),
            dir("/repo")
        );
        let gen1 = routes.reset_locations();
        assert_eq!(
            routes.location(gen1, "shell.exited", None, &json!({"type":"shell.exited","data":{"id":"sh-keep"}})),
            None,
            "reset_locations clears pty/shell/form caches"
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

    fn drain_hub(app: &App, sub: &crate::events::hub::Sub) -> Vec<Value> {
        let mut out = Vec::new();
        while let crate::events::hub::Next::Frame(text) = app.events.pop(sub) {
            out.push(serde_json::from_str(&text).unwrap());
        }
        out
    }

    fn build_bridge_test_app(
        dir: &std::path::Path,
        ws_root: &std::path::Path,
        native_addr: std::net::SocketAddr,
    ) -> (Shared, crate::Workspace) {
        let auth = crate::auth::Auth::new(crate::auth::Settings {
            username: "fixture".into(),
            password: None,
            file: None,
            cookie: "fixture".into(),
            token: false,
            managed_local: false,
            skip: true,
            idle: Duration::from_secs(60),
            absolute: Duration::from_secs(60),
        })
        .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
            dir.join("config.yaml").to_str().unwrap(),
        ));
        let native = crate::opencode::Native::test_connection(native_addr);
        let app = Arc::new(App::new(
            auth,
            0,
            dir.to_path_buf(),
            dir.to_path_buf(),
            false,
            settings,
            Value::Null,
            native,
            std::path::PathBuf::new(),
            None,
            crate::files::watch::Watches::new(tx),
            None,
        ));
        let ws = crate::Workspace {
            id: Uuid::new_v4(),
            request_id: None,
            path: ws_root.to_path_buf(),
            name: None,
            status: "running",
            proxy_path: "/workspaces/test/instance".into(),
            binary_id: std::path::PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            location: json!({"directory": ws_root}),
            temporary: None,
        };
        {
            let mut inner = app.inner.lock().unwrap();
            inner.status = "connected";
            inner.generation = 1;
            inner.workspaces.push(ws.clone());
        }
        (app, ws)
    }

    #[tokio::test]
    async fn session_location_retries_once_on_transient_error_and_resyncs_on_persistent_failure() {
        use axum::{Json, Router, extract::Request, http::StatusCode, response::IntoResponse, routing::any};
        use std::sync::atomic::AtomicUsize;

        #[derive(Clone)]
        struct Stub {
            root: String,
            retry_calls: Arc<AtomicUsize>,
            fail_calls: Arc<AtomicUsize>,
            gone_calls: Arc<AtomicUsize>,
        }

        async fn fake_native(
            axum::extract::State(st): axum::extract::State<Stub>,
            req: Request,
        ) -> axum::response::Response {
            match req.uri().path() {
                "/api/session/ses_retry" => {
                    let n = st.retry_calls.fetch_add(1, Relaxed);
                    if n == 0 {
                        StatusCode::INTERNAL_SERVER_ERROR.into_response()
                    } else {
                        Json(json!({"data": {"id": "ses_retry", "location": {"directory": st.root}}})).into_response()
                    }
                }
                "/api/session/ses_fail" => {
                    st.fail_calls.fetch_add(1, Relaxed);
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
                "/api/session/ses_gone" => {
                    st.gone_calls.fetch_add(1, Relaxed);
                    (
                        StatusCode::NOT_FOUND,
                        Json(json!({"_tag": "SessionNotFoundError", "sessionID": "ses_gone", "message": "Session not found"})),
                    )
                        .into_response()
                }
                _ => StatusCode::NOT_FOUND.into_response(),
            }
        }

        let dir = crate::shared::test_dir("bridge-m7-session-location");
        let ws_root = dir.join("project");
        std::fs::create_dir_all(&ws_root).unwrap();
        let ws_root = dunce::canonicalize(&ws_root).unwrap();
        let root_str = ws_root.to_string_lossy().into_owned();

        let retry_calls = Arc::new(AtomicUsize::new(0));
        let fail_calls = Arc::new(AtomicUsize::new(0));
        let gone_calls = Arc::new(AtomicUsize::new(0));
        let stub = Stub {
            root: root_str,
            retry_calls: Arc::clone(&retry_calls),
            fail_calls: Arc::clone(&fail_calls),
            gone_calls: Arc::clone(&gone_calls),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let http = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(any(fake_native)).with_state(stub)).await.unwrap()
        });

        let (app, ws) = build_bridge_test_app(&dir, &ws_root, addr);
        let app_gen = app.inner.lock().unwrap().generation;
        let endpoint = app.native.endpoint().unwrap();
        let routes = Arc::new(Routes::default());
        let lanes = Arc::new(Lanes::default());
        let generation = routes.reset_locations();
        let sub = app.events.subscribe();

        // 1. Transient 500 on first lookup succeeds on retry and delivers the event.
        let lease = Arc::new(BytesLease { lanes: Arc::downgrade(&lanes), bytes: 0 });
        route(
            &app,
            &routes,
            &lanes,
            "session:ses_retry".into(),
            Arc::new(json!({"type": "session.text.delta", "data": {"sessionID": "ses_retry", "delta": "ok"}})),
            Arc::clone(&endpoint),
            (Instant::now(), 1),
            generation,
            app_gen,
            lease,
        )
        .await;
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(retry_calls.load(Relaxed), 2, "transient failure must retry once");
        let frames = drain_hub(&app, &sub);
        assert!(
            frames.iter().any(|f| f["type"] == "instance.event" && f["event"]["data"]["sessionID"] == "ses_retry"),
            "retried session event must be delivered: {frames:?}"
        );

        // 2. Definite 404 does NOT retry and does NOT pulse resync.
        let lease = Arc::new(BytesLease { lanes: Arc::downgrade(&lanes), bytes: 0 });
        route(
            &app,
            &routes,
            &lanes,
            "session:ses_gone".into(),
            Arc::new(json!({"type": "session.text.delta", "data": {"sessionID": "ses_gone", "delta": "x"}})),
            Arc::clone(&endpoint),
            (Instant::now(), 2),
            generation,
            app_gen,
            lease,
        )
        .await;
        assert_eq!(gone_calls.load(Relaxed), 1, "404 must not retry");
        assert!(drain_hub(&app, &sub).is_empty(), "404 must not pulse resync");

        // 3. Persistent 500 retries once then pulses resync (error -> connected) for the workspace.
        let lease = Arc::new(BytesLease { lanes: Arc::downgrade(&lanes), bytes: 0 });
        route(
            &app,
            &routes,
            &lanes,
            "session:ses_fail".into(),
            Arc::new(json!({"type": "session.text.delta", "data": {"sessionID": "ses_fail", "delta": "x"}})),
            Arc::clone(&endpoint),
            (Instant::now(), 3),
            generation,
            app_gen,
            lease,
        )
        .await;
        assert_eq!(fail_calls.load(Relaxed), 2, "persistent 500 must retry once");
        let resync_frames = drain_hub(&app, &sub);
        assert_eq!(resync_frames.len(), 2, "expected error+connected resync pulse: {resync_frames:?}");
        assert_eq!(resync_frames[0]["type"], "instance.eventStatus");
        assert_eq!(resync_frames[0]["instanceId"], ws.id.to_string());
        assert_eq!(resync_frames[0]["status"], "error");
        assert_eq!(resync_frames[0]["reason"], "event routing failed");
        assert_eq!(resync_frames[1]["type"], "instance.eventStatus");
        assert_eq!(resync_frames[1]["status"], "connected");

        let _ = routes.reset_locations();
        http.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn delivery_retries_unavailable_inventory_and_resyncs_when_unreadable_or_previously_held() {
        use axum::{Json, Router, extract::Request, http::StatusCode, response::IntoResponse, routing::any};
        use std::sync::atomic::AtomicUsize;

        let _serial = crate::git::test_git_serial().await;

        #[derive(Clone)]
        struct Stub {
            root: String,
            linked: String,
            mode: Arc<AtomicUsize>, // 0 = fail first /api/location then succeed, 1 = always 500
            loc_calls: Arc<AtomicUsize>,
        }

        async fn fake_native(
            axum::extract::State(st): axum::extract::State<Stub>,
            req: Request,
        ) -> axum::response::Response {
            match req.uri().path() {
                "/api/location" => {
                    let n = st.loc_calls.fetch_add(1, Relaxed);
                    let m = st.mode.load(Relaxed);
                    if m == 1 || (m == 0 && n == 0) {
                        StatusCode::INTERNAL_SERVER_ERROR.into_response()
                    } else {
                        Json(json!({
                            "directory": st.root,
                            "project": {"id": "prj_m7", "directory": st.root, "canonical": st.root}
                        }))
                        .into_response()
                    }
                }
                "/api/worktree" => Json(json!([{"directory": st.root}, {"directory": st.linked}])).into_response(),
                _ => StatusCode::NOT_FOUND.into_response(),
            }
        }

        let dir = crate::shared::test_dir("bridge-m7-delivery-resync");
        let root_dir = dir.join("main");
        let linked_dir = dir.join("linked");
        let foreign_dir = dir.join("foreign");
        std::fs::create_dir_all(&root_dir).unwrap();
        std::fs::create_dir_all(&foreign_dir).unwrap();
        let git = |p: &std::path::Path, args: &[&str]| {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(p)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .status()
                .unwrap();
            assert!(status.success(), "{args:?}");
        };
        git(&root_dir, &["init", "-q"]);
        git(&root_dir, &["config", "user.name", "test"]);
        git(&root_dir, &["config", "user.email", "test@example.com"]);
        git(&root_dir, &["commit", "--allow-empty", "-q", "-m", "init"]);
        git(&root_dir, &["worktree", "add", "--quiet", "--detach", linked_dir.to_str().unwrap()]);
        let root_dir = dunce::canonicalize(&root_dir).unwrap();
        let linked_dir = dunce::canonicalize(&linked_dir).unwrap();
        let foreign_dir = dunce::canonicalize(&foreign_dir).unwrap();

        let mode = Arc::new(AtomicUsize::new(0));
        let loc_calls = Arc::new(AtomicUsize::new(0));
        let stub = Stub {
            root: root_dir.to_string_lossy().into_owned(),
            linked: linked_dir.to_string_lossy().into_owned(),
            mode: Arc::clone(&mode),
            loc_calls: Arc::clone(&loc_calls),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let http = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(any(fake_native)).with_state(stub)).await.unwrap()
        });

        let (app, ws) = build_bridge_test_app(&dir, &root_dir, addr);
        let app_gen = app.inner.lock().unwrap().generation;
        let endpoint = app.native.endpoint().unwrap();
        let routes = Arc::new(Routes::default());
        let sub = app.events.subscribe();

        // 1. Transient 500 on first inventory lookup -> retries once -> delivers linked worktree event!
        deliver(
            &app,
            &routes,
            ws.clone(),
            Arc::new(json!({"type": "session.text.delta", "data": {"sessionID": "ses_wt", "delta": "hi"}})),
            Arc::clone(&endpoint),
            (Instant::now(), 1),
            Some(Arc::from(linked_dir.to_string_lossy().into_owned())),
            false,
            Some(Arc::from("ses_wt")),
            app_gen,
        )
        .await;
        assert_eq!(loc_calls.load(Relaxed), 2, "transient inventory error must retry once");
        let frames = drain_hub(&app, &sub);
        assert!(
            frames.iter().any(|f| f["type"] == "instance.event" && f["event"]["data"]["sessionID"] == "ses_wt"),
            "linked worktree event must be delivered after retry: {frames:?}"
        );

        // 2. Foreign directory for an unknown session is proven NotOwned -> silent drop (no resync).
        deliver(
            &app,
            &routes,
            ws.clone(),
            Arc::new(json!({"type": "session.text.delta", "data": {"sessionID": "ses_other", "delta": "x"}})),
            Arc::clone(&endpoint),
            (Instant::now(), 2),
            Some(Arc::from(foreign_dir.to_string_lossy().into_owned())),
            false,
            Some(Arc::from("ses_other")),
            app_gen,
        )
        .await;
        assert!(drain_hub(&app, &sub).is_empty(), "foreign unknown session must not pulse resync");

        // 3. Previously-held session (`ses_wt`) now refused without move -> pulses resync.
        deliver(
            &app,
            &routes,
            ws.clone(),
            Arc::new(json!({"type": "session.text.delta", "data": {"sessionID": "ses_wt", "delta": "x"}})),
            Arc::clone(&endpoint),
            (Instant::now(), 3),
            Some(Arc::from(foreign_dir.to_string_lossy().into_owned())),
            false,
            Some(Arc::from("ses_wt")),
            app_gen,
        )
        .await;
        let held_resync = drain_hub(&app, &sub);
        assert_eq!(held_resync.len(), 2, "previously held session refused must pulse resync: {held_resync:?}");
        assert_eq!(held_resync[0]["status"], "error");
        assert_eq!(held_resync[1]["status"], "connected");

        // 4. Persistent inventory failure on a fresh workspace/endpoint -> retries once & pulses resync.
        let unavail_calls = Arc::new(AtomicUsize::new(0));
        let unavail_stub = Stub {
            root: root_dir.to_string_lossy().into_owned(),
            linked: linked_dir.to_string_lossy().into_owned(),
            mode: Arc::new(AtomicUsize::new(1)),
            loc_calls: Arc::clone(&unavail_calls),
        };
        let unavail_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let unavail_addr = unavail_listener.local_addr().unwrap();
        let unavail_http = tokio::spawn(async move {
            axum::serve(unavail_listener, Router::new().fallback(any(fake_native)).with_state(unavail_stub))
                .await
                .unwrap()
        });
        let (unavail_app, unavail_ws) = build_bridge_test_app(&dir, &root_dir, unavail_addr);
        let unavail_app_gen = unavail_app.inner.lock().unwrap().generation;
        let unavail_endpoint = unavail_app.native.endpoint().unwrap();
        let unavail_routes = Arc::new(Routes::default());
        let unavail_sub = unavail_app.events.subscribe();
        deliver(
            &unavail_app,
            &unavail_routes,
            unavail_ws.clone(),
            Arc::new(json!({"type": "session.text.delta", "data": {"sessionID": "ses_unavail", "delta": "x"}})),
            Arc::clone(&unavail_endpoint),
            (Instant::now(), 4),
            Some(Arc::from(linked_dir.to_string_lossy().into_owned())),
            false,
            Some(Arc::from("ses_unavail")),
            unavail_app_gen,
        )
        .await;
        assert_eq!(unavail_calls.load(Relaxed), 2, "persistent unavailable inventory must retry once");
        let unavail_resync = drain_hub(&unavail_app, &unavail_sub);
        assert_eq!(unavail_resync.len(), 2, "unavailable inventory must pulse resync: {unavail_resync:?}");
        assert_eq!(unavail_resync[0]["status"], "error");
        assert_eq!(unavail_resync[1]["status"], "connected");
        let _ = unavail_routes.reset_locations();
        unavail_http.abort();

        // 5. `form.created` with `data.form.sessionID` followed IMMEDIATELY (no sleep!) by a foreign
        // `workspaceID` event on the same lane must stay FIFO-ordered so the foreign refusal sees the
        // newly recorded held recipient and pulses resync.
        let generation = routes.reset_locations();
        let lanes = Arc::new(Lanes::default());
        let lease1 = Arc::new(BytesLease { lanes: Arc::downgrade(&lanes), bytes: 0 });
        route(
            &app,
            &routes,
            &lanes,
            "session:ses_form".into(),
            Arc::new(json!({
                "type": "form.created",
                "location": {"directory": root_dir.to_string_lossy()},
                "data": {"form": {"id": "frm_1", "sessionID": "ses_form"}}
            })),
            Arc::clone(&endpoint),
            (Instant::now(), 5),
            generation,
            app_gen,
            lease1,
        )
        .await;
        let lease2 = Arc::new(BytesLease { lanes: Arc::downgrade(&lanes), bytes: 0 });
        route(
            &app,
            &routes,
            &lanes,
            "session:ses_form".into(),
            Arc::new(json!({
                "type": "session.text.delta",
                "location": {"directory": root_dir.to_string_lossy(), "workspaceID": "ws_remote"},
                "data": {"sessionID": "ses_form", "delta": "moved"}
            })),
            Arc::clone(&endpoint),
            (Instant::now(), 6),
            generation,
            app_gen,
            lease2,
        )
        .await;
        tokio::time::sleep(Duration::from_millis(80)).await;
        let fifo_frames = drain_hub(&app, &sub);
        assert_eq!(
            fifo_frames.len(),
            3,
            "expected form.created followed by error+connected resync in FIFO order: {fifo_frames:?}"
        );
        assert_eq!(fifo_frames[0]["type"], "instance.event");
        assert_eq!(fifo_frames[0]["event"]["type"], "form.created");
        assert_eq!(fifo_frames[1]["status"], "error");
        assert_eq!(fifo_frames[2]["status"], "connected");

        // 6a. After local SSE disconnect (`status = "error"`) BEFORE `connecting` bumps generation
        // (same endpoint, same `app_generation`), in-flight workers must not emit, resync, or mutate `held`.
        let err_gen = status(&app, "error", Some("Shared OpenCode event stream ended"));
        assert_eq!(err_gen, app_gen);
        let _ = drain_hub(&app, &sub);
        deliver(
            &app,
            &routes,
            ws.clone(),
            Arc::new(json!({"type": "session.text.delta", "data": {"sessionID": "ses_disc_local", "delta": "late"}})),
            Arc::clone(&endpoint),
            (Instant::now(), 7),
            Some(Arc::from(root_dir.to_string_lossy().into_owned())),
            false,
            Some(Arc::from("ses_disc_local")),
            app_gen,
        )
        .await;
        assert!(drain_hub(&app, &sub).is_empty(), "disconnected stream must not emit normal event");
        assert!(!routes.held.lock().unwrap().has("ses_disc_local", ws.id), "disconnected stream must not mutate held");
        deliver(
            &app,
            &routes,
            ws.clone(),
            Arc::new(json!({
                "type": "session.moved",
                "data": {"sessionID": "ses_disc_moved", "location": {"directory": root_dir.to_string_lossy()}}
            })),
            Arc::clone(&endpoint),
            (Instant::now(), 8),
            Some(Arc::from(foreign_dir.to_string_lossy().into_owned())),
            false,
            Some(Arc::from("ses_disc_moved")),
            app_gen,
        )
        .await;
        assert!(drain_hub(&app, &sub).is_empty(), "disconnected stream must not emit session.moved");
        assert!(!routes.held.lock().unwrap().has("ses_disc_moved", ws.id), "disconnected moved must not mutate held");

        // 6b. After SSE reconnect on the SAME endpoint (bumping app_generation), a stale worker
        // carrying the old `app_generation` must never emit resync pulses, emit native events,
        // or mutate `routes.held` on the new connection (including for `session.moved`).
        let _ = status(&app, "connecting", None);
        let live_gen = status(&app, "connected", None);
        assert_ne!(live_gen, app_gen);
        let _ = drain_hub(&app, &sub);
        let _ = routes.reset_locations();
        deliver(
            &app,
            &routes,
            ws.clone(),
            Arc::new(json!({"type": "session.text.delta", "data": {"sessionID": "ses_wt", "delta": "stale"}})),
            Arc::clone(&endpoint),
            (Instant::now(), 7),
            Some(Arc::from(foreign_dir.to_string_lossy().into_owned())),
            false,
            Some(Arc::from("ses_wt")),
            app_gen, // stale SSE generation!
        )
        .await;
        assert!(drain_hub(&app, &sub).is_empty(), "stale app_generation worker must not pulse resync");
        deliver(
            &app,
            &routes,
            ws.clone(),
            Arc::new(json!({"type": "session.text.delta", "data": {"sessionID": "ses_stale_local", "delta": "old"}})),
            Arc::clone(&endpoint),
            (Instant::now(), 8),
            Some(Arc::from(root_dir.to_string_lossy().into_owned())),
            false,
            Some(Arc::from("ses_stale_local")),
            app_gen, // stale SSE generation!
        )
        .await;
        assert!(drain_hub(&app, &sub).is_empty(), "stale app_generation worker must not emit normal event");
        assert!(!routes.held.lock().unwrap().has("ses_stale_local", ws.id), "stale worker must not mutate held");
        deliver(
            &app,
            &routes,
            ws.clone(),
            Arc::new(json!({
                "type": "session.moved",
                "data": {"sessionID": "ses_stale_moved", "location": {"directory": root_dir.to_string_lossy()}}
            })),
            Arc::clone(&endpoint),
            (Instant::now(), 9),
            Some(Arc::from(foreign_dir.to_string_lossy().into_owned())),
            false,
            Some(Arc::from("ses_stale_moved")),
            app_gen, // stale SSE generation!
        )
        .await;
        assert!(drain_hub(&app, &sub).is_empty(), "stale app_generation worker must not emit session.moved");
        assert!(
            !routes.held.lock().unwrap().has("ses_stale_moved", ws.id),
            "stale session.moved worker must not mutate held"
        );

        // 7. A pending trailing resync timer must NEVER publish `connected` after workspace stop.
        routes.request_routing_resync(&app, ws.id, live_gen); // leading pulse
        routes.request_routing_resync(&app, ws.id, live_gen); // arms trailing timer
        {
            let mut store = app.inner.lock().unwrap();
            let idx = store.workspaces.iter().position(|w| w.id == ws.id).unwrap();
            app.remove(&mut store, idx, false);
        }
        let _ = drain_hub(&app, &sub);
        Routes::pulse_routing_resync(&app, ws.id, live_gen);
        assert!(drain_hub(&app, &sub).is_empty(), "removed workspace must never receive late resync pulse");

        let _ = routes.reset_locations();
        http.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn pty_and_shell_locationless_events_deliver_to_owning_workspace_and_resync_unknown() {
        use axum::{Router, http::StatusCode, response::IntoResponse, routing::any};

        let dir = crate::shared::test_dir("bridge-m12-pty-shell");
        let ws_root = dir.join("project");
        let foreign_root = dir.join("foreign");
        std::fs::create_dir_all(&ws_root).unwrap();
        std::fs::create_dir_all(&foreign_root).unwrap();
        let ws_root = dunce::canonicalize(&ws_root).unwrap();
        let foreign_root = dunce::canonicalize(&foreign_root).unwrap();
        let root_str = ws_root.to_string_lossy().into_owned();
        let foreign_str = foreign_root.to_string_lossy().into_owned();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let http = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(any(|| async { StatusCode::NOT_FOUND.into_response() })))
                .await
                .unwrap()
        });

        let (app, ws) = build_bridge_test_app(&dir, &ws_root, addr);
        let app_gen = app.inner.lock().unwrap().generation;
        let endpoint = app.native.endpoint().unwrap();
        let routes = Arc::new(Routes::default());
        let lanes = Arc::new(Lanes::default());
        let generation = routes.reset_locations();
        let sub = app.events.subscribe();

        // 1. Locationless pty.created (with info.cwd) -> pty.exited -> pty.deleted all deliver to owning workspace.
        for (idx, ev) in [
            json!({"type": "pty.created", "data": {"info": {"id": "pty-1", "cwd": root_str}}}),
            json!({"type": "pty.exited", "data": {"id": "pty-1", "exitCode": 0}}),
            json!({"type": "pty.deleted", "data": {"id": "pty-1"}}),
            json!({"type": "shell.created", "data": {"info": {"id": "sh-1", "cwd": root_str}}}),
            json!({"type": "shell.exited", "data": {"id": "sh-1", "exit": 0}}),
            json!({"type": "shell.deleted", "data": {"id": "sh-1"}}),
            // Foreign cwd shell must NOT deliver to this workspace.
            json!({"type": "shell.created", "data": {"info": {"id": "sh-foreign", "cwd": foreign_str}}}),
            json!({"type": "shell.exited", "data": {"id": "sh-foreign", "exit": 0}}),
        ]
        .into_iter()
        .enumerate()
        {
            let key = lane(&ev);
            let lease = Arc::new(BytesLease { lanes: Arc::downgrade(&lanes), bytes: 0 });
            route(
                &app,
                &routes,
                &lanes,
                key,
                Arc::new(ev),
                Arc::clone(&endpoint),
                (Instant::now(), idx as i64),
                generation,
                app_gen,
                lease,
            )
            .await;
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
        let delivered = drain_hub(&app, &sub);
        let types: Vec<&str> = delivered
            .iter()
            .filter(|f| f["type"] == "instance.event" && f["instanceId"] == ws.id.to_string())
            .filter_map(|f| f["event"]["type"].as_str())
            .collect();
        let pty_types: Vec<&str> = types.iter().copied().filter(|t| t.starts_with("pty.")).collect();
        let shell_types: Vec<&str> = types.iter().copied().filter(|t| t.starts_with("shell.")).collect();
        assert_eq!(types.len(), 6, "unexpected events delivered: {types:?}");
        assert_eq!(pty_types, vec!["pty.created", "pty.exited", "pty.deleted"]);
        assert_eq!(shell_types, vec!["shell.created", "shell.exited", "shell.deleted"]);

        // 2. Uncached locationless shell.exited triggers a routing resync pulse instead of silent drop.
        let unknown = json!({"type": "shell.exited", "data": {"id": "sh-unknown", "exit": 1}});
        let lease = Arc::new(BytesLease { lanes: Arc::downgrade(&lanes), bytes: 0 });
        route(
            &app,
            &routes,
            &lanes,
            lane(&unknown),
            Arc::new(unknown),
            Arc::clone(&endpoint),
            (Instant::now(), 99),
            generation,
            app_gen,
            lease,
        )
        .await;
        let resync = drain_hub(&app, &sub);
        assert_eq!(resync.len(), 2, "unknown locationless shell event must pulse resync: {resync:?}");
        assert_eq!(resync[0]["status"], "error");
        assert_eq!(resync[1]["status"], "connected");

        let _ = routes.reset_locations();
        http.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
