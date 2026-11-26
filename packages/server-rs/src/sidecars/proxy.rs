//! `/sidecars/:id/*` (`proxySideCarRequest`, `proxySideCarWebSocketUpgrade`, `proxy-websocket.ts`,
//! `proxy-cookies.ts`): HTTP and WebSocket relays to 127.0.0.1 behind the local session and source
//! checks, application cookies filtered both ways, never to this server's own listeners. Served on
//! the loopback listener only, as the reference keeps SideCars host-only.
use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
    routing::any,
};
use hyper_util::rt::TokioIo;
use reqwest::Url;
use serde_json::json;
use tokio::net::TcpStream;
use tokio_util::either::Either;

use super::{SideCar, base, get_one, target_path};
use crate::{
    Shared, auth,
    shared::{decode_component, fastify},
};

pub fn routes(ui: Arc<crate::host::ui::Source>) -> Router<Shared> {
    Router::new()
        .route(
            "/sidecars",
            any(|axum::Extension(ui): axum::Extension<Arc<crate::host::ui::Source>>, request: Request| async move {
                unrouted(&ui, request).await
            }),
        )
        .route("/sidecars/", any(relay))
        .route("/sidecars/{*rest}", any(relay))
        .layer(axum::Extension(ui))
}

/// Fastify uses the UI fallback for unmatched SideCar paths when the bundle exists.
async fn unrouted(ui: &crate::host::ui::Source, request: Request) -> Response {
    use crate::host::ui::Source;
    let serves_ui = match ui {
        Source::Dev(_) => true,
        Source::Dir(dir, _) => dir.is_dir(),
        Source::Absent => false,
    };
    if serves_ui {
        return crate::host::ui::serve(ui, request).await;
    }
    let target = request.uri().path_and_query().map_or("/", |p| p.as_str());
    let message = format!("Route {}:{target} not found", request.method());
    (Status::NOT_FOUND, Json(json!({"message": message, "error": "Not Found", "statusCode": 404}))).into_response()
}

fn failure(status: Status, text: &str) -> Response {
    (status, Json(json!({"error": text}))).into_response()
}
fn proxy_failed(status: Status) -> Response {
    failure(status, "SideCar proxy failed")
}
/// `rejectUpgrade`: an empty answer that closes the connection.
fn reject(status: Status) -> Response {
    (status, [(header::CONNECTION, "close"), (header::CONTENT_LENGTH, "0")]).into_response()
}

fn reserved(name: &str, session: &str) -> bool {
    // Desktop backends name their cookie codenomad_session_<process>_<time>, and cookies ignore ports.
    name == session
        || name == auth::DEFAULT_COOKIE
        || name.starts_with("codenomad_session_")
        || name == auth::devices::COOKIE
}
fn cookie_name(pair: &str) -> &str {
    pair.split('=').next().unwrap_or("").trim()
}
/// `sidecarRequestCookies`: the application's own cookies never reach a SideCar.
fn request_cookies(headers: &HeaderMap, session: &str) -> Option<String> {
    let joined: Vec<_> = headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).collect();
    let kept: Vec<_> = joined
        .join("; ")
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty() && !reserved(cookie_name(part), session))
        .map(str::to_owned)
        .collect();
    (!kept.is_empty()).then(|| kept.join("; "))
}
/// `sidecarResponseCookies`: nor can a SideCar set them (or a malformed, nameless cookie).
fn response_cookies(headers: &mut HeaderMap, session: &str) {
    headers.remove("set-cookie2");
    let kept: Vec<_> = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter(|value| {
            let pair = value.as_bytes().split(|b| *b == b';').next().unwrap_or_default();
            let pair = String::from_utf8_lossy(pair);
            let name = cookie_name(&pair);
            pair.find('=').is_some_and(|at| at > 0)
                && !name.is_empty()
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
                && !reserved(name, session)
        })
        .cloned()
        .collect();
    headers.remove(header::SET_COOKIE);
    for value in kept {
        headers.append(header::SET_COOKIE, value);
    }
}

