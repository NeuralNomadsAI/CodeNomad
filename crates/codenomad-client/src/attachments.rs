use crate::{
    backend::Backend,
    content::Reference,
    history::{Result, valid_id},
};
use futures_lite::StreamExt;
use std::sync::Arc;

pub const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;

impl Backend {
    pub async fn attachment_bytes(&self, reference: &Reference) -> Result<Arc<Vec<u8>>> {
        if !valid_id(&self.workspace)
            || !valid_id(&self.session)
            || !valid_id(&reference.message)
            || reference.ordinal >= crate::history::MESSAGE_BYTES
            || !crate::content::attachment_digest(&reference.sha256)
        {
            return Err("invalid attachment identity".into());
        }
        let response = self
            .client
            .get(format!(
                "{}api/workspaces/{}/session-attachment/{}/{}/{}/{}",
                self.base,
                self.workspace,
                self.session,
                reference.message,
                reference.ordinal,
                reference.sha256
            ))
            .send()
            .await?
            .error_for_status()?;
        if response.status() != reqwest::StatusCode::OK {
            return Err("unexpected attachment response".into());
        }
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.split(';').next() == Some("application/octet-stream"))
        {
            return Err("invalid attachment content type".into());
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_ATTACHMENT_BYTES as u64)
        {
            return Err("attachment body exceeds its bound".into());
        }
        let mut bytes = Vec::with_capacity(response.content_length().unwrap_or(0) as usize);
        let mut chunks = response.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            if chunk.len() > MAX_ATTACHMENT_BYTES - bytes.len() {
                return Err("attachment body exceeds its bound".into());
            }
            let needed = bytes.len() + chunk.len();
            if needed > bytes.capacity() {
                let capacity = needed.max(bytes.capacity() * 2).min(MAX_ATTACHMENT_BYTES);
                bytes.reserve_exact(capacity - bytes.len());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(Arc::new(bytes))
    }
}
