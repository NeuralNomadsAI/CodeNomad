//! The local password session (`/api/auth/*`, loopback only) and the paired-device
//! admission of the HTTPS listener (`devices`, `remote`, `tls`).
pub mod devices;
pub mod remote;
pub mod tls;
pub mod tls_admission;

use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode as Status, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;

use crate::{Error, Shared, error};

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/auth/status", get(status))
        .route("/api/auth/login", post(login).layer(DefaultBodyLimit::max(24 * 1024)))
        .route("/api/auth/logout", post(logout))
}
/// Pairing, served on the HTTPS listener only.
pub fn remote_routes() -> Router<Shared> {
    Router::new()
        .route("/api/remote-control/pair", post(devices::exchange))
        .route("/api/remote-control/server-pair", post(devices::exchange))
        .route("/remote-pair", get(devices::page))
}
/// Device management, served on the loopback listener only.
pub fn local_routes() -> Router<Shared> {
    Router::new()
        .route("/api/remote-control/pairings", post(devices::issue).layer(DefaultBodyLimit::max(4096)))
        .route("/api/remote-control/devices", get(devices::list))
        .route("/api/remote-control/devices/{id}", delete(devices::revoke))
}

const NAME: &str = "codenomad";
/// Proxy and routing headers no client may supply: refused locally, stripped from paired devices.
pub const AUTHORITY_HEADERS: [&str; 7] = [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "x-codenomad-remote-control",
    "x-codenomad-backend-authority",
];
const COOKIE: &str = "codenomad_session";

#[derive(Clone)]
pub struct Principal(pub CancellationToken);
impl Principal {
    /// Refuses once the session that admitted the request has ended.
    pub fn live(&self) -> Result<(), Error> {
        if self.0.is_cancelled() { Err(unauthorized()) } else { Ok(()) }
    }
}
pub fn unauthorized() -> Error {
    error(Status::UNAUTHORIZED, "Unauthorized")
}
struct Session {
    born: Instant,
    seen: Instant,
    principal: Principal,
}

pub struct Auth {
    salt: [u8; 16],
    hash: [u8; 64],
    sessions: Mutex<HashMap<String, Session>>,
    login_budget: tokio::sync::Semaphore,
}

fn derive(value: &str, salt: &[u8; 16]) -> [u8; 64] {
    let mut output = [0; 64];
    scrypt::scrypt(value.as_bytes(), salt, &scrypt::Params::new(14, 8, 1, 64).unwrap(), &mut output)
        .expect("fixed scrypt parameters");
    output
}

impl Auth {
    pub fn new(secret: &str) -> Result<Self, &'static str> {
        let value = secret.trim();
        if value.is_empty() {
            return Err("CNRS_SERVER_PASSWORD must be nonempty");
        }
        let mut salt = [0; 16];
        getrandom::fill(&mut salt).map_err(|_| "Secure random source unavailable")?;
        Ok(Self {
            salt,
            hash: derive(value, &salt),
            sessions: Mutex::default(),
            login_budget: tokio::sync::Semaphore::new(4),
        })
    }
    fn expired(s: &Session) -> bool {
        s.seen.elapsed() >= Duration::from_secs(86400) || s.born.elapsed() >= Duration::from_secs(7 * 86400)
    }
    pub async fn sweep(app: Shared) {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            app.auth.sessions.lock().unwrap().retain(|_, s| {
                if !Self::expired(s) {
                    return true;
                }
                s.principal.0.cancel();
                false
            });
        }
    }
    fn principal(&self, key: &str) -> Option<Principal> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(key)?;
        if Self::expired(s) {
            s.principal.0.cancel();
            sessions.remove(key);
            return None;
        }
        s.seen = Instant::now();
        Some(s.principal.clone())
    }
}

