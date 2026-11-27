//! Credential lookups, public window shapes and bounded outbound transport.
use std::{sync::LazyLock, time::Duration};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, Method, Url, header::HeaderMap, redirect::Policy};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::shared::{js_trim, now_ms};

pub type Fields = Map<String, Value>;
pub type Quota = Result<Usage, Failed>;

#[derive(Clone, Default)]
pub struct Usage {
    pub windows: Fields,
    pub models: Vec<(String, Fields)>,
    pub extra: Fields,
    pub at: Option<u64>,
}
impl From<Fields> for Usage {
    fn from(windows: Fields) -> Self {
        Self { windows, ..Default::default() }
    }
}

#[derive(Clone, Debug)]
pub struct Failed {
    pub configured: bool,
    pub status: Option<u16>,
    pub reason: Option<&'static str>,
    pub code: Option<String>,
    pub malformed: bool,
}
pub const FAILED: Failed = Failed { configured: true, status: None, reason: None, code: None, malformed: false };
pub const MISSING: Failed = Failed { configured: false, ..FAILED };
pub const INVALID: Failed = Failed { malformed: true, ..FAILED };
pub fn reason(reason: &'static str) -> Failed {
    Failed { reason: Some(reason), ..FAILED }
}

pub const HOUR: f64 = 3600.0;
pub const DAY: f64 = 24.0 * HOUR;
pub const WEEK: f64 = 7.0 * DAY;
pub const FIVE_HOURS: f64 = 5.0 * HOUR;

pub fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string()))
}
pub fn text(s: &Value) -> Option<&str> {
    s.as_str().map(js_trim).filter(|s| !s.is_empty())
}
pub fn var(name: &str) -> Result<String, Failed> {
    std::env::var(name).ok().map(|s| js_trim(&s).to_owned()).filter(|s| !s.is_empty()).ok_or(MISSING)
}
pub fn num(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| text(value).map(crate::search::query::number)).filter(|n| n.is_finite())
}
pub fn timestamp(value: &Value) -> Option<f64> {
    if let Some(n) = value.as_f64() {
        return Some(if n < 1e12 { n * 1000.0 } else { n });
    }
    let s = text(value)?;
    use chrono::{DateTime, NaiveDate, NaiveDateTime};
    DateTime::parse_from_rfc3339(s)
        .or_else(|_| DateTime::parse_from_rfc2822(s))
        .map(|d| d.timestamp_millis() as f64)
        .ok()
        .or_else(|| {
            let date = s.split_once('T').map(|(date, _)| date).unwrap_or(s);
            let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
            let datetime = if s.contains('T') {
                NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").ok()?
            } else {
                date.and_hms_opt(0, 0, 0)?
            };
            Some(datetime.and_utc().timestamp_millis() as f64)
        })
}
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}
pub fn window(used: Option<f64>, seconds: Option<f64>, reset: Option<f64>, label: Option<String>) -> Value {
    let used = used.map(|n| n.clamp(0.0, 100.0));
    let mut out = json!({"usedPercent": used, "remainingPercent": used.map(|n| 100.0 - n),
        "windowSeconds": seconds, "resetAt": reset});
    if let Some(label) = label.filter(|s| !s.is_empty()) {
        out["valueLabel"] = json!(label);
    }
    out
}
/// `Number.toFixed` rounds exact ties away from zero; Rust formatting chooses even.
pub fn fixed(value: f64, digits: u32) -> String {
    if !value.is_finite() || value.abs() >= 1e21 {
        return value.to_string();
    }
    let scale = 10_u64.pow(digits);
    let n = value.abs();
    let scaled = n * scale as f64;
    // Split the binary significand before multiplying, to avoid rounding a decimal to a false tie.
    let bits = n.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let (mantissa, shift) = if exponent == 0 { (fraction, -1074) } else { (fraction | 1 << 52, exponent - 1075) };
    let mantissa = u128::from(mantissa) * u128::from(scale);
    let rounded = if shift >= 0 {
        mantissa << shift
    } else {
        let shift = -shift as u32;
        if shift >= 128 { 0 } else { (mantissa >> shift) + ((mantissa >> (shift - 1)) & 1) }
    };
    debug_assert!(scaled.is_finite());
    let scale = u128::from(scale);
    let sign = if value < 0.0 { "-" } else { "" };
    if digits == 0 {
        format!("{sign}{rounded}")
    } else {
        format!("{sign}{}.{:0width$}", rounded / scale, rounded % scale, width = digits as usize)
    }
}
pub fn balance(n: f64) -> Value {
    window(None, None, None, Some(format!("{}${}", if n < 0.0 { "-" } else { "" }, fixed(n.abs(), 2))))
}
pub fn label(seconds: Option<f64>) -> String {
    match seconds {
        None | Some(0.0) => "usage".into(),
        Some(WEEK) => "weekly".into(),
        Some(n) if n % DAY == 0.0 => format!("{}d", n / DAY),
        Some(n) if n % HOUR == 0.0 => format!("{}h", n / HOUR),
        Some(n) => format!("{n}s"),
    }
}

