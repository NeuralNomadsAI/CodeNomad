use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
#[cfg(windows)]
use std::ffi::c_void;
use std::io::{BufRead, BufReader};
#[cfg(windows)]
use std::mem::{size_of, zeroed};
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

const LOG_LIMIT: usize = 1_000;
const LOG_MESSAGE_LIMIT: usize = 512;
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeveloperRunTarget {
    Electron,
    Tauri,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeveloperRunState {
    Starting,
    Ready,
    Error,
    #[default]
    Stopped,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperRunStatus {
    pub state: DeveloperRunState,
    pub run_id: Option<String>,
    pub target: Option<DeveloperRunTarget>,
    pub executable_path: Option<PathBuf>,
    pub profile_path: Option<PathBuf>,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub page_url: Option<String>,
    pub debugger_url: Option<String>,
    pub target_id: Option<String>,
    pub target_title: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperRunLog {
    pub run_id: String,
    pub timestamp: u64,
    pub stream: String,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct DeveloperRunManager {
    shared: Arc<Shared>,
}

#[derive(Debug)]
struct Shared {
    lifecycle: Mutex<()>,
    state: Mutex<ManagerState>,
    generation: AtomicU64,
}

#[derive(Debug, Default)]
struct ManagerState {
    status: DeveloperRunStatus,
    active: Option<ActiveRun>,
    logs: VecDeque<DeveloperRunLog>,
    generation: u64,
}

#[derive(Debug)]
struct ActiveRun {
    generation: u64,
    child: Child,
    profile: PathBuf,
    #[cfg(windows)]
    job: WindowsJobObject,
}

#[derive(Debug, Eq, PartialEq)]
struct LaunchSpec {
    args: Vec<String>,
    environment: Vec<(&'static str, String)>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPageTarget {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(rename = "type")]
    kind: String,
    web_socket_debugger_url: Option<String>,
}

impl DeveloperRunManager {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                lifecycle: Mutex::new(()),
                state: Mutex::new(ManagerState::default()),
                generation: AtomicU64::new(0),
            }),
        }
    }

    pub fn status(&self) -> DeveloperRunStatus {
        self.shared.state.lock().status.clone()
    }

    pub fn logs(&self) -> Vec<DeveloperRunLog> {
        self.shared.state.lock().logs.iter().cloned().collect()
    }

    pub fn start(
        &self,
        target: DeveloperRunTarget,
        executable_path: impl AsRef<Path>,
    ) -> anyhow::Result<DeveloperRunStatus> {
        if target == DeveloperRunTarget::Tauri && !cfg!(windows) {
            return Err(anyhow::anyhow!(
                "Tauri developer runs currently require Windows WebView2"
            ));
        }

        let executable_path = executable_path
            .as_ref()
            .canonicalize()
            .map_err(|error| anyhow::anyhow!("invalid developer executable path: {error}"))?;
        if !executable_path.is_file() {
            return Err(anyhow::anyhow!(
                "developer executable is not a file: {}",
                executable_path.display()
            ));
        }

        let port = allocate_loopback_port()?;
        let run_id = uuid::Uuid::new_v4().to_string();
        let profile_path = std::env::temp_dir()
            .join("codenomad-developer-runs")
            .join(&run_id);
        std::fs::create_dir_all(&profile_path)?;
        #[cfg(unix)]
        std::fs::set_permissions(
            &profile_path,
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )?;
        let launch = launch_spec(
            target,
            port,
            &profile_path,
            &run_id,
            std::env::var("NODE_OPTIONS").ok().as_deref(),
            std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
                .ok()
                .as_deref(),
        );
        let _lifecycle = self.shared.lifecycle.lock();
        let generation = self.shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.shared.state.lock().generation = generation;
        if let Err(error) = self.stop_active() {
            let _ = std::fs::remove_dir_all(&profile_path);
            self.publish_error(
                generation,
                format!("failed to replace developer run: {error}"),
            );
            return Err(error);
        }

        {
            let mut state = self.shared.state.lock();
            state.logs.clear();
            state.generation = generation;
            state.status = DeveloperRunStatus {
                state: DeveloperRunState::Starting,
                run_id: Some(run_id),
                target: Some(target),
                executable_path: Some(executable_path.clone()),
                profile_path: Some(profile_path.clone()),
                pid: None,
                port: Some(port),
                page_url: None,
                debugger_url: None,
                target_id: None,
                target_title: None,
                error: None,
            };
        }

        let mut command = Command::new(&executable_path);
        command
            .args(&launch.args)
            .envs(launch.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(directory) = executable_path.parent() {
            command.current_dir(directory);
        }
        configure_process_group(&mut command);

        #[cfg(windows)]
        let job = match WindowsJobObject::create() {
            Ok(job) => job,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&profile_path);
                self.publish_error(generation, error.to_string());
                return Err(error);
            }
        };
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&profile_path);
                self.publish_error(
                    generation,
                    format!("failed to launch developer run: {error}"),
                );
                return Err(error.into());
            }
        };
        #[cfg(windows)]
        if let Err(error) = job.assign_child(&child) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&profile_path);
            self.publish_error(generation, error.to_string());
            return Err(error);
        }

        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        {
            let mut state = self.shared.state.lock();
            if state.generation != generation {
                terminate_child(
                    &mut child,
                    #[cfg(windows)]
                    &job,
                )?;
                return Err(anyhow::anyhow!("developer run start was superseded"));
            }
            state.status.pid = Some(pid);
            state.active = Some(ActiveRun {
                generation,
                child,
                profile: profile_path,
                #[cfg(windows)]
                job,
            });
        }

        if let Some(stdout) = stdout {
            spawn_log_reader(Arc::clone(&self.shared), generation, "stdout", stdout);
        }
        if let Some(stderr) = stderr {
            spawn_log_reader(Arc::clone(&self.shared), generation, "stderr", stderr);
        }
        spawn_readiness_poll(Arc::clone(&self.shared), generation, port);
        spawn_exit_monitor(Arc::clone(&self.shared), generation);
        Ok(self.status())
    }

    pub fn stop(&self) -> anyhow::Result<DeveloperRunStatus> {
        let _lifecycle = self.shared.lifecycle.lock();
        let generation = self.shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.shared.state.lock().generation = generation;
        if let Err(error) = self.stop_active() {
            self.publish_error(generation, format!("failed to stop developer run: {error}"));
            return Err(error);
        }
        let mut state = self.shared.state.lock();
        state.generation = generation;
        state.status = DeveloperRunStatus::default();
        Ok(state.status.clone())
    }

    pub fn restart(&self) -> anyhow::Result<DeveloperRunStatus> {
        let status = self.status();
        self.start(
            status
                .target
                .ok_or_else(|| anyhow::anyhow!("Developer Automation is not running"))?,
            status
                .executable_path
                .ok_or_else(|| anyhow::anyhow!("Developer Automation has no executable"))?,
        )
    }

    fn stop_active(&self) -> anyhow::Result<()> {
        let active = self.shared.state.lock().active.take();
        let Some(mut active) = active else {
            return Ok(());
        };
        let result = terminate_child(
            &mut active.child,
            #[cfg(windows)]
            &active.job,
        )
        .and_then(|_| std::fs::remove_dir_all(&active.profile).map_err(Into::into));
        if result.is_err() {
            self.shared.state.lock().active = Some(active);
        }
        result
    }

    fn publish_error(&self, generation: u64, message: String) {
        publish_error(&self.shared, generation, message);
    }
}

