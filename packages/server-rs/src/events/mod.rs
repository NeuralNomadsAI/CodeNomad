//! `GET /api/events`: the UI's SSE stream (workspace, native and file events under a
//! shared byte budget), its pong keep-alive and the bridge from the daemon's stream.
mod upstream;

use std::{
    convert::Infallible,
    path::Path,
    time::{Duration, Instant},
};

use axum::{
    Extension, Json,
    extract::{Query, State, rejection::QueryRejection},
    http::StatusCode as Status,
    response::sse::{Event, Sse},
    routing::{get, post},
};
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{App, Error, Shared, error};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    client_id: String,
    connection_id: String,
}

impl Connection {
    fn validate(self) -> Result<(String, String), Error> {
        let (client, stream) = (self.client_id.trim(), self.connection_id.trim());
        if client.is_empty() || stream.is_empty() || client.len() > 256 || stream.len() > 256 {
            return Err(error(Status::BAD_REQUEST, "Invalid client connection"));
        }
        Ok((client.into(), stream.into()))
    }
}

pub struct Client {
    cancellation: CancellationToken,
    pong: Instant,
}
pub fn routes() -> axum::Router<Shared> {
    axum::Router::new().route("/api/events", get(connect)).route("/api/client-connections/pong", post(pong))
}

impl App {
    pub fn emit(&self, event: Value) {
        if self.events.receiver_count() == 0 {
            return;
        }
        let text = event.to_string();
        let frame = u32::try_from(text.capacity())
            .ok()
            .and_then(|size| self.event_budget.clone().try_acquire_many_owned(size).ok())
            .map(|permit| std::sync::Arc::new(Frame { text, _bytes: permit }));
        // A subscriber that cannot consume the shared byte budget must reconnect
        // and reconcile just like a receiver that lags the 128-frame ring.
        let _ = self.events.send(frame);
    }
    pub fn emit_status(&self, id: Uuid, status: &str, generation: u64, reason: Option<&str>) {
        let mut event = json!({"type":"instance.eventStatus","instanceId":id,"status":status,"generation":generation});
        if let Some(reason) = reason {
            event["reason"] = json!(reason);
        }
        self.emit(event);
    }
}

pub struct Frame {
    text: String,
    _bytes: tokio::sync::OwnedSemaphorePermit,
}

struct Guard(Shared, (String, String), CancellationToken);
impl Drop for Guard {
    fn drop(&mut self) {
        let mut store = self.0.inner.lock().unwrap();
        if !self.2.is_cancelled() {
            store.connections.remove(&self.1);
        }
    }
}

/// Event streams per principal (audit F3): the local UI and each paired
/// device have their own budget, and a connection key names its owner, so a
/// device can neither starve the local UI nor replace another client's stream.
pub const LOCAL_STREAMS: usize = 16;
pub const DEVICE_STREAMS: usize = 8;
fn owner(channel: Option<&crate::auth::tls::Channel>) -> String {
    match channel {
        None => "local".into(),
        Some(c) => match *c.principal.lock().unwrap() {
            Some(device) => device.to_string(),
            None => "unbound".into(),
        },
    }
}
fn owned_key(owner: &str, (client, stream): (String, String)) -> (String, String) {
    (format!("{owner}\0{client}"), stream)
}