pub fn first_auth<'a>(auth: &'a Value, aliases: &[&str]) -> &'a Value {
    aliases.iter().map(|name| &auth[*name]).find(|entry| entry.is_object()).unwrap_or(&Value::Null)
}
pub fn oauth<'a>(auth: &'a Value, aliases: &[&str]) -> &'a Value {
    aliases
        .iter()
        .map(|name| &auth[*name])
        .find(|v| v["type"] == "oauth" && access(v).is_some())
        .unwrap_or(&Value::Null)
}
pub fn key<'a>(auth: &'a Value, aliases: &[&str], fields: &[&str]) -> Result<&'a str, Failed> {
    aliases.iter().find_map(|id| fields.iter().find_map(|field| text(&auth[*id][*field]))).ok_or(MISSING)
}
pub fn access(entry: &Value) -> Option<&str> {
    text(&entry["access"]).or_else(|| text(&entry["token"]))
}
pub fn jwt(access: &str) -> Value {
    access
        .split('.')
        .nth(1)
        .and_then(|p| URL_SAFE_NO_PAD.decode(p).ok())
        .and_then(|p| serde_json::from_slice(&p).ok())
        .unwrap_or_default()
}
pub fn stale(entry: &Value, token: &str) -> bool {
    let deadline = now_ms() as f64 + 120_000.0;
    let expired = |n: f64| n <= deadline;
    let js_number = |v: &Value| match v {
        Value::Null => Some(0.0),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => Some(crate::search::query::number(s)),
        v => v.as_f64(),
    };
    entry.get("expires").and_then(js_number).is_some_and(expired)
        || jwt(token).get("exp").and_then(js_number).map(|t| t * 1000.0).is_some_and(expired)
}

/// `parseQuotaBaseURL` checks the raw authority before URL normalization can discard a port.
pub fn base_url(raw: &str) -> Option<Url> {
    static FORM: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)^https://([a-z0-9.-]+)(/[^?#]*)?$").unwrap());
    if raw.len() > 2048
        || raw.chars().any(|c| crate::shared::js_space(c) || c.is_ascii_control() || c == '\\')
        || !FORM.is_match(raw)
    {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    let host = url.domain()?;
    (host.len() <= 253
        && host.contains('.')
        && !host.ends_with(".localhost")
        && host.split('.').all(|s| !s.is_empty() && s.len() <= 63 && !s.starts_with('-') && !s.ends_with('-')))
    .then_some(url)
}

pub struct Http {
    plain: Client,
    strict: Client,
    fixture: Option<Url>,
}

pub struct Reply {
    pub status: u16,
    pub headers: HeaderMap,
    pub bytes: Vec<u8>,
}
impl Reply {
    pub fn json(&self) -> Result<Value, Failed> {
        serde_json::from_slice(&self.bytes).map_err(|_| INVALID)
    }
    pub fn checked_json(&self) -> Result<Value, Failed> {
        if !(200..300).contains(&self.status) {
            return Err(Failed { status: Some(self.status), ..FAILED });
        }
        self.json()
    }
}

