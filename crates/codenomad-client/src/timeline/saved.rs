//! Optional structural cache only; its identity is re-attested before use.
use super::{Backend, CACHE_ENTRIES, Checkpoint, Entry, MAX_SEQ, Outline, valid_id};
use crate::server_path;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::Arc};

pub const SAVED_BYTES: usize = 2 * 1024 * 1024;
const SAVED_OUTLINES: usize = 16;
const FORMAT: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Identity {
    server: String,
    project: String,
    root: String,
    directory: String,
    session: String,
    undo: Option<String>,
}

impl Identity {
    pub(super) fn from_session(backend: &Backend, root: &str, row: &Value) -> Option<Self> {
        let identity = Self {
            server: backend.client.server_identity()?.into(),
            project: row["projectID"].as_str()?.into(),
            root: root.into(),
            directory: row["location"]["directory"].as_str()?.into(),
            session: backend.session.clone(),
            undo: match &row["revert"] {
                Value::Null => None,
                undo => Some(undo["messageID"].as_str()?.into()),
            },
        };
        (identity.valid() && identity.matches(backend, root)).then_some(identity)
    }

    fn valid(&self) -> bool {
        let path = |p: &str| p.len() <= 16 * 1024 && server_path::absolute(p);
        valid_id(&self.server)
            && valid_id(&self.project)
            && valid_id(&self.session)
            && self.undo.as_deref().is_none_or(valid_id)
            && path(&self.root)
            && path(&self.directory)
    }

    fn matches(&self, backend: &Backend, root: &str) -> bool {
        backend.client.server_identity() == Some(self.server.as_str())
            && backend.session == self.session
            && server_path::same(root, &self.root)
            && backend
                .session_directory
                .as_deref()
                .is_some_and(|d| server_path::same(d, &self.directory))
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub(super) identity: Identity,
    pub(super) checkpoints: Vec<Checkpoint>,
}

impl Outline {
    pub fn belongs_to_session(&self, server: &str, session: &str) -> bool {
        self.saved
            .as_ref()
            .is_some_and(|m| m.identity.server == server && m.identity.session == session)
    }

    pub(super) fn has_complete_metadata(&self) -> bool {
        self.entries.iter().all(|entry| {
            (entry.tools == 0 || entry.tool_name.is_some())
                && (entry.kind != super::Kind::Assistant
                    || (entry.text.is_some() && entry.layout.is_some()))
        })
    }

    pub fn saved_weight(&self) -> Option<usize> {
        let meta = self.saved.as_ref()?;
        Some(
            self.entries
                .iter()
                .map(|e| {
                    std::mem::size_of::<Entry>()
                        + e.id.len()
                        + e.layout.as_ref().map_or(0, String::len)
                        + e.tool_name.as_ref().map_or(0, String::len)
                })
                .sum::<usize>()
                + meta.checkpoints.len() * 112,
        )
    }

    pub fn saved_for(&self, backend: &Backend, project: &str) -> bool {
        self.saved
            .as_ref()
            .is_some_and(|m| m.identity.matches(backend, project))
    }

    pub fn same_saved_slot(&self, other: &Self) -> bool {
        self.saved
            .as_ref()
            .zip(other.saved.as_ref())
            .is_some_and(|(a, b)| {
                let (a, b) = (&a.identity, &b.identity);
                a.server == b.server
                    && a.project == b.project
                    && a.root == b.root
                    && a.directory == b.directory
                    && a.session == b.session
            })
    }

    pub fn same_saved_outline(&self, other: &Self) -> bool {
        self.saved
            .as_ref()
            .zip(other.saved.as_ref())
            .is_some_and(|(a, b)| {
                a.identity == b.identity
                    && a.checkpoints == b.checkpoints
                    && self.entries == other.entries
            })
    }
}

pub(super) fn valid_digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || b"abcdef".contains(&b))
}

#[derive(Serialize)]
struct Record<'a> {
    format: u8,
    metadata: &'a Metadata,
    total: u64,
    entries: &'a [Entry],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decoded {
    format: u8,
    metadata: Metadata,
    total: u64,
    entries: Vec<Entry>,
}

impl Decoded {
    fn verify(self) -> Option<Outline> {
        let m = &self.metadata;
        if self.format != FORMAT
            || !m.identity.valid()
            || self.total != self.entries.len() as u64
            || self.entries.len() > CACHE_ENTRIES
            || m.checkpoints.is_empty()
            || m.checkpoints.len() > 512
        {
            return None;
        }
        let mut after = -1;
        for c in &m.checkpoints {
            if c.after != after
                || c.through > MAX_SEQ
                || c.through as i64 <= after
                || !valid_digest(&c.digest)
            {
                return None;
            }
            after = c.through as i64;
        }
        let mut ids = HashSet::new();
        let mut seq = None;
        for entry in &self.entries {
            if entry.seq > after as u64
                || seq.is_some_and(|last| entry.seq <= last)
                || !entry.valid()
                || !ids.insert(&entry.id)
            {
                return None;
            }
            seq = Some(entry.seq);
        }
        Some(Outline {
            entries: self.entries,
            total: self.total,
            cacheable: true,
            saved: Some(self.metadata),
        })
    }
}

pub fn encode_saved_outlines(outlines: &[Arc<Outline>]) -> Vec<u8> {
    let mut out = vec![b'['];
    let mut rows = 0;
    let mut entries = 0;
    for outline in outlines.iter().filter(|o| o.saved.is_some()) {
        if rows == SAVED_OUTLINES {
            break;
        }
        if entries + outline.entries.len() > CACHE_ENTRIES {
            continue;
        }
        let record = Record {
            format: FORMAT,
            metadata: outline.saved.as_ref().unwrap(),
            total: outline.total,
            entries: &outline.entries,
        };
        let Ok(raw) = serde_json::to_string(&record) else {
            continue;
        };
        let digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
        // A string carries the exact hashed bytes and keeps one damaged record independent.
        let row = serde_json::to_vec(&(digest, raw)).expect("strings serialize");
        if out.len() + row.len() + 2 > SAVED_BYTES {
            continue;
        }
        if rows != 0 {
            out.push(b',');
        }
        out.extend(row);
        rows += 1;
        entries += outline.entries.len();
    }
    out.push(b']');
    out
}

pub fn decode_saved_outlines(bytes: &[u8]) -> Vec<Arc<Outline>> {
    if bytes.len() > SAVED_BYTES {
        return Vec::new();
    }
    let Ok(items) = serde_json::from_slice::<Vec<Value>>(bytes) else {
        return Vec::new();
    };
    let mut entries = 0;
    items
        .into_iter()
        .take(SAVED_OUTLINES)
        .filter_map(|row| {
            let (digest, raw): (String, String) = serde_json::from_value(row).ok()?;
            if !valid_digest(&digest) || format!("{:x}", Sha256::digest(raw.as_bytes())) != digest {
                return None;
            }
            let item = serde_json::from_str::<Decoded>(&raw).ok()?.verify()?;
            if entries + item.entries.len() > CACHE_ENTRIES {
                return None;
            }
            entries += item.entries.len();
            Some(Arc::new(item))
        })
        .collect()
}