/// `sanitizeSideCarProxyRequestHeaders`, plus what reply-from and undici drop from a relayed request.
fn request_headers(source: &HeaderMap, target: &Url, session: &str, upgrade: bool) -> HeaderMap {
    const BLOCKED: [&str; 9] = [
        "host",
        "expect",
        "authorization",
        "proxy-authorization",
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-port",
        "x-forwarded-proto",
    ];
    let mut dropped: Vec<String> = BLOCKED.iter().map(|s| s.to_string()).collect();
    if !upgrade {
        // reply-from strips the client's Connection header and the names it lists; undici, Transfer-Encoding.
        dropped.push("connection".into());
        dropped.push("transfer-encoding".into());
        for value in source.get_all(header::CONNECTION).iter().filter_map(|v| v.to_str().ok()) {
            dropped.extend(value.split(',').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()));
        }
    }
    let mut headers = HeaderMap::new();
    for (name, value) in source {
        // An empty value is falsy, so the reference drops it.
        if !value.is_empty()
            && !dropped.iter().any(|d| d == name.as_str())
            && name != header::COOKIE
            && name != header::ORIGIN
        {
            headers.append(name, value.clone());
        }
    }
    if let Some(cookies) = request_cookies(source, session).and_then(|c| HeaderValue::from_str(&c).ok()) {
        headers.insert(header::COOKIE, cookies);
    }
    let origin = target.origin().ascii_serialization();
    headers.insert(header::ORIGIN, HeaderValue::from_str(&origin).unwrap());
    let host = target.host_str().unwrap_or_default();
    let host = target.port().map_or_else(|| host.to_owned(), |port| format!("{host}:{port}"));
    headers.insert(header::HOST, HeaderValue::from_str(&host).unwrap());
    headers
}

/// `rewriteSideCarResponseHeaders`: a stripped SideCar's redirects stay under its public path.
fn rewrite_location(headers: &mut HeaderMap, record: &SideCar, origin: &str) {
    if record.prefix_mode == "preserve" {
        return;
    }
    let Some(location) = headers.get(header::LOCATION).and_then(|v| v.to_str().ok()).map(str::to_owned) else { return };
    let base = base(&record.id);
    let next = if location.starts_with('/') {
        Some(format!("{base}{location}"))
    } else {
        Url::parse(&location).ok().filter(|u| u.origin().ascii_serialization() == origin).map(|u| {
            let part = |prefix: char, v: Option<&str>| {
                v.filter(|v| !v.is_empty()).map(|v| format!("{prefix}{v}")).unwrap_or_default()
            };
            format!("{base}{}{}{}", u.path(), part('?', u.query()), part('#', u.fragment()))
        })
    };
    if let Some(value) = next.and_then(|n| HeaderValue::from_str(&n).ok()) {
        headers.insert(header::LOCATION, value);
    }
}

