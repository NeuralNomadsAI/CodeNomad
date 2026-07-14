use super::commands::is_allowed_client_state_origin;
use super::process::{PRIMARY_LOCK_FILENAME, RUNNING_MARKER_PREFIX, RUNNING_MARKER_SUFFIX};
use super::window::{
    clamp_window_bounds, normalize_native_zoom_level, DisplayArea, NativeWindowState, WindowBounds,
    MAX_ZOOM_LEVEL,
};
use super::{
    parse_client_state, ClientState, ClientStateLoadResult, CLIENT_STATE_FILENAME,
    DEFAULT_ZOOM_LEVEL, MAX_CLIENT_SNAPSHOT_BYTES,
};
use serde_json::{json, Value};
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Barrier};
use std::thread;
use std::time::Duration;
use url::Url;

#[test]
fn invalid_or_old_state_uses_safe_defaults() {
    for value in [
        br#"not json"#.as_slice(),
        br#"{"version":0,"restoreEnabled":false,"snapshot":{"old":true}}"#.as_slice(),
        br#"{"version":1,"restoreEnabled":"no"}"#.as_slice(),
    ] {
        let state = parse_client_state(value);
        assert!(state.restore_enabled);
        assert_eq!(state.snapshot, None);
        assert!(!state.unsupported_future_envelope);
    }
}

#[test]
fn parses_and_normalizes_versioned_state() {
    let state = parse_client_state(
        br#"{"version":1,"restoreEnabled":false,"snapshot":{"folder":"work"},"window":{"bounds":{"x":20,"y":30,"width":1400,"height":900},"maximized":true,"fullscreen":false,"zoomFactor":20}}"#,
    );

    assert!(!state.restore_enabled);
    assert_eq!(state.snapshot, Some(json!({ "folder": "work" })));
    assert_eq!(state.window.unwrap().zoom_factor, MAX_ZOOM_LEVEL);
}

#[test]
fn normalizes_valid_native_zoom_levels() {
    assert_eq!(normalize_native_zoom_level(1.25), Some(1.25));
    assert_eq!(normalize_native_zoom_level(0.01), Some(0.25));
    assert_eq!(normalize_native_zoom_level(20.0), Some(MAX_ZOOM_LEVEL));
}

#[test]
fn rejects_invalid_native_zoom_levels() {
    for value in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(normalize_native_zoom_level(value), None);
    }
}

#[test]
fn disabled_restore_initializes_default_zoom() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join(CLIENT_STATE_FILENAME),
        br#"{"version":1,"restoreEnabled":false,"window":{"bounds":{"x":20,"y":30,"width":1400,"height":900},"maximized":false,"fullscreen":false,"zoomFactor":2}}"#,
    )
    .unwrap();

    let state = ClientState::initialize_at(directory.path()).unwrap();
    assert_eq!(*state.zoom_level.lock().unwrap(), DEFAULT_ZOOM_LEVEL);
    assert!(state.persistence_suppressed.load(Ordering::SeqCst));
    let disabled_bytes = fs::read(directory.path().join(CLIENT_STATE_FILENAME)).unwrap();
    assert!(state.save_snapshot(json!({ "ignored": true })).unwrap());
    assert_eq!(
        fs::read(directory.path().join(CLIENT_STATE_FILENAME)).unwrap(),
        disabled_bytes
    );
}

#[test]
fn disabling_restore_atomically_clears_persisted_snapshot_and_window() {
    let directory = tempfile::tempdir().unwrap();
    let state_path = directory.path().join(CLIENT_STATE_FILENAME);
    fs::write(
        &state_path,
        br#"{"version":1,"restoreEnabled":true,"snapshot":{"kept":true},"window":{"bounds":{"x":20,"y":30,"width":1400,"height":900},"maximized":true,"fullscreen":false,"zoomFactor":2}}"#,
    )
    .unwrap();
    let write_count = Arc::new(AtomicUsize::new(0));
    let write_count_for_writer = Arc::clone(&write_count);
    let state = ClientState::initialize_at_with_writer(
        directory.path(),
        Arc::new(move |path, bytes| {
            write_count_for_writer.fetch_add(1, Ordering::SeqCst);
            super::write_atomically(path, bytes)
        }),
    )
    .unwrap();

    assert!(state.set_restore_enabled(false).unwrap());
    assert_eq!(write_count.load(Ordering::SeqCst), 1);

    let persisted = parse_client_state(&fs::read(&state_path).unwrap());
    assert!(!persisted.restore_enabled);
    assert_eq!(persisted.snapshot, None);
    assert_eq!(persisted.window, None);
    let disabled_bytes = fs::read(&state_path).unwrap();
    assert!(state.save_snapshot(json!({ "ignored": true })).unwrap());
    assert_eq!(fs::read(state_path).unwrap(), disabled_bytes);
    assert_eq!(write_count.load(Ordering::SeqCst), 1);
}

