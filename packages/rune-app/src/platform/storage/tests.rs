use super::{MAX_BYTES, native::Files};
use std::{fs, path::PathBuf};

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let parent =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/rune-store-tests");
        fs::create_dir_all(&parent).unwrap();
        let root = parent.join(format!(
            "trial-rune-store-{}",
            codenomad_client::http::client_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn open(&self) -> Files {
        Files::open(self.0.join("rune")).unwrap()
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn restart_retains_last_complete_write_and_releases_lock() {
    let root = Root::new();
    let first = root.open();
    assert_eq!(first.load().unwrap(), None);
    first.save(br#"{"draft":"first"}"#).unwrap();
    assert!(Files::open(root.0.join("rune")).is_err());
    first.save(br#"{"draft":"second"}"#).unwrap();
    drop(first);
    let second = root.open();
    assert_eq!(second.load().unwrap().unwrap(), br#"{"draft":"second"}"#);
    assert_eq!(fs::read_dir(root.0.join("rune")).unwrap().count(), 2);
}

#[test]
fn optional_outline_bytes_round_trip_without_touching_restored_drafts() {
    let root = Root::new();
    crate::platform::block_on(async {
        let path = root.0.join("rune");
        let first = super::Store::open(path.clone()).await.unwrap();
        first.stage(b"workspace", &[]);
        first.save(b"workspace".to_vec()).await.unwrap();
        first.save_file_drafts(b"document").unwrap();
        first.save_outlines(b"structure".to_vec()).await.unwrap();
        drop(first);
        let second = super::Store::open(path.clone()).await.unwrap();
        assert_eq!(second.load_outlines().await.unwrap().unwrap(), b"structure");
        fs::write(
            path.join("outlines-v1.json"),
            vec![0; super::OUTLINE_BYTES + 1],
        )
        .unwrap();
        assert!(second.load_outlines().await.is_err());
        assert_eq!(second.load().await.unwrap().unwrap(), b"workspace");
        assert_eq!(
            second.load_file_drafts().await.unwrap().unwrap(),
            b"document"
        );
    });
}

#[test]
fn oversized_write_preserves_previous_snapshot() {
    let root = Root::new();
    let store = root.open();
    store.save(b"retained").unwrap();
    assert!(store.save(&vec![0; MAX_BYTES + 1]).is_err());
    assert_eq!(store.load().unwrap().unwrap(), b"retained");
    fs::rename(root.0.join("rune/state.json"), root.0.join("retained.json")).unwrap();
    fs::create_dir(root.0.join("rune/state.json")).unwrap();
    assert!(store.save(b"replacement").is_err());
    assert_eq!(fs::read(root.0.join("retained.json")).unwrap(), b"retained");
}

#[test]
fn truncated_data_remains_available_for_validation_without_overwrite() {
    let root = Root::new();
    let store = root.open();
    fs::write(root.0.join("rune/state.json"), b"{\"version\":").unwrap();
    assert_eq!(store.load().unwrap().unwrap(), b"{\"version\":");
    fs::write(root.0.join("rune/state.json"), vec![0; MAX_BYTES + 1]).unwrap();
    assert!(store.load().is_err());
    assert_eq!(
        fs::metadata(root.0.join("rune/state.json")).unwrap().len(),
        MAX_BYTES as u64 + 1
    );
}

#[test]
fn relative_directory_and_file_in_place_of_directory_are_rejected() {
    assert!(Files::open("relative".into()).is_err());
    let root = Root::new();
    fs::write(root.0.join("rune"), b"foreign").unwrap();
    assert!(Files::open(root.0.join("rune")).is_err());
    assert_eq!(fs::read(root.0.join("rune")).unwrap(), b"foreign");
}

#[test]
fn stale_async_file_draft_write_cannot_overwrite_newer_write() {
    let root = Root::new();
    let path = root.0.join("rune");
    // Unpolled background write admitted before an exit flush cannot outrank or overwrite it.
    let store = crate::platform::block_on(super::Store::open(path.clone())).unwrap();
    let unpolled_stale = store.start_file_drafts_save(b"stale-before-exit".to_vec());
    store.save_file_drafts_exit(b"exit-fresh".to_vec()).unwrap();
    crate::platform::block_on(async {
        assert!(!unpolled_stale.await.unwrap());
        assert_eq!(
            store.load_file_drafts().await.unwrap().unwrap(),
            b"exit-fresh"
        );
        // Contended file-draft lock: older write waiting on the mutex skips once superseded,
        // while independent state/preferences operations do not block on file-draft I/O.
        let guard = store.lock_file_drafts();
        #[cfg(target_os = "windows")]
        {
            let pref_store = store.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(pref_store.save_preferences_frame(b"{}").is_ok());
            });
            assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(2)), Ok(true));
        }
        let older = store.start_file_drafts_save(b"older".to_vec());
        let older_task = tokio::spawn(older);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !store.file_draft_worker_running() || store.file_draft_pending() {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        // Submitting multiple writes while the single worker is blocked replaces the pending slot
        // without spawning extra blocking tasks; the displaced middle write resolves immediately.
        let middle = store.start_file_drafts_save(b"middle".to_vec());
        let newer = store.start_file_drafts_save(b"newer".to_vec());
        assert!(!middle.await.unwrap());
        let newer_task = tokio::spawn(newer);
        drop(guard);
        assert!(!older_task.await.unwrap().unwrap());
        assert!(newer_task.await.unwrap().unwrap());
        assert_eq!(store.load_file_drafts().await.unwrap().unwrap(), b"newer");
        // A timed-out write already dequeued by the worker cancels its state and skips
        // disk I/O once the lock frees.
        let guard = store.lock_file_drafts();
        let timed_out = tokio::spawn(store.start_file_drafts_save_with_timeout(
            b"timed-out".to_vec(),
            std::time::Duration::from_millis(500),
        ));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !store.file_draft_worker_running() || store.file_draft_pending() {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        assert!(timed_out.await.unwrap().is_err());
        drop(guard);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while store.file_draft_worker_running() || store.files_refcount() > 1 {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        assert_eq!(store.load_file_drafts().await.unwrap().unwrap(), b"newer");
        // An already-expired deadline is rejected directly by the worker without publishing.
        let expired = store.start_file_drafts_save_with_deadlines(
            b"already-expired".to_vec(),
            std::time::Instant::now() - std::time::Duration::from_millis(1),
            std::time::Duration::from_secs(3),
        );
        assert!(matches!(expired.await, Ok(false)));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while store.file_draft_worker_running() || store.files_refcount() > 1 {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        assert_eq!(store.load_file_drafts().await.unwrap().unwrap(), b"newer");
    });
    drop(store);
    crate::platform::block_on(async {
        let reopened = super::Store::open(path).await.unwrap();
        assert_eq!(
            reopened.load_file_drafts().await.unwrap().unwrap(),
            b"newer"
        );
    });
}

#[test]
fn pre_rename_staleness_cancels_publication_and_removes_temp_file() {
    let root = Root::new();
    let files = root.open();
    assert!(
        files
            .save_file_with(
                "workspace-file-drafts.json",
                super::FILE_DRAFT_BYTES,
                b"kept",
                || true,
                |tmp, dst| {
                    fs::rename(tmp, dst)?;
                    Ok(true)
                },
            )
            .unwrap()
    );
    let checks = std::cell::Cell::new(0usize);
    let published = files
        .save_file_with(
            "workspace-file-drafts.json",
            super::FILE_DRAFT_BYTES,
            b"stale-after-sync",
            || {
                checks.set(checks.get() + 1);
                true
            },
            |_, _| {
                checks.set(checks.get() + 1);
                Ok(false)
            },
        )
        .unwrap();
    assert!(!published);
    assert_eq!(checks.get(), 2);
    assert_eq!(
        fs::read(root.0.join("rune/workspace-file-drafts.json")).unwrap(),
        b"kept"
    );
    // Only state.lock and workspace-file-drafts.json remain; the temporary file is removed.
    assert_eq!(fs::read_dir(root.0.join("rune")).unwrap().count(), 2);
}
