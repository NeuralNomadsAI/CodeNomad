use crate::managed_node::resolve_bundled_node_binary;
use dirs::home_dir;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::VecDeque;
use std::env;
#[cfg(windows)]
use std::ffi::c_void;
use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(windows)]
use std::mem::{size_of, zeroed};
use std::net::TcpStream;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{webview::cookie::Cookie, AppHandle, Manager, Url};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const MISSING_NODE_PREFIX: &str = "CODENOMAD_MISSING_NODE:";
#[cfg(windows)]
const CLI_SHUTDOWN_COMMAND: &[u8] = b"codenomad:shutdown\n";

#[cfg(windows)]
#[derive(Debug)]
struct WindowsJobObject {
    // The desktop wrapper may observe only a short-lived Node wrapper PID while the real
    // server and workspace descendants continue running below it. KILL_ON_JOB_CLOSE gives
    // Tauri an OS-owned handle for the whole subtree instead of relying on a single PID.
    handle: HANDLE,
}

#[cfg(windows)]
impl WindowsJobObject {
    fn create() -> anyhow::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if handle.is_null() {
            return Err(anyhow::anyhow!(
                "CreateJobObjectW failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(handle);
            }
            return Err(anyhow::anyhow!("SetInformationJobObject failed: {}", err));
        }

        Ok(Self { handle })
    }

