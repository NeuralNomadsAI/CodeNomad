use super::source_text::Snapshot;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, Weak},
};

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct Key {
    pub server: String,
    pub instance: String,
    pub directory: String,
    pub path: String,
}
const LIMIT: usize = 256 * 1024;
const COUNT: usize = 32;

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub(super) struct SavedKey {
    pub server: String,
    pub project: String,
    pub directory: String,
    pub path: String,
}

#[derive(Clone, PartialEq, Eq)]
struct Saved {
    key: SavedKey,
    version: String,
    text: String,
}
impl Saved {
    fn value(&self) -> Value {
        let key = &self.key;
        json!([
            key.server,
            key.project,
            key.directory,
            key.path,
            self.version,
            self.text
        ])
    }
    fn decode(row: &Value) -> Option<Self> {
        let row = row.as_array()?;
        if row.len() != 6 {
            return None;
        }
        let field = |index: usize| -> Option<String> {
            let text = row.get(index)?.as_str()?;
            (!text.is_empty() && text.len() <= 16 * 1024).then(|| text.into())
        };
        Some(Self {
            key: SavedKey {
                server: field(0)?,
                project: field(1)?,
                directory: field(2)?,
                path: field(3)?,
            },
            version: version(Some(row.get(4)?.as_str()?))?,
            text: row.get(5)?.as_str()?.into(),
        })
    }
}

