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

struct Server {
    child: Child,
    lines: mpsc::UnboundedReceiver<String>,
    root: PathBuf,
    config: PathBuf,
}

impl Server {
    /// `exe` with the hosts' variables in a private home; the daemon endpoint is a placeholder.
    fn start(root: PathBuf, exe: &Path, args: &[&str]) -> Self {
        let (home, config, cwd) = (root.join("home"), root.join("config"), root.join("cwd"));
        for dir in [&home, &config, &cwd] {
            fs::create_dir_all(dir).unwrap();
        }
        let config = dunce::canonicalize(config).unwrap();
        #[allow(deprecated)]
        let actual_home = std::env::home_dir();
        assert!(actual_home.is_none_or(|path| !config.starts_with(path)), "Test config is under the user's home");
        #[cfg(windows)]
        assert!(
            !config.to_string_lossy().to_ascii_lowercase().starts_with(r"c:\users\admin\"),
            "Test config is under the user's home"
        );
        let mut command = Command::new(exe);
        command.args(args).current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true);
        for (name, _) in std::env::vars_os() {
            let name = name.to_string_lossy().into_owned();
            if name.starts_with("CODENOMAD_") || name.starts_with("CLI_") || name.starts_with("CNRS_") {
                command.env_remove(name);
            }
        }
        command
            .env("CODENOMAD_NATIVE_PARENT", "1")
            .env("CLI_CONFIG", &config)
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("APPDATA", home.join("AppData/Roaming"))
            .env("LOCALAPPDATA", home.join("AppData/Local"))
            .env("XDG_CONFIG_HOME", home.join("xdg/config"))
            .env("XDG_DATA_HOME", home.join("xdg/data"))
            .env("XDG_STATE_HOME", home.join("xdg/state"))
            .env("XDG_CACHE_HOME", home.join("xdg/cache"));
        let mut child = command.spawn().unwrap();
        let (tx, lines) = mpsc::unbounded_channel();
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        tokio::spawn(async move {
            while let Ok(Some(line)) = stdout.next_line().await {
                let _ = tx.send(line);
            }
        });
        Self { child, lines, root, config }
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
        let _ = fs::remove_dir_all(&self.root);
    }
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
    assert!(set.starts_with(&format!("{COOKIE}=")) && set.ends_with("; HttpOnly; Path=/; SameSite=Lax"), "{set}");
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
        assert_eq!(fallback.headers()["content-type"], "text/html", "{path}");
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
