//! Session preview registry and cookie-free capability proxy (`previews/manager.ts`).
pub mod backend;
mod proxy;
mod remote;
mod rewrite;

use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{StatusCode as Status, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{any, delete, post},
};
use reqwest::Url;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    Error, Shared, error, now,
    shared::{decode_component, fastify, js_trim},
};

/// The authenticated UI fallback can borrow only a live preview named by a same-origin Referer.
pub async fn fallback(app: &Shared, req: Request) -> Result<Response, Request> {
    let Some((token, preview, path)) = referred_preview(app, &req) else { return Err(req) };
    Ok(proxy::relay(app, req, preview, &path, &base(token)).await)
}

fn referred_preview(app: &Shared, req: &Request) -> Option<(Uuid, Preview, String)> {
    let path = req.uri().path();
    let excluded = ["/api", "/workspaces", "/sidecars", "/auth", "/login", "/previews"];
    if req.extensions().get::<crate::auth::Principal>().is_none()
        || path == "/"
        || excluded
            .iter()
            .any(|prefix| path == *prefix || path.strip_prefix(prefix).is_some_and(|s| s.starts_with('/')))
    {
        return None;
    }
    let host = req.headers().get(header::HOST)?.to_str().ok()?;
    let our_origin = format!("http://{host}");
    let referer = Url::parse(req.headers().get(header::REFERER)?.to_str().ok()?).ok()?;
    let token = path_token(referer.path())?;
    if referer.origin().ascii_serialization() != our_origin || !safe_request(req, Some(&our_origin)) {
        return None;
    }
    Some((token, lookup(app, token)?, path.to_owned()))
}

