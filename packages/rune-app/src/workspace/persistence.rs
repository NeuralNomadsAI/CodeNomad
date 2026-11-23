use super::{Snapshot, decode, encode_for_save};
use crate::{history::Result, platform::storage::Store};
use codenomad_client::{Receiver, bounded};
use std::path::PathBuf;

type Loaded = (Store, Result<Option<Snapshot>>, Result<Option<Vec<u8>>>);

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
    saved: u64,
    saved_file_drafts: u64,
    #[cfg(target_arch = "wasm32")]
    attempted_file_drafts: u64,
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
            saved: 0,
            saved_file_drafts: 0,
            #[cfg(target_arch = "wasm32")]
            attempted_file_drafts: 0,
            due: 0.0,
        }
    }
    pub fn start(&mut self, directory: Option<PathBuf>, wake: rune::Waker) {
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
        #[cfg(target_arch = "wasm32")]
        {
            self.attempted_file_drafts = self.saved_file_drafts;
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
        #[cfg(target_arch = "wasm32")]
        {
            self.attempted_file_drafts = self.saved_file_drafts;
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
    pub fn flush_file_drafts(&mut self, documents: &crate::files::document::store::Store) -> bool {
        self.save_file_drafts_since(documents, self.saved_file_drafts)
    }
    #[cfg(target_arch = "wasm32")]
    pub fn poll_file_drafts(&mut self, documents: &crate::files::document::store::Store) {
        self.save_file_drafts_since(documents, self.attempted_file_drafts);
    }
    fn save_file_drafts_since(
        &mut self,
        documents: &crate::files::document::store::Store,
        revision: u64,
    ) -> bool {
        let Some((revision, bytes)) = documents.file_draft_snapshot(revision) else {
            return !self.file_draft_error;
        };
        #[cfg(target_arch = "wasm32")]
        {
            self.attempted_file_drafts = revision;
        }
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
    fn corrupt_window_snapshot_does_not_hide_the_file_sidecar() {
        let parent = std::env::temp_dir().join(codenomad_client::http::client_id().unwrap());
        fs::create_dir(&parent).unwrap();
        let root = parent.join("rune");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("state.json"), b"broken window snapshot").unwrap();
        fs::write(root.join("workspace-file-drafts.json"), b"[]").unwrap();
        let mut state = Persistence::new();
        state.start(Some(root), Arc::new(|| {}));
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
}
