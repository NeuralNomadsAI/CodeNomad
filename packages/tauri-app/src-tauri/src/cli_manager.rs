use dirs::home_dir;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::VecDeque;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Url};

fn log_line(message: &str) {
    println!("[tauri-cli] {message}");
}

fn workspace_root() -> Option<PathBuf> {
    std::env::current_dir().ok().and_then(|mut dir| {
        for _ in 0..3 {
            if let Some(parent) = dir.parent() {
                dir = parent.to_path_buf();
            }
        }
        Some(dir)
    })
}

fn navigate_main(app: &AppHandle, url: &str) {
    if let Some(win) = app.webview_windows().get("main") {
        log_line(&format!("navigating main to {url}"));
        if let Ok(parsed) = Url::parse(url) {
            let _ = win.navigate(parsed);
        } else {
            log_line("failed to parse URL for navigation");
        }
    } else {
        log_line("main window not found for navigation");
    }
}

const DEFAULT_CONFIG_PATH: &str = "~/.config/era-code/config.json";

#[derive(Debug, Deserialize)]
struct PreferencesConfig {
    #[serde(rename = "listeningMode")]
    listening_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AppConfig {
    preferences: Option<PreferencesConfig>,
}

fn resolve_config_path() -> PathBuf {
    let raw = env::var("CLI_CONFIG")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CONFIG_PATH.to_string());
    expand_home(&raw)
}

fn expand_home(path: &str) -> PathBuf {
    if path.starts_with("~/") {
        if let Some(home) = home_dir().or_else(|| env::var("HOME").ok().map(PathBuf::from)) {
            return home.join(path.trim_start_matches("~/"));
        }
    }
    PathBuf::from(path)
}

fn resolve_listening_mode() -> String {
    let path = resolve_config_path();
    if let Ok(content) = fs::read_to_string(path) {
        if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
            if let Some(mode) = config
                .preferences
                .as_ref()
                .and_then(|prefs| prefs.listening_mode.as_ref())
            {
                if mode == "local" {
                    return "local".to_string();
                }
                if mode == "all" {
                    return "all".to_string();
                }
            }
        }
    }
    "local".to_string()
}

