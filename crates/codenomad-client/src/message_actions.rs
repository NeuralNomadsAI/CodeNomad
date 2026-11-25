use crate::{
    Receiver,
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

const DEADLINE: Duration = Duration::from_secs(15);
const RECORD_LIMIT: usize = 256 * 1024;
const LIST_LIMIT: usize = 24 * 1024 * 1024;
pub const MAX_PRUNE_MESSAGES: usize = 256;
pub const MAX_PRUNE_INDEX: u64 = 100_000;
const MAX_PRUNE_PARTS: usize = 100_001;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PruneKind {
    Tool,
    Reasoning,
}

impl PruneKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "tool" => Some(Self::Tool),
            "reasoning" => Some(Self::Reasoning),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PrunePartTarget {
    pub index: u64,
    pub kind: PruneKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PruneMessageTarget {
    pub message: String,
    pub parts: Vec<PrunePartTarget>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PruneReason {
    Unavailable,
    MaintenanceRequired,
    Conflict,
    NotDeletable,
    UnsupportedStorage,
    Blocked,
}

impl PruneReason {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("unavailable") => Self::Unavailable,
            Some("maintenance_required") => Self::MaintenanceRequired,
            Some("conflict") => Self::Conflict,
            Some("not_deletable") => Self::NotDeletable,
            Some("unsupported_storage") => Self::UnsupportedStorage,
            _ => Self::Blocked,
        }
    }

    pub fn message_key(self) -> &'static str {
        match self {
            Self::Unavailable => "session.pruning.unavailable",
            Self::MaintenanceRequired => "session.pruning.maintenance_required",
            Self::Conflict => "session.pruning.conflict",
            Self::NotDeletable => "session.pruning.not_deletable",
            Self::UnsupportedStorage => "session.pruning.unsupported_storage",
            Self::Blocked => "session.pruning.blocked",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PruneBlocked {
    pub reason: PruneReason,
}

impl std::fmt::Display for PruneBlocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason.message_key())
    }
}

impl std::error::Error for PruneBlocked {}

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

struct PruneMessagePlan {
    message: String,
    revision: String,
    indexes: Vec<u64>,
    tools: usize,
}

pub struct PrunePreview {
    connection: crate::http::Http,
    workspace: String,
    session: String,
    directory: Option<String>,
    messages: Vec<PruneMessagePlan>,
}

impl PrunePreview {
    pub fn counts(&self) -> (usize, usize) {
        let tools = self.messages.iter().map(|m| m.tools).sum();
        let total: usize = self.messages.iter().map(|m| m.indexes.len()).sum();
        (tools, total - tools)
    }

    pub fn message_count(&self) -> usize {
        self.messages.len()
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
        let (revision, parts) = self.fetch_prune_preview(message).await?;
        if parts.is_empty() {
            return Err("invalid prune parts".into());
        }
        let mut indexes: Vec<_> = parts.keys().copied().collect();
        indexes.sort_unstable();
        let tools = parts
            .values()
            .filter(|kind| **kind == PruneKind::Tool)
            .count();
        Ok(PrunePreview {
            connection: self.client.clone(),
            workspace: self.workspace.clone(),
            session: self.session.clone(),
            directory: self.session_directory.clone(),
            messages: vec![PruneMessagePlan {
                message: message.into(),
                revision,
                indexes,
                tools,
            }],
        })
    }

    pub async fn preview_prune_targets(
        &self,
        targets: &[PruneMessageTarget],
        cancel: &Receiver<()>,
    ) -> Result<PrunePreview> {
        self.action_session()?;
        let normalized = validate_prune_targets(targets)?;
        let mut messages = Vec::with_capacity(normalized.len());
        for target in normalized {
            if cancel.is_closed() {
                return Err("pruning selection expired".into());
            }
            let (revision, available) = self.fetch_prune_preview(&target.message).await?;
            if cancel.is_closed() {
                return Err("pruning selection expired".into());
            }
            let mut indexes = Vec::with_capacity(target.parts.len());
            let mut tools = 0;
            for part in target.parts {
                if available.get(&part.index) != Some(&part.kind) {
                    return Err(PruneBlocked {
                        reason: PruneReason::Conflict,
                    }
                    .into());
                }
                indexes.push(part.index);
                tools += usize::from(part.kind == PruneKind::Tool);
            }
            messages.push(PruneMessagePlan {
                message: target.message,
                revision,
                indexes,
                tools,
            });
        }
        Ok(PrunePreview {
            connection: self.client.clone(),
            workspace: self.workspace.clone(),
            session: self.session.clone(),
            directory: self.session_directory.clone(),
            messages,
        })
    }

    async fn fetch_prune_preview(
        &self,
        message: &str,
    ) -> Result<(String, HashMap<u64, PruneKind>)> {
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
        if reply["status"] == "blocked" {
            return Err(PruneBlocked {
                reason: PruneReason::parse(reply["reason"].as_str()),
            }
            .into());
        }
        if reply["status"] != "preview" {
            return Err("pruning unavailable".into());
        }
        if reply["liveMutation"] != true {
            return Err(PruneBlocked {
                reason: PruneReason::Unavailable,
            }
            .into());
        }
        let revision = revision(&reply).ok_or("invalid prune revision")?.to_owned();
        let raw = reply["parts"]
            .as_array()
            .filter(|parts| parts.len() <= MAX_PRUNE_PARTS)
            .ok_or("invalid prune parts")?;
        let mut parts = HashMap::with_capacity(raw.len());
        for part in raw {
            let index = part["index"]
                .as_u64()
                .filter(|index| *index <= MAX_PRUNE_INDEX)
                .ok_or("invalid prune index")?;
            let kind = part["type"]
                .as_str()
                .and_then(PruneKind::parse)
                .ok_or("invalid prune selection")?;
            if parts.insert(index, kind).is_some() {
                return Err("invalid prune selection".into());
            }
        }
        Ok((revision, parts))
    }