#[test]
fn moves_offscreen_bounds_to_nearest_monitor_work_area() {
    let bounds = WindowBounds {
        x: 4000,
        y: 2000,
        width: 1400,
        height: 900,
    };
    let displays = [DisplayArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    }];

    assert_eq!(
        clamp_window_bounds(&bounds, &displays),
        Some(WindowBounds {
            x: 520,
            y: 180,
            width: 1400,
            height: 900,
        })
    );
}

#[test]
fn clamps_window_size_to_selected_monitor() {
    let bounds = WindowBounds {
        x: -2000,
        y: 100,
        width: 3000,
        height: 300,
    };
    let displays = [
        DisplayArea {
            x: -1280,
            y: 0,
            width: 1280,
            height: 1024,
        },
        DisplayArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        },
    ];

    assert_eq!(
        clamp_window_bounds(&bounds, &displays),
        Some(WindowBounds {
            x: -1280,
            y: 100,
            width: 1280,
            height: 600,
        })
    );
}

#[test]
fn existing_unlocked_lock_and_marker_files_are_recovered() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join(PRIMARY_LOCK_FILENAME),
        br#"{"pid":999999}"#,
    )
    .unwrap();
    let stale_marker = directory.path().join(format!(
        "{RUNNING_MARKER_PREFIX}stale{RUNNING_MARKER_SUFFIX}"
    ));
    fs::write(&stale_marker, b"").unwrap();

    let state = ClientState::initialize_at(directory.path()).unwrap();
    assert!(state.is_primary());
    assert!(!stale_marker.exists());
}

#[test]
fn simultaneous_clients_elect_exactly_one_primary() {
    let directory = tempfile::tempdir().unwrap();
    let start = Arc::new(Barrier::new(3));
    let release = Arc::new(Barrier::new(3));
    let (sender, receiver) = mpsc::channel();
    let mut handles = Vec::new();

    for _ in 0..2 {
        let path = directory.path().to_path_buf();
        let start = Arc::clone(&start);
        let release = Arc::clone(&release);
        let sender = sender.clone();
        handles.push(thread::spawn(move || {
            start.wait();
            let state = ClientState::initialize_at(&path).unwrap();
            sender.send(state.is_primary()).unwrap();
            release.wait();
            drop(state);
        }));
    }
    drop(sender);

    start.wait();
    let roles = [receiver.recv().unwrap(), receiver.recv().unwrap()];
    release.wait();
    for handle in handles {
        handle.join().unwrap();
    }

    assert_eq!(
        roles.into_iter().filter(|is_primary| *is_primary).count(),
        1
    );
}

#[test]
fn primary_role_recovers_after_all_participants_drop() {
    let directory = tempfile::tempdir().unwrap();
    let primary = ClientState::initialize_at(directory.path()).unwrap();
    let secondary = ClientState::initialize_at(directory.path()).unwrap();
    assert!(primary.is_primary());
    assert!(!secondary.is_primary());

    drop(primary);
    let waiting = ClientState::initialize_at(directory.path()).unwrap();
    assert!(!waiting.is_primary());

    drop(secondary);
    drop(waiting);
    let recovered = ClientState::initialize_at(directory.path()).unwrap();
    assert!(recovered.is_primary());
}

#[test]
fn third_client_remains_secondary_after_primary_drops_while_secondary_lives() {
    let directory = tempfile::tempdir().unwrap();
    let primary = ClientState::initialize_at(directory.path()).unwrap();
    assert!(primary.save_snapshot(json!({ "restore": true })).unwrap());
    let secondary = ClientState::initialize_at(directory.path()).unwrap();

    drop(primary);
    let third = ClientState::initialize_at(directory.path()).unwrap();

    assert!(!secondary.is_primary());
    assert_eq!(
        third.load().unwrap(),
        ClientStateLoadResult {
            is_primary: false,
            restore_enabled: true,
            snapshot: Value::Null,
        }
    );
}

