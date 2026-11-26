use crate::{
    backend::{Backend, read_json_limited},
    history::Result,
    settings::{Owner, PatchOutcome, info::listener_origin},
};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const MAX_ERROR_BYTES: usize = 4096;
const MAX_ERROR_CHARS: usize = 320;
const MAX_ADDRESSES: usize = 128;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelState {
    #[default]
    Stopped,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

impl TunnelState {
    pub fn i18n_key(self) -> &'static str {
        match self {
            Self::Stopped => "remoteControl.state.stopped",
            Self::Connecting => "remoteControl.state.connecting",
            Self::Connected => "remoteControl.state.connected",
            Self::Reconnecting => "remoteControl.state.reconnecting",
            Self::Error => "remoteControl.state.error",
        }
    }

    pub fn is_connecting(self) -> bool {
        matches!(self, Self::Connecting | Self::Reconnecting)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub manageable: bool,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub starts_on_launch: bool,
    #[serde(default)]
    pub previews: bool,
    #[serde(default)]
    pub state: TunnelState,
    #[serde(default)]
    pub paired_devices: usize,
    #[serde(default)]
    pub disabled_by_administrator: bool,
    #[serde(default)]
    pub remote_url: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub direct_origins: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub origin: Option<String>,
    pub last_seen_at: String,
    #[serde(default)]
    pub revocation_pending: bool,
}

#[derive(Clone, Debug)]
pub struct Pairing {
    pub url: String,
    pub expires_at_rfc3339: String,
    expires_at: OffsetDateTime,
}

impl Pairing {
    pub fn remaining(&self) -> std::time::Duration {
        let Ok(now) = web_time::SystemTime::now().duration_since(web_time::UNIX_EPOCH) else {
            return std::time::Duration::ZERO;
        };
        let nanos = self.expires_at.unix_timestamp_nanos() - now.as_nanos() as i128;
        // A stale or invalid receipt never makes an unbounded clipboard/timer request.
        match u64::try_from(nanos) {
            Ok(nanos) if nanos <= 300_000_000_000 => std::time::Duration::from_nanos(nanos),
            _ => std::time::Duration::ZERO,
        }
    }
}

pub struct StartResponse {
    pub status: Status,
    pub pairing: Pairing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub username: Option<String>,
    pub password_user_provided: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ListeningMode {
    #[default]
    Local,
    All,
}

impl ListeningMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::All => "all",
        }
    }

    pub fn from_str(value: &str) -> Self {
        if value == "all" {
            Self::All
        } else {
            Self::Local
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkAddress {
    pub ip: String,
    pub family: String,
    pub scope: String,
    pub remote_url: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DirectAccessMeta {
    pub listening_mode: ListeningMode,
    pub listening_locked: bool,
    pub local_request: bool,
    pub host: Option<String>,
    pub local_url: Option<String>,
    pub addresses: Vec<NetworkAddress>,
}

pub fn split_remote_addresses(
    addresses: &[NetworkAddress],
) -> (Option<&NetworkAddress>, Vec<&NetworkAddress>) {
    let mut remote = addresses.iter().filter(|a| a.scope != "loopback");
    let recommended = remote.next();
    let hidden = remote.collect();
    (recommended, hidden)
}

pub fn parse_direct_access_meta(value: &Value) -> DirectAccessMeta {
    let listening_mode = value["listeningMode"]
        .as_str()
        .map(ListeningMode::from_str)
        .unwrap_or(ListeningMode::Local);
    let listening_locked = value["listeningLocked"].as_bool().unwrap_or(false);
    let local_request = value["localRequest"].as_bool().unwrap_or(true);
    let host = clean_text(value["host"].as_str(), 256);
    let local_url = value["localUrl"].as_str().and_then(listener_origin);
    let addresses = value["addresses"]
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_ADDRESSES)
        .filter_map(|item| {
            let ip = clean_text(item["ip"].as_str(), 128)?;
            let family = clean_text(item["family"].as_str(), 16)?;
            let scope = match item["scope"].as_str() {
                Some("external") => "external",
                Some("loopback") => "loopback",
                _ => "internal",
            }
            .to_owned();
            let remote_url = listener_origin(item["remoteUrl"].as_str()?)?;
            Some(NetworkAddress {
                ip,
                family,
                scope,
                remote_url,
            })
        })
        .collect();
    DirectAccessMeta {
        listening_mode,
        listening_locked,
        local_request,
        host,
        local_url,
        addresses,
    }
}

pub async fn direct_access_meta(backend: &Backend) -> Result<DirectAccessMeta> {
    let value = crate::settings::info::metadata(backend).await?;
    Ok(parse_direct_access_meta(&value))
}

pub async fn direct_access_snapshot(
    backend: &Backend,
) -> (
    std::result::Result<DirectAccessMeta, String>,
    std::result::Result<AuthStatus, String>,
) {
    let (meta, auth) =
        futures_lite::future::zip(direct_access_meta(backend), auth_status(backend)).await;
    (
        meta.map_err(|e| e.to_string()),
        auth.map_err(|e| e.to_string()),
    )
}

pub async fn status(backend: &Backend) -> Result<Status> {
    let request = backend
        .client
        .get(format!("{}api/remote-control/status", backend.base));
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = check_response(request.send().await?).await?;
    parse_status(read_json_limited(response, 8192).await?)
}

pub async fn start(backend: &Backend) -> Result<StartResponse> {
    // First use provisions the OpenTunnel identity and certificate (REMOTE_CONTROL.md).
    let request = backend
        .client
        .post(format!("{}api/remote-control/start", backend.base))
        .timeout(std::time::Duration::from_secs(300));
    let response = check_response(request.send().await?).await?;
    let mut value = read_json_limited(response, 16384).await?;
    let status = parse_status(value["status"].take())?;
    let expected = status
        .remote_url
        .as_deref()
        .and_then(origin)
        .ok_or("Missing Remote Control tunnel origin")?;
    let pairing = pairing_result(&value["pairing"], &expected)?;
    Ok(StartResponse { status, pairing })
}

pub async fn stop(backend: &Backend) -> Result<Status> {
    let response = check_response(
        backend
            .client
            .delete(format!("{}api/remote-control", backend.base))
            .send()
            .await?,
    )
    .await?;
    parse_status(read_json_limited(response, 8192).await?)
}

pub async fn set_previews(backend: &Backend, enabled: bool) -> Result<Status> {
    let response = check_response(
        backend
            .client
            .put(format!("{}api/remote-control/previews", backend.base))
            .json(&json!({"enabled": enabled}))
            .send()
            .await?,
    )
    .await?;
    parse_status(read_json_limited(response, 8192).await?)
}

pub async fn devices(backend: &Backend) -> Result<Option<Vec<Device>>> {
    let request = backend
        .client
        .get(format!("{}api/remote-control/devices", backend.base));
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?;
    // Loopback-only servers may have no paired-device registry.
    if response.status() == reqwest::StatusCode::NOT_IMPLEMENTED {
        return Ok(None);
    }
    let response = check_response(response).await?;
    let mut value = read_json_limited(response, 32768).await?;
    let devices: Vec<Device> = serde_json::from_value(value["devices"].take())?;
    if devices.len() > 32
        || devices.iter().any(|device| {
            !device_id(&device.id)
                || device.name.trim().is_empty()
                || device.name.encode_utf16().count() > 80
                || device.name.chars().any(|c| c.is_ascii_control())
                || device
                    .origin
                    .as_ref()
                    .is_some_and(|value| value.len() > 512 || origin(value).is_none())
                || OffsetDateTime::parse(&device.last_seen_at, &Rfc3339).is_err()
        })
    {
        return Err("Invalid paired device list".into());
    }
    Ok(Some(devices))
}

pub async fn pairing(
    backend: &Backend,
    direct_origin: Option<&str>,
    expected_origin: &str,
) -> Result<Pairing> {
    let expected = origin(expected_origin).ok_or("Invalid HTTPS pairing origin")?;
    let mut request = backend
        .client
        .post(format!("{}api/remote-control/pairings", backend.base));
    if let Some(direct) = direct_origin {
        if origin(direct).is_none() {
            return Err("Invalid HTTPS pairing origin".into());
        }
        request = request.json(&json!({"origin": direct}));
    }
    let response = check_response(request.send().await?).await?;
    pairing_result(&read_json_limited(response, 4096).await?, &expected)
}

pub async fn revoke(backend: &Backend, id: &str) -> Result<()> {
    if !device_id(id) {
        return Err("Invalid paired device identity".into());
    }
    let response = check_response(
        backend
            .client
            .delete(format!("{}api/remote-control/devices/{id}", backend.base))
            .send()
            .await?,
    )
    .await?;
    if response.status() != reqwest::StatusCode::NO_CONTENT {
        return Err("Unconfirmed device revocation".into());
    }
    Ok(())
}

pub async fn auth_status(backend: &Backend) -> Result<AuthStatus> {
    let request = backend
        .client
        .get(format!("{}api/auth/status", backend.base));
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = check_response(request.send().await?).await?;
    let value = read_json_limited(response, 4096).await?;
    let authenticated = value["authenticated"].as_bool().unwrap_or(false);
    Ok(AuthStatus {
        authenticated,
        username: authenticated
            .then(|| clean_text(value["username"].as_str(), 128))
            .flatten(),
        password_user_provided: authenticated
            && value["passwordUserProvided"].as_bool().unwrap_or(false),
    })
}

pub async fn set_password(backend: &Backend, password: &str) -> Result<AuthStatus> {
    let response = check_response(
        backend
            .client
            .post(format!("{}api/auth/password", backend.base))
            .json(&json!({"password": password}))
            .send()
            .await?,
    )
    .await?;
    let value = read_json_limited(response, 4096).await?;
    if value["ok"].as_bool() != Some(true) {
        return Err("Password update was not confirmed".into());
    }
    // Saving a server password revokes the active session cookie; confirm current auth status
    // rather than assuming the caller remains authenticated.
    Ok(auth_status(backend).await.unwrap_or(AuthStatus {
        authenticated: false,
        username: clean_text(value["username"].as_str(), 128),
        password_user_provided: value["passwordUserProvided"].as_bool().unwrap_or(true),
    }))
}

/// Persists `server.listeningMode` through the Server config owner.
/// On an uncertain write, re-reads the authoritative server config instead of replaying.
pub async fn set_listening_mode(backend: &Backend, mode: ListeningMode) -> Result<()> {
    let target = mode.as_str();
    match Owner::Server
        .patch(backend, &json!({"listeningMode": target}), false)
        .await
    {
        PatchOutcome::Applied(doc) => {
            if doc["listeningMode"].as_str().unwrap_or("local") == target {
                Ok(())
            } else {
                Err("Listening mode change was not applied".into())
            }
        }
        PatchOutcome::Rejected => Err("Listening mode change was rejected".into()),
        PatchOutcome::Uncertain => {
            let doc = Owner::Server.read(backend).await?;
            if doc["listeningMode"].as_str().unwrap_or("local") == target {
                Ok(())
            } else {
                Err("Listening mode change was not confirmed".into())
            }
        }
    }
}

fn parse_status(value: Value) -> Result<Status> {
    let mut status: Status = serde_json::from_value(value)?;
    status
        .direct_origins
        .retain(|value| origin(value).is_some());
    status.remote_url = status.remote_url.filter(|value| origin(value).is_some());
    status.error = clean_text(status.error.as_deref(), MAX_ERROR_CHARS);
    if !status.manageable || status.disabled_by_administrator {
        status.direct_origins.clear();
    }
    Ok(status)
}

async fn check_response(response: reqwest::Response) -> Result<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let message = read_error_message(response).await;
    Err(message
        .unwrap_or_else(|| format!("HTTP {}", status.as_u16()))
        .into())
}

async fn read_error_message(response: reqwest::Response) -> Option<String> {
    use futures_lite::StreamExt;
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            break;
        };
        let take = chunk.len().min(MAX_ERROR_BYTES.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&chunk[..take]);
        if bytes.len() >= MAX_ERROR_BYTES {
            break;
        }
    }
    let text = std::str::from_utf8(&bytes).ok()?;
    if let Ok(value) = serde_json::from_str::<Value>(text)
        && let Some(msg) = value["error"]
            .as_str()
            .or_else(|| value["message"].as_str())
    {
        return clean_text(Some(msg), MAX_ERROR_CHARS);
    }
    clean_text(Some(text), MAX_ERROR_CHARS)
}