    pub async fn prune_message(&self, preview: PrunePreview) -> Result<()> {
        let (_keep, cancel) = crate::bounded(1);
        self.prune_targets(preview, &cancel).await
    }

    pub async fn prune_targets(&self, preview: PrunePreview, cancel: &Receiver<()>) -> Result<()> {
        self.action_session()?;
        if !preview.connection.same_connection(&self.client)
            || preview.workspace != self.workspace
            || preview.session != self.session
            || preview.directory != self.session_directory
        {
            return Err("pruning preview belongs to another conversation".into());
        }
        if preview.messages.is_empty() || preview.messages.len() > MAX_PRUNE_MESSAGES {
            return Err("invalid prune target set".into());
        }
        let url = format!(
            "{}api/workspaces/{}/session-pruning/prune",
            self.base, self.workspace
        );
        for plan in preview.messages {
            if cancel.is_closed() {
                return Err("pruning selection expired".into());
            }
            let response = self
                .client
                .post(&url)
                .timeout(DEADLINE)
                .json(&json!({
                    "sessionID": self.session,
                    "messageID": plan.message,
                    "revision": plan.revision,
                    "indexes": plan.indexes,
                }))
                .send()
                .await?;
            let reply = read_json_limited(prune_response(response)?, RECORD_LIMIT).await?;
            if reply["status"] == "blocked" {
                return Err(PruneBlocked {
                    reason: PruneReason::parse(reply["reason"].as_str()),
                }
                .into());
            }
            if reply["status"] != "pruned"
                || reply["messageID"] != plan.message
                || reply["removedCount"].as_u64() != Some(plan.indexes.len() as u64)
                || revision(&reply).is_none()
            {
                return Err("pruning not confirmed".into());
            }
        }
        Ok(())
    }
}

fn validate_prune_targets(targets: &[PruneMessageTarget]) -> Result<Vec<PruneMessageTarget>> {
    if targets.is_empty() || targets.len() > MAX_PRUNE_MESSAGES {
        return Err("invalid prune target set".into());
    }
    let mut seen_messages = HashSet::with_capacity(targets.len());
    let mut normalized = Vec::with_capacity(targets.len());
    for target in targets {
        if !valid_id(&target.message)
            || !seen_messages.insert(target.message.as_str())
            || target.parts.is_empty()
            || target.parts.len() > MAX_PRUNE_PARTS
        {
            return Err("invalid message action target".into());
        }
        let mut seen_indexes = HashSet::with_capacity(target.parts.len());
        let mut parts = Vec::with_capacity(target.parts.len());
        for part in &target.parts {
            if part.index > MAX_PRUNE_INDEX || !seen_indexes.insert(part.index) {
                return Err("invalid prune selection".into());
            }
            parts.push(*part);
        }
        parts.sort_unstable_by_key(|part| part.index);
        normalized.push(PruneMessageTarget {
            message: target.message.clone(),
            parts,
        });
    }
    Ok(normalized)
}

fn revision(value: &Value) -> Option<&str> {
    value["revision"].as_str().filter(|rev| {
        rev.len() == 64
            && rev
                .bytes()
                .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(message: &str, parts: &[(u64, PruneKind)]) -> PruneMessageTarget {
        PruneMessageTarget {
            message: message.into(),
            parts: parts
                .iter()
                .map(|&(index, kind)| PrunePartTarget { index, kind })
                .collect(),
        }
    }

    #[test]
    fn validate_prune_targets_enforces_bounds_and_uniqueness() {
        assert!(validate_prune_targets(&[]).is_err());
        assert!(validate_prune_targets(&[target("m1", &[])]).is_err());
        assert!(validate_prune_targets(&[target("../bad", &[(0, PruneKind::Tool)])]).is_err());
        assert!(
            validate_prune_targets(&[
                target("m1", &[(0, PruneKind::Tool)]),
                target("m1", &[(1, PruneKind::Tool)]),
            ])
            .is_err()
        );
        assert!(
            validate_prune_targets(&[target(
                "m1",
                &[(2, PruneKind::Tool), (2, PruneKind::Reasoning)],
            )])
            .is_err()
        );
        assert!(
            validate_prune_targets(&[target("m1", &[(MAX_PRUNE_INDEX + 1, PruneKind::Tool)])])
                .is_err()
        );
        let too_many: Vec<_> = (0..=MAX_PRUNE_MESSAGES)
            .map(|i| target(&format!("m{i}"), &[(0, PruneKind::Tool)]))
            .collect();
        assert!(validate_prune_targets(&too_many).is_err());

        let normalized = validate_prune_targets(&[target(
            "m1",
            &[(4, PruneKind::Reasoning), (1, PruneKind::Tool)],
        )])
        .unwrap();
        assert_eq!(normalized[0].parts[0].index, 1);
        assert_eq!(normalized[0].parts[1].index, 4);
    }

    #[test]
    fn prune_reason_maps_every_server_block_code() {
        for (raw, expected) in [
            (Some("unavailable"), "session.pruning.unavailable"),
            (
                Some("maintenance_required"),
                "session.pruning.maintenance_required",
            ),
            (Some("conflict"), "session.pruning.conflict"),
            (Some("not_deletable"), "session.pruning.not_deletable"),
            (
                Some("unsupported_storage"),
                "session.pruning.unsupported_storage",
            ),
            (Some("unknown"), "session.pruning.blocked"),
            (None, "session.pruning.blocked"),
        ] {
            assert_eq!(PruneReason::parse(raw).message_key(), expected);
        }
    }
}
