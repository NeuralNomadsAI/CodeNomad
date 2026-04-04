use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use futures_util::TryStreamExt;
use rand::RngCore;
use reqwest::redirect::Policy;
use reqwest::Client;
use std::collections::HashSet;
use std::sync::Arc;
use url::Url;

const PROXY_COOKIE_NAME: &str = "codenomad_remote_proxy";
const PROXY_TOKEN_QUERY: &str = "proxy_token";

#[derive(Clone)]
struct ProxyState {
    client: Client,
    target_base_url: Url,
    local_base_url: Url,
    session_token: String,
}

/// TLS configuration for the local HTTPS proxy.
pub struct ProxyTlsConfig {
    pub cert_pem: String,
    pub key_pem: String,
}

pub struct RemoteProxyHandle {
    local_base_url: Url,
    entry_url: Url,
    target_base_url: Url,
    skip_tls_verify: bool,
    server_handle: axum_server::Handle,
}

impl RemoteProxyHandle {
    pub fn local_base_url(&self) -> &Url {
        &self.local_base_url
    }

    pub fn entry_url(&self) -> &Url {
        &self.entry_url
    }

    pub fn matches(&self, target_base_url: &Url, skip_tls_verify: bool) -> bool {
        self.target_base_url == *target_base_url && self.skip_tls_verify == skip_tls_verify
    }

    pub fn shutdown(&self) {
        self.server_handle.shutdown();
    }
}

impl Drop for RemoteProxyHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub async fn start_remote_proxy(
    target_base_url: Url,
    skip_tls_verify: bool,
    tls_config: Option<ProxyTlsConfig>,
) -> Result<RemoteProxyHandle, String> {
    let client = Client::builder()
        .redirect(Policy::none())
        .danger_accept_invalid_certs(skip_tls_verify)
        .build()
        .map_err(|err| err.to_string())?;

    // Pre-bind a std TcpListener on port 0 to discover the actual port
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|err| err.to_string())?;
    let address = std_listener.local_addr().map_err(|err| err.to_string())?;

    let scheme = if tls_config.is_some() { "https" } else { "http" };
    let local_base_url =
        Url::parse(&format!("{scheme}://{address}")).map_err(|err| err.to_string())?;
    let session_token = generate_session_token();
    let mut entry_url = local_base_url.clone();
    entry_url.set_query(Some(&format!("{PROXY_TOKEN_QUERY}={session_token}")));

    let state = Arc::new(ProxyState {
        client,
        target_base_url: target_base_url.clone(),
        local_base_url: local_base_url.clone(),
        session_token,
    });

    let app = Router::new()
        .route("/*path", any(proxy_request))
        .route("/", any(proxy_request))
        .with_state(state);

    let server_handle = axum_server::Handle::new();
    let handle_clone = server_handle.clone();

    if let Some(tls) = tls_config {
        let rustls_config =
            RustlsConfig::from_pem(tls.cert_pem.into_bytes(), tls.key_pem.into_bytes())
                .await
                .map_err(|err| format!("Failed to build RustlsConfig: {err}"))?;

        tauri::async_runtime::spawn(async move {
            let server = axum_server::from_tcp_rustls(std_listener, rustls_config)
                .handle(handle_clone)
                .serve(app.into_make_service());

            if let Err(err) = server.await {
                eprintln!("[tauri] remote proxy (HTTPS) stopped with error: {err}");
            }
        });
    } else {
        tauri::async_runtime::spawn(async move {
            let server = axum_server::from_tcp(std_listener)
                .handle(handle_clone)
                .serve(app.into_make_service());

            if let Err(err) = server.await {
                eprintln!("[tauri] remote proxy (HTTP) stopped with error: {err}");
            }
        });
    }

    Ok(RemoteProxyHandle {
        local_base_url,
        entry_url,
        target_base_url,
        skip_tls_verify,
        server_handle,
    })
}

async fn proxy_request(
    State(state): State<Arc<ProxyState>>,
    request: Request,
) -> Result<Response<Body>, StatusCode> {
    if !request_is_authorized(&request, &state.session_token) {
        if request_bootstraps_session(&request, &state.session_token) {
            return Ok(build_bootstrap_response(request.uri(), &state.session_token)?);
        }
        return Err(StatusCode::FORBIDDEN);
    }

    let upstream_url = build_upstream_url(&state.target_base_url, request.uri())
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let mut builder = state
        .client
        .request(request.method().clone(), upstream_url.clone());
    builder = builder.headers(filter_request_headers(
        request.headers(),
        &state.target_base_url,
    )?);

    let body = axum::body::to_bytes(request.into_body(), usize::MAX)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if !body.is_empty() {
        builder = builder.body(body);
    }

    let upstream = builder.send().await.map_err(map_upstream_error)?;
    let status = upstream.status();
    let headers = rewrite_response_headers(
        upstream.headers(),
        &state.target_base_url,
        &state.local_base_url,
    )?;
    let stream = upstream
        .bytes_stream()
        .map_err(|err| std::io::Error::other(err.to_string()));

    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}

