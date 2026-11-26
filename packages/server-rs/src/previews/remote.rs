//! Remote preview capabilities: isolated loopback origin or a principal-bound opaque path.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
    routing::post,
};
use futures_util::StreamExt;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::{net::TcpListener, sync::OnceCell};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    backend::{self, Generation},
    base, proxy, rewrite, suffix,
};
use crate::{
    Shared,
    auth::{Principal, tls},
    shared::js_trim,
};

#[derive(Default)]
pub struct Remote {
    records: Mutex<HashMap<Uuid, Arc<Record>>>,
    pending: Mutex<usize>,
    port: OnceCell<u16>,
    stop: CancellationToken,
    budget: rewrite::Budget,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    token: Uuid,
    session_id: String,
    target_url: String,
    proxy_url: String,
    created_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Create {
    session_id: String,
    url: String,
}
struct Device {
    id: Uuid,
    host: String,
    ingress: bool,
}
struct Record {
    source: Source,
    generation: Arc<Generation>,
    embedding: Option<String>,
    device: Option<Device>,
    signal: CancellationToken,
}
impl Record {
    fn current(&self, app: &Shared) -> bool {
        !self.signal.is_cancelled()
            && self.generation.current(app)
            && self
                .device
                .as_ref()
                .is_none_or(|d| app.remote_control.is_preview_device_authorized(app, d.id, &d.host, d.ingress))
    }
}
impl Remote {
    pub fn listener_port(&self) -> Option<u16> {
        self.port.get().copied()
    }
    async fn listen(&self, app: &Shared) -> Option<u16> {
        self.port
            .get_or_try_init(|| async {
                let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
                let port = listener.local_addr()?.port();
                let stop = self.stop.clone();
                let router = Router::new().fallback(isolated).with_state(app.clone());
                tokio::spawn(async move {
                    let _ = axum::serve(listener, router).with_graceful_shutdown(stop.cancelled_owned()).await;
                });
                Ok::<u16, std::io::Error>(port)
            })
            .await
            .ok()
            .copied()
    }
    pub fn close(&self) {
        self.stop.cancel();
        for r in self.records.lock().unwrap().values() {
            r.signal.cancel();
        }
    }
    pub fn revoke_devices(&self) {
        for record in self.records.lock().unwrap().values() {
            if record.device.is_some() {
                record.signal.cancel();
            }
        }
    }
    pub fn revoke_tunnel_devices(&self) {
        for record in self.records.lock().unwrap().values() {
            if record.device.as_ref().is_some_and(|d| d.ingress) {
                record.signal.cancel();
            }
        }
    }
    pub fn revoke_device(&self, id: Uuid) {
        for record in self.records.lock().unwrap().values() {
            if record.device.as_ref().is_some_and(|device| device.id == id) {
                record.signal.cancel();
            }
        }
    }
}
pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/backends/{id}/preview-capabilities", post(create).delete(detach))
        .route("/api/backends/{id}/preview-capabilities/{capability}", axum::routing::delete(remove))
}