#[test]
fn concurrent_successors_remain_secondary_while_an_older_secondary_lives() {
    let directory = tempfile::tempdir().unwrap();
    let primary = ClientState::initialize_at(directory.path()).unwrap();
    let secondary = ClientState::initialize_at(directory.path()).unwrap();
    drop(primary);

    let start = Arc::new(Barrier::new(3));
    let release = Arc::new(Barrier::new(3));
    let (sender, receiver) = mpsc::channel();
    let mut handles = Vec::new();
    for _ in 0..2 {
        let path = directory.path().to_path_buf();
        let start = Arc::clone(&start);
        let release = Arc::clone(&release);
        let sender = sender.clone();
        handles.push(thread::spawn(move || {
            start.wait();
            let state = ClientState::initialize_at(&path).unwrap();
            sender.send(state.is_primary()).unwrap();
            release.wait();
            drop(state);
        }));
    }
    drop(sender);

    start.wait();
    let roles = [receiver.recv().unwrap(), receiver.recv().unwrap()];
    release.wait();
    for handle in handles {
        handle.join().unwrap();
    }
    drop(secondary);

    assert_eq!(roles, [false, false]);
}

#[test]
fn secondary_never_reads_or_writes_primary_state() {
    let directory = tempfile::tempdir().unwrap();
    let primary = ClientState::initialize_at(directory.path()).unwrap();
    assert!(primary.save_snapshot(json!({ "kept": true })).unwrap());
    let state_path = directory.path().join(CLIENT_STATE_FILENAME);
    let original = fs::read(&state_path).unwrap();

    let secondary = ClientState::initialize_at(directory.path()).unwrap();
    assert_eq!(
        secondary.load().unwrap(),
        ClientStateLoadResult {
            is_primary: false,
            restore_enabled: true,
            snapshot: Value::Null,
        }
    );
    assert!(!secondary.save_snapshot(json!({ "replace": true })).unwrap());
    assert!(!secondary.set_restore_enabled(false).unwrap());
    assert!(!secondary.clear().unwrap());
    assert_eq!(fs::read(state_path).unwrap(), original);
}

#[test]
fn disabled_primary_loads_role_and_setting_while_writes_are_noops() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    assert!(state.save_snapshot(json!({ "removed": true })).unwrap());
    assert!(state.set_restore_enabled(false).unwrap());
    let state_path = directory.path().join(CLIENT_STATE_FILENAME);
    let disabled = fs::read(&state_path).unwrap();

    assert_eq!(
        state.load().unwrap(),
        ClientStateLoadResult {
            is_primary: true,
            restore_enabled: false,
            snapshot: Value::Null,
        }
    );
    assert!(state.save_snapshot(json!({ "ignored": true })).unwrap());
    assert_eq!(fs::read(state_path).unwrap(), disabled);
}

#[test]
fn failed_restore_setting_write_rolls_memory_back() {
    let directory = tempfile::tempdir().unwrap();
    let fail_writes = Arc::new(AtomicBool::new(false));
    let fail_writes_for_writer = Arc::clone(&fail_writes);
    let state = ClientState::initialize_at_with_writer(
        directory.path(),
        Arc::new(move |path, bytes| {
            if fail_writes_for_writer.load(Ordering::SeqCst) {
                Err("injected write failure".to_string())
            } else {
                super::write_atomically(path, bytes)
            }
        }),
    )
    .unwrap();
    assert!(state.save_snapshot(json!({ "kept": true })).unwrap());
    state.state.lock().unwrap().window = Some(NativeWindowState {
        bounds: WindowBounds {
            x: 20,
            y: 30,
            width: 1400,
            height: 900,
        },
        maximized: true,
        fullscreen: false,
        zoom_factor: 2.0,
    });
    fail_writes.store(true, Ordering::SeqCst);

    assert_eq!(
        state.set_restore_enabled(false).unwrap_err(),
        "injected write failure"
    );
    assert_eq!(
        state.load().unwrap(),
        ClientStateLoadResult {
            is_primary: true,
            restore_enabled: true,
            snapshot: json!({ "kept": true }),
        }
    );
    assert!(state.state.lock().unwrap().window.is_some());
    assert!(!state.persistence_suppressed.load(Ordering::SeqCst));
    assert!(
        parse_client_state(&fs::read(directory.path().join(CLIENT_STATE_FILENAME)).unwrap())
            .restore_enabled
    );
    fail_writes.store(false, Ordering::SeqCst);
    assert!(state.save_snapshot(json!({ "replacement": true })).unwrap());
}

