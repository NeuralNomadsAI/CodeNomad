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
        let snapshot: Snapshot = serde_json::from_value(read_json_limited(response, 4096).await?)?;
        if snapshot.root.as_deref().is_some_and(|root| !valid_id(root)) {
            return Err("invalid permission mode root".into());
        }
        Ok(snapshot)
    }

    pub async fn set_permission_mode(&self, mode: Mode) -> Option<WriteIssue> {
        let Ok(url) = self.permission_mode_url() else {
            return Some(WriteIssue::Unconfirmed);
        };
        let Ok(response) = self
            .client
            .put(url)
            .json(&json!({ "mode": mode }))
            .timeout(Duration::from_secs(12))
            .send()
            .await
        else {
            return Some(WriteIssue::Unconfirmed);
        };
        if response.status().is_success() {
            return None;
        }
        if response.status() == reqwest::StatusCode::CONFLICT
            && read_json_limited(response, 4096)
                .await
                .is_ok_and(|body| body["code"] == "PERMISSION_BLOCK_UNVERIFIED")
        {
            return Some(WriteIssue::Unverified);
        }
        Some(WriteIssue::Unconfirmed)
    }
}
