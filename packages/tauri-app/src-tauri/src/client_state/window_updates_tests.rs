use super::*;
use serde_json::{json, Value};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(5);

fn bounds(x: i32) -> WindowBounds {
    WindowBounds {
        x,
        y: 20,
        width: 1200,
        height: 800,
    }
}

fn geometry(x: i32) -> WindowGeometry {
    WindowGeometry {
        bounds: Some(bounds(x)),
        maximized: false,
        fullscreen: false,
    }
}

fn capture(state: &ClientState, id: &str, x: i32) -> bool {
    state.capture_window_geometry(id, || geometry(x))
}

fn read_state(state: &ClientState) -> Value {
    serde_json::from_slice(&fs::read(&state.state_path).unwrap()).unwrap()
}

#[test]
fn captures_do_not_wait_for_disk_and_latest_geometry_is_flushed() {
    let directory = tempfile::tempdir().unwrap();
    let block = Arc::new(AtomicBool::new(false));
    let writer_block = Arc::clone(&block);
    let (entered, entries) = mpsc::channel();
    let (release, releases) = mpsc::channel();
    let releases = Mutex::new(releases);
    let state = Arc::new(
        ClientState::initialize_at_with_writer(
            directory.path(),
            Arc::new(move |path, bytes, valid| {
                if writer_block.swap(false, Ordering::SeqCst) {
                    entered.send(()).unwrap();
                    releases.lock().unwrap().recv_timeout(TIMEOUT * 2).unwrap();
                }
                crate::client_state::write_atomically(path, bytes, valid)
            }),
        )
        .unwrap(),
    );
    let id = state.active_window_id().unwrap();
    assert!(capture(&state, &id, 1));
    block.store(true, Ordering::SeqCst);
    let writing = Arc::clone(&state);
    let writer = thread::spawn(move || writing.flush().unwrap());
    entries.recv_timeout(TIMEOUT).unwrap();
    let capturing = Arc::clone(&state);
    let window_id = id.clone();
    let (done, completion) = mpsc::channel();
    let events = thread::spawn(move || {
        for x in 2..=1_000 {
            assert!(capture(&capturing, &window_id, x));
        }
        done.send(()).unwrap();
    });
    // A stalled fsync is released only AFTER move/resize handlers finish.
    let captured = completion.recv_timeout(TIMEOUT);
    release.send(()).unwrap();
    writer.join().unwrap();
    events.join().unwrap();
    captured.unwrap();
    assert_eq!(state.pending_windows.lock().unwrap().latest.len(), 1);
    assert_eq!(
        read_state(&state)["windows"][&id]["window"]["bounds"]["x"],
        1
    );
    state.flush().unwrap();
    assert_eq!(
        read_state(&state)["windows"][&id]["window"]["bounds"]["x"],
        1_000
    );
}

#[test]
fn native_getters_run_without_any_client_state_lock() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    let id = state.active_window_id().unwrap();
    assert!(state.capture_window_geometry(&id, || {
        assert!(
            state.write_lock.try_lock().is_ok(),
            "native getter holds disk lock"
        );
        assert!(
            state.state.try_lock().is_ok(),
            "native getter holds state lock"
        );
        assert!(
            state.zoom_levels.try_lock().is_ok(),
            "native getter holds zoom lock"
        );
        assert!(
            state.pending_windows.try_lock().is_ok(),
            "native getter holds mailbox lock"
        );
        geometry(10)
    }));
}

#[test]
fn background_native_capture_cannot_deadlock_main_thread_move_event() {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(ClientState::initialize_at(directory.path()).unwrap());
    let id = state.active_window_id().unwrap();
    let background_state = Arc::clone(&state);
    let background_id = id.clone();
    let (requested, requests) = mpsc::channel();
    let (release, releases) = mpsc::channel();
    let background = thread::spawn(move || {
        background_state.capture_window_geometry(&background_id, || {
            // Wry getters dispatch to the UI event loop then wait for its reply.
            requested.send(()).unwrap();
            releases.recv_timeout(TIMEOUT * 2).unwrap();
            geometry(30)
        })
    });
    requests.recv_timeout(TIMEOUT).unwrap();
    let ui_state = Arc::clone(&state);
    let ui_id = id.clone();
    let (done, completion) = mpsc::channel();
    let ui = thread::spawn(move || {
        assert!(capture(&ui_state, &ui_id, 20));
        done.send(()).unwrap();
    });
    let ui_free = completion.recv_timeout(TIMEOUT);
    // Break a regressed cycle from the controller so the test never hangs forever.
    release.send(()).unwrap();
    assert!(background.join().unwrap());
    ui.join().unwrap();
    ui_free.unwrap();
    state.flush().unwrap();
    assert_eq!(
        read_state(&state)["windows"][&id]["window"]["bounds"],
        json!(bounds(30))
    );
}

