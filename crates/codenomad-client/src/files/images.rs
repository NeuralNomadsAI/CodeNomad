//! Markdown pictures use a separate, credential-free client.
use super::MAX_FILE_BYTES;
use crate::history::Result;
#[cfg(not(target_arch = "wasm32"))]
use futures_lite::StreamExt;
#[cfg(not(target_arch = "wasm32"))]
use reqwest::Client;
use reqwest::Url;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Duration;

mod admission;
#[cfg(target_arch = "wasm32")]
mod browser;
pub use admission::can_decode;
pub struct Images {
    #[cfg(not(target_arch = "wasm32"))]
    client: Client,
}
impl Images {
    pub fn new() -> Result<Self> {
        Ok(Self {
            #[cfg(not(target_arch = "wasm32"))]
            client: native_client().build()?,
        })
    }

    pub async fn read(&self, base: &str, source: &str, maximum: usize) -> Result<Vec<u8>> {
        let maximum = maximum.min(MAX_FILE_BYTES);
        let url = source_url(base, source).ok_or("unsupported Markdown image source")?;
        #[cfg(target_arch = "wasm32")]
        let bytes = browser::read(url, maximum).await?;
        #[cfg(not(target_arch = "wasm32"))]
        let bytes = self.read_native(url, maximum).await?;
        if !can_decode(&bytes) {
            return Err("unavailable Markdown image".into());
        }
        Ok(bytes)
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn read_native(&self, url: Url, maximum: usize) -> Result<Vec<u8>> {
        let response = self
            .client
            .get(url)
            .timeout(Duration::from_secs(15))
            .send()
            .await?
            .error_for_status()?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|size| size > maximum as u64)
        {
            return Err("unavailable Markdown image".into());
        }
        let mut bytes = Vec::new();
        let mut chunks = response.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            if chunk.len() > maximum.saturating_sub(bytes.len()) {
                return Err("oversized Markdown image".into());
            }
            bytes.extend_from_slice(&chunk);
            reject_svgz(&bytes)?;
        }
        Ok(bytes)
    }
}

fn reject_svgz(bytes: &[u8]) -> Result<()> {
    // Rune treats any gzip signature as SVGZ and decodes before applying its SVG cap.
    if bytes.starts_with(&[0x1f, 0x8b]) {
        Err("compressed Markdown images are unsupported".into())
    } else {
        Ok(())
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn native_client() -> reqwest::ClientBuilder {
    Client::builder()
        .no_proxy()
        .referer(false)
        .redirect(reqwest::redirect::Policy::custom(|hop| {
            if hop.previous().len() < 5 && network(hop.url()) {
                hop.follow()
            } else {
                hop.stop()
            }
        }))
}

fn network(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http")
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none()
}

fn source_url(base: &str, source: &str) -> Option<Url> {
    let source = source.trim();
    if source.len() > 8192 || source.contains('\\') {
        return None;
    }
    // An ordinary relative path is a local image label in Solid, not an HTTP request.
    let url = if source.starts_with("//") {
        Url::parse(base).ok()?.join(source).ok()?
    } else {
        Url::parse(source).ok()?
    };
    network(&url).then_some(url)
}

pub fn supported(base: &str, source: &str) -> bool {
    source_url(base, source).is_some()
}

#[cfg(test)]
#[test]
fn markdown_image_destinations_do_not_become_file_or_authorized_requests() {
    let base = "https://host.invalid/app/";
    assert_eq!(
        source_url(base, "//images.invalid/sample.png")
            .map(|url| url.to_string())
            .as_deref(),
        Some("https://images.invalid/sample.png")
    );
    for source in [
        "./private.png",
        "/api/private.png",
        "file:///C:/secret.png",
        r"\\host\private.png",
        "data:text/html,<script>",
        "https://name:token@host.invalid/image.png",
        "javascript:alert(1)",
    ] {
        assert!(source_url(base, source).is_none(), "{source}");
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
#[ignore = "requires an isolated HTTPS image fixture and its test CA"]
fn native_tls_reads_a_trusted_image_and_refuses_an_unknown_certificate() {
    let origin = std::env::var("RUNE_IMAGE_TLS_FIXTURE").unwrap();
    let parsed = Url::parse(&origin).unwrap();
    assert_eq!(parsed.scheme(), "https");
    assert_eq!(parsed.host_str(), Some("127.0.0.1"));
    assert!(parsed.port().is_some());
    let picture = parsed.join("image.png").unwrap();
    let ca = std::fs::read(std::env::var_os("RUNE_IMAGE_TLS_CA").unwrap()).unwrap();
    let ca = reqwest::Certificate::from_pem(&ca).unwrap();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let unknown = Images::new()
                .unwrap()
                .read(&origin, picture.as_str(), 4096)
                .await;
            assert!(
                unknown.is_err(),
                "unknown certificates must not be accepted"
            );
            let images = Images {
                client: native_client().add_root_certificate(ca).build().unwrap(),
            };
            let bytes = images.read(&origin, picture.as_str(), 4096).await.unwrap();
            assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
            let compressed = parsed.join("compressed.png").unwrap();
            let error = images
                .read(&origin, compressed.as_str(), 4096)
                .await
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                "compressed Markdown images are unsupported"
            );
        });
}
