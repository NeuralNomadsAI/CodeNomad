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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Read,
    ReadOnly,
    MissingVersion,
    Conflict,
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
    pub original: Option<String>,
    pub text: String,
    pub pending: Option<Pending>,
    pub uncertain: Option<String>,
    pub error: Option<Error>,
    pub revision: u64,
}
impl Draft {
    pub fn dirty(&self) -> bool {
        self.original
            .as_ref()
            .is_some_and(|original| *original != self.text)
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
        lock(&self.0)
            .drafts
            .keys()
            .any(|key| key.instance == tab_key)
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
        let retained = {
            let draft = lock(shared);
            draft.dirty() || draft.pending.is_some() || draft.uncertain.is_some()
        };
        let mut store = lock(&self.0);
        let drafts = &mut store.drafts;
        if retained {
            drafts.insert(key.clone(), shared.clone());
        } else if drafts.get(key).is_some_and(|old| Arc::ptr_eq(old, shared)) {
            drafts.remove(key);
        }
    }
}
