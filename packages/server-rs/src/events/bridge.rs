//! Bridge from the daemon's event stream to the workspaces: one FIFO lane per session (or
//! location) so a slow ownership or location read never holds the others, as the TS
//! `InstanceEventQueue` does, with its budget and the reference's session location cache.
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    sync::{
        Arc, Mutex,
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

#[derive(Default)]
struct Routes {
    held: Mutex<Held>,
    locations: Mutex<(u64, HashMap<String, (Instant, String)>)>,
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
    /// The directory a session event is routed by: its envelope's, else a fresh cached one.
    /// Located events refresh the cache; a move or deletion clears it.
    fn directory(&self, generation: u64, kind: &str, session: Option<&str>, event: &Value) -> Option<String> {
        let located = event["location"]["directory"].as_str().map(str::to_owned);
        let Some(session) = session else { return located };
        let mut guard = self.locations.lock().unwrap();
        if guard.0 != generation {
            return located;
        }
        let cache = &mut guard.1;
        let now = Instant::now();
        if matches!(kind, "session.moved" | "session.deleted") || event["location"].get("workspaceID").is_some() {
            cache.remove(session);
        } else if let Some(dir) = &located {
            Self::cache(cache, session, dir, now);
        } else if located.is_none() {
            return cache.get(session).filter(|(until, _)| *until > now).map(|(_, dir)| dir.clone());
        }
        located
    }
    fn learn(&self, generation: u64, session: &str, dir: &str) {
        let mut guard = self.locations.lock().unwrap();
        if guard.0 == generation {
            Self::cache(&mut guard.1, session, dir, Instant::now());
        }
    }

    fn cache(cache: &mut HashMap<String, (Instant, String)>, session: &str, dir: &str, now: Instant) {
        if cache.len() >= SESSION_RECIPIENT_LIMIT && !cache.contains_key(session) {
            cache.retain(|_, (until, _)| *until > now);
            if cache.len() >= SESSION_RECIPIENT_LIMIT {
                return;
            }
        }
        cache.insert(session.to_owned(), (now + LOCATION_TTL, dir.to_owned()));
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

struct Job {
    event: Value,
    endpoint: Arc<crate::opencode::Endpoint>,
    received: (Instant, i64),
    bytes: usize,
    generation: u64,
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
    /// Queues `job` behind its lane, starting the lane when idle; false past the budget.
    fn enqueue(self: &Arc<Self>, app: &Shared, routes: &Arc<Routes>, key: String, job: Job) -> bool {
        if self.jobs.fetch_add(1, Relaxed) >= ROUTING_JOBS
            || self.bytes.fetch_add(job.bytes, Relaxed) + job.bytes > ROUTING_BYTES
        {
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
            let bytes = job.bytes;
            tokio::select! {
                biased;
                _ = self.failed.cancelled() => return,
                done = tokio::time::timeout(ROUTING_TIMEOUT.saturating_sub(job.received.0.elapsed()), route(&app, &routes, job)) => if done.is_err() {
                    return self.failed.cancel();
                },
            }
            self.jobs.fetch_sub(1, Relaxed);
            self.bytes.fetch_sub(bytes, Relaxed);
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
                let Some(Ok(mut event)) = next else { break };
                let Some(kind) = event["type"].as_str().map(str::to_owned) else { break };
                let received = (Instant::now(), now());
                if !connected {
                    if kind != "server.connected" {
                        keep_connection = true;
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
                // Integration events can contain backend-only data and need the TS sanitizer.
                if kind.starts_with("worktree.") || kind == "server.connected" {
                    if kind == "worktree.updated"
                        && let Some(project) =
                            event["data"]["projectID"].as_str().filter(|p| crate::opencode::valid_id(p))
                    {
                        crate::worktrees::linked::invalidate_project(&app, project);
                    } else {
                        crate::worktrees::linked::invalidate(&app);
                    }
                    lanes.receipts.schedule();
                }
                if kind == "session.deleted"
                    && let Some(id) = event["data"]["sessionID"].as_str()
                {
                    lanes.receipts.retire(id);
                }
                if matches!(kind.as_str(), "integration.updated" | "rpc") {
                    continue;
                }
                const SDK_FRAME_UNITS: usize = 16 * 1024 * 1024;
                let wire = event.to_string();
                let mut bytes = wire.len();
                if bytes > ROUTING_BYTES {
                    break;
                }
                if bytes > SDK_FRAME_UNITS && wire.encode_utf16().count() > SDK_FRAME_UNITS {
                    drop(wire);
                    // Matches TS `native-event-stream.ts:30-38`: an oversized upstream SSE event
                    // fails the stream and invalidates the shared connection (`keep_connection = false`).
                    let Some(files) = crate::sessions::user_files::projected_inbox_files(&event) else {
                        break;
                    };
                    event["data"]["item"]["payload"]["files"] = files;
                    let projected = event.to_string();
                    bytes = projected.len();
                    if bytes > SDK_FRAME_UNITS && projected.encode_utf16().count() > SDK_FRAME_UNITS {
                        break;
                    }
                }
                let job = Job { bytes, event, received, endpoint: endpoint.clone(), generation };
                if !lanes.enqueue(&app, &routes, lane(&job.event), job) {
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
        eprintln!("Shared OpenCode event stream disconnected: Shared OpenCode event stream ended");
        status(&app, "error", Some("Shared OpenCode event stream ended"));
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
}

async fn route(
    app: &Shared,
    routes: &Routes,
    Job { event, endpoint, received: (routed, received), generation, .. }: Job,
) {
    let kind = event["type"].as_str().unwrap_or_default();
    let inbox = kind.starts_with("session.inbox.");
    let receipt_event = matches!(kind, "permission.asked" | "permission.replied" | "session.deleted");
    let session = event["data"]["sessionID"]
        .as_str()
        .or_else(|| event["data"]["form"]["sessionID"].as_str())
        .filter(|s| crate::opencode::valid_id(s));
    let mut directory = routes.directory(generation, kind, session, &event);
    if directory.is_none()
        && let Some(session) = session
    {
        directory = crate::opencode::session_directory(app, session).await.ok();
        if let Some(dir) = directory.as_deref().filter(|_| kind != "session.deleted") {
            routes.learn(generation, session, dir);
        }
    }
    let candidates = {
        let store = app.inner.lock().unwrap();
        store
            .workspaces
            .iter()
            .filter(|workspace| {
                let native_dir = workspace.location["directory"].as_str().unwrap_or_default();
                directory.as_deref().map_or_else(
                    || GLOBAL.split(' ').any(|g| g == kind) || kind == "session.deleted",
                    |dir| dir == native_dir || Path::new(dir).starts_with(&app.scope) || receipt_event,
                ) && event["location"].get("workspaceID").is_none()
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    let session_id = event["data"]["sessionID"].as_str();
    let session_id = session_id.filter(|s| *s != "global" && crate::opencode::valid_id(s)).map(str::to_owned);
    let mut recipients = Vec::new();
    let mut inbox_proofs = HashMap::new();
    if kind == "session.moved"
        && let Some(sid) = session_id.as_deref()
        && let Some(destination) = event["data"]["location"]["directory"]
            .as_str()
            .filter(|_| event["data"]["location"].get("workspaceID").is_none())
            .map(str::to_owned)
    {
        // Like native location subscriptions, a move reaches the
        // source owner, earlier recipients and the destination owner.
        let all = app.inner.lock().unwrap().workspaces.clone();
        for workspace in all {
            let source = match directory.as_deref() {
                Some(dir) if event["location"].get("workspaceID").is_none() => {
                    crate::worktrees::owns_event(app, &workspace, dir).await
                }
                _ => false,
            };
            let owns_destination = crate::worktrees::owns_event(app, &workspace, &destination).await;
            let mut held = routes.held.lock().unwrap();
            if owns_destination {
                held.remember(sid, workspace.id);
            }
            if held.has(sid, workspace.id) || source || owns_destination {
                if !owns_destination {
                    held.forget(sid, workspace.id);
                }
                recipients.push(workspace);
            }
        }
    } else {
        for workspace in candidates {
            if let Some(dir) = directory.as_deref() {
                if inbox {
                    let Some(physical) = crate::files::paths::canonical(&app.scope, dir) else { continue };
                    let Ok(identity) = crate::files::host_identity(&physical) else { continue };
                    let Some(proof) = crate::worktrees::ownership::capture_directory(app, &workspace, &physical).await
                    else {
                        continue;
                    };
                    inbox_proofs.insert(workspace.id, (physical, identity, proof));
                } else if !crate::worktrees::owns_event(app, &workspace, dir).await
                    && !(receipt_event
                        && crate::worktrees::ownership::owns_loaded(app, &workspace, &endpoint, dir).await)
                {
                    continue;
                }
            }
            recipients.push(workspace);
        }
        if let Some(sid) = session_id.as_deref() {
            let mut held = routes.held.lock().unwrap();
            for workspace in &recipients {
                if kind == "session.deleted" || kind == "session.moved" {
                    held.forget(sid, workspace.id);
                } else {
                    held.remember(sid, workspace.id);
                }
            }
        }
    }
    for workspace in &recipients {
        let envelope = json!({"type":"instance.event","instanceId":workspace.id,"event":event});
        if inbox {
            let Some((physical, identity, proof)) = inbox_proofs.get(&workspace.id) else { continue };
            if !directory
                .as_deref()
                .is_some_and(|dir| crate::files::paths::canonical(&app.scope, dir).as_ref() == Some(physical))
                || !crate::sessions::permission_mode::workspace_current(app, workspace)
                || crate::files::host_identity(physical).ok().as_ref() != Some(identity)
                || !proof.live(physical)
                || !app.native.current(&endpoint)
            {
                continue;
            }
        } else if !app.native.current(&endpoint) || app.workspace(&workspace.id.to_string()).is_err() {
            continue;
        }
        app.emit(envelope);
    }
    let sid = session_id.as_deref().or(event["data"]["session"]["id"].as_str()).or(event["data"]["id"].as_str());
    let (took, count, sid) = (routed.elapsed().as_millis(), recipients.len(), sid.unwrap_or("-"));
    crate::bench::route_trace(format_args!("event {kind} {took}ms to {count} at {received} sid {sid}"));
    crate::sessions::favorites::deleted(app, &event);
    if crate::sessions::receipts::observe(app, &endpoint, &event, &recipients).await.is_err() {
        eprintln!("Permission receipt persistence unavailable");
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
        assert_eq!(routes.directory(gen0, "session.execution.started", Some("ses_a"), &json!({})), None);
        assert_eq!(routes.directory(gen0, "session.text.delta", Some("ses_a"), &at("/w")).as_deref(), Some("/w"));
        assert_eq!(routes.directory(gen0, "session.usage.updated", Some("ses_a"), &json!({})).as_deref(), Some("/w"));
        let scoped = json!({"location":{"directory":"/remote","workspaceID":"x"}});
        assert_eq!(routes.directory(gen0, "session.text.delta", Some("ses_b"), &scoped).as_deref(), Some("/remote"));
        assert_eq!(
            routes.directory(gen0, "session.usage.updated", Some("ses_b"), &json!({})),
            None,
            "a scoped location is not cached"
        );
        assert_eq!(routes.directory(gen0, "session.moved", Some("ses_a"), &at("/w")).as_deref(), Some("/w"));
        assert_eq!(
            routes.directory(gen0, "session.usage.updated", Some("ses_a"), &json!({})),
            None,
            "a move forgets the location"
        );
        routes.learn(gen0, "ses_a", "/v");
        routes.locations.lock().unwrap().1.get_mut("ses_a").unwrap().0 = Instant::now() - Duration::from_millis(1);
        assert_eq!(
            routes.directory(gen0, "session.usage.updated", Some("ses_a"), &json!({})),
            None,
            "expired after 2 s"
        );
        let gen1 = routes.reset_locations();
        routes.learn(gen0, "ses_a", "/stale");
        assert_eq!(
            routes.directory(gen1, "session.usage.updated", Some("ses_a"), &json!({})),
            None,
            "stale subscription worker cannot repopulate locations after reconnect"
        );
    }
}
