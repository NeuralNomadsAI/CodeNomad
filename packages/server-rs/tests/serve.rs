//! The binary started as Tauri's `cli_manager.rs` starts the reference: same arguments and variables,
//! then the ready line, the token exchange, the UI, the TLS files and a clean stop over stdin.
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::mpsc,
    time::timeout,
};

const COOKIE: &str = "codenomad_session_4242_1700000000000";
const PROD: [&str; 11] = [
    "serve",
    "--host",
    "127.0.0.1",
    "--auth-cookie-name",
    COOKIE,
    "--generate-token",
    "--unrestricted-root",
    "--https",
    "true",
    "--http",
    "true",
];

fn ci_enabled() -> bool {
    std::env::var_os("CI").is_some_and(|v| {
        let s = v.to_string_lossy();
        let trimmed = s.trim();
        !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("false") && trimmed != "0"
    })
}

fn is_loopback_host(raw: &str) -> bool {
    let trimmed = raw.trim();
    let stripped = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(trimmed);
    stripped.is_empty()
        || stripped.eq_ignore_ascii_case("localhost")
        || stripped.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.to_canonical().is_loopback())
}

fn assert_loopback_command(command: &std::process::Command) {
    let args: Vec<String> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    for pair in args.windows(2) {
        if pair[0] == "--host" {
            assert!(
                is_loopback_host(&pair[1]),
                "local serve tests must bind loopback only (set CI for wildcard host tests), got --host {}",
                pair[1]
            );
        }
    }
    for arg in &args {
        if let Some(host) = arg.strip_prefix("--host=") {
            assert!(
                is_loopback_host(host),
                "local serve tests must bind loopback only (set CI for wildcard host tests), got --host={host}"
            );
        }
    }
    for (key, value) in command.get_envs() {
        let Some(value) = value else { continue };
        let key = key.to_string_lossy();
        let val = value.to_string_lossy();
        if key.eq_ignore_ascii_case("CODENOMAD_LOCKED_HOST") || key.eq_ignore_ascii_case("CLI_HOST") {
            assert!(
                is_loopback_host(&val),
                "local serve tests must bind loopback only (set CI for wildcard host tests), got {key}={val}"
            );
        } else if key.eq_ignore_ascii_case("CNRS_HTTPS_BIND") && !val.trim().is_empty() {
            assert!(
                val.trim().parse::<std::net::SocketAddr>().is_ok_and(|addr| addr.ip().to_canonical().is_loopback()),
                "local serve tests must bind loopback only (set CI for wildcard host tests), got {key}={val}"
            );
        }
    }
}

struct Server {
    child: Child,
    lines: mpsc::UnboundedReceiver<String>,
    root: PathBuf,
    config: PathBuf,
    pid: u32,
}

impl Server {
    /// `exe` with the hosts' variables in a private home; the daemon endpoint is a placeholder.
    fn start(root: PathBuf, exe: &Path, args: &[&str]) -> Self {
        Self::start_with(root, exe, args, |command| {
            command
                .env("CODENOMAD_NATIVE_PARENT", "1")
                .env("CNRS_FIXTURE_URL", "http://127.0.0.1:9/")
                .env("CNRS_FIXTURE_PASSWORD", "placeholder");
        })
    }

