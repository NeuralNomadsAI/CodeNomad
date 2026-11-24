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
pub(crate) fn finish(s: &mut crate::State, _: &mut rune::Tx) {
    super::capture_files_mode(s);
    super::capture(s);
    if let Some(mut ui) = s.workspace.take() {
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
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };
    #[test]
    fn failed_profile_open_keeps_file_draft_updates_blocked_until_hydration() {
        let parent = std::env::temp_dir().join(codenomad_client::http::client_id().unwrap());
        fs::create_dir(&parent).unwrap();
        let root = parent.join("rune");
        let owner = crate::platform::block_on(Store::open(root.clone())).unwrap();
        owner.save_file_drafts(b"[]").unwrap();
        let documents = Documents::default();
        let mut state = Persistence::new();
        state.start(Some(root.clone()), &documents, Arc::new(|| {}));
        assert!(documents.file_draft_updates_blocked());
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while state.loading {
            state.poll_load();
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(state.read_error);
        assert!(documents.file_draft_updates_blocked());
        drop(owner);
        state.retry();
        state.start(Some(root), &documents, Arc::new(|| {}));
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let (_, drafts) = loop {
            if let Some(loaded) = state.poll_load() {
                break loaded;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        };
        assert_eq!(drafts.unwrap().unwrap(), b"[]");
        assert!(documents.file_draft_updates_blocked());
        drop(state);
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn corrupt_window_snapshot_does_not_hide_the_file_sidecar() {
        let parent = std::env::temp_dir().join(codenomad_client::http::client_id().unwrap());
        fs::create_dir(&parent).unwrap();
        let root = parent.join("rune");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("state.json"), b"broken window snapshot").unwrap();
        fs::write(root.join("workspace-file-drafts.json"), b"[]").unwrap();
        let mut state = Persistence::new();
        state.start(Some(root), &Documents::default(), Arc::new(|| {}));
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let loaded = loop {
            if let Some(loaded) = state.poll_load() {
                break loaded;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        };
        assert!(state.read_error);
        assert!(loaded.0.is_none());
        assert_eq!(loaded.1.unwrap().unwrap(), b"[]");
        drop(state);
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn write_failure_stays_dirty_without_automatic_retries() {
        let parent =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/rune-state-tests");
        fs::create_dir_all(&parent).unwrap();
        let root = parent.join(codenomad_client::http::client_id().unwrap());
        fs::create_dir(&root).unwrap();
        let store = crate::platform::block_on(Store::open(root.join("rune"))).unwrap();
        fs::create_dir(root.join("rune/state.json")).unwrap();
        let snapshot = Snapshot {
            revision: 1,
            saved_at: 1,
            panel_widths: [None; 2],
            file_wrap: None,
            tabs: vec![super::super::Tab::Blank],
            active: Some(0),
        };
        store.stage(&super::super::encode(&snapshot).unwrap(), &[]);
        let mut persistence = Persistence::new();
        persistence.store = Some(store);
        let wakes = Arc::new(AtomicUsize::new(0));
        let count = wakes.clone();
        let wake: rune::Waker = Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        let mut rt = rune::Runtime::new(
            (persistence, snapshot),
            |_, _| rune::el(),
            (100.0, 100.0),
            rune::Env::new(false, 1.0),
        );
        for _ in 0..100 {
            let wake = wake.clone();
            rt.update(move |(p, snapshot), tx| p.poll_save(snapshot, 1.0, tx, wake));
            if rt.state.0.write_error && wakes.load(Ordering::SeqCst) == 1 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(rt.state.0.write_error);
        assert_eq!(rt.state.0.saved, 0);
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
        for _ in 0..10 {
            let wake = wake.clone();
            rt.update(move |(p, snapshot), tx| p.poll_save(snapshot, 2.0, tx, wake));
        }
        assert!(rt.state.0.saving.is_none());
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
        fs::remove_dir(root.join("rune/state.json")).unwrap();
        rt.state.0.retry();
        for _ in 0..100 {
            let wake = wake.clone();
            rt.update(move |(p, snapshot), tx| p.poll_save(snapshot, 3.0, tx, wake));
            if rt.state.0.saved == 1 && wakes.load(Ordering::SeqCst) == 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(rt.state.0.saved, 1);
        assert_eq!(wakes.load(Ordering::SeqCst), 2);
        drop(rt);
        fs::remove_dir_all(root).unwrap();
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let parent =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/rune-state-tests");
            fs::create_dir_all(&parent).unwrap();
            let root = parent.join(codenomad_client::http::client_id().unwrap());
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn native_file_drafts_persist_asynchronously_without_exit_flush() {
        let root = TempDir::new();
        let store = crate::platform::block_on(Store::open(root.0.join("rune"))).unwrap();
        let documents = Documents::default();
        documents.insert_test_file_draft("src/lib.rs", "crash-safe draft");
        let expected = documents.file_draft_snapshot(0).unwrap().1;
        let mut persistence = Persistence::new();
        persistence.store = Some(store);
        let wakes = Arc::new(AtomicUsize::new(0));
        let count = wakes.clone();
        let wake: rune::Waker = Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        let mut rt = rune::Runtime::new(
            (persistence, documents),
            |_, _| rune::el(),
            (100.0, 100.0),
            rune::Env::new(false, 1.0),
        );
        let initial_wake = wake.clone();
        rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 1.0, tx, initial_wake));
        assert!(rt.state.0.saving_file_drafts.is_none());
        assert_eq!(rt.state.0.saved_file_drafts, 0);
        assert!(!root.0.join("rune/workspace-file-drafts.json").exists());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !(rt.state.0.saved_file_drafts == 1 && wakes.load(Ordering::SeqCst) == 1) {
            let wake = wake.clone();
            rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 1.25, tx, wake));
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(rt.state.0.saved_file_drafts, 1);
        assert!(!rt.state.0.file_draft_error);
        // Continuous edits every 0.1s still checkpoint at the 2.0s max-wait bound.
        let mut revision = 1u64;
        for step in 0..20 {
            let now = 5.0 + (step as f64) * 0.1;
            revision += 1;
            rt.state
                .1
                .insert_test_file_draft("src/lib.rs", &format!("typing-{revision}"));
            let wake = wake.clone();
            rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, now, tx, wake));
            assert!(rt.state.0.saving_file_drafts.is_none());
        }
        let max_wait_expected = rt.state.1.file_draft_snapshot(1).unwrap().1;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !(rt.state.0.saved_file_drafts == revision && wakes.load(Ordering::SeqCst) == 2) {
            let wake = wake.clone();
            rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 7.0, tx, wake));
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        // Wait for the background worker to drop its Arc<Files> (releasing state.lock) before reopen.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while rt
            .state
            .0
            .store
            .as_ref()
            .is_some_and(|store| store.file_draft_worker_running() || store.files_refcount() > 1)
        {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        // Drop without flush_file_drafts to verify drafts survive an abrupt exit.
        drop(rt);
        let loaded = crate::platform::block_on(async {
            let reopened = Store::open(root.0.join("rune")).await.unwrap();
            reopened.load_file_drafts().await.unwrap().unwrap()
        });
        assert_ne!(loaded, expected);
        assert_eq!(loaded, max_wait_expected);
        let hydrated = Documents::default();
        assert!(hydrated.hydrate_file_drafts(&loaded));
    }

    #[test]
    fn native_file_draft_write_failure_stays_dirty_without_automatic_retries() {
        let root = TempDir::new();
        let store = crate::platform::block_on(Store::open(root.0.join("rune"))).unwrap();
        fs::create_dir(root.0.join("rune/workspace-file-drafts.json")).unwrap();
        let documents = Documents::default();
        documents.insert_test_file_draft("src/main.rs", "blocked draft");
        let expected = documents.file_draft_snapshot(0).unwrap().1;
        let mut persistence = Persistence::new();
        persistence.store = Some(store);
        let wakes = Arc::new(AtomicUsize::new(0));
        let count = wakes.clone();
        let wake: rune::Waker = Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        let mut rt = rune::Runtime::new(
            (persistence, documents),
            |_, _| rune::el(),
            (100.0, 100.0),
            rune::Env::new(false, 1.0),
        );
        let first_wake = wake.clone();
        rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 1.0, tx, first_wake));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !(rt.state.0.file_draft_error && wakes.load(Ordering::SeqCst) == 1) {
            let wake = wake.clone();
            rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 1.25, tx, wake));
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(rt.state.0.file_draft_error);
        assert_eq!(rt.state.0.saved_file_drafts, 0);
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
        // Retry recovers the exact failed revision without needing a new edit.
        fs::remove_dir(root.0.join("rune/workspace-file-drafts.json")).unwrap();
        rt.state.0.retry();
        assert!(rt.state.0.file_draft_error);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !(rt.state.0.saved_file_drafts == 1 && wakes.load(Ordering::SeqCst) == 2) {
            let wake = wake.clone();
            rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 2.0, tx, wake));
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(!rt.state.0.file_draft_error);
        assert_eq!(rt.state.0.saved_file_drafts, 1);
        // A second failure followed by a new edit past both debounce and max-wait does not
        // trigger automatic retries while file_draft_error is active.
        fs::remove_file(root.0.join("rune/workspace-file-drafts.json")).unwrap();
        fs::create_dir(root.0.join("rune/workspace-file-drafts.json")).unwrap();
        rt.state
            .1
            .insert_test_file_draft("src/main.rs", "blocked second revision");
        let second_wake = wake.clone();
        rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 3.0, tx, second_wake));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !(rt.state.0.file_draft_error && wakes.load(Ordering::SeqCst) == 3) {
            let wake = wake.clone();
            rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 3.25, tx, wake));
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        rt.state
            .1
            .insert_test_file_draft("src/main.rs", "edited after failure");
        let after_failure_wake = wake.clone();
        rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 4.0, tx, after_failure_wake));
        for _ in 0..10 {
            let wake = wake.clone();
            rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 6.5, tx, wake));
        }
        assert!(rt.state.0.saving_file_drafts.is_none());
        assert_eq!(wakes.load(Ordering::SeqCst), 3);
        fs::remove_dir(root.0.join("rune/workspace-file-drafts.json")).unwrap();
        rt.state.0.retry();
        assert!(rt.state.0.file_draft_error);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !(rt.state.0.saved_file_drafts == 3 && wakes.load(Ordering::SeqCst) == 4) {
            let wake = wake.clone();
            rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 7.0, tx, wake));
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(!rt.state.0.file_draft_error);
        assert_eq!(rt.state.0.saved_file_drafts, 3);
        // A Retry clicked while a failing write is still queued triggers a fresh write on the next poll.
        let (stale_tx, stale_rx) = bounded(1);
        stale_tx.try_send((4, false)).unwrap();
        rt.state.0.saving_file_drafts = Some((4, stale_rx));
        rt.state
            .1
            .insert_test_file_draft("src/main.rs", "retried after in-flight failure");
        rt.state.0.retry();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !(rt.state.0.saved_file_drafts == 4 && wakes.load(Ordering::SeqCst) == 5) {
            let wake = wake.clone();
            rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 8.0, tx, wake));
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(!rt.state.0.file_draft_error);
        // Fifth edit flushed synchronously on exit.
        rt.state
            .1
            .insert_test_file_draft("src/main.rs", "flushed on exit");
        assert!(rt.state.0.flush_file_drafts(&rt.state.1));
        assert_eq!(rt.state.0.saved_file_drafts, 5);
        assert!(!rt.state.0.file_draft_error);
        // Even after repeated Retry clicks while an actual background save of the current
        // revision is in flight, flush_file_drafts awaits that real save without rewriting.
        rt.state
            .1
            .insert_test_file_draft("src/main.rs", "confirmed by real in-flight save");
        let inflight_expected = rt.state.1.file_draft_snapshot(5).unwrap().1;
        let lock_store = rt.state.0.store.clone().unwrap();
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let blocker = std::thread::spawn(move || {
            let _guard = lock_store.lock_file_drafts();
            let _ = locked_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(15));
        });
        locked_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let wake_six = wake.clone();
        rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 9.0, tx, wake_six));
        let wake_six_due = wake.clone();
        rt.update(move |(p, docs), tx| p.poll_file_drafts(docs, 9.25, tx, wake_six_due));
        assert!(rt.state.0.saving_file_drafts.is_some());
        rt.state.0.retry();
        rt.state.0.retry();
        release_tx.send(()).unwrap();
        assert!(rt.state.0.flush_file_drafts(&rt.state.1));
        blocker.join().unwrap();
        assert_eq!(rt.state.0.saved_file_drafts, 6);
        assert!(!rt.state.0.file_draft_error);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while wakes.load(Ordering::SeqCst) < 6
            || rt.state.0.store.as_ref().is_some_and(|store| {
                store.file_draft_worker_running() || store.files_refcount() > 1
            })
        {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(wakes.load(Ordering::SeqCst), 6);
        drop(rt);
        let loaded = crate::platform::block_on(async {
            let reopened = Store::open(root.0.join("rune")).await.unwrap();
            reopened.load_file_drafts().await.unwrap().unwrap()
        });
        assert_ne!(loaded, expected);
        assert_eq!(loaded, inflight_expected);
    }
}
