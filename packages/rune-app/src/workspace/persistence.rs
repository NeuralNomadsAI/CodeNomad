use super::{Snapshot, decode, encode_for_save};
use crate::{
    files::document::store::Store as Documents,
    history::Result,
    platform::storage::{ClearOutcome, Store},
};
#[cfg(not(target_arch = "wasm32"))]
use codenomad_client::TryRecvError;
use codenomad_client::{Receiver, bounded};
use std::path::PathBuf;

type Loaded = (
    Store,
    Option<bool>,
    Result<Option<Snapshot>>,
    Result<Option<Vec<u8>>>,
);

#[cfg(not(target_arch = "wasm32"))]
const FILE_DRAFT_DEBOUNCE_SECS: f64 = 0.25;
#[cfg(not(target_arch = "wasm32"))]
const FILE_DRAFT_MAX_WAIT_SECS: f64 = 2.0;

pub(super) struct Persistence {
    pub loading: bool,
    pub restore_enabled: bool,
    pub restore_read_error: bool,
    pub mutating: bool,
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
    cleared_revision: Option<u64>,
    cleared_file_drafts_revision: Option<u64>,
    mutation_baseline: Option<(u64, u64, u64)>,
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
            restore_enabled: true,
            restore_read_error: false,
            mutating: false,
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
            cleared_revision: None,
            cleared_file_drafts_revision: None,
            mutation_baseline: None,
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
                let restore_enabled = store.restore_enabled().await.ok();
                let (snapshot, drafts) = match restore_enabled {
                    Some(true) => {
                        let snapshot = store.load().await.and_then(|bytes| {
                            bytes
                                .map(|bytes| {
                                    decode(&bytes).map_err(|_| "invalid saved workspace".into())
                                })
                                .transpose()
                        });
                        let drafts = store.load_file_drafts().await;
                        (snapshot, drafts)
                    }
                    Some(false) => (Ok(None), Ok(None)),
                    None => (
                        Err("invalid restore preference".into()),
                        Err("invalid restore preference".into()),
                    ),
                };
                Ok((store, restore_enabled, snapshot, drafts))
            }
            .await;
            let _ = out.send(result).await;
            wake();
        });
    }
    pub fn poll_load(&mut self) -> Option<(Option<Snapshot>, Result<Option<Vec<u8>>>)> {
        if self.mutating {
            self.loaded = None;
            self.loading = false;
            return None;
        }
        let result = self.loaded.as_ref()?.try_recv().ok()?;
        self.loaded = None;
        self.loading = false;
        match result {
            Ok((store, restore_enabled, snapshot, drafts)) => {
                self.restore_read_error = restore_enabled.is_none();
                let enabled = restore_enabled.unwrap_or(false);
                self.restore_enabled = enabled;
                self.read_error = self.restore_read_error || (enabled && snapshot.is_err());
                let snapshot = if enabled {
                    snapshot.ok().flatten()
                } else {
                    None
                };
                self.saved = snapshot.as_ref().map_or(0, |s| s.revision);
                self.store = Some(store);
                Some((
                    snapshot,
                    if enabled || self.restore_read_error {
                        drafts
                    } else {
                        Ok(None)
                    },
                ))
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
    pub fn poll_save_ready(&mut self, revision: u64, now: f64, tx: &mut rune::Tx) -> bool {
        if let Some((saved_rev, ok)) = self.saving.as_ref().and_then(|rx| rx.try_recv().ok()) {
            self.saving = None;
            self.write_error = !ok;
            if ok {
                self.saved = self.saved.max(saved_rev);
            }
        }
        if self.store.is_none()
            || !self.restore_enabled
            || self.mutating
            || self.read_error
            || self.write_error
            || self.saving.is_some()
            || self.saved >= revision
        {
            return false;
        }
        if self
            .cleared_revision
            .is_some_and(|cleared| revision > cleared)
        {
            self.cleared_revision = None;
        }
        if now < self.due {
            tx.wake_at(self.due);
            return false;
        }
        true
    }
    pub fn start_save(&mut self, snapshot: &Snapshot, wake: rune::Waker) {
        let Some(store) = self.store.clone() else {
            return;
        };
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
        let write = store.start_save(bytes);
        crate::platform::spawn(async move {
            let ok = write.await.is_ok();
            let _ = out.send((revision, ok)).await;
            wake();
        });
    }
    #[cfg(test)]
    pub fn poll_save(
        &mut self,
        snapshot: &Snapshot,
        now: f64,
        tx: &mut rune::Tx,
        wake: rune::Waker,
    ) {
        if self.poll_save_ready(snapshot.revision, now, tx) {
            self.start_save(snapshot, wake);
        }
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
    fn reload_from_store(&mut self, store: Store, wake: rune::Waker) {
        if self.loading {
            return;
        }
        self.loading = true;
        let (out, input) = bounded(1);
        self.loaded = Some(input);
        crate::platform::spawn(async move {
            let result = async {
                let restore_enabled = store.restore_enabled().await.ok();
                let (snapshot, drafts) = match restore_enabled {
                    Some(true) => {
                        let snapshot = store.load().await.and_then(|bytes| {
                            bytes
                                .map(|bytes| {
                                    decode(&bytes).map_err(|_| "invalid saved workspace".into())
                                })
                                .transpose()
                        });
                        let drafts = store.load_file_drafts().await;
                        (snapshot, drafts)
                    }
                    Some(false) => (Ok(None), Ok(None)),
                    None => (
                        Err("invalid restore preference".into()),
                        Err("invalid restore preference".into()),
                    ),
                };
                Ok((store, restore_enabled, snapshot, drafts))
            }
            .await;
            let _ = out.send(result).await;
            wake();
        });
    }
    pub fn retry_file_drafts(&mut self, wake: rune::Waker) {
        if self.mutating {
            return;
        }
        let Some(store) = self.store.clone() else {
            return;
        };
        if self.restore_read_error {
            // Re-read the restore preference and saved data on the existing Store without
            // dropping it (dropping Store on Web cancels openings; on desktop it can collide
            // with Preferences' lock clone).
            self.read_error = false;
            self.reload_from_store(store, wake);
            return;
        }
        if !self.file_draft_read_error || self.retrying_file_drafts.is_some() {
            return;
        }
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
        if !self.restore_enabled || self.mutating {
            self.retrying_file_drafts = None;
            return false;
        }
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
    pub fn begin_startup_mutation(
        &mut self,
        current_revision: u64,
        documents: &Documents,
        outlines: &mut super::outlines::Cache,
    ) {
        self.mutating = true;
        self.loaded = None;
        self.loading = false;
        self.saving = None;
        self.retrying_file_drafts = None;
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.saving_file_drafts = None;
            self.file_drafts_first_dirty = None;
        }
        if let Some(store) = &self.store {
            store.begin_startup_mutation();
            #[cfg(target_arch = "wasm32")]
            store.stage_pending_file_drafts(documents.live_file_draft_bytes());
        }
        let outlines_version = outlines.begin_freeze();
        self.mutation_baseline = Some((
            current_revision,
            documents.file_draft_revision(),
            outlines_version,
        ));
    }
    pub fn cancel_startup_mutation(&mut self, outlines: &mut super::outlines::Cache) {
        self.mutating = false;
        self.mutation_baseline = None;
        self.saving = None;
        self.due = 0.0;
        self.attempted_file_drafts = self.saved_file_drafts;
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.saving_file_drafts = None;
            self.file_drafts_due = 0.0;
            self.file_draft_retry_requested = true;
        }
        if self.restore_enabled {
            outlines.restore_after_failed_mutation();
        }
    }
    /// Applies a confirmed restore-enabled change. Returns `true` when the workspace should
    /// immediately mark itself dirty to write live state; returns `false` when repairing an
    /// unreadable marker triggered a reload that must finish before unblocking writes.
    pub fn apply_restore_enabled(
        &mut self,
        enabled: bool,
        current_revision: u64,
        documents: &Documents,
        outlines: &mut super::outlines::Cache,
        wake: rune::Waker,
    ) -> bool {
        let was_unreadable = self.restore_read_error;
        self.mutating = false;
        self.mutation_baseline = None;
        self.restore_enabled = enabled;
        self.restore_read_error = false;
        self.saving = None;
        self.retrying_file_drafts = None;
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.saving_file_drafts = None;
            self.file_drafts_first_dirty = None;
        }
        if enabled && was_unreadable {
            // Existing state/drafts on disk were never loaded while the marker was unreadable.
            // Keep writes blocked and reload them before allowing the live window to overwrite disk.
            self.read_error = true;
            self.file_draft_read_error = true;
            documents.block_file_draft_updates(true);
            outlines.restore_after_failed_mutation();
            if let Some(store) = self.store.clone() {
                self.reload_from_store(store, wake);
            }
            return false;
        }
        self.read_error = false;
        self.write_error = false;
        self.partial = false;
        self.file_draft_error = false;
        self.file_draft_read_error = false;
        documents.block_file_draft_updates(false);
        if enabled {
            self.cleared_revision = None;
            self.cleared_file_drafts_revision = None;
            documents.mark_file_drafts_dirty_if_nonempty();
            outlines.mark_dirty_if_nonempty();
            self.saved = 0;
            self.saved_file_drafts = 0;
            self.attempted_file_drafts = 0;
            self.due = 0.0;
            #[cfg(not(target_arch = "wasm32"))]
            {
                self.file_drafts_dirty_revision = documents.file_draft_revision();
                self.file_drafts_due = 0.0;
                self.file_draft_retry_requested = true;
            }
            true
        } else {
            documents.discard_unopened_saved_drafts();
            outlines.clear_saved();
            let drafts_rev = documents.file_draft_revision();
            self.saved = current_revision;
            self.cleared_revision = Some(current_revision);
            self.cleared_file_drafts_revision = None;
            self.saved_file_drafts = drafts_rev;
            self.attempted_file_drafts = drafts_rev;
            #[cfg(not(target_arch = "wasm32"))]
            {
                self.file_drafts_dirty_revision = drafts_rev;
                self.file_draft_retry_requested = false;
            }
            false
        }
    }
    pub fn apply_cleared(
        &mut self,
        outcome: ClearOutcome,
        current_revision: u64,
        documents: &Documents,
        outlines: &mut super::outlines::Cache,
    ) {
        self.mutating = false;
        self.saving = None;
        self.retrying_file_drafts = None;
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.saving_file_drafts = None;
            self.file_drafts_first_dirty = None;
        }
        let (base_rev, base_drafts, base_outlines) = self.mutation_baseline.take().unwrap_or((
            current_revision,
            documents.file_draft_revision(),
            outlines.version(),
        ));
        if outcome.state_ok {
            self.read_error = self.restore_read_error;
            self.write_error = false;
            self.partial = false;
            if current_revision > base_rev {
                // Workspace edits arrived while Clear was running: re-arm persistence instead of
                // swallowing them into the cleared baseline.
                self.saved = base_rev;
                self.cleared_revision = None;
                self.due = 0.0;
            } else {
                self.saved = current_revision;
                self.cleared_revision = Some(current_revision);
            }
        } else {
            self.due = 0.0;
        }
        if outcome.outlines_ok {
            outlines.clear_saved_before(base_outlines);
        } else if self.restore_enabled {
            outlines.restore_after_failed_mutation();
        }
        if outcome.drafts_ok {
            documents.discard_unopened_saved_drafts();
            let drafts_rev = documents.file_draft_revision();
            self.file_draft_error = false;
            self.file_draft_read_error = self.restore_read_error;
            if drafts_rev > base_drafts {
                // File edits arrived while Clear was running: keep them dirty so they checkpoint
                // and trigger recovery if unsaved on exit.
                self.cleared_file_drafts_revision = None;
                self.saved_file_drafts = base_drafts;
                self.attempted_file_drafts = base_drafts;
                #[cfg(not(target_arch = "wasm32"))]
                {
                    self.file_drafts_dirty_revision = drafts_rev;
                    self.file_drafts_due = 0.0;
                    self.file_draft_retry_requested = true;
                }
            } else if documents.has_saved_file_drafts() {
                // Clear removed saved drafts from disk, but open dirty editors still hold unsaved
                // edits: stay quiet while idle, yet leave them unpersisted so exit flushes them
                // (or opens recovery on failure).
                documents.mark_file_drafts_dirty_if_nonempty();
                let next_rev = documents.file_draft_revision();
                self.cleared_file_drafts_revision = Some(next_rev);
                self.saved_file_drafts = drafts_rev;
                self.attempted_file_drafts = drafts_rev;
                #[cfg(target_arch = "wasm32")]
                if let Some(store) = &self.store {
                    let staged = documents
                        .file_draft_snapshot(drafts_rev)
                        .map(|(_, bytes)| bytes);
                    store.stage_pending_file_drafts(staged);
                }
                #[cfg(not(target_arch = "wasm32"))]
                {
                    self.file_drafts_dirty_revision = next_rev;
                    self.file_draft_retry_requested = false;
                }
            } else {
                self.cleared_file_drafts_revision = None;
                self.saved_file_drafts = drafts_rev;
                self.attempted_file_drafts = drafts_rev;
                #[cfg(not(target_arch = "wasm32"))]
                {
                    self.file_drafts_dirty_revision = drafts_rev;
                    self.file_draft_retry_requested = false;
                }
            }
            if !self.restore_read_error {
                documents.block_file_draft_updates(false);
            }
        } else {
            // Re-arm any file draft write cancelled by the partial Clear so live edits persist.
            self.attempted_file_drafts = self.saved_file_drafts;
            #[cfg(not(target_arch = "wasm32"))]
            {
                self.file_drafts_due = 0.0;
                self.file_draft_retry_requested = true;
            }
        }
    }
    pub fn suppresses_snapshot(&self, current_revision: u64) -> bool {
        !self.restore_enabled || self.mutating || self.cleared_revision == Some(current_revision)
    }
    pub fn flush(&mut self, snapshot: &Snapshot) -> bool {
        if self.mutating || self.read_error || self.loading {
            return false;
        }
        if self.suppresses_snapshot(snapshot.revision) {
            return true;
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
        if self.mutating || self.restore_read_error {
            return false;
        }
        if !self.restore_enabled {
            return true;
        }
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
                self.cleared_file_drafts_revision = None;
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
        if !self.restore_enabled || self.mutating {
            #[cfg(not(target_arch = "wasm32"))]
            self.drain_file_draft_save();
            return;
        }
        let current_rev = documents.file_draft_revision();
        if let Some(cleared) = self.cleared_file_drafts_revision {
            if current_rev == cleared {
                #[cfg(not(target_arch = "wasm32"))]
                self.drain_file_draft_save();
                return;
            }
            self.cleared_file_drafts_revision = None;
            #[cfg(target_arch = "wasm32")]
            if let Some(store) = &self.store {
                store.stage_pending_file_drafts(None);
            }
        }
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
        self.cleared_file_drafts_revision = None;
        self.file_draft_error = false;
        true
    }
}
pub(crate) fn finish(s: &mut crate::State, _: &mut rune::Tx) {
    super::capture_files_mode(s);
    super::capture(s);
    #[cfg(not(target_arch = "wasm32"))]
    crate::settings::startup_state::wait_for_flight(s, std::time::Duration::from_secs(5));
    if let Some(mut ui) = s.workspace.take() {
        ui.openings.close();
        let stashed = s.temporary.stashed_for_snapshot();
        let snapshot = ui.snapshot_with_stashed(stashed);
        let drafts_saved = ui.persistence.flush_file_drafts(&s.documents);
        #[cfg(not(target_arch = "wasm32"))]
        {
            let drafts_persisted = ui.persistence.restore_enabled && drafts_saved;
            crate::files::document::recovery::show(
                s.documents.closing_drafts(!drafts_persisted),
                !drafts_saved,
            );
        }
        if ui.persistence.flush(&snapshot) && drafts_saved && !ui.has_unsaved_large_drafts() {
            ui.release_all_with_stashed(stashed);
        } else {
            crate::platform::release_records_on_exit(Vec::new(), ui.openings.clone());
        }
        s.workspace = Some(ui);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
