//! The project-owned `messageHistory` field of the shared instance document.
use crate::{
    backend::{Backend, read_json_limited},
    history::Result,
};
use reqwest::Url;

pub const MAX_ENTRY_BYTES: usize = 128 * 1024;
pub const MAX_ENTRIES: usize = 100;

fn url(backend: &Backend) -> Result<Url> {
    if backend.workspace.is_empty() {
        return Err("prompt history requires a workspace".into());
    }
    let mut url = Url::parse(&format!("{}api/storage/instances", backend.base))?;
    url.path_segments_mut()
        .map_err(|_| "invalid instance storage URL")?
        .push(&backend.workspace);
    Ok(url)
}

pub async fn read(backend: &Backend) -> Result<Vec<String>> {
    let request = backend
        .client
        .get(url(backend)?)
        .header("cache-control", "no-cache");
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?.error_for_status()?;
    let data = read_json_limited(response, 8 * 1024 * 1024 + 128).await?;
    let entries = data["messageHistory"]
        .as_array()
        .ok_or("invalid prompt history")?;
    entries
        .iter()
        .take(MAX_ENTRIES)
        .map(|entry| {
            entry
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "invalid prompt history entry".into())
        })
        .collect()
}

/// One append per attempt. A lost acknowledgement never replays the write.
pub async fn append(backend: &Backend, text: &str) -> Result<()> {
    if text.is_empty() || text.len() > MAX_ENTRY_BYTES {
        return Err("prompt history entry outside its storage budget".into());
    }
    let response = backend
        .client
        .post(url(backend)?)
        .json(&serde_json::json!({"text": text}))
        .send()
        .await?;
    if response.status() != reqwest::StatusCode::NO_CONTENT {
        return Err(format!("prompt history append returned HTTP {}", response.status()).into());
    }
    Ok(())
}
