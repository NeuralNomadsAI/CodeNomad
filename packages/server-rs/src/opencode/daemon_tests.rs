use super::*;
use crate::opencode::admission::{Capabilities, Refusal, below_minimum, contract};
use std::{fs, path::PathBuf, sync::Arc};

#[test]
fn service_urls_are_loopback_origins_as_the_reference_admits_them() {
    for ok in ["http://127.0.0.1:4096", "http://localhost:1", "http://[::1]:2", "https://127.0.0.2:3/"] {
        assert!(service_url(ok).is_ok(), "{ok}");
    }
    assert_eq!(service_url("http://0.0.0.0:7").unwrap().as_str(), "http://127.0.0.1:7/");
    for bad in [
        "http://10.0.0.1:1",
        "http://u:p@127.0.0.1:1",
        "http://127.0.0.1:1/x",
        "http://127.0.0.1:1?q",
        "http://127.0.0.1:1 ",
        "ftp://127.0.0.1:1",
        "stopped",
    ] {
        assert_eq!(service_url(bad).unwrap_err(), "Host OpenCode service returned an invalid loopback URL", "{bad}");
    }
}

#[test]
fn cli_output_is_one_strict_line() {
    assert_eq!(single_line("http://x\r\n", "status").unwrap(), "http://x");
    assert_eq!(single_line("secret", "password").unwrap(), "secret");
    assert_eq!(single_line("a\nb\n", "status").unwrap_err(), "Host OpenCode service returned multiline status output");
    assert_eq!(
        single_line(" a\n", "password").unwrap_err(),
        "Host OpenCode service returned malformed password output"
    );
}

#[test]
fn a_v1_help_is_recognised_without_a_version_number() {
    let v1 = "\x1b[1mUsage\x1b[0m\r\nCommands:\n  opencode run   Run\n  opencode serve  Serve\n";
    assert!(service_unavailable(v1, ""));
    assert!(service_unavailable("", v1));
    assert!(!service_unavailable("Commands:\n  opencode service  Manage\n  opencode run\n", ""));
    assert!(!service_unavailable("stopped\n", "") && !service_unavailable("Commands:\n", ""));
}

#[test]
fn only_releases_below_the_minimum_are_refused() {
    for below in ["2.3.1", "1.9.99", "2.2.10", "2.3.1+build.7", "0.0.0-beta-12"] {
        assert!(below_minimum(below), "{below}");
    }
    for admitted in ["2.3.2", "2.3.10", "3.0.0", "2.4.0+local", "dev", "2.3.1-rc.1", "2.3"] {
        assert!(!below_minimum(admitted), "{admitted}");
    }
    let refusal = Refusal::Unsupported { actual: "2.3.1".into(), reason: "native_contract" };
    assert!(refusal.to_string().starts_with("opencode_update_required: OpenCode 2.3.1; requires the background"));
}

fn contract_document() -> Value {
    let body = |field: &str| json!({"requestBody": {"content": {"application/json": {"schema": {"properties": {field: {}}}}}}});
    json!({
        "paths": {
            "/api/session/{sessionID}": {"patch": {}},
            "/api/form": {"get": {}},
            "/api/session/{sessionID}/form/{formID}": {"delete": {}},
            "/api/experimental/session/{sessionID}/wait": {"post": {}},
            "/api/session/{sessionID}/fork": {"post": body("before")},
            "/api/session/{sessionID}/command": {"post": body("name")},
            "/api/session/{sessionID}/permission/{requestID}/reply": {"post": body("decision")},
            "/api/session/{sessionID}/environment": {"put": {"requestBody": {"content": {"application/json":
                {"schema": {"$ref": "#/components/schemas/Env"}}}}}},
        },
        "components": {"schemas": {
            "Env": {"properties": {"variables": {}}},
            "Session.Inbox.User": {"properties": {"time": {}}},
            "Session.Message.Assistant.Text": {"properties": {"native": {}}},
            "Session.Message.Compaction.Completed": {"properties": {"metadata": {}}},
        }},
    })
}

