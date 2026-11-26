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
    response::{Html, IntoResponse, Response},
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
pub fn clear_cookie() -> String {
    format!("{COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0")
}
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
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    server: bool,
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
    persisted: bool,
    pairing: Option<Pairing>,
    pub origin: String,
    pub origins: Vec<String>,
    pub ingress: bool,
    pub disabled_by_admin: bool,
    pub revocation_locked: bool,
    pending_revocations: HashMap<Uuid, Value>,
    tokens: HashMap<Uuid, (bool, CancellationToken)>,
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
/// The reference's `remote-control-devices.json` in the private data folder, shared with it: a device
/// paired by either server is admitted, and revoked, by both. An earlier `devices/` copy moves there once.
pub fn open(data: &Path, tls: Option<&tls::Listener>) -> Result<Lock<Devices>, Fail> {
    let file = data.join("remote-control-devices.json");
    let earlier = data.join("devices").join("remote-control-devices.json");
    if !file.exists() && earlier.is_file() {
        fs::rename(&earlier, &file)?;
    }
    let (origin, origins, ingress) = match tls {
        Some(tls) => (tls.origin.clone(), tls.direct_origins.clone(), tls.ingress),
        None => (String::new(), Vec::new(), false),
    };
    Ok(Lock::new(Devices::open(file, origin, origins, ingress)?))
}

#[cfg(test)]
pub(crate) fn open_for_test(data: &Path, origin: String, origins: Vec<String>) -> Lock<Devices> {
    Lock::new(
        Devices::open_with_policy(data.join("remote-control-devices.json"), origin, origins, false, false).unwrap(),
    )
}

