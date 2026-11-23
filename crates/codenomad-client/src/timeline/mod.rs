//! Read the global structural outline independently of resident transcript windows.
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;

const PAGE_ENTRIES: usize = 16_384;
const PAGE_BYTES: usize = 24 * 1024 * 1024;
const INDEX_ENTRIES: usize = 200_000;
const INDEX_BYTES: usize = 32 * 1024 * 1024;
const MAX_SEQ: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    User,
    Assistant,
    System,
    Synthetic,
    Skill,
    Shell,
    Compaction,
    Idle,
    AgentSwitched,
    ModelSwitched,
    LocationSwitched,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub seq: u64,
    #[serde(rename = "type")]
    pub kind: Kind,
    pub tools: u64,
    pub reasoning: u64,
    pub text: Option<u64>,
    pub tool_name: Option<String>,
    pub layout: Option<String>,
    pub omitted: Option<Omitted>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Omitted {
    pub reasoning: u64,
    pub text: u64,
    pub continues: bool,
}

#[derive(Debug)]
pub struct Outline {
    pub entries: Vec<Entry>,
    /// Count at the last page's read transaction, not a guarantee against concurrent deletion.
    pub total: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    after: u64,
    through: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    after: i64,
    through: u64,
    digest: String,
    changed: bool,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum Page {
    Outline {
        entries: Vec<Entry>,
        total: u64,
        #[serde(deserialize_with = "Option::deserialize")]
        cursor: Option<Cursor>,
        checkpoints: Vec<Checkpoint>,
    },
    Blocked {
        reason: Blocked,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocked {
    Unavailable,
    MaintenanceRequired,
    Conflict,
    NotDeletable,
    UnsupportedStorage,
}

impl std::fmt::Display for Blocked {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "outline blocked: {self:?}")
    }
}
impl std::error::Error for Blocked {}

impl Backend {
    /// A cold scan publishes only after the last page. Drop the future to cancel the read.
    pub async fn outline(&self) -> Result<Outline> {
        if !valid_id(&self.workspace) || !valid_id(&self.session) {
            return Err("invalid outline scope".into());
        }
        let url = format!(
            "{}api/workspaces/{}/session-history/outline",
            self.base, self.workspace
        );
        let mut scan = Scan::default();
        loop {
            let body = match scan.cursor {
                None => json!({"sessionID": self.session}),
                Some(cursor) => json!({"sessionID": self.session, "cursor": cursor}),
            };
            let response = self
                .client
                .post(&url)
                .json(&body)
                .send()
                .await?
                .error_for_status()?;
            let page = serde_json::from_value(read_json_limited(response, PAGE_BYTES).await?)?;
            if let Some(total) = scan.accept(page)? {
                return Ok(Outline {
                    entries: scan.entries,
                    total,
                });
            }
        }
    }
}

#[derive(Default)]
struct Scan {
    cursor: Option<Cursor>,
    entries: Vec<Entry>,
    ids: HashSet<String>,
    bytes: usize,
    pages: usize,
}

impl Scan {
    /// None carries the next cursor; Some gives the last transaction's total.
    fn accept(&mut self, page: Page) -> Result<Option<u64>> {
        let (entries, total, next, checkpoints) = match page {
            Page::Outline {
                entries,
                total,
                cursor,
                checkpoints,
            } => (entries, total, cursor, checkpoints),
            Page::Blocked { reason } => return Err(reason.into()),
        };
        self.pages += 1;
        if self.pages > 512
            || entries.len() > PAGE_ENTRIES
            || self.entries.len() + entries.len() > INDEX_ENTRIES
            || total > MAX_SEQ
            || checkpoints.is_empty()
            || checkpoints.len() > 512
        {
            return Err("outline exceeds its bounds".into());
        }
        let start = self.cursor.map_or(-1, |cursor| cursor.after as i64);
        let mut after = start;
        for checkpoint in checkpoints {
            let Checkpoint {
                after: begin,
                through,
                digest,
                changed,
            } = checkpoint;
            if begin != after
                || through > MAX_SEQ
                || through as i64 <= after
                || !changed
                || digest.len() != 64
                || !digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b"abcdef".contains(&b))
            {
                return Err("invalid outline checkpoint".into());
            }
            after = through as i64;
        }
        if next.is_some_and(|cursor| {
            cursor.after as i64 != after
                || cursor.after >= cursor.through
                || cursor.through > MAX_SEQ
        }) || self.cursor.is_some_and(|cursor| {
            next.map_or(after != cursor.through as i64, |next| {
                next.through != cursor.through
            })
        }) {
            return Err("outline cursor changed or did not advance".into());
        }
        let mut seq = start;
        for entry in entries {
            if entry.seq > MAX_SEQ
                || entry.seq as i64 <= seq
                || entry.seq as i64 > after
                || !entry.valid()
                || !self.ids.insert(entry.id.clone())
            {
                return Err("invalid or duplicate outline entry".into());
            }
            self.bytes += std::mem::size_of::<Entry>()
                + 2 * entry.id.len()
                + entry.layout.as_ref().map_or(0, String::len)
                + entry.tool_name.as_ref().map_or(0, String::len);
            if self.bytes > INDEX_BYTES {
                return Err("outline memory budget reached".into());
            }
            seq = entry.seq as i64;
            self.entries.push(entry);
        }
        self.cursor = next;
        Ok(next.is_none().then_some(total))
    }
}

impl Entry {
    fn valid(&self) -> bool {
        let run = |s: &str, limit| s.len() <= limit && s.bytes().all(|b| b"RTX".contains(&b));
        let layout = match self.layout.as_deref().and_then(|s| s.split_once('-')) {
            Some((head, tail)) => {
                self.omitted
                    .as_ref()
                    .is_some_and(|o| o.reasoning <= MAX_SEQ && o.text <= MAX_SEQ)
                    && run(head, 500)
                    && run(tail, 500)
            }
            None => self.omitted.is_none() && self.layout.as_deref().is_none_or(|s| run(s, 1000)),
        };
        valid_id(&self.id)
            && layout
            && self.tools <= MAX_SEQ
            && self.reasoning <= MAX_SEQ
            && self.text.is_none_or(|n| n <= MAX_SEQ)
            && self
                .tool_name
                .as_ref()
                .is_none_or(|s| s.encode_utf16().count() <= 256)
    }
}

#[cfg(test)]
mod tests;