#[test]
fn maximization_preserves_latest_normal_bounds_and_windows_stay_independent() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    let first = state.active_window_id().unwrap();
    let second = uuid::Uuid::new_v4().to_string();
    state.add_window(second.clone()).unwrap();
    state
        .save_snapshot_guarded_for(&first, json!({ "draft": "keep" }), || true)
        .unwrap();
    assert!(capture(&state, &first, 30));
    assert!(capture(&state, &first, 90));
    assert!(state.queue_window_capture(&first, None, true, false, 1.5));
    assert!(capture(&state, &second, 60));
    for _ in 0..1_000 {
        assert!(!capture(&state, &uuid::Uuid::new_v4().to_string(), 0));
    }
    assert_eq!(state.pending_windows.lock().unwrap().latest.len(), 2);
    state.flush().unwrap();
    let saved = read_state(&state);
    assert_eq!(
        saved["windows"][&first]["snapshot"],
        json!({ "draft": "keep" })
    );
    assert_eq!(
        saved["windows"][&first]["window"],
        json!({
            "bounds": bounds(90), "maximized": true, "fullscreen": false, "zoomFactor": 1.5
        })
    );
    assert_eq!(
        saved["windows"][&second]["window"]["bounds"],
        json!(bounds(60))
    );
    // Fullscreen, minimized or unavailable normal bounds retain the last geometry.
    assert!(state.queue_window_capture(&first, None, false, true, 1.5));
    state.flush().unwrap();
    assert_eq!(
        read_state(&state)["windows"][&first]["window"]["bounds"],
        json!(bounds(90))
    );
}

#[test]
fn clear_disable_and_removal_invalidate_pending_geometry() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    let id = state.active_window_id().unwrap();
    for clear in [false, true] {
        assert!(capture(&state, &id, 70));
        if clear {
            state.clear().unwrap();
        } else {
            state.set_restore_enabled(false).unwrap();
        }
        assert!(!capture(&state, &id, 80));
        state.set_restore_enabled(true).unwrap();
        state.flush().unwrap();
        assert!(read_state(&state)["windows"][&id].get("window").is_none());
    }
    assert!(capture(&state, &id, 90));
    state.remove_window(&id).unwrap();
    assert!(!capture(&state, &id, 100));
    state.add_window(id.clone()).unwrap();
    state.flush().unwrap();
    assert!(read_state(&state)["windows"][&id].get("window").is_none());
}

#[test]
fn failed_writes_keep_captures_retryable_without_overwriting_newer_events() {
    let directory = tempfile::tempdir().unwrap();
    let fail = Arc::new(AtomicBool::new(false));
    let writer_fail = Arc::clone(&fail);
    let state = ClientState::initialize_at_with_writer(
        directory.path(),
        Arc::new(move |path, bytes, valid| {
            if writer_fail.load(Ordering::SeqCst) {
                return Err("simulated fsync failure".into());
            }
            crate::client_state::write_atomically(path, bytes, valid)
        }),
    )
    .unwrap();
    let id = state.active_window_id().unwrap();
    assert!(capture(&state, &id, 20));
    state.flush().unwrap();
    fail.store(true, Ordering::SeqCst);
    assert!(capture(&state, &id, 40));
    assert!(state.flush().is_err());
    assert_eq!(
        read_state(&state)["windows"][&id]["window"]["bounds"],
        json!(bounds(20))
    );
    fail.store(false, Ordering::SeqCst);
    state.flush().unwrap();
    assert_eq!(
        read_state(&state)["windows"][&id]["window"]["bounds"],
        json!(bounds(40))
    );
    fail.store(true, Ordering::SeqCst);
    assert!(capture(&state, &id, 60));
    assert!(state.flush().is_err());
    assert!(capture(&state, &id, 80));
    fail.store(false, Ordering::SeqCst);
    state.flush().unwrap();
    assert_eq!(
        read_state(&state)["windows"][&id]["window"]["bounds"],
        json!(bounds(80))
    );
}

#[test]
fn failed_record_mutations_roll_back_queued_geometry_too() {
    let directory = tempfile::tempdir().unwrap();
    let fail = Arc::new(AtomicBool::new(false));
    let writer_fail = Arc::clone(&fail);
    let state = ClientState::initialize_at_with_writer(
        directory.path(),
        Arc::new(move |path, bytes, valid| {
            if writer_fail.load(Ordering::SeqCst) {
                return Err("simulated publication failure".into());
            }
            crate::client_state::write_atomically(path, bytes, valid)
        }),
    )
    .unwrap();
    let id = state.active_window_id().unwrap();
    for operation in 0..3 {
        assert!(capture(&state, &id, 10 + operation));
        fail.store(true, Ordering::SeqCst);
        let result = match operation {
            0 => state.clear(),
            1 => state.set_restore_enabled(false),
            _ => state.remove_window(&id),
        };
        assert!(result.is_err());
        fail.store(false, Ordering::SeqCst);
        state.flush().unwrap();
        assert_eq!(
            read_state(&state)["windows"][&id]["window"]["bounds"],
            json!(bounds(10 + operation))
        );
    }
}