/// JS `decodeURI` as `routedPath` applies it (reserved escapes and `%25` kept); `None` when malformed.
fn decode_uri(path: &str) -> Option<String> {
    let (bytes, mut out, mut i) = (path.as_bytes(), Vec::new(), 0);
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = |at: usize| bytes.get(at).and_then(|b| (*b as char).to_digit(16));
            let byte = (hex(i + 1)? << 4 | hex(i + 2)?) as u8;
            if b";/?:@&=+$,#%".contains(&byte) {
                out.extend_from_slice(&bytes[i..i + 3]);
            } else {
                out.push(byte);
            }
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `blocksHostProxyTarget` and the connector's `proxyDestination`: a SideCar on one of this server's
/// ports never reaches it (`Not found` for its API and host-only paths, a failed proxy otherwise).
fn own_listener(app: &crate::App, target: &Url) -> Option<Response> {
    let port = target.port_or_known_default()?;
    let https = app.meta["remotePort"].as_u64().is_some_and(|p| p == u64::from(port));
    let ingress = app.remote_control.ingress_port() == Some(port);
    if port != app.port && !https && !ingress {
        return None;
    }
    let api = decode_uri(target.path()).is_none_or(|p| {
        p.starts_with("/api/")
            || p == "/api"
            || p.starts_with("/workspaces/")
            || p == "/login"
            || ["/auth/", "/sidecars/", "/previews/"].iter().any(|x| p.starts_with(x) || format!("{p}/") == *x)
    });
    Some(if port == app.port && api {
        failure(Status::NOT_FOUND, "Not found")
    } else {
        proxy_failed(Status::NOT_FOUND)
    })
}

/// Node's CA roots plus `NODE_EXTRA_CA_CERTS`. Public authorities never certify 127.0.0.1, so only
/// the extra file can make an HTTPS SideCar verify, as for the reference.
static TLS: LazyLock<tokio_rustls::TlsConnector> = LazyLock::new(|| {
    let mut roots = rustls::RootCertStore::empty();
    if let Some(file) = std::env::var_os("NODE_EXTRA_CA_CERTS").and_then(|p| std::fs::File::open(p).ok()) {
        for cert in rustls_pemfile::certs(&mut std::io::BufReader::new(file)).flatten() {
            let _ = roots.add(cert);
        }
    }
    let config = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
    tokio_rustls::TlsConnector::from(Arc::new(config))
});

type Io = Either<TcpStream, tokio_rustls::client::TlsStream<TcpStream>>;
/// undici's 10 s connect budget, TLS included.
async fn dial(target: &Url) -> std::io::Result<Io> {
    let port = target.port_or_known_default().unwrap_or(0);
    let connect = async {
        let tcp = TcpStream::connect(("127.0.0.1", port)).await?;
        if target.scheme() != "https" {
            return Ok(Either::Left(tcp));
        }
        let name = rustls::pki_types::ServerName::IpAddress(std::net::Ipv4Addr::LOCALHOST.into());
        Ok(Either::Right(TLS.connect(name, tcp).await?))
    };
    tokio::time::timeout(Duration::from_secs(10), connect).await.map_err(std::io::Error::other)?
}

async fn send(target: &Url, request: axum::http::Request<Body>) -> Result<Response<hyper::body::Incoming>, ()> {
    let io = dial(target).await.map_err(|_| ())?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(io)).await.map_err(|_| ())?;
    tokio::spawn(connection.with_upgrades());
    sender.send_request(request).await.map_err(|_| ())
}

fn origin_form(target: &Url) -> String {
    match target.query() {
        Some(query) => format!("{}?{query}", target.path()),
        None => target.path().to_owned(),
    }
}

