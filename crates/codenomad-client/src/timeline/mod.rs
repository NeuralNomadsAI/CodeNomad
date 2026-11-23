//! Read the global structural outline independently of resident transcript windows.
use crate::{
    backend::{Backend, read_json, read_json_limited},
    history::{Result, valid_id},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::atomic::{AtomicU64, Ordering::SeqCst},
};

mod anchor;
mod rail;
pub use anchor::AnchorWindow;
pub use rail::{Marker, MarkerKind, Resident, UnplacedWindow, WindowPosition, project};

const PAGE_ENTRIES: usize = 16_384;
const PAGE_BYTES: usize = 24 * 1024 * 1024;
const CACHE_ENTRIES: usize = 200_000;
const CACHE_BYTES: usize = 16 * 1024 * 1024;
const INDEX_BYTES: usize = 128 * 1024 * 1024;
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
    /// Larger indexes stay in the active view, outside the reusable cache.
    pub cacheable: bool,
}

/// The view invalidates this revision on undo and on revocation of its history read.
#[derive(Default)]
pub struct OutlineRevision(AtomicU64);

impl OutlineRevision {
    pub fn invalidate(&self) {
        self.0.fetch_add(1, SeqCst);
    }
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
    pub async fn read_outline(&self, revision: &OutlineRevision) -> Result<Outline> {
        if !valid_id(&self.workspace) || !valid_id(&self.session) {
            return Err("invalid outline scope".into());
        }
        let url = format!(
            "{}api/workspaces/{}/session-history/outline",
            self.base, self.workspace
        );
        let stamp = revision.0.load(SeqCst);
        let current = || {
            (revision.0.load(SeqCst) == stamp)
                .then_some(())
                .ok_or(Blocked::Conflict)
        };
        let undo = self.outline_undo().await?;
        let mut scan = Scan::default();
        loop {
            current()?;
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
            current()?;
            let total = scan.accept(page)?;
            // Each broker page is stable within its own request. The native undo boundary
            // and the live revision together fence the complete multi-page scan.
            if self.outline_undo().await? != undo {
                return Err(Blocked::Conflict.into());
            }
            current()?;
            if let Some(total) = total {
                return Ok(Outline {
                    cacheable: scan.cacheable,
                    entries: scan.entries,
                    total,
                });
            }
        }
    }

    async fn outline_undo(&self) -> Result<Value> {
        let value = read_json(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{}",
                    self.base, self.workspace, self.session
                ))
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        let record = value.get("data").unwrap_or(&value);
        if record["id"] != self.session {
            return Err("outline session identity changed".into());
        }
        Ok(record["revert"].clone())
    }
}

#[derive(Default)]
struct Scan {
    cursor: Option<Cursor>,
    entries: Vec<Entry>,
    ids: HashSet<String>,
    bytes: usize,
    pages: usize,
    cacheable: bool,
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
        if self.pages == 0 {
            if total > (INDEX_BYTES / std::mem::size_of::<Entry>()) as u64 {
                return Err("outline cannot fit in its active index budget".into());
            }
            self.cacheable = total <= CACHE_ENTRIES as u64;
        }
        self.pages += 1;
        if self.pages > 512
            || entries.len() > PAGE_ENTRIES
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
        self.cacheable &= self.entries.len() <= CACHE_ENTRIES && self.bytes <= CACHE_BYTES;
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
