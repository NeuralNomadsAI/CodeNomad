use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Autonomous,
    Supervised,
}

#[derive(Debug, Deserialize)]
pub struct Snapshot {
    pub mode: Mode,
    #[serde(rename = "rootSessionID")]
    pub root: Option<String>,
}

#[derive(Clone, Copy)]
pub enum WriteIssue {
    Unverified,
    Unconfirmed,
}

impl Backend {
    fn permission_mode_url(&self) -> Result<String> {
        if !valid_id(&self.workspace) || !valid_id(&self.session) {
            return Err("invalid permission mode target".into());
        }
        Ok(format!(
            "{}api/workspaces/{}/sessions/{}/permission-mode",
            self.base, self.workspace, self.session
        ))
    }

    pub async fn permission_mode(&self) -> Result<Snapshot> {
        let response = self
            .client
            .get(self.permission_mode_url()?)
            .timeout(Duration::from_secs(12))
            .send()
            .await?
            .error_for_status()?;
        snapshot(read_json_limited(response, 4096).await?)
    }

    pub async fn set_permission_mode(
        &self,
        mode: Mode,
    ) -> std::result::Result<Snapshot, WriteIssue> {
        let Ok(url) = self.permission_mode_url() else {
            return Err(WriteIssue::Unconfirmed);
        };
        let Ok(response) = self
            .client
            .put(url)
            .json(&json!({ "mode": mode }))
            .timeout(Duration::from_secs(12))
            .send()
            .await
        else {
            return Err(WriteIssue::Unconfirmed);
        };
        let status = response.status();
        let body = read_json_limited(response, 4096)
            .await
            .map_err(|_| WriteIssue::Unconfirmed)?;
        if status.is_success() {
            return snapshot(body).map_err(|_| WriteIssue::Unconfirmed);
        }
        if status == reqwest::StatusCode::CONFLICT && body["code"] == "PERMISSION_BLOCK_UNVERIFIED"
        {
            return Err(WriteIssue::Unverified);
        }
        Err(WriteIssue::Unconfirmed)
    }
}

fn snapshot(body: serde_json::Value) -> Result<Snapshot> {
    let snapshot: Snapshot = serde_json::from_value(body)?;
    if snapshot.root.as_deref().is_some_and(|root| !valid_id(root)) {
        return Err("invalid permission mode root".into());
    }
    Ok(snapshot)
}
