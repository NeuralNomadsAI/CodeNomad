use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

fn installation(root: &std::path::Path, mode: &str) -> Installation {
    let node = std::env::var_os("CODENOMAD_TEST_NODE").unwrap_or_else(|| "node".into());
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../desktop-speech/hex-test-service.fixture.mjs");
    Installation {
        executable: which::which(node).expect("Node runs the shared embedded Hex fixture"),
        support: root.to_owned(),
        key: "fixture".into(),
        version: "3.4.0".into(),
        model: "parakeet_v3".into(),
        files: vec![],
        directories: vec![],
        args: Some(vec![fixture, mode.into()]),
    }
}

fn clip(marker: i16) -> Vec<u8> {
    let mut wav = SILENCE.to_vec();
    wav[4] = 40;
    wav[40] = 4;
    wav[44..].copy_from_slice(&marker.to_le_bytes());
    wav.extend([0, 0]);
    wav
}

fn until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(4);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for Hex");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn prewarms_reuses_then_replaces_the_service_after_exit_idle_or_deselection() {
    let root = tempfile::tempdir().unwrap();
    let service = HexService::default();
    let selected = Arc::new(AtomicBool::new(true));
    let warmed = || fs::read_to_string(root.path().join("warmed")).unwrap();
    let logs = || fs::read_dir(root.path().join("logs")).unwrap().count();
    let run = |marker, count, idle| {
        let selected = selected.clone();
        service.run(
            installation(root.path(), ""),
            move || selected.load(Ordering::Acquire),
            || false,
            |_| {
                until(|| root.path().join("warmed").is_file() && warmed().lines().count() == count);
                Some(clip(marker))
            },
            idle,
        )
    };
    assert_eq!(run(0, 1, IDLE).unwrap(), "Bonjour, hello.");
    assert_eq!(run(0, 1, IDLE).unwrap(), "Bonjour, hello.");
    assert_eq!(logs(), 1);
    assert_eq!(run(43, 1, IDLE), Err(SpeechError::Failed));
    assert_eq!(logs(), 0);
    assert_eq!(
        run(0, 2, Duration::from_millis(25)).unwrap(),
        "Bonjour, hello."
    );
    until(|| logs() == 0);
    assert_eq!(run(0, 3, IDLE).unwrap(), "Bonjour, hello.");
    selected.store(false, Ordering::Release);
    until(|| logs() == 0);
    assert_eq!(run(0, 3, IDLE), Err(SpeechError::Failed));
}

#[test]
fn refuses_wrong_child_url_and_oversized_utf8_text() {
    let root = tempfile::tempdir().unwrap();
    let service = HexService::default();
    for mode in ["bad-pid", "redirect"] {
        assert_eq!(
            service.dictate(
                installation(root.path(), mode),
                || true,
                || false,
                |_| Some(clip(0))
            ),
            Err(SpeechError::Failed)
        );
    }
    assert_eq!(
        service.dictate(
            installation(root.path(), ""),
            || true,
            || false,
            |_| Some(clip(44))
        ),
        Err(SpeechError::Failed)
    );
}

#[test]
fn cancellation_stops_the_owned_child_and_discards_the_pending_transcript() {
    let root = tempfile::tempdir().unwrap();
    let service = HexService::default();
    let stop = AtomicBool::new(false);
    thread::scope(|threads| {
        let request = threads.spawn(|| {
            service.dictate(
                installation(root.path(), ""),
                || true,
                || stop.load(Ordering::Acquire),
                |_| Some(clip(42)),
            )
        });
        until(|| root.path().join("started").is_file());
        stop.store(true, Ordering::Release);
        assert_eq!(request.join().unwrap(), Err(SpeechError::Failed));
    });
    assert_eq!(fs::read_dir(root.path().join("logs")).unwrap().count(), 0);
    assert!(service.state.instance.lock().is_none());
}

#[test]
fn a_receipt_removed_during_capture_blocks_the_audio_upload_and_stops_hex() {
    let root = tempfile::tempdir().unwrap();
    let receipt = root.path().join("ready.json");
    fs::write(&receipt, "{}").unwrap();
    let service = HexService::default();
    let mut install = installation(root.path(), "");
    install.files.push(receipt.clone());
    assert_eq!(
        service.dictate(
            install,
            || true,
            || false,
            |_| {
                fs::remove_file(receipt).unwrap();
                Some(clip(0))
            }
        ),
        Err(SpeechError::Unavailable)
    );
    assert!(service.state.instance.lock().is_none());
}

#[test]
fn cancel_before_upload_leaves_the_synthetic_prewarm_for_the_next_capture() {
    let root = tempfile::tempdir().unwrap();
    let service = HexService::default();
    let stop = AtomicBool::new(false);
    let started = root.path().join("warm-started");
    thread::scope(|threads| {
        let request = threads.spawn(|| {
            service.dictate(
                installation(root.path(), "warm-blocked"),
                || true,
                || stop.load(Ordering::Acquire),
                |_| Some(clip(0)),
            )
        });
        until(|| started.is_file());
        stop.store(true, Ordering::Release);
        assert_eq!(request.join().unwrap(), Err(SpeechError::Failed));
    });
    let pid = fs::read_to_string(started).unwrap();
    assert!(root
        .path()
        .join("logs")
        .join(format!("embedded-{pid}.ndjson"))
        .is_file());
    fs::write(root.path().join("warm-release"), []).unwrap();
    assert_eq!(
        service
            .dictate(
                installation(root.path(), "warm-blocked"),
                || true,
                || false,
                |_| Some(clip(0))
            )
            .unwrap(),
        "Bonjour, hello."
    );
    assert_eq!(
        fs::read_to_string(root.path().join("warmed")).unwrap(),
        format!("{pid}\n")
    );
}

#[cfg(windows)]
#[test]
fn requesting_stop_does_not_wait_for_the_gpu_or_release_process_ownership() {
    let root = tempfile::tempdir().unwrap();
    let service = HexService::default();
    let cancelled = AtomicBool::new(false);
    let started = root.path().join("warm-started");
    let release = root.path().join("warm-release");
    thread::scope(|threads| {
        let request = threads.spawn(|| {
            service.dictate(
                installation(root.path(), "warm-blocked"),
                || true,
                || cancelled.load(Ordering::Acquire),
                |_| Some(clip(0)),
            )
        });
        until(|| started.is_file());
        cancelled.store(true, Ordering::Release);
        assert_eq!(request.join().unwrap(), Err(SpeechError::Failed));
    });
    service.request_stop();
    // Preferences can finish while the old child is still closing.
    assert_eq!(fs::read_dir(root.path().join("logs")).unwrap().count(), 1);
    fs::write(release, []).unwrap();
    service.stop();
    assert!(root.path().join("warmed").is_file());
    assert!(!root.path().join("closing").exists());
    assert_eq!(fs::read_dir(root.path().join("logs")).unwrap().count(), 0);
}
