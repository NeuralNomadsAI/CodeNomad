//! Saved destination and authenticated server identity for a remote preview generation.
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{HeaderMap, Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;

use crate::{Shared, auth::Principal, settings::Kind};

pub const PROOF: &str = "x-codenomad-backend-authority";

#[derive(Default)]
pub struct Owners {
    generations: Mutex<HashMap<String, Arc<Generation>>>,
    mutation: tokio::sync::Mutex<()>,
}
pub struct Generation {
    pub id: String,
    pub origin: Url,
    pub skip_tls: bool,
    pub proof: String,
    server: String,
    identity: [u8; 32],
    pub signal: CancellationToken,
    transfers: Mutex<CancellationToken>,
    cookie: Mutex<Option<String>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    base_url: String,
    #[serde(default)]
    skip_tls_verify: bool,
    ssh: Option<Value>,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Secret {
    Device { cookie: String },
    Session { cookie: String },
    Password { username: String, password: String, cookie: Option<String> },
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Credential {
    origin: String,
    #[serde(default)]
    skip_tls_verify: bool,
    secret: Secret,
}
impl Credential {
    fn cookie(&self) -> Option<String> {
        match &self.secret {
            Secret::Device { cookie } | Secret::Session { cookie } => Some(cookie.clone()),
            Secret::Password { cookie, .. } => cookie.clone(),
        }
    }
    fn digest(&self) -> [u8; 32] {
        let secret = match &self.secret {
            Secret::Password { username, password, .. } => json!(["password", username, password]),
            _ => serde_json::to_value(&self.secret).unwrap(),
        };
        Sha256::digest(json!([self.origin, self.skip_tls_verify, secret]).to_string()).into()
    }
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/backends/{id}/api/meta", get(metadata))
        .route("/api/backends/{id}/api/auth/login", post(connect))
        .route("/api/remote-servers/{id}/connect", post(connect))
        .route("/api/remote-servers/{id}/forget", post(forget))
}
pub fn enabled(app: &crate::App) -> bool {
    app.settings.raw_config_owner("ui").is_ok_and(|x| x.get("settings").is_some_and(|s| s["multiBackend"] == true))
}
pub fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
pub fn proof(headers: &HeaderMap) -> Option<&str> {
    if headers.get_all(PROOF).iter().count() != 1 {
        return None;
    }
    headers.get(PROOF)?.to_str().ok()
}
pub fn sound_proof(p: &str) -> bool {
    p.len() == 43 && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
pub fn refused() -> Response {
    (Status::NOT_FOUND, [(header::CACHE_CONTROL, "no-store")], Json(json!({"error":"unreachable"}))).into_response()
}
pub fn guard(app: &Shared, request: &Request) -> bool {
    let h = request.headers();
    if !enabled(app)
        || request.extensions().get::<Principal>().is_none_or(|p| p.0.is_cancelled())
        || h.get_all(header::ORIGIN).iter().count() > 1
        || h.get_all(header::REFERER).iter().count() > 1
    {
        return false;
    }
    if let Some(channel) = crate::auth::tls::https_only(request) {
        return !h.contains_key("x-codenomad-server-request")
            && h.get(header::ORIGIN).map_or_else(
                || matches!(*request.method(), Method::GET | Method::HEAD),
                |h| h == channel.origin.as_str(),
            );
    }
    let Some(host) = h.get(header::HOST).and_then(|h| h.to_str().ok()) else { return false };
    let own = format!("http://{host}");
    h.get(header::ORIGIN).map_or_else(
        || {
            matches!(*request.method(), Method::GET | Method::HEAD)
                && h.get("sec-fetch-site").is_some_and(|v| v == "same-origin")
                && h.get(header::REFERER)
                    .and_then(|h| Url::parse(h.to_str().ok()?).ok())
                    .is_some_and(|u| u.origin().ascii_serialization() == own)
        },
        |source| source == own.as_str(),
    )
}
pub fn deny() -> Response {
    (Status::FORBIDDEN, [(header::CONNECTION, "close")], Json(json!({"error":"auth"}))).into_response()
}
fn normalize(raw: &str) -> Option<Url> {
    static ORIGIN: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)^https?://[^/?#\\\s]+/?$").unwrap());
    if !ORIGIN.is_match(raw) || raw.contains('@') {
        return None;
    }
    let u = Url::parse(raw).ok()?;
    u.host_str().is_some_and(|s| !s.contains('*')).then_some(u)
}
fn saved_origin(app: &crate::App, id: &str) -> Option<(Url, bool)> {
    if !id_ok(id) {
        return None;
    }
    let ui = app.settings.owner(Kind::State, "ui");
    let p = ui
        .get("remoteServers")?
        .as_array()?
        .iter()
        .filter_map(|v| serde_json::from_value::<Profile>(v.clone()).ok())
        .find(|p| p.id == id)?;
    if p.ssh.is_some() {
        return None;
    }
    Some((normalize(&p.base_url)?, p.skip_tls_verify))
}
fn profile(app: &crate::App, id: &str) -> Option<(Url, bool, Credential)> {
    let (u, skip) = saved_origin(app, id)?;
    let saved = read_credential_file(app).ok()?;
    let c: Credential = serde_json::from_value(saved["servers"].get(id)?.clone()).ok()?;
    if c.origin != u.origin().ascii_serialization() || c.skip_tls_verify != skip {
        return None;
    }
    Some((u, skip, c))
}
fn credentials_path(app: &crate::App) -> std::path::PathBuf {
    app.settings.location.base.join("remote-server-credentials.json")
}
fn read_credential_file(app: &crate::App) -> Result<Value, ()> {
    use std::io::Read;
    let path = credentials_path(app);
    let file = std::fs::File::open(path).map_err(|_| ())?;
    let mut input = Vec::new();
    file.take(1024 * 1024 + 1).read_to_end(&mut input).map_err(|_| ())?;
    if input.len() > 1024 * 1024 {
        return Err(());
    }
    let v: Value = serde_json::from_slice(&input).map_err(|_| ())?;
    if !v["servers"].is_object() {
        return Err(());
    }
    Ok(v)
}
fn erase_credential(app: &crate::App, id: &str, identity: Option<&[u8; 32]>) -> Result<(), ()> {
    let file = credentials_path(app);
    if std::fs::symlink_metadata(&file).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return Ok(());
    }
    let mut stored = read_credential_file(app)?;
    let servers = stored["servers"].as_object_mut().unwrap();
    let matching = identity.is_none_or(|expected| {
        servers.get(id).is_some_and(|v| {
            serde_json::from_value::<Credential>(v.clone()).is_ok_and(|credential| &credential.digest() == expected)
        })
    });
    if matching && servers.remove(id).is_some() {
        crate::auth::tls::write_private(&file, stored.to_string().as_bytes()).map_err(|_| ())?;
    }
    Ok(())
}

impl Generation {
    pub fn current(&self, app: &crate::App) -> bool {
        !self.signal.is_cancelled()
            && enabled(app)
            && profile(app, &self.id).is_some_and(|(url, skip, credential)| {
                url == self.origin && skip == self.skip_tls && credential.digest() == self.identity
            })
    }
    pub fn preview_lifetime(&self) -> CancellationToken {
        self.transfers.lock().unwrap().child_token()
    }
    pub fn detach(&self) {
        let mut previews = self.transfers.lock().unwrap();
        previews.cancel();
        *previews = self.signal.child_token();
    }
}

impl Owners {
    pub fn exact(&self, app: &crate::App, id: &str, proof: &str) -> Option<Arc<Generation>> {
        if !sound_proof(proof) {
            return None;
        }
        let g = self.generations.lock().unwrap().get(id).cloned()?;
        if !g.current(app) {
            g.signal.cancel();
            return None;
        }
        bool::from(g.proof.as_bytes().ct_eq(proof.as_bytes())).then_some(g)
    }
    fn retire(&self, id: &str) {
        if let Some(g) = self.generations.lock().unwrap().remove(id) {
            g.signal.cancel();
        }
    }
    pub fn reconcile(&self, app: &crate::App) {
        self.generations.lock().unwrap().retain(|_, g| {
            let live = g.current(app);
            if !live {
                g.signal.cancel();
                if saved_origin(app, &g.id) != Some((g.origin.clone(), g.skip_tls)) {
                    let _ = erase_credential(app, &g.id, Some(&g.identity));
                }
            }
            live
        });
    }
    pub fn close(&self) {
        for (_, g) in self.generations.lock().unwrap().drain() {
            g.signal.cancel();
        }
    }
}

async fn metadata(State(app): State<Shared>, Path(id): Path<String>, request: Request) -> Response {
    if !guard(&app, &request) {
        return deny();
    }
    let Some(p) = proof(request.headers()) else { return refused() };
    let principal = request.extensions().get::<Principal>().unwrap();
    let observe = async {
        let _serialized = app.previews.owners.mutation.lock().await;
        let old = if p != "bootstrap" {
            Some(app.previews.owners.exact(&app, &id, p)?)
        } else {
            app.previews.owners.generations.lock().unwrap().get(&id).cloned().filter(|g| g.current(&app))
        };
        let Some((origin, skip, credential)) = profile(&app, &id) else {
            app.previews.owners.retire(&id);
            return None;
        };
        let identity = credential.digest();
        let client = super::proxy::pinned_client(&app, &origin, skip, true).await.ok()?;
        if !enabled(&app) || profile(&app, &id).is_none_or(|(_, _, new)| new.digest() != identity) {
            return None;
        }
        let mut cookie = old.as_ref().and_then(|g| g.cookie.lock().unwrap().clone()).or_else(|| credential.cookie());
        let mut response =
            control_request(&client, &origin, &credential, &cookie, Method::GET, "/api/meta", None).await?;
        if response.status() == Status::UNAUTHORIZED
            && let Secret::Password { username, password, .. } = &credential.secret
        {
            let login = client
                .post(origin.join("/api/auth/login").ok()?)
                .json(&json!({"username":username,"password":password}))
                .send()
                .await
                .ok()?;
            if !login.status().is_success() {
                app.previews.owners.retire(&id);
                return None;
            }
            cookie = session_cookie(login.headers());
            cookie.as_ref()?;
            response = control_request(&client, &origin, &credential, &cookie, Method::GET, "/api/meta", None).await?;
        }
        if response.status() != Status::OK {
            if response.status() == Status::UNAUTHORIZED {
                app.previews.owners.retire(&id);
            }
            return None;
        }
        let meta = crate::opencode::read_json(response, 64 * 1024).await.ok()?;
        let server = meta["serverId"].as_str().filter(|s| !s.trim().is_empty() && s.len() <= 256)?;
        if !enabled(&app) || profile(&app, &id).is_none_or(|(_, _, new)| new.digest() != identity) {
            app.previews.owners.retire(&id);
            return None;
        }
        if old.as_ref().is_some_and(|g| g.server != server) {
            app.previews.owners.retire(&id);
            let _ = erase_credential(&app, &id, Some(&identity));
            return None;
        }
        let g = if let Some(g) = old {
            *g.cookie.lock().unwrap() = cookie;
            g
        } else {
            let mut entropy = [0_u8; 32];
            getrandom::fill(&mut entropy).ok()?;
            let signal = CancellationToken::new();
            let g = Arc::new(Generation {
                id: id.clone(),
                origin,
                skip_tls: skip,
                proof: URL_SAFE_NO_PAD.encode(entropy),
                identity,
                server: server.into(),
                transfers: Mutex::new(signal.child_token()),
                signal,
                cookie: Mutex::new(cookie),
            });
            let mut live = app.previews.owners.generations.lock().unwrap();
            if let Some(prior) = live.insert(id.clone(), g.clone()) {
                prior.signal.cancel();
            }
            g
        };
        Some(([(PROOF, g.proof.clone()), ("cache-control", "no-store".into())], Json(meta)).into_response())
    };
    tokio::select! {
        biased;
        _ = principal.0.cancelled() => refused(),
        r = tokio::time::timeout(Duration::from_secs(10),observe) => r.ok().flatten().unwrap_or_else(refused),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_origins_and_proofs_retain_their_exact_scope() {
        assert_eq!(normalize("HTTPS://127.0.0.1:3000/").unwrap().as_str(), "https://127.0.0.1:3000/");
        for input in [
            "https://localhost/.",
            "https://localhost?",
            "https://localhost#",
            "https://user@localhost",
            "https://localhost\\path",
            "https://*.localhost",
            "file:///C:/test",
        ] {
            assert!(normalize(input).is_none(), "{input}");
        }
        assert!(sound_proof(&"x".repeat(43)));
        assert!(!sound_proof("bootstrap"));
        let mut headers = HeaderMap::new();
        headers.append(PROOF, "bootstrap".parse().unwrap());
        headers.append(PROOF, "other".parse().unwrap());
        assert_eq!(proof(&headers), None);
    }

    #[test]
    fn detach_cancels_existing_transfers_only() {
        let signal = CancellationToken::new();
        let g = Generation {
            id: "fixture".into(),
            origin: normalize("https://127.0.0.1:3000").unwrap(),
            skip_tls: false,
            proof: "x".repeat(43),
            server: "fixture".into(),
            identity: [0; 32],
            transfers: Mutex::new(signal.child_token()),
            signal,
            cookie: Mutex::new(None),
        };
        let first = g.preview_lifetime();
        g.detach();
        assert!(first.is_cancelled());
        let second = g.preview_lifetime();
        assert!(!second.is_cancelled());
        g.signal.cancel();
        assert!(second.is_cancelled());
    }
}

fn session_cookie(headers: &HeaderMap) -> Option<String> {
    let c = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .filter_map(|v| v.split(';').next())
        .filter(|pair| {
            pair.split_once('=').is_some_and(|(name, value)| {
                (name == crate::auth::DEFAULT_COOKIE || name.starts_with("codenomad_session_")) && !value.is_empty()
            })
        })
        .collect::<Vec<_>>();
    (!c.is_empty()).then(|| c.join("; "))
}
async fn control_request(
    client: &Client,
    origin: &Url,
    credential: &Credential,
    cookie: &Option<String>,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Option<reqwest::Response> {
    let mut request = client.request(method, origin.join(path).ok()?);
    if let Some(c) = cookie {
        request = request.header(header::COOKIE, c);
    }
    if matches!(credential.secret, Secret::Device { .. }) {
        if origin.scheme() != "https" {
            return None;
        }
        request = request.header("x-codenomad-server-request", "1");
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    request.send().await.ok()
}

pub async fn control(
    app: &Shared,
    g: &Generation,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Option<reqwest::Response> {
    if !g.current(app) {
        g.signal.cancel();
        return None;
    }
    let (_, _, credential) = profile(app, &g.id)?;
    let call = async {
        let client = super::proxy::pinned_client(app, &g.origin, g.skip_tls, true).await.ok()?;
        if !g.current(app) {
            g.signal.cancel();
            return None;
        }
        let cookie = g.cookie.lock().unwrap().clone();
        let response = control_request(&client, &g.origin, &credential, &cookie, method, path, body).await?;
        if response.status() == Status::UNAUTHORIZED || !g.current(app) {
            g.signal.cancel();
            return None;
        }
        Some(response)
    };
    tokio::select! {
        _ = g.signal.cancelled() => None,
        r = tokio::time::timeout(Duration::from_secs(10),call) => r.ok().flatten(),
    }
}

async fn forget(State(app): State<Shared>, Path(id): Path<String>, request: Request) -> Response {
    if !guard(&app, &request) || crate::auth::tls::https_only(&request).is_some() {
        return deny();
    }
    if !id_ok(&id) {
        return refused();
    }
    let _serialized = app.previews.owners.mutation.lock().await;
    if !guard(&app, &request) {
        return deny();
    }
    app.previews.owners.retire(&id);
    if erase_credential(&app, &id, None).is_err() {
        return refused();
    }
    Json(json!({"ok":true})).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Connect {
    username: Option<String>,
    password: Option<String>,
    pairing_link: Option<String>,
}
async fn connect(State(app): State<Shared>, Path(id): Path<String>, request: Request) -> Response {
    if !guard(&app, &request) || crate::auth::tls::https_only(&request).is_some() {
        return deny();
    }
    if request.headers().contains_key(PROOF) {
        let Some(p) = proof(request.headers()) else { return refused() };
        if p != "bootstrap" && app.previews.owners.exact(&app, &id, p).is_none() {
            return refused();
        }
    }
    let principal = request.extensions().get::<Principal>().unwrap().0.clone();
    let action = async {
        let body = axum::body::to_bytes(request.into_body(), 24 * 1024).await.ok()?;
        let body: Connect = serde_json::from_slice(&body).ok()?;
        let _write = app.previews.owners.mutation.lock().await;
        let (origin, skip) = saved_origin(&app, &id)?;
        let authority = origin.origin().ascii_serialization();
        let client = super::proxy::pinned_client(&app, &origin, skip, true).await.ok()?;
        let secret = match (body.username, body.password, body.pairing_link) {
            (None, None, Some(link)) if origin.scheme() == "https" => {
                let marker = format!("{authority}/remote-pair#");
                let code = link.strip_prefix(&marker)?;
                if code.len() != 32 || !code.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) {
                    return None;
                }
                if saved_origin(&app, &id) != Some((origin.clone(), skip)) {
                    return None;
                }
                let response = client
                    .post(origin.join("/api/remote-control/server-pair").ok()?)
                    .header("x-codenomad-server-pairing", "1")
                    .json(&json!({"code":code,"hostName":"CodeNomad"}))
                    .send()
                    .await
                    .ok()?;
                if !response.status().is_success() {
                    return None;
                }
                let receipt = crate::opencode::read_json(response, 16 * 1024).await.ok()?;
                let cookie = receipt["credential"].as_str().filter(|s| sound_proof(s))?;
                Secret::Device { cookie: format!("{}={cookie}", crate::auth::devices::COOKIE) }
            }
            (Some(username), Some(password), None)
                if !username.is_empty() && username.len() <= 1024 && !password.is_empty() && password.len() <= 8192 =>
            {
                if saved_origin(&app, &id) != Some((origin.clone(), skip)) {
                    return None;
                }
                let response = client
                    .post(origin.join("/api/auth/login").ok()?)
                    .json(&json!({"username":username,"password":password}))
                    .send()
                    .await
                    .ok()?;
                if !response.status().is_success() {
                    return None;
                }
                Secret::Password { username, password, cookie: Some(session_cookie(response.headers())?) }
            }
            (None, None, None) => profile(&app, &id)?.2.secret,
            _ => return None,
        };
        let credential = Credential { origin: authority, skip_tls_verify: skip, secret };
        let response =
            control_request(&client, &origin, &credential, &credential.cookie(), Method::GET, "/api/auth/status", None)
                .await?;
        if response.status() != Status::OK
            || crate::opencode::read_json(response, 16 * 1024).await.ok()?["authenticated"] != true
            || saved_origin(&app, &id) != Some((origin, skip))
            || principal.is_cancelled()
        {
            return None;
        }
        let file = credentials_path(&app);
        let mut stored = if std::fs::symlink_metadata(&file).is_ok() {
            read_credential_file(&app).ok()?
        } else {
            json!({"servers":{}})
        };
        stored["servers"][&id] = serde_json::to_value(&credential).ok()?;
        crate::auth::tls::write_private(&file, stored.to_string().as_bytes()).ok()?;
        app.previews.owners.reconcile(&app);
        Some(Json(json!({"ok":true})).into_response())
    };
    let cancel = principal.clone();
    tokio::select! {
        biased;
        _ = cancel.cancelled() => deny(),
        r = tokio::time::timeout(Duration::from_secs(10),action) => r.ok().flatten().unwrap_or_else(deny),
    }
}
