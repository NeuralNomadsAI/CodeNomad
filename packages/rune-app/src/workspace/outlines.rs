use crate::{
    State,
    backend::Backend,
    platform::{self, storage::Store},
};
use codenomad_client::{
    Receiver, bounded,
    timeline::{self, Outline},
};
use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
    rc::{Rc, Weak},
    sync::Arc,
};

type Session = (String, String);
struct Entry {
    version: u64,
    outline: Arc<Outline>,
}

#[derive(Default)]
pub(crate) struct Cache {
    entries: Vec<Entry>,
    version: u64,
    started: bool,
    loading: Option<Receiver<Vec<Arc<Outline>>>>,
    saving: Option<Receiver<()>>,
    dirty: bool,
    pending_write_before_freeze: bool,
    unloaded_before_freeze: bool,
    mutations: HashMap<Session, Weak<Cell<u64>>>,
    invalidated_while_loading: HashSet<Session>,
}

impl Cache {
    pub(super) fn poll(&mut self, store: &Store, wake: rune::Waker) {
        if !std::mem::replace(&mut self.started, true) {
            let store = store.clone();
            let (tx, rx) = bounded(1);
            self.loading = Some(rx);
            let wake = wake.clone();
            platform::spawn(async move {
                let entries = store
                    .load_outlines()
                    .await
                    .ok()
                    .flatten()
                    .map_or_else(Vec::new, |bytes| timeline::decode_saved_outlines(&bytes));
                let _ = tx.send(entries).await;
                wake();
            });
        }
        if let Some(rx) = &self.loading {
            let Ok(entries) = rx.try_recv() else { return };
            self.loading = None;
            for entry in entries {
                if self
                    .invalidated_while_loading
                    .iter()
                    .any(|(server, session)| entry.belongs_to_session(server, session))
                {
                    self.dirty = true;
                    continue;
                }
                if !self
                    .entries
                    .iter()
                    .any(|current| current.outline.same_saved_slot(&entry))
                {
                    self.entries.push(Entry {
                        version: 0,
                        outline: entry,
                    });
                }
            }
            self.invalidated_while_loading.clear();
            self.trim();
        }
        if let Some(rx) = &self.saving {
            if rx.try_recv().is_err() {
                return;
            }
            self.saving = None;
        }
        if std::mem::take(&mut self.dirty) {
            let outlines: Vec<Arc<Outline>> = self
                .entries
                .iter()
                .map(|entry| entry.outline.clone())
                .collect();
            let write =
                store.start_save_outlines_with(move || timeline::encode_saved_outlines(&outlines));
            let (tx, rx) = bounded(1);
            self.saving = Some(rx);
            platform::spawn(async move {
                let _ = write.await;
                let _ = tx.send(()).await;
                wake();
            });
        }
    }

    pub(crate) fn version(&self) -> u64 {
        self.version
    }

    pub(crate) fn begin_freeze(&mut self) -> u64 {
        self.pending_write_before_freeze |= self.dirty || self.saving.is_some();
        self.unloaded_before_freeze |= !self.started || self.loading.is_some();
        self.started = true;
        self.loading = None;
        self.saving = None;
        self.dirty = false;
        self.version
    }

    pub(crate) fn restore_after_failed_mutation(&mut self) {
        if std::mem::take(&mut self.unloaded_before_freeze) {
            self.started = false;
        }
        if std::mem::take(&mut self.pending_write_before_freeze) {
            self.dirty = true;
        }
    }

    pub(crate) fn clear_saved(&mut self) {
        self.entries.clear();
        self.pending_write_before_freeze = false;
        self.unloaded_before_freeze = false;
        self.started = true;
        self.loading = None;
        self.saving = None;
        self.dirty = false;
        self.invalidated_while_loading.clear();
    }

    pub(crate) fn clear_saved_before(&mut self, baseline: u64) {
        self.pending_write_before_freeze = false;
        self.unloaded_before_freeze = false;
        self.entries.retain(|entry| entry.version > baseline);
        self.started = true;
        self.loading = None;
        self.saving = None;
        self.invalidated_while_loading.clear();
        self.dirty = self.version > baseline;
    }

    pub(crate) fn mark_dirty_if_nonempty(&mut self) {
        self.pending_write_before_freeze = false;
        self.unloaded_before_freeze = false;
        self.started = true;
        self.loading = None;
        self.saving = None;
        self.invalidated_while_loading.clear();
        if !self.entries.is_empty() {
            self.dirty = true;
        }
    }

