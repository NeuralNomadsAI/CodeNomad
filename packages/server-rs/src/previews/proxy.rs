//! Capability-only HTTP/WS transport, pinned to a checked upstream address.
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use hyper_util::rt::TokioIo;
use reqwest::{Client, Url, redirect::Policy};
use tokio::time::Instant;

use super::{Preview, rewrite, suffix};
use crate::{Shared, error};

pub(super) const SANDBOX: &str = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads";
const DERIVED: &[&str] = &[
    "content-length",
    "content-encoding",
    "etag",
    "last-modified",
    "content-range",
    "accept-ranges",
    "content-digest",
    "repr-digest",
    "digest",
    "content-md5",
];
fn found(status: Status, message: &str) -> Response {
    error(status, message).into_response()
}
fn bad() -> Response {
    found(Status::BAD_GATEWAY, "Preview proxy failed")
}
fn refused() -> Response {
    found(Status::NOT_FOUND, "Not found")
}
fn stop(status: Status) -> Response {
    (status, [(header::CONNECTION, "close"), (header::CONTENT_LENGTH, "0")]).into_response()
}

pub fn upgrade(req: &Request) -> bool {
    req.headers().get(header::UPGRADE).is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
        && req
            .headers()
            .get_all(header::CONNECTION)
            .iter()
            .filter_map(|s| s.to_str().ok())
            .any(|s| s.split(',').any(|h| h.trim().eq_ignore_ascii_case("upgrade")))
}
fn hop(headers: &mut HeaderMap) {
    let from_connection: Vec<_> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|h| HeaderName::from_bytes(h.trim().as_bytes()).ok())
        .collect();
    for k in from_connection {
        headers.remove(k);
    }
    for k in [
        "connection",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "proxy-authenticate",
        "proxy-authorization",
    ] {
        headers.remove(k);
    }
}
fn request_headers(req: &Request, url: &Url, websocket: bool) -> HeaderMap {
    let mut headers = req.headers().clone();
    hop(&mut headers);
    for k in [
        "host",
        "expect",
        "authorization",
        "cookie",
        "cookie2",
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-port",
        "x-forwarded-proto",
        "x-real-ip",
        "referer",
        "content-length",
    ] {
        headers.remove(k);
    }
    let private: Vec<_> = headers
        .keys()
        .filter(|name| {
            let n = name.as_str();
            n.starts_with("x-codenomad-")
                || n.starts_with("x-opencode-")
                || (!websocket && n.starts_with("sec-websocket-"))
        })
        .cloned()
        .collect();
    for k in private {
        headers.remove(k);
    }
    headers.insert(header::ORIGIN, url.origin().ascii_serialization().parse().unwrap());
    if websocket {
        headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    } else {
        headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    }
    headers
}
fn response_headers(mut headers: HeaderMap, url: &Url, base: &str, ws: bool, opaque: bool) -> HeaderMap {
    for k in ["set-cookie", "set-cookie2", "service-worker-allowed"] {
        headers.remove(k);
    }
    if ws {
        return headers;
    }
    hop(&mut headers);
    for k in [
        "x-frame-options",
        "content-security-policy",
        "content-security-policy-report-only",
        "access-control-allow-credentials",
    ] {
        headers.remove(k);
    }
    if !base.is_empty() {
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(SANDBOX));
        headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("same-origin"));
    }
    if opaque {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("null"));
        // Fastify's CORS hook applies to the proxy response. Neither direction carries cookies.
        headers.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true"));
    }
    let Some(location) = headers.get(header::LOCATION).and_then(|v| v.to_str().ok()) else { return headers };
    let origin = url.origin();
    let absolute = if location.starts_with("//") { url.join(location).ok() } else { Url::parse(location).ok() };
    let target = if let Some(target) = absolute {
        if target.origin() == origin {
            Some(format!("{base}{}{}{}", target.path(), suffix('?', target.query()), suffix('#', target.fragment())))
        } else if location.starts_with("//") {
            Some(target.to_string())
        } else {
            None
        }
    } else if location.starts_with('/') {
        Some(format!("{base}{location}"))
    } else {
        None
    };
    if let Some(location) = target.and_then(|t| HeaderValue::from_str(&t).ok()) {
        headers.insert(header::LOCATION, location);
    }
    headers
}
fn target(preview: &Preview, path: &str, query: Option<&str>) -> Option<Url> {
    let origin = preview.target.origin();
    let url = preview.target.join(&format!("/{}{}", path.trim_start_matches(['/', '\\']), suffix('?', query))).ok()?;
    (url.origin() == origin).then_some(url)
}
fn loopback_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).trim_end_matches('.');
    matches!(host, "localhost" | "0.0.0.0" | "::")
        || host.ends_with(".localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.to_canonical().is_loopback() || ip.is_unspecified())
}
fn backend_port(app: &Shared, port: u16) -> bool {
    app.port == port || app.meta["remotePort"].as_u64() == Some(u64::from(port))
}
async fn address(app: &Shared, host: &str, port: u16) -> Result<Vec<SocketAddr>, Status> {
    if host.trim_end_matches('.').to_ascii_lowercase().ends_with(".preview.localhost")
        || app.previews.remote.listener_port() == Some(port)
        || backend_port(app, port) && loopback_host(host)
    {
        return Err(Status::NOT_FOUND);
    }
    let host = host.trim_matches(['[', ']']);
    let answers = tokio::time::timeout(Duration::from_secs(10), tokio::net::lookup_host((host, port)))
        .await
        .map_err(|_| Status::BAD_GATEWAY)?
        .map_err(|_| Status::BAD_GATEWAY)?
        .collect::<Vec<_>>();
    if answers.is_empty() {
        return Err(Status::BAD_GATEWAY);
    }
    // A checked origin cannot be rebound after DNS. Reserve both server ports, including the non-loopback TLS bind.
    if backend_port(app, port) {
        return Err(Status::NOT_FOUND);
    }
    Ok(answers)
}
pub(super) async fn pinned_client(app: &Shared, target: &Url, skip_tls: bool, decode: bool) -> Result<Client, Status> {
    let host = target.host_str().ok_or(Status::BAD_GATEWAY)?;
    let port = target.port_or_known_default().ok_or(Status::BAD_GATEWAY)?;
    let addresses = address(app, host, port).await?;
    let mut client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .http1_only()
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(10))
        .danger_accept_invalid_certs(skip_tls);
    if !decode {
        client = client.no_gzip().no_deflate().no_brotli();
    }
    if let Some(file) = std::env::var_os("NODE_EXTRA_CA_CERTS")
        && let Ok(bytes) = tokio::fs::read(file).await
        && let Ok(certs) = reqwest::Certificate::from_pem_bundle(&bytes)
    {
        for cert in certs {
            client = client.add_root_certificate(cert);
        }
    }
    client.build().map_err(|_| Status::BAD_GATEWAY)
}

