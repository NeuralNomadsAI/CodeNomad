use super::*;
use std::sync::mpsc;

#[test]
fn reader_waiting_for_lifecycle_can_drain_after_revocation() {
    let manager = CliProcessManager::new();
    let generation = manager.advance_generation();
    let lifecycle = manager.lifecycle.lock();
    let current = manager.clone();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        entered_tx.send(()).unwrap();
        assert!(current
            .with_current_generation(generation, || panic!("revoked effect"))
            .is_none());
        done_tx.send(()).unwrap();
    });
    entered_rx.recv().unwrap();
    manager.accepting_spawns.store(false, Ordering::SeqCst);
    manager.advance_generation();
    // Keep the stop-owned lock while waiting: a blocking lock in the reader deadlocks here.
    done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    drop(lifecycle);
    reader.join().unwrap();
}

#[test]
fn real_child_stop_drains_both_streams_after_revocation() {
    let manager = CliProcessManager::new();
    let generation = manager.advance_generation();
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../server/src/fixtures/shutdown-output.ts");
    let mut command = Command::new(which::which("node").unwrap());
    command
        .args(["--import", "tsx"])
        .arg(fixture)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_spawn(&mut command);
    #[cfg(unix)]
    configure_posix_process_group(&mut command);
    let child = command.spawn().unwrap();
    #[cfg(windows)]
    let job = WindowsJobObject::create().unwrap();
    #[cfg(windows)]
    job.assign_child(&child).unwrap();
    let (stdout, stderr) = manager
        .register_spawned_child(
            generation,
            child,
            #[cfg(windows)]
            job,
        )
        .unwrap();
    let (ready_tx, ready_rx) = mpsc::channel();
    let lines = Arc::new(Mutex::new(Vec::new()));
    let mut readers = Vec::new();
    // Use the production pump and admission fence, with no graphical AppHandle required.
    let current = manager.clone();
    let output = lines.clone();
    readers.push((
        "stdout",
        ReaderReceipt::spawn(move || {
            output::pump(
                stdout.unwrap(),
                crate::native_request::MAX_LINE_BYTES,
                |line| {
                    let line = line.unwrap();
                    if line == "READY" {
                        ready_tx.send(()).unwrap();
                    }
                    output.lock().push(line.to_owned());
                    if !current.is_current_generation(generation) {
                        assert!(current
                            .with_current_generation(generation, || panic!("late UI effect"))
                            .is_none());
                    }
                },
            )
        }),
    ));
    let errors = Arc::new(AtomicU64::new(0));
    let count = errors.clone();
    readers.push((
        "stderr",
        ReaderReceipt::spawn(move || {
            output::pump(
                stderr.unwrap(),
                crate::native_request::MAX_LINE_BYTES,
                |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                },
            )
        }),
    ));
    *manager.output.lock() = Some(OutputDrain::new(readers));
    ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    manager
        .stop_until(Instant::now() + Duration::from_secs(10))
        .unwrap();
    assert!(manager.child.lock().is_none());
    assert!(manager.output.lock().is_none());
    assert!(!manager.is_current_generation(generation));
    assert_eq!(errors.load(Ordering::SeqCst), 128);
    let lines = lines.lock();
    assert_eq!(
        lines
            .iter()
            .filter(|line| *line == "CODENOMAD_SHUTDOWN_STATUS:complete")
            .count(),
        1
    );
    assert!(!lines.iter().any(|line| line.contains("incomplete")));
}

#[test]
fn contained_child_with_pending_reader_is_retained_for_bounded_retry() {
    let manager = CliProcessManager::new();
    let mut command = Command::new(which::which("node").unwrap());
    command.args(["-e", "process.exit(0)"]);
    configure_spawn(&mut command);
    let mut child = command.spawn().unwrap();
    assert!(child.wait().unwrap().success());
    *manager.child.lock() = Some(child);
    let (release_tx, release_rx) = mpsc::channel();
    let mut drain = OutputDrain::new(vec![
        ("stdout", ReaderReceipt::spawn(|| Ok(()))),
        (
            "stderr",
            ReaderReceipt::spawn(move || {
                release_rx.recv().unwrap();
                Ok(())
            }),
        ),
    ]);
    drain.contained = true;
    *manager.output.lock() = Some(drain);
    let deadline = Instant::now() + Duration::from_millis(30);
    assert!(manager
        .stop_until(deadline)
        .unwrap_err()
        .to_string()
        .contains("drain deadline"));
    assert!(Instant::now() < deadline + Duration::from_secs(1));
    assert!(manager.child.lock().is_some());
    release_tx.send(()).unwrap();
    manager
        .stop_until(Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert!(manager.child.lock().is_none());
}

#[cfg(unix)]
#[test]
fn escaped_descendant_holding_pipe_fails_within_stop_budget_then_retries() {
    struct ReleasePipe(PathBuf);
    impl Drop for ReleasePipe {
        fn drop(&mut self) {
            let _ = fs::write(&self.0, "release");
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let release = ReleasePipe(temp.path().join("release"));
    let held = format!(
        r#"
        const fs = require('fs');
        const timer = setInterval(() => {{ if (fs.existsSync({})) process.exit(0); }}, 10);
        setTimeout(() => process.exit(2), 10000);
        console.log('HELD');
    "#,
        json!(release.0)
    );
    let root = format!(
        r#"
        const child = require('child_process').spawn(process.execPath, ['-e', {}],
          {{ detached: true, stdio: ['ignore', 'inherit', 'inherit'] }});
        child.unref();
    "#,
        json!(held)
    );
    let manager = CliProcessManager::new();
    let generation = manager.advance_generation();
    let mut command = Command::new(which::which("node").unwrap());
    command
        .args(["-e", &root])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_posix_process_group(&mut command);
    let child = command.spawn().unwrap();
    let (stdout, stderr) = manager.register_spawned_child(generation, child).unwrap();
    let (held_tx, held_rx) = mpsc::channel();
    *manager.output.lock() = Some(OutputDrain::new(vec![
        (
            "stdout",
            ReaderReceipt::spawn(move || {
                output::pump(stdout.unwrap(), 1024, |line| {
                    if line == Some("HELD") {
                        held_tx.send(()).unwrap();
                    }
                })
            }),
        ),
        (
            "stderr",
            ReaderReceipt::spawn(move || output::pump(stderr.unwrap(), 1024, |_| {})),
        ),
    ]));
    held_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let deadline = Instant::now() + Duration::from_millis(100);
    let error = manager.stop_until(deadline).unwrap_err();
    assert!(error.to_string().contains("drain deadline"), "{error}");
    assert!(Instant::now() < deadline + Duration::from_secs(1));
    assert!(manager.child.lock().is_some());
    drop(release);
    manager
        .stop_until(Instant::now() + Duration::from_secs(3))
        .unwrap();
    assert!(manager.child.lock().is_none());
}