#[test]
fn failed_clear_restores_snapshot_and_suppression_flag() {
    let directory = tempfile::tempdir().unwrap();
    let fail_writes = Arc::new(AtomicBool::new(false));
    let fail_writes_for_writer = Arc::clone(&fail_writes);
    let state = ClientState::initialize_at_with_writer(
        directory.path(),
        Arc::new(move |path, bytes| {
            if fail_writes_for_writer.load(Ordering::SeqCst) {
                Err("injected write failure".to_string())
            } else {
                super::write_atomically(path, bytes)
            }
        }),
    )
    .unwrap();
    assert!(state.save_snapshot(json!({ "kept": true })).unwrap());
    fail_writes.store(true, Ordering::SeqCst);

    assert_eq!(state.clear().unwrap_err(), "injected write failure");

    fail_writes.store(false, Ordering::SeqCst);
    assert_eq!(state.load().unwrap().snapshot, json!({ "kept": true }));
    assert!(!state.persistence_suppressed.load(Ordering::SeqCst));
    assert!(state.save_snapshot(json!({ "replacement": true })).unwrap());
    assert_eq!(
        state.load().unwrap().snapshot,
        json!({ "replacement": true })
    );
}

#[test]
fn failed_restore_reenable_keeps_successful_clear_suppression_active() {
    let directory = tempfile::tempdir().unwrap();
    let fail_writes = Arc::new(AtomicBool::new(false));
    let fail_writes_for_writer = Arc::clone(&fail_writes);
    let state = ClientState::initialize_at_with_writer(
        directory.path(),
        Arc::new(move |path, bytes| {
            if fail_writes_for_writer.load(Ordering::SeqCst) {
                Err("injected write failure".to_string())
            } else {
                super::write_atomically(path, bytes)
            }
        }),
    )
    .unwrap();
    assert!(state.save_snapshot(json!({ "cleared": true })).unwrap());
    assert!(state.clear().unwrap());
    fail_writes.store(true, Ordering::SeqCst);

    assert_eq!(
        state.set_restore_enabled(true).unwrap_err(),
        "injected write failure"
    );
    assert!(state.save_snapshot(json!({ "ignored": true })).unwrap());
    assert_eq!(state.load().unwrap().snapshot, Value::Null);
}

#[test]
fn future_envelope_is_preserved_until_clear_replaces_and_unblocks_it() {
    let directory = tempfile::tempdir().unwrap();
    let state_path = directory.path().join(CLIENT_STATE_FILENAME);
    let future = br#"{"version":2,"restoreEnabled":false,"snapshot":{"future":true},"window":{"future":true},"extension":{"keep":"exactly"}}"#;
    fs::write(&state_path, future).unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();

    assert!(state.state.lock().unwrap().unsupported_future_envelope);
    assert_eq!(
        state.load().unwrap(),
        ClientStateLoadResult {
            is_primary: true,
            restore_enabled: true,
            snapshot: Value::Null,
        }
    );
    assert!(!state.set_restore_enabled(false).unwrap());
    assert!(!state.set_restore_enabled(true).unwrap());
    assert!(state
        .save_snapshot(Value::String("x".repeat(MAX_CLIENT_SNAPSHOT_BYTES)))
        .unwrap());
    state.state.lock().unwrap().window = Some(NativeWindowState {
        bounds: WindowBounds {
            x: 20,
            y: 30,
            width: 1400,
            height: 900,
        },
        maximized: true,
        fullscreen: false,
        zoom_factor: 2.0,
    });
    state.flush().unwrap();
    assert_eq!(fs::read(&state_path).unwrap(), future);

    drop(state);
    let state = ClientState::initialize_at(directory.path()).unwrap();
    assert_eq!(
        state.load().unwrap(),
        ClientStateLoadResult {
            is_primary: true,
            restore_enabled: true,
            snapshot: Value::Null,
        }
    );
    assert_eq!(fs::read(&state_path).unwrap(), future);

    assert!(state.clear().unwrap());
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&state_path).unwrap()).unwrap(),
        json!({ "version": 1, "restoreEnabled": true })
    );
    assert!(!state.state.lock().unwrap().unsupported_future_envelope);
    assert!(!state.persistence_suppressed.load(Ordering::SeqCst));
    assert!(state.save_snapshot(json!({ "afterClear": true })).unwrap());
    assert_eq!(
        state.load().unwrap().snapshot,
        json!({ "afterClear": true })
    );
}

