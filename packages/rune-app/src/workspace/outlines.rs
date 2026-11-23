use crate::{
    State,
    backend::Backend,
    platform::{self, storage::Store},
};
use codenomad_client::{
    Receiver, bounded,
    timeline::{self, Outline},
};
use std::sync::Arc;

#[derive(Default)]
pub(super) struct Cache {
    entries: Vec<Arc<Outline>>,
    started: bool,
    loading: Option<Receiver<Vec<Arc<Outline>>>>,
    saving: Option<Receiver<()>>,
    dirty: bool,
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
                if !self
                    .entries
                    .iter()
                    .any(|current| current.same_saved_slot(&entry))
                {
                    self.entries.push(entry);
                }
            }
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

pub(crate) fn seed(s: &State, backend: &Backend, project: &str) -> Option<Arc<Outline>> {
    s.workspace
        .as_ref()?
        .outlines
        .entries
        .iter()
        .find(|outline| outline.saved_for(backend, project))
        .cloned()
}

pub(crate) fn remember(s: &mut State, outline: Arc<Outline>) {
    let Some(cache) = s.workspace.as_mut().map(|w| &mut w.outlines) else {
        return;
    };
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

pub(crate) fn invalidate(s: &mut State, backend: &Backend, project: &str) {
    let Some(cache) = s.workspace.as_mut().map(|w| &mut w.outlines) else {
        return;
    };
    let before = cache.entries.len();
    cache
        .entries
        .retain(|outline| !outline.saved_for(backend, project));
    if cache.entries.len() != before {
        cache.dirty = true;
        (s.wake)();
    }
}
