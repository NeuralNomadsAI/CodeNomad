use super::commands::is_allowed_client_state_origin;
use super::partitions::MAX_COMMIT_BYTES;
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
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Barrier};
use std::thread;

#[test]
fn legacy_migration_uuids_match_the_cross_host_exact_byte_vectors() {
    for (content, expected) in [
        (
            br#"{"version":1}"#.as_slice(),
            "2430f1a2-ad29-52d0-8678-85488a4c89e2",
        ),
        (
            br#"{ "version": 1, "restoreEnabled": false }"#.as_slice(),
            "e6a1425a-ebb1-502f-b79c-d92772fa763b",
        ),
    ] {
        assert_eq!(
            super::envelope::deterministic_legacy_window_id(content),
            expected
        );
        assert_eq!(parse_client_state(content).active_window_id, expected);
    }
}
use std::time::Duration;
use tempfile::TempDir;
use url::Url;

fn load(is_primary: bool, restore_enabled: bool, snapshot: Value) -> ClientStateLoadResult {
    ClientStateLoadResult {
        is_primary,
        restore_enabled,
        snapshot,
        partition_protocol_version: Some(1),
    }
}

fn assert_access_rejected(state: &ClientState, token: &str, url: &Url) {
    assert!(state.renderer_access.validate(token, url).is_err());
}

fn acknowledged_generation(state: &ClientState) -> u64 {
    let window_id = state.active_window_id().unwrap();
    state
        .renderer_flush
        .windows
        .lock()
        .unwrap()
        .get(&window_id)
        .map(|state| state.1)
        .unwrap_or(0)
}

fn assert_receive_timeout<T>(result: Result<T, mpsc::RecvTimeoutError>) {
    assert!(matches!(result, Err(mpsc::RecvTimeoutError::Timeout)));
}

fn enable_restore(state: &ClientState) {
    assert!(state.set_restore_enabled(true).unwrap());
}

fn enable_restore_in_memory(state: &ClientState) {
    let mut persisted = state.state.lock().unwrap();
    persisted.active_mut().restore_enabled = true;
    persisted.active_mut().writes_enabled = true;
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
        scale_factor: 1.0,
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
fn restore_defaults_on_unless_explicitly_disabled() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    assert_eq!(state.load().unwrap(), load(true, true, Value::Null));
    assert!(state.save_snapshot(json!({ "saved": true })).unwrap());

    let disabled_directory = tempfile::tempdir().unwrap();
    fs::write(
        disabled_directory.path().join(CLIENT_STATE_FILENAME),
        br#"{"version":1,"restoreEnabled":false}"#,
    )
    .unwrap();
    let disabled = ClientState::initialize_at(disabled_directory.path()).unwrap();
    assert_eq!(disabled.load().unwrap(), load(true, false, Value::Null));
}