#[test]
fn release_drains_even_a_capture_whose_wakeup_has_not_been_sent() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    let id = state.active_window_id().unwrap();
    assert!(capture(&state, &id, 120));
    state.release_locks();
    assert_eq!(
        read_state(&state)["windows"][&id]["window"]["bounds"],
        json!(bounds(120))
    );
    assert!(!capture(&state, &id, 130));
    state
        .window_flush
        .schedule(|| panic!("worker restarted after release"))
        .unwrap();
    state.release_locks();
    let successor = ClientState::initialize_at(directory.path()).unwrap();
    assert!(successor.is_primary());
    assert_eq!(
        read_state(&successor)["windows"][&id]["window"]["bounds"],
        json!(bounds(120))
    );
}

#[test]
fn release_retries_a_failed_flush_even_after_captures_were_merged() {
    let directory = tempfile::tempdir().unwrap();
    let fail = Arc::new(AtomicBool::new(false));
    let writer_fail = Arc::clone(&fail);
    let state = ClientState::initialize_at_with_writer(
        directory.path(),
        Arc::new(move |path, bytes, valid| {
            if writer_fail.swap(false, Ordering::SeqCst) {
                return Err("transient publication failure".into());
            }
            crate::client_state::write_atomically(path, bytes, valid)
        }),
    )
    .unwrap();
    let id = state.active_window_id().unwrap();
    assert!(capture(&state, &id, 42));
    fail.store(true, Ordering::SeqCst);
    assert!(state.flush().is_err());
    assert!(state.pending_windows.lock().unwrap().latest.is_empty());
    state.release_locks();
    assert_eq!(
        read_state(&state)["windows"][&id]["window"]["bounds"],
        json!(bounds(42))
    );
}

#[test]
fn scheduled_flush_drains_trailing_events_before_ownership_handoff() {
    let directory = tempfile::tempdir().unwrap();
    let block = Arc::new(AtomicBool::new(false));
    let writer_block = Arc::clone(&block);
    let (entered, entries) = mpsc::channel();
    let (release, releases) = mpsc::channel();
    let releases = Mutex::new(releases);
    let state = Arc::new(
        ClientState::initialize_at_with_writer(
            directory.path(),
            Arc::new(move |path, bytes, valid| {
                if writer_block.swap(false, Ordering::SeqCst) {
                    entered.send(()).unwrap();
                    releases.lock().unwrap().recv_timeout(TIMEOUT * 2).unwrap();
                }
                crate::client_state::write_atomically(path, bytes, valid)
            }),
        )
        .unwrap(),
    );
    let id = state.active_window_id().unwrap();
    assert!(capture(&state, &id, 10));
    block.store(true, Ordering::SeqCst);
    let writing = Arc::clone(&state);
    state
        .window_flush
        .schedule(move || writing.flush().unwrap())
        .unwrap();
    entries.recv_timeout(TIMEOUT).unwrap();
    assert!(capture(&state, &id, 20));
    let writing = Arc::clone(&state);
    state
        .window_flush
        .schedule(move || writing.flush().unwrap())
        .unwrap();
    release.send(()).unwrap();
    state.release_locks();
    assert!(!capture(&state, &id, 30));
    let successor = ClientState::initialize_at(directory.path()).unwrap();
    assert!(successor.is_primary());
    assert_eq!(
        read_state(&successor)["windows"][&id]["window"]["bounds"],
        json!(bounds(20))
    );
}

#[test]
fn secondary_owner_and_future_envelope_cannot_publish_captures() {
    let directory = tempfile::tempdir().unwrap();
    let primary = ClientState::initialize_at(directory.path()).unwrap();
    primary.flush().unwrap();
    let secondary = ClientState::initialize_at(directory.path()).unwrap();
    let before = fs::read(&primary.state_path).unwrap();
    capture(&secondary, &secondary.active_window_id().unwrap(), 50);
    secondary.flush().unwrap();
    assert_eq!(fs::read(&primary.state_path).unwrap(), before);
    let id = primary.active_window_id().unwrap();
    primary.state.lock().unwrap().unsupported_future_envelope = true;
    assert!(!capture(&primary, &id, 60));
    primary.flush().unwrap();
    assert_eq!(fs::read(&primary.state_path).unwrap(), before);
}