fn clean_text(value: Option<&str>, max_chars: usize) -> Option<String> {
    let cleaned: String = value?
        .trim()
        .chars()
        .filter(|c| !c.is_control() || *c == ' ')
        .take(max_chars)
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn origin(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.origin().ascii_serialization() == value)
        .then_some(url)
}

fn pairing_result(value: &Value, origin: &Url) -> Result<Pairing> {
    let raw = value["url"]
        .as_str()
        .filter(|s| s.len() <= 2048)
        .ok_or("Invalid pairing link")?;
    let url = Url::parse(raw)?;
    if url.origin() != origin.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/remote-pair"
        || url.query().is_some()
        || !url.fragment().is_some_and(|code| {
            (20..=128).contains(&code.len())
                && code
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        })
    {
        return Err("Invalid pairing link".into());
    }
    let expires_at_rfc3339 = value["expiresAt"]
        .as_str()
        .ok_or("Missing pairing expiry")?
        .to_owned();
    Ok(Pairing {
        url: raw.to_owned(),
        expires_at: OffsetDateTime::parse(&expires_at_rfc3339, &Rfc3339)?,
        expires_at_rfc3339,
    })
}

fn device_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(n, b)| {
            if matches!(n, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_links_are_bound_to_the_advertised_origin_and_exact_path() {
        let origin = origin("https://example.test:444").unwrap();
        for (base, expected) in [
            ("https://example.test:444/remote-pair", true),
            ("https://other.test:444/remote-pair", false),
            ("https://example.test:444/login", false),
            ("https://user@example.test:444/remote-pair", false),
            ("https://example.test:444/remote-pair?next=/", false),
        ] {
            let reply = json!({"url":format!("{base}#abcdefghijklmnopqrstuv"),"expiresAt":"2026-11-23T14:00:00Z"});
            assert_eq!(pairing_result(&reply, &origin).is_ok(), expected);
        }
        assert!(!device_id(
            "../devices/00000000-0000-0000-0000-000000000000"
        ));
    }

    #[test]
    fn status_and_direct_meta_sanitize_fields_and_split_addresses() {
        let parsed = parse_status(json!({
            "manageable": true,
            "enabled": true,
            "startsOnLaunch": true,
            "previews": true,
            "state": "connected",
            "pairedDevices": 2,
            "remoteUrl": "https://codenomad-abc.opentunnel.xyz",
            "directOrigins": ["https://lan.test:9898", "http://insecure.test"],
            "error": "line1\nline2",
        }))
        .unwrap();
        assert_eq!(parsed.state, TunnelState::Connected);
        assert_eq!(
            parsed.remote_url.as_deref(),
            Some("https://codenomad-abc.opentunnel.xyz")
        );
        assert_eq!(parsed.direct_origins, ["https://lan.test:9898"]);
        assert_eq!(parsed.error.as_deref(), Some("line1line2"));

        let disabled = parse_status(json!({
            "manageable": true,
            "disabledByAdministrator": true,
            "directOrigins": ["https://lan.test:9898"],
        }))
        .unwrap();
        assert!(disabled.direct_origins.is_empty());

        let meta = parse_direct_access_meta(&json!({
            "listeningMode": "all",
            "listeningLocked": true,
            "localRequest": true,
            "host": "0.0.0.0",
            "localUrl": "http://127.0.0.1:9898/path?x=1",
            "addresses": [
                {"ip": "127.0.0.1", "family": "ipv4", "scope": "loopback", "remoteUrl": "https://127.0.0.1:9899"},
                {"ip": "192.168.1.10", "family": "ipv4", "scope": "external", "remoteUrl": "https://192.168.1.10:9899"},
                {"ip": "10.0.0.5", "family": "ipv4", "scope": "internal", "remoteUrl": "https://10.0.0.5:9899"},
                {"ip": "bad", "family": "ipv4", "scope": "external", "remoteUrl": "javascript:alert(1)"}
            ]
        }));
        assert_eq!(meta.listening_mode, ListeningMode::All);
        assert!(meta.listening_locked);
        assert_eq!(meta.local_url.as_deref(), Some("http://127.0.0.1:9898"));
        let (rec, hidden) = split_remote_addresses(&meta.addresses);
        assert_eq!(rec.unwrap().ip, "192.168.1.10");
        assert_eq!(hidden.len(), 1);
        assert_eq!(hidden[0].ip, "10.0.0.5");
    }
}
