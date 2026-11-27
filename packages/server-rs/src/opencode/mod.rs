//! The OpenCode daemon: the shared connection (`opencode-service.ts`) found or started through
//! its CLI (`daemon`, `launch`) and admitted (`admission`), bounded native reads and the workspace
//! relay (`proxy`) with its session-list scope (`scope`), the executable's update status (`update`).
pub mod admission;
mod controls;
pub mod daemon;
pub mod install;
pub mod launch;
pub(crate) mod login_start;
mod logs;
mod prompt;
pub mod proxy;
pub(crate) mod proxy_body;
mod proxy_write;
pub mod scope;
pub mod service_action;
mod session_environment;
pub mod update;

use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
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

/// `Ok(None)` signals that `reconnect()` superseded this flight; callers rejoin `acquire()`.
type AcquireFlight =
    futures_util::future::Shared<futures_util::future::BoxFuture<'static, Result<Option<Arc<Endpoint>>, Refusal>>>;

struct NativeInner {
    client: Client,
    endpoint: RwLock<Option<Arc<Endpoint>>>,
    /// `None`: the bench's fixture daemon, never rediscovered.
    lifecycle: RwLock<Option<daemon::Lifecycle>>,
    config_path: RwLock<Option<PathBuf>>,
    pinned_binary: AtomicBool,
    /// Serializes async binary resolution + hot-adoption so concurrent config PATCHes
    /// always converge to the latest committed setting.
    binary_adopt: tokio::sync::Mutex<()>,
    /// Incremented on invalidation, retirement or binary hot-adoption so stale acquires retry.
    generation: AtomicU64,
    next_flight_id: AtomicU64,
    /// When the current endpoint was last confirmed; `None` once invalidated.
    validated: Mutex<Option<Instant>>,
    inflight: Mutex<Option<(u64, AcquireFlight)>>,
    retired: tokio::sync::Notify,
}

pub struct Native {
    pub client: Client,
    inner: Arc<NativeInner>,
}