fn build_upstream_url(base_url: &Url, uri: &Uri) -> Result<Url, url::ParseError> {
    let mut url = base_url.join(uri.path().trim_start_matches('/'))?;
    url.set_query(strip_proxy_token_query(uri.query()).as_deref());
    Ok(url)
}

fn generate_session_token() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn request_is_authorized(request: &Request, session_token: &str) -> bool {
    request
        .headers()
        .get(axum::http::header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .map(|cookie_header| {
            cookie_header
                .split(';')
                .map(str::trim)
                .filter_map(|part| part.split_once('='))
                .any(|(name, value)| name == PROXY_COOKIE_NAME && value == session_token)
        })
        .unwrap_or(false)
}

fn request_bootstraps_session(request: &Request, session_token: &str) -> bool {
    request.uri().query().is_some_and(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .any(|(name, value)| name == PROXY_TOKEN_QUERY && value == session_token)
    })
}

fn build_bootstrap_response(uri: &Uri, session_token: &str) -> Result<Response<Body>, StatusCode> {
    let redirect_target = sanitized_request_target(uri);
    let cookie = format!(
        "{PROXY_COOKIE_NAME}={session_token}; Path=/; HttpOnly; SameSite=Strict; Secure"
    );

    Response::builder()
        .status(StatusCode::FOUND)
        .header(axum::http::header::LOCATION, redirect_target)
        .header(axum::http::header::SET_COOKIE, cookie)
        .body(Body::empty())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn sanitized_request_target(uri: &Uri) -> String {
    let path = if uri.path().is_empty() { "/" } else { uri.path() };
    match strip_proxy_token_query(uri.query()) {
        Some(query) if !query.is_empty() => format!("{path}?{query}"),
        _ => path.to_string(),
    }
}

fn strip_proxy_token_query(query: Option<&str>) -> Option<String> {
    let query = query?;
    let filtered: Vec<(std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>)> =
        url::form_urlencoded::parse(query.as_bytes())
            .filter(|(name, _)| name != PROXY_TOKEN_QUERY)
            .collect();

    if filtered.is_empty() {
        return None;
    }

    Some(
        url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(filtered)
            .finish(),
    )
}

fn filter_request_headers(
    headers: &HeaderMap,
    target_base_url: &Url,
) -> Result<HeaderMap, StatusCode> {
    let mut forwarded = HeaderMap::new();
    for (name, value) in headers {
        if is_hop_by_hop_header(name) || *name == axum::http::header::HOST {
            continue;
        }
        forwarded.append(name.clone(), value.clone());
    }

    let host = target_base_url.host_str().ok_or(StatusCode::BAD_REQUEST)?;
    let host_value = match target_base_url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    forwarded.insert(
        axum::http::header::HOST,
        HeaderValue::from_str(&host_value).map_err(|_| StatusCode::BAD_REQUEST)?,
    );

    Ok(forwarded)
}

fn rewrite_response_headers(
    headers: &HeaderMap,
    target_base_url: &Url,
    local_base_url: &Url,
) -> Result<HeaderMap, StatusCode> {
    let mut rewritten = HeaderMap::new();
    for (name, value) in headers {
        if is_hop_by_hop_header(name) {
            continue;
        }

        if *name == axum::http::header::LOCATION {
            if let Ok(location) = value.to_str() {
                let next = rewrite_location(location, target_base_url, local_base_url);
                rewritten.append(
                    name.clone(),
                    HeaderValue::from_str(&next).map_err(|_| StatusCode::BAD_GATEWAY)?,
                );
                continue;
            }
        }

        rewritten.append(name.clone(), value.clone());
    }
    Ok(rewritten)
}

fn rewrite_location(location: &str, target_base_url: &Url, local_base_url: &Url) -> String {
    let Ok(parsed) = target_base_url.join(location) else {
        return location.to_string();
    };

    if parsed.origin() != target_base_url.origin() {
        return location.to_string();
    }

    let mut rewritten = local_base_url.clone();
    rewritten.set_path(parsed.path());
    rewritten.set_query(parsed.query());
    rewritten.set_fragment(parsed.fragment());
    rewritten.to_string()
}

fn map_upstream_error(error: reqwest::Error) -> StatusCode {
    if error.is_timeout() {
        StatusCode::GATEWAY_TIMEOUT
    } else if error.is_connect() {
        StatusCode::BAD_GATEWAY
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

fn is_hop_by_hop_header(name: &HeaderName) -> bool {
    static HOP_BY_HOP: std::sync::OnceLock<HashSet<&'static str>> = std::sync::OnceLock::new();
    HOP_BY_HOP
        .get_or_init(|| {
            HashSet::from([
                "connection",
                "keep-alive",
                "proxy-authenticate",
                "proxy-authorization",
                "te",
                "trailer",
                "transfer-encoding",
                "upgrade",
            ])
        })
        .contains(name.as_str())
}
