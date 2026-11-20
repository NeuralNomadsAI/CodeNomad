//! Paired remote devices: one-time pairing links, the device registry under the data
//! folder and the HTTPS pairing exchange that binds a device cookie.
use crate::{
    Shared,
    auth::tls::{self, Channel, write_private},
    shared::panic_guard::Lock,
};
use axum::{
    Extension, Json,
    body::Bytes,
    extract::{Path as RoutePath, Request, State},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const COOKIE: &str = "__Host-codenomad_device";
const INVALID: &str = "This pairing link is invalid, already used or expired";
type Fail = Box<dyn std::error::Error>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: Uuid,
    name: String,
    token_hash: String,
    created_at: String,
    last_seen_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    push_epoch: Option<Uuid>,
}
impl Device {
    fn public(&self) -> Value {
        let mut r = json!({"id":self.id,"name":self.name,"createdAt":self.created_at,"lastSeenAt":self.last_seen_at});
        if let Some(origin) = &self.origin {
            r["origin"] = json!(origin);
        }
        r
    }
    fn live(&self) -> bool {
        DateTime::parse_from_rfc3339(&self.last_seen_at)
            .is_ok_and(|t| t.timestamp_millis() + 30 * 86400000 > Utc::now().timestamp_millis())
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    version: u8,
    route: String,
    devices: Vec<Device>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tunnel_push_epoch: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    previews: Option<bool>,
}
struct Pairing {
    hash: [u8; 32],
    until: Instant,
    origin: Option<String>,
}
pub struct Devices {
    file: PathBuf,
    doc: Document,
    pairing: Option<Pairing>,
    pub origin: String,
    pub ingress: bool,
    pub disabled: bool,
    tokens: HashMap<Uuid, CancellationToken>,
    written: HashMap<Uuid, Instant>,
    failures: u32,
    reset: Instant,
}
fn entropy<const N: usize>() -> Result<[u8; N], Fail> {
    let mut b = [0; N];
    getrandom::fill(&mut b).map_err(|_| "Random source unavailable")?;
    Ok(b)
}
fn hash(s: &str) -> [u8; 32] {
    Sha256::digest(s.as_bytes()).into()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn direct_origin(origin: &str) -> bool {
    reqwest::Url::parse(origin).is_ok_and(|url|url.scheme()=="https" && url.host_str().is_some_and(|host| {
            let host=host.trim_matches(['[',']']).to_ascii_lowercase();
            !host.starts_with("0.") && host.parse::<std::net::IpAddr>().map_or_else(|_|host!="localhost"&&!host.ends_with(".localhost"),
                |ip| !ip.is_unspecified()&&!ip.is_loopback()&&!matches!(ip,std::net::IpAddr::V6(v) if v.to_ipv4_mapped().is_some_and(|v|v.is_loopback()||v.is_unspecified())))
        }))
}
/// The registry of `<data>/devices`, private like `tls/`.
pub fn open(data: &Path, tls: &tls::Listener) -> Result<Lock<Devices>, Fail> {
    let dir = data.join("devices");
    tls::private_directory(&dir)?;
    Ok(Lock::new(Devices::open(&dir, tls.origin.clone(), tls.ingress)?))
}
/// Expired pairings and sessions leave the registry within 250 ms.
pub async fn sweep(app: Shared, stop: CancellationToken) {
    loop {
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
        app.devices.as_ref().unwrap().lock().unwrap().prune();
    }
}
impl Devices {
    fn open(path: &Path, origin: String, ingress: bool) -> Result<Self, Fail> {
        let file = path.join("remote-control-devices.json");
        let doc = match fs::File::open(&file) {
            Ok(f) => {
                let mut data = Vec::new();
                f.take(65537).read_to_end(&mut data)?;
                if data.len() > 65536 {
                    return Err("Device registry exceeds limit".into());
                }
                serde_json::from_slice(&data)?
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {
                Document { version: 1, route: format!("codenomad-{}", hex(&entropy::<6>()?)), ..Default::default() }
            }
            Err(e) => return Err(e.into()),
        };
        if doc.version != 1
            || doc.devices.len() > 32
            || doc.route.is_empty()
            || doc.route.len() > 63
            || !doc.route.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || doc.devices.iter().any(|d| {
                d.token_hash.len() != 64
                    || !d.token_hash.bytes().all(|b| b.is_ascii_hexdigit())
                    || DateTime::parse_from_rfc3339(&d.last_seen_at).is_err()
                    || DateTime::parse_from_rfc3339(&d.created_at).is_err()
                    || d.name.is_empty()
                    || d.name.encode_utf16().count() > 80
            })
        {
            return Err("Invalid device registry; left unchanged".into());
        }
        let disabled = match crate::config::remote_control().trim().to_ascii_lowercase().as_str() {
            "" => false,
            "disabled" => true,
            _ => return Err("Unknown remote control policy".into()),
        };
        Ok(Self::new(file, doc, origin, ingress, disabled))
    }
    fn new(file: PathBuf, doc: Document, origin: String, ingress: bool, disabled: bool) -> Self {
        let (tokens, written, reset) = (HashMap::new(), HashMap::new(), Instant::now());
        Self { file, doc, pairing: None, origin, ingress, disabled, tokens, written, failures: 0, reset }
    }
    fn persist(&self, doc: &Document) -> Result<(), Fail> {
        Ok(write_private(&self.file, &serde_json::to_vec_pretty(doc)?)?)
    }
    fn drop_principal(&mut self, id: Uuid) {
        if let Some(token) = self.tokens.remove(&id) {
            token.cancel();
        }
        self.written.remove(&id);
    }
    pub fn prune(&mut self) {
        let expired = self.doc.devices.iter().filter(|d| !d.live()).map(|d| d.id).collect::<Vec<_>>();
        for id in expired {
            self.drop_principal(id);
        }
    }
    pub fn authenticate(&mut self, token: &str, origin: Option<&str>) -> Option<(Uuid, CancellationToken)> {
        if self.disabled || token.len() != 43 {
            return None;
        }
        let hashed = hex(&hash(token));
        let d = self.doc.devices.iter_mut().find(|d| {
            bool::from(d.token_hash.as_bytes().ct_eq(hashed.as_bytes())) && d.origin.as_deref() == origin && d.live()
        })?;
        let id = d.id;
        d.last_seen_at = crate::now();
        if self.written.get(&id).is_none_or(|t| t.elapsed() >= Duration::from_secs(600)) {
            self.persist(&self.doc).ok()?;
            self.written.insert(id, Instant::now());
        }
        Some((id, self.tokens.entry(id).or_default().clone()))
    }
    fn issue(&mut self, origin: Option<String>) -> Result<Value, Fail> {
        let code = URL_SAFE_NO_PAD.encode(entropy::<24>()?);
        let expires_at =
            (Utc::now() + chrono::Duration::minutes(5)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let url = format!("{}/remote-pair#{code}", self.origin);
        self.pairing = Some(Pairing { hash: hash(&code), until: Instant::now() + Duration::from_secs(300), origin });
        Ok(json!({"url":url,"expiresAt":expires_at}))
    }
    fn exchange(&mut self, code: &str, name: String, origin: Option<&str>) -> Result<Option<(Value, String)>, Fail> {
        if self.disabled
            || !self.pairing.as_ref().is_some_and(|p| {
                p.origin.as_deref() == origin && p.until > Instant::now() && bool::from(p.hash.ct_eq(&hash(code)))
            })
        {
            return Ok(None);
        }
        self.pairing = None;
        self.prune();
        let mut doc = self.doc.clone();
        doc.devices.retain(Device::live);
        let evicted = if doc.devices.len() == 32 {
            doc.devices.sort_by(|a, b| a.last_seen_at.cmp(&b.last_seen_at));
            Some(doc.devices.remove(0).id)
        } else {
            None
        };
        let token = URL_SAFE_NO_PAD.encode(entropy::<32>()?);
        let now = crate::now();
        let visible: String = name.chars().filter(|c| !c.is_ascii_control()).collect();
        let name = String::from_utf16_lossy(&visible.trim().encode_utf16().take(80).collect::<Vec<_>>());
        let d = Device {
            id: Uuid::new_v4(),
            name: if name.is_empty() { "Device".into() } else { name },
            token_hash: hex(&hash(&token)),
            created_at: now.clone(),
            last_seen_at: now,
            origin: origin.map(str::to_owned),
            push_epoch: None,
        };
        let public = d.public();
        doc.devices.push(d);
        self.persist(&doc)?;
        self.doc = doc;
        if let Some(id) = evicted {
            self.drop_principal(id);
        }
        Ok(Some((public, token)))
    }
    fn failure(&mut self) -> Option<u64> {
        let now = Instant::now();
        if now >= self.reset {
            self.failures = 0;
            self.reset = now + Duration::from_secs(60);
        }
        self.failures = self.failures.saturating_add(1);
        (self.failures > 10).then(|| self.reset.saturating_duration_since(now).as_millis().div_ceil(1000).max(1) as u64)
    }
}
fn reply(status: Status, message: &str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Direct {
    origin: String,
}
pub async fn issue(State(app): State<Shared>, body: Bytes) -> Response {
    let Some(devices) = &app.devices else { return crate::unavailable() };
    let mut d = devices.lock().unwrap();
    if d.disabled {
        return (Status::FORBIDDEN,Json(json!({"error":"Remote Control is disabled by the host administrator","code":"remote_control_disabled"}))).into_response();
    }
    let input = if body.is_empty() { Ok(None) } else { serde_json::from_slice::<Option<Direct>>(&body) };
    let origin = match input {
        Ok(None) if d.ingress => None,
        Ok(Some(body)) if !d.ingress && body.origin == d.origin && direct_origin(&d.origin) => Some(body.origin),
        Ok(_) => return reply(Status::CONFLICT, "This origin cannot pair devices"),
        Err(_) => return reply(Status::BAD_REQUEST, "Invalid direct pairing body"),
    };
    match d.issue(origin) {
        Ok(value) => Json(value).into_response(),
        Err(_) => reply(Status::SERVICE_UNAVAILABLE, "Pairing unavailable"),
    }
}
/// `GET /api/remote-control/status`: this server has no tunnel, so Remote Control is always stopped
/// and never resumes; paired devices and the direct HTTPS origin come from this registry.
pub async fn status(State(app): State<Shared>, channel: Option<Extension<Channel>>) -> Json<Value> {
    let local = channel.is_none();
    let (paired, origin) = match &app.devices {
        Some(d) => {
            let d = d.lock().unwrap();
            let origin = (!d.ingress && direct_origin(&d.origin)).then(|| d.origin.clone());
            (d.doc.devices.iter().filter(|d| d.live()).count(), origin)
        }
        None => (0, None),
    };
    let mut status = json!({"manageable": local, "enabled": false, "startsOnLaunch": false,
        "previews": false, "state": "stopped", "pairedDevices": paired});
    if crate::config::remote_control().trim().eq_ignore_ascii_case("disabled") {
        status["disabledByAdministrator"] = json!(true);
    }
    if let Some(origin) = origin.filter(|_| local) {
        status["directOrigins"] = json!([origin]);
    }
    Json(status)
}
pub async fn list(State(app): State<Shared>) -> Response {
    let Some(d) = &app.devices else { return crate::unavailable() };
    let d = d.lock().unwrap();
    Json(json!({"devices":d.doc.devices.iter().filter(|d|d.live()).map(Device::public).collect::<Vec<_>>()}))
        .into_response()
}
pub async fn revoke(State(app): State<Shared>, RoutePath(id): RoutePath<Uuid>) -> Response {
    let Some(d) = &app.devices else { return crate::unavailable() };
    let mut d = d.lock().unwrap();
    let mut doc = d.doc.clone();
    doc.devices.retain(|x| x.id != id);
    d.drop_principal(id);
    if doc.devices.len() == d.doc.devices.len() {
        return reply(Status::NOT_FOUND, "Remote device not found");
    }
    // Refuse the old token immediately even if the durable revocation fails.
    d.doc = doc;
    if d.persist(&d.doc).is_err() {
        d.disabled = true;
        for token in d.tokens.values() {
            token.cancel();
        }
        return reply(Status::SERVICE_UNAVAILABLE, "Revocation persistence unavailable");
    }
    Status::NO_CONTENT.into_response()
}
pub async fn exchange(State(app): State<Shared>, Extension(channel): Extension<Channel>, req: Request) -> Response {
    let server = req.uri().path().ends_with("/server-pair");
    let agent = req.headers().get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
    let Ok(bytes) = axum::body::to_bytes(req.into_body(), 4096).await else {
        return reply(Status::PAYLOAD_TOO_LARGE, "Request body is too large");
    };
    let value: Value = serde_json::from_slice(&bytes).unwrap_or_default();
    let code = value["code"].as_str().filter(|s| !s.is_empty() && s.encode_utf16().count() <= 256);
    let hostname =
        value["hostName"].as_str().map(str::trim).filter(|s| !s.is_empty() && s.encode_utf16().count() <= 255);
    let valid_server = code.is_some_and(|code| {
        code.len() == 32 && code.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    }) && hostname.is_some()
        && value.as_object().is_some_and(|o| o.len() == 2);
    let d = app.devices.as_ref().unwrap();
    let mut d = d.lock().unwrap();
    let code = code.filter(|_| !server || valid_server);
    if let Some(code) = code {
        let name = if server { format!("CodeNomad · {}", hostname.unwrap()) } else { device_name(&agent) };
        match d.exchange(code, name, (!channel.ingress).then_some(&channel.origin)) {
            Ok(Some((device, token))) => {
                let no_store = (header::CACHE_CONTROL, "no-store".to_owned());
                if server {
                    return ([no_store], Json(json!({"device": device, "credential": token}))).into_response();
                }
                let cookie = format!("{COOKIE}={token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000");
                return ([no_store, (header::SET_COOKIE, cookie)], Json(json!({"device": device}))).into_response();
            }
            Err(_) => return reply(Status::SERVICE_UNAVAILABLE, "Pairing unavailable"),
            _ => {}
        }
    }
    let mut failure = if (server || !channel.ingress)
        && let Some(seconds) = d.failure()
    {
        (
            Status::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, seconds.to_string())],
            Json(json!({"error":"Pairing rate limited"})),
        )
            .into_response()
    } else if server && !valid_server {
        reply(Status::BAD_REQUEST, "Invalid server pairing body")
    } else {
        reply(Status::UNAUTHORIZED, INVALID)
    };
    if server {
        failure.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    failure
}
fn device_name(agent: &str) -> String {
    let os = [
        ("iPhone", "iPhone"),
        ("iPad", "iPad"),
        ("Android", "Android"),
        ("Windows", "Windows"),
        ("Mac OS X", "macOS"),
        ("Macintosh", "macOS"),
        ("Linux", "Linux"),
    ]
    .into_iter()
    .find(|(s, _)| agent.contains(s))
    .map_or("Device", |(_, n)| n);
    let browser = [("Edg/", "Edge"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari")]
        .into_iter()
        .find(|(s, _)| agent.contains(s))
        .map_or("Browser", |(_, n)| n);
    format!("{os} · {browser}")
}
pub async fn page() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::X_FRAME_OPTIONS, "DENY"),
        ],
        include_str!("../../../server/src/server/routes/auth-pages/remote-pair.html"),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_and_wrong_channel_codes_never_persist() {
        let doc = Document { version: 1, route: "test".into(), ..Default::default() };
        let mut devices = Devices::new("not-used".into(), doc, "https://localhost:1234".into(), true, false);
        let until = Instant::now() - Duration::from_secs(1);
        devices.pairing = Some(Pairing { hash: hash("fixture"), until, origin: None });
        assert!(devices.exchange("fixture", "Device".into(), None).unwrap().is_none());
        devices.pairing.as_mut().unwrap().until = Instant::now() + Duration::from_secs(1);
        assert!(devices.exchange("fixture", "Device".into(), Some("https://other.invalid")).unwrap().is_none());
        assert!(devices.doc.devices.is_empty());
        assert!(devices.pairing.is_some());
    }
}
