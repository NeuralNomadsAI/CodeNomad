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
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Barrier};
use std::thread;
use std::time::Duration;
use tempfile::TempDir;
use url::Url;

fn load(is_primary: bool, restore_enabled: bool, snapshot: Value) -> ClientStateLoadResult {
    ClientStateLoadResult {
        is_primary,
        restore_enabled,
        snapshot,
    }
}

fn assert_access_rejected(state: &ClientState, token: &str, url: &Url) {
    assert!(state.renderer_access.validate(token, url).is_err());
}

fn acknowledged_generation(state: &ClientState) -> u64 {
    state
        .renderer_flush
        .acknowledged_generation
        .load(Ordering::SeqCst)
}

fn assert_receive_timeout<T>(result: Result<T, mpsc::RecvTimeoutError>) {
    assert!(matches!(result, Err(mpsc::RecvTimeoutError::Timeout)));
}

fn enable_restore(state: &ClientState) {
    assert!(state.set_restore_enabled(true).unwrap());
}

fn enable_restore_in_memory(state: &ClientState) {
    let mut persisted = state.state.lock().unwrap();
    persisted.restore_enabled = true;
    persisted.writes_enabled = true;
}

fn failing_state(initially_failing: bool) -> (TempDir, ClientState, Arc<AtomicBool>) {
    let directory = tempfile::tempdir().unwrap();
    let fail = Arc::new(AtomicBool::new(initially_failing));
    let writer_flag = Arc::clone(&fail);
    let state = ClientState::initialize_at_with_writer(
        directory.path(),
        Arc::new(move |path, bytes, ownership_valid| {
            if writer_flag.load(Ordering::SeqCst) {
                Err("injected write failure".to_string())
            } else {
                super::write_atomically(path, bytes, ownership_valid)
            }
        }),
    )
    .unwrap();
    (directory, state, fail)
}
fn window() -> NativeWindowState {
    NativeWindowState {
        bounds: bounds(20, 30, 1400, 900),
        maximized: true,
        fullscreen: false,
        zoom_factor: 2.0,
    }
}
fn bounds(x: i32, y: i32, width: i32, height: i32) -> WindowBounds {
    WindowBounds {
        x,
        y,
        width,
        height,
    }
}
fn display(x: i32, y: i32, width: u32, height: u32) -> DisplayArea {
    DisplayArea {
        x,
        y,
        width,
        height,
    }
}
fn concurrent_roles(path: &std::path::Path, count: usize) -> Vec<bool> {
    let start = Arc::new(Barrier::new(count + 1));
    let release = Arc::new(Barrier::new(count + 1));
    let (sender, receiver) = mpsc::channel();
    let handles: Vec<_> = (0..count)
        .map(|_| {
            let path = path.to_path_buf();
            let start = Arc::clone(&start);
            let release = Arc::clone(&release);
            let sender = sender.clone();
            thread::spawn(move || {
                start.wait();
                let state = ClientState::initialize_at(&path).unwrap();
                sender.send(state.is_primary()).unwrap();
                release.wait();
            })
        })
        .collect();
    drop(sender);
    start.wait();
    let roles = (0..count).map(|_| receiver.recv().unwrap()).collect();
    release.wait();
    for handle in handles {
        handle.join().unwrap();
    }
    roles
}