pub fn cookies(headers: &HeaderMap) -> Result<(Option<String>, Option<String>), Error> {
    let (mut key, mut device) = (None, None);
    for value in headers.get_all(header::COOKIE) {
        for field in value.to_str().map_err(|_| invalid_cookie())?.split(';') {
            let Some((name, value)) = field.split_once('=') else { continue };
            let name = name.trim();
            let value = value.trim();
            if value.as_bytes().iter().enumerate().any(|(i, b)| {
                *b == b'%' && !value.as_bytes().get(i + 1..i + 3).is_some_and(|s| s.iter().all(u8::is_ascii_hexdigit))
            }) {
                return Err(invalid_cookie());
            }
            let value = percent_encoding::percent_decode_str(value).decode_utf8().map_err(|_| invalid_cookie())?;
            let slot = match name {
                devices::COOKIE => &mut device,
                COOKIE => &mut key,
                _ => continue,
            };
            if slot.replace(value.into_owned()).is_some() {
                return Err(invalid_cookie());
            }
        }
    }
    Ok((key, device))
}
fn invalid_cookie() -> Error {
    error(Status::BAD_REQUEST, "Invalid cookie")
}

pub async fn admit(State(app): State<Shared>, mut req: Request, next: Next) -> Result<Response, Error> {
    let (key, device) = cookies(req.headers())?;
    let host = req.headers().get(header::HOST).and_then(|x| x.to_str().ok()).unwrap_or("");
    let selected = [format!("127.0.0.1:{}", app.port), format!("localhost:{}", app.port)];
    if !selected.iter().any(|expected| expected == host) || req.headers().get_all(header::HOST).iter().count() != 1 {
        return Err(error(Status::FORBIDDEN, "Loopback prototype only"));
    }
    let source = req.headers().get(header::ORIGIN).map(|v| v.to_str().ok().map(str::to_owned)).or_else(|| {
        req.headers().get(header::REFERER).map(|v| {
            v.to_str().ok().and_then(|r| reqwest::Url::parse(r).ok()).map(|url| url.origin().ascii_serialization())
        })
    });
    if req.headers().get_all(header::ORIGIN).iter().count() > 1
        || req.headers().get_all(header::REFERER).iter().count() > 1
        || source.is_some_and(|source| source.as_deref() != Some(&format!("http://{host}")))
    {
        return Err(error(Status::FORBIDDEN, "Cross-origin request rejected"));
    }
    // SameSite=Lax still sends the cookie on another site's top-level
    // navigation (no Origin, no Referer with rel=noreferrer): Fetch Metadata
    // names it. Same-origin pages, direct navigations and non-browser callers
    // (`none` or no header) are unaffected (audit M2).
    if key.is_some()
        && req.headers().get_all("sec-fetch-site").iter().any(|v| {
            v.to_str().is_ok_and(|v| {
                v.trim().eq_ignore_ascii_case("cross-site") || v.trim().eq_ignore_ascii_case("same-site")
            })
        })
    {
        return Err(error(Status::FORBIDDEN, "Cross-origin request rejected"));
    }
    if AUTHORITY_HEADERS.iter().any(|h| req.headers().contains_key(*h)) {
        return Err(error(Status::FORBIDDEN, "Unsupported authority"));
    }
    if req.uri().query().is_some_and(|query| {
        reqwest::Url::parse(&format!("http://127.0.0.1/?{query}"))
            .ok()
            .is_some_and(|url| url.query_pairs().any(|(k, _)| k == "__codenomad_authority"))
    }) {
        return Err(error(Status::FORBIDDEN, "Unsupported authority"));
    }
    let path = req.uri().path();
    if device.is_some() || req.headers().contains_key("x-codenomad-server-request") {
        return Err(error(Status::UNAUTHORIZED, "This device is not paired"));
    }
    if app.devices.is_some() && path == "/api/remote-control/server-pair" {
        return Ok((
            Status::NOT_FOUND,
            [(header::CACHE_CONTROL, "no-store"), (header::CONNECTION, "close")],
            Json(json!({"error":"Server pairing request rejected"})),
        )
            .into_response());
    }
    if path == "/api/remote-control/server-pair"
        || path == "/api/remote-control/pair"
        || req.headers().contains_key("x-codenomad-server-pairing")
    {
        return Err(error(Status::FORBIDDEN, "Server pairing request rejected"));
    }
    let origin = req.headers().get(header::ORIGIN).cloned();
    let response = if req.method() == Method::OPTIONS && origin.is_some() {
        if req.headers().get(header::ACCESS_CONTROL_REQUEST_METHOD).is_none_or(|h| h.is_empty()) {
            (Status::BAD_REQUEST, "Invalid Preflight Request").into_response()
        } else {
            let mut response = Status::NO_CONTENT.into_response();
            let headers = response.headers_mut();
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET,HEAD,PUT,PATCH,POST,DELETE"),
            );
            headers.insert(header::VARY, HeaderValue::from_static("Origin, Access-Control-Request-Headers"));
            if let Some(requested) = req.headers().get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
                headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, requested.clone());
            }
            response
        }
    } else {
        let principal = key.as_deref().and_then(|key| app.auth.principal(key));
        if matches!(path, "/api/auth/login" | "/api/auth/status" | "/api/auth/logout") {
            req.extensions_mut().insert(principal);
            next.run(req).await
        } else if let Some(principal) = principal {
            req.extensions_mut().insert(principal);
            next.run(req).await
        } else {
            unauthorized().into_response()
        }
    };
    Ok(remote::cors(response, origin))
}