    fn start_with(root: PathBuf, exe: &Path, args: &[&str], configure: impl FnOnce(&mut Command)) -> Self {
        let resolved = dunce::canonicalize(&root)
            .unwrap_or_else(|_| dunce::canonicalize(root.parent().unwrap()).unwrap().join(root.file_name().unwrap()));
        let actual_home = std::env::home_dir().and_then(|home| dunce::canonicalize(home).ok());
        assert!(actual_home.is_some_and(|home| !resolved.starts_with(home)), "Test root is under the user's home");
        let (home, config, cwd) = (root.join("home"), root.join("config"), root.join("cwd"));
        for dir in [&home, &config, &cwd] {
            fs::create_dir_all(dir).unwrap();
        }
        let config = dunce::canonicalize(config).unwrap();
        assert!(config.starts_with(resolved), "Test config escapes the private root");
        let mut command = Command::new(exe);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        command.args(args).current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true);
        for (name, _) in std::env::vars_os() {
            let name = name.to_string_lossy().into_owned();
            let name = name.to_ascii_uppercase();
            if ["CODENOMAD_", "CLI_", "CNRS_", "XDG_"].iter().any(|prefix| name.starts_with(prefix)) {
                command.env_remove(name);
            }
        }
        configure(&mut command);
        command
            .env("CLI_CONFIG", &config)
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("APPDATA", home.join("AppData/Roaming"))
            .env("LOCALAPPDATA", home.join("AppData/Local"))
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_DATA_HOME", home.join(".local/share"))
            .env("XDG_STATE_HOME", home.join(".local/state"))
            .env("XDG_CACHE_HOME", home.join(".cache"));
        if !ci_enabled() {
            assert_loopback_command(command.as_std());
        }
        let mut child = command.spawn().unwrap();
        let (tx, lines) = mpsc::unbounded_channel();
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        tokio::spawn(async move {
            while let Ok(Some(line)) = stdout.next_line().await {
                let _ = tx.send(line);
            }
        });
        let pid = child.id().unwrap();
        Self { child, lines, root, config, pid }
    }
    async fn line(&mut self) -> String {
        timeout(Duration::from_secs(60), self.lines.recv()).await.expect("stdout line within the hosts' 60 s").unwrap()
    }
    /// `cli_manager.rs`: the token, then the URL matched by its regular expression, then the remote URL.
    async fn ready(&mut self) -> (String, String, String) {
        let token = self.line().await.strip_prefix("CODENOMAD_BOOTSTRAP_TOKEN:").unwrap().to_owned();
        let ready = regex::Regex::new(r"(?i)^Local\s+Connection\s+URL\s*:\s*(https?://\S+)\s*$").unwrap();
        let url = ready.captures(&self.line().await).unwrap()[1].to_owned();
        assert!(url.starts_with("http://127.0.0.1:"));
        (token, url, self.line().await)
    }
    /// `cli_manager.rs` stop: the command, end of input, the status line and exit within 30 s.
    async fn stop(mut self, before: &[u8]) {
        let mut stdin = self.child.stdin.take().unwrap();
        stdin.write_all(before).await.unwrap();
        stdin.write_all(b"codenomad:shutdown\n").await.unwrap();
        drop(stdin);
        while self.line().await != "CODENOMAD_SHUTDOWN_STATUS:complete" {}
        let exit = timeout(Duration::from_secs(30), self.child.wait()).await.expect("exit within 30 s").unwrap();
        assert!(exit.success());
        assert!(published(&self.bridges(), self.pid).is_empty(), "registration removed on stop");
        let _ = fs::remove_dir_all(&self.root);
    }
    /// `automationBridgeDirectory` of the child's private environment.
    fn bridges(&self) -> PathBuf {
        let home = self.root.join("home");
        if cfg!(windows) { home.join("AppData/Local/CodeNomad") } else { home.join(".config/codenomad") }
            .join("automation-bridges")
    }
}

/// Registration files of `pid` in `dir`.
fn published(dir: &Path, pid: u32) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else { return vec![] };
    let mark = format!("-{pid}-");
    entries.flatten().map(|e| e.path()).filter(|p| p.to_string_lossy().contains(&mark)).collect()
}

/// The user's own `automation-bridges/`, as this test process sees it.
fn user_bridges() -> Option<PathBuf> {
    let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    let base = match var("LOCALAPPDATA").filter(|_| cfg!(windows)) {
        Some(local) => local.join("CodeNomad"),
        None => match var("XDG_RUNTIME_DIR") {
            Some(runtime) => runtime.join("codenomad"),
            None => var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?.join(".config").join("codenomad"),
        },
    };
    Some(base.join("automation-bridges"))
}

fn scratch(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    std::env::temp_dir().join(format!("cnrs-{name}-{}-{nanos}", std::process::id()))
}

