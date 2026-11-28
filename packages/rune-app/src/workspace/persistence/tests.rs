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
    let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/rune-state-tests");
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
    let writes_before_inflight = rt.state.0.store.as_ref().unwrap().file_draft_write_count();
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
        || rt
            .state
            .0
            .store
            .as_ref()
            .is_some_and(|store| store.file_draft_worker_running() || store.files_refcount() > 1)
    {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(wakes.load(Ordering::SeqCst), 6);
    assert_eq!(
        rt.state.0.store.as_ref().unwrap().file_draft_write_count(),
        writes_before_inflight + 1
    );
    drop(rt);
    let loaded = crate::platform::block_on(async {
        let reopened = Store::open(root.0.join("rune")).await.unwrap();
        reopened.load_file_drafts().await.unwrap().unwrap()
    });
    assert_ne!(loaded, expected);
    assert_eq!(loaded, inflight_expected);
}

use crate::platform::storage::{
    RestoreMode, WebDepartInput, WebDepartKeys, WebDepartStorage, depart_web_state,
};

#[derive(Default)]
struct MemoryWebStorage {
    items: std::collections::BTreeMap<String, String>,
    fail_keys: std::collections::BTreeSet<String>,
}

impl WebDepartStorage for MemoryWebStorage {
    fn set_item(&mut self, key: &str, value: &str) -> std::result::Result<(), ()> {
        if self.fail_keys.contains(key) {
            return Err(());
        }
        self.items.insert(key.to_owned(), value.to_owned());
        Ok(())
    }
}

fn test_web_keys() -> WebDepartKeys<'static> {
    WebDepartKeys {
        state: "state",
        file_drafts: "file-drafts",
        released: "released",
    }
}

#[test]
fn web_pagehide_keeps_records_when_session_storage_quota_fails_after_clear() {
    let drafts = br#"[{"path":"src/lib.rs","text":"unsaved"}]"#;

    // After Web Clear (snapshot suppressed), a sessionStorage quota failure while persisting
    // pending file drafts must refuse to release server workspace records.
    let mut quota_store = MemoryWebStorage::default();
    quota_store.fail_keys.insert("file-drafts".to_owned());
    let release = depart_web_state(
        &mut quota_store,
        WebDepartInput {
            frozen: false,
            restore: RestoreMode::Enabled,
            snapshot_suppressed: true,
            snapshot: Some(b""),
            pending_file_drafts: Some(Some(drafts)),
            max_file_draft_bytes: 256 * 1024,
            keys: test_web_keys(),
        },
    );
    assert!(!release);
    assert!(quota_store.items.is_empty());

    // Oversized pending drafts, invalid UTF-8, or a contested borrow after Clear also retain records.
    let mut oversized_store = MemoryWebStorage::default();
    assert!(!depart_web_state(
        &mut oversized_store,
        WebDepartInput {
            frozen: false,
            restore: RestoreMode::Enabled,
            snapshot_suppressed: true,
            snapshot: Some(b""),
            pending_file_drafts: Some(Some(drafts)),
            max_file_draft_bytes: 4,
            keys: test_web_keys(),
        },
    ));
    assert!(oversized_store.items.is_empty());

    let mut invalid_utf8_store = MemoryWebStorage::default();
    assert!(!depart_web_state(
        &mut invalid_utf8_store,
        WebDepartInput {
            frozen: false,
            restore: RestoreMode::Enabled,
            snapshot_suppressed: true,
            snapshot: Some(b""),
            pending_file_drafts: Some(Some(&[0xff, 0xfe])),
            max_file_draft_bytes: 256 * 1024,
            keys: test_web_keys(),
        },
    ));
    assert!(invalid_utf8_store.items.is_empty());

    let mut borrow_failed_store = MemoryWebStorage::default();
    assert!(!depart_web_state(
        &mut borrow_failed_store,
        WebDepartInput {
            frozen: false,
            restore: RestoreMode::Enabled,
            snapshot_suppressed: true,
            snapshot: Some(b""),
            pending_file_drafts: None,
            max_file_draft_bytes: 256 * 1024,
            keys: test_web_keys(),
        },
    ));
    assert!(borrow_failed_store.items.is_empty());

    // Once sessionStorage accepts the pending file drafts after Clear, records may be released.
    let mut ok_clear_store = MemoryWebStorage::default();
    assert!(depart_web_state(
        &mut ok_clear_store,
        WebDepartInput {
            frozen: false,
            restore: RestoreMode::Enabled,
            snapshot_suppressed: true,
            snapshot: Some(b""),
            pending_file_drafts: Some(Some(drafts)),
            max_file_draft_bytes: 256 * 1024,
            keys: test_web_keys(),
        },
    ));
    assert_eq!(
        ok_clear_store.items.get("file-drafts").map(String::as_str),
        Some(std::str::from_utf8(drafts).unwrap())
    );
    assert!(!ok_clear_store.items.contains_key("state"));
    assert!(!ok_clear_store.items.contains_key("released"));

    // On a normal (unsuppressed) departure, failing to persist pending drafts also prevents
    // marking records released even if the workspace snapshot itself fits.
    let mut normal_quota_store = MemoryWebStorage::default();
    normal_quota_store
        .fail_keys
        .insert("file-drafts".to_owned());
    assert!(!depart_web_state(
        &mut normal_quota_store,
        WebDepartInput {
            frozen: false,
            restore: RestoreMode::Enabled,
            snapshot_suppressed: false,
            snapshot: Some(br#"{"tabs":[]}"#),
            pending_file_drafts: Some(Some(drafts)),
            max_file_draft_bytes: 256 * 1024,
            keys: test_web_keys(),
        },
    ));
    assert_eq!(
        normal_quota_store.items.get("state").map(String::as_str),
        Some(r#"{"tabs":[]}"#)
    );
    assert!(!normal_quota_store.items.contains_key("released"));

    // When both drafts and snapshot persist on normal departure, RELEASED is set and records release.
    let mut normal_ok_store = MemoryWebStorage::default();
    assert!(depart_web_state(
        &mut normal_ok_store,
        WebDepartInput {
            frozen: false,
            restore: RestoreMode::Enabled,
            snapshot_suppressed: false,
            snapshot: Some(br#"{"tabs":[]}"#),
            pending_file_drafts: Some(Some(drafts)),
            max_file_draft_bytes: 256 * 1024,
            keys: test_web_keys(),
        },
    ));
    assert_eq!(
        normal_ok_store.items.get("released").map(String::as_str),
        Some("1")
    );

    // Frozen or Unknown restore keeps records without touching storage; Disabled releases cleanly.
    let mut frozen_store = MemoryWebStorage::default();
    assert!(!depart_web_state(
        &mut frozen_store,
        WebDepartInput {
            frozen: true,
            restore: RestoreMode::Enabled,
            snapshot_suppressed: true,
            snapshot: Some(b""),
            pending_file_drafts: Some(Some(drafts)),
            max_file_draft_bytes: 256 * 1024,
            keys: test_web_keys(),
        },
    ));
    assert!(frozen_store.items.is_empty());

    let mut disabled_store = MemoryWebStorage::default();
    assert!(depart_web_state(
        &mut disabled_store,
        WebDepartInput {
            frozen: false,
            restore: RestoreMode::Disabled,
            snapshot_suppressed: false,
            snapshot: Some(br#"{"tabs":[]}"#),
            pending_file_drafts: Some(Some(drafts)),
            max_file_draft_bytes: 256 * 1024,
            keys: test_web_keys(),
        },
    ));
    assert!(disabled_store.items.is_empty());
}
