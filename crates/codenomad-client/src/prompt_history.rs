//! The project-owned `messageHistory` field of the shared instance document.
use crate::{
    backend::{Backend, read_json_limited},
    history::Result,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MAX_ENTRIES: usize = 100;
// Fastify's default body limit, used by the shared instance PUT.
pub const MAX_WRITE_BYTES: usize = 1024 * 1024;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct InstanceData {
    message_history: Vec<String>,
    agent_model_selections: Map<String, Value>,
}

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

async fn read_instance(backend: &Backend) -> Result<InstanceData> {
    let request = backend
        .client
        .get(url(backend)?)
        .header("cache-control", "no-cache");
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?.error_for_status()?;
    Ok(serde_json::from_value(
        read_json_limited(response, 8 * 1024 * 1024 + 128).await?,
    )?)
}

pub async fn read(backend: &Backend) -> Result<Vec<String>> {
    let mut history = read_instance(backend).await?.message_history;
    history.truncate(MAX_ENTRIES);
    Ok(history)
}

/// Use the shared whole-document PUT, preserving model selections from a fresh read.
/// A lost acknowledgement never replays the write.
pub async fn append(backend: &Backend, text: &str) -> Result<()> {
    if text.is_empty() || text.len() > MAX_WRITE_BYTES {
        return Err("prompt history entry outside its storage budget".into());
    }
    let mut data = read_instance(backend).await?;
    data.message_history.insert(0, text.into());
    data.message_history.truncate(MAX_ENTRIES);
    let body = serde_json::to_vec(&data)?;
    if body.len() > MAX_WRITE_BYTES {
        return Err("instance document outside its storage budget".into());
    }
    let response = backend
        .client
        .put(url(backend)?)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await?;
    if response.status() != reqwest::StatusCode::NO_CONTENT {
        return Err(format!("prompt history append returned HTTP {}", response.status()).into());
    }
    Ok(())
}
