//! The OpenCode daemon: the shared connection (`opencode-service.ts`) found or started through
//! its CLI (`daemon`, `launch`) and admitted (`admission`), bounded native reads and the workspace
//! relay (`proxy`) with its session-list scope (`scope`), the executable's update status (`update`).
pub mod admission;
mod controls;
pub mod daemon;
pub mod install;
pub mod launch;
pub(crate) mod login_start;
mod prompt;
pub mod proxy;
mod proxy_body;
mod proxy_write;
pub mod scope;
mod session_environment;
pub mod update;

use std::{
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use axum::{
    Json, Router,
    http::StatusCode as Status,
    routing::{any, get, post},
};
use reqwest::{Client, Method, RequestBuilder, Url};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{App, Error, Shared, bench, error};
pub use admission::Refusal;
pub use daemon::Endpoint;

/// A working connection is rediscovered after this interval; only a different daemon replaces it.
const RECHECK: Duration = Duration::from_secs(30);
// Default headers/body inactivity limit of the reference's Undici transport.
const PROXY_IDLE: Duration = Duration::from_secs(300);

type AcquireFlight =
    futures_util::future::Shared<futures_util::future::BoxFuture<'static, Result<Arc<Endpoint>, Refusal>>>;

struct NativeInner {
    client: Client,
    endpoint: RwLock<Option<Arc<Endpoint>>>,
    /// `None`: the bench's fixture daemon, never rediscovered.
    lifecycle: Option<daemon::Lifecycle>,
    /// When the current endpoint was last confirmed; `None` once invalidated.
    validated: Mutex<Option<Instant>>,
    inflight: Mutex<Option<AcquireFlight>>,
    retired: tokio::sync::Notify,
}

pub struct Native {
    pub client: Client,
    inner: Arc<NativeInner>,
}

/// Port 0 refuses every connection: before the first acquisition, native requests fail
/// like the reference's unconfigured lifecycle.
static UNCONNECTED: std::sync::LazyLock<Url> = std::sync::LazyLock::new(|| Url::parse("http://127.0.0.1:0/").unwrap());

impl Native {
    #[cfg(test)]
    pub(crate) fn test_connection(address: std::net::SocketAddr) -> Self {
        let url = Url::parse(&format!("http://{address}")).unwrap();
        let client = Client::builder().no_proxy().build().unwrap();
        let inner = Arc::new(NativeInner {
            client: client.clone(),
            endpoint: RwLock::new(Some(Arc::new(Endpoint {
                url,
                password: "synthetic".into(),
                version: String::new(),
                pid: 0,
            }))),
            lifecycle: None,
            validated: Mutex::new(Some(Instant::now())),
            inflight: Mutex::new(None),
            retired: tokio::sync::Notify::new(),
        });
        Self { client, inner }
    }

    /// The bench's fixture daemon when the positional launch injects it, else the CLI lifecycle of `binary`.
    pub fn connect(binary: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .read_timeout(PROXY_IDLE)
            // The reference's fetch idle keep-alive (undici 4 s): hyper's 90 s default reused
            // sockets the daemon had already closed (ConnectionReset, a 502 in the UI).
            .pool_idle_timeout(Duration::from_secs(4))
            .build()?;
        let (endpoint, lifecycle) = if bench::native_endpoint_set() && !crate::config::serve() {
            let (url, password) = bench::native_endpoint()?;
            let url = Url::parse(&url)?;
            let fixture = url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some();
            if !fixture || !url.username().is_empty() || url.path() != "/" || url.query().is_some() {
                return Err("An explicit loopback HTTP fixture origin is required".into());
            }
            if password.is_empty() {
                return Err("An explicit fixture password is required".into());
            }
            (Some(Arc::new(Endpoint { url, password, version: String::new(), pid: 0 })), None)
        } else {
            (None, Some(daemon::Lifecycle::new(binary.into(), client.clone())))
        };
        let validated = Mutex::new(endpoint.as_ref().map(|_| Instant::now()));
        let inner = Arc::new(NativeInner {
            client: client.clone(),
            endpoint: RwLock::new(endpoint),
            lifecycle,
            validated,
            inflight: Mutex::new(None),
            retired: tokio::sync::Notify::new(),
        });
        Ok(Self { client, inner })
    }
    pub fn endpoint(&self) -> Option<Arc<Endpoint>> {
        self.inner.endpoint.read().unwrap().clone()
    }
    pub fn current(&self, endpoint: &Arc<Endpoint>) -> bool {
        let live = self.inner.endpoint.read().unwrap();
        live.as_ref().is_some_and(|current| Arc::ptr_eq(current, endpoint))
            && self.inner.validated.lock().unwrap().is_some()
    }
    pub async fn wait_retired(&self, endpoint: &Arc<Endpoint>) {
        loop {
            let notified = self.inner.retired.notified();
            if !self.current(endpoint) {
                return;
            }
            notified.await;
        }
    }
    pub fn url(&self) -> Url {
        self.endpoint().map_or_else(|| UNCONNECTED.clone(), |e| e.url.clone())
    }
    pub fn password(&self) -> String {
        self.endpoint().map(|e| e.password.clone()).unwrap_or_default()
    }

    /// `OpenCodeSharedService.connect`: the current connection while confirmed less than
    /// 30 s ago; else discovery, a start when nothing runs, then admission. A recheck that
    /// fails or finds nothing keeps a working connection; an invalidated one is replaced.
    /// Runs in a detached shared flight so cancelling one waiter never aborts another's acquisition.
    pub async fn acquire(&self, deadline: Instant) -> Result<Arc<Endpoint>, Refusal> {
        if self.inner.lifecycle.is_none() {
            return self.endpoint().ok_or_else(|| Refusal::Failed("OpenCode fixture endpoint is missing".into()));
        }
        {
            let current = self.inner.endpoint.read().unwrap();
            if let (Some(current), Some(at)) = (current.as_ref(), *self.inner.validated.lock().unwrap())
                && at.elapsed() < RECHECK
            {
                return Ok(current.clone());
            }
        }
        let flight = {
            let mut slot = self.inner.inflight.lock().unwrap();
            if let Some(existing) = slot.as_ref() {
                existing.clone()
            } else {
                use futures_util::FutureExt;
                let inner = self.inner.clone();
                let shared_deadline = deadline.max(Instant::now() + Duration::from_secs(30));
                let (tx, rx) = tokio::sync::oneshot::channel();
                let shared: AcquireFlight = async move {
                    rx.await.unwrap_or_else(|_| Err(Refusal::Failed("OpenCode acquisition stopped".into())))
                }
                .boxed()
                .shared();
                *slot = Some(shared.clone());
                tokio::spawn(async move {
                    let result = run_acquire(&inner, shared_deadline).await;
                    *inner.inflight.lock().unwrap() = None;
                    let _ = tx.send(result);
                });
                shared
            }
        };
        tokio::time::timeout_at(deadline, flight)
            .await
            .map_err(|_| Refusal::Failed("Timed out waiting for OpenCode".into()))?
    }
    /// `lifecycle.discover()`: the running daemon, never started. The bench's fixture endpoint
    /// reports the version its `/api/info` declares, as the reference remembers it.
    pub async fn discover(&self, binary: &str, deadline: Instant) -> Result<Option<Endpoint>, String> {
        if let Some(lifecycle) = &self.inner.lifecycle {
            return if lifecycle.binary == binary {
                lifecycle.discover(deadline).await
            } else {
                daemon::Lifecycle::new(binary.to_owned(), self.client.clone()).discover(deadline).await
            };
        }
        let Some(mut endpoint) = self.endpoint().map(|e| (*e).clone()) else { return Ok(None) };
        let info = self.get("/api/info").timeout(Duration::from_secs(5)).send().await.map_err(|e| e.to_string())?;
        endpoint.version = read_json(info, 64 * 1024)
            .await
            .ok()
            .and_then(|v| v["version"].as_str().map(str::to_owned))
            .unwrap_or_default();
        Ok(Some(endpoint))
    }
    /// The event stream of `endpoint` ended or failed: the next acquisition discovers again
    /// (and starts the daemon when it is gone). Requests keep it until then.
    pub fn invalidate(&self, endpoint: &Arc<Endpoint>) {
        let live = self.inner.endpoint.read().unwrap();
        if self.inner.lifecycle.is_some() && live.as_ref().is_some_and(|e| Arc::ptr_eq(e, endpoint)) {
            *self.inner.validated.lock().unwrap() = None;
            drop(live);
            self.inner.retired.notify_waiters();
        }
    }

    pub fn request(&self, method: Method, url: Url) -> RequestBuilder {
        self.client.request(method, url).basic_auth("opencode", Some(self.password()))
    }
    pub fn get(&self, path: &str) -> RequestBuilder {
        self.request(Method::GET, self.url().join(path).expect("static native path"))
    }
    /// `POST /api/rpc/<plugin>/<method>` for one Location.
    pub fn rpc(&self, route: &str, directory: &str, input: &Value) -> RequestBuilder {
        self.request(Method::POST, self.url().join(&format!("/api/rpc/{route}")).expect("static native path"))
            .query(&[("location[directory]", directory)])
            .json(&json!({ "input": input }))
    }
}

async fn run_acquire(inner: &NativeInner, deadline: Instant) -> Result<Arc<Endpoint>, Refusal> {
    let Some(lifecycle) = &inner.lifecycle else {
        return inner
            .endpoint
            .read()
            .unwrap()
            .clone()
            .ok_or_else(|| Refusal::Failed("OpenCode fixture endpoint is missing".into()));
    };
    for _attempt in 0..3 {
        let validated = *inner.validated.lock().unwrap();
        let current = inner.endpoint.read().unwrap().clone();
        let found = match (&current, validated) {
            (Some(current), Some(at)) if at.elapsed() < RECHECK => return Ok(current.clone()),
            (Some(current), Some(_)) => match lifecycle.discover(deadline).await {
                Ok(Some(found)) if found != **current => found,
                _ => {
                    let mut validated = inner.validated.lock().unwrap();
                    if validated.is_none() {
                        // Connection was invalidated while discovery ran (e.g. SSE disconnect);
                        // retry acquisition within the same request deadline (TS `opencode-service.ts:196-204`).
                        continue;
                    }
                    *validated = Some(Instant::now());
                    return Ok(current.clone());
                }
            },
            _ => match lifecycle.discover(deadline).await? {
                Some(found) => found,
                None => lifecycle.ensure(deadline).await?,
            },
        };
        if current.as_ref().is_some_and(|old| **old != found) {
            // Retire the replaced daemon immediately upon discovering a different endpoint
            // (TS `opencode-service.ts:196-200, 333-343`), even if admitting the replacement fails.
            *inner.endpoint.write().unwrap() = None;
            *inner.validated.lock().unwrap() = None;
            inner.retired.notify_waiters();
        }
        admission::admit(&inner.client, &found).await?;
        let found = Arc::new(found);
        let mut endpoint = inner.endpoint.write().unwrap();
        *endpoint = Some(found.clone());
        *inner.validated.lock().unwrap() = Some(Instant::now());
        drop(endpoint);
        inner.retired.notify_waiters();
        return Ok(found);
    }
    Err(Refusal::Failed("OpenCode connection was invalidated during discovery".into()))
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/workspaces/{id}/instance", any(proxy::relay))
        .route("/workspaces/{id}/instance/{*route}", any(proxy::relay))
        .route("/api/opencode/update", get(update::status))
        .route("/api/opencode/login-start", get(login_start::read).post(login_start::set))
        .route("/api/storage/binaries/validate", post(update::validate))
}

/// Marks a relayed native body whose content type must stay untouched.
#[derive(Clone)]
pub struct NativeBody;

/// `session-access-contract.ts` of the reference.
pub const SESSION_LOCATED_ELSEWHERE: &str = "session_located_elsewhere";
pub const SESSION_PLACEMENT_HEADER: &str = "x-codenomad-session-placement";

pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 514
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

pub fn upstream_error() -> Error {
    error(Status::BAD_GATEWAY, "Workspace instance proxy failed")
}

pub fn pre_dispatch_unavailable() -> Error {
    error(Status::BAD_GATEWAY, "opencode_unavailable_before_send")
}

pub(crate) async fn read_bytes(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, ()> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        let Some(need) = body.len().checked_add(chunk.len()) else {
            return Err(());
        };
        if need > max {
            return Err(());
        }
        if need > body.capacity() {
            let target = (body.capacity().max(8192).saturating_mul(2)).max(need).min(max);
            body.reserve_exact(target - body.len());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub async fn read_json(response: reqwest::Response, max: usize) -> Result<Value, ()> {
    let bytes = read_bytes(response, max).await?;
    if bytes.len() > 32 * 1024 {
        tokio::task::spawn_blocking(move || serde_json::from_slice(&bytes).map_err(|_| ())).await.map_err(|_| ())?
    } else {
        serde_json::from_slice(&bytes).map_err(|_| ())
    }
}

pub fn native_rpc_absent(body: &Value, status: Status) -> bool {
    status == Status::BAD_REQUEST
        && body.as_object().is_some_and(|o| o.len() == 3)
        && body["_tag"] == "RpcError"
        && matches!(body["type"].as_str(), Some("rpc.method_not_found" | "rpc.unavailable"))
        && body["message"].as_str().is_some_and(|s| !s.is_empty() && s.len() <= 4096)
}

pub async fn session_record(app: &App, id: &str) -> Result<Value, Error> {
    let endpoint = app.native.endpoint().ok_or_else(upstream_error)?;
    session_record_at(app, &endpoint, id).await
}

pub async fn session_record_at(app: &App, endpoint: &Endpoint, id: &str) -> Result<Value, Error> {
    session_record_with_timeout_at(app, endpoint, id, Duration::from_secs(4)).await
}

pub async fn session_record_with_timeout_at(
    app: &App,
    endpoint: &Endpoint,
    id: &str,
    timeout: Duration,
) -> Result<Value, Error> {
    if !valid_id(id) {
        return Err(error(Status::BAD_REQUEST, "Invalid session ID"));
    }
    session_record_segment_at(app, endpoint, id, timeout, true, 2 * 1024 * 1024, false).await
}

/// Variant for opaque session IDs (`navigation-contract.ts` / `session-media-contract.ts`)
/// with caller-selected timeout, strict ID enforcement, and body size cap.
pub async fn session_record_opaque_at(
    app: &App,
    endpoint: &Endpoint,
    id: &str,
    timeout: Duration,
    strict_id: bool,
    max_bytes: usize,
) -> Result<Value, Error> {
    if id.is_empty()
        || id.encode_utf16().nth(256).is_some()
        || matches!(id, "." | "..")
        || id.bytes().any(|b| b.is_ascii_control())
    {
        return Err(error(Status::BAD_REQUEST, "Invalid session ID"));
    }
    session_record_segment_at(app, endpoint, id, timeout, strict_id, max_bytes, true).await
}

/// Variant for `GET /api/session/:id/message` admission checks: accepts opaque session IDs with
/// the 30 s budget and uniform 16 MiB session-record cap matching history/media reads.
pub async fn session_record_list_at(app: &App, endpoint: &Endpoint, id: &str) -> Result<Value, Error> {
    session_record_opaque_at(app, endpoint, id, Duration::from_secs(30), true, 16 * 1024 * 1024).await
}

/// Variant for opaque media/history-media session IDs (TS `session-media-contract.ts`).
/// Uses the full 30 s route budget and 16 MiB body cap (TS `session-media-fetch.ts:29-46`).
pub async fn session_record_media_at(app: &App, endpoint: &Endpoint, id: &str) -> Result<Value, Error> {
    session_record_opaque_at(app, endpoint, id, Duration::from_secs(30), true, 16 * 1024 * 1024).await
}

/// Variant for `session-media` that lets the caller classify an unexpected `data.id`
/// (`403` on initial lookup, `409` on revalidation, matching TS `session-media.ts:54-70`).
pub async fn session_record_media_raw_at(app: &App, endpoint: &Endpoint, id: &str) -> Result<Value, Error> {
    session_record_opaque_at(app, endpoint, id, Duration::from_secs(30), false, 16 * 1024 * 1024).await
}

async fn session_record_segment_at(
    app: &App,
    endpoint: &Endpoint,
    id: &str,
    timeout: Duration,
    strict_id: bool,
    max_bytes: usize,
    compact: bool,
) -> Result<Value, Error> {
    let mut url = endpoint.url.clone();
    url.path_segments_mut().map_err(|_| upstream_error())?.clear().extend(["api", "session", id]);
    let response = app
        .native
        .client
        .get(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| {
            bench::route_trace(format_args!(
                "session-record send-failed timeout={} connect={} chain={:?}",
                e.is_timeout(),
                e.is_connect(),
                std::error::Error::source(&e)
            ));
            upstream_error()
        })?;
    if !response.status().is_success() {
        bench::route_trace(format_args!("session-record native-status {}", response.status().as_u16()));
    }
    if response.status() == Status::NOT_FOUND {
        let declared = read_json(response, 4096).await.ok();
        declared.filter(|d| d["_tag"] == "SessionNotFoundError" && d["sessionID"] == id).ok_or_else(upstream_error)?;
        return Err((
            Status::NOT_FOUND,
            Json(json!({"_tag":"SessionNotFoundError","sessionID":id,"message":"Session not found"})),
        ));
    }
    if response.status() == Status::BAD_REQUEST {
        return Err(error(Status::BAD_REQUEST, "Invalid session ID"));
    }
    if response.status() != Status::OK {
        return Err(upstream_error());
    }
    if compact {
        let is_json =
            response.headers().get(axum::http::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|ct| {
                let essence = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
                essence == "application/json" || essence.ends_with("+json")
            });
        if !is_json {
            return Err(upstream_error());
        }
    }
    static SESSION_PARSE_SLOTS: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)));
    let parse_permit = if max_bytes > 2 * 1024 * 1024 {
        Some(SESSION_PARSE_SLOTS.clone().acquire_owned().await.map_err(|_| upstream_error())?)
    } else {
        None
    };
    let raw = read_bytes(response.error_for_status().map_err(|_| upstream_error())?, max_bytes)
        .await
        .map_err(|_| upstream_error())?;
    let parse = move |bytes: Vec<u8>, id: &str, strict_id: bool| -> Result<Value, ()> {
        if compact {
            return crate::sessions::media_stream::extract_session_record(&bytes, id, strict_id);
        }
        if !crate::sessions::media_stream::json_node_count_within(&bytes, 100_000) {
            return Err(());
        }
        let mut parsed: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
        let data = match parsed.as_object_mut().and_then(|o| o.remove("data")) {
            Some(inner) => inner,
            None => parsed,
        };
        if !data.is_object() || (strict_id && data["id"] != id) { Err(()) } else { Ok(data) }
    };
    if raw.len() > 32 * 1024 {
        let expected = id.to_owned();
        // Move `parse_permit` into `spawn_blocking` so cancelling the request never releases the
        // slot while the worker still holds the raw JSON buffer or parsed tree.
        tokio::task::spawn_blocking(move || {
            let _permit = parse_permit;
            parse(raw, &expected, strict_id)
        })
        .await
        .map_err(|_| upstream_error())?
        .map_err(|_| upstream_error())
    } else {
        parse(raw, id, strict_id).map_err(|_| upstream_error())
    }
}

/// Returns `Ok(Some(directory))` when the session belongs to a local directory with no
/// `workspaceID`, `Ok(None)` when the session carries a native `workspaceID` selector (foreign
/// workspace), and `Err` when the native record cannot be read.
pub async fn session_location(app: &App, id: &str) -> Result<Option<String>, Error> {
    let record = session_record(app, id).await?;
    if record["location"].get("workspaceID").is_some() {
        return Ok(None);
    }
    record["location"]["directory"].as_str().map(|dir| Some(dir.to_owned())).ok_or_else(upstream_error)
}

pub async fn session_directory(app: &App, id: &str) -> Result<String, Error> {
    session_location(app, id).await?.ok_or_else(upstream_error)
}