fn run_node_state_host(
    election: &std::path::Path,
    electron_data: &std::path::Path,
    tauri_data: &std::path::Path,
    operation: &str,
    payload: Option<&Value>,
) -> Value {
    let root = election.parent().unwrap();
    fs::create_dir_all(root).unwrap();
    let start = root.join(format!("node-start-{operation}"));
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../electron-app/electron/main/client-state-cross-host-child.ts");
    let mut child = Command::new("node")
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .args(["--import", "tsx"])
        .arg(script)
        .arg(election)
        .arg(&start)
        .args(["", "full"])
        .arg(electron_data)
        .args(["", ""])
        .arg(tauri_data)
        .arg(operation)
        .arg(payload.map(Value::to_string).unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node and tsx are required for cross-language state tests");
    fs::write(start, b"").unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().unwrap())
        .read_line(&mut line)
        .unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Node host failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_str(&line).unwrap()
}
#[test]
fn parses_envelopes_and_normalizes_zoom() {
    for bytes in [
        br#"not json"#.as_slice(),
        br#"{"version":0,"restoreEnabled":false}"#.as_slice(),
        br#"{"version":1,"restoreEnabled":"no"}"#.as_slice(),
    ] {
        let state = parse_client_state(bytes);
        assert!(!state.restore_enabled);
        assert_eq!(state.snapshot, None);
        assert!(!state.unsupported_future_envelope);
    }
    let state = parse_client_state(
        br#"{"version":1,"restoreEnabled":false,"snapshot":{"folder":"work"},"window":{"bounds":{"x":20,"y":30,"width":1400,"height":900},"maximized":true,"fullscreen":false,"zoomFactor":20}}"#,
    );
    assert!(!state.restore_enabled);
    assert_eq!(state.snapshot, Some(json!({ "folder": "work" })));
    assert_eq!(state.window.unwrap().zoom_factor, MAX_ZOOM_LEVEL);
    for (input, expected) in [
        (1.25, Some(1.25)),
        (0.01, Some(0.25)),
        (20.0, Some(MAX_ZOOM_LEVEL)),
        (0.0, None),
        (-1.0, None),
        (f64::NAN, None),
        (f64::INFINITY, None),
    ] {
        assert_eq!(normalize_native_zoom_level(input), expected);
    }
}

#[test]
fn migrates_dual_legacy_files_with_disabled_dominance_and_malformed_fallback() {
    for malformed_electron in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let electron = root.path().join("electron");
        let tauri = root.path().join("tauri");
        let election = root.path().join("shared/election");
        let shared = root.path().join("shared/client-state.json");
        fs::create_dir_all(&electron).unwrap();
        fs::create_dir_all(&tauri).unwrap();
        fs::write(
            electron.join(CLIENT_STATE_FILENAME),
            if malformed_electron {
                b"malformed".to_vec()
            } else {
                serde_json::to_vec(&json!({
                    "version": 1,
                    "restoreEnabled": true,
                    "snapshot": { "revision": 999, "savedAt": 20, "host": "electron" }
                }))
                .unwrap()
            },
        )
        .unwrap();
        fs::write(
            tauri.join(CLIENT_STATE_FILENAME),
            serde_json::to_vec(&json!({
                "version": 1,
                "restoreEnabled": false,
                "snapshot": { "savedAt": 1, "host": "tauri" }
            }))
            .unwrap(),
        )
        .unwrap();
        let state = ClientState::initialize_at_with_writer_and_election(
            &tauri,
            &election,
            &shared,
            Some(&electron),
            Arc::new(super::write_atomically),
        )
        .unwrap();
        assert_eq!(state.load().unwrap(), load(true, false, Value::Null));
        assert!(!parse_client_state(&fs::read(&shared).unwrap()).restore_enabled);
        assert!(!electron.join(CLIENT_STATE_FILENAME).exists());
        assert!(!tauri.join(CLIENT_STATE_FILENAME).exists());
    }

    let root = tempfile::tempdir().unwrap();
    let electron = root.path().join("electron");
    let tauri = root.path().join("tauri");
    let election = root.path().join("shared/election");
    let shared = root.path().join("shared/client-state.json");
    fs::create_dir_all(&electron).unwrap();
    fs::create_dir_all(&tauri).unwrap();
    fs::write(
        electron.join(CLIENT_STATE_FILENAME),
        serde_json::to_vec(&json!({ "version": 1, "restoreEnabled": true })).unwrap(),
    )
    .unwrap();
    fs::write(
        tauri.join(CLIENT_STATE_FILENAME),
        serde_json::to_vec(&json!({
            "version": 1,
            "restoreEnabled": true,
            "snapshot": { "savedAt": 20 }
        }))
        .unwrap(),
    )
    .unwrap();
    let state = ClientState::initialize_at_with_writer_and_election(
        &tauri,
        &election,
        &shared,
        Some(&electron),
        Arc::new(super::write_atomically),
    )
    .unwrap();
    assert_eq!(state.load().unwrap().snapshot, Value::Null);
}

