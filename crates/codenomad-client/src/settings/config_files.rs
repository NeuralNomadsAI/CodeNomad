use crate::{
    backend::{Backend, read_json_limited},
    history::Result,
};
use serde::Deserialize;

pub const MAX_CONTENT: usize = 1024 * 1024;

#[derive(Deserialize)]
pub struct File {
    pub id: String,
    pub label: String,
    pub path: String,
    pub language: String,
}

#[derive(Deserialize, Debug, PartialEq, Eq)]
pub struct Content {
    id: String,
    pub contents: String,
    pub exists: bool,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn url(backend: &Backend, id: &str) -> Result<String> {
    if !valid_id(id) {
        return Err("Invalid configuration file identity".into());
    }
    Ok(format!("{}api/config-files/{id}/content", backend.base))
}

pub async fn list(backend: &Backend) -> Result<Vec<File>> {
    let request = backend
        .client
        .get(format!("{}api/config-files", backend.base));
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?.error_for_status()?;
    let files: Vec<File> = serde_json::from_value(read_json_limited(response, 64 * 1024).await?)?;
    let mut ids = std::collections::HashSet::new();
    if files.len() > 64
        || files.iter().any(|f| {
            !valid_id(&f.id)
                || !ids.insert(&f.id)
                || [&f.label, &f.path, &f.language]
                    .into_iter()
                    .any(|s| s.is_empty() || s.len() > 4096 || s.contains(char::is_control))
        })
    {
        return Err("Invalid configuration file list".into());
    }
    Ok(files)
}

pub async fn read(backend: &Backend, id: &str) -> Result<Content> {
    let request = backend.client.get(url(backend, id)?);
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?.error_for_status()?;
    // JSON control-character escaping can expand each byte up to six times.
    let data = read_json_limited(response, MAX_CONTENT * 6 + 16 * 1024).await?;
    let content: Content = serde_json::from_value(data)?;
    if content.id != id
        || content.contents.len() > MAX_CONTENT
        || !content.exists && !content.contents.is_empty()
    {
        return Err("Invalid configuration file content".into());
    }
    Ok(content)
}

pub async fn save(backend: &Backend, id: &str, contents: &str) -> Result<()> {
    if contents.len() > MAX_CONTENT {
        return Err("Configuration file is too large".into());
    }
    let response = backend
        .client
        .put(url(backend, id)?)
        .json(&serde_json::json!({ "contents": contents }))
        .send()
        .await?
        .error_for_status()?;
    if response.status() != reqwest::StatusCode::NO_CONTENT {
        return Err("Unconfirmed configuration file save".into());
    }
    Ok(())
}