#[cfg(test)]
pub(crate) fn open_for_test_with_policy(
    data: &Path,
    origin: String,
    origins: Vec<String>,
    disabled_by_admin: bool,
) -> Lock<Devices> {
    Lock::new(
        Devices::open_with_policy(data.join("remote-control-devices.json"), origin, origins, false, disabled_by_admin)
            .unwrap(),
    )
}
#[cfg(test)]
pub(crate) fn open_ingress_for_test(data: &Path, origin: String) -> Lock<Devices> {
    Lock::new(Devices::open(data.join("remote-control-devices.json"), origin.clone(), vec![origin], true).unwrap())
}
/// Expired pairings and sessions leave the registry within 250 ms.
pub async fn sweep(app: Shared, stop: CancellationToken) {
    loop {
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
        if let Some(devices) = &app.devices {
            devices.lock().unwrap().prune();
        }
    }
}
impl Devices {
    pub fn is_paired(&self, id: Uuid, origin: Option<&str>) -> bool {
        !self.disabled_by_admin
            && !self.revocation_locked
            && self.doc.devices.iter().any(|d| d.id == id && d.origin.as_deref() == origin && d.live())
    }
    pub(crate) fn is_authorized(&self, id: Uuid, tunnel_active: bool) -> bool {
        if self.disabled_by_admin || self.revocation_locked {
            return false;
        }
        self.doc.devices.iter().any(|d| {
            d.id == id
                && d.live()
                && match d.origin.as_deref() {
                    None => tunnel_active || self.ingress,
                    Some(origin) => self.origins.iter().any(|o| o == origin) && direct_origin(origin),
                }
        })
    }
    /// Registry setting: previews are enabled by default unless explicitly turned off.
    pub fn previews_allowed(&self) -> bool {
        self.doc.previews != Some(false)
    }
    /// Effective remote preview admission, respecting administrator disable and revocation lock.
    pub fn previews_allowed_for_remote(&self) -> bool {
        !self.disabled_by_admin && !self.revocation_locked && self.previews_allowed()
    }
    pub fn starts_on_launch(&self) -> bool {
        self.doc.enabled == Some(true)
    }
    pub fn set_starts_on_launch(&mut self, enabled: bool) -> Result<(), Fail> {
        let _lock = self.lock_registry()?;
        let disk = Self::read_disk(&self.file)?;
        if !enabled && disk.is_none() && !self.persisted && !self.starts_on_launch() {
            return Ok(());
        }
        let mut doc = disk.unwrap_or_else(|| self.doc.clone());
        if !self.pending_revocations.is_empty() {
            doc.devices.retain(|d| !self.pending_revocations.contains_key(&d.id));
        }
        if enabled && doc.enabled == Some(true) && self.persisted && self.pending_revocations.is_empty() {
            self.doc = doc;
            return Ok(());
        }
        doc.enabled = Some(enabled);
        self.persist(&doc)?;
        self.doc = doc;
        self.persisted = true;
        self.pending_revocations.clear();
        self.revocation_locked = false;
        Ok(())
    }
    /// The stable tunnel route, persisted on first use so hosts that never enable Remote Control write nothing.
    pub fn route(&mut self) -> Result<String, Fail> {
        if !self.persisted {
            self.mutate_persisted(|_| {})?;
        }
        Ok(self.doc.route.clone())
    }
    pub fn paired_count(&self) -> usize {
        self.doc.devices.iter().filter(|d| d.live()).count()
    }
    /// Cancels an unused tunnel code; a direct HTTPS code is independent of the tunnel.
    pub fn cancel_tunnel_pairing(&mut self) {
        if self.pairing.as_ref().is_some_and(|p| p.origin.is_none()) {
            self.pairing = None;
        }
    }
    pub fn issue_tunnel(&mut self, base_url: &str) -> Result<Value, Fail> {
        self.issue_with_base(None, base_url)
    }
    fn open(file: PathBuf, origin: String, origins: Vec<String>, ingress: bool) -> Result<Self, Fail> {
        let disabled_by_admin = match crate::config::remote_control().trim().to_ascii_lowercase().as_str() {
            "" => false,
            "disabled" => true,
            _ => return Err("Unknown remote control policy".into()),
        };
        Self::open_with_policy(file, origin, origins, ingress, disabled_by_admin)
    }
    fn open_with_policy(
        file: PathBuf,
        origin: String,
        origins: Vec<String>,
        ingress: bool,
        disabled_by_admin: bool,
    ) -> Result<Self, Fail> {
        let (doc, persisted) = match fs::File::open(&file) {
            Ok(f) => {
                let mut data = Vec::new();
                f.take(65537).read_to_end(&mut data)?;
                if data.len() > 65536 {
                    return Err("Device registry exceeds limit".into());
                }
                (serde_json::from_slice(&data)?, true)
            }
            Err(e) if e.kind() == ErrorKind::NotFound => (
                Document { version: 1, route: format!("codenomad-{}", hex(&entropy::<6>()?)), ..Default::default() },
                false,
            ),
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
        Ok(Self::new(file, doc, persisted, origin, origins, ingress, disabled_by_admin))
    }
    fn new(
        file: PathBuf,
        doc: Document,
        persisted: bool,
        origin: String,
        origins: Vec<String>,
        ingress: bool,
        disabled_by_admin: bool,
    ) -> Self {
        let (tokens, written, reset) = (HashMap::new(), HashMap::new(), Instant::now());
        Self {
            file,
            doc,
            persisted,
            pairing: None,
            origin,
            origins,
            ingress,
            disabled_by_admin,
            revocation_locked: false,
            pending_revocations: HashMap::new(),
            tokens,
            written,
            failures: 0,
            reset,
        }
    }
    fn valid_doc(doc: &Document) -> bool {
        doc.version == 1
            && doc.devices.len() <= 32
            && !doc.route.is_empty()
            && doc.route.len() <= 63
            && doc.route.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && doc.devices.iter().all(|d| {
                d.token_hash.len() == 64
                    && d.token_hash.bytes().all(|b| b.is_ascii_hexdigit())
                    && DateTime::parse_from_rfc3339(&d.last_seen_at).is_ok()
                    && DateTime::parse_from_rfc3339(&d.created_at).is_ok()
                    && !d.name.is_empty()
                    && d.name.encode_utf16().count() <= 80
            })
    }
    fn read_disk(file: &Path) -> Result<Option<Document>, Fail> {
        match fs::File::open(file) {
            Ok(f) => {
                let mut data = Vec::new();
                f.take(65537).read_to_end(&mut data)?;
                if data.len() > 65536 {
                    return Err("Device registry exceeds limit".into());
                }
                let doc: Document = serde_json::from_slice(&data)?;
                if !Self::valid_doc(&doc) {
                    return Err("Invalid device registry; left unchanged".into());
                }
                Ok(Some(doc))
            }
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    fn lock_registry(&self) -> Result<fs::File, Fail> {
        if let Some(parent) = self.file.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)?;
        }
        let lock_path = self.file.with_extension("json.lock");
        let mut opts = fs::OpenOptions::new();
        opts.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let lock_file = opts.open(lock_path)?;
        lock_file.lock()?;
        Ok(lock_file)
    }
    fn persist(&self, doc: &Document) -> Result<(), Fail> {
        Ok(write_private(&self.file, format!("{}\n", serde_json::to_string_pretty(doc)?).as_bytes())?)
    }
    /// Serializes writes across backends and merges the latest on-disk device list before applying
    /// a mutation, so one backend's flag update never resurrects a device revoked by another.
    fn mutate_persisted<R>(&mut self, update: impl FnOnce(&mut Document) -> R) -> Result<R, Fail> {
        let _lock = self.lock_registry()?;
        let mut doc = match Self::read_disk(&self.file)? {
            Some(disk) => disk,
            None => self.doc.clone(),
        };
        if !self.pending_revocations.is_empty() {
            doc.devices.retain(|d| !self.pending_revocations.contains_key(&d.id));
        }
        let result = update(&mut doc);
        self.persist(&doc)?;
        self.doc = doc;
        self.persisted = true;
        self.pending_revocations.clear();
        self.revocation_locked = false;
        Ok(result)
    }
    fn drop_principal(&mut self, id: Uuid) {
        if let Some((_, token)) = self.tokens.remove(&id) {
            token.cancel();
        }
        self.written.remove(&id);
    }
    /// Cancels all tunnel device principals without affecting verified direct HTTPS devices.
    pub fn drop_tunnel_principals(&mut self) {
        let ids: Vec<Uuid> = self.tokens.iter().filter(|(_, (is_tunnel, _))| *is_tunnel).map(|(id, _)| *id).collect();
        for id in ids {
            self.drop_principal(id);
        }
    }
    /// Cancels all device principals (both tunnel and direct HTTPS) on server shutdown.
    pub fn drop_all_principals(&mut self) {
        for (_, (_, token)) in self.tokens.drain() {
            token.cancel();
        }
        self.written.clear();
    }
    pub fn prune(&mut self) {
        let expired = self.doc.devices.iter().filter(|d| !d.live()).map(|d| d.id).collect::<Vec<_>>();
        for id in expired {
            self.drop_principal(id);
        }
    }
    pub fn authenticate(
        &mut self,
        token: &str,
        origin: Option<&str>,
        tunnel_active: bool,
    ) -> Option<(Uuid, CancellationToken)> {
        if self.disabled_by_admin || self.revocation_locked || token.len() != 43 {
            return None;
        }
        match origin {
            None if !(tunnel_active || self.ingress) => return None,
            Some(origin) if !self.origins.iter().any(|o| o == origin) || !direct_origin(origin) => return None,
            _ => {}
        }
        let hashed = hex(&hash(token));
        let d = self.doc.devices.iter_mut().find(|d| {
            bool::from(d.token_hash.as_bytes().ct_eq(hashed.as_bytes())) && d.origin.as_deref() == origin && d.live()
        })?;
        let id = d.id;
        let is_tunnel = d.origin.is_none();
        let now = crate::now();
        d.last_seen_at = now.clone();
        if self.written.get(&id).is_none_or(|t| t.elapsed() >= Duration::from_secs(600)) {
            let still_present = self
                .mutate_persisted(|doc| {
                    if let Some(entry) = doc.devices.iter_mut().find(|x| x.id == id && x.live()) {
                        entry.last_seen_at = now;
                        true
                    } else {
                        false
                    }
                })
                .ok()?;
            if !still_present {
                self.drop_principal(id);
                return None;
            }
            self.written.insert(id, Instant::now());
        }
        let entry = self.tokens.entry(id).or_insert_with(|| (is_tunnel, CancellationToken::new()));
        if entry.1.is_cancelled() {
            *entry = (is_tunnel, CancellationToken::new());
        }
        Some((id, entry.1.clone()))
    }
    pub fn is_server_device(&self, id: Uuid) -> bool {
        self.doc.devices.iter().any(|d| d.id == id && (d.server || d.name.starts_with("CodeNomad ·")))
    }

    fn issue_with_base(&mut self, origin: Option<String>, base: &str) -> Result<Value, Fail> {
        let code = URL_SAFE_NO_PAD.encode(entropy::<24>()?);
        let expires_at =
            (Utc::now() + chrono::Duration::minutes(5)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let url = format!("{base}/remote-pair#{code}");
        self.pairing = Some(Pairing { hash: hash(&code), until: Instant::now() + Duration::from_secs(300), origin });
        Ok(json!({"url":url,"expiresAt":expires_at}))
    }
    fn exchange(
        &mut self,
        code: &str,
        name: String,
        origin: Option<&str>,
        tunnel_active: bool,
        server: bool,
    ) -> Result<Option<(Value, String)>, Fail> {
        if self.disabled_by_admin || self.revocation_locked {
            return Ok(None);
        }
        match origin {
            None if !(tunnel_active || self.ingress) => return Ok(None),
            Some(origin) if !self.origins.iter().any(|o| o == origin) || !direct_origin(origin) => return Ok(None),
            _ => {}
        }
        if !self.pairing.as_ref().is_some_and(|p| {
            p.origin.as_deref() == origin && p.until > Instant::now() && bool::from(p.hash.ct_eq(&hash(code)))
        }) {
            return Ok(None);
        }
        self.pairing = None;
        self.prune();
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
            server,
        };
        let public = d.public();
        let evicted = self.mutate_persisted(|doc| {
            doc.devices.retain(Device::live);
            let evicted = if doc.devices.len() >= 32 {
                doc.devices.sort_by(|a, b| a.last_seen_at.cmp(&b.last_seen_at));
                Some(doc.devices.remove(0).id)
            } else {
                None
            };
            doc.devices.push(d);
            evicted
        })?;
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

pub async fn set_previews(State(app): State<Shared>, body: Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return crate::error(Status::BAD_REQUEST, "Invalid previews setting").into_response();
    };
    let Some(enabled) = body.get("enabled").and_then(Value::as_bool) else {
        return crate::error(Status::BAD_REQUEST, "Invalid previews setting").into_response();
    };
    let Some(devices) = &app.devices else { return crate::unavailable() };
    {
        let mut d = devices.lock().unwrap();
        if d.mutate_persisted(|doc| {
            doc.previews = (!enabled).then_some(false);
        })
        .is_err()
        {
            return crate::error(Status::SERVICE_UNAVAILABLE, "Preview policy could not be saved").into_response();
        }
    }
    if !enabled {
        app.previews.revoke_devices();
    }
    Json(app.remote_control.status(&app, true)).into_response()
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
    let tunnel_url = app.remote_control.tunnel_url();
    let mut d = devices.lock().unwrap();
    if d.disabled_by_admin {
        return (
            Status::FORBIDDEN,
            Json(json!({"error": crate::remote_control::REMOTE_CONTROL_DISABLED, "code": "remote_control_disabled"})),
        )
            .into_response();
    }
    let input = if body.is_empty() { Ok(None) } else { serde_json::from_slice::<Option<Direct>>(&body) };
    let (origin, base) = match input {
        Ok(None) => {
            if let Some(url) = tunnel_url {
                (None, url)
            } else if d.ingress {
                (None, d.origin.clone())
            } else {
                return reply(Status::CONFLICT, "Remote Control is not connected");
            }
        }
        Ok(Some(body)) if body.origin.is_empty() || body.origin.encode_utf16().count() > 2048 => {
            return reply(Status::BAD_REQUEST, "Invalid direct pairing body");
        }
        Ok(Some(body)) if !d.ingress && d.origins.contains(&body.origin) && direct_origin(&body.origin) => {
            let base = body.origin.clone();
            (Some(body.origin), base)
        }
        Ok(Some(_)) => return reply(Status::CONFLICT, "This origin cannot pair devices"),
        Err(_) => return reply(Status::BAD_REQUEST, "Invalid direct pairing body"),
    };
    match d.issue_with_base(origin, &base) {
        Ok(value) => Json(value).into_response(),
        Err(_) => reply(Status::SERVICE_UNAVAILABLE, "Pairing unavailable"),
    }
}
/// `GET /api/remote-control/status`: live tunnel state, paired device count and (locally) direct HTTPS origins.
pub async fn status(State(app): State<Shared>, channel: Option<Extension<Channel>>) -> Json<Value> {
    Json(app.remote_control.status(&app, channel.is_none()))
}
pub async fn list(State(app): State<Shared>) -> Response {
    let Some(d) = &app.devices else { return crate::unavailable() };
    let d = d.lock().unwrap();
    let mut devices: Vec<Value> = d.doc.devices.iter().filter(|d| d.live()).map(Device::public).collect();
    devices.extend(d.pending_revocations.values().cloned());
    Json(json!({"devices": devices})).into_response()
}
pub async fn revoke(State(app): State<Shared>, RoutePath(raw_id): RoutePath<String>) -> Response {
    let Ok(id) = Uuid::parse_str(&raw_id) else {
        return reply(Status::BAD_REQUEST, "Invalid device id");
    };
    let Some(d) = &app.devices else { return crate::unavailable() };
    let mut d = d.lock().unwrap();
    let mut doc = d.doc.clone();
    let removed = doc.devices.iter().find(|x| x.id == id).cloned();
    doc.devices.retain(|x| x.id != id);
    d.drop_principal(id);
    if let Some(device) = removed {
        let mut pending = device.public();
        pending["revocationPending"] = json!(true);
        d.pending_revocations.insert(id, pending);
    } else if !d.pending_revocations.contains_key(&id) {
        return reply(Status::NOT_FOUND, "Remote device not found");
    }
    // Refuse the old token immediately even if durable revocation fails.
    d.doc = doc;
    if d.mutate_persisted(|disk| {
        disk.devices.retain(|x| x.id != id);
    })
    .is_err()
    {
        d.revocation_locked = true;
        // Drain all active principals rather than leaving cancelled tokens in the map.
        d.drop_all_principals();
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
    let parsed_json = serde_json::from_slice::<Value>(&bytes);
    let invalid_json = parsed_json.is_err();
    let value = parsed_json.unwrap_or(Value::Null);
    let code = value["code"].as_str().filter(|s| !s.is_empty() && s.encode_utf16().count() <= 256);
    let hostname =
        value["hostName"].as_str().map(str::trim).filter(|s| !s.is_empty() && s.encode_utf16().count() <= 255);
    let valid_server = !invalid_json
        && code.is_some_and(|code| {
            code.len() == 32 && code.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        })
        && hostname.is_some()
        && value.as_object().is_some_and(|o| o.len() == 2);
    let tunnel_active = app.remote_control.is_tunnel_active();
    let d = app.devices.as_ref().unwrap();
    let mut d = d.lock().unwrap();
    let code = code.filter(|_| !invalid_json && (!server || valid_server));
    if let Some(code) = code {
        let name = if server { format!("CodeNomad · {}", hostname.unwrap()) } else { device_name(&agent) };
        match d.exchange(code, name, (!channel.ingress).then_some(&channel.origin), tunnel_active, server) {
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
    } else if invalid_json {
        reply(Status::BAD_REQUEST, "Invalid pairing body")
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
    pairing_page(Html(include_str!("../../../server/src/server/routes/auth-pages/remote-pair.html")).into_response())
}
pub(super) fn pairing_page(mut response: Response) -> Response {
    for (name, value) in [
        (header::CACHE_CONTROL, "no-store"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::X_FRAME_OPTIONS, "DENY"),
    ] {
        response.headers_mut().insert(name, axum::http::HeaderValue::from_static(value));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_and_wrong_channel_codes_never_persist() {
        let doc = Document { version: 1, route: "test".into(), ..Default::default() };
        let mut devices = Devices::new(
            "not-used".into(),
            doc,
            false,
            "https://localhost:1234".into(),
            vec!["https://localhost:1234".into()],
            true,
            false,
        );
        let until = Instant::now() - Duration::from_secs(1);
        devices.pairing = Some(Pairing { hash: hash("fixture"), until, origin: None });
        assert!(devices.exchange("fixture", "Device".into(), None, true, false).unwrap().is_none());
        devices.pairing.as_mut().unwrap().until = Instant::now() + Duration::from_secs(1);
        assert!(
            devices.exchange("fixture", "Device".into(), Some("https://other.invalid"), true, false).unwrap().is_none()
        );
        assert!(devices.doc.devices.is_empty());
        assert!(devices.pairing.is_some());
    }

    #[test]
    fn server_paired_device_persists_server_flag_distinct_from_browser() {
        let dir = std::env::temp_dir().join(format!("cn-devices-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("remote-control.json");
        let doc = Document { version: 1, route: "test".into(), ..Default::default() };
        fs::write(&path, serde_json::to_vec(&doc).unwrap()).unwrap();
        let mut devices = Devices::new(
            path.clone(),
            doc,
            false,
            "https://localhost:1234".into(),
            vec!["https://localhost:1234".into()],
            true,
            false,
        );

        devices.pairing =
            Some(Pairing { hash: hash("browser-code"), until: Instant::now() + Duration::from_secs(60), origin: None });
        let (browser_pub, _) = devices.exchange("browser-code", "Browser".into(), None, true, false).unwrap().unwrap();
        let browser_id = Uuid::parse_str(browser_pub["id"].as_str().unwrap()).unwrap();
        assert!(!devices.is_server_device(browser_id));

        devices.pairing =
            Some(Pairing { hash: hash("server-code"), until: Instant::now() + Duration::from_secs(60), origin: None });
        let (server_pub, _) = devices.exchange("server-code", "Host".into(), None, true, true).unwrap().unwrap();
        let server_id = Uuid::parse_str(server_pub["id"].as_str().unwrap()).unwrap();
        assert!(devices.is_server_device(server_id));

        let reloaded: Document = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let reloaded_devices = Devices::new(
            path,
            reloaded,
            false,
            "https://localhost:1234".into(),
            vec!["https://localhost:1234".into()],
            true,
            false,
        );
        assert!(!reloaded_devices.is_server_device(browser_id));
        assert!(reloaded_devices.is_server_device(server_id));
        let _ = fs::remove_dir_all(&dir);
    }
}
