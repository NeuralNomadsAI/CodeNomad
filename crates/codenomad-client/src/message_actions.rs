use crate::{
    Receiver,
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};

const DEADLINE: Duration = Duration::from_secs(15);
const RECORD_LIMIT: usize = 256 * 1024;
const LIST_LIMIT: usize = 24 * 1024 * 1024;

#[derive(Debug)]
pub struct PruneUnavailable;

impl std::fmt::Display for PruneUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("session pruning is unavailable")
    }
}

impl std::error::Error for PruneUnavailable {}

fn prune_response(response: reqwest::Response) -> Result<reqwest::Response> {
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(PruneUnavailable.into());
    }
    Ok(response.error_for_status()?)
}

pub struct PrunePreview {
    connection: crate::http::Http,
    workspace: String,
    session: String,
    directory: Option<String>,
    message: String,
    revision: String,
    indexes: Vec<u64>,
    tools: usize,
}

impl PrunePreview {
    pub fn counts(&self) -> (usize, usize) {
        (self.tools, self.indexes.len() - self.tools)
    }
}

impl Backend {
    fn action_session(&self) -> Result<String> {
        if !valid_id(&self.workspace) || !valid_id(&self.session) {
            return Err("invalid session action scope".into());
        }
        Ok(format!(
            "{}workspaces/{}/instance/api/session/{}",
            self.base, self.workspace, self.session
        ))
    }

    pub async fn staged_revert(&self) -> Result<Option<String>> {
        let response = self
            .client
            .get(self.action_session()?)
            .timeout(DEADLINE)
            .send()
            .await?;
        let record = read_json_limited(response.error_for_status()?, RECORD_LIMIT).await?;
        let record = record.get("data").unwrap_or(&record);
        if record["id"] != self.session {
            return Err("unexpected session in revert read".into());
        }
        match &record["revert"] {
            Value::Null => Ok(None),
            value => value["messageID"]
                .as_str()
                .filter(|id| valid_id(id))
                .map(|id| Some(id.into()))
                .ok_or_else(|| "invalid revert boundary".into()),
        }
    }

    pub async fn stage_message_revert(&self, message: &str) -> Result<()> {
        if !valid_id(message) {
            return Err("invalid message action target".into());
        }
        let response = self
            .client
            .post(format!("{}/revert/stage", self.action_session()?))
            .timeout(DEADLINE)
            .json(&json!({"messageID": message}))
            .send()
            .await?;
        let record = read_json_limited(response.error_for_status()?, RECORD_LIMIT).await?;
        if record["data"]["messageID"] != message {
            return Err("unexpected staged revert receipt".into());
        }
        Ok(())
    }

    pub async fn clear_message_revert(&self) -> Result<()> {
        let response = self
            .client
            .delete(format!("{}/revert", self.action_session()?))
            .timeout(DEADLINE)
            .send()
            .await?
            .error_for_status()?;
        if response.status().as_u16() != 204 {
            return Err("unexpected clear revert receipt".into());
        }
        Ok(())
    }

