//! The local password session (`/api/auth/*`, `/login`, `/auth/token`; loopback only) with the
//! reference's `auth.json`, bootstrap token and named cookie, and the paired-device admission of
//! the HTTPS listener (`devices`, `remote`, `tls`).
pub mod devices;
pub mod password;
pub mod remote;
pub mod tls;
pub mod tls_admission;

use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode as Status, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    path::PathBuf,
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
        .route("/api/remote-control/status", get(devices::status))
}
/// Pairing, served on the HTTPS listener only.
pub fn remote_routes() -> Router<Shared> {
    Router::new()
        .route("/api/remote-control/pair", post(devices::exchange))
        .route("/api/remote-control/server-pair", post(devices::exchange))
        .route("/remote-pair", get(devices::page))
}
/// Device management, bootstrap and password pages, served on the loopback listener only.
pub fn local_routes() -> Router<Shared> {
    Router::new()
        .route("/api/remote-control/pairings", post(devices::issue).layer(DefaultBodyLimit::max(4096)))
        .route("/api/remote-control/devices", get(devices::list))
        .route("/api/remote-control/devices/{id}", delete(devices::revoke))
        .route("/api/remote-control/previews", put(devices::set_previews).layer(DefaultBodyLimit::max(4096)))
        .route("/api/auth/token", post(token).layer(DefaultBodyLimit::max(4096)))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/password", post(set_password).layer(DefaultBodyLimit::max(24 * 1024)))
        .route("/login", get(login_page))
        .route("/auth/token", get(token_page))
}

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
pub const DEFAULT_COOKIE: &str = "codenomad_session";
pub const DEFAULT_USERNAME: &str = "codenomad";
const TOKEN_TTL: Duration = Duration::from_secs(60);

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
    username: String,
    principal: Principal,
}

/// Startup choices (`AuthManagerInit`).
pub struct Settings {
    pub username: String,
    /// `--password`: hashed for this run, `auth.json` ignored.
    pub password: Option<String>,
    /// `auth.json` beside `config.yaml`; `None` keeps the runtime password only.
    pub file: Option<PathBuf>,
    pub cookie: String,
    pub token: bool,
    pub skip: bool,
    pub idle: Duration,
    pub absolute: Duration,
}

struct Credentials {
    username: String,
    record: password::Record,
    user_provided: bool,
}

pub struct Auth {
    settings: Settings,
    /// `None`: bootstrap only, until a password is set.
    credentials: Mutex<Option<Credentials>>,
    token: Mutex<Option<(String, Instant)>>,
    /// The single principal of `--dangerously-skip-auth`.
    open: Principal,
    sessions: Mutex<HashMap<String, Session>>,
    managed: Mutex<Option<ManagedSession>>,
    login_budget: tokio::sync::Semaphore,
    password_change: tokio::sync::Mutex<()>,
}

struct ManagedSession {
    current: String,
    previous: Option<String>,
    delivered: bool,
}

fn random_id() -> Option<String> {
    let mut entropy = [0; 32];
    getrandom::fill(&mut entropy).ok()?;
    Some(URL_SAFE_NO_PAD.encode(entropy))
}

impl Auth {
    /// `AuthStore.ensureInitialized`: the runtime password, else `auth.json`, else bootstrap-only with a token.
    pub fn new(settings: Settings) -> Result<Self, String> {
        let runtime = settings.password.as_deref().map(str::trim).filter(|p| !p.is_empty());
        let credentials = match (runtime, &settings.file) {
            _ if settings.skip => None,
            (Some(value), _) => Some(Credentials {
                username: settings.username.clone(),
                record: password::Record::new(value)?,
                user_provided: true,
            }),
            (None, Some(file)) => password::load(file).map(|f| Credentials {
                username: f.username,
                record: f.password,
                user_provided: f.user_provided,
            }),
            (None, None) => None,
        };
        if credentials.is_none() && !settings.token && !settings.skip {
            return Err(match &settings.file {
                Some(file) => format!(
                    "No server password configured. Create {} or start with --password / CODENOMAD_SERVER_PASSWORD.",
                    file.display()
                ),
                None => "CNRS_SERVER_PASSWORD must be nonempty".into(),
            });
        }
        let token = if settings.token && !settings.skip {
            Some((random_id().ok_or("Secure random source unavailable")?, Instant::now()))
        } else {
            None
        };
        Ok(Self {
            settings,
            credentials: Mutex::new(credentials),
            token: Mutex::new(token),
            open: Principal(CancellationToken::new()),
            sessions: Mutex::default(),
            managed: Mutex::default(),
            login_budget: tokio::sync::Semaphore::new(4),
            password_change: Default::default(),
        })
    }
    /// The one-time desktop token, printed once as `CODENOMAD_BOOTSTRAP_TOKEN:<token>`.
    pub fn bootstrap_token(&self) -> Option<String> {
        self.token.lock().unwrap().as_ref().map(|(token, _)| token.clone())
    }
    pub fn cookie_name(&self) -> &str {
        &self.settings.cookie
    }

