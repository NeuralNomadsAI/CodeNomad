//! Interchangeable native HTTP and browser fetch adapters; cookies stay in their owner.
use crate::history::Result;
use reqwest::{Client, RequestBuilder};
use std::{
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Http(
    Client,
    Arc<OnceLock<Identity>>,
    Arc<crate::stream::Children>,
    Arc<AtomicBool>,
);
struct Identity {
    server: String,
    capabilities: Vec<String>,
}
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
        Ok(Self(
            client,
            Arc::new(OnceLock::new()),
            Arc::default(),
            Arc::new(AtomicBool::new(true)),
        ))
    }
    /// Pre-seed a loopback session cookie issued over the owned child host's stdio channel.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn with_session_cookie(address: &str, name: &str, value: &str) -> Result<Self> {
        let valid_token = |token: &str| {
            !token.is_empty()
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        };
        if !valid_token(name) || !valid_token(value) {
            return Err("invalid session cookie".into());
        }
        let base = endpoint(address)?;
        let url = reqwest::Url::parse(&base)?;
        let jar = Arc::new(reqwest::cookie::Jar::default());
        jar.add_cookie_str(&format!("{name}={value}; Path=/"), &url);
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .cookie_provider(jar)
            .timeout(REQUEST_TIMEOUT)
            .build()?;
        Ok(Self(
            client,
            Arc::new(OnceLock::new()),
            Arc::default(),
            Arc::new(AtomicBool::new(true)),
        ))
    }
    pub fn same_connection(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.1, &other.1)
    }
    pub(crate) fn children(&self) -> &crate::stream::Children {
        &self.2
    }
    pub fn server_identity(&self) -> Option<&str> {
        self.1.get().map(|identity| identity.server.as_str())
    }
    pub fn supports(&self, capability: &str) -> bool {
        self.1
            .get()
            .is_some_and(|identity| identity.capabilities.iter().any(|item| item == capability))
    }
    pub(crate) fn attest(&self, id: &str, capabilities: Vec<String>) -> bool {
        self.1
            .get_or_init(|| Identity {
                server: id.to_owned(),
                capabilities,
            })
            .server
            == id
    }
    pub fn supports_service_usage(&self) -> bool {
        self.3.load(Ordering::Relaxed)
    }
    pub(crate) fn observe_service_usage(&self, advertised: bool) {
        self.3.store(advertised, Ordering::Relaxed);
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

/// Cryptographic lowercase RFC 4122 v4 UUID for native control correlation.
#[cfg(not(target_arch = "wasm32"))]
pub fn random_uuid_v4() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "random source unavailable")?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    ))
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
    let trimmed = raw.trim();
    if trimmed.chars().any(|c| c.is_control() || c == '\\') {
        return None;
    }
    let (scheme, rest) = trimmed.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    if rest.split(['/', '?', '#']).next()?.contains('@') {
        return None;
    }
    let url = reqwest::Url::parse(trimmed).ok()?;
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
    assert!(is_loopback_http_url(" http://127.0.0.1:8123/view "));
    for raw in [
        "https://127.0.0.1.example.org/",
        "//localhost:8080/",
        "http:localhost:8123/",
        "mailto:local@example.org",
        "http://alice:demo@localhost:8123/",
        "http://alice@127.0.0.1:8123/",
        "https://:demo@[::1]:8123/",
        "http://@localhost:8123/",
        "http://:@localhost:8123/",
        "http://127.0.0.1:8123/ok\ncmd",
        "http://127.0.0.1:8123/ok\tcmd",
        "http://127.0.0.1:8123\\@evil.example/",
    ] {
        assert!(!is_loopback_http_url(raw), "{raw:?}");
    }
    for rejected in [
        "http:localhost:8123/",
        "http://alice:demo@localhost:8123/",
        "http://@localhost:8123/",
        "http://127.0.0.1:8123/ok\ncmd",
        "http://127.0.0.1:8123\\@evil.example/",
    ] {
        assert!(external_http_url(rejected).is_none(), "{rejected:?}");
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn session_cookie_helper_validates_tokens_and_formats_uuid_v4() {
    let id = random_uuid_v4().unwrap();
    assert_eq!(id.len(), 36);
    assert_eq!(&id[14..15], "4");
    assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    assert!(
        id.bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
    );
    assert!(Http::with_session_cookie("http://127.0.0.1:9/", "", "abc").is_err());
    assert!(Http::with_session_cookie("http://127.0.0.1:9/", "name;bad", "abc").is_err());
    assert!(Http::with_session_cookie("http://127.0.0.1:9/", "codenomad_session", "a;b").is_err());
    assert!(Http::with_session_cookie("http://127.0.0.1:9/", "codenomad_session", "a\nb").is_err());
    assert!(Http::with_session_cookie("http://example.com/", "codenomad_session", "abc").is_err());

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let n = stream.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            req
        });
        let http = Http::with_session_cookie(
            &format!("http://127.0.0.1:{port}"),
            "codenomad_session_42",
            "renewed_cookie_value_1234567890123456789012",
        )
        .unwrap();
        let res = http
            .get(format!("http://127.0.0.1:{port}/api/meta"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let raw = server.join().unwrap();
        assert!(
            raw.to_ascii_lowercase().contains(
                "cookie: codenomad_session_42=renewed_cookie_value_1234567890123456789012"
            ),
            "missing session cookie in request: {raw}"
        );
    });
}