#[test]
fn failed_future_envelope_clear_preserves_file_and_write_suppression() {
    let directory = tempfile::tempdir().unwrap();
    let state_path = directory.path().join(CLIENT_STATE_FILENAME);
    let future = br#"{"version":9,"futureField":{"must":"survive"}}"#;
    fs::write(&state_path, future).unwrap();
    let fail_writes = Arc::new(AtomicBool::new(true));
    let write_count = Arc::new(AtomicUsize::new(0));
    let fail_writes_for_writer = Arc::clone(&fail_writes);
    let write_count_for_writer = Arc::clone(&write_count);
    let state = ClientState::initialize_at_with_writer(
        directory.path(),
        Arc::new(move |path, bytes| {
            write_count_for_writer.fetch_add(1, Ordering::SeqCst);
            if fail_writes_for_writer.load(Ordering::SeqCst) {
                Err("injected write failure".to_string())
            } else {
                super::write_atomically(path, bytes)
            }
        }),
    )
    .unwrap();

    assert_eq!(state.clear().unwrap_err(), "injected write failure");
    assert_eq!(fs::read(&state_path).unwrap(), future);
    assert!(state.state.lock().unwrap().unsupported_future_envelope);
    assert!(!state.set_restore_enabled(false).unwrap());
    assert!(state.save_snapshot(json!({ "ignored": true })).unwrap());
    state.flush().unwrap();
    assert_eq!(write_count.load(Ordering::SeqCst), 1);

    fail_writes.store(false, Ordering::SeqCst);
    assert!(state.clear().unwrap());
    assert!(state.save_snapshot(json!({ "accepted": true })).unwrap());
    assert_eq!(write_count.load(Ordering::SeqCst), 3);
}

#[test]
fn renderer_access_requires_a_claimed_matching_nonempty_token() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    let renderer_a = Url::parse("http://127.0.0.1:43123/workspace").unwrap();
    let renderer_b = Url::parse("http://127.0.0.1:43124/workspace").unwrap();

    assert!(state.claim_renderer_access("", &renderer_a).is_err());
    assert!(state.validate_renderer_access("", &renderer_a).is_err());
    assert!(state
        .validate_renderer_access("renderer-a", &renderer_a)
        .is_err());
    state
        .claim_renderer_access("renderer-a", &renderer_a)
        .unwrap();
    state
        .validate_renderer_access("renderer-a", &renderer_a)
        .unwrap();
    state
        .claim_renderer_access("renderer-a", &renderer_a)
        .unwrap();
    assert!(state
        .claim_renderer_access("renderer-b", &renderer_a)
        .is_err());
    assert!(state
        .validate_renderer_access("renderer-b", &renderer_a)
        .is_err());
    assert!(state
        .validate_renderer_access("renderer-a", &renderer_b)
        .is_err());

    state.begin_renderer_navigation(Some(&renderer_b)).unwrap();
    state
        .validate_renderer_access("renderer-a", &renderer_a)
        .unwrap();
    state
        .claim_renderer_access("renderer-b", &renderer_b)
        .unwrap();
    state
        .validate_renderer_access("renderer-b", &renderer_b)
        .unwrap();
}

#[test]
fn navigation_token_rotation_preserves_the_outgoing_renderers_latest_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    let outgoing_url = Url::parse("http://127.0.0.1:43123/workspace").unwrap();
    let incoming_url = Url::parse("http://127.0.0.1:43124/workspace").unwrap();

    state
        .claim_renderer_access("outgoing-document", &outgoing_url)
        .unwrap();
    state
        .validate_renderer_access("outgoing-document", &outgoing_url)
        .unwrap();
    assert!(!is_allowed_client_state_origin(
        &outgoing_url,
        Some(incoming_url.as_str()),
    ));
    state
        .validate_renderer_access("outgoing-document", &outgoing_url)
        .unwrap();
    assert!(state.renderer_origin_can_claim(&outgoing_url));
    assert!(state
        .save_snapshot(json!({ "revision": 7, "editor": "latest" }))
        .unwrap());

    state
        .begin_renderer_navigation(Some(&incoming_url))
        .unwrap();
    state
        .validate_renderer_access("outgoing-document", &outgoing_url)
        .unwrap();
    assert!(state
        .save_snapshot(json!({ "revision": 8, "editor": "flushed" }))
        .unwrap());
    state
        .claim_renderer_access("new-document", &incoming_url)
        .unwrap();
    state
        .validate_renderer_access("new-document", &incoming_url)
        .unwrap();
    assert!(state
        .validate_renderer_access("outgoing-document", &outgoing_url)
        .is_err());
    assert_eq!(
        state.load().unwrap().snapshot,
        json!({ "revision": 8, "editor": "flushed" })
    );
}

