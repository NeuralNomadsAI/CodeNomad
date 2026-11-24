use crate::{
    backend::{Backend, read_json_limited},
    history::Result,
};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub manageable: bool,
    #[serde(default)]
    pub disabled_by_administrator: bool,
    #[serde(default)]
    pub direct_origins: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub origin: Option<String>,
    pub last_seen_at: String,
}

pub struct Pairing {
    pub url: String,
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

pub async fn status(backend: &Backend) -> Result<Status> {
    let response = backend
        .client
        .get(format!("{}api/remote-control/status", backend.base))
        .send()
        .await?
        .error_for_status()?;
    let mut status: Status = serde_json::from_value(read_json_limited(response, 8192).await?)?;
    status
        .direct_origins
        .retain(|value| origin(value).is_some());
    if !status.manageable || status.disabled_by_administrator {
        status.direct_origins.clear();
    }
    Ok(status)
}

pub async fn devices(backend: &Backend) -> Result<Option<Vec<Device>>> {
    let response = backend
        .client
        .get(format!("{}api/remote-control/devices", backend.base))
        .send()
        .await?;
    // Loopback-only servers may have no paired-device registry.
    if response.status() == reqwest::StatusCode::NOT_IMPLEMENTED {
        return Ok(None);
    }
    let mut value = read_json_limited(response.error_for_status()?, 32768).await?;
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

pub async fn pairing(backend: &Backend, direct_origin: &str) -> Result<Pairing> {
    let origin = origin(direct_origin).ok_or("Invalid HTTPS pairing origin")?;
    let response = backend
        .client
        .post(format!("{}api/remote-control/pairings", backend.base))
        .json(&json!({"origin":direct_origin}))
        .send()
        .await?
        .error_for_status()?;
    pairing_result(&read_json_limited(response, 4096).await?, &origin)
}

pub async fn revoke(backend: &Backend, id: &str) -> Result<()> {
    if !device_id(id) {
        return Err("Invalid paired device identity".into());
    }
    let response = backend
        .client
        .delete(format!("{}api/remote-control/devices/{id}", backend.base))
        .send()
        .await?
        .error_for_status()?;
    if response.status() != reqwest::StatusCode::NO_CONTENT {
        return Err("Unconfirmed device revocation".into());
    }
    Ok(())
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
    Ok(Pairing {
        url: raw.to_owned(),
        expires_at: OffsetDateTime::parse(
            value["expiresAt"]
                .as_str()
                .ok_or("Missing pairing expiry")?,
            &Rfc3339,
        )?,
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
