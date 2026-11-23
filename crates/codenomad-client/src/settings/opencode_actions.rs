use crate::backend::{Backend, read_json_limited};
use std::time::Duration;

const FAILED: &str = "settings.opencode.setup.actionFailed";

pub async fn local_opencode_offer(
    backend: &Backend,
) -> crate::history::Result<super::OpenCodeStatus> {
    if !opencode_local(backend).await? {
        return Err("OpenCode maintenance requires the local host".into());
    }
    super::opencode_status(backend, false).await
}

pub async fn opencode_local(backend: &Backend) -> crate::history::Result<bool> {
    let request = backend.client.get(format!("{}api/meta", backend.base));
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?.error_for_status()?;
    let meta = read_json_limited(response, 65536).await?;
    Ok(meta["localRequest"] == true
        && backend
            .client
            .server_identity()
            .is_none_or(|id| meta["serverId"] == id))
}

pub async fn install_opencode(backend: &Backend) -> Result<(), &'static str> {
    let response = backend
        .client
        .post(format!("{}api/opencode/update", backend.base))
        .timeout(Duration::from_secs(300))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|_| FAILED)?;
    let success = response.status().is_success();
    let value = read_json_limited(response, 4096)
        .await
        .map_err(|_| FAILED)?;
    if success
        && value["success"] == true
        && value["version"]
            .as_str()
            .is_some_and(|version| !version.is_empty() && version.len() <= 256)
    {
        return Ok(());
    }
    Err(match value["error"].as_str() {
        Some("installation_busy") => "settings.opencode.setup.installation_busy",
        Some("installation_in_use") => "settings.opencode.setup.installation_in_use",
        _ => FAILED,
    })
}
