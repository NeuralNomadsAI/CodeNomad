//! Markdown pictures use a separate, credential-free client.
use super::MAX_FILE_BYTES;
use crate::history::Result;
use futures_lite::StreamExt;
use reqwest::{Client, Url};
use std::time::Duration;

pub struct Images(Client);
impl Images {
    pub fn new() -> Result<Self> {
        #[cfg(not(target_arch = "wasm32"))]
        let client = Client::builder()
            .no_proxy()
            .referer(false)
            .redirect(reqwest::redirect::Policy::custom(|hop| {
                if hop.previous().len() < 5 && network(hop.url()) {
                    hop.follow()
                } else {
                    hop.stop()
                }
            }))
            .build()?;
        #[cfg(target_arch = "wasm32")]
        let client = Client::new();
        Ok(Self(client))
    }

    pub async fn read(&self, base: &str, source: &str, maximum: usize) -> Result<Vec<u8>> {
        let maximum = maximum.min(MAX_FILE_BYTES);
        let url = source_url(base, source).ok_or("unsupported Markdown image source")?;
        let request = self.0.get(url).timeout(Duration::from_secs(15));
        #[cfg(target_arch = "wasm32")]
        let request = request.fetch_credentials_omit();
        let response = request.send().await?.error_for_status()?;
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
        }
        Ok(bytes)
    }
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