#[test]
fn electron_and_tauri_share_the_complete_envelope_across_handoffs() {
    let root = tempfile::tempdir().unwrap();
    let electron = root.path().join("electron");
    let tauri = root.path().join("tauri");
    let election = root.path().join("shared/election");
    let shared = root.path().join("shared/client-state.json");
    fs::create_dir_all(&electron).unwrap();
    fs::create_dir_all(&tauri).unwrap();

    let electron_snapshot = json!({ "version": 0, "savedAt": 10, "from": "electron" });
    let node = run_node_state_host(
        &election,
        &electron,
        &tauri,
        "save",
        Some(&electron_snapshot),
    );
    assert_eq!(node["acquired"], true);
    let rust = ClientState::initialize_at_with_writer_and_election(
        &tauri,
        &election,
        &shared,
        Some(&electron),
        Arc::new(super::write_atomically),
    )
    .unwrap();
    assert_eq!(rust.load().unwrap().snapshot, electron_snapshot);
    let tauri_snapshot = json!({ "savedAt": 20, "from": "tauri" });
    assert!(rust.save_snapshot(tauri_snapshot.clone()).unwrap());
    rust.release_locks();
    assert!(!election.join("primary.owner.json").exists());

    let node = run_node_state_host(&election, &electron, &tauri, "load", None);
    assert_eq!(node["acquired"], true);
    assert_eq!(node["state"]["snapshot"], tauri_snapshot);
}
#[test]
fn normalizes_window_bounds_against_displays() {
    let cases = [
        (
            bounds(4000, 2000, 1400, 900),
            vec![display(0, 0, 1920, 1080)],
            bounds(520, 180, 1400, 900),
        ),
        (
            bounds(-2000, 100, 3000, 300),
            vec![display(-1280, 0, 1280, 1024), display(0, 0, 1920, 1080)],
            bounds(-1280, 100, 1280, 600),
        ),
    ];
    for (bounds, displays, expected) in cases {
        assert_eq!(clamp_window_bounds(&bounds, &displays), Some(expected));
    }
}
#[test]
fn stale_files_recover_without_trusting_pid_identity() {
    for lock_contents in [
        b"{\"pid\":999999}".as_slice(),
        b"{\"pid\":0}",
        b"inconclusive",
    ] {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join(PRIMARY_LOCK_FILENAME), lock_contents).unwrap();
        let marker = directory.path().join(format!(
            "{RUNNING_MARKER_PREFIX}stale{RUNNING_MARKER_SUFFIX}"
        ));
        fs::write(&marker, b"").unwrap();
        let state = ClientState::initialize_at(directory.path()).unwrap();
        assert!(state.is_primary());
        assert!(!marker.exists());
    }
}
#[test]
fn election_preserves_cohorts_until_every_participant_exits() {
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(
        concurrent_roles(directory.path(), 2)
            .iter()
            .filter(|role| **role)
            .count(),
        1
    );
    fs::remove_dir_all(directory.path().join(".cross-host-election")).unwrap();
    let primary = ClientState::initialize_at(directory.path()).unwrap();
    let secondary = ClientState::initialize_at(directory.path()).unwrap();
    assert!(primary.is_primary());
    assert!(!secondary.is_primary());
    drop(primary);
    assert_eq!(concurrent_roles(directory.path(), 2), [false, false]);
    let waiting = ClientState::initialize_at(directory.path()).unwrap();
    assert!(!waiting.is_primary());
    drop(secondary);
    drop(waiting);
    // Thread-backed clients share this test process identity; real exited hosts do not.
    fs::remove_dir_all(directory.path().join(".cross-host-election")).unwrap();
    assert!(ClientState::initialize_at(directory.path())
        .unwrap()
        .is_primary());
}
#[test]
fn secondary_and_failed_initialization_are_isolated() {
    let directory = tempfile::tempdir().unwrap();
    let primary = ClientState::initialize_at(directory.path()).unwrap();
    enable_restore(&primary);
    assert!(primary.save_snapshot(json!({ "kept": true })).unwrap());
    let state_path = directory.path().join(CLIENT_STATE_FILENAME);
    let original = fs::read(&state_path).unwrap();
    let secondary = ClientState::initialize_at(directory.path()).unwrap();
    assert_eq!(secondary.load().unwrap(), load(false, true, Value::Null));
    assert!(!secondary.save_snapshot(json!({ "replace": true })).unwrap());
    assert!(!secondary.set_restore_enabled(false).unwrap());
    assert!(!secondary.clear().unwrap());
    assert_eq!(fs::read(state_path).unwrap(), original);
    let invalid = directory.path().join("not-a-directory");
    fs::write(&invalid, b"occupied").unwrap();
    let disabled = ClientState::initialize_managed_at(&invalid);
    assert_eq!(disabled.load().unwrap(), load(false, false, Value::Null));
    assert!(!disabled.save_snapshot(json!({ "ignored": true })).unwrap());
}
#[test]
fn disable_and_clear_suppress_later_writes() {
    for clear in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let state = ClientState::initialize_at(directory.path()).unwrap();
        enable_restore(&state);
        assert!(state.save_snapshot(json!({ "removed": true })).unwrap());
        state.state.lock().unwrap().window = Some(window());
        if clear {
            assert!(state.clear().unwrap());
            assert_eq!(state.load().unwrap(), load(true, true, Value::Null));
        } else {
            assert!(state.set_restore_enabled(false).unwrap());
            assert_eq!(state.load().unwrap(), load(true, false, Value::Null));
            assert_eq!(*state.zoom_level.lock().unwrap(), DEFAULT_ZOOM_LEVEL);
        }
        let path = directory.path().join(CLIENT_STATE_FILENAME);
        let persisted = parse_client_state(&fs::read(&path).unwrap());
        assert_eq!(persisted.snapshot, None);
        assert_eq!(persisted.window, None);
        let bytes = fs::read(&path).unwrap();
        assert!(state.save_snapshot(json!({ "ignored": true })).unwrap());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}
