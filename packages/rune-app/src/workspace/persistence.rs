use super::{Snapshot, decode, encode_for_save};
use crate::{
    files::document::store::Store as Documents, history::Result, platform::storage::Store,
};
#[cfg(not(target_arch = "wasm32"))]
use codenomad_client::TryRecvError;
use codenomad_client::{Receiver, bounded};
use std::path::PathBuf;

type Loaded = (Store, Result<Option<Snapshot>>, Result<Option<Vec<u8>>>);

#[cfg(not(target_arch = "wasm32"))]
const FILE_DRAFT_DEBOUNCE_SECS: f64 = 0.25;
#[cfg(not(target_arch = "wasm32"))]
const FILE_DRAFT_MAX_WAIT_SECS: f64 = 2.0;

pub(super) struct Persistence {
    pub loading: bool,
    pub read_error: bool,
    pub write_error: bool,
    pub file_draft_error: bool,
    pub file_draft_read_error: bool,
    pub partial: bool,
    pub store: Option<Store>,
    loaded: Option<Receiver<Result<Loaded>>>,
    retrying_file_drafts: Option<Receiver<Result<Option<Vec<u8>>>>>,
    saving: Option<Receiver<(u64, bool)>>,
    #[cfg(not(target_arch = "wasm32"))]
    saving_file_drafts: Option<(u64, Receiver<(u64, bool)>)>,
    saved: u64,
    saved_file_drafts: u64,
    attempted_file_drafts: u64,
    #[cfg(not(target_arch = "wasm32"))]
    file_drafts_dirty_revision: u64,
    #[cfg(not(target_arch = "wasm32"))]
    file_drafts_first_dirty: Option<f64>,
    #[cfg(not(target_arch = "wasm32"))]
    file_drafts_due: f64,
    #[cfg(not(target_arch = "wasm32"))]
    file_draft_retry_requested: bool,
    due: f64,
}
impl Persistence {
    pub fn new() -> Self {
        Self {
            loading: false,
            read_error: false,
            write_error: false,
            file_draft_error: false,
            file_draft_read_error: false,
            partial: false,
            store: None,
            loaded: None,
            retrying_file_drafts: None,
            saving: None,
            #[cfg(not(target_arch = "wasm32"))]
            saving_file_drafts: None,
            saved: 0,
            saved_file_drafts: 0,
            attempted_file_drafts: 0,
            #[cfg(not(target_arch = "wasm32"))]
            file_drafts_dirty_revision: 0,
            #[cfg(not(target_arch = "wasm32"))]
            file_drafts_first_dirty: None,
            #[cfg(not(target_arch = "wasm32"))]
            file_drafts_due: 0.0,
            #[cfg(not(target_arch = "wasm32"))]
            file_draft_retry_requested: false,
            due: 0.0,
        }
    }
    pub fn start(&mut self, directory: Option<PathBuf>, documents: &Documents, wake: rune::Waker) {
        if self.store.is_none() {
            // An unopened store may already contain drafts, even if its lock cannot be acquired.
            documents.block_file_draft_updates(true);
        }
        if self.loading || self.store.is_some() || self.read_error {
            return;
        }
        #[cfg(not(target_arch = "wasm32"))]
        let Some(directory) = directory else {
            return;
        };
        #[cfg(target_arch = "wasm32")]
        let _ = directory;
        let (out, input) = bounded(1);
        self.loaded = Some(input);
        self.loading = true;
        crate::platform::spawn(async move {
            let result = async {
                #[cfg(not(target_arch = "wasm32"))]
                let store = Store::open(directory).await?;
                #[cfg(target_arch = "wasm32")]
                let store = Store::open().await?;
                let snapshot = store.load().await.and_then(|bytes| {
                    bytes
                        .map(|bytes| decode(&bytes).map_err(|_| "invalid saved workspace".into()))
                        .transpose()
                });
                let drafts = store.load_file_drafts().await;
                Ok((store, snapshot, drafts))
            }
            .await;
            let _ = out.send(result).await;
            wake();
        });
    }
    pub fn poll_load(&mut self) -> Option<(Option<Snapshot>, Result<Option<Vec<u8>>>)> {
        let result = self.loaded.as_ref()?.try_recv().ok()?;
        self.loaded = None;
        self.loading = false;
        match result {
            Ok((store, snapshot, drafts)) => {
                self.read_error = snapshot.is_err();
                let snapshot = snapshot.ok().flatten();
                self.saved = snapshot.as_ref().map_or(0, |s| s.revision);
                self.store = Some(store);
                Some((snapshot, drafts))
            }
            Err(_) => {
                self.read_error = true;
                None
            }
        }
    }
    pub fn dirty(&mut self, now: f64) {
        self.due = now + 0.25;
    }
    pub fn poll_save(
        &mut self,
        snapshot: &Snapshot,
        now: f64,
        tx: &mut rune::Tx,
        wake: rune::Waker,
    ) {
        if let Some((revision, ok)) = self.saving.as_ref().and_then(|rx| rx.try_recv().ok()) {
            self.saving = None;
            self.write_error = !ok;
            if ok {
                self.saved = self.saved.max(revision);
            }
        }
        let Some(store) = self.store.clone() else {
            return;
        };
        if self.read_error
            || self.write_error
            || self.saving.is_some()
            || self.saved >= snapshot.revision
        {
            return;
        }
        if now < self.due {
            tx.wake_at(self.due);
            return;
        }
        let bytes = match encode_for_save(snapshot) {
            Ok((bytes, partial)) => {
                self.partial = partial;
                bytes
            }
            Err(_) => {
                self.write_error = true;
                return;
            }
        };
        let (out, input) = bounded(1);
        self.saving = Some(input);
        let revision = snapshot.revision;
        crate::platform::spawn(async move {
            let ok = store.save(bytes).await.is_ok();
            let _ = out.send((revision, ok)).await;
            wake();
        });
    }
    pub fn retry(&mut self) {
        if self.store.is_none() {
            self.read_error = false;
        }
        self.write_error = false;
        self.due = 0.0;
        self.attempted_file_drafts = self.saved_file_drafts;
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.file_drafts_due = 0.0;
            self.file_draft_retry_requested = true;
        }
    }
    pub fn retry_file_drafts(&mut self, wake: rune::Waker) {
        if !self.file_draft_read_error || self.retrying_file_drafts.is_some() {
            return;
        }
        let Some(store) = self.store.clone() else {
            return;
        };
        let (out, input) = bounded(1);
        self.retrying_file_drafts = Some(input);
        crate::platform::spawn(async move {
            let _ = out.send(store.load_file_drafts().await).await;
            wake();
        });
    }
    pub fn poll_file_draft_retry(
        &mut self,
        documents: &crate::files::document::store::Store,
    ) -> bool {
        let Some(Ok(result)) = self.retrying_file_drafts.as_ref().map(Receiver::try_recv) else {
            return false;
        };
        self.retrying_file_drafts = None;
        self.file_draft_read_error = match result {
            Ok(Some(bytes)) => !documents.hydrate_file_drafts(&bytes),
            Ok(None) => false,
            Err(_) => true,
        };
        documents.block_file_draft_updates(self.file_draft_read_error);
        self.attempted_file_drafts = self.saved_file_drafts;
        #[cfg(not(target_arch = "wasm32"))]
        if !self.file_draft_read_error {
            self.file_drafts_dirty_revision = documents.file_draft_revision();
            self.file_drafts_first_dirty = None;
            self.file_drafts_due = 0.0;
            self.file_draft_retry_requested = true;
        }
        true
    }
    pub fn flush(&mut self, snapshot: &Snapshot) -> bool {
        if self.read_error || self.loading {
            return false;
        }
        let Some(store) = &self.store else {
            return true;
        };
        let Ok((bytes, partial)) = encode_for_save(snapshot) else {
            self.write_error = true;
            return false;
        };
        self.partial = partial;
        let ok = store.save_exit(bytes).is_ok();
        self.write_error = !ok;
        if ok {
            self.saved = snapshot.revision;
        }
        ok && !partial
    }
    #[cfg(not(target_arch = "wasm32"))]
    fn drain_file_draft_save(&mut self) {
        let Some((_, rx)) = &self.saving_file_drafts else {
            return;
        };
        match rx.try_recv() {
            Ok((revision, ok)) => {
                self.saving_file_drafts = None;
                self.file_draft_error = !ok;
                if ok {
                    self.saved_file_drafts = self.saved_file_drafts.max(revision);
                    self.file_draft_retry_requested = false;
                }
            }
            Err(TryRecvError::Closed) => {
                self.saving_file_drafts = None;
                self.file_draft_error = true;
            }
            Err(TryRecvError::Empty) => {}
        }
    }
    pub fn flush_file_drafts(&mut self, documents: &Documents) -> bool {
        #[cfg(target_arch = "wasm32")]
        {
            self.save_file_drafts_since(documents, self.saved_file_drafts)
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.drain_file_draft_save();
            self.file_draft_retry_requested = false;
            self.file_drafts_first_dirty = None;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            if let Some((in_flight_revision, rx)) = self.saving_file_drafts.take() {
                if !self.file_draft_read_error
                    && in_flight_revision == documents.file_draft_revision()
                {
                    if let Some(remaining) =
                        deadline.checked_duration_since(std::time::Instant::now())
                    {
                        match crate::platform::block_on(async {
                            tokio::time::timeout(remaining, rx.recv()).await
                        }) {
                            Ok(Ok((revision, true))) => {
                                self.saved_file_drafts = self.saved_file_drafts.max(revision);
                                self.file_draft_error = false;
                            }
                            Ok(Ok((_, false))) | Ok(Err(_)) => {
                                self.file_draft_error = true;
                            }
                            Err(_) => {
                                if let Some(store) = &self.store {
                                    store.cancel_file_drafts_save();
                                }
                                self.file_draft_error = true;
                            }
                        }
                    }
                }
            }
            loop {
                let Some((revision, bytes)) = documents.file_draft_snapshot(self.saved_file_drafts)
                else {
                    return !self.file_draft_error;
                };
                self.attempted_file_drafts = revision;
                let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now())
                else {
                    self.file_draft_error = true;
                    return false;
                };
                if self.file_draft_read_error
                    || self.store.as_ref().is_none_or(|store| {
                        store
                            .save_file_drafts_exit_within(bytes, remaining)
                            .is_err()
                    })
                {
                    self.file_draft_error = true;
                    return false;
                }
                self.saved_file_drafts = revision;
                self.file_draft_error = false;
            }
        }
    }
    pub fn poll_file_drafts(
        &mut self,
        documents: &Documents,
        now: f64,
        tx: &mut rune::Tx,
        wake: rune::Waker,
    ) {
        #[cfg(target_arch = "wasm32")]
        {
            let _ = (now, tx, wake);
            self.save_file_drafts_since(documents, self.attempted_file_drafts);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.drain_file_draft_save();
            let current = documents.file_draft_revision();
            if current <= self.saved_file_drafts {
                self.file_drafts_first_dirty = None;
                self.file_draft_retry_requested = false;
            } else if current != self.file_drafts_dirty_revision {
                let first = *self.file_drafts_first_dirty.get_or_insert(now);
                self.file_drafts_dirty_revision = current;
                if !self.file_draft_retry_requested {
                    self.file_drafts_due =
                        (now + FILE_DRAFT_DEBOUNCE_SECS).min(first + FILE_DRAFT_MAX_WAIT_SECS);
                }
            }
            let Some(store) = self.store.clone() else {
                return;
            };
            if self.file_draft_read_error
                || (self.file_draft_error && !self.file_draft_retry_requested)
                || self.saving_file_drafts.is_some()
                || self.attempted_file_drafts >= current
                || self.saved_file_drafts >= current
            {
                return;
            }
            if now < self.file_drafts_due {
                tx.wake_at(self.file_drafts_due);
                return;
            }
            let Some((revision, bytes)) = documents.file_draft_snapshot(self.saved_file_drafts)
            else {
                return;
            };
            self.file_draft_retry_requested = false;
            self.file_drafts_first_dirty = None;
            self.attempted_file_drafts = revision;
            let (out, input) = bounded(1);
            self.saving_file_drafts = Some((revision, input));
            let write = store.start_file_drafts_save(bytes);
            crate::platform::spawn(async move {
                let ok = matches!(write.await, Ok(true));
                let _ = out.send((revision, ok)).await;
                wake();
            });
        }
    }
    #[cfg(target_arch = "wasm32")]
    fn save_file_drafts_since(&mut self, documents: &Documents, revision: u64) -> bool {
        let Some((revision, bytes)) = documents.file_draft_snapshot(revision) else {
            return !self.file_draft_error;
        };
        self.attempted_file_drafts = revision;
        if self.file_draft_read_error
            || self
                .store
                .as_ref()
                .is_none_or(|store| store.save_file_drafts(&bytes).is_err())
        {
            self.file_draft_error = true;
            return false;
        }
        self.saved_file_drafts = revision;
        self.file_draft_error = false;
        true
    }
}
pub(crate) fn finish(s: &mut crate::State, tx: &mut rune::Tx) {
    finish_inner(s, tx, true);
}

pub(crate) fn finish_on_quit(s: &mut crate::State, tx: &mut rune::Tx) {
    finish_inner(s, tx, false);
}

fn finish_inner(s: &mut crate::State, _: &mut rune::Tx, mark_closed: bool) {
    if s.workspace.as_ref().is_some_and(|ui| ui.finished) {
        return;
    }
    super::capture_files_mode(s);
    super::capture(s);
    if let Some(mut ui) = s.workspace.take() {
        if mark_closed {
            ui.finished = true;
        }
        ui.openings.close();
        let snapshot = ui.snapshot();
        let drafts_saved = ui.persistence.flush_file_drafts(&s.documents);
        #[cfg(not(target_arch = "wasm32"))]
        crate::files::document::recovery::show(
            s.documents.closing_drafts(!drafts_saved),
            !drafts_saved,
        );
        if ui.persistence.flush(&snapshot) && drafts_saved && !ui.has_unsaved_large_drafts() {
            ui.release_all();
        } else {
            crate::platform::release_records_on_exit(Vec::new(), ui.openings.clone());
        }
        s.workspace = Some(ui);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
