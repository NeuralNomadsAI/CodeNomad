//! The OpenCode daemon: its authenticated client, bounded native reads and the
//! workspace relay (`proxy`) with its session-list scope (`scope`).
pub mod proxy;
pub mod scope;

use std::time::Duration;

use axum::{
    Json, Router,
    http::StatusCode as Status,
    routing::{any, get},
};
use reqwest::{Client, Method, RequestBuilder, Url};
use serde_json::{Value, json};

use crate::{App, Error, Shared, bench, config, error, service};

pub struct Native {
    pub client: Client,
    pub url: Url,
    pub password: String,
}

impl Native {
    /// The service record's endpoint, else the bench's; loopback HTTP only.
    pub async fn connect() -> Result<Self, Box<dyn std::error::Error>> {
        let (url, password) = match config::opencode_service_file() {
            Some(_) if bench::native_endpoint_set() => {
                return Err("CNRS_OPENCODE_SERVICE_FILE and CNRS_FIXTURE_URL are exclusive".into());
            }
            Some(path) => service::endpoint(path.as_ref()).await?,
            None => bench::native_endpoint()?,
        };
        let url = Url::parse(&url)?;
        if !service::loopback(&url) {
            return Err("An explicit loopback HTTP fixture origin is required".into());
        }
        if password.is_empty() {
            return Err("An explicit fixture password is required".into());
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            // The reference's fetch idle keep-alive (undici 4 s): hyper's 90 s default reused
            // sockets the daemon had already closed (ConnectionReset, a 502 in the UI).
            .pool_idle_timeout(Duration::from_secs(4))
            .build()?;
        Ok(Self { client, url, password })
    }
    pub fn request(&self, method: Method, url: Url) -> RequestBuilder {
        self.client.request(method, url).basic_auth("opencode", Some(&self.password))
    }
    pub fn get(&self, path: &str) -> RequestBuilder {
        self.request(Method::GET, self.url.join(path).expect("static native path"))
    }
    /// `POST /api/rpc/<plugin>/<method>` for one Location.
    pub fn rpc(&self, route: &str, directory: &str, input: &Value) -> RequestBuilder {
        self.request(Method::POST, self.url.join(&format!("/api/rpc/{route}")).expect("static native path"))
            .query(&[("location[directory]", directory)])
            .json(&json!({ "input": input }))
    }
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/workspaces/{id}/instance", any(proxy::relay))
        .route("/workspaces/{id}/yolo/sessions/{session}", get(proxy::yolo_read))
        .route("/workspaces/{id}/instance/{*route}", any(proxy::relay))
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

pub async fn read_json(mut response: reqwest::Response, max: usize) -> Result<Value, ()> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if body.len() + chunk.len() > max {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| ())
}

pub fn native_rpc_absent(body: &Value, status: Status) -> bool {
    status == Status::BAD_REQUEST
        && body.as_object().is_some_and(|o| o.len() == 3)
        && body["_tag"] == "RpcError"
        && matches!(body["type"].as_str(), Some("rpc.method_not_found" | "rpc.unavailable"))
        && body["message"].as_str().is_some_and(|s| !s.is_empty() && s.len() <= 4096)
}

pub async fn session_record(app: &App, id: &str) -> Result<Value, Error> {
    if !valid_id(id) {
        return Err(error(Status::BAD_REQUEST, "Invalid session ID"));
    }
    let response =
        app.native.get(&format!("/api/session/{id}")).timeout(Duration::from_secs(4)).send().await.map_err(|e| {
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
