use super::*;
use std::{
    fs,
    io::{BufReader, Cursor},
    path::PathBuf,
};

#[test]
fn bounded_protocol_drains_oversized_lines_and_preserves_utf8() {
    let mut bytes = vec![b'x'; protocol::MAX_LINE + 1];
    bytes.extend_from_slice(b"CODENOMAD_BOOTSTRAP_TOKEN:discard\n");
    bytes.extend_from_slice("é🙂\nCODENOMAD_BOOTSTRAP_TOKEN:private\n".as_bytes());
    let mut lines = Vec::new();
    protocol::pump(BufReader::with_capacity(2, Cursor::new(bytes)), |line| {
        lines.push(line.map(str::to_owned))
    })
    .unwrap();
    assert_eq!(
        lines,
        [
            None,
            Some("é🙂".into()),
            Some("CODENOMAD_BOOTSTRAP_TOKEN:private".into())
        ]
    );
}

#[test]
fn local_readiness_refuses_foreign_and_credential_endpoints() {
    for url in [
        "https://127.0.0.1:1234",
        "http://localhost:1234",
        "http://127.0.0.1:1234/path",
        "http://user:secret@127.0.0.1:1234",
        "http://127.0.0.1:1234/?token=secret",
    ] {
        assert!(!protocol::loopback_url(url));
    }
    assert!(matches!(
        protocol::classify("Local Connection URL : http://127.0.0.1:1234"),
        protocol::Line::Ready(_)
    ));
}

#[test]
fn native_capability_denial_correlates_without_reflecting_params() {
    let line = r#"CODENOMAD_NATIVE_REQUEST:{"v":1,"id":"owned-request","method":"opencode.service.start","params":{"password":"SECRET"},"deadline":9999999999999}"#;
    let protocol::Line::Native {
        response, expires, ..
    } = protocol::classify(line)
    else {
        panic!("Expected explicit native response")
    };
    assert!(!response.contains("SECRET"));
    assert!(expires > Instant::now());
    let value: serde_json::Value = serde_json::from_str(
        response
            .trim()
            .strip_prefix("CODENOMAD_NATIVE_RESPONSE:")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value["v"], 1);
    assert_eq!(value["id"], "owned-request");
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["code"], "native_error");
}

#[test]
fn managed_session_reply_classification_validates_id_and_token() {
    let id = "9d754f99-0b08-44d0-a99c-0d6c95229647";
    let token = "abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE";
    assert_eq!(token.len(), 43);
    assert!(matches!(
        protocol::classify(&format!("CODENOMAD_MANAGED_SESSION:{id} {token}")),
        protocol::Line::ManagedSession { id: ref parsed_id, session: Some(ref parsed) }
            if parsed_id == id && parsed == token
    ));
    assert!(matches!(
        protocol::classify(&format!("CODENOMAD_MANAGED_SESSION:{id} -")),
        protocol::Line::ManagedSession { id: ref parsed_id, session: None } if parsed_id == id
    ));
    for bad in [
        format!("CODENOMAD_MANAGED_SESSION:{id} short"),
        format!("CODENOMAD_MANAGED_SESSION:{id} {token}extra"),
        format!("CODENOMAD_MANAGED_SESSION:{id} {token} "),
        format!("CODENOMAD_MANAGED_SESSION:bad-id {token}"),
        format!("CODENOMAD_MANAGED_SESSION:------------------------------------ {token}"),
        format!(
            "CODENOMAD_MANAGED_SESSION:{} {token}",
            id.to_ascii_uppercase()
        ),
        format!("CODENOMAD_MANAGED_SESSION:{id} {token} trailing"),
    ] {
        assert!(
            matches!(protocol::classify(&bad), protocol::Line::Diagnostic),
            "{bad:?}"
        );
    }
    let mut pumped = Vec::new();
    protocol::pump(
        BufReader::new(Cursor::new(format!(
            "CODENOMAD_MANAGED_SESSION:{id} {token} \r\nCODENOMAD_MANAGED_SESSION:{id} {token}"
        ))),
        |line| pumped.push(line.map(str::to_owned)),
    )
    .unwrap();
    assert_eq!(
        pumped,
        [Some(format!("CODENOMAD_MANAGED_SESSION:{id} {token} "))],
        "trailing spaces stay intact and unterminated EOF lines are discarded"
    );
    assert_eq!(
        protocol::renew_command(id),
        format!("codenomad:renew-session {id}\n")
    );
}

