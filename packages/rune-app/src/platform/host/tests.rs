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
    let line = r#"CODENOMAD_NATIVE_REQUEST:{"v":1,"id":"owned-request","method":"developer.status","params":{"password":"SECRET"},"deadline":9999999999999}"#;
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
fn opencode_service_start_contract_routes_fences_and_executes_bounded() {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let future_deadline = now_ms + 30_000;
    let valid_line = format!(
        r#"CODENOMAD_NATIVE_REQUEST:{{"v":1,"id":"start-1","method":"opencode.service.start","params":{{"file":"x","args":[],"env":{{}},"cwd":".","windowsVerbatimArguments":false}},"deadline":{future_deadline}}}"#
    );
    assert!(matches!(
        protocol::classify(&valid_line),
        protocol::Line::NativeServiceStart { ref id, deadline, .. }
            if id == "start-1" && deadline == future_deadline
    ));

    // Expired opencode.service.start is refused directly without spawning.
    let expired_line = r#"CODENOMAD_NATIVE_REQUEST:{"v":1,"id":"start-exp","method":"opencode.service.start","params":{"file":"x","args":[],"env":{},"cwd":".","windowsVerbatimArguments":false},"deadline":1}"#;
    let protocol::Line::Native { response, .. } = protocol::classify(expired_line) else {
        panic!("Expected immediate expiry refusal");
    };
    let expired_val: serde_json::Value = serde_json::from_str(
        response
            .trim()
            .strip_prefix("CODENOMAD_NATIVE_RESPONSE:")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(expired_val["ok"], false);
    assert_eq!(
        expired_val["error"]["message"],
        "Native request expired before execution"
    );

    // Queued ok:true reply that expires before stdin write becomes ok:false expired error.
    let ok_reply = protocol::native_ok(
        "start-queued",
        serde_json::json!({"stdout":"ok","stderr":""}),
    );
    let fenced = protocol::fenced_response(ok_reply, Instant::now(), 1);
    let fenced_val: serde_json::Value = serde_json::from_str(
        fenced
            .trim()
            .strip_prefix("CODENOMAD_NATIVE_RESPONSE:")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(fenced_val["id"], "start-queued");
    assert_eq!(fenced_val["ok"], false);
    assert_eq!(
        fenced_val["error"]["message"],
        "Native request expired before execution"
    );
    assert!(fenced_val.get("result").is_none());

    // Unknown params fields and pre-cancelled requests are refused cleanly.
    assert_eq!(
        service_start::run(
            serde_json::json!({
                "file": "x",
                "args": [],
                "env": {},
                "cwd": ".",
                "windowsVerbatimArguments": false,
                "unexpected": "SECRET"
            }),
            future_deadline,
            || false,
        ),
        Err(service_start::Error::Failed)
    );
    assert_eq!(
        service_start::run(
            serde_json::json!({
                "file": "x",
                "args": [],
                "env": {},
                "cwd": ".",
                "windowsVerbatimArguments": false
            }),
            future_deadline,
            || true,
        ),
        Err(service_start::Error::Cancelled)
    );

    // Bounded execution: stdout/stderr capture, non-zero exit redaction, output cap, and timeout.
    let temp = fresh_root("service-start");
    fs::create_dir_all(&temp).unwrap();
    let base_env: serde_json::Map<String, serde_json::Value> = std::env::vars()
        .map(|(k, v)| (k, serde_json::Value::String(v)))
        .collect();
    #[cfg(windows)]
    {
        let ok_cmd = temp.join("ok wrapper.cmd");
        fs::write(&ok_cmd, "@echo off\r\necho %~1\r\necho notice 1>&2\r\n").unwrap();
        let params = serde_json::json!({
            "file": "cmd.exe",
            "args": ["/d", "/s", "/c", format!("\"\"{}\" \"a b\"\"", ok_cmd.display())],
            "env": base_env,
            "cwd": temp,
            "windowsVerbatimArguments": true,
        });
        let result = service_start::run(params, future_deadline, || false).unwrap();
        assert_eq!(result["stdout"], "a b\r\n");
        assert!(result["stderr"].as_str().unwrap().contains("notice"));

        let fail_cmd = temp.join("fail.cmd");
        fs::write(&fail_cmd, "@echo off\r\necho SECRET 1>&2\r\nexit /b 1\r\n").unwrap();
        let fail_params = serde_json::json!({
            "file": "cmd.exe",
            "args": ["/d", "/c", fail_cmd],
            "env": base_env,
            "cwd": temp,
            "windowsVerbatimArguments": false,
        });
        assert_eq!(
            service_start::run(fail_params, future_deadline, || false),
            Err(service_start::Error::Failed)
        );
    }
    #[cfg(unix)]
    {
        let ok_params = serde_json::json!({
            "file": "/bin/sh",
            "args": ["-c", "printf 'started'; printf 'notice' >&2"],
            "env": base_env,
            "cwd": temp,
            "windowsVerbatimArguments": false,
        });
        let result = service_start::run(ok_params, future_deadline, || false).unwrap();
        assert_eq!(
            result,
            serde_json::json!({"stdout": "started", "stderr": "notice"})
        );

        let fail_params = serde_json::json!({
            "file": "/bin/sh",
            "args": ["-c", "printf 'SECRET' >&2; exit 1"],
            "env": base_env,
            "cwd": temp,
            "windowsVerbatimArguments": false,
        });
        assert_eq!(
            service_start::run(fail_params, future_deadline, || false),
            Err(service_start::Error::Failed)
        );
    }

    // Async dispatch_service_start delivers ok:true over Control::Native and fences stale generation.
    let active = Arc::new(AtomicUsize::new(0));
    let shutdown = Arc::new(AtomicBool::new(false));
    let authority = Arc::new(AtomicU64::new(1));
    let (tx, rx) = mpsc::sync_channel::<Control>(4);
    #[cfg(windows)]
    let dispatch_params = serde_json::json!({
        "file": "cmd.exe",
        "args": ["/d", "/c", "echo ok"],
        "env": base_env,
        "cwd": temp,
        "windowsVerbatimArguments": false,
    });
    #[cfg(unix)]
    let dispatch_params = serde_json::json!({
        "file": "/bin/sh",
        "args": ["-c", "printf ok"],
        "env": base_env,
        "cwd": temp,
        "windowsVerbatimArguments": false,
    });
    dispatch_service_start(
        "async-start".into(),
        dispatch_params,
        Instant::now() + Duration::from_secs(10),
        future_deadline,
        &active,
        &shutdown,
        &authority,
        1,
        &tx,
    );
    let Control::Native { response, .. } = rx.recv_timeout(Duration::from_secs(5)).unwrap() else {
        panic!("Expected Control::Native reply");
    };
    let dispatched: serde_json::Value = serde_json::from_str(
        response
            .trim()
            .strip_prefix("CODENOMAD_NATIVE_RESPONSE:")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(dispatched["id"], "async-start");
    assert_eq!(dispatched["ok"], true);
    assert!(
        dispatched["result"]["stdout"]
            .as_str()
            .unwrap()
            .contains("ok")
    );
    assert_eq!(active.load(Ordering::SeqCst), 0);

    // Concurrency cap returns an immediate failure without spawning.
    active.store(MAX_CONCURRENT_SERVICE_STARTS, Ordering::SeqCst);
    dispatch_service_start(
        "capped-start".into(),
        serde_json::json!({}),
        Instant::now() + Duration::from_secs(10),
        future_deadline,
        &active,
        &shutdown,
        &authority,
        1,
        &tx,
    );
    let Control::Native { response, .. } = rx.recv_timeout(Duration::from_secs(1)).unwrap() else {
        panic!("Expected capped error reply");
    };
    let capped: serde_json::Value = serde_json::from_str(
        response
            .trim()
            .strip_prefix("CODENOMAD_NATIVE_RESPONSE:")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(capped["id"], "capped-start");
    assert_eq!(capped["ok"], false);
    assert_eq!(capped["error"]["message"], "OpenCode service start failed");
    let _ = fs::remove_dir_all(&temp);
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

#[test]
fn desktop_launch_builds_standard_and_named_profiles_and_sanitizes_env() {
    // Verify SHA-256 scope suffixes against shared Electron/Tauri data-profile vectors.
    assert_eq!(
        config::scope_suffix("dev", "/home/dev/.config/codenomad/config.yaml"),
        "6698b32b9d7b4a38"
    );
    assert_eq!(
        config::scope_suffix("dev", r"c:\users\dev\.config\codenomad\config.yaml"),
        "adceedb0dd29790c"
    );
    assert_eq!(
        config::scope_suffix("stable", "/work/other/config.yaml"),
        "218200c29d8465d1"
    );

    let root = fresh_root("desktop-config");
    let install_dir = root.join("install");
    let home = root.join("home");
    let local_data = root.join("local-data");
    fs::create_dir_all(&install_dir).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&local_data).unwrap();
    let sibling = install_dir.join(config::SERVER_BINARY_NAME);
    fs::write(&sibling, b"server").unwrap();

    let mut inherited = std::collections::BTreeMap::<std::ffi::OsString, std::ffi::OsString>::new();
    inherited.insert("HOME".into(), home.clone().into_os_string());
    inherited.insert("USERPROFILE".into(), home.clone().into_os_string());
    inherited.insert("LOCALAPPDATA".into(), local_data.clone().into_os_string());
    inherited.insert("XDG_DATA_HOME".into(), local_data.clone().into_os_string());
    inherited.insert("MY_DESKTOP_VAR".into(), "keep-me".into());
    inherited.insert("RUNE_BACKEND".into(), "http://127.0.0.1:9999/".into());
    inherited.insert("RUNE_NO_AUTOLAUNCH".into(), "1".into());
    inherited.insert("CNRS_FIXTURE_URL".into(), "http://127.0.0.1:1/".into());
    inherited.insert("CODENOMAD_SERVER_PASSWORD".into(), "leaked".into());
    inherited.insert("CODENOMAD_SKIP_AUTH".into(), "1".into());
    inherited.insert("CLI_LAUNCH".into(), "1".into());
    inherited.insert("ELECTRON_RUN_AS_NODE".into(), "1".into());

    // 1. Standard default desktop launch (no CODENOMAD_PROFILE).
    let cfg = LaunchConfig::desktop_with_env(sibling.clone(), &install_dir, &inherited).unwrap();
    assert_eq!(cfg.profile, "stable");
    assert_eq!(cfg.working_directory, home);
    assert_eq!(
        cfg.config_file,
        home.join(".config").join("codenomad").join("config.yaml")
    );
    assert!(!cfg.ephemeral_ports);
    let default_state = cfg.state_directory().expect("desktop state directory");
    assert_eq!(default_state.file_name().unwrap(), "default");
    assert!(
        default_state.parent().unwrap().is_dir(),
        "state parent must exist for storage::native::Files::open"
    );

    let command = cfg.command("desktop-cookie").unwrap();
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        args,
        vec![
            "serve",
            "--host",
            "127.0.0.1",
            "--auth-cookie-name",
            "desktop-cookie",
            "--generate-token",
            "--unrestricted-root",
            "--https",
            "true",
            "--http",
            "true",
        ]
    );
    let env: std::collections::BTreeMap<_, _> = command
        .get_envs()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect();
    assert_eq!(env["CODENOMAD_NATIVE_PARENT"].as_deref(), Some("1"));
    assert_eq!(env["CODENOMAD_PROFILE"].as_deref(), Some("stable"));
    assert_eq!(env["CODENOMAD_UPDATE_CHANNEL"].as_deref(), Some("stable"));
    assert_eq!(
        env["CODENOMAD_PROFILE_CONFIG_IDENTITY"].as_deref(),
        Some(cfg.config_identity.as_str())
    );
    assert_eq!(
        env["CLI_CONFIG"].as_deref(),
        Some(cfg.config_file.to_string_lossy().as_ref())
    );
    assert_eq!(env["MY_DESKTOP_VAR"].as_deref(), Some("keep-me"));
    for stripped in [
        "RUNE_BACKEND",
        "RUNE_NO_AUTOLAUNCH",
        "CNRS_FIXTURE_URL",
        "CODENOMAD_SERVER_PASSWORD",
        "CODENOMAD_SKIP_AUTH",
        "CLI_LAUNCH",
        "ELECTRON_RUN_AS_NODE",
    ] {
        assert!(!env.contains_key(stripped), "must strip {stripped}");
    }

    // 2. Named profile (`CODENOMAD_PROFILE= Work `) scopes Rune UI state independently.
    let mut named_env = inherited.clone();
    named_env.insert("CODENOMAD_PROFILE".into(), " Work ".into());
    let named = LaunchConfig::desktop_with_env(sibling.clone(), &install_dir, &named_env).unwrap();
    assert_eq!(named.profile, "work");
    let named_state = named.state_directory().unwrap();
    assert_ne!(named_state, default_state);
    assert!(
        named_state
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("work-")
    );

    // 3. Explicit `CODENOMAD_PROFILE=default` resolves to `stable` and default state dir.
    let mut explicit_default = inherited.clone();
    explicit_default.insert("CODENOMAD_PROFILE".into(), "default".into());
    let def =
        LaunchConfig::desktop_with_env(sibling.clone(), &install_dir, &explicit_default).unwrap();
    assert_eq!(def.profile, "stable");
    assert_eq!(def.state_directory().unwrap(), default_state);

    // 4. Custom CLI_CONFIG normalizes legacy .json to config.yaml and scopes state dir.
    let mut custom_cfg = inherited.clone();
    custom_cfg.insert("CLI_CONFIG".into(), "~/custom/config.json".into());
    let custom =
        LaunchConfig::desktop_with_env(sibling.clone(), &install_dir, &custom_cfg).unwrap();
    assert_eq!(custom.config_file, home.join("custom").join("config.yaml"));
    assert_ne!(custom.state_directory().unwrap(), default_state);
    assert!(
        custom
            .state_directory()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("stable-")
    );

    // 5. Invalid CODENOMAD_PROFILE fails closed instead of falling back to default.
    let mut invalid_env = inherited;
    invalid_env.insert("CODENOMAD_PROFILE".into(), "../escape".into());
    assert!(LaunchConfig::desktop_with_env(sibling, &install_dir, &invalid_env).is_err());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn desktop_launch_isolated_install_dir_round_trip() {
    let root = fresh_root("desktop-install-roundtrip");
    let install_dir = root.join("app");
    let home = root.join("home");
    let local_data = root.join("local");
    fs::create_dir_all(&install_dir).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&local_data).unwrap();

    let fake_rune = install_dir.join(if cfg!(windows) {
        "codenomad-rune.exe"
    } else {
        "codenomad-rune"
    });
    fs::write(&fake_rune, b"rune").unwrap();
    let sibling = install_dir.join(config::SERVER_BINARY_NAME);

    let mut env = std::collections::BTreeMap::<std::ffi::OsString, std::ffi::OsString>::new();
    for (k, v) in std::env::vars_os() {
        let upper = k.to_string_lossy().to_ascii_uppercase();
        if matches!(
            upper.as_str(),
            "PATH" | "PATHEXT" | "SYSTEMROOT" | "WINDIR" | "COMSPEC" | "SYSTEMDRIVE"
        ) {
            env.insert(k, v);
        }
    }
    env.insert("HOME".into(), home.clone().into_os_string());
    env.insert("USERPROFILE".into(), home.clone().into_os_string());
    env.insert("APPDATA".into(), root.join("roaming").into_os_string());
    env.insert("LOCALAPPDATA".into(), local_data.clone().into_os_string());
    env.insert("XDG_DATA_HOME".into(), local_data.clone().into_os_string());
    env.insert(
        "XDG_CONFIG_HOME".into(),
        home.join(".config").into_os_string(),
    );
    env.insert("TEMP".into(), root.join("tmp").into_os_string());
    env.insert("TMP".into(), root.join("tmp").into_os_string());
    fs::create_dir_all(root.join("tmp")).unwrap();
    fs::create_dir_all(root.join("roaming")).unwrap();

    if let Some(real_server) = std::env::var_os("CODENOMAD_HOST_TEST_SERVER").map(PathBuf::from) {
        // Real sibling codenomad-rs in an isolated install folder (never touches real OS profile).
        fs::copy(&real_server, &sibling).unwrap();
        let cfg_dir = home.join(".config").join("codenomad");
        fs::create_dir_all(&cfg_dir).unwrap();
        let blocked_cli = root.join("disabled-opencode-cli");
        fs::write(
            cfg_dir.join("config.yaml"),
            serde_json::to_vec_pretty(
                &serde_json::json!({"server": {"opencodeBinary": blocked_cli}}),
            )
            .unwrap(),
        )
        .unwrap();
        env.insert("CODENOMAD_REMOTE_CONTROL".into(), "disabled".into());

        let discovered = discover_sibling_server(&fake_rune).expect("discover sibling server");
        assert_eq!(discovered, sibling);
        let mut config = LaunchConfig::desktop_with_env(discovered, &install_dir, &env).unwrap();
        config.ephemeral_ports = true;
        let state_dir = config.state_directory().unwrap();
        let mut child = Controller::default().launch(config).unwrap();
        let backend = child.connect().unwrap();
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
        let report = child.stop().unwrap();
        assert!(!report.forced && report.native_cleanup_confirmed && report.exit_code == Some(0));
        assert!(state_dir.parent().unwrap().is_dir());
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server_thread = thread::spawn(move || {
                use std::io::{Read, Write};
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut buf = [0u8; 4096];
                    let _ = stream.read(&mut buf);
                    let body = r#"{"authenticated":true,"username":"opencode"}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: desktop=ok; HttpOnly\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes());
                }
            });
            fs::write(
                &sibling,
                format!(
                    "#!/bin/sh\n\
                     [ \"$CODENOMAD_NATIVE_PARENT\" = \"1\" ] || exit 11\n\
                     printf 'CODENOMAD_BOOTSTRAP_TOKEN:desktop-bootstrap-tok\\n'\n\
                     printf 'Local Connection URL : http://127.0.0.1:{port}\\n'\n\
                     while IFS= read -r line; do\n\
                       if [ \"$line\" = \"codenomad:shutdown\" ]; then\n\
                         printf 'CODENOMAD_SHUTDOWN_COMPLETE:true\\n'\n\
                         exit 0\n\
                       fi\n\
                     done\n\
                     exit 1\n"
                ),
            )
            .unwrap();
            fs::set_permissions(&sibling, fs::Permissions::from_mode(0o755)).unwrap();

            let discovered = discover_sibling_server(&fake_rune).expect("discover sibling server");
            assert_eq!(discovered, sibling);
            let config = LaunchConfig::desktop_with_env(discovered, &install_dir, &env).unwrap();
            let mut child = Controller::default().launch(config).unwrap();
            let backend = child.connect().unwrap();
            assert_eq!(backend.base, format!("http://127.0.0.1:{port}/"));
            let report = child.stop().unwrap();
            assert!(
                !report.forced && report.native_cleanup_confirmed && report.exit_code == Some(0)
            );
            server_thread.join().unwrap();
        }
        #[cfg(windows)]
        {
            fs::write(&sibling, b"stub-server").unwrap();
            let discovered = discover_sibling_server(&fake_rune).expect("discover sibling server");
            assert_eq!(discovered, sibling);
            let config = LaunchConfig::desktop_with_env(discovered, &install_dir, &env).unwrap();
            let state_dir = config.state_directory().expect("desktop state directory");
            assert!(state_dir.starts_with(local_data.join("CodeNomad").join("rune")));
            assert!(state_dir.parent().unwrap().is_dir());
            assert!(config.command("desktop-cookie").is_ok());
        }
    }

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn desktop_profile_lease_enforces_exclusivity_releases_on_drop_and_isolates_profiles() {
    let root = fresh_root("desktop-lease");
    let home = root.join("home");
    let local_data = root.join("local-data");
    let install_dir = root.join("install");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&local_data).unwrap();
    fs::create_dir_all(&install_dir).unwrap();
    let server = install_dir.join(if cfg!(windows) {
        "codenomad-rs.exe"
    } else {
        "codenomad-rs"
    });
    fs::write(&server, b"stub-server").unwrap();

    let mut base_env = std::collections::BTreeMap::new();
    base_env.insert("USERPROFILE".into(), home.clone().into_os_string());
    base_env.insert("HOME".into(), home.clone().into_os_string());
    base_env.insert("LOCALAPPDATA".into(), local_data.clone().into_os_string());
    base_env.insert("XDG_DATA_HOME".into(), local_data.clone().into_os_string());

    let cfg_default_a = LaunchConfig::desktop_with_env(server.clone(), &home, &base_env).unwrap();
    let cfg_default_b = LaunchConfig::desktop_with_env(server.clone(), &home, &base_env).unwrap();
    assert_eq!(cfg_default_a.desktop_lock, cfg_default_b.desktop_lock);
    let lock_path = cfg_default_a
        .desktop_lock
        .clone()
        .expect("desktop lock path");
    assert_eq!(
        lock_path.file_name().and_then(|n| n.to_str()),
        Some("default.host.lock")
    );

    // First acquisition succeeds; second concurrent acquisition and Controller::launch fail closed.
    let lease_a = super::lease::acquire(&cfg_default_a)
        .unwrap()
        .expect("desktop lease acquired");
    let err = super::lease::acquire(&cfg_default_b)
        .err()
        .expect("second lease must be busy");
    assert_eq!(err.kind(), std::io::ErrorKind::WouldBlock);
    let launch_err = Controller::default()
        .launch(cfg_default_b)
        .err()
        .expect("concurrent Controller::launch must fail before spawning");
    assert_eq!(launch_err.kind(), std::io::ErrorKind::WouldBlock);

    // Distinct named profile and distinct CLI_CONFIG hold independent leases concurrently.
    let mut dev_env = base_env.clone();
    dev_env.insert("CODENOMAD_PROFILE".into(), "dev".into());
    let cfg_dev = LaunchConfig::desktop_with_env(server.clone(), &home, &dev_env).unwrap();
    let _lease_dev = super::lease::acquire(&cfg_dev)
        .unwrap()
        .expect("distinct profile lease succeeds concurrently");

    let mut custom_env = base_env.clone();
    let custom_cfg = root.join("custom-cfg");
    custom_env.insert("CLI_CONFIG".into(), custom_cfg.into_os_string());
    let cfg_custom = LaunchConfig::desktop_with_env(server.clone(), &home, &custom_env).unwrap();
    let _lease_custom = super::lease::acquire(&cfg_custom)
        .unwrap()
        .expect("distinct CLI_CONFIG lease succeeds concurrently");

    // Dropping the owner lease immediately releases the profile for the next launch.
    drop(lease_a);
    let lease_reacquired = super::lease::acquire(&cfg_default_a)
        .unwrap()
        .expect("lease reacquired after drop");
    drop(lease_reacquired);

    #[cfg(unix)]
    {
        let target = root.join("outside.lock");
        fs::write(&target, b"outside").unwrap();
        let _ = fs::remove_file(&lock_path);
        std::os::unix::fs::symlink(&target, &lock_path).unwrap();
        assert!(super::lease::acquire(&cfg_default_a).is_err());
    }

    let _ = fs::remove_dir_all(&root);
}