pub async fn relay(app: &Shared, mut request: Request, preview: Preview, path: &str, base: &str) -> Response {
    if !crate::sidecars::proxy::routed(request.method()) {
        return refused();
    }
    let upgrade = upgrade(&request);
    if request.headers().contains_key(header::UPGRADE) && !upgrade {
        return stop(Status::BAD_REQUEST);
    }
    let Some(target) = target(&preview, path, request.uri().query()) else { return refused() };
    let opaque = request.headers().get(header::ORIGIN).is_some_and(|h| h == "null");
    let headers = request_headers(&request, &target, upgrade);
    let on_upgrade = upgrade.then(|| hyper::upgrade::on(&mut request));
    let (parts, body) = request.into_parts();
    if parts.method == Method::OPTIONS
        && let Some(method) = parts.headers.get(header::ACCESS_CONTROL_REQUEST_METHOD)
    {
        if !opaque {
            return stop(Status::FORBIDDEN);
        }
        let mut reply = (
            Status::NO_CONTENT,
            [
                (header::ACCESS_CONTROL_ALLOW_ORIGIN, "null"),
                (header::ACCESS_CONTROL_ALLOW_METHODS, "GET,HEAD,PUT,PATCH,POST,DELETE"),
            ],
        )
            .into_response();
        if method.is_empty() {
            return stop(Status::BAD_REQUEST);
        }
        if let Some(requested) = parts.headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
            reply.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_HEADERS, requested.clone());
        }
        return reply;
    }
    let method = parts.method;
    let perform = async {
        let client = pinned_client(app, &target, false, false).await?;
        let mut req = client.request(method.clone(), target.clone()).headers(headers);
        if !matches!(method, Method::GET | Method::HEAD) && !upgrade {
            req = req.body(reqwest::Body::wrap_stream(body.into_data_stream()));
        }
        req.send().await.map_err(|_| Status::BAD_GATEWAY)
    };
    let response = tokio::select! {
        _ = preview.until.cancelled() => return refused(),
        result = tokio::time::timeout(Duration::from_secs(15), perform) => match result {
            Ok(Ok(r)) => r,
            Ok(Err(Status::NOT_FOUND)) => return if upgrade { stop(Status::NOT_FOUND) } else { refused() },
            _ => return if upgrade { stop(Status::BAD_GATEWAY) } else { bad() },
        },
    };
    let status = response.status();
    let mut headers = response_headers(response.headers().clone(), &target, base, upgrade, opaque);
    if let Some(on_upgrade) = on_upgrade {
        if status == Status::SWITCHING_PROTOCOLS {
            return tunnel(response, headers, on_upgrade, preview.until).await;
        }
        hop(&mut headers);
        headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
    }
    let mime = headers.get(header::CONTENT_TYPE).and_then(|h| h.to_str().ok()).unwrap_or("").to_owned();
    if !upgrade && let Some(kind) = rewrite::kind(&mime) {
        if status == Status::PARTIAL_CONTENT || headers.contains_key(header::CONTENT_RANGE) {
            let mut response = bad();
            let target = response.headers_mut();
            target.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
            for name in [header::CONTENT_SECURITY_POLICY, header::REFERRER_POLICY] {
                if let Some(value) = headers.remove(&name) {
                    target.insert(name, value);
                }
            }
            return response;
        }
        let encoding = headers
            .get(header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        for name in DERIVED {
            headers.remove(*name);
        }
        if method == Method::HEAD || matches!(status.as_u16(), 204 | 205 | 304) {
            let mut reply = status.into_response();
            *reply.headers_mut() = headers;
            return reply;
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        let budget = &app.previews.rewrites;
        let Ok(total) = budget.total.clone().try_acquire_owned() else { return bad() };
        let buffered = tokio::time::timeout_at(deadline, async {
            let active = budget.active.clone().acquire_owned().await.ok()?;
            let input = document(response, &encoding).await?;
            let bytes = rewrite::body(kind, &mime, &input, base, &target.origin().ascii_serialization())?;
            Some((active, bytes))
        });
        let (active, bytes) = tokio::select! {
            data = buffered => match data { Ok(Some(value)) => value, _ => return bad() },
            _ = preview.until.cancelled() => return refused(),
        };
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
        let until = preview.until;
        let stream = async_stream::stream! {
            let _hold = (total, active);
            if !until.is_cancelled() && Instant::now() < deadline { yield Ok::<_, std::io::Error>(bytes::Bytes::from(bytes)); }
        };
        return make(status, headers, Body::from_stream(stream));
    }
    make(status, headers, Body::from_stream(response.bytes_stream().take_until(preview.until.cancelled_owned())))
}

pub(super) async fn tunnel(
    response: reqwest::Response,
    headers: HeaderMap,
    upgrade: hyper::upgrade::OnUpgrade,
    until: tokio_util::sync::CancellationToken,
) -> Response {
    let Ok(mut upstream) = response.upgrade().await else { return stop(Status::BAD_GATEWAY) };
    tokio::spawn(async move {
        let Ok(peer) = upgrade.await else { return };
        let mut peer = TokioIo::new(peer);
        tokio::select! {
            biased;
            _ = until.cancelled() => {},
            _ = tokio::io::copy_bidirectional(&mut peer, &mut upstream) => {},
        }
    });
    make(Status::SWITCHING_PROTOCOLS, headers, Body::empty())
}

pub(super) fn make(status: Status, headers: HeaderMap, body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}
pub(super) async fn document(response: reqwest::Response, encoding: &str) -> Option<Vec<u8>> {
    use async_compression::tokio::bufread::{BrotliDecoder, GzipDecoder, ZlibDecoder};
    use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
    let input = BufReader::new(tokio_util::io::StreamReader::new(
        response.bytes_stream().map(|chunk| chunk.map_err(std::io::Error::other)),
    ));
    let stream: Box<dyn AsyncRead + Unpin + Send> = match encoding {
        "" | "identity" => Box::new(input),
        "gzip" | "x-gzip" => Box::new(GzipDecoder::new(input)),
        "deflate" => Box::new(ZlibDecoder::new(input)),
        "br" => Box::new(BrotliDecoder::new(input)),
        _ => return None,
    };
    let mut bytes = Vec::new();
    stream.take((rewrite::BYTES + 1) as u64).read_to_end(&mut bytes).await.ok()?;
    (bytes.len() <= rewrite::BYTES).then_some(bytes)
}