#[test]
fn opaque_renderer_urls_cannot_share_client_state_authority() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    let app_url = Url::parse("tauri://localhost/loading.html").unwrap();
    let asset_url = Url::parse("asset://localhost/loading.html").unwrap();
    let file_url = Url::parse("file:///tmp/loading.html").unwrap();
    let about_url = Url::parse("about:blank").unwrap();

    state.claim_renderer_access("app", &app_url).unwrap();
    state.validate_renderer_access("app", &app_url).unwrap();
    assert!(state.validate_renderer_access("app", &asset_url).is_err());
    assert!(state.claim_renderer_access("file", &file_url).is_err());
    assert!(state.claim_renderer_access("about", &about_url).is_err());
}

#[test]
fn ownership_release_drains_active_write_and_blocks_later_writes() {
    let directory = tempfile::tempdir().unwrap();
    let write_count = Arc::new(AtomicUsize::new(0));
    let write_count_for_writer = Arc::clone(&write_count);
    let (write_started_tx, write_started_rx) = mpsc::sync_channel(0);
    let (allow_write_tx, allow_write_rx) = mpsc::sync_channel(0);
    let allow_write_rx = std::sync::Mutex::new(allow_write_rx);
    let state = Arc::new(
        ClientState::initialize_at_with_writer(
            directory.path(),
            Arc::new(move |path, bytes| {
                write_count_for_writer.fetch_add(1, Ordering::SeqCst);
                write_started_tx.send(()).unwrap();
                allow_write_rx.lock().unwrap().recv().unwrap();
                super::write_atomically(path, bytes)
            }),
        )
        .unwrap(),
    );

    let writing_state = Arc::clone(&state);
    let writer = thread::spawn(move || writing_state.save_snapshot(json!({ "first": true })));
    write_started_rx.recv().unwrap();

    let releasing_state = Arc::clone(&state);
    let (release_started_tx, release_started_rx) = mpsc::sync_channel(0);
    let (release_finished_tx, release_finished_rx) = mpsc::sync_channel(0);
    let releaser = thread::spawn(move || {
        release_started_tx.send(()).unwrap();
        releasing_state.release_locks();
        release_finished_tx.send(()).unwrap();
    });
    release_started_rx.recv().unwrap();
    assert_eq!(
        release_finished_rx.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Timeout)
    );

    allow_write_tx.send(()).unwrap();
    assert!(writer.join().unwrap().unwrap());
    release_finished_rx.recv().unwrap();
    releaser.join().unwrap();
    assert!(!state.is_primary());
    assert_eq!(write_count.load(Ordering::SeqCst), 1);
    assert!(!state.save_snapshot(json!({ "tooLate": true })).unwrap());
    assert_eq!(write_count.load(Ordering::SeqCst), 1);
}

#[test]
fn client_state_origin_requires_managed_cli_or_narrow_app_origin() {
    let managed = "http://127.0.0.1:43123";
    assert!(is_allowed_client_state_origin(
        &Url::parse("http://127.0.0.1:43123/workspace").unwrap(),
        Some(managed),
    ));
    assert!(!is_allowed_client_state_origin(
        &Url::parse("http://127.0.0.1:43124/workspace").unwrap(),
        Some(managed),
    ));
    assert!(!is_allowed_client_state_origin(
        &Url::parse("http://localhost:9000/workspace").unwrap(),
        None,
    ));
    assert!(is_allowed_client_state_origin(
        &Url::parse("https://tauri.localhost/loading.html").unwrap(),
        None,
    ));
}

#[test]
fn rejects_snapshots_over_one_mib_without_replacing_state() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    assert!(state.save_snapshot(json!({ "small": true })).unwrap());

    let oversized = Value::String("x".repeat(MAX_CLIENT_SNAPSHOT_BYTES));
    assert!(state.save_snapshot(oversized).is_err());
    assert_eq!(state.load().unwrap().snapshot, json!({ "small": true }));
}