fn resolve_listening_host() -> String {
    let mode = resolve_listening_mode();
    if mode == "local" {
        "127.0.0.1".to_string()
    } else {
        "0.0.0.0".to_string()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CliState {
    Starting,
    Ready,
    Error,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
pub struct CliStatus {
    pub state: CliState,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub error: Option<String>,
}

impl Default for CliStatus {
    fn default() -> Self {
        Self {
            state: CliState::Stopped,
            pid: None,
            port: None,
            url: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CliProcessManager {
    status: Arc<Mutex<CliStatus>>,
    child: Arc<Mutex<Option<Child>>>,
    ready: Arc<AtomicBool>,
}

impl CliProcessManager {
    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(CliStatus::default())),
            child: Arc::new(Mutex::new(None)),
            ready: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start(&self, app: AppHandle, dev: bool) -> anyhow::Result<()> {
        log_line(&format!("start requested (dev={dev})"));
        self.stop()?;
        self.ready.store(false, Ordering::SeqCst);
        {
            let mut status = self.status.lock();
            status.state = CliState::Starting;
            status.port = None;
            status.url = None;
            status.error = None;
            status.pid = None;
        }
        Self::emit_status(&app, &self.status.lock());

        let status_arc = self.status.clone();
        let child_arc = self.child.clone();
        let ready_flag = self.ready.clone();
        thread::spawn(move || {
            if let Err(err) = Self::spawn_cli(app.clone(), status_arc.clone(), child_arc, ready_flag, dev) {
                log_line(&format!("cli spawn failed: {err}"));
                let mut locked = status_arc.lock();
                locked.state = CliState::Error;
                locked.error = Some(err.to_string());
                let snapshot = locked.clone();
                drop(locked);
                let _ = app.emit("cli:error", json!({"message": err.to_string()}));
                let _ = app.emit("cli:status", snapshot);
            }
        });

        Ok(())
    }

    pub fn stop(&self) -> anyhow::Result<()> {
        let mut child_opt = self.child.lock();
        if let Some(mut child) = child_opt.take() {
            #[cfg(unix)]
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                let _ = child.kill();
            }

            let start = Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if start.elapsed() > Duration::from_secs(4) {
                            #[cfg(unix)]
                            unsafe {
                                libc::kill(child.id() as i32, libc::SIGKILL);
                            }
                            #[cfg(windows)]
                            {
                                let _ = child.kill();
                            }
                            break;
                        }
                        thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        }

        let mut status = self.status.lock();
        status.state = CliState::Stopped;
        status.pid = None;
        status.port = None;
        status.url = None;
        status.error = None;

        Ok(())
    }

    pub fn status(&self) -> CliStatus {
        self.status.lock().clone()
    }

    fn spawn_cli(
        app: AppHandle,
        status: Arc<Mutex<CliStatus>>,
        child_holder: Arc<Mutex<Option<Child>>>,
        ready: Arc<AtomicBool>,
        dev: bool,
    ) -> anyhow::Result<()> {
        log_line("resolving CLI entry");
        let resolution = CliEntry::resolve(&app, dev)?;
        let host = resolve_listening_host();
        log_line(&format!(
            "resolved CLI entry runner={:?} entry={} host={}",
            resolution.runner, resolution.entry, host
        ));
        let args = resolution.build_args(dev, &host);
        log_line(&format!("CLI args: {:?}", args));
        if dev {
            log_line("development mode: will prefer tsx + source if present");
        }

        let cwd = workspace_root();
        if let Some(ref c) = cwd {
            log_line(&format!("using cwd={}", c.display()));
        }

        let command_info = if supports_user_shell() {
            log_line("spawning via user shell");
            ShellCommandType::UserShell(build_shell_command_string(&resolution, &args)?)
        } else {
            log_line("spawning directly with node");
            ShellCommandType::Direct(DirectCommand {
                program: resolution.node_binary.clone(),
                args: resolution.runner_args(&args),
            })
        };

        if !supports_user_shell() {
            if which::which(&resolution.node_binary).is_err() {
                return Err(anyhow::anyhow!("Node binary not found. Make sure Node.js is installed."));
            }
        }

        let child = match &command_info {
            ShellCommandType::UserShell(cmd) => {
                log_line(&format!("spawn command: {} {:?}", cmd.shell, cmd.args));
                let mut c = Command::new(&cmd.shell);
                c.args(&cmd.args)
                    .env("ELECTRON_RUN_AS_NODE", "1")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                if let Some(ref cwd) = cwd {
                    c.current_dir(cwd);
                }
                c.spawn()?
            }
            ShellCommandType::Direct(cmd) => {
                log_line(&format!("spawn command: {} {:?}", cmd.program, cmd.args));
                let mut c = Command::new(&cmd.program);
                c.args(&cmd.args)
                    .env("ELECTRON_RUN_AS_NODE", "1")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                if let Some(ref cwd) = cwd {
                    c.current_dir(cwd);
                }
                c.spawn()?
            }
        };

        let pid = child.id();
        log_line(&format!("spawned pid={pid}"));
        {
            let mut locked = status.lock();
            locked.pid = Some(pid);
        }
        Self::emit_status(&app, &status.lock());

        {
            let mut holder = child_holder.lock();
            *holder = Some(child);
        }

        let child_clone = child_holder.clone();
        let status_clone = status.clone();
        let app_clone = app.clone();
        let ready_clone = ready.clone();

        thread::spawn(move || {
            let stdout = child_clone
                .lock()
                .as_mut()
                .and_then(|c| c.stdout.take())
                .map(BufReader::new);
            let stderr = child_clone
                .lock()
                .as_mut()
                .and_then(|c| c.stderr.take())
                .map(BufReader::new);

            if let Some(reader) = stdout {
                Self::process_stream(reader, "stdout", &app_clone, &status_clone, &ready_clone);
            }
            if let Some(reader) = stderr {
                Self::process_stream(reader, "stderr", &app_clone, &status_clone, &ready_clone);
            }
        });

        let app_clone = app.clone();
        let status_clone = status.clone();
        let ready_clone = ready.clone();
        let child_holder_clone = child_holder.clone();
        thread::spawn(move || {
            let timeout = Duration::from_secs(60);
            thread::sleep(timeout);
            if ready_clone.load(Ordering::SeqCst) {
                return;
            }
            let mut locked = status_clone.lock();
            locked.state = CliState::Error;
            locked.error = Some("CLI did not start in time".to_string());
            log_line("timeout waiting for CLI readiness");
            if let Some(child) = child_holder_clone.lock().as_mut() {
                let _ = child.kill();
            }
            let _ = app_clone.emit("cli:error", json!({"message": "CLI did not start in time"}));
            Self::emit_status(&app_clone, &locked);
        });

        let status_clone = status.clone();
        let app_clone = app.clone();
        thread::spawn(move || {
            let code = {
                let mut guard = child_holder.lock();
                if let Some(child) = guard.as_mut() {
                    child.wait().ok()
                } else {
                    None
                }
            };

            let mut locked = status_clone.lock();
            let failed = locked.state != CliState::Ready;
            let err_msg = if failed {
                Some(match code {
                    Some(status) => format!("CLI exited early: {status}"),
                    None => "CLI exited early".to_string(),
                })
            } else {
                None
            };

            if failed {
                locked.state = CliState::Error;
                if locked.error.is_none() {
                    locked.error = err_msg.clone();
                }
                log_line(&format!("cli process exited before ready: {:?}", locked.error));
                let _ = app_clone.emit("cli:error", json!({"message": locked.error.clone().unwrap_or_default()}));
            } else {
                locked.state = CliState::Stopped;
                log_line("cli process stopped cleanly");
            }

            Self::emit_status(&app_clone, &locked);
        });

        Ok(())
    }

    fn process_stream<R: BufRead>(
        mut reader: R,
        stream: &str,
        app: &AppHandle,
        status: &Arc<Mutex<CliStatus>>,
        ready: &Arc<AtomicBool>,
    ) {
        let mut buffer = String::new();
        let port_regex = Regex::new(r"Era Code Server is ready at http://[^:]+:(\d+)").ok();
        let http_regex = Regex::new(r":(\d{2,5})(?!.*:\d)").ok();

        loop {
            buffer.clear();
            match reader.read_line(&mut buffer) {
                Ok(0) => break,
                Ok(_) => {
                    let line = buffer.trim_end();
                    if !line.is_empty() {
                        log_line(&format!("[cli][{}] {}", stream, line));

                        if ready.load(Ordering::SeqCst) {
                            continue;
                        }

                        if let Some(port) = port_regex
                            .as_ref()
                            .and_then(|re| re.captures(line).and_then(|c| c.get(1)))
                            .and_then(|m| m.as_str().parse::<u16>().ok())
                        {
                            Self::mark_ready(app, status, ready, port);
                            continue;
                        }

                        if line.to_lowercase().contains("http server listening") {
                            if let Some(port) = http_regex
                                .as_ref()
                                .and_then(|re| re.captures(line).and_then(|c| c.get(1)))
                                .and_then(|m| m.as_str().parse::<u16>().ok())
                            {
                                Self::mark_ready(app, status, ready, port);
                                continue;
                            }

                            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                                if let Some(port) = value.get("port").and_then(|p| p.as_u64()) {
                                    Self::mark_ready(app, status, ready, port as u16);
                                    continue;
                                }
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
    }

    fn mark_ready(app: &AppHandle, status: &Arc<Mutex<CliStatus>>, ready: &Arc<AtomicBool>, port: u16) {
        ready.store(true, Ordering::SeqCst);
        let mut locked = status.lock();
        let url = format!("http://127.0.0.1:{port}");
        locked.port = Some(port);
        locked.url = Some(url.clone());
        locked.state = CliState::Ready;
        locked.error = None;
        log_line(&format!("cli ready on {url}"));
        navigate_main(app, &url);
        let _ = app.emit("cli:ready", locked.clone());
        Self::emit_status(app, &locked);
    }

    fn emit_status(app: &AppHandle, status: &CliStatus) {
        let _ = app.emit("cli:status", status.clone());
    }
}

fn supports_user_shell() -> bool {
    cfg!(unix)
}

#[derive(Debug)]
struct ShellCommand {
    shell: String,
    args: Vec<String>,
}

#[derive(Debug)]
struct DirectCommand {
    program: String,
    args: Vec<String>,
}

#[derive(Debug)]
enum ShellCommandType {
    UserShell(ShellCommand),
    Direct(DirectCommand),
}

#[derive(Debug)]
struct CliEntry {
    entry: String,
    runner: Runner,
    runner_path: Option<String>,
    node_binary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Runner {
    Node,
    Tsx,
}

impl CliEntry {
    fn resolve(app: &AppHandle, dev: bool) -> anyhow::Result<Self> {
        let node_binary = std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_string());

        if dev {
            if let Some(tsx_path) = resolve_tsx(app) {
                if let Some(entry) = resolve_dev_entry(app) {
                    return Ok(Self {
                        entry,
                        runner: Runner::Tsx,
                        runner_path: Some(tsx_path),
                        node_binary,
                    });
                }
            }
        }

        if let Some(entry) = resolve_dist_entry(app) {
            return Ok(Self {
                entry,
                runner: Runner::Node,
                runner_path: None,
                node_binary,
            });
        }

        Err(anyhow::anyhow!(
            "Unable to locate Era Code CLI build (dist/bin.js). Please build @neuralnomads/codenomad."
        ))
    }

    fn build_args(&self, dev: bool, host: &str) -> Vec<String> {
        let mut args = vec![
            "serve".to_string(),
            "--host".to_string(),
            host.to_string(),
            "--port".to_string(),
            "0".to_string(),
        ];
        if dev {
            args.push("--ui-dev-server".to_string());
            args.push("http://localhost:3000".to_string());
            args.push("--log-level".to_string());
            args.push("debug".to_string());
        }
        args
    }

    fn runner_args(&self, cli_args: &[String]) -> Vec<String> {
        let mut args = VecDeque::new();
        if self.runner == Runner::Tsx {
            if let Some(path) = &self.runner_path {
                args.push_back(path.clone());
            }
        }
        args.push_back(self.entry.clone());
        for arg in cli_args {
            args.push_back(arg.clone());
        }
        args.into_iter().collect()
    }
}

fn resolve_tsx(_app: &AppHandle) -> Option<String> {
    let candidates = vec![
        std::env::current_dir()
            .ok()
            .map(|p| p.join("node_modules/tsx/dist/cli.js")),
        std::env::current_exe()
            .ok()
            .and_then(|ex| ex.parent().map(|p| p.join("../node_modules/tsx/dist/cli.js"))),
    ];

    first_existing(candidates)
}

fn resolve_dev_entry(_app: &AppHandle) -> Option<String> {
    let candidates = vec![
        std::env::current_dir()
            .ok()
            .map(|p| p.join("packages/server/src/index.ts")),
        std::env::current_dir()
            .ok()
            .map(|p| p.join("../server/src/index.ts")),
    ];

    first_existing(candidates)
}

fn resolve_dist_entry(_app: &AppHandle) -> Option<String> {
    let base = workspace_root();
    let mut candidates: Vec<Option<PathBuf>> = vec![
        base.as_ref().map(|p| p.join("packages/server/dist/bin.js")),
        base.as_ref().map(|p| p.join("packages/server/dist/index.js")),
        base.as_ref().map(|p| p.join("server/dist/bin.js")),
        base.as_ref().map(|p| p.join("server/dist/index.js")),
    ];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let resources = dir.join("../Resources");
            candidates.push(Some(resources.join("server/dist/bin.js")));
            candidates.push(Some(resources.join("server/dist/index.js")));
            candidates.push(Some(resources.join("server/dist/server/bin.js")));
            candidates.push(Some(resources.join("server/dist/server/index.js")));
            candidates.push(Some(resources.join("resources/server/dist/bin.js")));
            candidates.push(Some(resources.join("resources/server/dist/index.js")));
            candidates.push(Some(resources.join("resources/server/dist/server/bin.js")));
            candidates.push(Some(resources.join("resources/server/dist/server/index.js")));

            let linux_resource_roots = [dir.join("../lib/CodeNomad"), dir.join("../lib/codenomad")];
            for root in linux_resource_roots {
                candidates.push(Some(root.join("server/dist/bin.js")));
                candidates.push(Some(root.join("server/dist/index.js")));
                candidates.push(Some(root.join("server/dist/server/bin.js")));
                candidates.push(Some(root.join("server/dist/server/index.js")));
                candidates.push(Some(root.join("resources/server/dist/bin.js")));
                candidates.push(Some(root.join("resources/server/dist/index.js")));
                candidates.push(Some(root.join("resources/server/dist/server/bin.js")));
                candidates.push(Some(root.join("resources/server/dist/server/index.js")));
            }
        }
    }

    first_existing(candidates)
}

fn build_shell_command_string(entry: &CliEntry, cli_args: &[String]) -> anyhow::Result<ShellCommand> {

    let shell = default_shell();
    let mut quoted: Vec<String> = Vec::new();
    quoted.push(shell_escape(&entry.node_binary));
    for arg in entry.runner_args(cli_args) {
        quoted.push(shell_escape(&arg));
    }
    let command = format!("ELECTRON_RUN_AS_NODE=1 exec {}", quoted.join(" "));
    let args = build_shell_args(&shell, &command);
    log_line(&format!("user shell command: {} {:?}", shell, args));
    Ok(ShellCommand { shell, args })
}

fn default_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.trim().is_empty() {
            return shell;
        }
    }
    if cfg!(target_os = "macos") {
        "/bin/zsh".to_string()
    } else {
        "/bin/bash".to_string()
    }
}

fn shell_escape(input: &str) -> String {
    if input.is_empty() {
        "''".to_string()
    } else if !input
        .chars()
        .any(|c| matches!(c, ' ' | '"' | '\'' | '$' | '`' | '!' ))
    {
        input.to_string()
    } else {
        let escaped = input.replace('\'', "'\\''");
        format!("'{}'", escaped)
    }
}

fn build_shell_args(shell: &str, command: &str) -> Vec<String> {
    let shell_name = std::path::Path::new(shell)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_lowercase();

    if shell_name.contains("zsh") {
        vec!["-l".into(), "-i".into(), "-c".into(), command.into()]
    } else {
        vec!["-l".into(), "-c".into(), command.into()]
    }
}

fn first_existing(paths: Vec<Option<PathBuf>>) -> Option<String> {
    paths
        .into_iter()
        .flatten()
        .find(|p| p.exists())
        .map(|p| normalize_path(p))
}

fn normalize_path(path: PathBuf) -> String {
    if let Ok(clean) = path.canonicalize() {
        clean.to_string_lossy().to_string()
    } else {
        path.to_string_lossy().to_string()
    }
}