    pub(crate) fn human(&self, principal: &Principal) -> bool {
        !self.settings.skip && principal.live().is_ok()
    }
    pub(crate) fn cookie_user(&self, key: &str) -> Option<String> {
        if self.settings.skip {
            return None;
        }
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(key)?;
        (!self.expired(session) && session.principal.live().is_ok()).then(|| session.username.clone())
    }
    fn expired(&self, s: &Session) -> bool {
        s.seen.elapsed() >= self.settings.idle || s.born.elapsed() >= self.settings.absolute
    }
    pub async fn sweep(app: Shared) {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            app.auth.sessions.lock().unwrap().retain(|_, s| {
                if !app.auth.expired(s) {
                    return true;
                }
                s.principal.0.cancel();
                false
            });
        }
    }
    fn principal(&self, key: Option<&str>) -> Option<Principal> {
        if self.settings.skip {
            return Some(self.open.clone());
        }
        let key = key?;
        // Keep first use ordered with rotation and logout.
        let mut managed = self.managed.lock().unwrap();
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(key)?;
        if self.expired(s) {
            s.principal.0.cancel();
            sessions.remove(key);
            return None;
        }
        s.seen = Instant::now();
        if let Some(managed) = managed.as_mut().filter(|managed| managed.current == key) {
            managed.delivered = true;
        }
        Some(s.principal.clone())
    }
    /// `{username, passwordUserProvided}` of the reference's `getStatus`.
    fn identity(&self) -> (String, bool) {
        match &*self.credentials.lock().unwrap() {
            Some(c) if !self.settings.skip => (c.username.clone(), c.user_provided),
            _ => (self.settings.username.clone(), false),
        }
    }
    fn open_session(&self, username: String) -> Result<String, Error> {
        let id = random_id().ok_or_else(|| error(Status::SERVICE_UNAVAILABLE, "Login unavailable"))?;
        let now = Instant::now();
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, s| {
            let live = !self.expired(s);
            if !live {
                s.principal.0.cancel();
            }
            live
        });
        sessions.insert(
            id.clone(),
            Session { born: now, seen: now, username, principal: Principal(CancellationToken::new()) },
        );
        Ok(id)
    }

    fn can_renew(&self) -> bool {
        self.settings.token
            && !self.settings.skip
            && crate::host::native_parent::available()
            && self.credentials.lock().unwrap().is_none()
            && self.settings.file.as_ref().is_some_and(|path| matches!(path.try_exists(), Ok(false)))
    }

    fn open_bootstrap_session(&self) -> Result<String, Error> {
        let mut slot = self.managed.lock().unwrap();
        let id = self.open_session(self.identity().0)?;
        if self.can_renew() {
            *slot = Some(ManagedSession { current: id.clone(), previous: None, delivered: true });
        }
        Ok(id)
    }

    pub(crate) fn renew_managed_session(&self) -> Option<String> {
        let mut slot = self.managed.lock().unwrap();
        let managed = slot.as_mut()?;
        if !self.can_renew() {
            return None;
        }
        let live = self.sessions.lock().unwrap().get(&managed.current).is_some_and(|session| !self.expired(session));
        if live {
            return (!managed.delivered).then(|| managed.current.clone());
        }
        let current = self.open_session(self.settings.username.clone()).ok()?;
        if managed.delivered {
            managed.previous = Some(std::mem::take(&mut managed.current));
        }
        managed.current = current.clone();
        managed.delivered = false;
        Some(current)
    }

    fn revoke_cookie(&self, cookie: &str) {
        let mut managed = self.managed.lock().unwrap();
        let mut sessions = self.sessions.lock().unwrap();
        let replacement = managed
            .as_ref()
            .is_some_and(|session| session.current == cookie || session.previous.as_deref() == Some(cookie));
        if let Some(id) = replacement.then(|| managed.take()).flatten().map(|session| session.current)
            && let Some(session) = sessions.remove(&id)
        {
            session.principal.0.cancel();
        }
        if let Some(session) = sessions.remove(cookie) {
            session.principal.0.cancel();
        }
    }
    /// Values are base64url session ids, which `encodeURIComponent` leaves unchanged.
    fn session_cookie(&self, value: &str, max_age: Option<u64>) -> String {
        let tail = max_age.map(|age| format!("; Max-Age={age}")).unwrap_or_default();
        format!("{}={value}; HttpOnly; Path=/; SameSite=Lax{tail}", self.settings.cookie)
    }

    fn issued_session_cookie(&self, value: &str) -> String {
        // AuthManager.setSessionCookieWithOptions uses a fixed cookie lifetime.
        self.session_cookie(value, (!self.settings.skip).then_some(7 * 24 * 60 * 60))
    }
}