impl Default for DeveloperRunManager {
    fn default() -> Self {
        Self::new()
    }
}

fn allocate_loopback_port() -> anyhow::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

fn launch_spec(
    target: DeveloperRunTarget,
    port: u16,
    profile: &Path,
    run_id: &str,
    node_options: Option<&str>,
    webview_options: Option<&str>,
) -> LaunchSpec {
    let config = profile.join("config.yaml").to_string_lossy().into_owned();
    let node_options = node_options
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("{value} --enable-source-maps"))
        .unwrap_or_else(|| "--enable-source-maps".to_string());
    let mut environment = vec![
        (
            "CODENOMAD_UPDATE_CHANNEL",
            format!("developer-automation-{run_id}"),
        ),
        ("CLI_CONFIG", config),
        ("NODE_OPTIONS", node_options),
    ];
    match target {
        DeveloperRunTarget::Electron => LaunchSpec {
            args: vec![
                "--remote-debugging-address=127.0.0.1".to_string(),
                format!("--remote-debugging-port={port}"),
                format!("--user-data-dir={}", profile.display()),
                "--enable-logging".to_string(),
            ],
            environment,
        },
        DeveloperRunTarget::Tauri => {
            let webview_options = webview_options
                .into_iter()
                .flat_map(str::split_whitespace)
                .filter(|value| {
                    !value.starts_with("--remote-debugging-address=")
                        && !value.starts_with("--remote-debugging-port=")
                })
                .collect::<Vec<_>>()
                .join(" ");
            environment.extend([
                (
                    "WEBVIEW2_USER_DATA_FOLDER",
                    profile.join("webview2").to_string_lossy().into_owned(),
                ),
                (
                    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                    format!(
                        "{}--remote-debugging-address=127.0.0.1 --remote-debugging-port={port}",
                        (!webview_options.is_empty())
                            .then(|| format!("{webview_options} "))
                            .unwrap_or_default()
                    ),
                ),
                ("RUST_BACKTRACE", "1".to_string()),
            ]);
            LaunchSpec {
                args: Vec::new(),
                environment,
            }
        }
    }
}