/// The request `cli_manager.rs` writes on a raw socket; the whole answer, which needs `Connection: close`.
async fn tauri_exchange(url: &str, token: &str) -> String {
    let url = reqwest::Url::parse(url).unwrap();
    let (host, port) = (url.host_str().unwrap().to_owned(), url.port().unwrap());
    let body = format!("{{\"token\":\"{token}\"}}");
    tokio::task::spawn_blocking(move || {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect((host.as_str(), port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let request = format!(
            "POST /api/auth/token HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    })
    .await
    .unwrap()
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap()
}

#[tokio::test]
async fn serve_selects_opencode_from_cli_config_before_path() {
    for (selection, marker) in [(true, "selected-cli"), (false, "automatic-cli")] {
        let root = scratch("opencode-selection");
        let bin = root.join("fixture-bin");
        let config = root.join("config");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&config).unwrap();
        let fixture = |name: &str, marker: &str| {
            let file = bin.join(if cfg!(windows) { format!("{name}.cmd") } else { name.to_owned() });
            let script = if cfg!(windows) {
                format!("@echo off\r\nif \"%1 %2\"==\"service status\" echo {marker}\r\nexit /b 7\r\n")
            } else {
                format!("#!/bin/sh\n[ \"$*\" = 'service status' ] && echo {marker}\nexit 7\n")
            };
            fs::write(&file, script).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).unwrap();
            }
            file
        };
        let selected = fixture("custom opencode", "selected-cli");
        fixture("opencode2", "automatic-cli");
        let selected = if selection { selected.to_str().unwrap() } else { "opencode2" };
        fs::write(config.join("config.yaml"), serde_json::json!({"server": {"opencodeBinary": selected}}).to_string())
            .unwrap();
        let executable = Path::new(env!("CARGO_BIN_EXE_codenomad-rs"));
        let mut server = Server::start_with(
            root,
            executable,
            &["serve", "--generate-token", "--http", "true", "--http-port", "0", "--https", "false"],
            |command| {
                command.env_clear();
                #[cfg(windows)]
                {
                    let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
                    command.env("SystemRoot", &system).env("ComSpec", system.join(r"System32\cmd.exe"));
                }
                let home = bin.parent().unwrap().join("home");
                command
                    .env("PATH", &bin)
                    .env("PATHEXT", ".CMD")
                    .env("ProgramData", home.join("ProgramData"))
                    .env("TEMP", &home)
                    .env("TMP", &home)
                    .env("TMPDIR", &home);
            },
        );
        let (token, url, _) = server.ready().await;
        let client = client();
        let auth = client.post(format!("{url}/api/auth/token")).json(&serde_json::json!({ "token": token }));
        let token_response = auth.send().await.unwrap();
        let cookie = token_response.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap();
        let response = client
            .post(format!("{url}/api/workspaces"))
            .header("cookie", cookie)
            .json(&serde_json::json!({"path": server.root.join("cwd")}))
            .timeout(Duration::from_secs(40))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body = response.text().await.unwrap();
        server.stop(b"").await;
        assert_eq!(status, 400, "{body}");
        assert!(body.contains(marker), "{body}");
    }
}

#[tokio::test]
async fn desktop_launch_contract() {
    let root = scratch("serve");
    // The packaged layout: the executable with the UI bundle in `public/` beside it.
    let app = root.join("app");
    fs::create_dir_all(app.join("public/assets")).unwrap();
    let exe = app.join(Path::new(env!("CARGO_BIN_EXE_codenomad-rs")).file_name().unwrap());
    fs::copy(env!("CARGO_BIN_EXE_codenomad-rs"), &exe).unwrap();
    fs::write(app.join("public/index.html"), "<!doctype html><title>ui</title>").unwrap();
    fs::write(app.join("public/assets/app.js"), "console.log(1)").unwrap();
    fs::write(app.join("public/ui-version.json"), r#"{"uiVersion":"9.9.9"}"#).unwrap();
    fs::write(app.join("public/.secret"), "hidden").unwrap();
    let mut server = Server::start(root, &exe, &PROD);
    fs::write(server.root.join("cwd/plain.txt"), "outside").unwrap();
    let (token, url, remote) = server.ready().await;
    assert!(remote.starts_with("Remote Connection URL : https://localhost:"), "{remote}");
    // The plugin bridge is advertised in the private home only, never in the user's registry.
    assert_eq!(published(&server.bridges(), server.pid).len(), 1);
    if let Some(user) = user_bridges() {
        assert!(published(&user, server.pid).is_empty(), "registration in {}", user.display());
    }
    for file in ["ca-cert.pem", "server-cert.pem", "server-key.pem"] {
        assert!(server.config.join("tls").join(file).is_file(), "{file}");
    }

    let client = client();
    let get = |path: &str, cookie: Option<&str>| {
        let request = client.get(format!("{url}{path}")).header("accept", "text/html");
        match cookie {
            Some(cookie) => request.header("cookie", cookie),
            None => request,
        }
    };
    let page = get("/", None).send().await.unwrap();
    assert_eq!((page.status().as_u16(), page.headers()["location"].to_str().unwrap()), (302, "/login"));
    let login = get("/login", None).send().await.unwrap();
    assert_eq!(login.headers()["cache-control"], "no-store");
    assert!(login.text().await.unwrap().contains(r#"value="codenomad""#));
    assert_eq!(get("/auth/token", None).send().await.unwrap().status(), 200);
    let unauthorized = client.get(format!("{url}/api/meta")).send().await.unwrap();
    assert_eq!(unauthorized.status(), 401);

    // `exchange_bootstrap_token`: Tauri's own HTTP/1.1 request, read to the end of the connection.
    let set = tauri_exchange(&url, &token).await;
    let set = set.lines().find_map(|l| l.strip_prefix("set-cookie: ")).expect("200 with a cookie").to_owned();
    assert!(
        set.starts_with(&format!("{COOKIE}=")) && set.ends_with("; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800")
    );
    let cookie = set.split(';').next().unwrap().to_owned();
    assert!(tauri_exchange(&url, &token).await.starts_with("HTTP/1.1 401 "));

    let status: serde_json::Value = get("/api/auth/status", Some(&cookie)).send().await.unwrap().json().await.unwrap();
    assert_eq!(
        status,
        serde_json::json!({"authenticated": true, "username": "codenomad", "passwordUserProvided": false})
    );
    let meta: serde_json::Value = get("/api/meta", Some(&cookie)).send().await.unwrap().json().await.unwrap();
    let identity = fs::read_to_string(server.config.join("config.yaml.server-id")).unwrap();
    assert_eq!(meta["serverId"], identity.trim());
    assert_eq!(meta["ui"], serde_json::json!({"source": "bundled", "version": "9.9.9"}));
    assert_eq!(get("/", Some(&cookie)).send().await.unwrap().text().await.unwrap(), "<!doctype html><title>ui</title>");
    let asset = get("/assets/app.js", Some(&cookie)).send().await.unwrap();
    assert_eq!(asset.headers()["content-type"], "application/javascript; charset=utf-8");
    assert_eq!(asset.text().await.unwrap(), "console.log(1)");
    let spa = get("/workspace/route", Some(&cookie)).send().await.unwrap();
    assert!(spa.text().await.unwrap().contains("<title>ui</title>"));
    let long_sidecar = format!("/sidecars/{}/app", "i".repeat(101));
    for path in ["/sidecars", "/sidecars?x=1", &long_sidecar] {
        let fallback = get(path, Some(&cookie)).send().await.unwrap();
        assert_eq!(fallback.status(), 200, "{path}");
        assert_eq!(fallback.headers()["content-type"], "text/html; charset=utf-8", "{path}");
        assert!(fallback.text().await.unwrap().contains("<title>ui</title>"), "{path}");
    }
    for hidden in ["/.secret", "/assets%5C..%5C..%5C..%5Ccwd%5Cplain.txt"] {
        let body = get(hidden, Some(&cookie)).send().await.unwrap().text().await.unwrap();
        assert!(body.contains("<title>ui</title>"), "{hidden}: {body}");
    }

    // An event stream stays open during the stop; it must not hold the drain.
    let events = get("/api/events?clientId=c&connectionId=s", Some(&cookie)).send().await.unwrap();
    assert_eq!(events.status(), 200);
    server.stop(b"CODENOMAD_NATIVE_RESPONSE:{\"v\":1,\"id\":\"stale\",\"ok\":true}\n").await;
    drop(events);
}

/// Tauri's development launch: loopback HTTP on any port, the UI from the Vite server.
#[tokio::test]
async fn desktop_dev_launch_proxies_the_ui() {
    let vite = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dev = format!("http://localhost:{}", vite.local_addr().unwrap().port());
    let app = axum::Router::new().fallback(|request: axum::extract::Request| async move {
        let seen = format!("{} {}", request.method(), request.uri());
        ([("content-type", "text/html"), ("x-vite", "1")], seen)
    });
    tokio::spawn(async move { axum::serve(vite, app).await });
    let args = [&PROD[..], &["--http-port", "0"]].concat();
    let args = [&args[..], &["--ui-dev-server", &dev, "--log-level", "info"]].concat();
    let mut server = Server::start(scratch("dev"), Path::new(env!("CARGO_BIN_EXE_codenomad-rs")), &args);
    let (token, url, _) = server.ready().await;
    let client = client();
    let set = client.post(format!("{url}/api/auth/token")).json(&serde_json::json!({ "token": token })).send().await;
    let cookie = set.unwrap().headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned();
    let page = client.get(format!("{url}/src/main.tsx?t=1")).header("cookie", &cookie).send().await.unwrap();
    assert_eq!(page.headers()["x-vite"], "1");
    assert_eq!(page.text().await.unwrap(), "GET /src/main.tsx?t=1");
    let meta: serde_json::Value =
        client.get(format!("{url}/api/meta")).header("cookie", &cookie).send().await.unwrap().json().await.unwrap();
    assert_eq!(meta["ui"], serde_json::json!({"source": "dev-proxy"}));
    server.stop(b"").await;
}

/// Tauri's "all interfaces" listening mode (`--host 0.0.0.0`): HTTPS binds the wildcard while native
/// desktop HTTP stays on 127.0.0.1, matching `packages/server/src/index.ts`.
#[tokio::test]
async fn desktop_launch_accepts_wildcard_host_and_keeps_http_on_loopback() {
    // Binding `--host 0.0.0.0` triggers the Windows Firewall prompt for each new test binary; run in CI only.
    if !ci_enabled() {
        return;
    }
    let args = [
        "serve",
        "--host",
        "0.0.0.0",
        "--auth-cookie-name",
        COOKIE,
        "--generate-token",
        "--unrestricted-root",
        "--https",
        "true",
        "--http",
        "true",
        "--http-port",
        "0",
        "--https-port",
        "0",
    ];
    let mut server = Server::start(scratch("wildcard"), Path::new(env!("CARGO_BIN_EXE_codenomad-rs")), &args);
    let (token, url, remote) = server.ready().await;
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");
    let remote_url = remote.strip_prefix("Remote Connection URL : ").expect(&remote);
    assert!(remote_url.starts_with("https://") && !remote_url.contains("0.0.0.0"), "{remote}");
    for file in ["ca-cert.pem", "server-cert.pem", "server-key.pem"] {
        assert!(server.config.join("tls").join(file).is_file(), "{file}");
    }
    let client = client();
    let set = client.post(format!("{url}/api/auth/token")).json(&serde_json::json!({ "token": token })).send().await;
    let cookie = set.unwrap().headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned();
    let meta: serde_json::Value =
        client.get(format!("{url}/api/meta")).header("cookie", &cookie).send().await.unwrap().json().await.unwrap();
    assert_eq!(meta["host"], "0.0.0.0");
    assert_eq!(meta["listeningMode"], "all");
    assert_eq!(meta["remoteUrl"], remote_url);
    let remote_port = meta["remotePort"].as_u64().expect("remotePort");
    assert!(remote_port > 0, "{meta}");
    assert!(meta["addresses"].as_array().is_some_and(|a| !a.is_empty()), "{meta}");

    // Verify the wildcard HTTPS listener answers real TLS requests on 127.0.0.1 and rejects rogue Host headers.
    let ca_pem = fs::read(server.config.join("tls").join("ca-cert.pem")).unwrap();
    let ca = reqwest::Certificate::from_pem(&ca_pem).unwrap();
    let https = reqwest::Client::builder().no_proxy().add_root_certificate(ca).build().unwrap();
    let tls_status = https.get(format!("https://127.0.0.1:{remote_port}/api/auth/status")).send().await.unwrap();
    assert_eq!(tls_status.status(), 200);
    let tls_body: serde_json::Value = tls_status.json().await.unwrap();
    assert_eq!(tls_body["authenticated"], false);
    let misdirected = https
        .get(format!("https://127.0.0.1:{remote_port}/api/auth/status"))
        .header("host", format!("rogue.invalid:{remote_port}"))
        .send()
        .await
        .unwrap();
    assert_eq!(misdirected.status(), 421);

    server.stop(b"").await;
}

#[tokio::test]
async fn shutdown_cancels_pending_plugin_snapshot() {
    let root = scratch("pending-stop");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let directory = dunce::canonicalize(&project).unwrap();
    let native = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let native_url = format!("http://{}/", native.local_addr().unwrap());
    let waiting = std::sync::Arc::new(tokio::sync::Notify::new());
    let entered = waiting.clone();
    let stub = axum::Router::new()
        .route(
            "/api/location",
            axum::routing::get(move || async move { axum::Json(serde_json::json!({"directory":directory})) }),
        )
        .route(
            "/api/plugin",
            axum::routing::get(move || async move {
                entered.notify_one();
                std::future::pending::<axum::http::StatusCode>().await
            }),
        );
    tokio::spawn(async move { axum::serve(native, stub).await });
    let mut command = Command::new(env!("CARGO_BIN_EXE_codenomad-rs"));
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
        .env_clear()
        .envs(std::env::vars_os().filter(|(key, _)| {
            matches!(key.to_string_lossy().to_ascii_uppercase().as_str(), "PATH" | "SYSTEMROOT" | "WINDIR")
        }))
        .env("HOME", &root)
        .env("USERPROFILE", &root)
        .env("GIT_CEILING_DIRECTORIES", &root)
        .env("CNRS_SERVER_PASSWORD", "fixture-only")
        .env("CNRS_FIXTURE_URL", native_url)
        .env("CNRS_FIXTURE_PASSWORD", "fixture-daemon")
        .env("CNRS_FIXTURE_STDIN_STOP", "1")
        .args([root.as_os_str(), root.join("identity.json").as_os_str(), "0".as_ref(), "fixture".as_ref()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    if !ci_enabled() {
        assert_loopback_command(command.as_std());
    }
    let mut child = command.spawn().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let url = timeout(Duration::from_secs(30), stdout.next_line()).await.unwrap().unwrap().unwrap();
    let client = client();
    let login = client
        .post(format!("{url}/api/auth/login"))
        .json(&serde_json::json!({
            "username":"codenomad", "password":"fixture-only"
        }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let cookie = login.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned();
    let workspace: serde_json::Value = client
        .post(format!("{url}/api/workspaces"))
        .header("cookie", &cookie)
        .json(&serde_json::json!({"path":project}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = workspace["id"].as_str().unwrap();
    let pending = tokio::spawn(
        client
            .get(format!("{url}/api/workspaces/{id}/pending-requests"))
            .header("cookie", cookie)
            .query(&[("directories", project.to_str().unwrap())])
            .send(),
    );
    timeout(Duration::from_secs(15), waiting.notified()).await.expect("snapshot reached the plugin");
    child.stdin.take().unwrap().write_all(b"shutdown\n").await.unwrap();
    let response = timeout(Duration::from_secs(15), pending).await.expect("cancel pending snapshot").unwrap().unwrap();
    assert_eq!(response.status(), 503);
    assert_eq!(response.json::<serde_json::Value>().await.unwrap()["error"], "Server is shutting down");
    assert!(timeout(Duration::from_secs(15), child.wait()).await.unwrap().unwrap().success());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn managed_session_renews_over_parent_pipes_and_retires_on_logout() {
    let args = [&PROD[..], &["--https", "false", "--http-port", "0"]].concat();
    let mut server =
        Server::start_with(scratch("managed-renew"), Path::new(env!("CARGO_BIN_EXE_codenomad-rs")), &args, |cmd| {
            cmd.env("CODENOMAD_NATIVE_PARENT", "1")
                .env("CODENOMAD_SESSION_IDLE_SECONDS", "1")
                .env("CNRS_FIXTURE_URL", "http://127.0.0.1:9/")
                .env("CNRS_FIXTURE_PASSWORD", "placeholder");
        });
    let (token, url, _) = server.ready().await;
    let client = client();
    let set = client
        .post(format!("{url}/api/auth/token"))
        .json(&serde_json::json!({ "token": token }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let old_cookie = set.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned();
    assert_eq!(client.get(format!("{url}/api/meta")).header("cookie", &old_cookie).send().await.unwrap().status(), 200);

    async fn ask(stdin: &mut tokio::process::ChildStdin, id: &str) {
        let line = format!("codenomad:renew-session {id}\n");
        stdin.write_all(line.as_bytes()).await.unwrap();
        stdin.flush().await.unwrap();
    }
    async fn read_reply(server: &mut Server, id: &str) -> String {
        let prefix = format!("CODENOMAD_MANAGED_SESSION:{id} ");
        loop {
            let line = server.line().await;
            if let Some(value) = line.strip_prefix(&prefix) {
                return value.to_owned();
            }
        }
    }

    // Active delivered session must not renew.
    let id1 = "9d754f99-0b08-44d0-a99c-0d6c95229647";
    ask(server.child.stdin.as_mut().unwrap(), id1).await;
    assert_eq!(read_reply(&mut server, id1).await, "-");

    // Wait for the 1 s idle expiry, verify 401, then renew over parent stdin/stdout.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(client.get(format!("{url}/api/meta")).header("cookie", &old_cookie).send().await.unwrap().status(), 401);
    let id2 = "11111111-2222-4333-8444-555555555555";
    ask(server.child.stdin.as_mut().unwrap(), id2).await;
    let renewed = read_reply(&mut server, id2).await;
    assert_eq!(renewed.len(), 43);
    let new_cookie = format!("{COOKIE}={renewed}");
    assert_ne!(new_cookie, old_cookie);
    assert_eq!(client.get(format!("{url}/api/meta")).header("cookie", &new_cookie).send().await.unwrap().status(), 200);

    // Logout revokes the renewed session and retires the managed renewal right.
    assert_eq!(
        client.post(format!("{url}/api/auth/logout")).header("cookie", &new_cookie).send().await.unwrap().status(),
        200
    );
    assert_eq!(client.get(format!("{url}/api/meta")).header("cookie", &new_cookie).send().await.unwrap().status(), 401);
    let id3 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    ask(server.child.stdin.as_mut().unwrap(), id3).await;
    assert_eq!(read_reply(&mut server, id3).await, "-");

    server.stop(b"").await;
}

#[tokio::test]
async fn serve_declares_missions_capability_without_bench_env() {
    let executable = Path::new(env!("CARGO_BIN_EXE_codenomad-rs"));
    let args =
        ["serve", "--host", "127.0.0.1", "--generate-token", "--http", "true", "--http-port", "0", "--https", "false"];
    for (label, block_bridge, fixture_run_env) in [
        ("clean-serve", false, false),
        ("bridge-unavailable", true, false),
        ("no-duplicate-with-fixture-env", false, true),
    ] {
        let root = scratch(&format!("missions-meta-{label}"));
        let bridge_path = if cfg!(windows) {
            root.join("home/AppData/Local/CodeNomad/automation-bridges")
        } else {
            root.join("home/.config/codenomad/automation-bridges")
        };
        let mut server = Server::start_with(root, executable, &args, |command| {
            if block_bridge {
                fs::create_dir_all(bridge_path.parent().unwrap()).unwrap();
                fs::write(&bridge_path, "blocked").unwrap();
            }
            if fixture_run_env {
                command.env("CNRS_FIXTURE_MISSIONS_RUN", "1");
            }
        });
        let (token, url, _) = server.ready().await;
        let client = client();
        let token_response = client
            .post(format!("{url}/api/auth/token"))
            .json(&serde_json::json!({ "token": token }))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .unwrap();
        assert_eq!(token_response.status(), 200, "{label}");
        let cookie = token_response.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned();
        let meta: serde_json::Value = client
            .get(format!("{url}/api/meta"))
            .header("cookie", &cookie)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let capabilities = meta["capabilities"].as_array().expect("capabilities array");
        let missions_count = capabilities.iter().filter(|cap| *cap == "missions").count();
        assert_eq!(missions_count, 1, "{label}: expected exactly one missions capability, got {capabilities:?}");
        if block_bridge {
            assert!(published(&server.bridges(), server.pid).is_empty(), "blocked bridge must not publish");
        } else {
            assert_eq!(published(&server.bridges(), server.pid).len(), 1, "clean serve must publish its bridge");
        }
        server.stop(b"").await;
    }
}

#[test]
fn local_serve_command_guard_rejects_non_loopback_hosts_and_env() {
    let ok = |configure: &dyn Fn(&mut std::process::Command)| {
        let mut cmd = std::process::Command::new("codenomad-rs");
        configure(&mut cmd);
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || assert_loopback_command(&cmd))).is_ok()
    };
    assert!(ok(&|c| {
        c.args(["serve", "--host", "127.0.0.1", "--host=[::1]", "--host=LOCALHOST"]);
        c.env("CLI_HOST", "::ffff:127.0.0.1").env("CNRS_HTTPS_BIND", "127.0.0.1:0");
    }));
    assert!(!ok(&|c| {
        c.args(["serve", "--host", "0.0.0.0"]);
    }));
    assert!(!ok(&|c| {
        c.args(["serve", "--host=::"]);
    }));
    assert!(!ok(&|c| {
        c.args(["serve", "--host", "127.0.0.1"]).env("CODENOMAD_LOCKED_HOST", "0.0.0.0");
    }));
    assert!(!ok(&|c| {
        c.args(["serve"]).env("CLI_HOST", "::");
    }));
    assert!(!ok(&|c| {
        c.env("CNRS_HTTPS_BIND", "0.0.0.0:9898");
    }));
}

#[tokio::test]
async fn serve_starts_with_corrupt_config_yaml_and_omits_server_id() {
    let executable = Path::new(env!("CARGO_BIN_EXE_codenomad-rs"));
    let args =
        ["serve", "--host", "127.0.0.1", "--generate-token", "--http", "true", "--http-port", "0", "--https", "false"];
    let root = scratch("corrupt-config-startup");
    let config_dir = root.join("config");
    fs::create_dir_all(&config_dir).unwrap();
    let config_path = config_dir.join("config.yaml");
    let corrupt_contents = "server: [\n";
    fs::write(&config_path, corrupt_contents).unwrap();
    let mut server = Server::start(root, executable, &args);
    let (token, url, _) = server.ready().await;
    let client = client();
    let token_response = client
        .post(format!("{url}/api/auth/token"))
        .json(&serde_json::json!({ "token": token }))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .unwrap();
    assert_eq!(token_response.status(), 200);
    let cookie = token_response.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_owned();
    let meta: serde_json::Value = client
        .get(format!("{url}/api/meta"))
        .header("cookie", &cookie)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(meta.get("serverId").is_none(), "corrupt config.yaml must omit serverId from /api/meta: {meta}");
    assert_eq!(
        fs::read_to_string(&config_path).unwrap(),
        corrupt_contents,
        "corrupt config.yaml must not be overwritten"
    );
    assert!(!config_dir.join("config.yaml.server-id").exists(), "corrupt config.yaml must not claim a sidecar id");
    server.stop(b"").await;
}