// The Rust Files endpoint returns the SHA-256 of the exact original bytes as an ETag.
pub(super) fn version(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let hash = raw.strip_prefix('"')?.strip_suffix('"')?;
    (hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then(|| raw.into())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Read,
    ReadOnly,
    MissingVersion,
    Conflict(Option<String>),
    Uncertain,
    TooLarge,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Pending {
    Check(u64),
    Write(u64),
}
#[derive(Default)]
pub(super) struct Draft {
    pub original: Option<Snapshot>,
    pub text: String,
    pub pending: Option<Pending>,
    pub uncertain: Option<Snapshot>,
    pub error: Option<Error>,
    pub revision: u64,
    pub version: Option<String>,
    pub recovered: bool,
    pub not_retained: bool,
}
impl Draft {
    pub fn dirty(&self) -> bool {
        self.recovered
            || self
                .original
                .as_ref()
                .is_some_and(|original| original.text != self.text)
    }
    fn retained(&self) -> bool {
        self.dirty() || self.pending.is_some() || self.uncertain.is_some()
    }
}
pub(super) type Shared = Arc<Mutex<Draft>>;
pub(super) type Writes = Arc<Mutex<u64>>;
#[derive(Default)]
struct Stored {
    drafts: HashMap<Key, Shared>,
    sequence: u64,
    writes: HashMap<(String, String), Weak<Mutex<u64>>>,
    saved: Vec<Saved>,
    live: HashMap<SavedKey, Weak<Mutex<Draft>>>,
    revision: u64,
}
#[derive(Clone, Default)]
pub struct Store(Arc<Mutex<Stored>>);
pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}
impl Store {
    pub(crate) fn has_tab_edits(&self, tab_key: &str) -> bool {
        self.has_matching_edits(|key| key.instance == tab_key)
    }

    pub(super) fn has_edits(&self, server: &str, instance: &str) -> bool {
        self.has_matching_edits(|key| key.server == server && key.instance == instance)
    }

    fn has_matching_edits(&self, accepts: impl Fn(&Key) -> bool) -> bool {
        // Never hold the registry lock while waiting for a draft.
        let drafts: Vec<_> = lock(&self.0)
            .drafts
            .iter()
            .filter(|(key, _)| accepts(key))
            .map(|(_, draft)| draft.clone())
            .collect();
        drafts.iter().any(|draft| lock(draft).retained())
    }
    pub(super) fn writes(&self, server: &str, instance: &str) -> Writes {
        let mut store = lock(&self.0);
        store.writes.retain(|_, writes| writes.strong_count() > 0);
        let slot = store
            .writes
            .entry((server.into(), instance.into()))
            .or_default();
        if let Some(writes) = slot.upgrade() {
            return writes;
        }
        let writes = Writes::default();
        *slot = Arc::downgrade(&writes);
        writes
    }
    #[cfg(test)]
    pub(super) fn open(&self, key: &Key) -> Shared {
        lock(&self.0).drafts.get(key).cloned().unwrap_or_default()
    }
    pub(super) fn open_saved(&self, key: &Key, saved_key: Option<&SavedKey>) -> Shared {
        let mut store = lock(&self.0);
        if let Some(shared) = store.drafts.get(key) {
            return shared.clone();
        }
        let Some(saved_key) = saved_key else {
            return Shared::default();
        };
        store.live.retain(|_, pointer| pointer.strong_count() > 0);
        if let Some(shared) = store.live.get(saved_key).and_then(Weak::upgrade) {
            return shared;
        }
        let shared = store
            .saved
            .iter()
            .find(|row| &row.key == saved_key)
            .map(|row| {
                Arc::new(Mutex::new(Draft {
                    text: row.text.clone(),
                    version: Some(row.version.clone()),
                    recovered: true,
                    ..Draft::default()
                }))
            })
            .unwrap_or_default();
        store
            .live
            .insert(saved_key.clone(), Arc::downgrade(&shared));
        shared
    }
    pub(crate) fn hydrate_file_drafts(&self, bytes: &[u8]) {
        if bytes.len() > LIMIT {
            return;
        }
        let Ok(rows) = serde_json::from_slice::<Vec<Value>>(bytes) else {
            return;
        };
        let mut store = lock(&self.0);
        for row in rows
            .into_iter()
            .take(COUNT)
            .filter_map(|row| Saved::decode(&row))
        {
            if !store.saved.iter().any(|old| old.key == row.key) {
                store.saved.push(row);
            }
        }
    }
    pub(crate) fn file_draft_snapshot(&self, saved_revision: u64) -> Option<(u64, Vec<u8>)> {
        let store = lock(&self.0);
        (saved_revision != store.revision).then(|| (store.revision, Self::encode(&store.saved)))
    }
    fn encode(rows: &[Saved]) -> Vec<u8> {
        Value::Array(rows.iter().map(Saved::value).collect())
            .to_string()
            .into_bytes()
    }
    pub(super) fn sync_saved(&self, key: &Key, saved_key: Option<&SavedKey>, shared: &Shared) {
        self.sync(key, shared);
        let mut draft = lock(shared);
        let Some(saved_key) = saved_key else { return };
        let mut store = lock(&self.0);
        let previous = store.saved.iter().position(|row| &row.key == saved_key);
        if !draft.retained() {
            if let Some(previous) = previous {
                store.saved.remove(previous);
                store.revision += 1;
            }
            draft.not_retained = false;
            return;
        }
        let Some(version) = &draft.version else {
            draft.not_retained = true;
            return;
        };
        let row = Saved {
            key: saved_key.clone(),
            version: version.clone(),
            text: draft.text.clone(),
        };
        if previous.is_some_and(|index| store.saved[index] == row) {
            draft.not_retained = false;
            return;
        }
        if row.text.len() > LIMIT {
            draft.not_retained = true;
            return;
        }
        let mut next = store.saved.clone();
        if let Some(index) = previous {
            next[index] = row;
        } else {
            next.push(row);
        }
        draft.not_retained = next.len() > COUNT || Self::encode(&next).len() > LIMIT;
        if !draft.not_retained {
            store.saved = next;
            store.revision += 1;
        }
    }
    pub(super) fn next(&self) -> u64 {
        let mut store = lock(&self.0);
        store.sequence += 1;
        store.sequence
    }
    pub(super) fn sync(&self, key: &Key, shared: &Shared) {
        // Document operations take the draft lock before the store lock.
        let draft = lock(shared);
        let mut store = lock(&self.0);
        let drafts = &mut store.drafts;
        if draft.retained() {
            drafts.insert(key.clone(), shared.clone());
        } else {
            drafts.retain(|_, old| !Arc::ptr_eq(old, shared));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_drafts_are_bounded_and_isolated_across_a_new_store() {
        let store = Store::default();
        let key = Key {
            server: "ephemeral".into(),
            instance: "tab".into(),
            directory: "/link".into(),
            path: "file".into(),
        };
        let scope = SavedKey {
            server: "installation".into(),
            project: "/root".into(),
            directory: key.directory.clone(),
            path: key.path.clone(),
        };
        let draft = store.open_saved(&key, Some(&scope));
        {
            let mut draft = lock(&draft);
            draft.original = Some(Snapshot::loaded("original"));
            draft.version = Some(format!("\"{}\"", "a".repeat(64)));
            draft.text = "édité".into();
        }
        store.sync_saved(&key, Some(&scope), &draft);
        let (revision, bytes) = store.file_draft_snapshot(0).unwrap();
        lock(&draft).text = "\u{0}".repeat(60_000);
        store.sync_saved(&key, Some(&scope), &draft);
        assert!(lock(&draft).not_retained);
        assert!(store.file_draft_snapshot(revision).is_none());
        let reopened = Store::default();
        reopened.hydrate_file_drafts(&bytes);
        let shared = reopened.open_saved(&key, Some(&scope));
        assert!(lock(&shared).recovered);
        assert_eq!(lock(&shared).text, "édité");
        for other in [
            SavedKey {
                directory: "/root".into(),
                ..scope.clone()
            },
            SavedKey {
                project: "/unrelated".into(),
                ..scope.clone()
            },
            SavedKey {
                server: "other".into(),
                ..scope.clone()
            },
            SavedKey {
                path: "File".into(),
                ..scope.clone()
            },
        ] {
            assert!(!lock(&reopened.open_saved(&key, Some(&other))).dirty());
        }
    }

    #[test]
    fn a_tab_guard_reads_retained_drafts_without_a_reader() {
        let store = Store::default();
        let key = Key {
            server: "one".into(),
            instance: "tab-2".into(),
            directory: "/project".into(),
            path: "main.rs".into(),
        };
        let shared = store.open(&key);
        {
            let mut draft = lock(&shared);
            draft.original = Some(Snapshot::loaded("original"));
            draft.text = "local edit".into();
        }
        store.sync(&key, &shared);
        assert!(!store.has_tab_edits("tab-1"));
        assert!(store.has_tab_edits("tab-2"));
        lock(&shared).text = "original".into();
        store.sync(&key, &shared);
        assert!(!store.has_tab_edits("tab-2"));
    }
}