#[test]
fn parses_exact_envelopes_and_fences_malformed_values() {
    for bytes in [
        br#"not json"#.as_slice(),
        br#"{"version":0,"restoreEnabled":false}"#.as_slice(),
        br#"{"version":1,"restoreEnabled":"no"}"#.as_slice(),
        br#"{"version":1.5,"restoreEnabled":true}"#.as_slice(),
        br#"{"version":"1","restoreEnabled":true}"#.as_slice(),
        br#"{"version":1,"restoreEnabled":true,"protocolVersion":1}"#.as_slice(),
    ] {
        let state = parse_client_state(bytes);
        assert!(!state.active().restore_enabled);
        assert_eq!(state.active().snapshot, None);
        assert!(state.unsupported_future_envelope);
    }
    let state = parse_client_state(
        br#"{"version":1,"restoreEnabled":false,"snapshot":{"folder":"work"},"window":{"bounds":{"x":20,"y":30,"width":1400,"height":900},"maximized":true,"fullscreen":false,"zoomFactor":5}}"#,
    );
    assert!(!state.active().restore_enabled);
    assert_eq!(state.active().snapshot, Some(json!({ "folder": "work" })));
    assert_eq!(
        state.active().window.as_ref().unwrap().zoom_factor,
        MAX_ZOOM_LEVEL
    );
    let v1_with_partition_metadata = parse_client_state(
        br#"{"version":1,"restoreEnabled":true,"snapshot":{},"protocolVersion":1,"partitionKeys":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}"#,
    );
    assert!(v1_with_partition_metadata.unsupported_future_envelope);
    let key = "a".repeat(64);
    let window_id = "11111111-1111-4111-8111-111111111111";
    let envelope_for = |version: &str| {
        if version.starts_with('1') {
            format!(r#"{{"version":{version},"restoreEnabled":true}}"#)
        } else if version.starts_with('2') {
            format!(
                r#"{{"version":{version},"restoreEnabled":true,"snapshot":{{"version":2.0,"sessionPartition":"{key}","partitionKeys":["{key}"]}},"protocolVersion":1.0,"partitionKeys":["{key}"]}}"#
            )
        } else {
            format!(
                r#"{{"version":{version},"activeWindowId":"{window_id}","windowOrder":["{window_id}"],"windows":{{"{window_id}":{{"restoreEnabled":true}}}}}}"#
            )
        }
    };
    for version in ["1", "1.0", "2", "2.0", "3", "3.0"] {
        let envelope = envelope_for(version);
        assert!(!parse_client_state(envelope.as_bytes()).unsupported_future_envelope);
    }
    for version in ["1.5", "2.5", "3.5"] {
        let envelope = envelope_for(version);
        assert!(parse_client_state(envelope.as_bytes()).unsupported_future_envelope);
    }
    assert!(parse_client_state(
        format!(r#"{{"version":2,"restoreEnabled":true,"snapshot":{{"version":2,"sessionPartition":"{key}","partitionKeys":["{key}"]}},"protocolVersion":1.5,"partitionKeys":["{key}"]}}"#).as_bytes(),
    ).unsupported_future_envelope);
    assert_eq!(
        super::envelope::exact_nonnegative_safe_integer(&json!(9_007_199_254_740_991_u64)),
        Some(9_007_199_254_740_991)
    );
    assert_eq!(
        super::envelope::exact_nonnegative_safe_integer(&json!(9_007_199_254_740_992_u64)),
        None
    );
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
            None,
            Some(&electron),
            Arc::new(super::write_atomically),
        )
        .unwrap();
        assert_eq!(state.load().unwrap(), load(true, false, Value::Null));
        assert!(
            !parse_client_state(&fs::read(&shared).unwrap())
                .active()
                .restore_enabled
        );
        assert!(electron.join(CLIENT_STATE_FILENAME).exists());
        assert!(tauri.join(CLIENT_STATE_FILENAME).exists());
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
        None,
        Some(&electron),
        Arc::new(super::write_atomically),
    )
    .unwrap();
    assert_eq!(state.load().unwrap().snapshot, Value::Null);
}

