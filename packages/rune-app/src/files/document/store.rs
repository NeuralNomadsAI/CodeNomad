use super::editor::SavedPosition;
use super::source_text::Snapshot;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard, Weak},
};

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct Key {
    pub server: String,
    pub instance: String,
    pub native_project: Option<String>,
    pub directory: String,
    pub path: String,
}
const LIMIT: usize = 256 * 1024;
const COUNT: usize = 32;

#[derive(Clone, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct SavedKey {
    pub server: String,
    pub project: String,
    pub native_project: Option<String>,
    pub directory: String,
    pub path: String,
}
impl SavedKey {
    fn valid(&self) -> bool {
        [&self.server, &self.project, &self.directory, &self.path]
            .into_iter()
            .all(|part| !part.is_empty() && part.len() <= 16 * 1024)
            && self
                .native_project
                .as_ref()
                .is_none_or(|id| !id.is_empty() && id.len() <= 1024)
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Saved {
    key: SavedKey,
    version: Option<String>,
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
            self.text,
            key.native_project
        ])
    }
    fn decode(row: &Value) -> Option<Self> {
        let row = row.as_array()?;
        if row.len() != 7 {
            return None;
        }
        let field = |index: usize| row.get(index)?.as_str().map(str::to_owned);
        let key = SavedKey {
            server: field(0)?,
            project: field(1)?,
            native_project: match row.get(6)? {
                Value::Null => None,
                value => Some(value.as_str()?.into()),
            },
            directory: field(2)?,
            path: field(3)?,
        };
        key.valid().then_some(())?;
        Some(Self {
            key,
            version: match row.get(4)? {
                Value::Null => None,
                value => Some(version(Some(value.as_str()?))?),
            },
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
    owns_saved: bool,
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
    read_blocked: bool,
    positions: VecDeque<(Key, SavedPosition)>,
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
    pub(super) fn source_position(&self, key: &Key) -> Option<SavedPosition> {
        lock(&self.0)
            .positions
            .iter()
            .find(|(saved, _)| saved == key)
            .map(|(_, position)| *position)
    }

    pub(super) fn remember_position(&self, key: Key, position: SavedPosition) {
        let mut store = lock(&self.0);
        store.positions.retain(|(saved, _)| saved != &key);
        store.positions.push_front((key, position));
        if store.positions.len() > 5 {
            store.positions.pop_back();
        }
    }
    pub(crate) fn block_file_draft_updates(&self, blocked: bool) {
        let pending = {
            let mut store = lock(&self.0);
            let was_blocked = store.read_blocked;
            store.read_blocked = blocked;
            if blocked || !was_blocked {
                return;
            }
            store.live.retain(|_, pointer| pointer.strong_count() > 0);
            let mut pending: Vec<(SavedKey, Shared)> = store
                .live
                .iter()
                .filter(|(key, _)| !store.saved.iter().any(|row| &row.key == *key))
                .filter_map(|(key, pointer)| pointer.upgrade().map(|shared| (key.clone(), shared)))
                .collect();
            pending.sort_by(|a, b| a.0.cmp(&b.0));
            pending
        };
        for (saved_key, shared) in pending {
            self.sync_saved_entry(&saved_key, &shared);
        }
    }
    #[cfg(test)]
    pub(crate) fn file_draft_updates_blocked(&self) -> bool {
        lock(&self.0).read_blocked
    }

    pub(crate) fn has_tab_edits(&self, tab_key: &str) -> bool {
        self.has_matching_edits(|key| key.instance == tab_key)
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        let (drafts, saved_bytes) = {
            let store = lock(&self.0);
            let saved = store.saved.iter().fold(0usize, |total, row| {
                total
                    .saturating_add(row.text.len())
                    .saturating_add(row.key.path.len())
                    .saturating_add(row.key.directory.len())
            });
            (store.drafts.values().cloned().collect::<Vec<_>>(), saved)
        };
        let mut seen = std::collections::HashSet::new();
        let mut total = saved_bytes;
        for shared in drafts {
            if !seen.insert(Arc::as_ptr(&shared)) {
                continue;
            }
            let draft = lock(&shared);
            total = total
                .saturating_add(draft.text.len())
                .saturating_add(draft.original.as_ref().map_or(0, |snap| snap.text.len()))
                .saturating_add(draft.uncertain.as_ref().map_or(0, |snap| snap.text.len()));
        }
        total
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
                    version: row.version.clone(),
                    recovered: true,
                    owns_saved: true,
                    ..Draft::default()
                }))
            })
            .unwrap_or_default();
        store
            .live
            .insert(saved_key.clone(), Arc::downgrade(&shared));
        shared
    }
    pub(crate) fn hydrate_file_drafts(&self, bytes: &[u8]) -> bool {
        if bytes.len() > LIMIT {
            return false;
        }
        let Ok(rows) = serde_json::from_slice::<Vec<Value>>(bytes) else {
            return false;
        };
        if rows.len() > COUNT {
            return false;
        }
        let mut saved: Vec<Saved> = Vec::new();
        for row in rows {
            let Some(row) = Saved::decode(&row) else {
                return false;
            };
            if saved.iter().any(|old| old.key == row.key) {
                return false;
            }
            saved.push(row);
        }
        let mut store = lock(&self.0);
        saved.retain(|row| !store.saved.iter().any(|local| local.key == row.key));
        saved.extend(store.saved.iter().cloned());
        if saved.len() > COUNT || Self::encode(&saved).len() > LIMIT {
            return false;
        }
        // A clean reader opened while storage was unavailable never saw imported rows.
        let imported: Vec<_> = saved
            .iter()
            .filter(|row| !store.saved.iter().any(|local| local.key == row.key))
            .map(|row| row.key.clone())
            .collect();
        for key in imported {
            store.live.remove(&key);
        }
        store.saved = saved;
        true
    }
    pub(crate) fn file_draft_revision(&self) -> u64 {
        lock(&self.0).revision
    }
    pub(crate) fn mark_file_drafts_dirty_if_nonempty(&self) {
        let mut store = lock(&self.0);
        if !store.saved.is_empty() {
            store.revision = store.revision.wrapping_add(1);
        }
    }
    pub(crate) fn has_saved_file_drafts(&self) -> bool {
        !lock(&self.0).saved.is_empty()
    }
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn live_file_draft_bytes(&self) -> Option<Vec<u8>> {
        let live: Vec<(SavedKey, Shared)> = {
            let store = lock(&self.0);
            store
                .live
                .iter()
                .filter_map(|(key, pointer)| pointer.upgrade().map(|shared| (key.clone(), shared)))
                .collect()
        };
        let active: std::collections::HashSet<SavedKey> = live
            .into_iter()
            .filter_map(|(key, shared)| {
                let draft = lock(&shared);
                (draft.owns_saved && draft.retained()).then_some(key)
            })
            .collect();
        let store = lock(&self.0);
        let rows: Vec<Saved> = store
            .saved
            .iter()
            .filter(|row| active.contains(&row.key))
            .cloned()
            .collect();
        (!rows.is_empty()).then(|| Self::encode(&rows))
    }
    pub(crate) fn discard_unopened_saved_drafts(&self) {
        let live: Vec<(SavedKey, Shared)> = {
            let mut store = lock(&self.0);
            store.live.retain(|_, pointer| pointer.strong_count() > 0);
            store
                .live
                .iter()
                .filter_map(|(key, pointer)| pointer.upgrade().map(|shared| (key.clone(), shared)))
                .collect()
        };
        let active: std::collections::HashSet<SavedKey> = live
            .into_iter()
            .filter_map(|(key, shared)| {
                let draft = lock(&shared);
                (draft.owns_saved && draft.retained()).then_some(key)
            })
            .collect();
        let mut store = lock(&self.0);
        store.saved.retain(|row| active.contains(&row.key));
    }
    pub(crate) fn file_draft_snapshot(&self, saved_revision: u64) -> Option<(u64, Vec<u8>)> {
        let store = lock(&self.0);
        (saved_revision != store.revision).then(|| (store.revision, Self::encode(&store.saved)))
    }
    #[cfg(test)]
    pub(crate) fn insert_test_file_draft(&self, path: &str, text: &str) {
        let key = Key {
            server: "transport".into(),
            instance: "tab-0".into(),
            native_project: None,
            directory: "/project".into(),
            path: path.into(),
        };
        let scope = SavedKey {
            server: "installation".into(),
            project: "/project".into(),
            native_project: None,
            directory: key.directory.clone(),
            path: key.path.clone(),
        };
        let shared = self.open_saved(&key, Some(&scope));
        {
            let mut draft = lock(&shared);
            draft.original = Some(Snapshot::loaded("original"));
            draft.text = text.into();
        }
        self.sync_saved(&key, Some(&scope), &shared);
    }
    pub(crate) fn has_unretained_file_drafts(&self) -> bool {
        let drafts: Vec<_> = lock(&self.0).drafts.values().cloned().collect();
        drafts.iter().any(|draft| lock(draft).not_retained)
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn closing_drafts(&self, include_saved: bool) -> Vec<(String, String)> {
        let retained = lock(&self.0).drafts.clone();
        let mut seen = std::collections::HashSet::new();
        let mut warning = Vec::new();
        for (key, shared) in retained {
            if !seen.insert(Arc::as_ptr(&shared)) {
                continue;
            }
            let draft = lock(&shared);
            if draft.dirty() && (include_saved || draft.not_retained) {
                warning.push((
                    format!("{} · {}", key.directory, key.path),
                    draft.text.clone(),
                ));
            }
        }
        warning.sort_by(|a, b| a.0.cmp(&b.0));
        warning
    }
    fn encode(rows: &[Saved]) -> Vec<u8> {
        Value::Array(rows.iter().map(Saved::value).collect())
            .to_string()
            .into_bytes()
    }
    pub(super) fn sync_saved(&self, key: &Key, saved_key: Option<&SavedKey>, shared: &Shared) {
        self.sync(key, shared);
        let Some(saved_key) = saved_key else { return };
        self.sync_saved_entry(saved_key, shared);
    }
    fn sync_saved_entry(&self, saved_key: &SavedKey, shared: &Shared) {
        let mut draft = lock(shared);
        let mut store = lock(&self.0);
        if store.read_blocked {
            draft.not_retained = draft.dirty();
            return;
        }
        let previous = store.saved.iter().position(|row| &row.key == saved_key);
        if !draft.retained() {
            if let Some(previous) = previous.filter(|_| draft.owns_saved) {
                store.saved.remove(previous);
                store.revision += 1;
            }
            draft.owns_saved = false;
            draft.not_retained = false;
            return;
        }
        if previous.is_some() && !draft.owns_saved {
            draft.not_retained = true;
            return;
        }
        if draft.text.len() > LIMIT || !saved_key.valid() {
            draft.not_retained = true;
            return;
        }
        let row = Saved {
            key: saved_key.clone(),
            version: draft.version.clone(),
            text: draft.text.clone(),
        };
        if previous.is_some_and(|index| store.saved[index] == row) {
            draft.not_retained = false;
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
            draft.owns_saved = true;
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
    fn source_positions_are_bounded_and_belong_to_one_occurrence_and_checkout() {
        let store = Store::default();
        let key = Key {
            server: "transport".into(),
            instance: "tab-a".into(),
            native_project: None,
            directory: "/project".into(),
            path: "file".into(),
        };
        for index in 0..6 {
            store.remember_position(
                Key {
                    path: format!("file-{index}"),
                    ..key.clone()
                },
                SavedPosition::default(),
            );
        }
        assert!(
            store
                .source_position(&Key {
                    path: "file-0".into(),
                    ..key.clone()
                })
                .is_none()
        );
        let recent = Key {
            path: "file-1".into(),
            ..key
        };
        assert!(
            store
                .source_position(&Key {
                    instance: "tab-b".into(),
                    ..recent.clone()
                })
                .is_none()
        );
        assert!(
            store
                .source_position(&Key {
                    directory: "/other".into(),
                    ..recent.clone()
                })
                .is_none()
        );
        assert!(store.source_position(&recent).is_some());
    }

    #[test]
    fn retry_keeps_unseen_saved_text_when_the_open_reader_is_clean_or_edited() {
        let key = Key {
            server: "transport".into(),
            instance: "tab".into(),
            native_project: None,
            directory: "/project".into(),
            path: "file".into(),
        };
        let scope = SavedKey {
            server: "installation".into(),
            project: "/project".into(),
            native_project: None,
            directory: key.directory.clone(),
            path: key.path.clone(),
        };
        let bytes = Store::encode(&[Saved {
            key: scope.clone(),
            version: None,
            text: "unseen saved draft".into(),
        }]);
        for text in ["disk", "new live edit"] {
            let store = Store::default();
            store.block_file_draft_updates(true);
            let opened = store.open_saved(&key, Some(&scope));
            {
                let mut draft = lock(&opened);
                draft.original = Some(Snapshot::loaded("disk"));
                draft.text = text.into();
            }
            store.sync_saved(&key, Some(&scope), &opened);
            assert!(store.file_draft_snapshot(0).is_none());

            assert!(store.hydrate_file_drafts(&bytes));
            store.block_file_draft_updates(false);
            store.sync_saved(&key, Some(&scope), &opened);
            assert!(store.file_draft_snapshot(0).is_none());
            assert_eq!(lock(&opened).not_retained, text != "disk");
            assert_eq!(lock(&opened).text, text);
            let mut other = key.clone();
            other.instance = "reopened-tab".into();
            let reopened = store.open_saved(&other, Some(&scope));
            assert_eq!(lock(&reopened).text, "unseen saved draft");
        }
    }

    #[test]
    fn saved_drafts_are_bounded_and_isolated_across_a_new_store() {
        let store = Store::default();
        let key = Key {
            server: "ephemeral".into(),
            instance: "tab".into(),
            native_project: None,
            directory: "/link".into(),
            path: "file".into(),
        };
        let scope = SavedKey {
            server: "installation".into(),
            project: "/root".into(),
            native_project: Some("project-a".into()),
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
        assert_eq!(store.closing_drafts(false)[0].1, "\u{0}".repeat(60_000));
        let reopened = Store::default();
        assert!(reopened.hydrate_file_drafts(&bytes));
        assert!(!reopened.hydrate_file_drafts(b"invalid sidecar"));
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
                native_project: Some("project-b".into()),
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
    fn unblocking_file_drafts_promotes_unconflicted_live_edits() {
        let store = Store::default();
        let key = Key {
            server: "transport".into(),
            instance: "tab".into(),
            native_project: None,
            directory: "/project".into(),
            path: "edited-while-blocked.rs".into(),
        };
        let scope = SavedKey {
            server: "installation".into(),
            project: "/project".into(),
            native_project: None,
            directory: key.directory.clone(),
            path: key.path.clone(),
        };
        store.block_file_draft_updates(true);
        let opened = store.open_saved(&key, Some(&scope));
        {
            let mut draft = lock(&opened);
            draft.original = Some(Snapshot::loaded("disk"));
            draft.text = "live edit before retry".into();
        }
        store.sync_saved(&key, Some(&scope), &opened);
        assert!(lock(&opened).not_retained);
        assert!(store.file_draft_snapshot(0).is_none());

        assert!(store.hydrate_file_drafts(b"[]"));
        store.block_file_draft_updates(false);
        assert!(!lock(&opened).not_retained);
        let (revision, bytes) = store.file_draft_snapshot(0).unwrap();
        assert_eq!(revision, 1);
        let reopened = Store::default();
        assert!(reopened.hydrate_file_drafts(&bytes));
        assert_eq!(
            lock(&reopened.open_saved(&key, Some(&scope))).text,
            "live edit before retry"
        );
    }

    #[test]
    fn a_tab_guard_reads_retained_drafts_without_a_reader() {
        let store = Store::default();
        let key = Key {
            server: "one".into(),
            instance: "tab-2".into(),
            native_project: None,
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