#[test]
fn failed_publication_preserves_concurrent_captures_for_mutating_and_other_windows() {
    let directory = tempfile::tempdir().unwrap();
    let block = Arc::new(AtomicBool::new(false));
    let writer_block = Arc::clone(&block);
    let (entered, entries) = mpsc::channel();
    let (release, releases) = mpsc::channel();
    let releases = Mutex::new(releases);
    let state = Arc::new(
        ClientState::initialize_at_with_writer(
            directory.path(),
            Arc::new(move |path, bytes, valid| {
                if writer_block.swap(false, Ordering::SeqCst) {
                    entered.send(()).unwrap();
                    releases.lock().unwrap().recv_timeout(TIMEOUT * 2).unwrap();
                    return Err("simulated publication failure".into());
                }
                crate::client_state::write_atomically(path, bytes, valid)
            }),
        )
        .unwrap(),
    );
    let first = state.active_window_id().unwrap();
    let second = uuid::Uuid::new_v4().to_string();
    state.add_window(second.clone()).unwrap();
    state
        .zoom_levels
        .lock()
        .unwrap()
        .insert(second.clone(), 1.75);
    for operation in 0..4 {
        assert!(capture(&state, &first, 10 + operation));
        assert!(capture(&state, &second, 20));
        state.flush().unwrap();
        let writing = Arc::clone(&state);
        let id = first.clone();
        block.store(true, Ordering::SeqCst);
        let writer = thread::spawn(move || match operation {
            0 => writing.save_snapshot_guarded_for(&id, json!({"draft":"new"}), || true),
            1 => writing.clear_guarded(&id, || true),
            2 => writing.set_restore_enabled_guarded(&id, false, || true),
            _ => writing.remove_window(&id),
        });
        entries.recv_timeout(TIMEOUT).unwrap();
        let capturing = Arc::clone(&state);
        let id = second.clone();
        let changing_id = first.clone();
        let (done, completion) = mpsc::channel();
        let events = thread::spawn(move || {
            assert!(capture(&capturing, &id, 100 + operation));
            assert!(capture(&capturing, &changing_id, 200 + operation));
            done.send(()).unwrap();
        });
        let captured = completion.recv_timeout(TIMEOUT);
        release.send(()).unwrap();
        assert!(writer.join().unwrap().is_err());
        events.join().unwrap();
        captured.unwrap();
        state.flush().unwrap();
        let saved = read_state(&state);
        assert_eq!(
            saved["windows"][&first]["window"]["bounds"],
            json!(bounds(200 + operation))
        );
        assert_eq!(
            saved["windows"][&second]["window"]["bounds"],
            json!(bounds(100 + operation))
        );
        assert_eq!(saved["windows"][&second]["window"]["zoomFactor"], 1.75);
    }
}

#[test]
fn successful_destructive_publication_discards_speculative_captures() {
    let directory = tempfile::tempdir().unwrap();
    let during_write = Arc::new(Mutex::new(None::<std::sync::Weak<ClientState>>));
    let callback = Arc::clone(&during_write);
    let state = Arc::new(
        ClientState::initialize_at_with_writer(
            directory.path(),
            Arc::new(move |path, bytes, valid| {
                // The production capture doesn't acquire write_lock. Assert it can run
                // inside the publication adapter while the old admission policy is saved.
                if let Some(state) = callback
                    .lock()
                    .unwrap()
                    .take()
                    .and_then(|state| state.upgrade())
                {
                    let pending = state.pending_windows.lock().unwrap();
                    let id = pending.mutation.as_ref().unwrap().0.clone();
                    drop(pending);
                    let (done, completion) = mpsc::channel();
                    let capturing = thread::spawn(move || {
                        let _ = done.send(capture(&state, &id, 99));
                    });
                    // On a regression, return and release write_lock rather than leaving
                    // the test (or its capture thread) hung behind its own publication.
                    let captured = completion
                        .recv_timeout(TIMEOUT)
                        .map_err(|error| error.to_string())?;
                    capturing.join().unwrap();
                    assert!(captured);
                }
                crate::client_state::write_atomically(path, bytes, valid)
            }),
        )
        .unwrap(),
    );
    let id = state.active_window_id().unwrap();
    for operation in 0..3 {
        assert!(capture(&state, &id, 10));
        *during_write.lock().unwrap() = Some(Arc::downgrade(&state));
        match operation {
            0 => state.clear().unwrap(),
            1 => state.set_restore_enabled(false).unwrap(),
            _ => state.remove_window(&id).unwrap(),
        };
        assert!(state.pending_windows.lock().unwrap().latest.is_empty());
        if operation == 2 {
            state.add_window(id.clone()).unwrap();
        }
        state.set_restore_enabled(true).unwrap();
        state.flush().unwrap();
        assert!(read_state(&state)["windows"][&id].get("window").is_none());
    }
}
