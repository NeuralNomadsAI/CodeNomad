//! `GET /api/events`: the UI's SSE stream (workspace, native and file events through
//! per-subscriber queues), its pong keep-alive and the bridge from the daemon's stream.
mod bridge;
mod hub;
mod upstream;

pub use bridge::bridge;
pub use hub::Hub;

use std::{
    convert::Infallible,
    time::{Duration, Instant},
};

use axum::{
    Extension, Json,
    extract::{Query, State, rejection::QueryRejection},
    http::StatusCode as Status,
    response::sse::{Event, Sse},
    routing::{get, post},
};
use futures_util::Stream;
use serde::Deserialize;
use serde_json::{Value, json};
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
        self.events.publish(event);
    }
    pub fn emit_status(&self, id: Uuid, status: &str, generation: u64, reason: Option<&str>) {
        let mut event = json!({"type":"instance.eventStatus","instanceId":id,"status":status,"generation":generation});
        if let Some(reason) = reason {
            event["reason"] = json!(reason);
        }
        self.emit(event);
    }
}

struct Guard(Shared, (String, String), CancellationToken, std::sync::Arc<hub::Sub>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.events.unsubscribe(&self.3);
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
    // Subscribed under the inventory lock: the replayed statuses precede every later one.
    let sub = app.events.subscribe();
    drop(inventory);
    let guard = Guard(app, key, cancel.clone(), sub);
    Ok(Sse::new(async_stream::stream! {
        let _guard = guard;
        let (app, sub) = (&_guard.0, &_guard.3);
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        heartbeat.tick().await;
        // A backlog is sent without waiting, yet cancellation and the keep-alive still come first.
        let mut more = true;
        loop {
            tokio::select! {
                biased;
                _ = principal.0.cancelled() => break,
                _ = cancel.cancelled() => break,
                _ = app.events.shutdown.cancelled() => break,
                _ = heartbeat.tick() => {
                    if app.inner.lock().unwrap().connections.get(&_guard.1)
                        .is_none_or(|client| client.pong.elapsed() >= Duration::from_secs(45)) { break; }
                    yield Ok(Event::default().event("codenomad.client.ping")
                        .data(json!({"ts": chrono::Utc::now().timestamp_millis()}).to_string()));
                    continue;
                },
                _ = std::future::ready(()), if more => {},
                _ = sub.ready.notified(), if !more => {},
            }
            match app.events.pop(sub) {
                hub::Next::Frame(text) => {
                    more = true;
                    yield Ok(Event::default().data(text));
                }
                hub::Next::Empty => more = false,
                hub::Next::Closed => break,
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
}
