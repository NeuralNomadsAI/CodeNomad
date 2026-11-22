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
    pub(super) fn has_edits(&self, server: &str, instance: &str) -> bool {
        lock(&self.0).drafts.iter().any(|(key, draft)| {
            key.server == server && key.instance == instance && lock(draft).retained()
        })
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
        let retained = lock(shared).retained();
        let mut store = lock(&self.0);
        let drafts = &mut store.drafts;
        if retained {
            drafts.insert(key.clone(), shared.clone());
        } else if drafts.get(key).is_some_and(|old| Arc::ptr_eq(old, shared)) {
            drafts.remove(key);
        }
    }
}