fn upgrade_requested(headers: &HeaderMap) -> bool {
    headers.contains_key(header::UPGRADE)
        && headers
            .get_all(header::CONNECTION)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .any(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")))
}

/// JavaScript truthiness of a parsed JSON body (reply-from forwards only a truthy one).
fn truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        serde_json::Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The request body Fastify parsed for the SideCar scope, re-encoded as reply-from sends it:
/// `None` keeps the client's framing headers and sends nothing.
async fn body(method: &Method, headers: &HeaderMap, body: Body) -> Result<Option<(Vec<u8>, &'static str)>, Response> {
    const BODYLESS: [&str; 4] = ["GET", "HEAD", "TRACE", "UNLOCK"];
    if BODYLESS.contains(&method.as_str()) {
        return Ok(None);
    }
    let bytes = to_bytes(body, 1024 * 1024).await.map_err(|_| {
        fastify::error(Status::PAYLOAD_TOO_LARGE, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large")
            .into_response()
    })?;
    let framed = headers.contains_key(header::CONTENT_LENGTH) || headers.contains_key(header::TRANSFER_ENCODING);
    let json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json"));
    // `framesNoBody`: a bodiless DELETE or OPTIONS passes as such even when it declares JSON.
    if matches!(*method, Method::DELETE | Method::OPTIONS) && !framed && json {
        return Ok(None);
    }
    if !headers.contains_key(header::CONTENT_TYPE)
        && !headers.contains_key(header::TRANSFER_ENCODING)
        && headers.get(header::CONTENT_LENGTH).is_none_or(|v| v == "0")
    {
        return Ok(None);
    }
    Ok(match fastify::body(headers, &bytes).map_err(IntoResponse::into_response)? {
        Some(fastify::Body::Json(value)) if truthy(&value) => {
            let text = crate::missions::activity::ojson::parse(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes))
                .map(|v| v.stringify())
                .unwrap_or_default();
            Some((text.into_bytes(), "application/json"))
        }
        Some(fastify::Body::Text(text)) if !text.is_empty() => Some((text.into_bytes(), "text/plain")),
        _ => None,
    })
}

/// Methods the reference's router serves: Fastify's own and the proxied WebDAV, CalDAV and SEARCH ones.
pub(crate) fn routed(method: &Method) -> bool {
    const METHODS: [&str; 19] = [
        "GET",
        "HEAD",
        "TRACE",
        "DELETE",
        "OPTIONS",
        "PATCH",
        "PUT",
        "POST",
        "QUERY",
        "PROPFIND",
        "PROPPATCH",
        "MKCOL",
        "COPY",
        "MOVE",
        "LOCK",
        "UNLOCK",
        "SEARCH",
        "REPORT",
        "MKCALENDAR",
    ];
    METHODS.contains(&method.as_str())
}

async fn relay(
    State(app): State<Shared>,
    axum::Extension(ui): axum::Extension<Arc<crate::host::ui::Source>>,
    request: Request,
) -> Response {
    if upgrade_requested(request.headers()) {
        return websocket(app, request).await;
    }
    if !routed(request.method()) {
        return unrouted(&ui, request).await;
    }
    // The router's path ends at the first `;` (`useSemicolonDelimiter`); its parameters arrive decoded.
    let path = request.uri().path().split(';').next().unwrap_or("");
    let rest = path.strip_prefix("/sidecars/").unwrap_or("");
    let (id, suffix) = rest.split_once('/').unwrap_or((rest, ""));
    // find-my-way's `maxParamLength`: a longer `:id` matches no route.
    if id.len() > 100 {
        return unrouted(&ui, request).await;
    }
    let (Some(id), Some(suffix)) = (decode_component(id), decode_component(suffix)) else {
        return (Status::BAD_REQUEST, [(header::CONNECTION, "close")], Json(json!({"error": "Invalid request"})))
            .into_response();
    };
    let Some(record) = get_one(&app, &id).await else { return failure(Status::NOT_FOUND, "SideCar not found") };
    let base = base(&id);
    // `reencodePercent`: a literal `%` stays one in the target.
    let request_path = match suffix.replace('%', "%25") {
        s if s.is_empty() => base,
        s => format!("{base}/{}", s.trim_start_matches('/')),
    };
    let search = request.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let origin = format!("{}://127.0.0.1:{}", if record.insecure { "http" } else { "https" }, record.port);
    let Ok(target) = Url::parse(&format!("{origin}{}", target_path(&record, &request_path, &search))) else {
        return fastify::error(Status::INTERNAL_SERVER_ERROR, "ERR_INVALID_URL", "Invalid URL").into_response();
    };
    if let Some(refused) = own_listener(&app, &target) {
        return refused;
    }
    let (parts, incoming) = request.into_parts();
    let mut headers = request_headers(&parts.headers, &target, app.auth.cookie_name(), false);
    let payload = match body(&parts.method, &parts.headers, incoming).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let payload = match payload {
        Some((bytes, kind)) => {
            headers.insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(kind));
            Body::from(bytes)
        }
        None => {
            // undici frames an empty body itself: `Content-Length: 0` only where a payload is expected.
            headers.remove(header::CONTENT_LENGTH);
            if matches!(parts.method, Method::POST | Method::PUT | Method::PATCH) {
                headers.insert(header::CONTENT_LENGTH, HeaderValue::from(0));
            }
            Body::empty()
        }
    };
    let mut upstream = axum::http::Request::builder().method(parts.method).uri(origin_form(&target));
    *upstream.headers_mut().unwrap() = headers;
    let Ok(response) = send(&target, upstream.body(payload).unwrap()).await else {
        return proxy_failed(Status::BAD_GATEWAY);
    };
    let (mut head, incoming) = response.into_parts();
    for name in [header::TRANSFER_ENCODING, header::CONNECTION, HeaderName::from_static("keep-alive")] {
        head.headers.remove(name);
    }
    rewrite_location(&mut head.headers, &record, &target.origin().ascii_serialization());
    response_cookies(&mut head.headers, app.auth.cookie_name());
    head.extensions = Default::default();
    head.extensions.insert(crate::opencode::NativeBody);
    Response::from_parts(head, Body::new(incoming))
}