pub struct ConnectionGuard<'a> {
    _validated: std::sync::MutexGuard<'a, Option<Instant>>,
    _endpoint: std::sync::RwLockReadGuard<'a, Option<Arc<Endpoint>>>,
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
            lifecycle: RwLock::new(None),
            config_path: RwLock::new(None),
            pinned_binary: AtomicBool::new(false),
            binary_adopt: tokio::sync::Mutex::new(()),
            generation: AtomicU64::new(0),
            next_flight_id: AtomicU64::new(0),
            validated: Mutex::new(Some(Instant::now())),
            inflight: Mutex::new(None),
            retired: tokio::sync::Notify::new(),
        });
        Self { client, inner }
    }

    #[cfg(test)]
    pub(crate) fn replace_test_endpoint(&self, address: std::net::SocketAddr) {
        let url = Url::parse(&format!("http://{address}")).unwrap();
        *self.inner.endpoint.write().unwrap() =
            Some(Arc::new(Endpoint { url, password: "synthetic".into(), version: String::new(), pid: 0 }));
        *self.inner.validated.lock().unwrap() = Some(Instant::now());
        self.inner.retired.notify_waiters();
    }

    #[cfg(test)]
    pub(crate) fn invalidate_test_endpoint(&self, endpoint: &Arc<Endpoint>) {
        let live = self.inner.endpoint.read().unwrap();
        if live.as_ref().is_some_and(|e| Arc::ptr_eq(e, endpoint)) {
            *self.inner.validated.lock().unwrap() = None;
            drop(live);
            self.inner.retired.notify_waiters();
        }
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
            lifecycle: RwLock::new(lifecycle),
            config_path: RwLock::new(None),
            pinned_binary: AtomicBool::new(false),
            binary_adopt: tokio::sync::Mutex::new(()),
            generation: AtomicU64::new(0),
            next_flight_id: AtomicU64::new(0),
            validated,
            inflight: Mutex::new(None),
            retired: tokio::sync::Notify::new(),
        });
        Ok(Self { client, inner })
    }

    pub fn attach_settings(&self, config_path: PathBuf) {
        *self.inner.config_path.write().unwrap() = Some(config_path.clone());
        if let Some(lifecycle) = self.inner.lifecycle.write().unwrap().as_mut() {
            lifecycle.config_path = Some(config_path);
        }
    }

    pub fn pin_binary(&self) {
        self.inner.pinned_binary.store(true, Ordering::Relaxed);
    }

    pub fn is_pinned(&self) -> bool {
        self.inner.pinned_binary.load(Ordering::Relaxed)
    }

    pub fn binary(&self) -> Option<String> {
        self.inner.lifecycle.read().unwrap().as_ref().map(|lifecycle| lifecycle.binary.clone())
    }

    pub fn can_restart(&self) -> bool {
        self.inner.lifecycle.read().unwrap().is_some()
    }

    pub fn can_reload(&self) -> bool {
        self.inner.lifecycle.read().unwrap().is_some()
    }

    pub fn lifecycle_for(&self, binary: &str) -> Option<daemon::Lifecycle> {
        let existing = self.inner.lifecycle.read().unwrap();
        let existing = existing.as_ref()?;
        let config_path = existing.config_path.clone().or_else(|| self.inner.config_path.read().unwrap().clone());
        Some(daemon::Lifecycle::with_config(binary.to_owned(), self.client.clone(), config_path))
    }

    /// Hot-adopts a newly configured OpenCode executable for future discovery/startup without
    /// stopping or restarting any running daemon.
    pub fn adopt_binary(&self, binary: &str) {
        if self.is_pinned() {
            return;
        }
        let mut guard = self.inner.lifecycle.write().unwrap();
        let Some(lifecycle) = guard.as_mut() else {
            return;
        };
        if lifecycle.binary == binary {
            return;
        }
        lifecycle.binary = binary.to_owned();
        let mut validated = self.inner.validated.lock().unwrap();
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        *validated = None;
    }

    /// Retires client authority for the current shared connection without stopping the daemon,
    /// updates workspace binary labels, and acquires a fresh admitted connection for `binary`.
    pub async fn reconnect(&self, app: &App, binary: &str, deadline: Instant) -> Result<Arc<Endpoint>, Refusal> {
        if self.inner.lifecycle.read().unwrap().is_none() {
            return self.endpoint().ok_or_else(|| Refusal::Failed("OpenCode fixture endpoint is missing".into()));
        }
        {
            let _adopt = self.inner.binary_adopt.lock().await;
            let (selected, _, _) = update::selected_binary(app).await;
            if selected != binary {
                return Err(Refusal::Failed("OpenCode selection changed during activation".into()));
            }
            if !self.is_pinned()
                && let Some(lifecycle) = self.inner.lifecycle.write().unwrap().as_mut()
            {
                lifecycle.binary = binary.to_owned();
            }
            {
                let mut endpoint = self.inner.endpoint.write().unwrap();
                let mut validated = self.inner.validated.lock().unwrap();
                self.inner.generation.fetch_add(1, Ordering::SeqCst);
                *endpoint = None;
                *validated = None;
                *self.inner.inflight.lock().unwrap() = None;
            }
            self.inner.retired.notify_waiters();
            {
                let binary_path = PathBuf::from(binary);
                let label = binary_path.file_name().unwrap_or_default().to_string_lossy().into_owned();
                let mut store = app.inner.lock().unwrap();
                for workspace in &mut store.workspaces {
                    workspace.binary_id = binary_path.clone();
                    workspace.binary_label = label.clone();
                }
            }
        }
        self.acquire(deadline).await
    }

    pub fn endpoint(&self) -> Option<Arc<Endpoint>> {
        self.inner.endpoint.read().unwrap().clone()
    }
    pub fn current(&self, endpoint: &Arc<Endpoint>) -> bool {
        self.guard_current(endpoint).is_some()
    }
    pub fn guard_current(&self, endpoint: &Arc<Endpoint>) -> Option<ConnectionGuard<'_>> {
        let live = self.inner.endpoint.read().unwrap();
        let validated = self.inner.validated.lock().unwrap();
        if live.as_ref().is_some_and(|current| Arc::ptr_eq(current, endpoint)) && validated.is_some() {
            Some(ConnectionGuard { _endpoint: live, _validated: validated })
        } else {
            None
        }
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
        if self.inner.lifecycle.read().unwrap().is_none() {
            return self.endpoint().ok_or_else(|| Refusal::Failed("OpenCode fixture endpoint is missing".into()));
        }
        for _ in 0..8 {
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
                if let Some((_, existing)) = slot.as_ref() {
                    existing.clone()
                } else {
                    use futures_util::FutureExt;
                    let id = self.inner.next_flight_id.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
                    let inner = self.inner.clone();
                    let shared_deadline = deadline.max(Instant::now() + Duration::from_secs(30));
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let shared: AcquireFlight = async move {
                        rx.await.unwrap_or_else(|_| Err(Refusal::Failed("OpenCode acquisition stopped".into())))
                    }
                    .boxed()
                    .shared();
                    *slot = Some((id, shared.clone()));
                    tokio::spawn(async move {
                        let result = run_acquire(&inner, id, shared_deadline).await;
                        let mut slot = inner.inflight.lock().unwrap();
                        if slot.as_ref().is_some_and(|(current_id, _)| *current_id == id) {
                            *slot = None;
                        }
                        drop(slot);
                        let _ = tx.send(result);
                    });
                    shared
                }
            };
            match tokio::time::timeout_at(deadline, flight)
                .await
                .map_err(|_| Refusal::Failed("Timed out waiting for OpenCode".into()))??
            {
                Some(endpoint) => return Ok(endpoint),
                None => continue,
            }
        }
        Err(Refusal::Failed("OpenCode connection was invalidated during discovery".into()))
    }
    /// `lifecycle.discover()`: the running daemon, never started. The bench's fixture endpoint
    /// reports the version its `/api/info` declares, as the reference remembers it.
    pub async fn discover(&self, binary: &str, deadline: Instant) -> Result<Option<Endpoint>, String> {
        if let Some(lifecycle) = self.lifecycle_for(binary) {
            return lifecycle.discover(deadline).await;
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
        let _ = self.invalidate_if_current_with(endpoint, || {});
    }

    /// Invalidates `endpoint` only if it is still live and validated, invoking `on_retire`
    /// while holding the validation lock and before waking `wait_retired`. Returns `true`
    /// only for the single caller that transitioned `endpoint` to retired.
    pub(crate) fn invalidate_if_current_with(&self, endpoint: &Arc<Endpoint>, on_retire: impl FnOnce()) -> bool {
        let has_lifecycle = self.inner.lifecycle.read().unwrap().is_some();
        if !has_lifecycle {
            return false;
        }
        let live = self.inner.endpoint.read().unwrap();
        if live.as_ref().is_some_and(|e| Arc::ptr_eq(e, endpoint)) {
            let mut validated = self.inner.validated.lock().unwrap();
            self.inner.generation.fetch_add(1, Ordering::SeqCst);
            if validated.take().is_some() {
                on_retire();
                drop(validated);
                drop(live);
                self.inner.retired.notify_waiters();
                return true;
            }
        }
        false
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

fn is_active_flight(inner: &NativeInner, flight_id: u64) -> bool {
    inner.inflight.lock().unwrap().as_ref().is_some_and(|(id, _)| *id == flight_id)
}

async fn run_acquire(inner: &NativeInner, flight_id: u64, deadline: Instant) -> Result<Option<Arc<Endpoint>>, Refusal> {
    for _attempt in 0..6 {
        if !is_active_flight(inner, flight_id) {
            return Ok(None);
        }
        let generation = inner.generation.load(Ordering::SeqCst);
        let Some(lifecycle) = inner.lifecycle.read().unwrap().clone() else {
            return inner
                .endpoint
                .read()
                .unwrap()
                .clone()
                .map(Some)
                .ok_or_else(|| Refusal::Failed("OpenCode fixture endpoint is missing".into()));
        };
        let validated = *inner.validated.lock().unwrap();
        let current = inner.endpoint.read().unwrap().clone();
        let found = match (&current, validated) {
            (Some(current), Some(at)) if at.elapsed() < RECHECK => return Ok(Some(current.clone())),
            (Some(current), Some(_)) => match lifecycle.discover(deadline).await {
                Ok(Some(found)) if found != **current => found,
                _ => {
                    let mut validated = inner.validated.lock().unwrap();
                    if !is_active_flight(inner, flight_id) {
                        return Ok(None);
                    }
                    if validated.is_none() || inner.generation.load(Ordering::SeqCst) != generation {
                        // Connection was invalidated or binary changed while discovery ran;
                        // retry acquisition within the same request deadline (TS `opencode-service.ts:196-204`).
                        continue;
                    }
                    *validated = Some(Instant::now());
                    return Ok(Some(current.clone()));
                }
            },
            _ => match lifecycle.discover(deadline).await {
                Ok(Some(found)) => found,
                Ok(None) => {
                    if !is_active_flight(inner, flight_id) {
                        return Ok(None);
                    }
                    if inner.generation.load(Ordering::SeqCst) != generation {
                        continue;
                    }
                    // Match TS `ensure()`: validate profile startup env and run a final discovery
                    // before launching `service start`, checking generation right before spawn.
                    let environment = match launch::daemon_environment_from_config(lifecycle.config_path.as_deref()) {
                        Ok(env) => env,
                        Err(err) => {
                            return if is_active_flight(inner, flight_id) {
                                Err(Refusal::Failed(err))
                            } else {
                                Ok(None)
                            };
                        }
                    };
                    match lifecycle.discover(deadline).await {
                        Ok(Some(found)) => found,
                        Ok(None) => {
                            if !is_active_flight(inner, flight_id) {
                                return Ok(None);
                            }
                            if inner.generation.load(Ordering::SeqCst) != generation {
                                continue;
                            }
                            match lifecycle.start_with_env(&environment, deadline).await {
                                Ok(found) => found,
                                Err(err) => {
                                    return if is_active_flight(inner, flight_id) {
                                        Err(Refusal::Failed(err))
                                    } else {
                                        Ok(None)
                                    };
                                }
                            }
                        }
                        Err(err) => {
                            return if is_active_flight(inner, flight_id) {
                                Err(Refusal::Failed(err))
                            } else {
                                Ok(None)
                            };
                        }
                    }
                }
                Err(err) => {
                    return if is_active_flight(inner, flight_id) { Err(Refusal::Failed(err)) } else { Ok(None) };
                }
            },
        };
        if !is_active_flight(inner, flight_id) {
            return Ok(None);
        }
        if inner.generation.load(Ordering::SeqCst) != generation {
            continue;
        }
        if current.as_ref().is_some_and(|old| **old != found) {
            // Retire the replaced daemon immediately upon discovering a different endpoint
            // (TS `opencode-service.ts:196-200, 333-343`), even if admitting the replacement fails.
            {
                let mut endpoint = inner.endpoint.write().unwrap();
                let mut validated = inner.validated.lock().unwrap();
                if !is_active_flight(inner, flight_id) {
                    return Ok(None);
                }
                if inner.generation.load(Ordering::SeqCst) != generation {
                    continue;
                }
                *endpoint = None;
                *validated = None;
            }
            inner.retired.notify_waiters();
        }
        if let Err(err) = admission::admit(&inner.client, &found).await {
            return if is_active_flight(inner, flight_id) { Err(err) } else { Ok(None) };
        }
        let found = Arc::new(found);
        {
            let mut endpoint = inner.endpoint.write().unwrap();
            let mut validated = inner.validated.lock().unwrap();
            if !is_active_flight(inner, flight_id) {
                return Ok(None);
            }
            if inner.generation.load(Ordering::SeqCst) != generation {
                continue;
            }
            *endpoint = Some(found.clone());
            *validated = Some(Instant::now());
        }
        inner.retired.notify_waiters();
        return Ok(Some(found));
    }
    Err(Refusal::Failed("OpenCode connection was invalidated during discovery".into()))
}

/// Fastify 5 request body reading: rejects unsupported media types (`415`) before checking the
/// 1 MiB body limit (`413 FST_ERR_CTP_BODY_TOO_LARGE`). Briefly drains rejected bodies without
/// retaining them so HTTP/1.1 peers receive the 415/413 cleanly instead of a socket reset.
pub(crate) async fn read_fastify_body(
    request: axum::extract::Request,
) -> Result<Option<crate::shared::fastify::Body>, Error> {
    use crate::shared::fastify;
    use futures_util::StreamExt;
    const LIMIT: usize = 1024 * 1024;
    const DRAIN_LIMIT: usize = LIMIT + 64 * 1024;
    const DRAIN_TIME: Duration = Duration::from_secs(2);

    let media =
        || fastify::error(Status::UNSUPPORTED_MEDIA_TYPE, "FST_ERR_CTP_INVALID_MEDIA_TYPE", "Unsupported Media Type");
    let drain = |mut stream: axum::body::BodyDataStream, mut seen: usize| async move {
        let end = Instant::now() + DRAIN_TIME;
        while seen <= DRAIN_LIMIT {
            match tokio::time::timeout_at(end, stream.next()).await {
                Ok(Some(Ok(chunk))) => seen = seen.saturating_add(chunk.len()),
                _ => break,
            }
        }
    };
    let (head, body) = request.into_parts();
    let declared = head
        .headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<usize>().ok());
    match head.headers.get(axum::http::header::CONTENT_TYPE) {
        Some(kind) => {
            let essence = kind.to_str().unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            if !matches!(essence.as_str(), "application/json" | "text/plain") {
                drain(body.into_data_stream(), 0).await;
                return Err(media());
            }
            let bytes = proxy_body::read(body, LIMIT, declared).await?;
            fastify::body(&head.headers, &bytes)
        }
        None => {
            // Fastify 5 rejects framed bodies (`Transfer-Encoding` or non-zero `Content-Length`)
            // without a supported `Content-Type`, even when a chunked stream carries zero bytes.
            let has_transfer_encoding = head.headers.contains_key(axum::http::header::TRANSFER_ENCODING);
            let non_zero_length = head
                .headers
                .get(axum::http::header::CONTENT_LENGTH)
                .is_some_and(|v| v.to_str().ok().map(str::trim) != Some("0"));
            if has_transfer_encoding || non_zero_length {
                drain(body.into_data_stream(), 0).await;
                return Err(media());
            }
            let mut stream = body.into_data_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| media())?;
                if !chunk.is_empty() {
                    drain(stream, chunk.len()).await;
                    return Err(media());
                }
            }
            Ok(None)
        }
    }
}

