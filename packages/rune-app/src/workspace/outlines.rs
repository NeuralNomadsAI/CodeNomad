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
#[derive(Default)]
pub(crate) struct Cache {
    entries: Vec<Arc<Outline>>,
    started: bool,
    loading: Option<Receiver<Vec<Arc<Outline>>>>,
    saving: Option<Receiver<()>>,
    dirty: bool,
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
                    .any(|current| current.same_saved_slot(&entry))
                {
                    self.entries.push(entry);
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
            let store = store.clone();
            let entries = self.entries.clone();
            let (tx, rx) = bounded(1);
            self.saving = Some(rx);
            platform::spawn(async move {
                let _ = store
                    .save_outlines(timeline::encode_saved_outlines(&entries))
                    .await;
                let _ = tx.send(()).await;
                wake();
            });
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
            .retain(|outline| !outline.belongs_to_session(&key.0, &key.1));
        self.dirty |= before != self.entries.len();
        if !self.started || self.loading.is_some() {
            self.invalidated_while_loading.insert(key);
        }
    }

    fn trim(&mut self) {
        let mut bytes = 0;
        let keep = self
            .entries
            .iter()
            .take(16)
            .take_while(|entry| {
                bytes += entry.saved_weight().unwrap_or_default();
                bytes <= 16 * 1024 * 1024
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
        .find(|outline| outline.saved_for(backend, project))
        .cloned()
}

pub(crate) fn remember(s: &mut State, outline: Arc<Outline>) {
    let cache = &mut s.saved_outlines;
    if outline.saved_weight().is_none()
        || cache.entries.iter().any(|o| o.same_saved_outline(&outline))
    {
        return;
    }
    cache.entries.retain(|old| !old.same_saved_slot(&outline));
    cache.entries.insert(0, outline);
    cache.trim();
    cache.dirty = true;
    (s.wake)();
}

pub(crate) fn invalidate(s: &mut State, backend: &Backend) {
    s.saved_outlines.invalidate(backend);
    (s.wake)();
}