/// The upgrade path: `parseSideCarUpgradePath` on the URL parser's path, the handshake relayed
/// through a parsed response (its cookies filtered), then both sockets piped.
async fn websocket(app: Shared, mut request: Request) -> Response {
    let raw = request.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let Some(parsed) = Url::parse("http://localhost/").ok().and_then(|b| b.join(raw).ok()) else {
        return reject(Status::NOT_FOUND);
    };
    let pattern = regex::Regex::new(r"^/sidecars/([^/]+)(?:/.*)?$").unwrap();
    let Some(id) = pattern.captures(parsed.path()).and_then(|c| decode_component(&c[1])) else {
        return reject(Status::NOT_FOUND);
    };
    if !request.headers().get(header::UPGRADE).is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket")) {
        return reject(Status::BAD_REQUEST);
    }
    let Some(record) = get_one(&app, &id).await else { return reject(Status::NOT_FOUND) };
    let search = parsed.query().filter(|q| !q.is_empty()).map(|q| format!("?{q}")).unwrap_or_default();
    let origin = format!("{}://127.0.0.1:{}", if record.insecure { "http" } else { "https" }, record.port);
    let Ok(target) = Url::parse(&format!("{origin}{}", target_path(&record, parsed.path(), &search))) else {
        return reject(Status::BAD_GATEWAY);
    };
    if own_listener(&app, &target).is_some() {
        return reject(Status::NOT_FOUND);
    }
    let shutdown = app.events.shutdown.clone();
    if shutdown.is_cancelled() {
        return reject(Status::SERVICE_UNAVAILABLE);
    }
    let client = hyper::upgrade::on(&mut request);
    let mut upstream = axum::http::Request::builder().method(request.method().clone()).uri(origin_form(&target));
    *upstream.headers_mut().unwrap() = request_headers(request.headers(), &target, app.auth.cookie_name(), true);
    let handshake = tokio::select! {
        biased;
        _ = shutdown.cancelled() => return reject(Status::SERVICE_UNAVAILABLE),
        res = tokio::time::timeout(Duration::from_secs(15), send(&target, upstream.body(Body::empty()).unwrap())) => res,
    };
    let Ok(Ok(mut response)) = handshake else { return reject(Status::BAD_GATEWAY) };
    let server = (response.status() == Status::SWITCHING_PROTOCOLS).then(|| hyper::upgrade::on(&mut response));
    let (mut head, incoming) = response.into_parts();
    response_cookies(&mut head.headers, app.auth.cookie_name());
    head.extensions = Default::default();
    head.extensions.insert(crate::opencode::NativeBody);
    let Some(server) = server else {
        head.headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
        head.headers.remove(header::TRANSFER_ENCODING);
        return Response::from_parts(head, Body::new(incoming));
    };
    tokio::spawn(async move {
        let upgraded = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return,
            pair = async { (client.await, server.await) } => pair,
        };
        if let (Ok(client), Ok(server)) = upgraded {
            let mut client = TokioIo::new(client);
            let mut server = TokioIo::new(server);
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => {}
                _ = tokio::io::copy_bidirectional(&mut client, &mut server) => {}
            }
        }
    });
    Response::from_parts(head, Body::empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_cookies_stay_out_of_sidecars() {
        let mut headers = HeaderMap::new();
        headers.append(header::COOKIE, "codenomad_session=a; service_login=a=b%2Fc".parse().unwrap());
        headers.append(
            header::COOKIE,
            "codenomad_session_1_2=s; __Host-codenomad_device=d; custom=x; theme=dark".parse().unwrap(),
        );
        assert_eq!(request_cookies(&headers, "custom").as_deref(), Some("service_login=a=b%2Fc; theme=dark"));
        assert_eq!(request_cookies(&HeaderMap::new(), "custom"), None);
        let mut response = HeaderMap::new();
        for value in [
            "service_login=a=b%2Fc; HttpOnly; Path=/",
            "theme=dark; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
            "custom=injected; Path=/",
            "codenomad_session=x",
            "codenomad_session_9=x",
            "__Host-codenomad_device=x",
            "=nameless",
            "noequals",
            "bad name=x",
        ] {
            response.append(header::SET_COOKIE, value.parse().unwrap());
        }
        response.append("set-cookie2", "a=b".parse().unwrap());
        response_cookies(&mut response, "custom");
        let kept: Vec<_> = response.get_all(header::SET_COOKIE).iter().map(|v| v.to_str().unwrap()).collect();
        assert_eq!(
            kept,
            ["service_login=a=b%2Fc; HttpOnly; Path=/", "theme=dark; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/"]
        );
        assert!(!response.contains_key("set-cookie2"));
    }

    #[test]
    fn requests_lose_credentials_and_routing_headers() {
        let mut source = HeaderMap::new();
        for (name, value) in [
            ("authorization", "Basic x"),
            ("proxy-authorization", "x"),
            ("x-forwarded-for", "1"),
            ("forwarded", "for=1"),
            ("expect", "100-continue"),
            ("host", "127.0.0.1:1"),
            ("origin", "http://127.0.0.1:1"),
            ("connection", "keep-alive, x-drop"),
            ("x-drop", "1"),
            ("x-keep", "1"),
            ("cookie", "codenomad_session=a"),
        ] {
            source.append(name, value.parse().unwrap());
        }
        let target = Url::parse("http://127.0.0.1:3000/x").unwrap();
        let headers = request_headers(&source, &target, "codenomad_session", false);
        let mut names: Vec<_> = headers.keys().map(|k| k.as_str()).collect();
        names.sort();
        assert_eq!(names, ["host", "origin", "x-keep"]);
        assert_eq!(headers[header::ORIGIN], "http://127.0.0.1:3000");
        assert_eq!(headers[header::HOST], "127.0.0.1:3000");
        // A WebSocket handshake keeps its Connection and Upgrade headers.
        assert!(request_headers(&source, &target, "codenomad_session", true).contains_key("x-drop"));
    }

    #[test]
    fn redirects_and_host_paths() {
        let record = |mode| SideCar {
            id: "app".into(),
            kind: "port",
            name: "App".into(),
            port: 3000,
            insecure: true,
            prefix_mode: mode,
            status: "running",
            created_at: String::new(),
            updated_at: String::new(),
        };
        let location = |value: &str, mode| {
            let mut headers = HeaderMap::new();
            headers.insert(header::LOCATION, value.parse().unwrap());
            rewrite_location(&mut headers, &record(mode), "http://127.0.0.1:3000");
            headers[header::LOCATION].to_str().unwrap().to_owned()
        };
        assert_eq!(location("/login?x=1", "strip"), "/sidecars/app/login?x=1");
        assert_eq!(location("http://127.0.0.1:3000/a?b#c", "strip"), "/sidecars/app/a?b#c");
        assert_eq!(location("http://127.0.0.1:3000/a?", "strip"), "/sidecars/app/a");
        assert_eq!(location("https://example.test/a", "strip"), "https://example.test/a");
        assert_eq!(location("relative", "strip"), "relative");
        assert_eq!(location("/login", "preserve"), "/login");
        assert_eq!(decode_uri("/%61pi/%2Fx%25").as_deref(), Some("/api/%2Fx%25"));
        assert_eq!(decode_uri("/%FF"), None);
    }
}