pub async fn connect(
    State(app): State<Shared>,
    Extension(principal): Extension<crate::auth::Principal>,
    channel: Option<Extension<crate::auth::tls::Channel>>,
    query: Result<Query<Connection>, QueryRejection>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, Error> {
    let owner = owner(channel.as_ref().map(|c| &c.0));
    let key =
        owned_key(&owner, query.map_err(|_| error(Status::BAD_REQUEST, "Invalid client connection"))?.0.validate()?);
    let limit = if owner == "local" { LOCAL_STREAMS } else { DEVICE_STREAMS };
    let mut rx = app.events.subscribe();
    let cancel = CancellationToken::new();
    let mut inventory = app.inner.lock().unwrap();
    let prefix = format!("{owner}\0");
    let used = inventory.connections.keys().filter(|k| k.0.starts_with(&prefix)).count();
    if used >= limit && !inventory.connections.contains_key(&key) {
        return Err(error(Status::SERVICE_UNAVAILABLE, "Too many event connections"));
    }
    if let Some(previous) =
        inventory.connections.insert(key.clone(), Client { cancellation: cancel.clone(), pong: Instant::now() })
    {
        previous.cancellation.cancel();
    }
    drop(inventory);
    let guard = Guard(app, key, cancel.clone());
    Ok(Sse::new(async_stream::stream! {
        let _guard = guard;
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        heartbeat.tick().await;
        loop {
            tokio::select! {
                biased;
                _ = principal.0.cancelled() => break,
                _ = cancel.cancelled() => break,
                event = rx.recv() => match event {
                    Ok(Some(frame)) => yield Ok(Event::default().data(&frame.text)),
                    Ok(None) | Err(broadcast::error::RecvError::Lagged(_) | broadcast::error::RecvError::Closed) => break,
                },
                _ = heartbeat.tick() => {
                    if _guard.0.inner.lock().unwrap().connections.get(&_guard.1)
                        .is_none_or(|client| client.pong.elapsed() >= Duration::from_secs(45)) { break; }
                    yield Ok(Event::default().event("codenomad.client.ping")
                        .data(json!({"ts": chrono::Utc::now().timestamp_millis()}).to_string()));
                },
            }
        }
    }))
}

pub async fn pong(
    State(app): State<Shared>,
    channel: Option<Extension<crate::auth::tls::Channel>>,
    Json(connection): Json<Connection>,
) -> Result<Status, Error> {
    let key = owned_key(&owner(channel.as_ref().map(|c| &c.0)), connection.validate()?);
    if let Some(client) = app.inner.lock().unwrap().connections.get_mut(&key) {
        client.pong = Instant::now();
        Ok(Status::NO_CONTENT)
    } else {
        Err(error(Status::NOT_FOUND, "Client connection not found"))
    }
}

/// Native events without a location that every workspace receives.
const GLOBAL: &str = "agent.updated command.updated config.updated credential.switched credential.updated \
    integration.updated installation.update-available installation.updated mcp.resources.changed \
    mcp.status.changed models-dev.refreshed model.updated plugin.updated provider.updated \
    reference.updated server.connected skill.updated websearch.updated worktree.updated";

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
    order: std::collections::VecDeque<String>,
    sessions: std::collections::HashMap<String, std::collections::HashSet<Uuid>>,
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

pub async fn bridge(app: Shared) {
    let daemon = Uuid::new_v4().simple().to_string();
    let mut held = Held::default();
    loop {
        while {
            let store = app.inner.lock().unwrap();
            store.workspaces.is_empty() && store.generation == 0
        } {
            app.opened.notified().await;
        }
        status(&app, "connecting", None);
        let response = app.native.get("/api/event").header("accept", "text/event-stream").send().await;
        if let Ok(response) = response
            && response.status().is_success()
            && response.headers().get("content-type").is_some_and(|v| v.as_bytes().starts_with(b"text/event-stream"))
        {
            // Any chunk, including the daemon's `: heartbeat` comments (every 15 s when idle),
            // proves the stream alive: only 60 s without a byte reconnects and resynchronizes the UI.
            let now = || chrono::Utc::now().timestamp_millis();
            let seen = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(now()));
            let mark = seen.clone();
            let mut stream = Box::pin(upstream::events::<Value, _, _>(Box::pin(response.bytes_stream()), move || {
                mark.store(now(), std::sync::atomic::Ordering::Relaxed)
            }));
            let mut connected = false;
            loop {
                let next = match tokio::time::timeout(Duration::from_secs(60), stream.next()).await {
                    Ok(next) => next,
                    Err(_) if now() - seen.load(std::sync::atomic::Ordering::Relaxed) < 60_000 => continue,
                    Err(_) => break,
                };
                let Some(Ok(mut event)) = next else { break };
                let Some(kind) = event["type"].as_str().map(str::to_owned) else { break };
                let routed = Instant::now();
                let received = chrono::Utc::now().timestamp_millis();
                if !connected {
                    if kind != "server.connected" {
                        break;
                    }
                    connected = true;
                    status(&app, "connected", None);
                    // Reference: bundled plugins are provisioned on every OpenCode connection.
                    crate::extensions::lifecycle::connected();
                }
                if kind == "server.connected" {
                    if !event["data"].is_object() {
                        event["data"] = json!({});
                    }
                    event["data"]["daemon"] = json!(daemon);
                }
                // Integration events can contain backend-only data and need the TS sanitizer.
                if kind.starts_with("worktree.") || kind == "server.connected" {
                    crate::worktrees::linked::invalidate(&app);
                }
                if matches!(kind.as_str(), "integration.updated" | "rpc") {
                    continue;
                }
                let mut directory = event["location"]["directory"].as_str().map(str::to_owned);
                if directory.is_none() {
                    let session =
                        event["data"]["sessionID"].as_str().or_else(|| event["data"]["form"]["sessionID"].as_str());
                    if let Some(session) = session.filter(|s| crate::opencode::valid_id(s)) {
                        directory = crate::opencode::session_directory(&app, session).await.ok();
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
                                |dir| dir == native_dir || Path::new(dir).starts_with(&app.root),
                            ) && event["location"].get("workspaceID").is_none()
                        })
                        .cloned()
                        .collect::<Vec<_>>()
                };
                let session_id = event["data"]["sessionID"].as_str();
                let session_id =
                    session_id.filter(|s| *s != "global" && crate::opencode::valid_id(s)).map(str::to_owned);
                let mut recipients = Vec::new();
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
                                crate::worktrees::owns_event(&app, &workspace, dir).await
                            }
                            _ => false,
                        };
                        let owns_destination = crate::worktrees::owns_event(&app, &workspace, &destination).await;
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
                        if let Some(dir) = directory.as_deref()
                            && !crate::worktrees::owns_event(&app, &workspace, dir).await
                        {
                            continue;
                        }
                        recipients.push(workspace);
                    }
                    if let Some(sid) = session_id.as_deref() {
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
                    if app.workspace(&workspace.id.to_string()).is_ok() {
                        app.emit(json!({"type":"instance.event","instanceId":workspace.id,"event":event}));
                    }
                }
                let sid =
                    session_id.as_deref().or(event["data"]["session"]["id"].as_str()).or(event["data"]["id"].as_str());
                let (took, count, sid) = (routed.elapsed().as_millis(), recipients.len(), sid.unwrap_or("-"));
                crate::bench::route_trace(format_args!("event {kind} {took}ms to {count} at {received} sid {sid}"));
                crate::sessions::favorites::deleted(&app, &event);
                if crate::sessions::receipts::observe(&app, &event, &recipients).await.is_err() {
                    eprintln!("Permission receipt persistence unavailable");
                }
            }
        }
        status(&app, "error", Some("Shared OpenCode event stream ended"));
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_keys_are_bound_to_their_principal() {
        let channel = |device: Option<Uuid>| crate::auth::tls::Channel {
            origin: "https://127.0.0.1:1".into(),
            ingress: false,
            socket: CancellationToken::new(),
            principal: std::sync::Arc::new(std::sync::Mutex::new(device)),
        };
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let pair = || ("client".to_owned(), "stream".to_owned());
        let keys = [
            owned_key(&owner(None), pair()),
            owned_key(&owner(Some(&channel(Some(a)))), pair()),
            owned_key(&owner(Some(&channel(Some(b)))), pair()),
        ];
        assert!(keys[0] != keys[1] && keys[1] != keys[2] && keys[0] != keys[2]);
        assert!(keys[0].0.starts_with("local\0"));
        assert_eq!(owner(Some(&channel(None))), "unbound");
    }

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
}
