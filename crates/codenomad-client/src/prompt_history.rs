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
pub struct Document {
    message_history: Vec<String>,
    agent_model_selections: Map<String, Value>,
}

fn url(backend: &Backend) -> Result<Url> {
    let directory = backend
        .session_directory
        .as_deref()
        .ok_or("prompt history requires a session directory")?;
    let mut url = Url::parse(&format!("{}api/storage/instances", backend.base))?;
    url.path_segments_mut()
        .map_err(|_| "invalid instance storage URL")?
        .push(directory);
    Ok(url)
}

pub async fn read_document(backend: &Backend) -> Result<Document> {
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
    Ok(read_document(backend).await?.history().to_vec())
}

impl Document {
    pub fn history(&self) -> &[String] {
        &self.message_history[..self.message_history.len().min(MAX_ENTRIES)]
    }

    pub fn prepend(&mut self, text: String) {
        self.message_history.insert(0, text);
        self.message_history.truncate(MAX_ENTRIES);
    }

    /// One whole-document PUT. An unconfirmed write is not replayed automatically.
    pub async fn write(&self, backend: &Backend) -> Result<bool> {
        let body = serde_json::to_vec(self)?;
        if body.len() > MAX_WRITE_BYTES {
            return Ok(false);
        }
        let response = backend
            .client
            .put(url(backend)?)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await?;
        if response.status() != reqwest::StatusCode::NO_CONTENT {
            return Err(format!("prompt history write returned HTTP {}", response.status()).into());
        }
        Ok(true)
    }
}