/// `--auth-cookie-name`, made a cookie token like `sanitizeCookieName`.
pub fn cookie_name(value: Option<&str>) -> String {
    let value = value.map(str::trim).unwrap_or("");
    if value.is_empty() {
        return DEFAULT_COOKIE.into();
    }
    value.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

pub fn cookies(headers: &HeaderMap, session: &str) -> Result<(Option<String>, Option<String>), Error> {
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
            let slot = if name == devices::COOKIE {
                &mut device
            } else if name == session {
                &mut key
            } else {
                continue;
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

/// Fastify's `reply.redirect`: 302.
pub fn found(to: &'static str) -> Response {
    (Status::FOUND, [(header::LOCATION, to)]).into_response()
}

fn wants_html(headers: &HeaderMap) -> bool {
    headers.get_all(header::ACCEPT).iter().filter_map(|v| v.to_str().ok()).any(|v| {
        let v = v.to_ascii_lowercase();
        v.contains("text/html") || v.contains("application/xhtml")
    })
}

pub async fn admit(State(app): State<Shared>, mut req: Request, next: Next) -> Result<Response, Error> {
    let (key, device) = cookies(req.headers(), app.auth.cookie_name())?;
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
    let backend = req.uri().path().starts_with("/api/backends/");
    if AUTHORITY_HEADERS
        .iter()
        .any(|h| req.headers().contains_key(*h) && (!backend || *h != crate::previews::backend::PROOF))
    {
        return Err(error(Status::FORBIDDEN, "Unsupported authority"));
    }
    if req.uri().query().is_some_and(|query| {
        reqwest::Url::parse(&format!("http://127.0.0.1/?{query}"))
            .ok()
            .is_some_and(|url| url.query_pairs().any(|(k, _)| k == "__codenomad_authority"))
    }) {
        return Err(error(Status::FORBIDDEN, "Unsupported authority"));
    }
    let path = req.uri().path().to_owned();
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
        // The reference's `preHandler`: public auth routes and pages, then the session; pages
        // without one go to `/login`, other non-API paths reach the UI only.
        let principal = app.auth.principal(key.as_deref());
        let public =
            matches!(path.as_str(), "/api/auth/login" | "/api/auth/status" | "/api/auth/token" | "/api/auth/logout")
                || path == "/login"
                || path == "/auth/token" && app.auth.settings.token;
        let api = ["/api/", "/workspaces/", "/sidecars/", "/previews/"].iter().any(|p| path.starts_with(p));
        let html = wants_html(req.headers());
        if public || principal.is_some() {
            req.extensions_mut().insert(principal.clone());
            if let Some(principal) = principal {
                req.extensions_mut().insert(principal);
            }
            next.run(req).await
        } else if path == "/"
            || !api
                && percent_encoding::percent_decode_str(&path)
                    .decode_utf8()
                    .is_ok_and(|p| crate::host::ui::is_html_path(&p))
            || html && (!api || req.method() == Method::GET && !path.starts_with("/api/"))
        {
            found("/login")
        } else if api {
            unauthorized().into_response()
        } else {
            req.extensions_mut().insert(None::<Principal>);
            next.run(req).await
        }
    };
    Ok(remote::cors(response, origin))
}

pub async fn status(
    State(app): State<Shared>,
    Extension(principal): Extension<Option<Principal>>,
) -> impl IntoResponse {
    let data = if principal.is_some() {
        let (username, provided) = app.auth.identity();
        json!({"authenticated":true,"username":username,"passwordUserProvided":provided})
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
    if !app.auth.settings.skip {
        let _permit =
            app.auth.login_budget.try_acquire().map_err(|_| error(Status::TOO_MANY_REQUESTS, "Login busy"))?;
        let Some((expected, record)) =
            app.auth.credentials.lock().unwrap().as_ref().map(|c| (c.username.clone(), c.record.clone()))
        else {
            return Err(error(Status::UNAUTHORIZED, "Invalid credentials"));
        };
        let valid = tokio::task::spawn_blocking(move || record.verify(&password))
            .await
            .map_err(|_| error(Status::SERVICE_UNAVAILABLE, "Login unavailable"))?;
        if !valid || username != expected {
            return Err(error(Status::UNAUTHORIZED, "Invalid credentials"));
        }
    }
    let id = app.auth.open_session(username)?;
    Ok(([(header::SET_COOKIE, app.auth.issued_session_cookie(&id))], Json(json!({"ok":true}))))
}

#[derive(Deserialize)]
pub struct Token {
    token: String,
}

/// `POST /api/auth/token`: the bootstrap token, once and within a minute, opens a session.
pub async fn token(
    State(app): State<Shared>,
    payload: Result<Json<Token>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !app.auth.settings.token || app.auth.settings.skip {
        return error(Status::NOT_FOUND, "Not found").into_response();
    }
    let token = match payload {
        Ok(Json(Token { token })) if !token.is_empty() => token,
        _ => return error(Status::BAD_REQUEST, "Invalid token body").into_response(),
    };
    let accepted = {
        let mut slot = app.auth.token.lock().unwrap();
        let valid = slot.as_ref().is_some_and(|(expected, issued)| {
            issued.elapsed() <= TOKEN_TTL && bool::from(expected.as_bytes().ct_eq(token.as_bytes()))
        });
        if valid {
            slot.take();
        }
        valid
    };
    if !accepted {
        return error(Status::UNAUTHORIZED, "Invalid token").into_response();
    }
    match app.auth.open_bootstrap_session() {
        Ok(id) => {
            ([(header::SET_COOKIE, app.auth.issued_session_cookie(&id))], Json(json!({"ok":true}))).into_response()
        }
        Err(e) => e.into_response(),
    }
}

async fn logout(State(app): State<Shared>, headers: HeaderMap) -> Result<impl IntoResponse, Error> {
    if let (Some(cookie), None) = cookies(&headers, app.auth.cookie_name())? {
        app.auth.revoke_cookie(&cookie);
    }
    Ok(([(header::SET_COOKIE, app.auth.session_cookie("", Some(0)))], Json(json!({"ok":true}))))
}

#[derive(Deserialize)]
pub struct NewPassword {
    password: String,
}

/// `POST /api/auth/password`: writes `auth.json` and ends every session of that user.
pub async fn set_password(
    State(app): State<Shared>,
    principal: Option<Extension<Principal>>,
    payload: Result<Json<NewPassword>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if principal.is_none() {
        return unauthorized().into_response();
    }
    let password = match payload {
        Ok(Json(NewPassword { password })) if password.chars().count() >= 8 && password.len() <= 8192 => password,
        _ => return error(Status::BAD_REQUEST, "Invalid password body").into_response(),
    };
    let conflict =
        |message: &str| (Status::CONFLICT, [(header::CONTENT_TYPE, "text/plain")], message.to_owned()).into_response();
    let settings = &app.auth.settings;
    if settings.skip {
        return conflict("Internal authentication is disabled");
    }
    let Some(file) =
        settings.file.as_ref().filter(|_| settings.password.as_deref().is_none_or(|p| p.trim().is_empty()))
    else {
        return conflict(
            "Server password is provided via CLI/env and cannot be changed while running. Restart without --password / CODENOMAD_SERVER_PASSWORD to use auth.json.",
        );
    };
    let _change = app.auth.password_change.lock().await;
    let record = match tokio::task::spawn_blocking(move || password::Record::new(&password)).await {
        Ok(Ok(record)) => record,
        _ => return conflict("Password hashing failed"),
    };
    let username = app.auth.identity().0;
    let stored = password::AuthFile {
        version: 1,
        username: username.clone(),
        password: record.clone(),
        user_provided: true,
        updated_at: crate::now(),
    };
    if let Err(e) = password::save(file, &stored) {
        return conflict(&e.to_string());
    }
    let mut managed = app.auth.managed.lock().unwrap();
    *managed = None;
    *app.auth.credentials.lock().unwrap() =
        Some(Credentials { username: username.clone(), record, user_provided: true });
    app.auth.sessions.lock().unwrap().retain(|_, s| {
        let keep = s.username != username;
        if !keep {
            s.principal.0.cancel();
        }
        keep
    });
    (
        [(header::SET_COOKIE, app.auth.session_cookie("", Some(0)))],
        Json(json!({"ok":true,"username":username,"passwordUserProvided":true})),
    )
        .into_response()
}

const NO_STORE: [(header::HeaderName, &str); 3] =
    [(header::CACHE_CONTROL, "no-store"), (header::PRAGMA, "no-cache"), (header::EXPIRES, "0")];

/// `/login`: the reference page with the configured user name, or `/` once signed in.
pub async fn login_page(State(app): State<Shared>, Extension(principal): Extension<Option<Principal>>) -> Response {
    if principal.is_some() {
        return found("/");
    }
    let name =
        app.auth.identity().0.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    let page =
        include_str!("../../../server/src/server/routes/auth-pages/login.html").replace("{{DEFAULT_USERNAME}}", &name);
    (NO_STORE, [(header::CONTENT_TYPE, "text/html")], page).into_response()
}

pub async fn token_page(State(app): State<Shared>) -> Response {
    if !app.auth.settings.token || app.auth.settings.skip {
        return error(Status::NOT_FOUND, "Not found").into_response();
    }
    let page = include_str!("../../../server/src/server/routes/auth-pages/token.html");
    (NO_STORE, [(header::CONTENT_TYPE, "text/html")], page).into_response()
}
