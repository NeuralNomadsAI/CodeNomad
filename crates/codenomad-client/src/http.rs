//! Interchangeable native HTTP and browser fetch adapters; cookies stay in their owner.
use crate::history::Result;
use reqwest::{Client, RequestBuilder};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Http(Client, Arc<OnceLock<String>>, Arc<crate::stream::Children>);
impl Http {
    pub fn new() -> Result<Self> {
        #[cfg(not(target_arch = "wasm32"))]
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .cookie_store(true)
            .timeout(REQUEST_TIMEOUT)
            .build()?;
        #[cfg(target_arch = "wasm32")]
        let client = Client::new();
        Ok(Self(client, Arc::new(OnceLock::new()), Arc::default()))
    }
    pub fn same_connection(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.1, &other.1)
    }
    pub(crate) fn children(&self) -> &crate::stream::Children {
        &self.2
    }
    pub fn server_identity(&self) -> Option<&str> {
        self.1.get().map(String::as_str)
    }
    pub(crate) fn verify_server_identity(&self, id: &str) -> bool {
        self.1.get_or_init(|| id.to_owned()) == id
    }
    fn request(&self, method: reqwest::Method, url: impl reqwest::IntoUrl) -> RequestBuilder {
        let request = self.0.request(method, url).timeout(REQUEST_TIMEOUT);
        #[cfg(target_arch = "wasm32")]
        let request = request.fetch_credentials_same_origin();
        request
    }
    pub fn get(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.request(reqwest::Method::GET, url)
    }
    pub fn post(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.request(reqwest::Method::POST, url)
    }
    pub fn put(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.request(reqwest::Method::PUT, url)
    }
    pub fn patch(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.request(reqwest::Method::PATCH, url)
    }
    pub fn delete(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.request(reqwest::Method::DELETE, url)
    }
}

#[cfg(target_arch = "wasm32")]
pub async fn pairing_required() -> Result<Option<bool>> {
    let base = endpoint("/")?;
    let response = Http::new()?
        .get(format!("{base}api/auth/status"))
        .fetch_cache_no_store()
        .timeout(Duration::from_secs(8))
        .send()
        .await?
        .error_for_status()?;
    let status = crate::backend::read_json_limited(response, 4096).await?;
    Ok(match status["authenticated"].as_bool() {
        Some(true) => Some(false),
        Some(false) if status["pairingRequired"].as_bool() == Some(true) => Some(true),
        _ => None,
    })
}

pub fn authentication_expired(error: &crate::history::Error) -> bool {
    cfg!(not(target_arch = "wasm32"))
        && error
            .downcast_ref::<reqwest::Error>()
            .and_then(reqwest::Error::status)
            == Some(reqwest::StatusCode::UNAUTHORIZED)
}

pub fn endpoint(address: &str) -> Result<String> {
    #[cfg(target_arch = "wasm32")]
    let origin = web_sys::window()
        .ok_or("browser window required")?
        .location()
        .origin()
        .map_err(|_| "browser origin unavailable")?;
    #[cfg(target_arch = "wasm32")]
    let url = reqwest::Url::parse(&origin)?.join(address.trim())?;
    #[cfg(not(target_arch = "wasm32"))]
    let url = reqwest::Url::parse(address.trim())?;
    if url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("server root endpoint required".into());
    }
    #[cfg(not(target_arch = "wasm32"))]
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err("explicit loopback endpoint required".into());
    }
    #[cfg(target_arch = "wasm32")]
    if url.origin().ascii_serialization() != origin
        || !(url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
    {
        return Err("same-origin HTTPS endpoint required".into());
    }
    Ok(url.to_string())
}

pub fn client_id() -> Result<String> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        Ok(format!(
            "rune-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }
    #[cfg(target_arch = "wasm32")]
    {
        let mut bytes = [0u8; 16];
        web_sys::window()
            .ok_or("browser window required")?
            .crypto()
            .map_err(|_| "browser crypto unavailable")?
            .get_random_values_with_u8_array(&mut bytes)
            .map_err(|_| "browser entropy unavailable")?;
        Ok(format!(
            "rune-{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ))
    }
}
/// Parse an external link without accepting credentials or active schemes.
pub fn external_http_url(raw: &str) -> Option<(String, String)> {
    let url = credential_free_http_url(raw)?;
    let mut host = url.host_str()?.to_owned();
    if let Some(port) = url.port() {
        host.push_str(&format!(":{port}"));
    }
    Some((url.into(), host))
}

fn credential_free_http_url(raw: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url)
}

/// Match Solid's explicit HTTP(S) conversation links, using the parsed host.
pub fn is_loopback_http_url(raw: &str) -> bool {
    let Some((scheme, _)) = raw.split_once("://") else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    credential_free_http_url(raw).is_some_and(|url| {
        url.host_str().is_some_and(|host| {
            matches!(host, "localhost" | "0.0.0.0" | "[::1]")
                || host
                    .parse::<std::net::Ipv4Addr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
    })
}

#[cfg(test)]
#[test]
fn loopback_requires_an_explicit_http_scheme_and_literal_host() {
    for host in ["localhost", "127.0.0.1", "[::1]", "127.1", "0.0.0.0"] {
        assert!(is_loopback_http_url(&format!(
            "http://{host}:9200/a%2Fb?mode=1#target"
        )));
    }
    for raw in [
        "https://127.0.0.1.example.org/",
        "//localhost:8080/",
        "mailto:local@example.org",
        "http://alice:demo@localhost:8123/",
        "http://alice@127.0.0.1:8123/",
        "https://:demo@[::1]:8123/",
    ] {
        assert!(!is_loopback_http_url(raw));
    }
    assert!(external_http_url("http://alice:demo@localhost:8123/").is_none());
}