#[test]
fn renewal_pipe_ignores_unrelated_uuid_wakes_on_eof_and_skips_expired_writes() {
    let id = "9d754f99-0b08-44d0-a99c-0d6c95229647";
    let wrong_id = "11111111-2222-4333-8444-555555555555";
    let token = "abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE";

    // 1. Writer skips an already-expired or superseded renewal command without writing to stdin.
    let (writer_tx, writer_rx) = mpsc::sync_channel::<Control>(4);
    let shutdown = Arc::new(AtomicBool::new(false));
    let authority = Arc::new(AtomicU64::new(1));
    let pending = Arc::new(Mutex::new(None::<PendingRenewal>));
    let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
    struct SharedBuf(Arc<Mutex<Vec<u8>>>);
    impl Write for SharedBuf {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    writer_tx
        .send(Control::RenewSession {
            id: id.into(),
            command: protocol::renew_command(id),
            deadline: Instant::now() - Duration::from_millis(1),
        })
        .unwrap();
    drop(writer_tx);
    write_control_loop(
        SharedBuf(captured.clone()),
        writer_rx,
        shutdown.clone(),
        authority.clone(),
        1,
        pending.clone(),
    );
    assert!(
        captured.lock().unwrap().is_empty(),
        "expired or cleared renewal command must not be written to stdin"
    );

    // 2. Unrelated valid UUID is ignored; matching UUID resolves the pending wait.
    let (writer_tx, writer_rx) = mpsc::sync_channel::<Control>(4);
    let pending = Arc::new(Mutex::new(None::<PendingRenewal>));
    let stdout_closed = Arc::new(AtomicBool::new(false));
    let cancel = Arc::new(AtomicBool::new(false));
    let pending_reader = pending.clone();
    let responder = thread::spawn(move || {
        let Ok(Control::RenewSession { id: sent_id, .. }) = writer_rx.recv() else {
            return;
        };
        assert_eq!(sent_id, id);
        for line in [
            format!("CODENOMAD_MANAGED_SESSION:{wrong_id} -"),
            format!("CODENOMAD_MANAGED_SESSION:{id} {token}"),
        ] {
            if let protocol::Line::ManagedSession { id, session } = protocol::classify(&line) {
                let mut guard = pending_reader.lock().unwrap();
                if guard.as_ref().is_some_and(|req| req.id == id)
                    && let Some(req) = guard.take()
                {
                    let _ = req.reply.try_send(session);
                }
            }
        }
    });
    let outcome = request_managed_session(
        &pending,
        &writer_tx,
        &stdout_closed,
        &cancel,
        || true,
        id.into(),
        Instant::now() + Duration::from_secs(2),
    );
    responder.join().unwrap();
    assert_eq!(outcome, RenewalWait::Token(token.into()));

    // 3. Stdout EOF wakes the pending renewal wait immediately with Denied.
    let (writer_tx, writer_rx) = mpsc::sync_channel::<Control>(4);
    let pending = Arc::new(Mutex::new(None::<PendingRenewal>));
    let stdout_closed = Arc::new(AtomicBool::new(false));
    let eof_flag = stdout_closed.clone();
    let eof_pending = pending.clone();
    let eof_thread = thread::spawn(move || {
        let _ = writer_rx.recv();
        eof_flag.store(true, Ordering::SeqCst);
        eof_pending.lock().unwrap().take();
    });
    let started = Instant::now();
    let outcome = request_managed_session(
        &pending,
        &writer_tx,
        &stdout_closed,
        &cancel,
        || true,
        id.into(),
        Instant::now() + Duration::from_secs(3),
    );
    eof_thread.join().unwrap();
    assert_eq!(outcome, RenewalWait::Denied);
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "stdout EOF must wake pending renewal without waiting for the 3s timeout"
    );
}