    fn assign_child(&self, child: &Child) -> anyhow::Result<()> {
        let process_handle = child.as_raw_handle() as HANDLE;
        let ok = unsafe { AssignProcessToJobObject(self.handle, process_handle) };
        if ok == 0 {
            return Err(anyhow::anyhow!(
                "AssignProcessToJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        Ok(())
    }

    fn active_processes(&self) -> anyhow::Result<u32> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        let ok = unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(anyhow::anyhow!(
                "QueryInformationJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(info.ActiveProcesses)
    }

    fn terminate(&self) -> anyhow::Result<()> {
        if unsafe { TerminateJobObject(self.handle, 1) } == 0 {
            return Err(anyhow::anyhow!(
                "TerminateJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for WindowsJobObject {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(windows)]
unsafe impl Send for WindowsJobObject {}

#[cfg(windows)]
unsafe impl Sync for WindowsJobObject {}

fn log_line(message: &str) {
    println!("[tauri-cli] {message}");
}

#[cfg(windows)]
fn configure_spawn(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_spawn(_command: &mut Command) {}

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

const SESSION_COOKIE_NAME_PREFIX: &str = "codenomad_session";

#[cfg(not(windows))]
const CLI_STOP_GRACE_SECS: u64 = 30;
#[cfg(windows)]
const CLI_WINDOWS_FORCE_GRACE_MS: u64 = 2_000;
const CLI_FORCE_CONFIRM_GRACE_SECS: u64 = 2;

#[cfg(unix)]
fn configure_posix_process_group(command: &mut Command) {
    // Ensure the CLI runs in its own process group so we can terminate wrapper
    // processes (login shell/tsx) without leaving the server orphaned.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
const WINDOWS_CLI_LAUNCHER_ARG: &str = "--codenomad-internal-cli-launcher";

#[cfg(windows)]
fn wait_for_windows_cli_launch_gate(mut reader: impl Read) -> bool {
    let mut gate = [0_u8; 1];
    reader.read_exact(&mut gate).is_ok() && gate[0] == 1
}

#[cfg(windows)]
fn relay_windows_cli_control(
    mut reader: impl Read,
    mut writer: impl Write,
) -> std::io::Result<u64> {
    std::io::copy(&mut reader, &mut writer)
}

#[cfg(windows)]
fn request_windows_cli_shutdown(writer: &mut impl Write) -> std::io::Result<()> {
    writer.write_all(CLI_SHUTDOWN_COMMAND)?;
    writer.flush()
}

#[cfg(windows)]
pub(crate) fn run_windows_cli_launcher_if_requested() -> Option<i32> {
    let mut args = std::env::args_os();
    args.next();
    if args.next()?.to_str()? != WINDOWS_CLI_LAUNCHER_ARG {
        return None;
    }
    let Some(program) = args.next() else {
        return Some(1);
    };
    if !wait_for_windows_cli_launch_gate(std::io::stdin().lock()) {
        return Some(1);
    }

    let mut command = Command::new(program);
    command.args(args);
    command.stdin(Stdio::piped());
    configure_spawn(&mut command);
    let Ok(mut child) = command.spawn() else {
        return Some(1);
    };
    if let Some(mut node_stdin) = child.stdin.take() {
        thread::spawn(move || {
            let stdin = std::io::stdin();
            let _ = relay_windows_cli_control(stdin.lock(), &mut node_stdin);
        });
    }
    Some(
        child
            .wait()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(1),
    )
}

#[cfg(windows)]
fn windows_containment_confirmed(child_exited: bool, job_active_processes: Option<u32>) -> bool {
    child_exited && job_active_processes == Some(0)
}

fn wait_for_termination(
    timeout: Duration,
    poll_interval: Duration,
    mut is_terminated: impl FnMut() -> anyhow::Result<bool>,
) -> anyhow::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if is_terminated()? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(TerminationTimeout.into());
        }
        thread::sleep(poll_interval.min(deadline.saturating_duration_since(Instant::now())));
    }
}

fn termination_timeout(default: Duration, deadline: Option<Instant>) -> Duration {
    deadline
        .map(|deadline| default.min(deadline.saturating_duration_since(Instant::now())))
        .unwrap_or(default)
}

#[derive(Debug)]
struct TerminationTimeout;

impl std::fmt::Display for TerminationTimeout {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("process termination was not confirmed")
    }
}

impl std::error::Error for TerminationTimeout {}

fn containment_is_complete(root_exited: bool, descendants_gone: bool) -> bool {
    root_exited && descendants_gone
}

#[cfg(unix)]
fn process_group_is_gone(pid: u32) -> anyhow::Result<bool> {
    if unsafe { libc::kill(-(pid as i32), 0) } == 0 {
        return Ok(false);
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Ok(true),
        Some(libc::EPERM) => Ok(false),
        _ => Err(anyhow::anyhow!(
            "failed to inspect CLI process group {pid}: {}",
            std::io::Error::last_os_error()
        )),
    }
}

fn stop_child(
    child: &mut Child,
    #[cfg(windows)] job: Option<&WindowsJobObject>,
    deadline: Option<Instant>,
) -> anyhow::Result<()> {
    let pid = child.id();
    #[cfg(windows)]
    if job.is_none() {
        if child.try_wait()?.is_none() {
            let _ = child.kill();
            let _ = wait_for_termination(
                termination_timeout(Duration::from_secs(CLI_FORCE_CONFIRM_GRACE_SECS), deadline),
                Duration::from_millis(25),
                || Ok(child.try_wait()?.is_some()),
            );
        }
        return Err(anyhow::anyhow!(
            "CLI pid={pid} descendant cleanup cannot be confirmed without a Windows job"
        ));
    }

    #[cfg(unix)]
    unsafe {
        if libc::kill(-(pid as i32), libc::SIGTERM) != 0 {
            let _ = libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    let graceful_timeout = Duration::from_millis(CLI_WINDOWS_FORCE_GRACE_MS);
    #[cfg(not(windows))]
    let graceful_timeout = Duration::from_secs(CLI_STOP_GRACE_SECS);
    #[cfg(windows)]
    if child.try_wait()?.is_none() {
        match child.stdin.take() {
            Some(mut control) => {
                if let Err(err) = request_windows_cli_shutdown(&mut control) {
                    log_line(&format!(
                        "failed to request graceful CLI shutdown pid={pid}: {err}"
                    ));
                }
            }
            None => log_line(&format!("CLI control channel is unavailable pid={pid}")),
        }
    }
    let graceful = wait_for_termination(
        termination_timeout(graceful_timeout, deadline),
        Duration::from_millis(50),
        || {
            let child_exited = child.try_wait()?.is_some();
            #[cfg(unix)]
            return Ok(child_exited && process_group_is_gone(pid)?);
            #[cfg(windows)]
            return Ok(windows_containment_confirmed(
                child_exited,
                job.map(WindowsJobObject::active_processes).transpose()?,
            ));
            #[cfg(not(any(unix, windows)))]
            Ok(child_exited)
        },
    );
    match graceful {
        Ok(()) => return Ok(()),
        Err(err) if !err.is::<TerminationTimeout>() => {
            return Err(anyhow::anyhow!(
                "failed to inspect CLI pid={pid} termination: {err}"
            ))
        }
        Err(_) => {}
    }

    log_line(&format!("CLI shutdown timed out; escalating pid={pid}"));
    #[cfg(unix)]
    unsafe {
        if libc::kill(-(pid as i32), libc::SIGKILL) != 0 {
            let _ = libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        job.expect("Windows job checked above").terminate()?;
    }
    #[cfg(not(any(unix, windows)))]
    child.kill()?;

    wait_for_termination(
        termination_timeout(Duration::from_secs(CLI_FORCE_CONFIRM_GRACE_SECS), deadline),
        Duration::from_millis(25),
        || {
            let child_exited = child.try_wait()?.is_some();
            #[cfg(unix)]
            return Ok(child_exited && process_group_is_gone(pid)?);
            #[cfg(windows)]
            return Ok(windows_containment_confirmed(
                child_exited,
                job.map(WindowsJobObject::active_processes).transpose()?,
            ));
            #[cfg(not(any(unix, windows)))]
            Ok(child_exited)
        },
    )
    .map_err(|err| anyhow::anyhow!("CLI pid={pid} termination was not confirmed: {err}"))
}

fn discard_unregistered_child(child: &mut Child, #[cfg(windows)] job: &WindowsJobObject) {
    #[cfg(unix)]
    let pid = child.id();
    #[cfg(unix)]
    unsafe {
        if libc::kill(-(pid as i32), libc::SIGKILL) != 0 {
            let _ = child.kill();
        }
    }
    #[cfg(windows)]
    {
        let _ = job.terminate();
        let _ = child.kill();
    }
    #[cfg(not(any(unix, windows)))]
    let _ = child.kill();
    let _ = child.wait();
}

fn navigate_main(manager: &CliProcessManager, generation: u64, app: &AppHandle, url: &str) {
    if !manager.is_current_generation(generation) {
        return;
    }
    if !app
        .state::<crate::local_windows::LocalWindows>()
        .records()
        .is_empty()
    {
        let final_url = augment_launch_url(url);
        let mut display = final_url.clone();
        if let Some(hash_index) = display.find('#') {
            display.replace_range(hash_index + 1.., "[REDACTED]");
        }
        log_line(&format!("navigating main to {display}"));
        if let Ok(parsed) = Url::parse(&final_url) {
            let current = manager.clone();
            let navigate = manager.clone();
            app.state::<crate::local_windows::LocalWindows>()
                .set_backend_target(Some(final_url));
            for record in app.state::<crate::local_windows::LocalWindows>().records() {
                let current = current.clone();
                let navigate = navigate.clone();
                let parsed = parsed.clone();
                let label = record.label.clone();
                let target_label = label.clone();
                crate::client_state::before_window_navigation_if(
                    app,
                    label,
                    crate::client_state::NavigationKind::Cli,
                    Some(parsed.clone()),
                    move || current.is_current_generation(generation),
                    move |app| {
                        navigate
                            .with_current_generation(generation, || {
                                app.get_webview_window(&target_label)
                                    .ok_or_else(|| {
                                        "local window not found for CLI navigation".to_string()
                                    })?
                                    .navigate(parsed)
                                    .map_err(|err| {
                                        format!("failed to navigate local window to CLI URL: {err}")
                                    })
                            })
                            .unwrap_or_else(|| Err("discarded stale CLI navigation".to_string()))
                    },
                );
            }
        } else {
            log_line("failed to parse URL for navigation");
        }
    } else {
        log_line("local window not found for navigation");
    }
    crate::preferences_window::navigate_backend(app);
}

fn augment_launch_url(base_url: &str) -> String {
    let launch_query = std::env::var("CODENOMAD_UI_LAUNCH_QUERY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let Some(launch_query) = launch_query else {
        return base_url.to_string();
    };

    if base_url.contains('?') {
        return format!(
            "{}&{}",
            base_url,
            launch_query.trim_start_matches(['?', '#'])
        );
    }

    format!(
        "{}?{}",
        base_url,
        launch_query.trim_start_matches(['?', '#'])
    )
}

fn extract_cookie_value(set_cookie: &str, name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    let cookie_kv = set_cookie.split(';').next()?.trim();
    if !cookie_kv.starts_with(&prefix) {
        return None;
    }
    let value = cookie_kv.trim_start_matches(&prefix).trim();
    if value.is_empty() {
        return None;
    }
    Some(value.to_string())
}

fn is_loopback_http_url(base_url: &str) -> bool {
    let Ok(parsed) = Url::parse(base_url) else {
        return false;
    };
    if parsed.scheme() != "http" || !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    match parsed.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(host)) => host.is_loopback(),
        Some(url::Host::Ipv6(host)) => host.is_loopback(),
        None => false,
    }
}

fn exchange_bootstrap_token(
    base_url: &str,
    token: &str,
    cookie_name: &str,
) -> anyhow::Result<Option<String>> {
    let parsed = Url::parse(base_url)?;
    let host = parsed.host_str().unwrap_or("127.0.0.1");
    let port = parsed.port_or_known_default().unwrap_or(80);

    // This is only used for local bootstrap; we assume plain HTTP.
    let mut stream = TcpStream::connect((host, port))?;

    let body = format!("{{\"token\":\"{}\"}}", token);
    let request = format!(
        "POST /api/auth/token HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );

    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    let mut response = String::new();
    stream.read_to_string(&mut response)?;

    let (raw_headers, _rest) = response
        .split_once("\r\n\r\n")
        .or_else(|| response.split_once("\n\n"))
        .unwrap_or((response.as_str(), ""));

    let mut lines = raw_headers.lines();
    let status_line = lines.next().unwrap_or("");
    if !status_line.contains(" 200 ") {
        return Ok(None);
    }

    for line in lines {
        // handle case-insensitive header name
        if let Some(value) = line.strip_prefix("Set-Cookie:") {
            if let Some(session_id) = extract_cookie_value(value.trim(), cookie_name) {
                return Ok(Some(session_id));
            }
        } else if let Some(value) = line.strip_prefix("set-cookie:") {
            if let Some(session_id) = extract_cookie_value(value.trim(), cookie_name) {
                return Ok(Some(session_id));
            }
        }
    }

    Ok(None)
}

pub(crate) fn local_session_cookie(
    base_url: &str,
    cookie_name: &str,
    session_id: &str,
) -> anyhow::Result<Cookie<'static>> {
    let parsed = Url::parse(base_url)?;
    let domain = parsed.host_str().unwrap_or("127.0.0.1").to_string();

    Ok(
        Cookie::build((cookie_name.to_string(), session_id.to_string()))
            .domain(domain)
            .path("/")
            .http_only(true)
            .same_site(tauri::webview::cookie::SameSite::Lax)
            .build(),
    )
}

fn set_session_cookie(
    app: &AppHandle,
    base_url: &str,
    cookie_name: &str,
    session_id: &str,
) -> anyhow::Result<()> {
    let cookie = local_session_cookie(base_url, cookie_name, session_id)?;

    for record in app.state::<crate::local_windows::LocalWindows>().records() {
        if let Some(win) = app.get_webview_window(&record.label) {
            win.set_cookie(cookie.clone())?;
        }
    }

    Ok(())
}

fn generate_auth_cookie_name() -> String {
    let pid = std::process::id();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);

    format!("{SESSION_COOKIE_NAME_PREFIX}_{pid}_{timestamp}")
}

const DEFAULT_CONFIG_PATH: &str = "~/.config/codenomad/config.json";

#[derive(Debug, Deserialize)]
struct PreferencesConfig {
    #[serde(rename = "listeningMode")]
    listening_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ServerConfig {
    #[serde(rename = "listeningMode")]
    listening_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AppConfig {
    preferences: Option<PreferencesConfig>,
    server: Option<ServerConfig>,
}

fn resolve_config_locations() -> (PathBuf, PathBuf) {
    let raw = env::var("CLI_CONFIG")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CONFIG_PATH.to_string());

    let expanded = expand_home(&raw);
    let lower = raw.trim().to_lowercase();

    if lower.ends_with(".yaml") || lower.ends_with(".yml") {
        let base = expanded
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| expanded.clone());
        return (expanded, base.join("config.json"));
    }

    if lower.ends_with(".json") {
        let base = expanded
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| expanded.clone());
        return (base.join("config.yaml"), expanded);
    }

    // Treat as directory.
    (expanded.join("config.yaml"), expanded.join("config.json"))
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
    let (yaml_path, json_path) = resolve_config_locations();

    if let Ok(content) = fs::read_to_string(&yaml_path) {
        if let Ok(config) = serde_yaml::from_str::<AppConfig>(&content) {
            let mode = config
                .server
                .as_ref()
                .and_then(|srv| srv.listening_mode.as_ref())
                .or_else(|| {
                    config
                        .preferences
                        .as_ref()
                        .and_then(|prefs| prefs.listening_mode.as_ref())
                });

            if let Some(mode) = mode {
                if mode == "local" {
                    return "local".to_string();
                }
                if mode == "all" {
                    return "all".to_string();
                }
            }
        }
    }

    // Legacy fallback.
    if let Ok(content) = fs::read_to_string(&json_path) {
        if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
            let mode = config
                .server
                .as_ref()
                .and_then(|srv| srv.listening_mode.as_ref())
                .or_else(|| {
                    config
                        .preferences
                        .as_ref()
                        .and_then(|prefs| prefs.listening_mode.as_ref())
                });
            if let Some(mode) = mode {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalCliAccess {
    pub(crate) base_url: String,
    pub(crate) cookie_name: String,
    pub(crate) session_cookie: String,
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

fn cli_exit_error(status: &CliStatus, exit: &std::process::ExitStatus) -> String {
    if status.state == CliState::Ready {
        format!("CLI exited unexpectedly after readiness: {exit}")
    } else {
        status
            .error
            .clone()
            .unwrap_or_else(|| format!("CLI exited early: {exit}"))
    }
}

#[derive(Debug, Clone)]
pub struct CliProcessManager {
    status: Arc<Mutex<CliStatus>>,
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    #[cfg(windows)]
    job: Arc<Mutex<Option<WindowsJobObject>>>,
    bootstrap_token: Arc<Mutex<Option<String>>>,
    local_access: Arc<Mutex<Option<LocalCliAccess>>>,
    lifecycle: Arc<Mutex<()>>,
    generation_authority: Arc<Mutex<()>>,
    generation: Arc<AtomicU64>,
    accepting_spawns: Arc<AtomicBool>,
}

impl CliProcessManager {
    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(CliStatus::default())),
            child: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
            #[cfg(windows)]
            job: Arc::new(Mutex::new(None)),
            bootstrap_token: Arc::new(Mutex::new(None)),
            local_access: Arc::new(Mutex::new(None)),
            lifecycle: Arc::new(Mutex::new(())),
            generation_authority: Arc::new(Mutex::new(())),
            generation: Arc::new(AtomicU64::new(0)),
            accepting_spawns: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn start(&self, app: AppHandle, dev: bool) -> anyhow::Result<()> {
        let _lifecycle = self.lifecycle.lock();
        self.accepting_spawns.store(true, Ordering::SeqCst);
        let generation = self.advance_generation();
        *self.bootstrap_token.lock() = None;
        *self.local_access.lock() = None;
        log_line(&format!("start requested (dev={dev})"));
        self.stop_tracked_child(None)?;
        {
            let mut status = self.status.lock();
            status.state = CliState::Starting;
            status.port = None;
            status.url = None;
            status.error = None;
            status.pid = None;
        }
        Self::emit_status(&app, &self.status.lock());

        let manager = self.clone();
        thread::spawn(move || {
            if let Err(err) = Self::spawn_cli(manager.clone(), app.clone(), generation, dev) {
                log_line(&format!("cli spawn failed: {err}"));
                manager.publish_error(&app, generation, err.to_string());
            }
        });

        Ok(())
    }

    pub fn stop(&self) -> anyhow::Result<()> {
        self.accepting_spawns.store(false, Ordering::SeqCst);
        let generation = self.advance_generation();
        *self.bootstrap_token.lock() = None;
        *self.local_access.lock() = None;
        let _lifecycle = self.lifecycle.lock();
        if !self.generation_matches(generation) {
            return Err(anyhow::anyhow!("CLI stop was superseded"));
        }
        self.stop_tracked_child(None)?;
        self.reset_stopped_status();
        Ok(())
    }

    pub(crate) fn stop_until(&self, deadline: Instant) -> anyhow::Result<()> {
        self.accepting_spawns.store(false, Ordering::SeqCst);
        let Some(generation) = self.advance_generation_until(deadline) else {
            return Err(anyhow::anyhow!(
                "timed out waiting for CLI generation authority"
            ));
        };
        let Some(mut bootstrap_token) = self.bootstrap_token.try_lock_until(deadline) else {
            return Err(anyhow::anyhow!(
                "timed out waiting for CLI bootstrap token authority"
            ));
        };
        *bootstrap_token = None;
        drop(bootstrap_token);
        let Some(mut local_access) = self.local_access.try_lock_until(deadline) else {
            return Err(anyhow::anyhow!(
                "timed out waiting for CLI local access authority"
            ));
        };
        *local_access = None;
        drop(local_access);
        let Some(_lifecycle) = self.lifecycle.try_lock_until(deadline) else {
            return Err(anyhow::anyhow!("timed out waiting for CLI lifecycle lock"));
        };
        if Instant::now() >= deadline {
            return Err(anyhow::anyhow!("CLI stop deadline elapsed"));
        }
        if !self.generation_matches(generation) {
            return Err(anyhow::anyhow!("CLI stop was superseded"));
        }
        self.stop_tracked_child(Some(deadline))?;
        self.reset_stopped_status();
        Ok(())
    }

    fn advance_generation(&self) -> u64 {
        let _authority = self.generation_authority.lock();
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn advance_generation_until(&self, deadline: Instant) -> Option<u64> {
        if Instant::now() >= deadline {
            return None;
        }
        let _authority = self.generation_authority.try_lock_until(deadline)?;
        (Instant::now() < deadline).then(|| self.generation.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn is_current_generation(&self, generation: u64) -> bool {
        self.accepting_spawns.load(Ordering::SeqCst) && self.generation_matches(generation)
    }

    fn generation_matches(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    fn with_current_generation<T>(
        &self,
        generation: u64,
        operation: impl FnOnce() -> T,
    ) -> Option<T> {
        let _lifecycle = self.lifecycle.lock();
        let _authority = self.generation_authority.lock();
        self.is_current_generation(generation).then(operation)
    }

    fn lock_current_generation(&self, generation: u64) -> Option<parking_lot::MutexGuard<'_, ()>> {
        let lifecycle = self.lifecycle.lock();
        let current = {
            let _authority = self.generation_authority.lock();
            self.is_current_generation(generation)
        };
        current.then_some(lifecycle)
    }

    fn stop_tracked_child(&self, deadline: Option<Instant>) -> anyhow::Result<()> {
        let Some(mut child) = self.child.lock().take() else {
            self.stdin.lock().take();
            #[cfg(windows)]
            if let Some(job) = self.job.lock().take() {
                let result = job.terminate().and_then(|()| {
                    wait_for_termination(
                        termination_timeout(
                            Duration::from_secs(CLI_FORCE_CONFIRM_GRACE_SECS),
                            deadline,
                        ),
                        Duration::from_millis(25),
                        || Ok(job.active_processes()? == 0),
                    )
                });
                if let Err(err) = result {
                    *self.job.lock() = Some(job);
                    return Err(err);
                }
            }
            return Ok(());
        };
        if let Some(mut stdin) = self.stdin.try_lock() {
            child.stdin = stdin.take();
        }
        #[cfg(windows)]
        let job = self.job.lock().take();
        log_line(&format!("stopping CLI pid={}", child.id()));
        let result = stop_child(
            &mut child,
            #[cfg(windows)]
            job.as_ref(),
            deadline,
        );
        if let Err(err) = result {
            *self.child.lock() = Some(child);
            #[cfg(windows)]
            {
                *self.job.lock() = job;
            }
            return Err(err);
        }
        Ok(())
    }

    fn register_spawned_child(
        &self,
        generation: u64,
        mut child: Child,
        #[cfg(windows)] job: WindowsJobObject,
    ) -> Option<(
        Option<BufReader<std::process::ChildStdout>>,
        Option<BufReader<std::process::ChildStderr>>,
    )> {
        let authority = self.generation_authority.lock();
        if !self.is_current_generation(generation) {
            drop(authority);
            discard_unregistered_child(
                &mut child,
                #[cfg(windows)]
                &job,
            );
            return None;
        }
        let pid = child.id();
        let stdout = child.stdout.take().map(BufReader::new);
        let stderr = child.stderr.take().map(BufReader::new);
        let stdin = child.stdin.take();
        debug_assert!(self.child.lock().is_none());
        self.status.lock().pid = Some(pid);
        *self.child.lock() = Some(child);
        *self.stdin.lock() = stdin;
        #[cfg(windows)]
        {
            *self.job.lock() = Some(job);
        }
        Some((stdout, stderr))
    }

    fn reset_stopped_status(&self) {
        let mut status = self.status.lock();
        status.state = CliState::Stopped;
        status.pid = None;
        status.port = None;
        status.url = None;
        status.error = None;
        *self.local_access.lock() = None;
        self.stdin.lock().take();
    }

    fn publish_error(&self, app: &AppHandle, generation: u64, message: String) {
        self.with_current_generation(generation, || {
            *self.local_access.lock() = None;
            let mut status = self.status.lock();
            status.state = CliState::Error;
            status.error = Some(message.clone());
            let snapshot = status.clone();
            drop(status);
            crate::local_windows::emit_all(app, "cli:error", json!({"message": message}));
            crate::local_windows::emit_all(app, "cli:status", snapshot);
        });
    }

    fn write_native_response(&self, generation: u64, response: &str) {
        if !self.is_current_generation(generation) {
            return;
        }
        let mut stdin = self.stdin.lock();
        if !self.is_current_generation(generation) {
            return;
        }
        let Some(stdin) = stdin.as_mut() else {
            return;
        };
        if let Err(error) = stdin
            .write_all(response.as_bytes())
            .and_then(|()| stdin.flush())
        {
            log_line(&format!("failed to answer native CLI request: {error}"));
        }
    }

    pub fn status(&self) -> CliStatus {
        self.status.lock().clone()
    }

    pub(crate) fn local_cli_access(&self) -> Option<LocalCliAccess> {
        let _lifecycle = self.lifecycle.lock();
        if self.status.lock().state != CliState::Ready {
            return None;
        }
        self.local_access.lock().clone()
    }

    fn spawn_cli(
        manager: CliProcessManager,
        app: AppHandle,
        generation: u64,
        dev: bool,
    ) -> anyhow::Result<()> {
        let Some(lifecycle) = manager.lock_current_generation(generation) else {
            return Ok(());
        };
        log_line("resolving CLI entry");
        let resolution = CliEntry::resolve(&app, dev)?;
        let host = resolve_listening_host();
        log_line(&format!(
            "resolved CLI entry runner={:?} entry={} host={}",
            resolution.runner, resolution.entry, host
        ));
        let auth_cookie_name = Arc::new(generate_auth_cookie_name());
        let args = resolution.build_args(dev, &host, auth_cookie_name.as_str());
        log_line(&format!("CLI args: {:?}", args));
        if dev {
            log_line("development mode: will prefer tsx + source if present");
        }

        let cwd = workspace_root();
        if let Some(ref c) = cwd {
            log_line(&format!("using cwd={}", c.display()));
        }

        let use_user_shell = supports_user_shell();

        if !use_user_shell && which::which(&resolution.node_binary).is_err() {
            return Err(anyhow::anyhow!(
                "Node binary '{}' not found. CodeNomad desktop currently requires Node.js installed on the system, or set NODE_BINARY to a valid runtime path.",
                resolution.node_binary
            ));
        }

        let command_info = if use_user_shell {
            log_line("spawning via user shell");
            ShellCommandType::UserShell(build_shell_command_string(&resolution, &args)?)
        } else {
            log_line(if resolution.runner == Runner::Tsx {
                "spawning directly with node + tsx"
            } else {
                "spawning directly with node"
            });
            ShellCommandType::Direct(DirectCommand {
                program: resolution.node_binary.clone(),
                args: resolution.runner_args(&args),
            })
        };

        let mut child = match &command_info {
            ShellCommandType::UserShell(cmd) => {
                log_line(&format!("spawn command: {} {:?}", cmd.shell, cmd.args));
                let mut c = Command::new(&cmd.shell);
                c.args(&cmd.args)
                    .env("ELECTRON_RUN_AS_NODE", "1")
                    .env_remove("npm_config_prefix")
                    .env_remove("NPM_CONFIG_PREFIX")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                #[cfg(windows)]
                c.env("CODENOMAD_NATIVE_PARENT", "1");
                configure_spawn(&mut c);
                if let Some(ref cwd) = cwd {
                    c.current_dir(cwd);
                }
                #[cfg(unix)]
                configure_posix_process_group(&mut c);
                c.spawn()?
            }
            ShellCommandType::Direct(cmd) => {
                log_line(&format!("spawn command: {} {:?}", cmd.program, cmd.args));
                #[cfg(windows)]
                let mut c = {
                    // The launcher cannot create Node until its stdin gate opens. Assigning
                    // the blocked launcher first makes every later descendant inherit the job.
                    let mut launcher = Command::new(std::env::current_exe()?);
                    launcher
                        .arg(WINDOWS_CLI_LAUNCHER_ARG)
                        .arg(&cmd.program)
                        .args(&cmd.args)
                        .stdin(Stdio::piped());
                    launcher
                };
                #[cfg(not(windows))]
                let mut c = Command::new(&cmd.program);
                #[cfg(not(windows))]
                c.args(&cmd.args);
                c.env("ELECTRON_RUN_AS_NODE", "1")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                #[cfg(windows)]
                c.env("CODENOMAD_NATIVE_PARENT", "1");
                configure_spawn(&mut c);
                if let Some(ref cwd) = cwd {
                    c.current_dir(cwd);
                }
                #[cfg(unix)]
                configure_posix_process_group(&mut c);
                c.spawn()?
            }
        };

        let pid = child.id();
        log_line(&format!("spawned pid={pid}"));
        #[cfg(windows)]
        let job = match WindowsJobObject::create().and_then(|job| {
            job.assign_child(&child)?;
            Ok(job)
        }) {
            Ok(job) => {
                log_line(&format!("attached pid={pid} to Windows job object"));
                job
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(anyhow::anyhow!(
                    "failed to contain blocked CLI launcher pid={pid}; launch cancelled: {err}"
                ));
            }
        };
        #[cfg(windows)]
        {
            let authority = manager.generation_authority.lock();
            if !manager.is_current_generation(generation) {
                drop(authority);
                discard_unregistered_child(&mut child, &job);
                return Ok(());
            }
            drop(authority);
            let gate_result = child
                .stdin
                .as_mut()
                .ok_or_else(|| anyhow::anyhow!("blocked CLI launcher stdin is unavailable"))
                .and_then(|gate| {
                    gate.write_all(&[1])?;
                    gate.flush().map_err(anyhow::Error::from)
                });
            if let Err(err) = gate_result {
                let _ = job.terminate();
                let _ = child.kill();
                let _ = child.wait();
                return Err(anyhow::anyhow!(
                    "failed to release contained CLI launcher pid={pid}: {err}"
                ));
            }
        }

        let Some((stdout, stderr)) = manager.register_spawned_child(
            generation,
            child,
            #[cfg(windows)]
            job,
        ) else {
            return Ok(());
        };
        Self::emit_status(&app, &manager.status.lock());
        drop(lifecycle);

        let ready = Arc::new(AtomicBool::new(false));
        if let Some(reader) = stdout {
            let app = app.clone();
            let manager = manager.clone();
            let ready = ready.clone();
            let auth_cookie_name = auth_cookie_name.clone();
            thread::spawn(move || {
                Self::process_stream(
                    reader,
                    "stdout",
                    &manager,
                    generation,
                    &app,
                    &ready,
                    auth_cookie_name.as_str(),
                );
            });
        }
        if let Some(reader) = stderr {
            let app = app.clone();
            let manager = manager.clone();
            let ready = ready.clone();
            let auth_cookie_name = auth_cookie_name.clone();
            thread::spawn(move || {
                Self::process_stream(
                    reader,
                    "stderr",
                    &manager,
                    generation,
                    &app,
                    &ready,
                    auth_cookie_name.as_str(),
                );
            });
        }

        {
            let manager = manager.clone();
            let app = app.clone();
            let ready = ready.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(60));
                let _lifecycle = manager.lifecycle.lock();
                if !manager.is_current_generation(generation) || ready.load(Ordering::SeqCst) {
                    return;
                }
                manager.advance_generation();
                log_line("timeout waiting for CLI readiness");
                let stop_error = manager.stop_tracked_child(None).err();
                let message = stop_error.map_or_else(
                    || "CLI did not start in time".to_string(),
                    |err| format!("CLI did not start in time; cleanup failed: {err}"),
                );
                let mut status = manager.status.lock();
                status.state = CliState::Error;
                status.error = Some(message.clone());
                let snapshot = status.clone();
                drop(status);
                crate::local_windows::emit_all(&app, "cli:error", json!({"message": message}));
                crate::local_windows::emit_all(&app, "cli:status", snapshot);
            });
        }

        thread::spawn(move || loop {
            enum Poll {
                Running,
                Exited(std::process::ExitStatus),
                Failed(String),
            }
            let poll = {
                let _lifecycle = manager.lifecycle.lock();
                if !manager.is_current_generation(generation) {
                    return;
                }
                let mut child = manager.child.lock();
                let Some(tracked) = child.as_mut() else {
                    return;
                };
                match tracked.try_wait() {
                    Ok(Some(status)) => {
                        #[cfg(unix)]
                        let group_is_gone = process_group_is_gone(pid).map_err(|err| {
                            format!("failed to inspect exited CLI pid={pid}: {err}")
                        });
                        #[cfg(windows)]
                        let group_is_gone = match manager.job.lock().as_ref() {
                            Some(job) => job.active_processes().map(|active| active == 0),
                            None => Ok(false),
                        };
                        #[cfg(not(any(unix, windows)))]
                        let group_is_gone: anyhow::Result<bool> = Ok(true);
                        match group_is_gone {
                            Ok(gone) if containment_is_complete(true, gone) => {
                                *child = None;
                                #[cfg(windows)]
                                {
                                    manager.job.lock().take();
                                }
                                Poll::Exited(status)
                            }
                            // The root may be only a launcher/wrapper. Keep ownership and
                            // monitoring until the process group/job is actually empty.
                            Ok(_) => Poll::Running,
                            Err(err) => Poll::Failed(format!(
                                "failed to inspect exited CLI pid={pid}: {err}"
                            )),
                        }
                    }
                    Ok(None) => Poll::Running,
                    Err(err) => Poll::Failed(format!("failed to inspect CLI pid={pid}: {err}")),
                }
            };
            match poll {
                Poll::Running => thread::sleep(Duration::from_millis(100)),
                Poll::Failed(message) => {
                    manager.publish_error(&app, generation, message);
                    return;
                }
                Poll::Exited(code) => {
                    manager.with_current_generation(generation, || {
                        *manager.local_access.lock() = None;
                        let mut status = manager.status.lock();
                        let message = cli_exit_error(&status, &code);
                        status.state = CliState::Error;
                        status.error = Some(message.clone());
                        crate::local_windows::emit_all(
                            &app,
                            "cli:error",
                            json!({"message": message}),
                        );
                        Self::emit_status(&app, &status);
                    });
                    return;
                }
            }
        });

        Ok(())
    }

    fn process_stream<R: BufRead>(
        mut reader: R,
        stream: &str,
        manager: &CliProcessManager,
        generation: u64,
        app: &AppHandle,
        ready: &Arc<AtomicBool>,
        auth_cookie_name: &str,
    ) {
        let mut buffer = String::new();
        let local_url_regex =
            Regex::new(r"^Local\s+Connection\s+URL\s*:\s*(https?://\S+)\s*$").ok();
        let token_prefix = "CODENOMAD_BOOTSTRAP_TOKEN:";

        loop {
            match Self::read_bounded_line(&mut reader, &mut buffer) {
                Ok(0) => break,
                Ok(size) if size > crate::native_request::MAX_LINE_BYTES => {
                    log_line(&format!("[cli][{stream}] discarded oversized output line"));
                    continue;
                }
                Ok(_) => {
                    if !manager.is_current_generation(generation) {
                        break;
                    }
                    let line = buffer.trim_end();
                    if !line.is_empty() {
                        if stream == "stdout"
                            && line.starts_with(crate::native_request::REQUEST_PREFIX)
                        {
                            if let Some(request) = crate::native_request::parse(line) {
                                let now = SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .map(|duration| duration.as_millis() as u64)
                                    .unwrap_or(u64::MAX);
                                let result = if now >= request.deadline {
                                    Err("Native request expired before execution".to_string())
                                } else {
                                    crate::handle_native_request(
                                        app,
                                        &request.method,
                                        request.params,
                                        request.deadline,
                                    )
                                };
                                manager.write_native_response(
                                    generation,
                                    &crate::native_request::response(&request.id, result),
                                );
                            }
                            continue;
                        }
                        if line.starts_with(token_prefix) {
                            let token = line.trim_start_matches(token_prefix).trim();
                            if !token.is_empty() {
                                manager.with_current_generation(generation, || {
                                    let mut guard = manager.bootstrap_token.lock();
                                    if guard.is_none() {
                                        *guard = Some(token.to_string());
                                    }
                                });
                            }
                            continue;
                        }

                        log_line(&format!("[cli][{}] {}", stream, line));

                        if ready.load(Ordering::SeqCst) {
                            continue;
                        }

                        if let Some(node_binary) = line.strip_prefix(MISSING_NODE_PREFIX) {
                            manager.with_current_generation(generation, || {
                                let mut locked = manager.status.lock();
                                if locked.error.is_none() {
                                    locked.error = Some(format!(
                                        "Node binary '{}' not found in the desktop shell environment. CodeNomad desktop currently requires Node.js installed on the system, or set NODE_BINARY to a valid runtime path.",
                                        node_binary.trim()
                                    ));
                                }
                            });
                            continue;
                        }

                        if let Some(url) = local_url_regex
                            .as_ref()
                            .and_then(|re| re.captures(line).and_then(|c| c.get(1)))
                            .map(|m| m.as_str().to_string())
                        {
                            Self::mark_ready(
                                manager,
                                generation,
                                app,
                                ready,
                                auth_cookie_name,
                                url,
                            );
                            continue;
                        }
                    }
                }
                Err(_) => break,
            }
        }
    }

    fn read_bounded_line<R: BufRead>(
        reader: &mut R,
        buffer: &mut String,
    ) -> std::io::Result<usize> {
        buffer.clear();
        let mut total = 0usize;
        let mut oversized = false;
        let mut bytes = Vec::new();
        loop {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                return Ok(total);
            }
            let length = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| index + 1)
                .unwrap_or(available.len());
            let ended = available.get(length - 1) == Some(&b'\n');
            total = total.saturating_add(length);
            if !oversized && bytes.len() + length <= crate::native_request::MAX_LINE_BYTES {
                bytes.extend_from_slice(&available[..length]);
            } else {
                oversized = true;
                bytes.clear();
            }
            reader.consume(length);
            if ended {
                if !oversized {
                    *buffer = String::from_utf8_lossy(&bytes).into_owned();
                }
                return Ok(if oversized {
                    crate::native_request::MAX_LINE_BYTES + 1
                } else {
                    total
                });
            }
        }
    }

    fn mark_ready(
        manager: &CliProcessManager,
        generation: u64,
        app: &AppHandle,
        ready: &Arc<AtomicBool>,
        auth_cookie_name: &str,
        base_url: String,
    ) {
        if ready.swap(true, Ordering::SeqCst) {
            return;
        }
        let port = Url::parse(&base_url)
            .ok()
            .and_then(|u| u.port_or_known_default())
            .map(|p| p as u16);
        let token = manager
            .with_current_generation(generation, || {
                let mut locked = manager.status.lock();
                locked.port = port;
                locked.url = Some(base_url.clone());
                locked.state = CliState::Ready;
                locked.error = None;
                manager.bootstrap_token.lock().take()
            })
            .flatten();
        if !manager.is_current_generation(generation) {
            return;
        }
        log_line(&format!("cli ready on {base_url}"));

        if let Some(token) = token {
            // Native credentials are only established against the managed loopback listener.
            if !is_loopback_http_url(&base_url) {
                navigate_main(manager, generation, app, &base_url);
            } else {
                match exchange_bootstrap_token(&base_url, &token, &auth_cookie_name) {
                    Ok(Some(session_id)) => {
                        let cookie_result = manager.with_current_generation(generation, || {
                            set_session_cookie(app, &base_url, &auth_cookie_name, &session_id)
                        });
                        if cookie_result.is_none() {
                            return;
                        }
                        if let Err(err) = cookie_result.unwrap() {
                            log_line(&format!("failed to set session cookie: {err}"));
                            navigate_main(manager, generation, app, &format!("{base_url}/login"));
                        } else {
                            manager.with_current_generation(generation, || {
                                *manager.local_access.lock() = Some(LocalCliAccess {
                                    base_url: base_url.clone(),
                                    cookie_name: auth_cookie_name.to_string(),
                                    session_cookie: session_id,
                                });
                            });
                            navigate_main(manager, generation, app, &base_url);
                        }
                    }
                    Ok(None) => {
                        log_line("bootstrap token exchange failed (invalid token)");
                        navigate_main(manager, generation, app, &format!("{base_url}/login"));
                    }
                    Err(err) => {
                        log_line(&format!("bootstrap token exchange failed: {err}"));
                        navigate_main(manager, generation, app, &format!("{base_url}/login"));
                    }
                }
            }
        } else {
            navigate_main(manager, generation, app, &base_url);
        }
        manager.with_current_generation(generation, || {
            let status = manager.status.lock().clone();
            crate::local_windows::emit_all(app, "cli:ready", status.clone());
            Self::emit_status(app, &status);
        });
    }

    fn emit_status(app: &AppHandle, status: &CliStatus) {
        if status.state != CliState::Ready {
            crate::local_windows::show_loading_all(app);
            crate::preferences_window::show_loading(app);
        }
        crate::local_windows::emit_all(app, "cli:status", status.clone());
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
    node_args: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Runner {
    Node,
    Tsx,
}

impl CliEntry {
    fn resolve(app: &AppHandle, dev: bool) -> anyhow::Result<Self> {
        if dev {
            let node_binary = std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_string());
            if let Some(tsx_path) = resolve_tsx(app) {
                if let Some(entry) = resolve_dev_entry(app) {
                    return Ok(Self {
                        entry,
                        runner: Runner::Tsx,
                        runner_path: Some(tsx_path),
                        node_binary,
                        node_args: Vec::new(),
                    });
                }
            }
        }

        if let Some(entry) = resolve_prod_entry(app) {
            return Ok(Self {
                entry,
                runner: Runner::Node,
                runner_path: None,
                node_binary: resolve_bundled_node_binary()?,
                node_args: vec!["--experimental-specifier-resolution=node".to_string()],
            });
        }

        Err(anyhow::anyhow!(
            "Unable to locate the packaged CodeNomad server entrypoint (dist/bin.js). Please rebuild the desktop bundle."
        ))
    }

    fn build_args(&self, dev: bool, host: &str, auth_cookie_name: &str) -> Vec<String> {
        let mut args = vec![
            "serve".to_string(),
            "--host".to_string(),
            host.to_string(),
            "--auth-cookie-name".to_string(),
            auth_cookie_name.to_string(),
            "--generate-token".to_string(),
            "--unrestricted-root".to_string(),
        ];

        if dev {
            // Dev: keep loopback HTTP for the Vite proxy, but also enable HTTPS so
            // remote proxy sessions can still spin up secure local windows.
            let ui_dev_server = std::env::var("VITE_DEV_SERVER_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    std::env::var("ELECTRON_RENDERER_URL")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                })
                .unwrap_or_else(|| "http://localhost:3000".to_string());
            let log_level = std::env::var("CLI_LOG_LEVEL")
                .ok()
                .map(|value| value.trim().to_lowercase())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "info".to_string());

            args.push("--https".to_string());
            args.push("true".to_string());
            args.push("--http".to_string());
            args.push("true".to_string());
            args.push("--http-port".to_string());
            args.push("0".to_string());
            args.push("--ui-dev-server".to_string());
            args.push(ui_dev_server);
            args.push("--log-level".to_string());
            args.push(log_level);
        } else {
            // Prod desktop: always keep loopback HTTP enabled.
            args.push("--https".to_string());
            args.push("true".to_string());
            args.push("--http".to_string());
            args.push("true".to_string());
        }
        args
    }

    fn runner_args(&self, cli_args: &[String]) -> Vec<String> {
        let mut args = VecDeque::new();
        for arg in &self.node_args {
            args.push_back(arg.clone());
        }
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
    let cwd = std::env::current_dir().ok();
    let workspace = workspace_root();
    let mut candidates = vec![
        cwd.as_ref()
            .map(|p| p.join("node_modules/tsx/dist/cli.mjs")),
        cwd.as_ref()
            .map(|p| p.join("node_modules/tsx/dist/cli.cjs")),
        cwd.as_ref().map(|p| p.join("node_modules/tsx/dist/cli.js")),
        cwd.as_ref()
            .map(|p| p.join("../node_modules/tsx/dist/cli.mjs")),
        cwd.as_ref()
            .map(|p| p.join("../node_modules/tsx/dist/cli.cjs")),
        cwd.as_ref()
            .map(|p| p.join("../node_modules/tsx/dist/cli.js")),
        cwd.as_ref()
            .map(|p| p.join("../../node_modules/tsx/dist/cli.mjs")),
        cwd.as_ref()
            .map(|p| p.join("../../node_modules/tsx/dist/cli.cjs")),
        cwd.as_ref()
            .map(|p| p.join("../../node_modules/tsx/dist/cli.js")),
        workspace
            .as_ref()
            .map(|p| p.join("node_modules/tsx/dist/cli.mjs")),
        workspace
            .as_ref()
            .map(|p| p.join("node_modules/tsx/dist/cli.cjs")),
        workspace
            .as_ref()
            .map(|p| p.join("node_modules/tsx/dist/cli.js")),
    ];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(Some(dir.join("../node_modules/tsx/dist/cli.mjs")));
            candidates.push(Some(dir.join("../node_modules/tsx/dist/cli.cjs")));
            candidates.push(Some(dir.join("../node_modules/tsx/dist/cli.js")));
        }
    }

    first_existing(candidates)
}

fn resolve_dev_entry(_app: &AppHandle) -> Option<String> {
    let cwd = std::env::current_dir().ok();
    let workspace = workspace_root();
    let candidates = vec![
        workspace
            .as_ref()
            .map(|p| p.join("packages/server/src/index.ts")),
        cwd.as_ref().map(|p| p.join("packages/server/src/index.ts")),
        cwd.as_ref().map(|p| p.join("../server/src/index.ts")),
        cwd.as_ref().map(|p| p.join("../../server/src/index.ts")),
    ];

    first_existing(candidates)
}

fn resolve_prod_entry(_app: &AppHandle) -> Option<String> {
    let base = workspace_root();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()));

    first_existing(prod_entry_candidates(exe_dir, base))
}

fn prod_entry_candidates(
    exe_dir: Option<PathBuf>,
    workspace: Option<PathBuf>,
) -> Vec<Option<PathBuf>> {
    let mut candidates = Vec::new();

    if let Some(dir) = exe_dir {
        candidates.push(Some(dir.join("resources/server/dist/bin.js")));

        let resources = dir.join("../Resources");
        candidates.push(Some(resources.join("server/dist/bin.js")));
        candidates.push(Some(resources.join("resources/server/dist/bin.js")));

        let linux_resource_roots = [dir.join("../lib/CodeNomad"), dir.join("../lib/codenomad")];
        for root in linux_resource_roots {
            candidates.push(Some(root.join("server/dist/bin.js")));
            candidates.push(Some(root.join("resources/server/dist/bin.js")));
        }
    }

    candidates.push(workspace.map(|p| p.join("packages/server/dist/bin.js")));

    candidates
}

fn build_shell_command_string(
    entry: &CliEntry,
    cli_args: &[String],
) -> anyhow::Result<ShellCommand> {
    let shell = default_shell();
    let mut quoted: Vec<String> = Vec::new();
    quoted.push(shell_escape(&entry.node_binary));
    for arg in entry.runner_args(cli_args) {
        quoted.push(shell_escape(&arg));
    }
    let command = format!(
        "if [ -x {} ] || command -v {} >/dev/null 2>&1; then ELECTRON_RUN_AS_NODE=1 exec {}; else printf '%s%s\\n' '{}' {}; exit 127; fi",
        shell_escape(&entry.node_binary),
        shell_escape(&entry.node_binary),
        quoted.join(" "),
        MISSING_NODE_PREFIX,
        shell_escape(&entry.node_binary),
    );
    let wrapped_command = wrap_command_for_shell(&command, &shell);
    let args = build_shell_args(&shell, &wrapped_command);
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

fn wrap_command_for_shell(command: &str, shell: &str) -> String {
    let shell_name = std::path::Path::new(shell)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_lowercase();

    if shell_name.contains("bash") {
        return format!(
            "if [ -f ~/.bashrc ]; then source ~/.bashrc >/dev/null 2>&1; fi; {}",
            command
        );
    }

    if shell_name.contains("zsh") {
        return format!(
            "if [ -f ~/.zshrc ]; then source ~/.zshrc >/dev/null 2>&1; fi; {}",
            command
        );
    }

    command.to_string()
}

fn shell_escape(input: &str) -> String {
    if input.is_empty() {
        "''".to_string()
    } else if !input
        .chars()
        .any(|c| matches!(c, ' ' | '"' | '\'' | '$' | '`' | '!'))
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

    if shell_name.contains("zsh") || shell_name.contains("bash") {
        vec!["-i".into(), "-l".into(), "-c".into(), command.into()]
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
    let resolved = if let Ok(clean) = path.canonicalize() {
        clean
    } else {
        path
    };

    let rendered = resolved.to_string_lossy().to_string();
    if let Some(stripped) = rendered.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{}", stripped)
    } else if let Some(stripped) = rendered.strip_prefix("\\\\?\\") {
        stripped.to_string()
    } else {
        rendered
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    #[test]
    fn bounded_line_reader_discards_oversized_lines_without_losing_the_next_line() {
        let mut input = vec![b'x'; crate::native_request::MAX_LINE_BYTES + 5];
        input.extend_from_slice(b"\nnext\n");
        let mut reader = std::io::Cursor::new(input);
        let mut line = String::new();

        assert_eq!(
            CliProcessManager::read_bounded_line(&mut reader, &mut line).unwrap(),
            crate::native_request::MAX_LINE_BYTES + 1
        );
        assert!(line.is_empty());
        assert_eq!(
            CliProcessManager::read_bounded_line(&mut reader, &mut line).unwrap(),
            5
        );
        assert_eq!(line, "next\n");
    }

    #[test]
    fn bounded_line_reader_preserves_utf8_split_across_buffers() {
        let input = std::io::Cursor::new("éclair\n".as_bytes());
        let mut reader = std::io::BufReader::with_capacity(1, input);
        let mut line = String::new();

        assert_eq!(
            CliProcessManager::read_bounded_line(&mut reader, &mut line).unwrap(),
            8
        );
        assert_eq!(line, "éclair\n");
    }

    #[test]
    fn prod_entry_candidates_prefer_exe_relative_before_workspace_fallback() {
        let exe_dir = PathBuf::from("/opt/codenomad/bin");
        let workspace = PathBuf::from("/workspace/codenomad");

        let candidates = prod_entry_candidates(Some(exe_dir.clone()), Some(workspace.clone()))
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();

        assert_eq!(
            candidates.first(),
            Some(&exe_dir.join("resources/server/dist/bin.js"))
        );
        assert_eq!(
            candidates.last(),
            Some(&workspace.join("packages/server/dist/bin.js"))
        );
    }

    #[test]
    fn augment_launch_url_trims_leading_fragment_marker() {
        let _guard = ENV_LOCK.lock().expect("env lock poisoned");
        std::env::set_var("CODENOMAD_UI_LAUNCH_QUERY", "#debug=true");

        let augmented = augment_launch_url("http://127.0.0.1:3000");

        std::env::remove_var("CODENOMAD_UI_LAUNCH_QUERY");
        assert_eq!(augmented, "http://127.0.0.1:3000?debug=true");
    }

    #[test]
    fn augment_launch_url_trims_fragment_marker_when_query_exists() {
        let _guard = ENV_LOCK.lock().expect("env lock poisoned");
        std::env::set_var("CODENOMAD_UI_LAUNCH_QUERY", "#debug=true");

        let augmented = augment_launch_url("http://127.0.0.1:3000?existing=true");

        std::env::remove_var("CODENOMAD_UI_LAUNCH_QUERY");
        assert_eq!(augmented, "http://127.0.0.1:3000?existing=true&debug=true");
    }

    #[test]
    fn stale_generation_cannot_publish_status() {
        let manager = CliProcessManager::new();
        let first = manager.advance_generation();
        manager.with_current_generation(first, || {
            manager.status.lock().state = CliState::Starting;
        });
        let second = manager.advance_generation();

        assert!(manager
            .with_current_generation(first, || {
                manager.status.lock().state = CliState::Ready;
            })
            .is_none());
        assert_eq!(manager.status().state, CliState::Starting);
        assert!(manager
            .with_current_generation(second, || {
                manager.status.lock().state = CliState::Ready;
            })
            .is_some());
        assert_eq!(manager.status().state, CliState::Ready);
    }

    #[test]
    fn generation_invalidated_exit_cannot_replace_requested_stop_status() {
        let manager = CliProcessManager::new();
        let generation = manager.advance_generation();
        manager.status.lock().state = CliState::Ready;

        manager.advance_generation();
        manager.reset_stopped_status();

        assert!(manager
            .with_current_generation(generation, || {
                manager.status.lock().state = CliState::Error;
            })
            .is_none());
        assert_eq!(manager.status().state, CliState::Stopped);
    }

    #[test]
    fn unexpected_ready_exit_is_an_error_with_the_platform_status() {
        let status = if cfg!(windows) {
            Command::new("cmd.exe")
                .args(["/C", "exit", "23"])
                .status()
                .unwrap()
        } else {
            Command::new("sh").args(["-c", "exit 23"]).status().unwrap()
        };

        let message = cli_exit_error(
            &CliStatus {
                state: CliState::Ready,
                ..CliStatus::default()
            },
            &status,
        );
        assert!(
            message.contains("unexpectedly after readiness"),
            "{message}"
        );
        assert!(message.contains("23"), "{message}");
    }

    #[cfg(unix)]
    #[test]
    fn unexpected_ready_exit_preserves_the_signal() {
        use std::os::unix::process::ExitStatusExt;

        let status = std::process::ExitStatus::from_raw(9);
        let message = cli_exit_error(
            &CliStatus {
                state: CliState::Ready,
                ..CliStatus::default()
            },
            &status,
        );
        assert!(message.contains("signal: 9"), "{message}");
    }

    #[test]
    fn local_cli_access_requires_readiness_and_clears_on_stop() {
        let manager = CliProcessManager::new();
        let access = LocalCliAccess {
            base_url: "http://127.0.0.1:3000".into(),
            cookie_name: "codenomad_session_test".into(),
            session_cookie: "secret".into(),
        };
        *manager.local_access.lock() = Some(access.clone());

        assert_eq!(manager.local_cli_access(), None);
        manager.status.lock().state = CliState::Ready;
        assert_eq!(manager.local_cli_access(), Some(access));

        manager.stop().unwrap();
        assert_eq!(manager.local_cli_access(), None);
    }

    #[test]
    fn native_auth_is_limited_to_loopback_http() {
        assert!(is_loopback_http_url("http://127.0.0.1:3000"));
        assert!(is_loopback_http_url("http://[::1]:3000"));
        assert!(is_loopback_http_url("http://localhost:3000"));
        assert!(!is_loopback_http_url("https://localhost:3000"));
        assert!(!is_loopback_http_url("http://remote.example:3000"));
        assert!(!is_loopback_http_url("http://user@localhost:3000"));
    }

    #[test]
    fn stop_invalidates_before_waiting_for_an_authorized_spawn_section() {
        let manager = CliProcessManager::new();
        let generation = manager.advance_generation();
        let worker_manager = manager.clone();
        let (authorized_tx, authorized_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _lifecycle = worker_manager.lock_current_generation(generation).unwrap();
            authorized_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        authorized_rx.recv().unwrap();

        let stopping_manager = manager.clone();
        let (stopped_tx, stopped_rx) = std::sync::mpsc::channel();
        let stopping = std::thread::spawn(move || {
            stopping_manager.stop().unwrap();
            stopped_tx.send(()).unwrap();
        });
        assert!(stopped_rx.recv_timeout(Duration::from_millis(20)).is_err());

        release_tx.send(()).unwrap();
        worker.join().unwrap();
        stopped_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        stopping.join().unwrap();
        assert!(!manager.is_current_generation(generation));
    }

    #[test]
    fn stop_rejects_an_expired_absolute_deadline_before_locking() {
        let manager = CliProcessManager::new();
        let generation = manager.advance_generation();
        let _lifecycle = manager.lifecycle.lock();

        let error = manager.stop_until(Instant::now()).unwrap_err().to_string();

        assert!(error.contains("timed out waiting for CLI generation authority"));
        assert!(!manager.is_current_generation(generation));
        assert!(manager.generation_matches(generation));
        assert!(manager.child.lock().is_none());
    }

    #[test]
    fn stop_generation_authority_wait_honors_the_absolute_deadline() {
        let manager = CliProcessManager::new();
        let _authority = manager.generation_authority.lock();

        let error = manager
            .stop_until(Instant::now() + Duration::from_millis(20))
            .unwrap_err()
            .to_string();

        assert!(error.contains("timed out waiting for CLI generation authority"));
    }

    #[test]
    fn stop_bootstrap_token_wait_honors_the_absolute_deadline() {
        let manager = CliProcessManager::new();
        let _token = manager.bootstrap_token.lock();

        let error = manager
            .stop_until(Instant::now() + Duration::from_millis(20))
            .unwrap_err()
            .to_string();

        assert!(error.contains("timed out waiting for CLI bootstrap token authority"));
    }

    #[test]
    fn stop_local_access_wait_honors_the_absolute_deadline() {
        let manager = CliProcessManager::new();
        let _access = manager.local_access.lock();

        let error = manager
            .stop_until(Instant::now() + Duration::from_millis(20))
            .unwrap_err()
            .to_string();

        assert!(error.contains("timed out waiting for CLI local access authority"));
    }

    #[test]
    fn production_spawn_registration_is_rejected_after_timed_stop_returns() {
        let manager = CliProcessManager::new();
        let generation = manager.advance_generation();
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd.exe");
            command.args(["/C", "ping", "-n", "30", "127.0.0.1"]);
            command
        };
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 30"]);
            configure_posix_process_group(&mut command);
            command
        };
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        configure_spawn(&mut command);
        let child = command.spawn().unwrap();
        #[cfg(windows)]
        let job = WindowsJobObject::create()
            .and_then(|job| {
                job.assign_child(&child)?;
                Ok(job)
            })
            .unwrap();

        assert!(manager.stop_until(Instant::now()).is_err());
        let registered = manager.register_spawned_child(
            generation,
            child,
            #[cfg(windows)]
            job,
        );

        assert!(registered.is_none());
        assert!(manager.child.lock().is_none());
    }

    #[test]
    fn termination_waits_are_clipped_to_the_remaining_absolute_deadline() {
        let deadline = Instant::now() + Duration::from_millis(20);
        let timeout = termination_timeout(Duration::from_secs(30), Some(deadline));
        assert!(timeout <= Duration::from_millis(20));

        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(
            termination_timeout(Duration::from_secs(30), Some(deadline)),
            Duration::ZERO
        );
        assert_eq!(
            termination_timeout(Duration::from_secs(30), None),
            Duration::from_secs(30)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_launch_gate_requires_parent_release() {
        assert!(!wait_for_windows_cli_launch_gate(std::io::Cursor::new([])));
        assert!(!wait_for_windows_cli_launch_gate(std::io::Cursor::new([0])));
        assert!(wait_for_windows_cli_launch_gate(std::io::Cursor::new([1])));
    }

    #[cfg(windows)]
    #[test]
    fn windows_launcher_preserves_the_shutdown_control_channel() {
        let mut control = std::io::Cursor::new(b"\x01codenomad:shutdown\n");
        let mut node_stdin = Vec::new();

        assert!(wait_for_windows_cli_launch_gate(&mut control));
        relay_windows_cli_control(&mut control, &mut node_stdin).unwrap();

        assert_eq!(node_stdin, b"codenomad:shutdown\n");
    }

    #[cfg(windows)]
    #[test]
    fn windows_stop_writes_the_exact_shutdown_command() {
        let mut control = Vec::new();
        request_windows_cli_shutdown(&mut control).unwrap();
        assert_eq!(control, b"codenomad:shutdown\n");
    }

    #[cfg(windows)]
    #[test]
    fn windows_requires_an_empty_job_to_confirm_containment() {
        assert!(windows_containment_confirmed(true, Some(0)));
        assert!(!windows_containment_confirmed(true, Some(1)));
        assert!(!windows_containment_confirmed(true, None));
        assert!(!windows_containment_confirmed(false, Some(0)));
    }

    #[cfg(windows)]
    #[test]
    fn windows_exited_child_without_job_remains_unconfirmed() {
        let mut command = Command::new("cmd.exe");
        command.args(["/C", "exit", "0"]);
        configure_spawn(&mut command);
        let mut child = command.spawn().unwrap();
        child.wait().unwrap();

        let error = stop_child(&mut child, None, None).unwrap_err().to_string();
        assert!(error.contains("cannot be confirmed without a Windows job"));
    }

    #[test]
    fn exited_root_is_not_complete_while_descendants_remain() {
        assert!(!containment_is_complete(true, false));
        assert!(containment_is_complete(true, true));
    }

    #[test]
    fn termination_wait_propagates_probe_errors() {
        let result = wait_for_termination(Duration::ZERO, Duration::ZERO, || {
            Err(anyhow::anyhow!("try_wait failed"))
        });
        assert_eq!(result.unwrap_err().to_string(), "try_wait failed");
    }

    #[test]
    fn termination_wait_rejects_unconfirmed_exit() {
        let result = wait_for_termination(Duration::ZERO, Duration::ZERO, || Ok(false));
        assert_eq!(
            result.unwrap_err().to_string(),
            "process termination was not confirmed"
        );
    }

    #[test]
    fn termination_wait_accepts_confirmed_exit() {
        let mut probes = 0;
        wait_for_termination(Duration::from_secs(1), Duration::ZERO, || {
            probes += 1;
            Ok(probes == 2)
        })
        .unwrap();
        assert_eq!(probes, 2);
    }
}