fn push_log(state: &mut ManagerState, stream: impl Into<String>, message: impl Into<String>) {
    let Some(run_id) = state.status.run_id.clone() else {
        return;
    };
    let message = message.into();
    let message = if message.chars().count() > LOG_MESSAGE_LIMIT {
        format!(
            "{}...",
            message
                .chars()
                .take(LOG_MESSAGE_LIMIT - 3)
                .collect::<String>()
        )
    } else {
        message
    };
    state.logs.push_back(DeveloperRunLog {
        run_id,
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default(),
        stream: stream.into(),
        message,
    });
    if state.logs.len() > LOG_LIMIT {
        state.logs.pop_front();
    }
}

fn spawn_log_reader(
    shared: Arc<Shared>,
    generation: u64,
    stream: &'static str,
    reader: impl std::io::Read + Send + 'static,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        loop {
            let message = match read_bounded_line(&mut reader) {
                Ok(Some(line)) => line,
                Ok(None) => return,
                Err(error) => format!("failed to read {stream}: {error}"),
            };
            let mut state = shared.state.lock();
            if state.generation != generation {
                return;
            }
            push_log(&mut state, stream, message);
        }
    });
}

fn read_bounded_line(reader: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut bytes = Vec::with_capacity(LOG_MESSAGE_LIMIT);
    let mut truncated = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            let mut line = String::from_utf8_lossy(&bytes).into_owned();
            if truncated {
                line = format!(
                    "{}...",
                    line.chars().take(LOG_MESSAGE_LIMIT - 3).collect::<String>()
                );
            }
            return Ok(Some(line));
        }
        let end = available.iter().position(|byte| *byte == b'\n');
        let part = &available[..end.unwrap_or(available.len())];
        let remaining = LOG_MESSAGE_LIMIT.saturating_sub(bytes.len());
        bytes.extend_from_slice(&part[..part.len().min(remaining)]);
        truncated |= part.len() > remaining;
        let consumed = part.len() + usize::from(end.is_some());
        reader.consume(consumed);
        if end.is_some() {
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            let mut line = String::from_utf8_lossy(&bytes).into_owned();
            if truncated {
                line = format!(
                    "{}...",
                    line.chars().take(LOG_MESSAGE_LIMIT - 3).collect::<String>()
                );
            }
            return Ok(Some(line));
        }
    }
}

fn spawn_readiness_poll(shared: Arc<Shared>, generation: u64, port: u16) {
    thread::spawn(move || {
        let deadline = Instant::now() + READY_TIMEOUT;
        let base_url = format!("http://127.0.0.1:{port}");
        let client = match reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(500))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                publish_error(&shared, generation, error.to_string());
                return;
            }
        };
        let mut last_error = "CDP endpoint did not respond".to_string();

        while Instant::now() < deadline {
            if shared.state.lock().generation != generation {
                return;
            }
            match discover_page(&client, &base_url) {
                Ok(page_target) => {
                    let mut state = shared.state.lock();
                    if state.generation != generation
                        || state.status.state != DeveloperRunState::Starting
                    {
                        return;
                    }
                    state.status.state = DeveloperRunState::Ready;
                    state.status.page_url = Some(page_target.url);
                    state.status.debugger_url = page_target.web_socket_debugger_url;
                    state.status.target_id = Some(page_target.id);
                    state.status.target_title = Some(page_target.title);
                    return;
                }
                Err(error) => last_error = error.to_string(),
            }
            thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())));
        }
        publish_error(
            &shared,
            generation,
            format!("timed out waiting for a CDP page target: {last_error}"),
        );
        terminate_generation(&shared, generation);
    });
}

fn discover_page(
    client: &reqwest::blocking::Client,
    base_url: &str,
) -> anyhow::Result<RawPageTarget> {
    client
        .get(format!("{base_url}/json/version"))
        .send()?
        .error_for_status()?
        .json::<serde_json::Value>()?;
    let targets = client
        .get(format!("{base_url}/json/list"))
        .send()?
        .error_for_status()?
        .json::<Vec<RawPageTarget>>()?;
    let page = targets
        .into_iter()
        .find(|target| {
            target.kind == "page"
                && target.url != "about:blank"
                && !target
                    .url
                    .split(['?', '#'])
                    .next()
                    .is_some_and(|url| url.ends_with("/loading.html"))
                && target
                    .web_socket_debugger_url
                    .as_deref()
                    .is_some_and(|url| !url.is_empty())
        })
        .ok_or_else(|| anyhow::anyhow!("CDP has no ready page target"))?;
    Ok(page)
}