    pub async fn fork_after_message(&self, message: &str, cancel: &Receiver<()>) -> Result<String> {
        if !valid_id(message) {
            return Err("invalid message action target".into());
        }
        let url = self.action_session()?;
        let deadline = crate::runtime::Instant::now() + DEADLINE;
        let mut successor: Option<String> = None;
        let mut cursor: Option<String> = None;
        let mut seen = HashSet::new();
        loop {
            if cancel.is_closed() {
                return Err("fork selection expired".into());
            }
            let mut request = self
                .client
                .get(format!("{url}/message"))
                .timeout(deadline.saturating_duration_since(crate::runtime::Instant::now()))
                .query(&[("limit", "200")]);
            request = match &cursor {
                Some(cursor) => request.query(&[("cursor", cursor)]),
                None => request.query(&[("order", "desc")]),
            };
            let page =
                read_json_limited(request.send().await?.error_for_status()?, LIST_LIMIT).await?;
            for row in page["data"]
                .as_array()
                .filter(|rows| rows.len() <= 200)
                .ok_or("invalid fork page")?
            {
                let id = row["id"]
                    .as_str()
                    .filter(|id| valid_id(id))
                    .ok_or("invalid fork message id")?;
                if id == message {
                    if cancel.is_closed()
                        || row["type"] == "assistant" && row["time"]["completed"].is_null()
                    {
                        return Err("fork selection no longer available".into());
                    }
                    if crate::runtime::Instant::now() >= deadline {
                        return Err("fork read timed out".into());
                    }
                    let body = successor
                        .as_ref()
                        .map_or_else(|| json!({}), |id| json!({"before":id}));
                    let response = self
                        .client
                        .post(format!("{url}/fork"))
                        .timeout(DEADLINE)
                        .json(&body)
                        .send()
                        .await?;
                    let reply =
                        read_json_limited(response.error_for_status()?, RECORD_LIMIT).await?;
                    let fork = &reply["data"];
                    let id = fork["id"]
                        .as_str()
                        .filter(|id| *id != self.session && valid_id(id))
                        .ok_or("invalid fork receipt")?;
                    let (boundary_kind, boundary_id) = successor
                        .as_deref()
                        .map_or(("through", message), |id| ("before", id));
                    if fork["fork"]["sessionID"] != self.session {
                        return Err("unexpected fork receipt".into());
                    }
                    if fork["fork"]["boundary"]["type"] != boundary_kind
                        || fork["fork"]["boundary"]["messageID"] != boundary_id
                    {
                        self.client
                            .delete(format!(
                                "{}workspaces/{}/instance/api/session/{id}",
                                self.base, self.workspace
                            ))
                            .timeout(DEADLINE)
                            .send()
                            .await?
                            .error_for_status()?;
                        return Err("fork boundary changed".into());
                    }
                    return Ok(id.into());
                }
                successor = Some(id.into());
            }
            let next = page["cursor"]["next"]
                .as_str()
                .filter(|next| !next.is_empty() && next.len() <= 4096)
                .ok_or("fork target not found")?;
            if seen.len() >= 64
                || !seen.insert(next.to_owned())
                || crate::runtime::Instant::now() >= deadline
            {
                return Err("fork page budget reached".into());
            }
            cursor = Some(next.to_owned());
        }
    }

    pub async fn preview_message_prune(&self, message: &str) -> Result<PrunePreview> {
        self.action_session()?;
        if !valid_id(message) {
            return Err("invalid message action target".into());
        }
        let url = format!(
            "{}api/workspaces/{}/session-pruning/preview",
            self.base, self.workspace
        );
        let response = self
            .client
            .post(url)
            .timeout(DEADLINE)
            .json(&json!({"sessionID":self.session,"messageID":message}))
            .send()
            .await?;
        let reply = read_json_limited(prune_response(response)?, LIST_LIMIT).await?;
        if reply["status"] != "preview" || reply["liveMutation"] != true {
            return Err("pruning unavailable".into());
        }
        let revision = revision(&reply).ok_or("invalid prune revision")?;
        let mut indexes = HashSet::new();
        let mut tools = 0;
        for part in reply["parts"]
            .as_array()
            .filter(|parts| !parts.is_empty() && parts.len() <= 100_001)
            .ok_or("invalid prune parts")?
        {
            let index = part["index"]
                .as_u64()
                .filter(|index| *index <= 100_000)
                .ok_or("invalid prune index")?;
            if !matches!(part["type"].as_str(), Some("tool" | "reasoning"))
                || !indexes.insert(index)
            {
                return Err("invalid prune selection".into());
            }
            tools += usize::from(part["type"] == "tool");
        }
        let mut indexes: Vec<_> = indexes.into_iter().collect();
        indexes.sort_unstable();
        Ok(PrunePreview {
            connection: self.client.clone(),
            workspace: self.workspace.clone(),
            session: self.session.clone(),
            directory: self.session_directory.clone(),
            message: message.into(),
            revision: revision.into(),
            indexes,
            tools,
        })
    }

    pub async fn prune_message(&self, preview: PrunePreview) -> Result<()> {
        self.action_session()?;
        if !preview.connection.same_connection(&self.client)
            || preview.workspace != self.workspace
            || preview.session != self.session
            || preview.directory != self.session_directory
        {
            return Err("pruning preview belongs to another conversation".into());
        }
        let url = format!(
            "{}api/workspaces/{}/session-pruning/prune",
            self.base, self.workspace
        );
        let response = self.client.post(url).timeout(DEADLINE)
            .json(&json!({"sessionID":self.session,"messageID":preview.message,"revision":preview.revision,"indexes":preview.indexes}))
            .send().await?;
        let reply = read_json_limited(prune_response(response)?, RECORD_LIMIT).await?;
        if reply["status"] != "pruned"
            || reply["messageID"] != preview.message
            || reply["removedCount"].as_u64() != Some(preview.indexes.len() as u64)
            || revision(&reply).is_none()
        {
            return Err("pruning not confirmed".into());
        }
        Ok(())
    }
}

fn revision(value: &Value) -> Option<&str> {
    value["revision"].as_str().filter(|rev| {
        rev.len() == 64
            && rev
                .bytes()
                .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
    })
}
