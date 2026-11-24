use crate::{
    backend::Backend,
    files::MAX_FILE_BYTES,
    history::{Result, valid_id},
};
use futures_lite::StreamExt;
use std::sync::Arc;

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct DeferredPicture(Arc<str>);

impl DeferredPicture {
    pub(super) fn parse(uri: &str, message: &str, part: usize, index: usize) -> Option<Self> {
        if uri.len() > 4096 || !valid_id(message) || part > 100_000 || index > 100_000 {
            return None;
        }
        let (workspace, rest) = uri
            .strip_prefix("/api/workspaces/")?
            .split_once("/session-media/")?;
        let (session, rest) = rest.split_once('/')?;
        let digest = rest.strip_prefix(&format!("{message}/{part}/{index}/"))?;
        (valid_id(workspace) && valid_id(session) && crate::content::attachment_digest(digest))
            .then(|| Self(uri.into()))
    }

    pub(super) fn path(&self) -> &str {
        &self.0
    }

    pub(super) async fn read(&self, backend: &Backend, mime: &str) -> Result<Vec<u8>> {
        if !valid_id(&backend.workspace)
            || !valid_id(&backend.session)
            || !self.0.starts_with(&format!(
                "/api/workspaces/{}/session-media/{}/",
                backend.workspace, backend.session
            ))
        {
            return Err("image belongs to another conversation".into());
        }
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
                    value.split(';').next().is_some_and(|value| {
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
        Ok(bytes)
    }
}

fn icon(mime: &str) -> bool {
    mime.eq_ignore_ascii_case("image/x-icon")
        || mime.eq_ignore_ascii_case("image/vnd.microsoft.icon")
}

#[test]
fn reference_matches_the_exact_native_slot_and_canonical_digest() {
    let uri = format!(
        "/api/workspaces/w/session-media/s/m/23/5/{}",
        "a".repeat(64)
    );
    assert!(DeferredPicture::parse(&uri, "m", 23, 5).is_some());
    assert!(DeferredPicture::parse(&uri, "wrong", 23, 5).is_none());
    assert!(DeferredPicture::parse(&uri, "m", 23, 4).is_none());
    assert!(DeferredPicture::parse(&uri.replace("/23/", "/023/"), "m", 23, 5).is_none());
    assert!(DeferredPicture::parse(&uri.replace("/w/", "/../"), "m", 23, 5).is_none());
    assert!(DeferredPicture::parse(&format!("{uri}?x"), "m", 23, 5).is_none());
}