pub async fn status(Extension(principal): Extension<Option<Principal>>) -> impl IntoResponse {
    let data = if principal.is_some() {
        json!({"authenticated":true,"username":NAME,"passwordUserProvided":true})
    } else {
        json!({"authenticated":false})
    };
    Json(data)
}

#[derive(Deserialize)]
pub struct Login {
    username: String,
    password: String,
}

pub async fn login(
    State(app): State<Shared>,
    payload: Result<Json<Login>, axum::extract::rejection::JsonRejection>,
) -> Result<impl IntoResponse, Error> {
    let Json(Login { username, password }) = payload.map_err(|_| error(Status::BAD_REQUEST, "Invalid login body"))?;
    if username.is_empty() || password.is_empty() || username.len() > 1024 || password.len() > 8192 {
        return Err(error(Status::BAD_REQUEST, "Invalid login body"));
    }
    let _permit = app.auth.login_budget.try_acquire().map_err(|_| error(Status::TOO_MANY_REQUESTS, "Login busy"))?;
    let salt = app.auth.salt;
    let guess = tokio::task::spawn_blocking(move || derive(&password, &salt))
        .await
        .map_err(|_| error(Status::SERVICE_UNAVAILABLE, "Login unavailable"))?;
    if !bool::from(app.auth.hash.ct_eq(&guess)) || username != NAME {
        return Err(error(Status::UNAUTHORIZED, "Invalid credentials"));
    }
    let mut entropy = [0; 32];
    getrandom::fill(&mut entropy).map_err(|_| error(Status::SERVICE_UNAVAILABLE, "Login unavailable"))?;
    let id = URL_SAFE_NO_PAD.encode(entropy);
    let now = Instant::now();
    app.auth
        .sessions
        .lock()
        .unwrap()
        .insert(id.clone(), Session { born: now, seen: now, principal: Principal(CancellationToken::new()) });
    Ok(([(header::SET_COOKIE, format!("{COOKIE}={id}; HttpOnly; Path=/; SameSite=Lax"))], Json(json!({"ok":true}))))
}

pub async fn logout(State(app): State<Shared>, headers: HeaderMap) -> Result<impl IntoResponse, Error> {
    if let Some(key) = cookies(&headers)?.0 {
        if let Some(record) = app.auth.sessions.lock().unwrap().remove(&key) {
            record.principal.0.cancel();
        }
    }
    Ok((
        [(header::SET_COOKIE, format!("{COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"))],
        Json(json!({"ok":true})),
    ))
}