fn device(req: &Request) -> Option<Device> {
    let channel = tls::https_only(req)?;
    let id = (*channel.principal.lock().unwrap())?;
    let host = req.headers().get(header::HOST)?.to_str().ok()?.to_owned();
    Some(Device { id, host, ingress: channel.ingress })
}
async fn create(State(app): State<Shared>, Path(id): Path<String>, request: Request) -> Response {
    if !backend::guard(&app, &request) {
        return backend::deny();
    }
    let Some(proof) = backend::proof(request.headers()) else {
        return backend::refused();
    };
    let Some(generation) = app.previews.owners.exact(&app, &id, proof) else {
        return backend::refused();
    };
    let principal = request.extensions().get::<Principal>().unwrap().0.clone();
    let channel = tls::https_only(&request).is_some();
    let device = device(&request);
    if channel
        && !device
            .as_ref()
            .is_some_and(|d| app.remote_control.is_preview_device_authorized(&app, d.id, &d.host, d.ingress))
    {
        return backend::refused();
    }
    let embedding = (!channel)
        .then(|| request.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()).map(str::to_owned))
        .flatten();
    let remote = &app.previews.remote;
    let admission_epoch = request.extensions().get::<crate::auth::remote::DeviceAdmission>().copied();
    let logout_epoch = device.as_ref().map(|d| {
        admission_epoch
            .filter(|a| a.id == d.id)
            .map(|a| a.logout_epoch)
            .unwrap_or_else(|| app.previews.logout_epoch(d.id))
    });
    {
        let mut pending = remote.pending.lock().unwrap();
        if *pending + remote.records.lock().unwrap().len() >= 128 {
            return backend::refused();
        }
        *pending += 1;
    }
    struct Pending<'a>(&'a Mutex<usize>);
    impl Drop for Pending<'_> {
        fn drop(&mut self) {
            *self.0.lock().unwrap() -= 1;
        }
    }
    let _slot = Pending(&remote.pending);
    let signal = generation.preview_lifetime();
    let issue = async {
        if !request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| h.split(';').next().is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json")))
        {
            return None;
        }
        let bytes = axum::body::to_bytes(request.into_body(), 16 * 1024).await.ok()?;
        let body: Create = serde_json::from_slice(&bytes).ok()?;
        let session = js_trim(&body.session_id);
        let url = js_trim(&body.url);
        if session.is_empty()
            || session.encode_utf16().count() > 4096
            || url.is_empty()
            || url.encode_utf16().count() > 2048
        {
            return None;
        }
        let port = if channel { None } else { Some(remote.listen(&app).await?) };
        let response = backend::control(
            &app,
            &generation,
            Method::POST,
            "/api/previews",
            Some(json!({"sessionId":session,"url":url})),
        )
        .await?;
        if !response.status().is_success() {
            return None;
        }
        let document = crate::opencode::read_json(response, 16_384).await.ok()?;
        let source = serde_json::from_value::<Source>(document).ok()?;
        let target = Url::parse(&source.target_url).ok();
        let prefix = base(source.token);
        let valid = source.session_id == session
            && target.is_some_and(|u| {
                matches!(u.scheme(), "http" | "https") && u.username().is_empty() && u.password().is_none()
            })
            && source.proxy_url.strip_prefix(&prefix).is_some_and(|p| p.starts_with('/'))
            && !source.proxy_url.contains(['\\', '\0', '\r', '\n']);
        if !valid
            || !generation.current(&app)
            || signal.is_cancelled()
            || principal.is_cancelled()
            || channel
                && !device
                    .as_ref()
                    .is_some_and(|d| app.remote_control.is_preview_device_authorized(&app, d.id, &d.host, d.ingress))
        {
            cleanup(app.clone(), generation.clone(), source.token);
            return None;
        }
        let key = Uuid::new_v4();
        let renewed = match port {
            Some(port) => format!("http://{key}.preview.localhost:{port}{}", source.proxy_url),
            None => format!("{}{}", base(key), &source.proxy_url[prefix.len()..]),
        };
        let mut answer = serde_json::to_value(&source).ok()?;
        answer["capability"] = json!(key);
        answer["contentUrl"] = json!(renewed);
        let device_id = device.as_ref().map(|d| d.id);
        let record =
            Arc::new(Record { source, generation: generation.clone(), embedding, device, signal: signal.clone() });
        let inserted = {
            let mut records = remote.records.lock().unwrap();
            let logged_out = device_id.is_some_and(|id| app.previews.logout_epoch(id) != logout_epoch.unwrap_or(0));
            if logged_out {
                false
            } else {
                records.insert(key, record.clone());
                true
            }
        };
        if !inserted {
            cleanup(app.clone(), generation.clone(), record.source.token);
            return None;
        }
        let app = app.clone();
        let owner = record.signal.clone();
        let shutdown = remote.stop.clone();
        tokio::spawn(async move {
            // Revocation cancels both active content connections and in-flight requests,
            // including local session logouts that cancel the issuing Principal token.
            tokio::select! {
                _ = owner.cancelled() => {},
                _ = shutdown.cancelled() => {},
                _ = principal.cancelled() => {},
            }
            revoke(&app, key);
        });
        Some(([(header::CACHE_CONTROL, "no-store")], Json(answer)).into_response())
    };
    tokio::select! {
        biased;
        _ = signal.cancelled() => backend::refused(),
        _ = remote.stop.cancelled() => backend::refused(),
        response = tokio::time::timeout(Duration::from_secs(10),issue) => response.ok().flatten().unwrap_or_else(backend::refused),
    }
}

