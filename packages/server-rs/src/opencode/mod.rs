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

pub struct Native {
    pub client: Client,
    endpoint: RwLock<Option<Arc<Endpoint>>>,
    /// `None`: the bench's fixture daemon, never rediscovered.
    lifecycle: Option<daemon::Lifecycle>,
    /// When the current endpoint was last confirmed; `None` once invalidated.
    validated: Mutex<Option<Instant>>,
    acquiring: tokio::sync::Mutex<()>,
}

/// Port 0 refuses every connection: before the first acquisition, native requests fail
/// like the reference's unconfigured lifecycle.
static UNCONNECTED: std::sync::LazyLock<Url> = std::sync::LazyLock::new(|| Url::parse("http://127.0.0.1:0/").unwrap());

impl Native {
    /// The bench's fixture daemon when the positional launch injects it, else the CLI lifecycle of `binary`.
    pub fn connect(binary: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
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
        Ok(Self { client, endpoint: RwLock::new(endpoint), lifecycle, validated, acquiring: Default::default() })
    }
    pub fn endpoint(&self) -> Option<Arc<Endpoint>> {
        self.endpoint.read().unwrap().clone()
    }
    pub fn current(&self, endpoint: &Arc<Endpoint>) -> bool {
        let live = self.endpoint.read().unwrap();
        live.as_ref().is_some_and(|current| Arc::ptr_eq(current, endpoint)) && self.validated.lock().unwrap().is_some()
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
    pub async fn acquire(&self, deadline: Instant) -> Result<Arc<Endpoint>, Refusal> {
        let Some(lifecycle) = &self.lifecycle else {
            return self.endpoint().ok_or_else(|| Refusal::Failed("OpenCode fixture endpoint is missing".into()));
        };
        let _serialized = self.acquiring.lock().await;
        let validated = *self.validated.lock().unwrap();
        let current = self.endpoint();
        let found = match (&current, validated) {
            (Some(current), Some(at)) if at.elapsed() < RECHECK => return Ok(current.clone()),
            (Some(current), Some(_)) => match lifecycle.discover(deadline).await {
                Ok(Some(found)) if found != **current => found,
                _ => {
                    let mut validated = self.validated.lock().unwrap();
                    if validated.is_none() {
                        return Err(Refusal::Failed("OpenCode connection was invalidated during discovery".into()));
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
        admission::admit(&self.client, &found).await?;
        let found = Arc::new(found);
        let mut endpoint = self.endpoint.write().unwrap();
        *endpoint = Some(found.clone());
        *self.validated.lock().unwrap() = Some(Instant::now());
        Ok(found)
    }
    /// `lifecycle.discover()`: the running daemon, never started. The bench's fixture endpoint
    /// reports the version its `/api/info` declares, as the reference remembers it.
    pub async fn discover(&self, binary: &str, deadline: Instant) -> Result<Option<Endpoint>, String> {
        if let Some(lifecycle) = &self.lifecycle {
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
        let live = self.endpoint.read().unwrap();
        if self.lifecycle.is_some() && live.as_ref().is_some_and(|e| Arc::ptr_eq(e, endpoint)) {
            *self.validated.lock().unwrap() = None;
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

pub(crate) async fn read_bytes(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, ()> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if body.len() + chunk.len() > max {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub async fn read_json(response: reqwest::Response, max: usize) -> Result<Value, ()> {
    serde_json::from_slice(&read_bytes(response, max).await?).map_err(|_| ())
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
    if !valid_id(id) {
        return Err(error(Status::BAD_REQUEST, "Invalid session ID"));
    }
    let response = app
        .native
        .client
        .get(endpoint.url.join(&format!("/api/session/{id}")).map_err(|_| upstream_error())?)
        .basic_auth("opencode", Some(&endpoint.password))
        .timeout(Duration::from_secs(4))
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
    let response = read_json(response.error_for_status().map_err(|_| upstream_error())?, 2 * 1024 * 1024)
        .await
        .map_err(|_| upstream_error())?;
    let response = response.get("data").unwrap_or(&response);
    if response["id"] != id { Err(upstream_error()) } else { Ok(response.clone()) }
}

pub async fn session_directory(app: &App, id: &str) -> Result<String, Error> {
    session_record(app, id).await?["location"]["directory"].as_str().map(str::to_owned).ok_or_else(upstream_error)
}
