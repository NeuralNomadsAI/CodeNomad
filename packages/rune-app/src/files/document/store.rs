use super::source_text::Snapshot;
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
}
impl Draft {
    pub fn dirty(&self) -> bool {
        self.original
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
    pub(super) fn open(&self, key: &Key) -> Shared {
        lock(&self.0).drafts.get(key).cloned().unwrap_or_default()
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
        } else if drafts.get(key).is_some_and(|old| Arc::ptr_eq(old, shared)) {
            drafts.remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
