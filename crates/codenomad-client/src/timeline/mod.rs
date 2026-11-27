//! Read the global structural outline independently of resident transcript windows.
use crate::{
    backend::{Backend, read_json, read_json_limited},
    history::{Result, valid_id},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering::SeqCst},
    },
};

mod anchor;
mod jump;
mod previews;
mod rail;
mod saved;
pub use anchor::AnchorWindow;
pub use jump::{Admission, Jump};
pub(crate) use jump::{JumpOffer, page_offer, until_cancelled};
pub use previews::{Excerpt, PREVIEW_BATCH};
pub use rail::{Marker, MarkerKind, Resident, UnplacedWindow, WindowPosition, project};
use saved::Identity;
pub use saved::{SAVED_BYTES, decode_saved_outlines, encode_saved_outlines};

const PAGE_ENTRIES: usize = 16_384;
const PAGE_BYTES: usize = 24 * 1024 * 1024;
const CACHE_ENTRIES: usize = 200_000;
const CACHE_BYTES: usize = 16 * 1024 * 1024;
const INDEX_BYTES: usize = 128 * 1024 * 1024;
const MAX_SEQ: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Omitted {
    pub reasoning: u64,
    pub text: u64,
    pub continues: bool,
}

#[derive(Debug, Default)]
pub struct Outline {
    pub entries: Vec<Entry>,
    /// Count at the last page's read transaction, not a guarantee against concurrent deletion.
    pub total: u64,
    /// Larger indexes stay in the active view, outside the reusable cache.
    pub cacheable: bool,
    #[doc(hidden)]
    pub saved: Option<saved::Metadata>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    after: i64,
    through: u64,
    digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Checked {
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
        checkpoints: Vec<Checked>,
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

#[derive(Debug)]
pub struct OutlineIdentityChanged;
impl std::fmt::Display for OutlineIdentityChanged {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("outline session identity changed")
    }
}
impl std::error::Error for OutlineIdentityChanged {}

impl Backend {
    /// A cold scan publishes only after the last page. Drop the future to cancel the read.
    pub async fn read_outline(&self, revision: &OutlineRevision) -> Result<Outline> {
        self.read_outline_cached(revision, None, None, |_| ()).await
    }

    pub async fn read_outline_cached(
        &self,
        revision: &OutlineRevision,
        project: Option<&str>,
        saved: Option<Arc<Outline>>,
        show_saved: impl FnOnce(Option<Arc<Outline>>),
    ) -> Result<Outline> {
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
        let (undo, identity) = self.outline_session(project).await?;
        current()?;
        let check_seed = saved.is_some();
        let saved = saved.filter(|seed| {
            seed.saved
                .as_ref()
                .is_some_and(|m| Some(&m.identity) == identity.as_ref())
        });
        if check_seed {
            show_saved(saved.clone());
        }
        let mut scan = Scan::default();
        let mut known = saved
            .as_deref()
            .filter(|seed| seed.has_complete_metadata())
            .and_then(|seed| seed.saved.as_ref())
            .map_or(&[][..], |m| m.checkpoints.as_slice());
        loop {
            current()?;
            let mut body = match scan.cursor {
                None => json!({"sessionID": self.session}),
                Some(cursor) => json!({"sessionID": self.session, "cursor": cursor}),
            };
            if !known.is_empty() {
                body["known"] = json!(known);
            }
            let response = self.client.post(&url).json(&body).send().await?;
            if response.status() == reqwest::StatusCode::BAD_REQUEST && !known.is_empty() {
                known = &[];
                scan = Scan::default();
                continue;
            }
            let response = response.error_for_status()?;
            let page = serde_json::from_value(read_json_limited(response, PAGE_BYTES).await?)?;
            current()?;
            let total = scan.accept_with(page, saved.as_deref().filter(|_| !known.is_empty()))?;
            // Each broker page is stable within its own request. The native undo boundary
            // and the live revision together fence the complete multi-page scan.
            if self.outline_session(project).await? != (undo.clone(), identity.clone()) {
                return Err(OutlineIdentityChanged.into());
            }
            current()?;
            if let Some(total) = total {
                let saved = identity
                    .filter(|_| {
                        scan.cacheable
                            && scan.entries.len() as u64 == total
                            && scan.checkpoints.len() <= 512
                    })
                    .map(|identity| saved::Metadata {
                        identity,
                        checkpoints: scan.checkpoints,
                    });
                return Ok(Outline {
                    cacheable: scan.cacheable,
                    entries: scan.entries,
                    total,
                    saved,
                });
            }
        }
    }

    async fn outline_session(&self, project: Option<&str>) -> Result<(Value, Option<Identity>)> {
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
            return Err(OutlineIdentityChanged.into());
        }
        Ok((
            record["revert"].clone(),
            project.and_then(|root| Identity::from_session(self, root, record)),
        ))
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
    checkpoints: Vec<Checkpoint>,
    source_offset: usize,
}

impl Scan {
    /// None carries the next cursor; Some gives the last transaction's total.
    #[cfg(test)]
    fn accept(&mut self, page: Page) -> Result<Option<u64>> {
        self.accept_with(page, None)
    }

    fn accept_with(&mut self, page: Page, seed: Option<&Outline>) -> Result<Option<u64>> {
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
        let mut delta = entries.into_iter().peekable();
        let mut seq = start;
        for checkpoint in checkpoints {
            let Checked {
                after: begin,
                through,
                digest,
                changed,
            } = checkpoint;
            if begin != after
                || through > MAX_SEQ
                || through as i64 <= after
                || !saved::valid_digest(&digest)
            {
                return Err("invalid outline checkpoint".into());
            }
            let next_checkpoint = Checkpoint {
                after: begin,
                through,
                digest,
            };
            let unchanged = seed
                .and_then(|seed| seed.saved.as_ref().map(|m| (seed, m)))
                .filter(|(_, m)| m.checkpoints.iter().any(|known| *known == next_checkpoint));
            if !changed && unchanged.is_none() {
                return Err("unrecognized outline checkpoint".into());
            }
            if let Some(seed) = seed {
                while let Some(entry) = seed
                    .entries
                    .get(self.source_offset)
                    .filter(|entry| entry.seq <= through)
                {
                    self.source_offset += 1;
                    if !changed && entry.seq as i64 > begin {
                        self.admit(entry.clone(), &mut seq, through)?;
                    }
                }
            }
            while delta.peek().is_some_and(|entry| entry.seq <= through) {
                if !changed {
                    return Err("outline returned entries in an unchanged range".into());
                }
                self.admit(delta.next().unwrap(), &mut seq, through)?;
            }
            if self.checkpoints.len() <= 512 {
                self.checkpoints.push(next_checkpoint);
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
        if delta.next().is_some() {
            return Err("outline entry outside checkpoint coverage".into());
        }
        self.cursor = next;
        self.cacheable &= self.entries.len() <= CACHE_ENTRIES && self.bytes <= CACHE_BYTES;
        Ok(next.is_none().then_some(total))
    }

    fn admit(&mut self, entry: Entry, seq: &mut i64, through: u64) -> Result<()> {
        if entry.seq > through
            || entry.seq as i64 <= *seq
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
        *seq = entry.seq as i64;
        self.entries.push(entry);
        Ok(())
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
pub(crate) mod tests;