#[test]
fn v1_shared_state_is_copied_once_and_v2_mutations_remain_isolated() {
    let root = tempfile::tempdir().unwrap();
    let tauri = root.path().join("tauri");
    let shared = root.path().join("shared");
    let legacy_shared = shared.join(CLIENT_STATE_FILENAME);
    let v2 = shared.join("v2");
    let election = v2.join("election");
    let v2_state = v2.join(CLIENT_STATE_FILENAME);
    fs::create_dir_all(&shared).unwrap();
    fs::create_dir_all(&tauri).unwrap();
    let legacy_bytes = br#"{
  "version": 1, "restoreEnabled": true, "snapshot": { "source": "v1" }
}"#;
    fs::write(&legacy_shared, legacy_bytes).unwrap();
    let host_local = br#"{"version":1,"restoreEnabled":true,"snapshot":{"source":"host-local"}}"#;
    fs::write(tauri.join(CLIENT_STATE_FILENAME), host_local).unwrap();

    let state = ClientState::initialize_at_with_writer_and_election(
        &tauri,
        &election,
        &v2_state,
        Some(&legacy_shared),
        None,
        Arc::new(super::write_atomically),
    )
    .unwrap();
    assert_eq!(fs::read(&v2_state).unwrap(), legacy_bytes);
    assert_eq!(state.load().unwrap().snapshot, json!({ "source": "v1" }));
    assert!(state.save_snapshot(json!({ "source": "v2-save" })).unwrap());
    assert_eq!(fs::read(&legacy_shared).unwrap(), legacy_bytes);
    assert!(state.set_restore_enabled(false).unwrap());
    assert_eq!(fs::read(&legacy_shared).unwrap(), legacy_bytes);
    assert!(state.clear().unwrap());
    assert_eq!(fs::read(&legacy_shared).unwrap(), legacy_bytes);
    assert_eq!(
        fs::read(tauri.join(CLIENT_STATE_FILENAME)).unwrap(),
        host_local
    );
    state.release_locks();

    let restarted = ClientState::initialize_at_with_writer_and_election(
        &tauri,
        &election,
        &v2_state,
        Some(&legacy_shared),
        None,
        Arc::new(super::write_atomically),
    )
    .unwrap();
    assert!(!restarted.load().unwrap().restore_enabled);
    assert_ne!(fs::read(&v2_state).unwrap(), legacy_bytes);
    assert_eq!(fs::read(&legacy_shared).unwrap(), legacy_bytes);
}