#[test]
fn failed_writes_restore_memory_and_suppression_state() {
    for operation in ["snapshot", "clear", "disable"] {
        let (_directory, state, fail) = failing_state(false);
        enable_restore(&state);
        assert!(state.save_snapshot(json!({ "kept": true })).unwrap());
        state.state.lock().unwrap().window = Some(window());
        fail.store(true, Ordering::SeqCst);
        let error = match operation {
            "snapshot" => state.save_snapshot(json!({ "lost": true })).unwrap_err(),
            "clear" => state.clear().unwrap_err(),
            _ => state.set_restore_enabled(false).unwrap_err(),
        };
        assert_eq!(error, "injected write failure");
        assert_eq!(
            state.load().unwrap(),
            load(true, true, json!({ "kept": true }))
        );
        assert!(state.state.lock().unwrap().window.is_some());
        assert!(state.state.lock().unwrap().writes_enabled);
        fail.store(false, Ordering::SeqCst);
        assert!(state.save_snapshot(json!({ "replacement": true })).unwrap());
    }
    let (_directory, state, fail) = failing_state(false);
    state.clear().unwrap();
    fail.store(true, Ordering::SeqCst);
    assert_eq!(
        state.set_restore_enabled(true).unwrap_err(),
        "injected write failure"
    );
    assert!(state.save_snapshot(json!({ "ignored": true })).unwrap());
    assert_eq!(state.load().unwrap().snapshot, Value::Null);
}
#[test]
fn future_envelope_is_preserved_until_successful_clear() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(CLIENT_STATE_FILENAME);
    let future = br#"{"version":9,"snapshot":{"future":true},"extension":{"keep":"exactly"}}"#;
    fs::write(&path, future).unwrap();
    let fail = Arc::new(AtomicBool::new(true));
    let count = Arc::new(AtomicUsize::new(0));
    let writer_fail = Arc::clone(&fail);
    let writer_count = Arc::clone(&count);
    let state = ClientState::initialize_at_with_writer(
        directory.path(),
        Arc::new(move |path, bytes, ownership_valid| {
            writer_count.fetch_add(1, Ordering::SeqCst);
            if writer_fail.load(Ordering::SeqCst) {
                Err("injected write failure".to_string())
            } else {
                super::write_atomically(path, bytes, ownership_valid)
            }
        }),
    )
    .unwrap();
    assert_eq!(state.load().unwrap(), load(true, false, Value::Null));
    assert!(!state.set_restore_enabled(false).unwrap());
    assert!(state.save_snapshot(json!({ "ignored": true })).unwrap());
    state.flush().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert_eq!(state.clear().unwrap_err(), "injected write failure");
    assert_eq!(fs::read(&path).unwrap(), future);
    assert!(state.state.lock().unwrap().unsupported_future_envelope);
    fail.store(false, Ordering::SeqCst);
    assert!(state.clear().unwrap());
    assert!(!state.state.lock().unwrap().unsupported_future_envelope);
    enable_restore(&state);
    assert!(state.save_snapshot(json!({ "accepted": true })).unwrap());
    assert_eq!(state.load().unwrap().snapshot, json!({ "accepted": true }));
}
#[test]
fn renderer_tokens_and_origins_are_isolated_across_navigation() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    let outgoing = Url::parse("http://127.0.0.1:43123/workspace").unwrap();
    let incoming = Url::parse("http://127.0.0.1:43124/workspace").unwrap();
    assert!(state.renderer_access.claim("", &outgoing).is_err());
    assert_access_rejected(&state, "missing", &outgoing);
    state.renderer_access.claim("outgoing", &outgoing).unwrap();
    assert!(state.renderer_access.claim("other", &outgoing).is_err());
    assert_access_rejected(&state, "outgoing", &incoming);
    state
        .renderer_access
        .begin_navigation(Some(&incoming))
        .unwrap();
    state
        .renderer_access
        .validate("outgoing", &outgoing)
        .unwrap();
    state.renderer_access.claim("incoming", &incoming).unwrap();
    assert_access_rejected(&state, "outgoing", &outgoing);
    state
        .renderer_access
        .validate("incoming", &incoming)
        .unwrap();
    for (url, managed, allowed) in [
        (&outgoing, Some("http://127.0.0.1:43123"), true),
        (&incoming, Some("http://127.0.0.1:43123"), false),
        (
            &Url::parse("http://localhost:9000/workspace").unwrap(),
            None,
            false,
        ),
        (
            &Url::parse("https://tauri.localhost/loading.html").unwrap(),
            None,
            true,
        ),
    ] {
        assert_eq!(is_allowed_client_state_origin(url, managed), allowed);
    }
    for url in ["file:///tmp/loading.html", "about:blank"] {
        assert!(state
            .renderer_access
            .claim("opaque", &Url::parse(url).unwrap())
            .is_err());
    }
}

