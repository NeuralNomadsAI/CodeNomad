mod markdown_pages;
#[cfg(test)]
mod tests;

pub use markdown_pages::{
    MarkdownPage, READER_PAGE_SIZE, body_covers, body_need, markdown_page, page_count, utf16_len,
};

use super::directory::{digest_id, panel_id};
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use reqwest::Url;
use serde::Deserialize;
use std::time::Duration;

const SAFE: u64 = (1 << 53) - 1;
const MAX_QUERY_OFFSET: u64 = 999_999_999_999_999;
const CONTENT_MAX_BYTES: usize = 512 * 1024;
const CONTENT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BodyDescriptor {
    pub characters: u64,
    pub digest: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefingItem {
    pub text: String,
    #[serde(default)]
    pub task_keys: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefingDoc {
    #[serde(default)]
    pub based_on_revision: u64,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub achieved: Vec<BriefingItem>,
    #[serde(default)]
    pub ongoing: Vec<BriefingItem>,
    #[serde(default)]
    pub obstacles: Vec<BriefingItem>,
    #[serde(default)]
    pub next: Vec<BriefingItem>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum ContentSelector {
    Mission { field: String },
    Task { task_key: String, field: String },
    Report { report_id: String, field: String },
    Change { change: u64, field: String },
}

impl ContentSelector {
    pub fn mission(field: impl Into<String>) -> Self {
        Self::Mission {
            field: field.into(),
        }
    }

    pub fn task(task_key: impl Into<String>, field: impl Into<String>) -> Self {
        Self::Task {
            task_key: task_key.into(),
            field: field.into(),
        }
    }

    pub fn report(report_id: impl Into<String>, field: impl Into<String>) -> Self {
        Self::Report {
            report_id: report_id.into(),
            field: field.into(),
        }
    }

    pub fn change(change: u64, field: impl Into<String>) -> Self {
        Self::Change {
            change,
            field: field.into(),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Mission { .. } => "mission",
            Self::Task { .. } => "task",
            Self::Report { .. } => "report",
            Self::Change { .. } => "change",
        }
    }

    pub fn field(&self) -> &str {
        match self {
            Self::Mission { field }
            | Self::Task { field, .. }
            | Self::Report { field, .. }
            | Self::Change { field, .. } => field,
        }
    }

    pub fn task_key(&self) -> Option<&str> {
        match self {
            Self::Task { task_key, .. } => Some(task_key),
            _ => None,
        }
    }

    pub fn report_id(&self) -> Option<&str> {
        match self {
            Self::Report { report_id, .. } => Some(report_id),
            _ => None,
        }
    }

    pub fn change_revision(&self) -> Option<u64> {
        match self {
            Self::Change { change, .. } => Some(*change),
            _ => None,
        }
    }

    pub fn valid(&self) -> bool {
        let field_ok = valid_field(self.field(), 64);
        match self {
            Self::Mission { .. } => field_ok,
            Self::Task { task_key, .. } => field_ok && valid_task_key(task_key),
            Self::Report { report_id, .. } => field_ok && valid_field(report_id, 240),
            Self::Change { change, .. } => field_ok && (1..=MAX_QUERY_OFFSET).contains(change),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentSlice {
    pub kind: String,
    pub field: String,
    pub task_key: Option<String>,
    pub report_id: Option<String>,
    pub change: Option<u64>,
    pub digest: String,
    pub offset: u64,
    pub characters: u64,
    #[serde(default)]
    pub json: bool,
    pub text: String,
    pub next: Option<u64>,
}

impl ContentSlice {
    pub fn valid(
        &self,
        selector: &ContentSelector,
        expected_offset: u64,
        expected_digest: Option<&str>,
    ) -> bool {
        if self.kind != selector.kind()
            || self.field != selector.field()
            || self.task_key.as_deref() != selector.task_key()
            || self.report_id.as_deref() != selector.report_id()
            || self.change != selector.change_revision()
            || !digest_id(&self.digest)
            || expected_digest.is_some_and(|digest| self.digest != digest)
            || self.offset != expected_offset
            || self.characters > SAFE
            || self.offset > SAFE
        {
            return false;
        }
        let len = utf16_len(&self.text) as u64;
        let Some(end) = self.offset.checked_add(len) else {
            return false;
        };
        if end > self.characters {
            return false;
        }
        match self.next {
            None => end == self.characters,
            Some(next) => len > 0 && next == end && next < self.characters,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ContentRefusal {
    MissionNotFound,
    ContentNotFound,
    ContentChanged,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContentOutcome {
    Slice {
        revision: u64,
        slice: ContentSlice,
    },
    Refused {
        revision: Option<u64>,
        refusal: ContentRefusal,
    },
    AuthExpired,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentEnvelope {
    available: bool,
    version: Option<u8>,
    #[serde(rename = "projectID")]
    project_id: Option<String>,
    #[serde(rename = "missionID")]
    mission_id: Option<String>,
    revision: Option<u64>,
    content: Option<ContentSlice>,
    refused: Option<ContentRefusal>,
}

impl Backend {
    pub async fn mission_content(
        &self,
        project_id: &str,
        mission_id: &str,
        selector: &ContentSelector,
        offset: u64,
        digest: Option<&str>,
    ) -> Result<ContentOutcome> {
        let mission_id = mission_id.trim();
        if !valid_id(&self.workspace)
            || !panel_id(project_id)
            || !valid_field(mission_id, 100)
            || !selector.valid()
            || offset > MAX_QUERY_OFFSET
            || (offset > 0 && digest.is_none())
            || digest.is_some_and(|value| !digest_id(value))
        {
            return Err("invalid Mission content request".into());
        }
        let mut url = Url::parse(&self.base)?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|()| "invalid backend URL")?;
            segments.pop_if_empty();
            segments.extend([
                "api",
                "workspaces",
                &self.workspace,
                "missions",
                mission_id,
                "content",
            ]);
        }
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("kind", selector.kind());
            pairs.append_pair("field", selector.field());
            pairs.append_pair("offset", &offset.to_string());
            if let Some(task_key) = selector.task_key() {
                pairs.append_pair("taskKey", task_key);
            }
            if let Some(report_id) = selector.report_id() {
                pairs.append_pair("reportId", report_id);
            }
            if let Some(change) = selector.change_revision() {
                pairs.append_pair("change", &change.to_string());
            }
            if let Some(digest) = digest {
                pairs.append_pair("digest", digest);
            }
        }
        let response = crate::runtime::timeout(CONTENT_TIMEOUT, async {
            let response = self.client.get(url).send().await?;
            if response.status().as_u16() == 401 {
                return Ok(None);
            }
            let response = response.error_for_status()?;
            read_json_limited(response, CONTENT_MAX_BYTES)
                .await
                .map(Some)
        })
        .await
        .ok_or("Mission content request timed out")??;
        let Some(raw) = response else {
            return Ok(ContentOutcome::AuthExpired);
        };
        let envelope: ContentEnvelope =
            serde_json::from_value(raw).map_err(|_| "invalid Mission content envelope")?;
        if !envelope.available
            || envelope.version != Some(1)
            || envelope.project_id.as_deref() != Some(project_id)
            || envelope.mission_id.as_deref() != Some(mission_id)
        {
            return Err("invalid Mission content".into());
        }
        if let Some(revision) = envelope.revision
            && revision > SAFE
        {
            return Err("invalid Mission content".into());
        }
        match (envelope.content, envelope.refused) {
            (Some(slice), None) => {
                let Some(revision) = envelope.revision else {
                    return Err("invalid Mission content".into());
                };
                if !slice.valid(selector, offset, digest) {
                    return Err("invalid Mission content slice".into());
                }
                Ok(ContentOutcome::Slice { revision, slice })
            }
            (None, Some(refusal)) => Ok(ContentOutcome::Refused {
                revision: envelope.revision,
                refusal,
            }),
            _ => Err("invalid Mission content".into()),
        }
    }
}

fn valid_field(value: &str, max_len: usize) -> bool {
    !value.is_empty() && utf16_len(value) <= max_len && !value.chars().any(char::is_control)
}

fn valid_task_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    (2..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-' | b'.')
        })
}