#[test]
fn unshipped_partitioned_v2_shared_state_is_not_copied_over_shipped_v1_migration() {
    let root = tempfile::tempdir().unwrap();
    let tauri = root.path().join("tauri");
    let shared = root.path().join("shared");
    let legacy_shared = shared.join(CLIENT_STATE_FILENAME);
    let v2 = shared.join("v2");
    let v2_state = v2.join(CLIENT_STATE_FILENAME);
    fs::create_dir_all(&shared).unwrap();
    fs::create_dir_all(&tauri).unwrap();
    fs::write(&legacy_shared, br#"{"version":2,"restoreEnabled":true}"#).unwrap();
    fs::write(
        tauri.join(CLIENT_STATE_FILENAME),
        br#"{"version":1,"restoreEnabled":true,"snapshot":{"source":"shipped-v1"}}"#,
    )
    .unwrap();

    let state = ClientState::initialize_at_with_writer_and_election(
        &tauri,
        &v2.join("election"),
        &v2_state,
        Some(&legacy_shared),
        None,
        Arc::new(super::write_atomically),
    )
    .unwrap();
    assert_eq!(
        state.load().unwrap().snapshot,
        json!({ "source": "shipped-v1" })
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(v2_state).unwrap()).unwrap()["version"],
        1
    );
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
        None,
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
fn mixed_dpi_restore_selects_displays_in_physical_coordinates() {
    let mut high_dpi = display(1920, 0, 2560, 1440);
    high_dpi.scale_factor = 2.0;
    assert_eq!(
        clamp_window_bounds(
            &bounds(1000, 500, 700, 600),
            &[display(0, 0, 1920, 1080), high_dpi],
        ),
        Some(bounds(1000, 120, 800, 600))
    );
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
    assert_eq!(secondary.load().unwrap(), load(false, false, Value::Null));
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
        state.state.lock().unwrap().active_mut().window = Some(window());
        if clear {
            assert!(state.clear().unwrap());
            assert_eq!(state.load().unwrap(), load(true, true, Value::Null));
        } else {
            assert!(state.set_restore_enabled(false).unwrap());
            assert_eq!(state.load().unwrap(), load(true, false, Value::Null));
            let window_id = state.active_window_id().unwrap();
            assert_eq!(
                state.zoom_levels.lock().unwrap()[&window_id],
                DEFAULT_ZOOM_LEVEL
            );
        }
        let path = directory.path().join(CLIENT_STATE_FILENAME);
        let persisted = parse_client_state(&fs::read(&path).unwrap());
        assert_eq!(persisted.active().snapshot, None);
        assert_eq!(persisted.active().window, None);
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
        state.state.lock().unwrap().active_mut().window = Some(window());
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
        assert!(state.state.lock().unwrap().active().window.is_some());
        assert!(state.state.lock().unwrap().active().writes_enabled);
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
fn accepted_page_load_stages_renderer_rotation_and_preserves_generation_fencing() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    let window_id = state.active_window_id().unwrap();
    let url = Url::parse("http://127.0.0.1:43123/workspace").unwrap();
    state
        .renderer_access
        .claim_for(&window_id, "outgoing", &url)
        .unwrap();
    let generation = state
        .renderer_access
        .validate_for(&window_id, "outgoing", &url)
        .unwrap();

    state.stage_renderer_page_load(&window_id, &url).unwrap();
    state
        .renderer_access
        .claim_for(&window_id, "incoming", &url)
        .unwrap();

    assert!(!state
        .renderer_access
        .is_generation_current_for(&window_id, generation));
    assert!(state
        .renderer_access
        .validate_for(&window_id, "outgoing", &url)
        .is_err());
    state
        .renderer_access
        .validate_for(&window_id, "incoming", &url)
        .unwrap();
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
    let window_id = state.active_window_id().unwrap();
    state
        .renderer_flush
        .windows
        .lock()
        .unwrap()
        .insert(window_id.clone(), (2, 0));
    state.acknowledge_renderer_flush(&window_id, 1);
    assert_eq!(acknowledged_generation(&state), 0);
    state.acknowledge_renderer_flush(&window_id, 2);
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
    let lock_path = directory.path().join(PRIMARY_LOCK_FILENAME);
    let contender = OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path)
        .unwrap();
    assert!(fs2::FileExt::try_lock_exclusive(&contender).is_err());
    let releasing = Arc::clone(&state);
    let (released_tx, released_rx) = mpsc::channel();
    let releaser = thread::spawn(move || {
        releasing.release_locks();
        released_tx.send(()).unwrap();
    });
    assert_receive_timeout(released_rx.recv_timeout(Duration::from_millis(50)));
    assert!(fs2::FileExt::try_lock_exclusive(&contender).is_err());
    allow_tx.send(()).unwrap();
    assert!(writer.join().unwrap().unwrap());
    released_rx.recv().unwrap();
    releaser.join().unwrap();
    fs2::FileExt::try_lock_exclusive(&contender).unwrap();
    fs2::FileExt::unlock(&contender).unwrap();
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
    assert_eq!(state.load().unwrap(), load(false, false, Value::Null));
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

fn partition_commit(value: Value) -> super::partitions::PartitionCommit {
    serde_json::from_value(value).unwrap()
}

fn partition_key(content: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(content.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn partition_root(keys: &[String], fields: Value) -> Value {
    let Value::Object(mut root) = fields else {
        panic!("partition root fields must be an object");
    };
    root.insert("version".to_string(), json!(2));
    root.insert("sessionPartition".to_string(), json!(keys[0]));
    root.insert("partitionKeys".to_string(), json!(keys));
    Value::Object(root)
}

#[test]
fn v1_and_v2_migrate_in_memory_without_load_rewrites() {
    let content = "legacy partition";
    let key = partition_key(content);
    for initial in [
        json!({ "version": 1, "restoreEnabled": true, "snapshot": { "legacy": 1 } }),
        json!({
            "version": 2,
            "restoreEnabled": true,
            "snapshot": partition_root(std::slice::from_ref(&key), json!({})),
            "protocolVersion": 1,
            "partitionKeys": [key.clone()]
        }),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(CLIENT_STATE_FILENAME);
        let original = serde_json::to_vec(&initial).unwrap();
        fs::write(&path, &original).unwrap();
        let state = ClientState::initialize_at(directory.path()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(state.save_snapshot(json!({ "mutated": true })).unwrap());
        let persisted: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted["version"], 3);
        assert_eq!(persisted["windowOrder"][0], persisted["activeWindowId"]);
    }
}

#[test]
fn v3_records_isolate_tokens_partitions_clear_and_removal() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    enable_restore(&state);
    let window_a = state.active_window_id().unwrap();
    let window_b = "11111111-1111-4111-8111-111111111111".to_string();
    assert!(state.add_window(window_b.clone()).unwrap());

    let url = Url::parse("http://127.0.0.1:43123/workspace").unwrap();
    state
        .renderer_access
        .claim_for(&window_a, "token-a", &url)
        .unwrap();
    state
        .renderer_access
        .claim_for(&window_b, "token-b", &url)
        .unwrap();
    assert!(state
        .renderer_access
        .validate_for(&window_b, "token-a", &url)
        .is_err());
    assert!(state
        .save_snapshot_guarded_for(&window_a, json!({ "window": "a" }), || true)
        .unwrap());
    assert!(state
        .save_snapshot_guarded_for(&window_b, json!({ "window": "b" }), || true)
        .unwrap());
    state
        .state
        .lock()
        .unwrap()
        .record_mut(&window_a)
        .unwrap()
        .window = Some(window());
    state
        .state
        .lock()
        .unwrap()
        .record_mut(&window_b)
        .unwrap()
        .window = Some(NativeWindowState {
        bounds: bounds(40, 50, 1000, 700),
        maximized: false,
        fullscreen: true,
        zoom_factor: 1.25,
    });
    assert_eq!(
        state.load_window(&window_a).unwrap().snapshot,
        json!({ "window": "a" })
    );
    assert_eq!(
        state.load_window(&window_b).unwrap().snapshot,
        json!({ "window": "b" })
    );

    let content_a = "partition a";
    let key_a = partition_key(content_a);
    let content_b = "partition b";
    let key_b = partition_key(content_b);
    assert!(state
        .commit_partitions_guarded_for(
            &window_a,
            partition_commit(json!({
                "protocolVersion": 1,
                "snapshot": partition_root(std::slice::from_ref(&key_a), json!({})),
                "partitions": { key_a.clone(): content_a },
                "partitionKeys": [key_a.clone()]
            })),
            || true,
        )
        .unwrap());
    assert!(state
        .commit_partitions_guarded_for(
            &window_b,
            partition_commit(json!({
                "protocolVersion": 1,
                "snapshot": partition_root(std::slice::from_ref(&key_b), json!({})),
                "partitions": { key_b.clone(): content_b },
                "partitionKeys": [key_b.clone()]
            })),
            || true,
        )
        .unwrap());
    assert_eq!(
        state
            .load_partition_guarded_for(&window_a, &key_b, || true)
            .unwrap(),
        None
    );
    assert!(state.clear_guarded(&window_a, || true).unwrap());
    assert!(!directory.path().join("partitions").join(key_a).exists());
    assert!(directory.path().join("partitions").join(&key_b).exists());
    assert_eq!(
        state
            .load_partition_guarded_for(&window_b, &key_b, || true)
            .unwrap()
            .as_deref(),
        Some(content_b)
    );

    assert!(state.remove_window(&window_a).unwrap());
    let persisted: Value =
        serde_json::from_slice(&fs::read(directory.path().join(CLIENT_STATE_FILENAME)).unwrap())
            .unwrap();
    assert_eq!(persisted["activeWindowId"], window_b);
    assert_eq!(persisted["windowOrder"], json!([window_b]));
    assert!(state.remove_window(&window_b).unwrap());
    assert!(state.window_ids().is_empty());
    let persisted: Value =
        serde_json::from_slice(&fs::read(directory.path().join(CLIENT_STATE_FILENAME)).unwrap())
            .unwrap();
    assert_eq!(persisted["activeWindowId"], window_b);
    assert_eq!(persisted["windowOrder"], json!([]));
    assert_eq!(persisted["windows"], json!({}));
    assert!(!directory.path().join("partitions").join(key_b).exists());
}

#[test]
fn invalid_v3_is_frozen_until_explicit_clear() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(CLIENT_STATE_FILENAME);
    let window_id = "11111111-1111-4111-8111-111111111111";
    let original = format!(
        " {{ \"version\": 3, \"activeWindowId\": \"{window_id}\", \"windowOrder\": [\"{window_id}\"], \"windows\": {{ \"{window_id}\": {{ \"restoreEnabled\": true, \"unknown\": 1 }} }} }} "
    );
    fs::write(&path, original.as_bytes()).unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    assert!(state.save_snapshot(json!({ "ignored": true })).unwrap());
    assert_eq!(fs::read(&path).unwrap(), original.as_bytes());
    assert!(state.clear().unwrap());
    let persisted: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(persisted["version"], 3);
}

#[test]
fn partition_protocol_and_hashes_are_validated() {
    assert_eq!(MAX_COMMIT_BYTES, 256 * 1024 * 1024);
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    enable_restore(&state);
    let content = "partition";
    let key = partition_key(content);
    for payload in [
        json!({ "protocolVersion": 2, "snapshot": partition_root(std::slice::from_ref(&key), json!({})), "partitions": { key.clone(): content }, "partitionKeys": [key.clone()] }),
        json!({ "protocolVersion": 1, "snapshot": partition_root(std::slice::from_ref(&key), json!({})), "partitions": { key.clone(): "wrong" }, "partitionKeys": [key.clone()] }),
        json!({ "protocolVersion": 1, "snapshot": partition_root(std::slice::from_ref(&key), json!({})), "partitions": { key.clone(): content }, "partitionKeys": [key.clone(), key.clone()] }),
        json!({ "protocolVersion": 1, "snapshot": partition_root(std::slice::from_ref(&key), json!({})), "partitions": {}, "partitionKeys": [key.clone()] }),
        json!({ "protocolVersion": 1, "snapshot": partition_root(std::slice::from_ref(&key), json!({})), "partitions": { key.clone(): content, partition_key("extra"): "extra" }, "partitionKeys": [key.clone()] }),
        json!({ "protocolVersion": 1, "snapshot": partition_root(std::slice::from_ref(&key), json!({})), "partitions": { key.clone(): content }, "partitionKeys": [partition_key("other")] }),
    ] {
        assert!(state
            .commit_partitions_guarded(partition_commit(payload), || true)
            .is_err());
    }

    let mut partitions = serde_json::Map::new();
    let mut partition_keys = Vec::new();
    for index in 0..9 {
        let content = format!("{index}{}", "x".repeat(1024 * 1024 - 1));
        let key = partition_key(&content);
        partitions.insert(key.clone(), Value::String(content));
        partition_keys.push(key);
    }
    partition_keys.sort();
    assert!(state
        .commit_partitions_guarded(
            partition_commit(json!({
                "protocolVersion": 1, "snapshot": partition_root(&partition_keys, json!({})),
                "partitions": partitions, "partitionKeys": partition_keys
            })),
            || true,
        )
        .unwrap());
}

#[test]
fn partition_commit_read_and_failure_safety() {
    let (directory, state, fail) = failing_state(false);
    enable_restore(&state);
    let old_content = "old partition";
    let old_key = partition_key(old_content);
    assert!(state
        .commit_partitions_guarded(
            partition_commit(json!({
                "protocolVersion": 1, "snapshot": partition_root(std::slice::from_ref(&old_key), json!({ "root": "old" })),
                "partitions": { old_key.clone(): old_content }, "partitionKeys": [old_key.clone()]
            })),
            || true,
        )
        .unwrap());
    let root: Value =
        serde_json::from_slice(&fs::read(directory.path().join(CLIENT_STATE_FILENAME)).unwrap())
            .unwrap();
    let window_id = root["activeWindowId"].as_str().unwrap();
    assert_eq!(root["version"], 3);
    assert_eq!(root["windows"][window_id]["partitionProtocolVersion"], 1);
    assert!(root["windows"][window_id].get("protocolVersion").is_none());
    assert_eq!(
        state
            .load_partition_guarded(&old_key, || true)
            .unwrap()
            .as_deref(),
        Some(old_content)
    );

    let next_content = "next partition";
    let next_key = partition_key(next_content);
    fail.store(true, Ordering::SeqCst);
    assert!(state
        .commit_partitions_guarded(
            partition_commit(json!({
                "protocolVersion": 1, "snapshot": partition_root(std::slice::from_ref(&next_key), json!({ "root": "next" })),
                "partitions": { next_key.clone(): next_content }, "partitionKeys": [next_key.clone()]
            })),
            || true,
        )
        .is_err());
    assert_eq!(
        state.load().unwrap().snapshot,
        partition_root(std::slice::from_ref(&old_key), json!({ "root": "old" }))
    );
    assert!(directory.path().join("partitions").join(&old_key).exists());
    assert!(directory.path().join("partitions").join(&next_key).exists());
    fail.store(false, Ordering::SeqCst);
    assert!(state.clear().unwrap());
    assert!(!directory.path().join("partitions").join(&old_key).exists());
    assert!(!directory.path().join("partitions").join(&next_key).exists());
}

#[test]
fn v2_window_persistence_and_partition_to_monolithic_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    enable_restore(&state);
    let content = "window partition";
    let key = partition_key(content);
    assert!(state
        .commit_partitions_guarded(
            partition_commit(json!({
                "protocolVersion": 1, "snapshot": partition_root(std::slice::from_ref(&key), json!({ "root": true })),
                "partitions": { key.clone(): content }, "partitionKeys": [key.clone()]
            })),
            || true,
        )
        .unwrap());
    state.state.lock().unwrap().active_mut().window = Some(window());
    state.flush().unwrap();
    let root: Value =
        serde_json::from_slice(&fs::read(directory.path().join(CLIENT_STATE_FILENAME)).unwrap())
            .unwrap();
    let window_id = root["activeWindowId"].as_str().unwrap();
    assert_eq!(root["version"], 3);
    assert_eq!(root["windows"][window_id]["partitionProtocolVersion"], 1);
    assert_eq!(
        root["windows"][window_id]["partitionKeys"],
        json!([key.clone()])
    );
    state.release_locks();

    let restarted = ClientState::initialize_at(directory.path()).unwrap();
    assert_eq!(
        restarted.state.lock().unwrap().active().window,
        Some(window())
    );
    assert_eq!(
        restarted
            .load_partition_guarded(&key, || true)
            .unwrap()
            .as_deref(),
        Some(content)
    );
    assert!(restarted
        .save_snapshot(json!({ "monolithic": true }))
        .unwrap());
    let root: Value =
        serde_json::from_slice(&fs::read(directory.path().join(CLIENT_STATE_FILENAME)).unwrap())
            .unwrap();
    let window_id = root["activeWindowId"].as_str().unwrap();
    assert_eq!(root["version"], 3);
    assert!(root["windows"][window_id]
        .get("partitionProtocolVersion")
        .is_none());
    assert!(!directory.path().join("partitions").join(key).exists());
}