#[derive(Default)]
pub struct Previews {
    live: Mutex<HashMap<Uuid, Preview>>,
    rewrites: rewrite::Budget,
    pub owners: backend::Owners,
    remote: remote::Remote,
}
#[derive(Clone)]
struct Preview {
    target: Url,
    until: CancellationToken,
    source_device: Option<crate::auth::Principal>,
}
pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/previews", post(create))
        .route("/api/previews/{token}", delete(remove))
        .route("/previews/{token}", any(content))
        .route("/previews/{token}/{*tail}", any(content))
        .merge(backend::routes())
        .merge(remote::routes())
}
impl Previews {
    pub fn close(&self) {
        self.remote.close();
        self.owners.close();
        for preview in self.live.lock().unwrap().values() {
            preview.until.cancel();
        }
    }
    pub fn revoke_devices(&self) {
        self.remote.revoke_devices();
        self.live.lock().unwrap().retain(|_, p| {
            if p.source_device.is_some() {
                p.until.cancel();
                false
            } else {
                true
            }
        });
    }
}
pub async fn sweep(app: Shared, stop: CancellationToken) {
    loop {
        tokio::select! {
            _ = stop.cancelled() => { app.previews.close(); return; }
            _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {
                app.previews.owners.reconcile(&app);
                if !device_allowed(&app) { app.previews.revoke_devices(); }
                app.previews.live.lock().unwrap().retain(|_,p| !p.until.is_cancelled());
            }
        }
    }
}
fn device_allowed(app: &crate::App) -> bool {
    app.devices.as_ref().is_some_and(|d| d.lock().unwrap().previews_allowed())
}
fn invalid_target(message: &str) -> Error {
    error(Status::BAD_REQUEST, message)
}
fn target(input: &str) -> Result<Url, Error> {
    static SCHEME: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").unwrap());
    let lower = input.to_ascii_lowercase();
    let http = lower.starts_with("http://") || lower.starts_with("https://");
    let implicit = Url::parse(&format!("http://{input}")).ok();
    let loopback = implicit
        .as_ref()
        .and_then(Url::host_str)
        .is_some_and(|h| matches!(h, "localhost" | "0.0.0.0" | "::1") || h == "127" || h.starts_with("127."));
    if SCHEME.is_match(input) && !http && !loopback {
        return Err(invalid_target("Preview URL must use HTTP or HTTPS"));
    }
    let input = if http { input.to_owned() } else { format!("{}://{input}", if loopback { "http" } else { "https" }) };
    let url = Url::parse(&input).map_err(|_| invalid_target("Invalid URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid_target("Preview URL must use HTTP or HTTPS"));
    }
    if !url.username().is_empty() || url.password().is_some_and(|s| !s.is_empty()) {
        return Err(invalid_target("Preview URL cannot include credentials"));
    }
    Ok(url)
}

fn parse(body: &Value) -> Result<(&str, &str), Error> {
    use serde::Serialize;
    #[derive(Serialize)]
    struct Issue {
        #[serde(skip_serializing_if = "Option::is_none")]
        expected: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        origin: Option<&'static str>,
        code: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        minimum: Option<u8>,
        #[serde(skip_serializing_if = "Option::is_none")]
        inclusive: Option<bool>,
        path: Vec<&'static str>,
        message: String,
    }
    let mut issues = Vec::new();
    let ty = |entry: Option<&Value>| match entry {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    };
    let type_error = |expected, path, received| Issue {
        expected: Some(expected),
        origin: None,
        code: "invalid_type",
        minimum: None,
        inclusive: None,
        path,
        message: format!("Invalid input: expected {expected}, received {received}"),
    };
    let small = |origin, key, word| Issue {
        expected: None,
        origin: Some(origin),
        code: "too_small",
        minimum: Some(1),
        inclusive: Some(true),
        path: vec![key],
        message: format!("Too small: expected {origin} to have >=1 {word}"),
    };
    if !body.is_object() {
        issues.push(type_error("object", vec![], ty(Some(body))));
    } else {
        for key in ["sessionId", "url"] {
            let value = body.get(key);
            match value.and_then(Value::as_str).map(js_trim) {
                Some("") => issues.push(small("string", key, "characters")),
                None => {
                    issues.push(type_error("string", vec![key], ty(value)));
                    if value.and_then(Value::as_array).is_some_and(Vec::is_empty) {
                        issues.push(small("array", key, "items"));
                    }
                }
                _ => {}
            }
        }
    }
    if issues.is_empty() {
        Ok((js_trim(body["sessionId"].as_str().unwrap()), js_trim(body["url"].as_str().unwrap())))
    } else {
        Err(invalid_target(&serde_json::to_string_pretty(&issues).unwrap()))
    }
}
async fn create(State(app): State<Shared>, request: Request) -> Result<Json<Value>, Error> {
    let source_device = if crate::auth::tls::https_only(&request).is_some() {
        if !device_allowed(&app) {
            return Err(error(Status::NOT_FOUND, "Not found"));
        }
        Some(request.extensions().get::<crate::auth::Principal>().cloned().ok_or_else(crate::auth::unauthorized)?)
    } else {
        None
    };
    let (head, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .map_err(|_| error(Status::PAYLOAD_TOO_LARGE, "Request body is too large"))?;
    let body = match fastify::body(&head.headers, &bytes)? {
        None | Some(fastify::Body::Json(Value::Null)) => json!({}),
        Some(fastify::Body::Json(v)) => v,
        Some(fastify::Body::Text(s)) => json!(s),
    };
    let (session, url) = parse(&body)?;
    let target = target(url)?;
    if let Some(principal) = &source_device {
        principal.live()?;
        if !device_allowed(&app) {
            return Err(error(Status::NOT_FOUND, "Not found"));
        }
    }
    let token = Uuid::new_v4();
    let proxy_url =
        format!("{}{}{}{}", base(token), target.path(), suffix('?', target.query()), suffix('#', target.fragment()));
    let answer =
        json!({"token":token,"sessionId":session,"targetUrl":target.as_str(),"proxyUrl":proxy_url,"createdAt":now()});
    let until = source_device.as_ref().map_or_else(CancellationToken::new, |p| p.0.child_token());
    app.previews.live.lock().unwrap().insert(token, Preview { target, until, source_device });
    Ok(Json(answer))
}
async fn remove(State(app): State<Shared>, Path(token): Path<String>) -> Result<Status, Error> {
    let preview = id(&token).and_then(|token| app.previews.live.lock().unwrap().remove(&token));
    let preview = preview.ok_or_else(|| error(Status::NOT_FOUND, "Preview not found"))?;
    preview.until.cancel();
    Ok(Status::NO_CONTENT)
}

fn id(value: &str) -> Option<Uuid> {
    let token = value.parse::<Uuid>().ok()?;
    (token.hyphenated().to_string() == value).then_some(token)
}
fn base(token: Uuid) -> String {
    format!("/previews/{token}")
}
fn suffix(marker: char, value: Option<&str>) -> String {
    value.filter(|s| !s.is_empty()).map_or_else(String::new, |s| format!("{marker}{s}"))
}
fn path_token(path: &str) -> Option<Uuid> {
    let token = path.strip_prefix("/previews/")?.split('/').next()?;
    id(&decode_component(token)?)
}
fn host_token(host: &str, port: u16) -> Option<Uuid> {
    let (host, raw) = host.rsplit_once(':')?;
    let token = host.strip_suffix(".preview.localhost")?;
    (raw == port.to_string()).then(|| id(token)).flatten()
}
fn lookup(app: &Shared, token: Uuid) -> Option<Preview> {
    app.previews.live.lock().unwrap().get(&token).cloned()
}
fn not_found() -> Response {
    error(Status::NOT_FOUND, "Preview not found").into_response()
}
async fn content(State(app): State<Shared>, request: Request) -> Response {
    let Some(token) = path_token(request.uri().path()) else { return not_found() };
    let Some(preview) = lookup(&app, token) else { return not_found() };
    let original = request.uri().path();
    let tail = original.strip_prefix("/previews/").and_then(|p| p.split_once('/')).map_or("", |(_, t)| t);
    let path = if proxy::upgrade(&request) {
        Some(tail.to_owned())
    } else {
        decode_component(tail).map(|s| s.replace('%', "%25"))
    };
    let Some(path) = path else { return invalid_target("Invalid request").into_response() };
    proxy::relay(&app, request, preview, &path, &base(token)).await
}

/// Select content before the application's source-policy hook. Exclusive origins are content-only;
/// path capabilities may bypass the password solely on their exact live proxy route.
pub async fn admit_local(State(app): State<Shared>, req: Request, next: Next) -> Response {
    let h = req.headers();
    let host = h.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    let request_path = req.uri().path();
    if h.get_all(header::HOST).iter().count() == 1
        && let Some(token) = host_token(host, app.port)
    {
        // Host-based capabilities do not admit application controls or shared UI assets.
        if !safe_request(&req, Some(&format!("http://{host}")))
            || ["/api", "/workspaces", "/sidecars", "/auth", "/login", "/previews"].iter().any(|prefix| {
                request_path == *prefix || request_path.strip_prefix(prefix).is_some_and(|s| s.starts_with('/'))
            })
        {
            return not_found();
        }
        let Some(preview) = lookup(&app, token) else { return not_found() };
        let path = if proxy::upgrade(&req) {
            Some(request_path.to_owned())
        } else {
            decode_component(request_path).map(|p| p.replace('%', "%25"))
        };
        let Some(path) = path else { return invalid_target("Invalid request").into_response() };
        return proxy::relay(&app, req, preview, &path, "").await;
    }
    if path_token(request_path).is_some_and(|token| lookup(&app, token).is_some()) {
        if ![format!("127.0.0.1:{}", app.port), format!("localhost:{}", app.port)].iter().any(|h| h == host)
            || !safe_request(&req, Some(&format!("http://{host}")))
        {
            return not_found();
        }
        // Call the content handler directly, without turning the token into a general app principal.
        return content(State(app), req).await;
    }
    next.run(req).await
}
/// TLS host is already verified by the remote gate. No cookie reaches content or opens UI routes.
pub async fn admit_remote(app: &Shared, req: Request) -> Response {
    let Some(token) = path_token(req.uri().path()) else {
        return not_found();
    };
    let req = match remote::path(app, req, token).await {
        Ok(response) => return response,
        Err(req) => req,
    };
    let Some(channel) = crate::auth::tls::https_only(&req) else {
        return not_found();
    };
    if !channel.ingress
        || !device_allowed(app)
        || !safe_request(&req, Some(&channel.origin))
        || !lookup(app, token).is_some_and(|p| !p.until.is_cancelled())
    {
        return not_found();
    }
    content(State(app.clone()), req).await
}
fn safe_request(req: &Request, own: Option<&str>) -> bool {
    let headers = req.headers();
    req.uri().scheme().is_none()
        && req.uri().authority().is_none()
        && req.uri().path().starts_with('/')
        && !req.uri().path().starts_with("//")
        && !req.uri().path().contains(['#', '\\'])
        && headers.get_all(header::HOST).iter().count() == 1
        && headers.get_all(header::ORIGIN).iter().count() <= 1
        && !headers.contains_key("service-worker")
        && !crate::auth::AUTHORITY_HEADERS.iter().any(|h| headers.contains_key(*h))
        && headers.get(header::ORIGIN).is_none_or(|source| source == "null" || own.is_some_and(|own| source == own))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_targets_are_http_and_credential_free() {
        assert_eq!(target("localhost:3000/app?q=yes").unwrap().as_str(), "http://localhost:3000/app?q=yes");
        assert_eq!(target("example.test/game").unwrap().as_str(), "https://example.test/game");
        for bad in ["https://user:pass@example.test", "file:///C:/foo", "javascript:alert(1)"] {
            assert!(target(bad).is_err());
        }
    }

    #[test]
    fn content_admission_has_no_general_origin_or_worker_exception() {
        let request = |origin, worker| {
            let mut builder = axum::http::Request::builder().uri("/previews/test").header("host", "localhost:3000");
            if let Some(origin) = origin {
                builder = builder.header("origin", origin);
            }
            if worker {
                builder = builder.header("service-worker", "script");
            }
            builder.body(axum::body::Body::empty()).unwrap()
        };
        let origin = Some("http://localhost:3000");
        assert!(safe_request(&request(None, false), origin));
        assert!(safe_request(&request(Some("null"), false), origin));
        assert!(safe_request(&request(origin, false), origin));
        assert!(!safe_request(&request(Some("http://localhost:3001"), false), origin));
        assert!(!safe_request(&request(origin, true), origin));
    }
}