#[test]
fn trial_launch_has_explicit_isolated_profile_and_no_parent_secrets() {
    let root = fresh_root("config");
    let config =
        LaunchConfig::trial(std::env::current_exe().unwrap(), &root, "trial-host-config").unwrap();
    let document: serde_json::Value =
        serde_json::from_slice(&fs::read(&config.config_file).unwrap()).unwrap();
    let native_binary = PathBuf::from(document["server"]["opencodeBinary"].as_str().unwrap());
    assert!(native_binary.is_absolute() && native_binary.starts_with(&root));
    assert!(
        !native_binary.exists(),
        "trial native discovery must remain closed"
    );
    assert_ne!(native_binary.file_name().unwrap(), "opencode2");
    assert_ne!(native_binary.file_name().unwrap(), "opencode");
    let command = config.command("owned-cookie").unwrap();
    let env: std::collections::BTreeMap<_, _> = command
        .get_envs()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect();
    assert_eq!(
        env["CODENOMAD_PROFILE"].as_deref(),
        Some("trial-host-config")
    );
    assert_eq!(env["CODENOMAD_NATIVE_PARENT"].as_deref(), Some("1"));
    for name in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "CLI_CONFIG",
        "TEMP",
    ] {
        assert!(PathBuf::from(env[name].as_ref().unwrap()).starts_with(&root));
    }
    assert!(!env.contains_key("OPENAI_API_KEY"));
    assert!(
        !env.contains_key("CNRS_FIXTURE_URL"),
        "serve uses the explicit custom binary contract"
    );
    assert!(
        LaunchConfig::trial(
            std::env::current_exe().unwrap(),
            &fresh_root("invalid"),
            "stable"
        )
        .is_err()
    );
}

#[test]
fn trial_roots_cannot_enable_service_resolver_fallback() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/.local/share/codenomad/opencode/trial-refused-root");
    assert!(LaunchConfig::trial(std::env::current_exe().unwrap(), &root, "trial-host").is_err());
    assert!(!root.exists());
}

fn fresh_root(label: &str) -> PathBuf {
    let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/host-tests");
    fs::create_dir_all(&parent).unwrap();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    parent.join(format!("trial-{label}-{}-{nonce}", std::process::id()))
}

/// Set CODENOMAD_HOST_TEST_SERVER to the separately built real codenomad-rs.
/// The trial's absent custom CLI prevents discovery of an installed daemon.
#[test]
#[ignore = "requires an explicit real Rust server executable"]
fn real_serve_bootstrap_stop_and_new_generation() {
    let executable = PathBuf::from(
        std::env::var_os("CODENOMAD_HOST_TEST_SERVER").expect("Explicit real server executable"),
    );
    assert!(executable.is_absolute() && executable.is_file());
    let root = fresh_root("real-serve");
    let config = LaunchConfig::trial(executable, &root, "trial-rune-host").unwrap();
    let controller = Controller::default();
    let mut first = controller.launch(config.clone()).unwrap();
    let first_generation = first.generation();
    let backend = first.connect().unwrap();
    assert_eq!(
        crate::platform::block_on(async {
            backend
                .client
                .get(format!("{}api/meta", backend.base))
                .send()
                .await
        })
        .unwrap()
        .status(),
        200
    );
    assert!(
        first.connect().is_err(),
        "Bootstrap token consumed only once"
    );
    let report = first.stop().unwrap();
    assert!(!report.forced);
    assert!(report.native_cleanup_confirmed);
    assert_eq!(report.exit_code, Some(0));
    let mut second = controller.launch(config).unwrap();
    assert!(second.generation() > first_generation);
    assert!(
        first.connect().is_err(),
        "Previous generation cannot authenticate"
    );
    let _backend = second.connect().unwrap();
    let report = second.stop().unwrap();
    assert!(!report.forced && report.native_cleanup_confirmed);
}