fn spawn_exit_monitor(shared: Arc<Shared>, generation: u64) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(100));
        let mut state = shared.state.lock();
        if state.generation != generation {
            return;
        }
        let Some(active) = state
            .active
            .as_mut()
            .filter(|active| active.generation == generation)
        else {
            return;
        };
        match active.child.try_wait() {
            Ok(Some(exit)) => {
                state.status.pid = None;
                if state.status.state != DeveloperRunState::Error {
                    state.status.state = DeveloperRunState::Error;
                    state.status.error = Some(format!("developer run exited: {exit}"));
                }
                drop(state);
                terminate_generation(&shared, generation);
                return;
            }
            Ok(None) => {}
            Err(error) => {
                drop(state);
                publish_error(
                    &shared,
                    generation,
                    format!("failed to inspect developer run: {error}"),
                );
                return;
            }
        }
    });
}

fn publish_error(shared: &Shared, generation: u64, message: String) {
    let mut state = shared.state.lock();
    if state.generation != generation {
        return;
    }
    state.status.state = DeveloperRunState::Error;
    state.status.error = Some(message.clone());
}

fn terminate_generation(shared: &Shared, generation: u64) {
    let _lifecycle = shared.lifecycle.lock();
    let active = {
        let mut state = shared.state.lock();
        if state.generation != generation {
            return;
        }
        state
            .active
            .take()
            .filter(|active| active.generation == generation)
    };
    if let Some(mut active) = active {
        let result = terminate_child(
            &mut active.child,
            #[cfg(windows)]
            &active.job,
        )
        .and_then(|_| std::fs::remove_dir_all(&active.profile).map_err(Into::into));
        if let Err(error) = result {
            let mut state = shared.state.lock();
            if state.generation == generation && state.active.is_none() {
                state.active = Some(active);
                state.status.state = DeveloperRunState::Error;
                state.status.error = Some(format!("failed to stop developer run: {error}"));
            }
        } else {
            let mut state = shared.state.lock();
            if state.generation == generation {
                state.status.pid = None;
            }
        }
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            libc::umask(0o077);
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

#[cfg(windows)]
fn configure_process_group(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(any(unix, windows)))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_child(child: &mut Child) -> anyhow::Result<()> {
    let pid = child.id() as i32;
    unsafe {
        if libc::kill(-pid, libc::SIGTERM) != 0 {
            let _ = libc::kill(pid, libc::SIGTERM);
        }
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if child.try_wait()?.is_some() && process_group_is_gone(pid)? {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
    }
    unsafe {
        if libc::kill(-pid, libc::SIGKILL) != 0 {
            let _ = libc::kill(pid, libc::SIGKILL);
        }
    }
    wait_for_exit(child, || process_group_is_gone(pid))
}

#[cfg(unix)]
fn process_group_is_gone(pid: i32) -> anyhow::Result<bool> {
    if unsafe { libc::kill(-pid, 0) } == 0 {
        return Ok(false);
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Ok(true),
        Some(libc::EPERM) => Ok(false),
        _ => Err(std::io::Error::last_os_error().into()),
    }
}

#[cfg(windows)]
fn terminate_child(child: &mut Child, job: &WindowsJobObject) -> anyhow::Result<()> {
    job.terminate()?;
    wait_for_exit(child, || Ok(job.active_processes()? == 0))
}

#[cfg(not(any(unix, windows)))]
fn terminate_child(child: &mut Child) -> anyhow::Result<()> {
    child.kill()?;
    wait_for_exit(child, || Ok(true))
}

fn wait_for_exit(
    child: &mut Child,
    mut descendants_gone: impl FnMut() -> anyhow::Result<bool>,
) -> anyhow::Result<()> {
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if child.try_wait()?.is_some() && descendants_gone()? {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err(anyhow::anyhow!(
        "developer process-tree termination was not confirmed"
    ))
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsJobObject {
    handle: HANDLE,
}

#[cfg(windows)]
impl WindowsJobObject {
    fn create() -> anyhow::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().into());
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
            let error = std::io::Error::last_os_error();
            unsafe { CloseHandle(handle) };
            return Err(error.into());
        }
        Ok(Self { handle })
    }

    fn assign_child(&self, child: &Child) -> anyhow::Result<()> {
        if unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle() as HANDLE) } == 0 {
            return Err(anyhow::anyhow!(
                "failed to contain developer process tree: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    fn active_processes(&self) -> anyhow::Result<u32> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        if unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(info.ActiveProcesses)
    }

    fn terminate(&self) -> anyhow::Result<()> {
        if unsafe { TerminateJobObject(self.handle, 1) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for WindowsJobObject {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { CloseHandle(self.handle) };
        }
    }
}

#[cfg(windows)]
unsafe impl Send for WindowsJobObject {}

#[cfg(windows)]
unsafe impl Sync for WindowsJobObject {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_supported_targets() {
        assert_eq!(
            serde_json::from_str::<DeveloperRunTarget>("\"electron\"").unwrap(),
            DeveloperRunTarget::Electron
        );
        assert_eq!(
            serde_json::from_str::<DeveloperRunTarget>("\"tauri\"").unwrap(),
            DeveloperRunTarget::Tauri
        );
        assert!(serde_json::from_str::<DeveloperRunTarget>("\"browser\"").is_err());
    }

    #[test]
    fn launch_specs_isolate_profiles_and_enable_target_cdp() {
        let profile = Path::new("developer-profile");
        assert_eq!(
            launch_spec(
                DeveloperRunTarget::Electron,
                9223,
                profile,
                "run-1",
                None,
                None
            ),
            LaunchSpec {
                args: vec![
                    "--remote-debugging-address=127.0.0.1".to_string(),
                    "--remote-debugging-port=9223".to_string(),
                    format!("--user-data-dir={}", profile.display()),
                    "--enable-logging".to_string(),
                ],
                environment: vec![
                    (
                        "CODENOMAD_UPDATE_CHANNEL",
                        "developer-automation-run-1".to_string()
                    ),
                    (
                        "CLI_CONFIG",
                        profile.join("config.yaml").to_string_lossy().into_owned()
                    ),
                    ("NODE_OPTIONS", "--enable-source-maps".to_string()),
                ],
            }
        );
        assert_eq!(
            launch_spec(
                DeveloperRunTarget::Tauri,
                9223,
                profile,
                "run-1",
                Some("--trace-warnings"),
                Some("--remote-debugging-port=8111 --disable-features=msSmartScreenProtection")
            ),
            LaunchSpec {
                args: Vec::new(),
                environment: vec![
                    (
                        "CODENOMAD_UPDATE_CHANNEL",
                        "developer-automation-run-1".to_string()
                    ),
                    (
                        "CLI_CONFIG",
                        profile.join("config.yaml").to_string_lossy().into_owned()
                    ),
                    (
                        "NODE_OPTIONS",
                        "--trace-warnings --enable-source-maps".to_string()
                    ),
                    (
                        "WEBVIEW2_USER_DATA_FOLDER",
                        profile.join("webview2").to_string_lossy().into_owned()
                    ),
                    (
                        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                        "--disable-features=msSmartScreenProtection --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223".to_string()
                    ),
                    ("RUST_BACKTRACE", "1".to_string()),
                ],
            }
        );
    }

    #[test]
    fn logs_are_bounded_to_the_latest_thousand() {
        let mut state = ManagerState::default();
        state.status.run_id = Some("run-1".to_string());
        for index in 0..1_005 {
            push_log(&mut state, "stdout", index.to_string());
        }
        assert_eq!(state.logs.len(), LOG_LIMIT);
        assert_eq!(state.logs.front().unwrap().message, "5");
        assert_eq!(state.logs.back().unwrap().message, "1004");
    }

    #[test]
    fn output_lines_are_bounded_before_allocation() {
        let input = format!("{}\nnext\n", "x".repeat(100_000));
        let mut reader = BufReader::new(input.as_bytes());
        let first = read_bounded_line(&mut reader).unwrap().unwrap();
        assert_eq!(first.len(), LOG_MESSAGE_LIMIT);
        assert!(first.ends_with("..."));
        assert_eq!(read_bounded_line(&mut reader).unwrap().unwrap(), "next");
    }

    #[test]
    fn stale_generations_cannot_publish_errors() {
        let manager = DeveloperRunManager::new();
        manager.shared.state.lock().generation = 2;
        manager.publish_error(1, "stale".to_string());
        assert_eq!(manager.status().state, DeveloperRunState::Stopped);
        assert!(manager.logs().is_empty());
    }

    #[test]
    fn loopback_port_allocator_returns_bindable_port() {
        let port = allocate_loopback_port().unwrap();
        assert_ne!(port, 0);
        TcpListener::bind(("127.0.0.1", port)).unwrap();
    }
}
