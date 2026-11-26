use crate::{backend::Backend, files::MAX_FILE_BYTES, history::Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_lite::StreamExt;
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct DeferredPicture(Arc<str>);

pub fn data_uri_digest(mime: &str, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"data:");
    hasher.update(mime.as_bytes());
    hasher.update(b";base64,");
    let mut encoded = [0u8; 4 * 1024];
    for chunk in bytes.chunks(3 * 1024) {
        let written = STANDARD
            .encode_slice(chunk, &mut encoded)
            .expect("3 KiB raw chunk always fits in 4 KiB base64 buffer");
        hasher.update(&encoded[..written]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

fn encode_uri_component(id: &str) -> String {
    let mut encoded = String::with_capacity(id.len());
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn valid_media_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && id.encode_utf16().nth(256).is_none()
        && !id.bytes().any(|byte| byte.is_ascii_control())
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn decode_canonical_id(segment: &str) -> Option<String> {
    let raw = segment.as_bytes();
    let mut decoded = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' {
            let hi = hex_nibble(*raw.get(i + 1)?)?;
            let lo = hex_nibble(*raw.get(i + 2)?)?;
            decoded.push((hi << 4) | lo);
            i += 3;
        } else {
            decoded.push(raw[i]);
            i += 1;
        }
    }
    let id = String::from_utf8(decoded).ok()?;
    (valid_media_id(&id) && encode_uri_component(&id) == segment).then_some(id)
}

impl DeferredPicture {
    pub(super) fn parse(uri: &str, message: &str, part: usize, index: usize) -> Option<Self> {
        if uri.len() > 4096
            || !valid_media_id(message)
            || part > 100_000
            || index > 100_000
            || uri.contains(['?', '#'])
        {
            return None;
        }
        let mut segments = uri.strip_prefix("/api/workspaces/")?.split('/');
        let workspace = segments.next()?;
        if segments.next()? != "session-media" {
            return None;
        }
        let session = segments.next()?;
        let msg_seg = segments.next()?;
        let part_seg = segments.next()?;
        let index_seg = segments.next()?;
        let digest = segments.next()?;
        if segments.next().is_some() {
            return None;
        }
        (decode_canonical_id(workspace).is_some()
            && decode_canonical_id(session).is_some()
            && decode_canonical_id(msg_seg).as_deref() == Some(message)
            && part_seg == part.to_string()
            && index_seg == index.to_string()
            && crate::content::attachment_digest(digest))
        .then(|| Self(uri.into()))
    }

    pub(super) fn path(&self) -> &str {
        &self.0
    }

    pub(super) async fn read(&self, backend: &Backend, mime: &str) -> Result<Vec<u8>> {
        if !valid_media_id(&backend.workspace) || !valid_media_id(&backend.session) {
            return Err("image belongs to another conversation".into());
        }
        let expected_prefix = format!(
            "/api/workspaces/{}/session-media/{}/",
            encode_uri_component(&backend.workspace),
            encode_uri_component(&backend.session)
        );
        if !self.0.starts_with(&expected_prefix) {
            return Err("image belongs to another conversation".into());
        }
        let expected_digest = self
            .0
            .rsplit('/')
            .next()
            .filter(|digest| crate::content::attachment_digest(digest))
            .ok_or("invalid deferred image reference")?;
        let response = backend
            .client
            .get(format!("{}{}", backend.base, &self.0[1..]))
            .send()
            .await?
            .error_for_status()?;
        if response.status() != reqwest::StatusCode::OK
            || response
                .content_length()
                .is_some_and(|len| len > MAX_FILE_BYTES as u64)
            || !response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    value.split(';').next().map(str::trim).is_some_and(|value| {
                        value.eq_ignore_ascii_case(mime) || icon(mime) && icon(value)
                    })
                })
        {
            return Err("unavailable deferred image".into());
        }
        let mut bytes = Vec::new();
        let mut chunks = response.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            if chunk.len() > MAX_FILE_BYTES - bytes.len() {
                return Err("oversized deferred image".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if data_uri_digest(mime, &bytes) != expected_digest {
            return Err("deferred image digest mismatch".into());
        }
        Ok(bytes)
    }
}

fn icon(mime: &str) -> bool {
    mime.eq_ignore_ascii_case("image/x-icon")
        || mime.eq_ignore_ascii_case("image/vnd.microsoft.icon")
}

#[test]
fn reference_matches_the_exact_native_slot_and_canonical_digest() {
    let digest = "a".repeat(64);
    let uri = format!("/api/workspaces/w/session-media/s/m/23/5/{digest}");
    assert!(DeferredPicture::parse(&uri, "m", 23, 5).is_some());
    // Canonical percent-encoded IDs match TS and Rust server session-media contracts.
    let encoded_uri = format!("/api/workspaces/ws%201/session-media/ses%3A1/m/23/5/{digest}");
    assert!(DeferredPicture::parse(&encoded_uri, "m", 23, 5).is_some());
    assert!(
        DeferredPicture::parse(&encoded_uri.replace("%3A", "%3a"), "m", 23, 5).is_none(),
        "non-canonical lowercase percent-encoding must be rejected"
    );
    assert!(DeferredPicture::parse(&uri, "wrong", 23, 5).is_none());
    assert!(DeferredPicture::parse(&uri, "m", 23, 4).is_none());
    assert!(DeferredPicture::parse(&uri.replace("/23/", "/023/"), "m", 23, 5).is_none());
    assert!(DeferredPicture::parse(&uri.replace("/w/", "/../"), "m", 23, 5).is_none());
    assert!(DeferredPicture::parse(&uri.replace("/w/", "/%2E%2E/"), "m", 23, 5).is_none());
    assert!(DeferredPicture::parse(&format!("{uri}?x"), "m", 23, 5).is_none());
    assert!(DeferredPicture::parse(&format!("{uri}#x"), "m", 23, 5).is_none());
}

#[test]
fn streaming_data_uri_digest_matches_full_base64_sha256() {
    let payload: Vec<u8> = (0..(3 * 1024 + 17)).map(|i| (i % 251) as u8).collect();
    let full = format!("data:image/png;base64,{}", STANDARD.encode(&payload));
    let expected: String = Sha256::digest(full.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(data_uri_digest("image/png", &payload), expected);
}
