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
    let mut config = LaunchConfig::trial(executable, &root, "trial-rune-host").unwrap();
    config
        .environment
        .insert("CODENOMAD_SESSION_ABSOLUTE_SECONDS".into(), "2".into());
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
    let renewal = first.session_renewal();
    crate::platform::block_on(async {
        assert!(renewal.replace(backend.clone()).await.is_none());
        tokio::time::sleep(Duration::from_millis(2100)).await;
        assert_eq!(
            backend.authentication_status().await.unwrap()["authenticated"],
            false
        );
        let renewed = renewal
            .replace(backend.clone())
            .await
            .expect("owned parent renewal");
        assert!(!renewed.client.same_connection(&backend.client));
        assert_eq!(
            renewed.authentication_status().await.unwrap()["authenticated"],
            true
        );
        assert_eq!(
            backend.authentication_status().await.unwrap()["authenticated"],
            false
        );
        let response = renewed
            .client
            .post(format!("{}api/auth/logout", backend.base))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert!(renewal.replace(renewed).await.is_none());
    });
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
    assert!(crate::platform::block_on(renewal.replace(backend)).is_none());
    let _backend = second.connect().unwrap();
    let report = second.stop().unwrap();
    assert!(!report.forced && report.native_cleanup_confirmed);
}