fn cleanup(app: Shared, g: Arc<Generation>, token: Uuid) {
    tokio::spawn(async move {
        let _ = backend::control(&app, &g, Method::DELETE, &format!("/api/previews/{token}"), None).await;
    });
}
fn revoke(app: &Shared, id: Uuid) {
    let record = app.previews.remote.records.lock().unwrap().remove(&id);
    if let Some(record) = record {
        record.signal.cancel();
        cleanup(app.clone(), record.generation.clone(), record.source.token);
    }
}
async fn remove(State(app): State<Shared>, Path((id, token)): Path<(String, Uuid)>, request: Request) -> Response {
    if !backend::guard(&app, &request) {
        return backend::deny();
    }
    let Some(generation) = backend::proof(request.headers()).and_then(|p| app.previews.owners.exact(&app, &id, p))
    else {
        return backend::refused();
    };
    let caller = device(&request);
    let record = app.previews.remote.records.lock().unwrap().get(&token).cloned();
    if !record.is_some_and(|r| {
        Arc::ptr_eq(&r.generation, &generation)
            && match (&r.device, &caller) {
                (None, None) => true,
                (Some(owner), Some(caller)) => {
                    owner.id == caller.id && owner.host == caller.host && owner.ingress == caller.ingress
                }
                _ => false,
            }
    }) {
        return backend::refused();
    }
    revoke(&app, token);
    Status::NO_CONTENT.into_response()
}
async fn detach(State(app): State<Shared>, Path(id): Path<String>, request: Request) -> Response {
    if !backend::guard(&app, &request) || tls::https_only(&request).is_some() {
        return backend::deny();
    }
    let Some(g) = backend::proof(request.headers()).and_then(|p| app.previews.owners.exact(&app, &id, p)) else {
        return backend::refused();
    };
    g.detach();
    Status::NO_CONTENT.into_response()
}
fn absent() -> Response {
    (Status::NOT_FOUND, [(header::CONNECTION, "close"), (header::CONTENT_LENGTH, "0")]).into_response()
}
fn lookup(app: &Shared, id: Uuid) -> Option<Arc<Record>> {
    app.previews.remote.records.lock().unwrap().get(&id).cloned()
}
pub async fn path(app: &Shared, request: Request, token: Uuid) -> Result<Response, Request> {
    let Some(r) = lookup(app, token) else {
        return Err(request);
    };
    let Some(channel) = tls::https_only(&request) else {
        return Ok(absent());
    };
    if !r.device.as_ref().is_some_and(|d| {
        d.ingress == channel.ingress && request.headers().get(header::HOST).is_some_and(|h| h == d.host.as_str())
    }) {
        return Ok(absent());
    }
    Ok(content(app, request, token, r, "null", true).await)
}
async fn isolated(State(app): State<Shared>, request: Request) -> Response {
    let Some(port) = app.previews.remote.listener_port() else {
        return absent();
    };
    let Some((host, token)) = request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .and_then(|host| Some((host, super::host_token(host, port)?)))
    else {
        return absent();
    };
    let Some(r) = lookup(&app, token).filter(|r| r.device.is_none()) else {
        let mut response = absent();
        response.headers_mut().insert("clear-site-data", HeaderValue::from_static("\"storage\""));
        return response;
    };
    let origin = format!("http://{host}");
    content(&app, request, token, r, &origin, false).await
}
async fn content(app: &Shared, mut req: Request, key: Uuid, r: Arc<Record>, origin: &str, host_path: bool) -> Response {
    let h = req.headers();
    let websocket = proxy::upgrade(&req);
    let ok_origin = h.get(header::ORIGIN).is_some_and(|h| h == origin);
    if !r.current(app)
        || !super::safe_request(&req, Some(origin))
        || h.get(header::ORIGIN).is_some() && !ok_origin
        || h.contains_key(header::UPGRADE) && (!websocket || !ok_origin)
        || !crate::sidecars::proxy::routed(req.method())
    {
        return absent();
    }
    let host_prefix = base(key);
    let remote_prefix = base(r.source.token);
    let path = req.uri().path();
    let query = suffix('?', req.uri().query());
    let upstream = if host_path {
        let Some(tail) = path.strip_prefix(&host_prefix) else {
            return absent();
        };
        format!("{remote_prefix}{tail}{query}")
    } else if path == remote_prefix || path.strip_prefix(&remote_prefix).is_some_and(|p| p.starts_with('/')) {
        format!("{path}{query}")
    } else {
        format!("{remote_prefix}{path}{query}")
    };
    let Some(target) = r.generation.origin.join(&upstream).ok().filter(|url| {
        url.origin() == r.generation.origin.origin()
            && url.fragment().is_none()
            && (url.path() == remote_prefix
                || url.path().strip_prefix(&remote_prefix).is_some_and(|p| p.starts_with('/')))
            && url.path() == upstream.split('?').next().unwrap_or("")
    }) else {
        return absent();
    };
    let mut headers = HeaderMap::new();
    if !host_path {
        headers.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    }
    let own = HeaderValue::from_str(origin).unwrap();
    if req.method() == Method::OPTIONS
        && let Some(method) = h.get(header::ACCESS_CONTROL_REQUEST_METHOD)
    {
        if !ok_origin || method.is_empty() || method.len() > 20 || !method.as_bytes().iter().all(u8::is_ascii_uppercase)
        {
            return absent();
        }
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, own);
        headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, method.clone());
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            h.get(header::ACCESS_CONTROL_REQUEST_HEADERS).cloned().unwrap_or_else(|| HeaderValue::from_static("")),
        );
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return proxy::make(Status::NO_CONTENT, headers, Body::empty());
    }
    let mut outbound = HeaderMap::new();
    let ws_headers =
        ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"];
    let nominated = h
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|s| s.to_str().ok())
        .flat_map(|s| s.split(','))
        .map(|s| s.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();
    for (k, v) in h {
        let name = k.as_str();
        let keep = if websocket {
            ws_headers.contains(&name)
        } else {
            !nominated.iter().any(|n| n == name)
                && ![
                    "origin",
                    "authorization",
                    "proxy-authorization",
                    "cookie",
                    "cookie2",
                    "host",
                    "forwarded",
                    "x-real-ip",
                    "connection",
                    "keep-alive",
                    "proxy-connection",
                    "te",
                    "trailer",
                    "transfer-encoding",
                    "upgrade",
                    "referer",
                    "content-length",
                    "accept-encoding",
                    "expect",
                ]
                .contains(&name)
                && !["sec-", "x-forwarded-", "x-codenomad-", "x-opencode-"].iter().any(|p| name.starts_with(p))
        };
        if keep {
            outbound.append(k, v.clone());
        }
    }
    if websocket {
        outbound.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        outbound.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    } else {
        outbound.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    }
    let on_upgrade = websocket.then(|| hyper::upgrade::on(&mut req));
    let (head, body) = req.into_parts();
    let send = async {
        let client = proxy::pinned_client(app, &target, r.generation.skip_tls, false).await.ok()?;
        if !r.current(app) {
            return None;
        }
        let mut request = client.request(head.method.clone(), target.clone()).headers(outbound);
        if !matches!(head.method, Method::GET | Method::HEAD) && !websocket {
            request = request.body(reqwest::Body::wrap_stream(body.into_data_stream()));
        }
        request.send().await.ok()
    };
    let response = tokio::select! {
        biased;
        _ = r.signal.cancelled() => return absent(),
        res = tokio::time::timeout(Duration::from_secs(15),send) => match res { Ok(Some(res)) if r.current(app) => res, _ => return absent() },
    };
    let status = response.status();
    if let Some(on_upgrade) = on_upgrade {
        for key in
            ["upgrade", "connection", "sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"]
        {
            for v in response.headers().get_all(key) {
                headers.append(key, v.clone());
            }
        }
        if status == Status::SWITCHING_PROTOCOLS {
            return proxy::tunnel(response, headers, on_upgrade, r.signal.clone(), None).await;
        }
        return stream(status, headers, response, r.signal.clone());
    }
    let upstream = response.headers();
    let typ = upstream.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let encoding =
        upstream.get(header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()).unwrap_or("").trim().to_ascii_lowercase();
    let rewriting = host_path && rewrite::kind(&typ).is_some();
    if rewriting && (status == Status::PARTIAL_CONTENT || upstream.contains_key(header::CONTENT_RANGE)) {
        return absent();
    }
    for name in [
        "content-type",
        "content-disposition",
        "etag",
        "last-modified",
        "content-range",
        "accept-ranges",
        "access-control-allow-methods",
        "access-control-allow-headers",
    ] {
        if rewriting && ["etag", "last-modified", "content-range", "accept-ranges"].contains(&name) {
            continue;
        }
        if let Some(value) = upstream.get(name) {
            headers.insert(name, value.clone());
        }
    }
    if !rewriting && let Some(v) = upstream.get(header::CONTENT_ENCODING) {
        headers.insert(header::CONTENT_ENCODING, v.clone());
    }
    if let Some(location) = upstream.get(header::LOCATION) {
        let Some(url) = location.to_str().ok().and_then(|path| target.join(path).ok()) else {
            return absent();
        };
        if url.origin() != target.origin()
            || !(url.path() == remote_prefix
                || url.path().strip_prefix(&remote_prefix).is_some_and(|t| t.starts_with('/')))
        {
            return absent();
        }
        let prefix = if host_path { &host_prefix } else { &remote_prefix };
        let loc = format!(
            "{prefix}{}{}{}",
            &url.path()[remote_prefix.len()..],
            suffix('?', url.query()),
            suffix('#', url.fragment())
        );
        let Ok(loc) = HeaderValue::from_str(&loc) else {
            return absent();
        };
        headers.insert(header::LOCATION, loc);
    }
    let csp = if host_path {
        format!("{}; frame-ancestors 'self'", proxy::SANDBOX)
    } else {
        format!(
            "{} allow-same-origin; frame-ancestors 'self'{}",
            proxy::SANDBOX,
            r.embedding.as_ref().map(|o| format!(" {o}")).unwrap_or_default()
        )
    };
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_str(&csp).unwrap());
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static(if host_path { "no-referrer" } else { "same-origin" }),
    );
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, own);
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    if head.method == Method::HEAD || matches!(status.as_u16(), 204 | 205 | 304) {
        return proxy::make(status, headers, Body::empty());
    }
    if !rewriting {
        return stream(status, headers, response, r.signal.clone());
    }
    let budget = &app.previews.remote.budget;
    let Ok(total) = budget.total.clone().try_acquire_owned() else {
        return absent();
    };
    let buffered = async {
        let active = budget.active.clone().acquire_owned().await.ok()?;
        let doc = proxy::document(response, &encoding).await?;
        Some((active, rewrite::replace_prefix(doc, &typ, &remote_prefix, &host_prefix)?))
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let (active, bytes) = tokio::select! {
        biased;
        _ = r.signal.cancelled() => return absent(),
        r = tokio::time::timeout_at(deadline,buffered) => match r { Ok(Some(v))=>v,_=>return absent() },
    };
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
    let send = async_stream::stream! {
        let _hold = (total,active);
        if !r.signal.is_cancelled() && tokio::time::Instant::now() < deadline {
            yield Ok::<_,std::io::Error>(Bytes::from(bytes));
        }
    };
    proxy::make(status, headers, Body::from_stream(send))
}
fn stream(status: Status, headers: HeaderMap, response: reqwest::Response, signal: CancellationToken) -> Response {
    let body = async_stream::stream! {
        let mut stream = response.bytes_stream();
        loop {
            tokio::select! {
                biased;
                _ = signal.cancelled() => {
                    yield Err(std::io::Error::from(std::io::ErrorKind::ConnectionAborted));
                    break;
                }
                chunk = stream.next() => match chunk {
                    Some(chunk) => yield chunk.map_err(std::io::Error::other),
                    None => break,
                }
            }
        }
    };
    proxy::make(status, headers, Body::from_stream(body))
}