#[test]
fn reload_preserves_pending_cross_origin_authority_until_incoming_claim() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    let outgoing = Url::parse("http://127.0.0.1:43123/workspace").unwrap();
    let incoming = Url::parse("http://127.0.0.1:43124/workspace").unwrap();
    state.renderer_access.claim("outgoing", &outgoing).unwrap();

    state
        .renderer_access
        .begin_navigation(Some(&incoming))
        .unwrap();
    state.renderer_access.begin_navigation(None).unwrap();

    state.renderer_access.claim("incoming", &incoming).unwrap();
    state
        .renderer_access
        .validate("incoming", &incoming)
        .unwrap();
}

#[test]
fn failed_follow_up_navigation_restores_previous_pending_authority() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    let outgoing = Url::parse("http://127.0.0.1:43123/workspace").unwrap();
    let incoming = Url::parse("http://127.0.0.1:43124/workspace").unwrap();
    let failed = Url::parse("http://127.0.0.1:43125/workspace").unwrap();
    state.renderer_access.claim("outgoing", &outgoing).unwrap();
    state
        .renderer_access
        .begin_navigation(Some(&incoming))
        .unwrap();

    let failed_navigation = state
        .renderer_access
        .begin_navigation(Some(&failed))
        .unwrap();
    state.renderer_access.cancel_navigation(failed_navigation);

    state.renderer_access.claim("incoming", &incoming).unwrap();
    state
        .renderer_access
        .validate("incoming", &incoming)
        .unwrap();
}
#[test]
fn flush_generation_and_request_order_are_strict() {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(ClientState::initialize_at(directory.path()).unwrap());
    state
        .renderer_flush
        .next_generation
        .store(2, Ordering::SeqCst);
    state.acknowledge_renderer_flush(1);
    assert_eq!(acknowledged_generation(&state), 0);
    state.acknowledge_renderer_flush(2);
    assert_eq!(acknowledged_generation(&state), 2);
    let first = state.renderer_flush.request_lock.lock().unwrap();
    let waiting = Arc::clone(&state);
    let (sender, receiver) = mpsc::channel();
    let waiter = thread::spawn(move || {
        let _request = waiting.renderer_flush.request_lock.lock().unwrap();
        sender.send(()).unwrap();
    });
    assert_receive_timeout(receiver.recv_timeout(Duration::from_millis(20)));
    drop(first);
    receiver.recv_timeout(Duration::from_secs(1)).unwrap();
    waiter.join().unwrap();
}
#[test]
fn ownership_release_drains_active_write_and_blocks_later_writes() {
    let directory = tempfile::tempdir().unwrap();
    let (started_tx, started_rx) = mpsc::sync_channel(0);
    let (allow_tx, allow_rx) = mpsc::sync_channel(0);
    let allow_rx = std::sync::Mutex::new(allow_rx);
    let state = Arc::new(
        ClientState::initialize_at_with_writer(
            directory.path(),
            Arc::new(move |path, bytes, ownership_valid| {
                started_tx.send(()).unwrap();
                allow_rx.lock().unwrap().recv().unwrap();
                super::write_atomically(path, bytes, ownership_valid)
            }),
        )
        .unwrap(),
    );
    enable_restore_in_memory(&state);
    let writing = Arc::clone(&state);
    let writer = thread::spawn(move || writing.save_snapshot(json!({ "first": true })));
    started_rx.recv().unwrap();
    let releasing = Arc::clone(&state);
    let (released_tx, released_rx) = mpsc::channel();
    let releaser = thread::spawn(move || {
        releasing.release_locks();
        released_tx.send(()).unwrap();
    });
    assert_receive_timeout(released_rx.recv_timeout(Duration::from_millis(50)));
    allow_tx.send(()).unwrap();
    assert!(writer.join().unwrap().unwrap());
    released_rx.recv().unwrap();
    releaser.join().unwrap();
    assert!(!state.is_primary());
    assert!(!state.save_snapshot(json!({ "tooLate": true })).unwrap());
}

