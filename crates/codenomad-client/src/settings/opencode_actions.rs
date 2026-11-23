use crate::backend::{Backend, read_json_limited};
use std::time::Duration;

const FAILED: &str = "settings.opencode.setup.actionFailed";

pub async fn local_opencode_offer(
    backend: &Backend,
) -> crate::history::Result<super::OpenCodeStatus> {
    let response = backend
        .client
        .get(format!("{}api/meta", backend.base))
        .send()
        .await?
        .error_for_status()?;
    if read_json_limited(response, 65536).await?["localRequest"] != true {
        return Err("OpenCode maintenance requires the local host".into());
    }
    super::opencode_status(backend, false).await
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