#[test]
fn the_declared_contract_is_negotiated_like_the_reference() {
    let modern = contract_document();
    assert_eq!(contract(&modern), Ok(Capabilities { reload: false }));
    let mut reloadable = modern.clone();
    reloadable["paths"]["/api/location/reload"] = json!({"post": {}});
    assert_eq!(contract(&reloadable), Ok(Capabilities { reload: true }));
    let mut retired = modern.clone();
    retired["components"]["schemas"]["Session.Inbox.User"]["properties"]["timeCreated"] = json!({});
    assert_eq!(contract(&retired), Err("canonical_api"));
    let mut no_env = modern.clone();
    no_env["components"]["schemas"]["Env"]["properties"] = json!({});
    assert_eq!(contract(&no_env), Err("session_environment"));
    let mut replay = modern;
    replay["components"]["schemas"]["Session.Message.Assistant.Text"]["properties"]["state"] = json!({});
    assert_eq!(contract(&replay), Err("native_contract"));
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cnrs-daemon-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(dir.join("state")).unwrap();
    fs::create_dir_all(dir.join("config")).unwrap();
    dir
}

#[test]
fn registration_follows_the_credential_scoped_channel() {
    let dir = scratch("registration");
    let (state, config) = (dir.join("state"), dir.join("config"));
    let s = |p: &PathBuf| p.to_string_lossy().into_owned();
    fs::write(config.join("service.json"), r#"{"password":"a","port":47000}"#).unwrap();
    fs::write(config.join("service-beta.json"), r#"{"password":"b"}"#).unwrap();
    assert_eq!(registration(&s(&state), &s(&config), "a").unwrap(), Some(("http://127.0.0.1:47000".into(), None)));
    assert_eq!(registration(&s(&state), &s(&config), "b").unwrap(), None);
    assert_eq!(
        registration(&s(&state), &s(&config), "c").unwrap_err(),
        "Cannot uniquely identify the selected OpenCode service channel"
    );
    fs::write(state.join("service.json"), r#"{"url":"http://127.0.0.1:47001","pid":12,"password":"a"}"#).unwrap();
    assert_eq!(registration(&s(&state), &s(&config), "a").unwrap(), Some(("http://127.0.0.1:47001".into(), Some(12))));
    fs::write(state.join("service.json"), r#"{"url":"http://127.0.0.1:47001","pid":12,"password":"x"}"#).unwrap();
    assert_eq!(
        registration(&s(&state), &s(&config), "a").unwrap_err(),
        "Invalid native service registration or credential mismatch"
    );
    fs::write(state.join("service.json"), "{").unwrap();
    assert_eq!(registration(&s(&state), &s(&config), "a").unwrap_err(), "Invalid native service metadata");
    fs::write(config.join("service-beta.json"), r#"{"password":"b","port":47002,"hostname":"10.0.0.1"}"#).unwrap();
    assert!(registration(&s(&state), &s(&config), "b").unwrap_err().contains("must be loopback"));
    assert_eq!(
        registration("relative", &s(&config), "a").unwrap_err(),
        "OpenCode returned an invalid native service directory"
    );
    fs::remove_dir_all(dir).unwrap();
}

/// A loopback daemon answering `/api/info` for `password` only, counting its reads.
async fn fake_daemon(password: &'static str, pid: u64) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = reads.clone();
    let auth = format!(
        "basic {}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, format!("opencode:{password}"))
    );
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") && socket.read(&mut byte).await.is_ok_and(|n| n == 1) {
                head.push(byte[0]);
            }
            let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
            let auth = auth.to_ascii_lowercase();
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let (status, body) = if !head.contains(&auth) {
                ("401 Unauthorized", String::new())
            } else if head.starts_with("get /api/info ") {
                ("200 OK", json!({"version": "2.3.2", "pid": pid, "urls": []}).to_string())
            } else {
                ("404 Not Found", String::new())
            };
            let response =
                format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (url, reads)
}

/// A CLI answering from files beside it: `status.txt`, `start.txt`, `password.txt`, `help.txt`.
fn fake_cli(dir: &std::path::Path) -> String {
    #[cfg(windows)]
    {
        let script = dir.join("fake opencode.cmd");
        fs::write(
            &script,
            "@echo off\r\n\
             if exist \"%~dp0help.txt\" type \"%~dp0help.txt\" & exit /b 1\r\n\
             if \"%1 %2\"==\"service status\" type \"%~dp0status.txt\" & exit /b 0\r\n\
             if \"%1 %2 %3\"==\"service get password\" type \"%~dp0password.txt\" & exit /b 0\r\n\
             if \"%1 %2\"==\"service start\" echo start>>\"%~dp0started.log\" & type \"%~dp0start.txt\" & exit /b 0\r\n\
             if \"%1 %2 %3\"==\"debug paths state\" echo %~dp0state& exit /b 0\r\n\
             if \"%1 %2 %3\"==\"debug paths config\" echo %~dp0config& exit /b 0\r\n\
             exit /b 3\r\n",
        )
        .unwrap();
        script.to_string_lossy().into_owned()
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("fake-opencode");
        let d = dir.display();
        fs::write(
            &script,
            format!(
                "#!/bin/sh\n[ -f '{d}/help.txt' ] && {{ cat '{d}/help.txt'; exit 1; }}\ncase \"$*\" in\n\
                 'service status') cat '{d}/status.txt';;\n'service get password') cat '{d}/password.txt';;\n\
                 'service start') echo start >> '{d}/started.log'; cat '{d}/start.txt';;\n\
                 'debug paths state') echo '{d}/state';;\n'debug paths config') echo '{d}/config';;\n*) exit 3;;\nesac\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        script.to_string_lossy().into_owned()
    }
}

fn client() -> Client {
    Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap()
}
fn soon() -> Instant {
    Instant::now() + TIMEOUT
}

#[tokio::test]
async fn discovery_authenticates_a_running_daemon_and_starts_a_missing_one() {
    let dir = scratch("lifecycle");
    let (url, _) = fake_daemon("secret", 4242).await;
    let lifecycle = Lifecycle::new(fake_cli(&dir), client());
    fs::write(dir.join("password.txt"), "secret\n").unwrap();

    fs::write(dir.join("status.txt"), format!("{url}\n")).unwrap();
    let found = lifecycle.discover(soon()).await.unwrap().unwrap();
    assert_eq!((found.url.as_str(), found.version.as_str(), found.pid), (&*format!("{url}/"), "2.3.2", 4242));

    // Stopped, no registration and no configured port: absence, then one start.
    fs::write(dir.join("status.txt"), "stopped\n").unwrap();
    fs::write(dir.join("config").join("service.json"), r#"{"password":"secret"}"#).unwrap();
    fs::write(dir.join("start.txt"), format!("{url}\n")).unwrap();
    assert_eq!(lifecycle.discover(soon()).await.unwrap(), None);
    assert_eq!(lifecycle.ensure(soon()).await.unwrap(), found);
    assert_eq!(fs::read_to_string(dir.join("started.log")).unwrap().lines().count(), 1);

    // A stale registration whose listener is gone is absence; a wrong password is not.
    fs::write(dir.join("state").join("service.json"), r#"{"url":"http://127.0.0.1:9","pid":7,"password":"secret"}"#)
        .unwrap();
    assert_eq!(lifecycle.discover(soon()).await.unwrap(), None);
    fs::write(dir.join("password.txt"), "wrong\n").unwrap();
    fs::write(dir.join("status.txt"), format!("{url}\n")).unwrap();
    assert_eq!(
        lifecycle.discover(soon()).await.unwrap_err(),
        format!("Host OpenCode service authentication failed at {url} (HTTP 401)")
    );

    fs::write(dir.join("help.txt"), "Commands:\n  opencode run  Run\n").unwrap();
    assert_eq!(lifecycle.discover(soon()).await.unwrap_err(), V2_REQUIRED);
    fs::remove_file(dir.join("help.txt")).unwrap();
    fs::write(dir.join("status.txt"), "a\nb\n").unwrap();
    assert_eq!(lifecycle.discover(soon()).await.unwrap_err(), "Host OpenCode service returned multiline status output");
    assert_eq!(
        lifecycle.discover(Instant::now()).await.unwrap_err(),
        format!("Host OpenCode service status timed out after {}ms", TIMEOUT.as_millis())
    );
    let missing = Lifecycle::new(dir.join("absent-opencode").to_string_lossy().into_owned(), client());
    assert!(
        missing.discover(soon()).await.unwrap_err().starts_with("Host OpenCode service status failed: code ENOENT")
    );
    let wsl = Lifecycle::new(r"\\wsl$\Ubuntu\usr\bin\opencode".into(), client());
    assert_eq!(wsl.ensure(soon()).await.unwrap_err(), "WSL OpenCode is not supported by this backend");
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn the_shared_connection_is_kept_rechecked_and_replaced_after_a_restart() {
    let dir = scratch("native");
    let (first, first_reads) = fake_daemon("secret", 1).await;
    let (second, _) = fake_daemon("secret", 2).await;
    fs::write(dir.join("password.txt"), "secret\n").unwrap();
    fs::write(dir.join("status.txt"), format!("{first}\n")).unwrap();
    let native = crate::opencode::Native::connect(&fake_cli(&dir)).unwrap();
    assert_eq!(native.url().as_str(), "http://127.0.0.1:0/");
    let connected = native.acquire(soon()).await.unwrap();
    assert_eq!(connected.pid, 1);
    assert_eq!(native.url(), connected.url);
    assert!(native.current(&connected));

    // Confirmed less than 30 s ago: no discovery at all.
    fs::write(dir.join("status.txt"), format!("{second}\n")).unwrap();
    let reads = first_reads.load(std::sync::atomic::Ordering::SeqCst);
    assert!(Arc::ptr_eq(&native.acquire(soon()).await.unwrap(), &connected));
    assert_eq!(first_reads.load(std::sync::atomic::Ordering::SeqCst), reads);

    // The stream ended (daemon restarted elsewhere): the next acquisition follows it.
    native.invalidate(&connected);
    assert!(!native.current(&connected));
    let replaced = native.acquire(soon()).await.unwrap();
    assert!(!native.current(&connected));
    assert!(native.current(&replaced));
    assert_eq!((replaced.pid, native.password()), (2, "secret".to_owned()));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn daemon_environment_honors_profile_vars_and_excludes_protected_keys() {
    let dir = scratch("daemon-env");
    let config = dir.join("config.yaml");
    fs::write(
        &config,
        "server:\n  environmentVariables:\n    MY_CUSTOM_FLAG: enabled\n    NODE_EXTRA_CA_CERTS: /tmp/profile-ca.pem\n    OPENCODE_DB: /evil/db\n    XDG_STATE_HOME: /evil/state\n    CODENOMAD_PROFILE: prod\n    ELECTRON_RUN_AS_NODE: \"1\"\n    ELECTRON_NO_ASAR: \"1\"\n    CNRS_TEST_SECRET: nope\n",
    )
    .unwrap();
    let env = launch::daemon_environment_from_config(Some(&config)).unwrap();
    let get = |name: &str| {
        env.iter()
            .find(|(k, _)| if cfg!(windows) { k.eq_ignore_ascii_case(name) } else { k == name })
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(get("MY_CUSTOM_FLAG"), Some("enabled"));
    if std::env::var("NODE_EXTRA_CA_CERTS").is_err() {
        assert_eq!(get("NODE_EXTRA_CA_CERTS"), Some("/tmp/profile-ca.pem"));
    }
    assert_eq!(get("OPENCODE_DB"), None);
    assert_eq!(get("XDG_STATE_HOME"), None);
    assert_eq!(get("CODENOMAD_PROFILE"), None);
    assert_eq!(get("ELECTRON_RUN_AS_NODE"), None);
    assert_eq!(get("ELECTRON_NO_ASAR"), None);
    assert_eq!(get("CNRS_TEST_SECRET"), None);

    // Invalid variable names are rejected like TS `serviceStartupEnvironment`.
    let bad = dir.join("bad-config.yaml");
    fs::write(&bad, "server:\n  environmentVariables:\n    \"BAD=KEY\": nope\n").unwrap();
    assert_eq!(
        launch::daemon_environment_from_config(Some(&bad)).unwrap_err(),
        "Invalid OpenCode service environment variable name: BAD=KEY"
    );
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn restart_stops_running_daemon_and_passes_profile_env_on_start() {
    let dir = scratch("restart-env");
    let (url, _) = fake_daemon("secret", 77).await;
    let config = dir.join("config.yaml");
    fs::write(
        &config,
        "server:\n  environmentVariables:\n    CN_PROFILE_ENV_TEST: from-profile\n    OPENCODE_DB: blocked\n",
    )
    .unwrap();
    fs::write(dir.join("config").join("service.json"), r#"{"password":"secret"}"#).unwrap();
    fs::write(dir.join("password.txt"), "secret\n").unwrap();
    fs::write(dir.join("status.txt"), format!("{url}\n")).unwrap();
    fs::write(dir.join("start.txt"), format!("{url}\n")).unwrap();
    #[cfg(windows)]
    let cli = {
        let script = dir.join("restart-opencode.cmd");
        fs::write(
            &script,
            "@echo off\r\n\
             if \"%1 %2\"==\"service stop\" ((echo stop)>>\"%~dp0stop.log\" & (echo stopped)>\"%~dp0status.txt\" & exit /b 0)\r\n\
             if \"%1 %2\"==\"service status\" (type \"%~dp0status.txt\" & exit /b 0)\r\n\
             if \"%1 %2 %3\"==\"service get password\" (type \"%~dp0password.txt\" & exit /b 0)\r\n\
             if \"%1 %2\"==\"service start\" ((echo %CN_PROFILE_ENV_TEST%^|%OPENCODE_DB%)>\"%~dp0start-env.txt\" & copy /y \"%~dp0start.txt\" \"%~dp0status.txt\" >nul & type \"%~dp0start.txt\" & exit /b 0)\r\n\
             if \"%1 %2 %3\"==\"debug paths state\" (echo %~dp0state& exit /b 0)\r\n\
             if \"%1 %2 %3\"==\"debug paths config\" (echo %~dp0config& exit /b 0)\r\n\
             exit /b 3\r\n",
        )
        .unwrap();
        script.to_string_lossy().into_owned()
    };
    #[cfg(not(windows))]
    let cli = {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("restart-opencode");
        let d = dir.display();
        fs::write(
            &script,
            format!(
                "#!/bin/sh\ncase \"$*\" in\n\
                 'service stop') echo stop >> '{d}/stop.log'; echo stopped > '{d}/status.txt';;\n\
                 'service status') cat '{d}/status.txt';;\n\
                 'service get password') cat '{d}/password.txt';;\n\
                 'service start') printf '%s|%s\\n' \"$CN_PROFILE_ENV_TEST\" \"$OPENCODE_DB\" > '{d}/start-env.txt'; cp '{d}/start.txt' '{d}/status.txt'; cat '{d}/start.txt';;\n\
                 'debug paths state') echo '{d}/state';;\n\
                 'debug paths config') echo '{d}/config';;\n\
                 *) exit 3;;\nesac\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        script.to_string_lossy().into_owned()
    };
    let lifecycle = Lifecycle::with_config(cli.clone(), client(), Some(config.clone()));
    let restarted = lifecycle.restart(soon()).await.unwrap();
    assert_eq!(restarted.pid, 77);
    assert_eq!(fs::read_to_string(dir.join("stop.log")).unwrap().lines().count(), 1);
    assert_eq!(fs::read_to_string(dir.join("start-env.txt")).unwrap().trim(), "from-profile|");

    // Invalid profile environment must fail BEFORE calling `service stop`.
    fs::write(&config, "server:\n  environmentVariables:\n    \"BAD=KEY\": nope\n").unwrap();
    let err = lifecycle.restart(soon()).await.unwrap_err();
    assert!(err.contains("Invalid OpenCode service environment variable name"));
    assert_eq!(fs::read_to_string(dir.join("stop.log")).unwrap().lines().count(), 1);
    fs::remove_dir_all(dir).unwrap();
}