#[test]
fn ownership_loss_blocks_the_final_atomic_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let owner_path = directory
        .path()
        .join(".cross-host-election")
        .join("primary.owner.json")
        .join("owner.json");
    let state = ClientState::initialize_at_with_writer(
        directory.path(),
        Arc::new(move |path, bytes, ownership_valid| {
            fs::write(&owner_path, b"malformed").unwrap();
            super::write_atomically(path, bytes, ownership_valid)
        }),
    )
    .unwrap();
    enable_restore_in_memory(&state);
    assert_eq!(
        state.save_snapshot(json!({ "blocked": true })).unwrap_err(),
        "Client state ownership changed before atomic replacement"
    );
    assert!(!state.is_primary());
    assert_eq!(state.load().unwrap(), load(false, true, Value::Null));
    assert!(!directory.path().join(CLIENT_STATE_FILENAME).exists());
}

#[test]
fn renderer_rotation_blocks_an_in_flight_old_renderer_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let (started_tx, started_rx) = mpsc::sync_channel(0);
    let (allow_tx, allow_rx) = mpsc::sync_channel(0);
    let allow_rx = std::sync::Mutex::new(allow_rx);
    let state = Arc::new(
        ClientState::initialize_at_with_writer(
            directory.path(),
            Arc::new(move |path, bytes, replacement_valid| {
                started_tx.send(()).unwrap();
                allow_rx.lock().unwrap().recv().unwrap();
                super::write_atomically(path, bytes, replacement_valid)
            }),
        )
        .unwrap(),
    );
    enable_restore_in_memory(&state);
    let outgoing = Url::parse("http://127.0.0.1:43123/workspace").unwrap();
    let incoming = Url::parse("http://127.0.0.1:43124/workspace").unwrap();
    state.renderer_access.claim("old", &outgoing).unwrap();
    let generation = state.renderer_access.validate("old", &outgoing).unwrap();
    let writing = Arc::clone(&state);
    let authority = Arc::clone(&state);
    let writer = thread::spawn(move || {
        writing.save_snapshot_guarded(json!({ "stale": true }), || {
            authority.renderer_access.is_generation_current(generation)
        })
    });
    started_rx.recv().unwrap();
    state
        .renderer_access
        .begin_navigation(Some(&incoming))
        .unwrap();
    state.renderer_access.claim("new", &incoming).unwrap();
    allow_tx.send(()).unwrap();
    assert!(writer.join().unwrap().is_err());
    assert_eq!(state.load().unwrap().snapshot, Value::Null);
    assert!(!directory.path().join(CLIENT_STATE_FILENAME).exists());
}
#[test]
fn oversized_snapshot_does_not_replace_state() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    enable_restore(&state);
    state.save_snapshot(json!({ "small": true })).unwrap();
    assert!(state
        .save_snapshot(Value::String("x".repeat(MAX_CLIENT_SNAPSHOT_BYTES)))
        .is_err());
    assert_eq!(state.load().unwrap().snapshot, json!({ "small": true }));
}