#[test]
fn malformed_and_future_v2_roots_fence_writes_and_gc_until_clear() {
    let content = "keep orphan";
    let key = partition_key(content);
    for root in [
        json!({ "version": 2, "restoreEnabled": true, "snapshot": {}, "protocolVersion": 2, "partitionKeys": [key.clone()] }),
        json!({ "version": 2, "restoreEnabled": true, "snapshot": {}, "protocolVersion": 1, "partitionKeys": [key.clone(), key.clone()] }),
        json!({ "version": 2, "restoreEnabled": true, "snapshot": {}, "protocolVersion": 1, "partitionKeys": [key.to_uppercase()] }),
        json!({ "version": 2, "restoreEnabled": true, "snapshot": "x".repeat(1024 * 1024), "protocolVersion": 1, "partitionKeys": [key.clone()] }),
        json!({ "version": 2, "restoreEnabled": "yes", "snapshot": {}, "protocolVersion": 1, "partitionKeys": [key.clone()] }),
        json!({ "version": 3, "restoreEnabled": true, "snapshot": {}, "protocolVersion": 1, "partitionKeys": [key.clone()] }),
        json!({ "version": 2, "restoreEnabled": true, "snapshot": partition_root(std::slice::from_ref(&key), json!({})), "protocolVersion": 1, "partitionKeys": [key.clone()], "extra": true }),
        json!({ "version": 2, "restoreEnabled": true, "snapshot": partition_root(std::slice::from_ref(&key), json!({})), "protocolVersion": 1, "partitionKeys": [partition_key("other")] }),
        json!({ "version": 1, "restoreEnabled": true, "snapshot": {}, "protocolVersion": 1 }),
        json!({ "version": 1.5, "restoreEnabled": true }),
        json!({ "version": "2", "restoreEnabled": true }),
        json!("not an envelope"),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(CLIENT_STATE_FILENAME);
        let original = serde_json::to_vec(&root).unwrap();
        fs::write(&path, &original).unwrap();
        fs::create_dir(directory.path().join("partitions")).unwrap();
        let partition_path = directory.path().join("partitions").join(&key);
        fs::write(&partition_path, content).unwrap();
        let writes = Arc::new(AtomicUsize::new(0));
        let writer_writes = Arc::clone(&writes);
        let state = ClientState::initialize_at_with_writer(
            directory.path(),
            Arc::new(move |path, bytes, ownership_valid| {
                writer_writes.fetch_add(1, Ordering::SeqCst);
                super::write_atomically(path, bytes, ownership_valid)
            }),
        )
        .unwrap();
        assert_eq!(state.load().unwrap(), load(true, false, Value::Null));
        assert_eq!(state.load_partition_guarded(&key, || true).unwrap(), None);
        assert!(state.save_snapshot(json!({ "ignored": true })).unwrap());
        assert!(!state.set_restore_enabled(false).unwrap());
        state.flush().unwrap();
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(partition_path.exists());

        assert!(state.clear().unwrap());
        assert_eq!(writes.load(Ordering::SeqCst), 1);
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap()["version"],
            3
        );
        assert!(!partition_path.exists());
    }

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join(CLIENT_STATE_FILENAME);
    let original = b"{not json";
    fs::write(&path, original).unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    assert!(state.save_snapshot(json!({ "ignored": true })).unwrap());
    state.flush().unwrap();
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn partition_directory_and_gc_reject_unsafe_entries() {
    let occupied = tempfile::tempdir().unwrap();
    let occupied_state = ClientState::initialize_at(occupied.path()).unwrap();
    enable_restore(&occupied_state);
    fs::write(occupied.path().join("partitions"), "not a directory").unwrap();
    let occupied_content = "occupied";
    let occupied_key = partition_key(occupied_content);
    assert!(occupied_state
        .commit_partitions_guarded(
            partition_commit(json!({
                "protocolVersion": 1,
                "snapshot": partition_root(std::slice::from_ref(&occupied_key), json!({})),
                "partitions": { occupied_key.clone(): occupied_content },
                "partitionKeys": [occupied_key]
            })),
            || true,
        )
        .is_err());

    let gc = tempfile::tempdir().unwrap();
    let gc_state = ClientState::initialize_at(gc.path()).unwrap();
    enable_restore(&gc_state);
    let partitions = gc.path().join("partitions");
    let removable = partition_key("orphan");
    fs::create_dir(&partitions).unwrap();
    fs::write(partitions.join(&removable), "orphan").unwrap();
    fs::write(partitions.join("unrelated.txt"), "keep").unwrap();
    fs::create_dir(partitions.join("f".repeat(64))).unwrap();
    assert!(gc_state.clear().unwrap());
    assert!(!partitions.join(removable).exists());
    assert!(partitions.join("unrelated.txt").exists());
    assert!(partitions.join("f".repeat(64)).exists());
}

#[cfg(unix)]
#[test]
fn partition_directory_symlink_is_rejected() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    enable_restore(&state);
    let target = directory.path().join("partition-target");
    fs::create_dir(&target).unwrap();
    symlink(target, directory.path().join("partitions")).unwrap();
    let content = "linked";
    let key = partition_key(content);
    assert!(state
        .commit_partitions_guarded(
            partition_commit(json!({
                "protocolVersion": 1,
                "snapshot": partition_root(std::slice::from_ref(&key), json!({})),
                "partitions": { key.clone(): content },
                "partitionKeys": [key]
            })),
            || true,
        )
        .is_err());
}