    pub(crate) fn mutation(&mut self, backend: &Backend) -> Option<Rc<Cell<u64>>> {
        let key = session(backend)?;
        if let Some(clock) = self.mutations.get(&key).and_then(Weak::upgrade) {
            return Some(clock);
        }
        self.mutations.retain(|_, clock| clock.strong_count() > 0);
        let clock = Rc::new(Cell::new(0));
        self.mutations.insert(key, Rc::downgrade(&clock));
        Some(clock)
    }

    fn invalidate(&mut self, backend: &Backend) {
        let Some(key) = session(backend) else { return };
        if let Some(clock) = self.mutation(backend) {
            clock.set(clock.get().wrapping_add(1));
        }
        let before = self.entries.len();
        self.entries
            .retain(|entry| !entry.outline.belongs_to_session(&key.0, &key.1));
        if before != self.entries.len() {
            self.version = self.version.wrapping_add(1);
            self.dirty = true;
        }
        if !self.started || self.loading.is_some() || self.unloaded_before_freeze {
            self.invalidated_while_loading.insert(key);
        }
    }

    pub(crate) fn retained_bytes(&self, seen_outlines: &mut HashSet<usize>) -> usize {
        self.entries.iter().fold(0usize, |total, entry| {
            if seen_outlines.insert(Arc::as_ptr(&entry.outline) as usize) {
                total.saturating_add(crate::timeline::outline_weight(&entry.outline))
            } else {
                total
            }
        })
    }

    #[cfg(test)]
    pub(crate) fn fixture_insert(&mut self, outline: Arc<Outline>) {
        self.entries.push(Entry {
            version: 0,
            outline,
        });
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn evict_under_pressure(
        &mut self,
        bytes_to_free: usize,
        active_backend: Option<&Backend>,
        active_project: Option<&str>,
    ) -> usize {
        if bytes_to_free == 0
            || self.dirty
            || self.saving.is_some()
            || self.pending_write_before_freeze
            || self.entries.is_empty()
        {
            return 0;
        }
        let mut freed = 0usize;
        let mut index = self.entries.len();
        while index > 0 && freed < bytes_to_free {
            index -= 1;
            let is_active = active_backend
                .zip(active_project)
                .is_some_and(|(backend, project)| {
                    self.entries[index].outline.saved_for(backend, project)
                });
            if !is_active {
                let removed = self.entries.remove(index).outline;
                // Count freed bytes only when no inactive Timeline still holds a strong Arc clone.
                if Arc::strong_count(&removed) == 1 {
                    freed = freed.saturating_add(crate::timeline::outline_weight(&removed));
                }
            }
        }
        freed
    }

    fn trim(&mut self) {
        let mut bytes = 0;
        #[cfg(target_arch = "wasm32")]
        const MAX_OUTLINE_BYTES: usize = 4 * 1024 * 1024;
        #[cfg(not(target_arch = "wasm32"))]
        const MAX_OUTLINE_BYTES: usize = 16 * 1024 * 1024;
        let keep = self
            .entries
            .iter()
            .take(16)
            .take_while(|entry| {
                bytes += entry.outline.saved_weight().unwrap_or_default();
                bytes <= MAX_OUTLINE_BYTES
            })
            .count();
        self.entries.drain(keep..);
    }
}

fn session(backend: &Backend) -> Option<Session> {
    Some((
        backend.client.server_identity()?.to_owned(),
        backend.session.clone(),
    ))
}

pub(crate) fn seed(s: &State, backend: &Backend, project: &str) -> Option<Arc<Outline>> {
    s.saved_outlines
        .entries
        .iter()
        .find(|entry| entry.outline.saved_for(backend, project))
        .map(|entry| entry.outline.clone())
}

pub(crate) fn remember(s: &mut State, outline: Arc<Outline>) {
    let cache = &mut s.saved_outlines;
    if outline.saved_weight().is_none()
        || cache
            .entries
            .iter()
            .any(|o| o.outline.same_saved_outline(&outline))
    {
        return;
    }
    cache
        .entries
        .retain(|old| !old.outline.same_saved_slot(&outline));
    cache.version = cache.version.wrapping_add(1);
    let version = cache.version;
    cache.entries.insert(0, Entry { version, outline });
    cache.trim();
    cache.dirty = true;
    (s.wake)();
}

pub(crate) fn invalidate(s: &mut State, backend: &Backend) {
    s.saved_outlines.invalidate(backend);
    (s.wake)();
}