impl Http {
    pub fn fixture_oauth(&self) -> Option<(&'static str, &'static str)> {
        self.fixture.as_ref().map(|_| ("fixture-client-id", "fixture-client-secret"))
    }
    pub fn open() -> Result<Self, reqwest::Error> {
        Self::open_with_fixture(crate::bench::provider_fixture())
    }
    #[cfg(test)]
    pub fn with_fixture(fixture: Url) -> Result<Self, reqwest::Error> {
        Self::open_with_fixture(Some(fixture))
    }
    fn open_with_fixture(fixture: Option<Url>) -> Result<Self, reqwest::Error> {
        let client = || Client::builder().no_proxy().timeout(Duration::from_secs(15)).user_agent("node");
        let strict = client().redirect(Policy::none()).build()?;
        let plain = client()
            .redirect(if fixture.is_some() {
                Policy::none()
            } else {
                Policy::custom(|attempt| {
                    if attempt.previous().len() < 20
                        && attempt.previous().first().is_some_and(|url| url.origin() == attempt.url().origin())
                    {
                        attempt.follow()
                    } else {
                        attempt.stop()
                    }
                })
            })
            .build()?;
        Ok(Self { plain, strict, fixture })
    }
    pub async fn send(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
        strict: bool,
    ) -> Result<Reply, Failed> {
        let url = Url::parse(url).map_err(|_| FAILED)?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return Err(FAILED);
        }
        let mut target = url.clone();
        if let Some(fixture) = &self.fixture {
            target = fixture.join(&format!("{}{}", url.host_str().ok_or(FAILED)?, url.path())).map_err(|_| FAILED)?;
            target.set_query(url.query());
        }
        let client = if strict { &self.strict } else { &self.plain };
        let method = if body.is_some() { Method::POST } else { Method::GET };
        let mut request = client.request(method, target);
        if !headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("accept")) {
            request = request.header("Accept", "*/*");
        }
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        let mut response = request.send().await.map_err(|_| FAILED)?;
        let status = response.status().as_u16();
        if strict && (300..400).contains(&status) && response.headers().contains_key("location") {
            return Err(FAILED);
        }
        let cap = if strict { 65_536 } else { 8 * 1024 * 1024 };
        let headers = response.headers().clone();
        let mut bytes = Vec::new();
        let body_deadline =
            tokio::time::Instant::now() + if status >= 400 { Duration::from_secs(2) } else { Duration::from_secs(15) };
        loop {
            match tokio::time::timeout_at(body_deadline, response.chunk()).await {
                Ok(Ok(Some(chunk))) => {
                    if bytes.len() + chunk.len() > cap {
                        return Err(Failed { status: (status >= 400).then_some(status), ..INVALID });
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(Ok(None)) => break,
                Ok(Err(_)) | Err(_) => {
                    return Err(Failed { status: (status >= 400).then_some(status), ..FAILED });
                }
            }
        }
        Ok(Reply { status, headers, bytes })
    }
    pub async fn get(&self, url: &str, headers: &[(&str, &str)], strict: bool) -> Result<Value, Failed> {
        self.send(url, headers, None, strict).await?.checked_json()
    }
    pub async fn post(&self, url: &str, headers: &[(&str, &str)], body: &Value) -> Result<Value, Failed> {
        self.send(url, headers, Some(body.to_string().into_bytes()), true).await?.checked_json()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_credential_destination_and_decimal_rounding() {
        assert!(base_url("https://some.example.test/api/v1").is_some());
        for unsafe_url in [
            "http://some.example.test",
            "https://some.example.test:443",
            "https://user@some.example.test",
            "https://127.1",
            "https://a.localhost",
            "https://some.example.test/?query",
            "https://some.example.test\\path",
        ] {
            assert!(base_url(unsafe_url).is_none());
        }
        assert_eq!([fixed(-0.125, 2), fixed(3.005, 2), fixed(1234.5 * 0.05, 2)], ["-0.13", "3.00", "61.73"]);
    }
}