/// Resolves the currently configured OpenCode executable and hot-adopts it on `app.native`
/// without restarting any running daemon. Runs in a detached serialized task so concurrent
/// config PATCHes always converge to the latest committed `opencodeBinary` even if the HTTP
/// handler is cancelled mid-wait.
pub async fn adopt_configured_binary(app: &Shared) {
    if app.native.is_pinned() {
        return;
    }
    let app = app.clone();
    let _ = tokio::spawn(async move {
        let _guard = app.native.inner.binary_adopt.lock().await;
        let (binary, _, _) = update::selected_binary(&app).await;
        app.native.adopt_binary(&binary);
    })
    .await;
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/workspaces/{id}/instance", any(proxy::relay))
        .route("/workspaces/{id}/instance/{*route}", any(proxy::relay))
        .route("/api/opencode/service", post(service_action::handle))
        .route("/api/opencode/update", get(update::status))
        .route("/api/opencode/login-start", get(login_start::read).post(login_start::set))
        .route("/api/opencode/logs", get(logs::read))
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

pub async fn session_location_at(app: &App, endpoint: &Arc<Endpoint>, id: &str) -> Result<Option<String>, Error> {
    let record = session_record_at(app, endpoint, id).await?;
    if record["location"].get("workspaceID").is_some() {
        return Ok(None);
    }
    record["location"]["directory"].as_str().map(|dir| Some(dir.to_owned())).ok_or_else(upstream_error)
}

pub async fn session_directory(app: &App, id: &str) -> Result<String, Error> {
    session_location(app, id).await?.ok_or_else(upstream_error)
}

#[cfg(test)]
mod service_tests;
