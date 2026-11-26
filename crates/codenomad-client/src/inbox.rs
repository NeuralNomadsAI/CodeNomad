//! Session prompt queue (`session.inbox`) contract and mutation calls.
use crate::{
    Message,
    backend::{Backend, read_json_limited},
    content::{self, Part},
    history::{Result, WINDOW_BYTES, valid_id},
    prompt::Delivery,
};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};

const DEADLINE: Duration = Duration::from_secs(15);
pub const MAX_ITEMS: usize = 256;
const MAX_TEXT_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct QueuedPrompt {
    pub id: String,
    pub delivery: Delivery,
    pub text: String,
    pub parts: Vec<Part>,
    pub created: Option<u64>,
}

impl QueuedPrompt {
    pub fn into_message(&self) -> Message {
        Message {
            id: self.id.clone(),
            role: "user".into(),
            completed: true,
            body: self.text.clone(),
            usage: None,
            parts: self.parts.clone(),
        }
    }
}

#[derive(Debug)]
pub struct InboxUnavailable;

impl std::fmt::Display for InboxUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("prompt queue actions are unavailable on this server")
    }
}

impl std::error::Error for InboxUnavailable {}

fn parse_delivery(value: &Value) -> Option<Delivery> {
    match value.as_str()? {
        "queue" => Some(Delivery::Queue),
        "steer" => Some(Delivery::Steer),
        _ => None,
    }
}

fn delivery_str(delivery: Delivery) -> &'static str {
    match delivery {
        Delivery::Queue => "queue",
        Delivery::Steer => "steer",
    }
}

fn decode_user_item(id: &str, item: &Value, created: Option<u64>) -> Result<Option<QueuedPrompt>> {
    if item["type"] != "user" {
        return Ok(None);
    }
    let delivery = parse_delivery(&item["delivery"]).ok_or("invalid inbox delivery")?;
    let payload = &item["payload"];
    if !payload.is_object() {
        return Err("invalid inbox payload".into());
    }
    let text = payload["metadata"]["displayText"]
        .as_str()
        .filter(|text| !text.is_empty())
        .or_else(|| payload["text"].as_str())
        .ok_or("invalid inbox prompt text")?;
    if text.len() > MAX_TEXT_BYTES {
        return Err("inbox prompt text exceeds limit".into());
    }
    let parts = content::decode_user_payload(id, payload)?;
    let created = created.or_else(|| item["time"]["created"].as_u64());
    Ok(Some(QueuedPrompt {
        id: id.into(),
        delivery,
        text: text.into(),
        parts,
        created,
    }))
}

pub fn decode_list(value: &Value) -> Result<Vec<QueuedPrompt>> {
    let rows = value
        .get("data")
        .unwrap_or(value)
        .as_array()
        .filter(|rows| rows.len() <= MAX_ITEMS)
        .ok_or("invalid session inbox list")?;
    let mut seen = HashSet::with_capacity(rows.len());
    let mut items = Vec::new();
    for row in rows {
        let id = row["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or("invalid inbox item id")?;
        if !seen.insert(id) {
            return Err("duplicate inbox item id".into());
        }
        if let Some(prompt) = decode_user_item(id, row, None)? {
            items.push(prompt);
        }
    }
    Ok(items)
}

pub(crate) fn decode_enqueued(native: &Value) -> Option<QueuedPrompt> {
    let data = &native["data"];
    let item = &data["item"];
    let id = data["inboxID"]
        .as_str()
        .or_else(|| item["id"].as_str())
        .filter(|id| valid_id(id))?;
    decode_user_item(id, item, native["created"].as_u64())
        .ok()
        .flatten()
}

pub(crate) fn decode_delivery_changed(native: &Value) -> Option<(String, Delivery)> {
    let data = &native["data"];
    let id = data["inboxID"].as_str().filter(|id| valid_id(id))?;
    let delivery = parse_delivery(&data["delivery"])?;
    Some((id.into(), delivery))
}

pub(crate) fn decode_inbox_id(native: &Value) -> Option<&str> {
    native["data"]["inboxID"].as_str().filter(|id| valid_id(id))
}

impl Backend {
    fn inbox_url(&self) -> Result<String> {
        if !valid_id(&self.workspace) || !valid_id(&self.session) {
            return Err("invalid session inbox scope".into());
        }
        Ok(format!(
            "{}workspaces/{}/instance/api/session/{}/inbox",
            self.base, self.workspace, self.session
        ))
    }

    pub async fn session_inbox(&self) -> Result<Option<Vec<QueuedPrompt>>> {
        let response = self
            .client
            .get(self.inbox_url()?)
            .timeout(DEADLINE)
            .send()
            .await?;
        if matches!(
            response.status(),
            reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::NOT_IMPLEMENTED
        ) {
            return Ok(None);
        }
        let value = read_json_limited(response.error_for_status()?, WINDOW_BYTES).await?;
        decode_list(&value).map(Some)
    }

    pub async fn update_queued_prompt_delivery(
        &self,
        inbox_id: &str,
        delivery: Delivery,
    ) -> Result<()> {
        if !valid_id(inbox_id) {
            return Err("invalid inbox item id".into());
        }
        let response = self
            .client
            .patch(format!("{}/{inbox_id}", self.inbox_url()?))
            .timeout(DEADLINE)
            .json(&json!({ "delivery": delivery_str(delivery) }))
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_IMPLEMENTED {
            return Err(InboxUnavailable.into());
        }
        response.error_for_status()?;
        Ok(())
    }

    pub async fn cancel_queued_prompt(&self, inbox_id: &str) -> Result<()> {
        if !valid_id(inbox_id) {
            return Err("invalid inbox item id".into());
        }
        let response = self
            .client
            .delete(format!("{}/{inbox_id}", self.inbox_url()?))
            .timeout(DEADLINE)
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_IMPLEMENTED {
            return Err(InboxUnavailable.into());
        }
        response.error_for_status()?;
        Ok(())
    }
}
