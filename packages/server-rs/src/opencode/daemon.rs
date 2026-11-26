//! The shared daemon's official lifecycle through its CLI (`opencode-cli-service.ts`,
//! `native-service-registration.ts`, `native-service-start.ts`): `service status`, `start` and
//! `get password`, the registration fallback and the authenticated health read.
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use reqwest::{Client, Url};
use serde_json::{Value, json};
use tokio::{io::AsyncReadExt, time::Instant};

use super::launch;
use crate::host::native_parent;

pub const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT: usize = 64 * 1024;
const V2_REQUIRED: &str = "opencode_v2_required: Host binary does not support the OpenCode V2 service lifecycle";

#[derive(Debug, Clone, PartialEq)]
pub struct Endpoint {
    pub url: Url,
    pub password: String,
    pub version: String,
    pub pid: u64,
}

#[derive(Clone)]
pub struct Lifecycle {
    pub binary: String,
    client: Client,
    pub config_path: Option<PathBuf>,
}

enum Health {
    Refused,
    Failed(String),
}

pub struct Output {
    pub stdout: String,
    pub stderr: String,
}
pub struct ExecError {
    pub code: Option<i32>,
    pub detail: String,
    pub output: Output,
}

fn timed_out(label: &str) -> String {
    format!("Host OpenCode {label} timed out after {}ms", TIMEOUT.as_millis())
}
fn remaining(deadline: Instant, label: &str) -> Result<Duration, String> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() { Err(timed_out(label)) } else { Ok(left) }
}

/// `helpOutput`: both streams without terminal control sequences or carriage returns.
pub fn help_output(stdout: &str, stderr: &str) -> String {
    static ANSI: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").unwrap()
    });
    ANSI.replace_all(&format!("{stdout}\n{stderr}"), "").replace('\r', "")
}

/// `isOpenCodeServiceCommandUnavailable`: CLI help whose command list lacks `service`.
pub fn service_unavailable(stdout: &str, stderr: &str) -> bool {
    let output = help_output(stdout, stderr);
    let Some(start) = output.lines().position(|l| l.trim_end().eq_ignore_ascii_case("commands:")) else { return false };
    let command = |line: &&str, sub: &str| {
        let words: Vec<&str> = line.split_whitespace().collect();
        words.first().is_some_and(|w| w.eq_ignore_ascii_case("opencode") || w.eq_ignore_ascii_case("opencode2"))
            && (sub.is_empty() || words.get(1).is_some_and(|w| w.eq_ignore_ascii_case(sub)))
    };
    let lines: Vec<&str> = output.lines().skip(start).filter(|l| command(l, "")).collect();
    !lines.is_empty() && !lines.iter().any(|l| command(l, "service"))
}

/// `assertLoopbackServiceUrl` plus the CLI output checks: a loopback HTTP(S) origin, `0.0.0.0` as `127.0.0.1`.
pub fn service_url(value: &str) -> Result<Url, String> {
    let invalid = || "Host OpenCode service returned an invalid loopback URL".to_owned();
    let mut url = Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid());
    }
    if url.host_str() == Some("0.0.0.0") {
        url.set_host(Some("127.0.0.1")).map_err(|_| invalid())?;
    }
    let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    let loopback = host == "localhost"
        || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.octets()[0] == 127)
        || host.parse::<std::net::Ipv6Addr>().is_ok_and(|ip| ip.is_loopback());
    let spaced = value.chars().any(|c| (c.is_whitespace() && c != '\r' && c != '\n') || c.is_control());
    if !loopback
        || spaced
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url)
}

fn single_line(value: &str, label: &str) -> Result<String, String> {
    let line = value.strip_suffix("\r\n").or_else(|| value.strip_suffix(['\n', '\r'])).unwrap_or(value);
    if line.contains(['\n', '\r']) {
        return Err(format!("Host OpenCode service returned multiline {label} output"));
    }
    if line != line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}') {
        return Err(format!("Host OpenCode service returned malformed {label} output"));
    }
    Ok(line.to_owned())
}

fn clip(value: &str) -> String {
    if value.encode_utf16().count() <= 1024 {
        return value.into();
    }
    let head: Vec<u16> = value.encode_utf16().take(1024).collect();
    format!("{}...", String::from_utf16_lossy(&head))
}

async fn read_limited(stream: Option<impl tokio::io::AsyncRead + Unpin>) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    if let Some(stream) = stream {
        stream.take(MAX_OUTPUT as u64 + 1).read_to_end(&mut bytes).await?;
    }
    Ok(bytes)
}

/// `execFile` with `windowsHide`, no shell, bounded output and a deadline.
pub async fn execute(
    spec: &launch::Spec,
    env: Option<&[(String, String)]>,
    timeout: Duration,
) -> Result<Output, ExecError> {
    let empty = || Output { stdout: String::new(), stderr: String::new() };
    let mut command = tokio::process::Command::new(&spec.command);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
        if spec.verbatim {
            for arg in &spec.args {
                command.raw_arg(arg);
            }
        } else {
            command.args(&spec.args);
        }
    }
    #[cfg(not(windows))]
    command.args(&spec.args);
    if let Some(env) = env {
        command.env_clear().envs(env.iter().cloned());
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.kill_on_drop(true).spawn().map_err(|e| {
        let code = if e.kind() == std::io::ErrorKind::NotFound { "ENOENT".into() } else { format!("{:?}", e.kind()) };
        ExecError { code: None, detail: format!("code {code}: spawn {} {code}", spec.command), output: empty() }
    })?;
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let line = format!("{} {}", spec.command, spec.args.join(" "));
    let run = async {
        let (stdout, stderr, status) = tokio::join!(read_limited(out), read_limited(err), child.wait());
        let (stdout, stderr) = (stdout.unwrap_or_default(), stderr.unwrap_or_default());
        let text = |b: &[u8]| String::from_utf8_lossy(&b[..b.len().min(MAX_OUTPUT)]).into_owned();
        let output = Output { stdout: text(&stdout), stderr: text(&stderr) };
        if stdout.len() > MAX_OUTPUT || stderr.len() > MAX_OUTPUT {
            let which = if stdout.len() > MAX_OUTPUT { "stdout" } else { "stderr" };
            let detail = format!("code ERR_CHILD_PROCESS_STDIO_MAXBUFFER: {which} maxBuffer length exceeded");
            return Err(ExecError { code: None, detail, output });
        }
        match status {
            Ok(status) if status.success() => Ok(output),
            status => {
                let code = status.ok().and_then(|s| s.code());
                let message = format!("Command failed: {line}\n{}", output.stderr);
                let parts = [
                    code.map(|c| format!("code {c}")).unwrap_or_default(),
                    message,
                    output.stderr.trim().into(),
                    output.stdout.trim().into(),
                ];
                let detail = parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(": ");
                Err(ExecError { code, detail, output })
            }
        }
    };
    tokio::time::timeout(timeout, run)
        .await
        .unwrap_or_else(|_| Err(ExecError { code: None, detail: format!("Command failed: {line}\n"), output: empty() }))
}

/// A refused connection (no listener) anywhere in the error's source chain.
fn refused(error: &reqwest::Error) -> bool {
    let mut source: Option<&dyn std::error::Error> = Some(error);
    while let Some(e) = source {
        if e.downcast_ref::<std::io::Error>().is_some_and(|io| io.kind() == std::io::ErrorKind::ConnectionRefused) {
            return true;
        }
        source = e.source();
    }
    false
}

impl Lifecycle {
    pub fn new(binary: String, client: Client) -> Self {
        Self { binary, client, config_path: None }
    }

    pub fn with_config(binary: String, client: Client, config_path: Option<PathBuf>) -> Self {
        Self { binary, client, config_path }
    }

    pub async fn discover(&self, deadline: Instant) -> Result<Option<Endpoint>, String> {
        let status = single_line(&self.run(&["service", "status"], None, deadline).await?, "status")?;
        if status == "stopped" {
            return self.discover_registration(deadline).await;
        }
        self.endpoint(&status, deadline).await.map(Some)
    }

    /// Starts the daemon directly without a redundant discovery pass, using `environment`.
    pub async fn start_with_env(
        &self,
        environment: &[(String, String)],
        deadline: Instant,
    ) -> Result<Endpoint, String> {
        let url = single_line(&self.run(&["service", "start"], Some(environment), deadline).await?, "start")?;
        self.endpoint(&url, deadline).await
    }

    #[cfg(test)]
    pub async fn ensure(&self, deadline: Instant) -> Result<Endpoint, String> {
        let environment = launch::daemon_environment_from_config(self.config_path.as_deref())?;
        self.ensure_with_env(&environment, deadline).await
    }

    pub async fn ensure_with_env(
        &self,
        environment: &[(String, String)],
        deadline: Instant,
    ) -> Result<Endpoint, String> {
        if let Some(existing) = self.discover(deadline).await? {
            return Ok(existing);
        }
        self.start_with_env(environment, deadline).await
    }

    /// Explicit user restart only (`opencode-cli-service.ts:74-79`): validate and freeze the
    /// startup environment before any mutation, stop the shared service, then start it with that
    /// exact environment snapshot.
    #[cfg(test)]
    pub async fn restart(&self, deadline: Instant) -> Result<Endpoint, String> {
        let environment = launch::daemon_environment_from_config(self.config_path.as_deref())?;
        self.restart_with_env(&environment, deadline).await
    }

    pub async fn restart_with_env(
        &self,
        environment: &[(String, String)],
        deadline: Instant,
    ) -> Result<Endpoint, String> {
        let _ = self.run(&["service", "stop"], None, deadline).await?;
        self.ensure_with_env(environment, deadline).await
    }

    async fn password(&self, deadline: Instant) -> Result<String, String> {
        let password = single_line(&self.run(&["service", "get", "password"], None, deadline).await?, "password")?;
        if password.is_empty() {
            return Err("Host OpenCode service returned an empty password".into());
        }
        Ok(password)
    }

    async fn endpoint(&self, value: &str, deadline: Instant) -> Result<Endpoint, String> {
        let url = service_url(value)?;
        let password = self.password(deadline).await?;
        match self.validate(value, &url, &password, deadline).await {
            Ok((version, pid)) => Ok(Endpoint { url, password, version, pid }),
            Err(Health::Refused) => Err("Cannot reach OpenCode service: connection refused".into()),
            Err(Health::Failed(message)) => Err(message),
        }
    }

    /// The 2.0.11 recovery: a stopped status still lets the registration or the configured port prove a daemon.
    async fn discover_registration(&self, deadline: Instant) -> Result<Option<Endpoint>, String> {
        let password = self.password(deadline).await?;
        let state = single_line(&self.run(&["debug", "paths", "state"], None, deadline).await?, "state directory")?;
        let config = single_line(&self.run(&["debug", "paths", "config"], None, deadline).await?, "config directory")?;
        let left = remaining(deadline, "registration discovery")?;
        let read = tokio::task::spawn_blocking({
            let password = password.clone();
            move || registration(&state, &config, &password)
        });
        let registration = match tokio::time::timeout(left, read).await {
            Err(_) => return Err(timed_out("registration discovery")),
            Ok(joined) => joined.map_err(|_| "Cannot read native service metadata".to_owned())??,
        };
        let Some((raw, pid)) = registration else { return Ok(None) };
        let url = service_url(&raw)?;
        let (version, reported) = match self.validate(&raw, &url, &password, deadline).await {
            Ok(identity) => identity,
            // Only a refused connection proves a stale registration; anything else blocks a start.
            Err(Health::Refused) => return Ok(None),
            Err(Health::Failed(message)) => return Err(message),
        };
        if pid.is_some_and(|pid| pid != reported) {
            return Err("Native service registration identity changed".into());
        }
        Ok(Some(Endpoint { url, password, version, pid: reported }))
    }

    async fn run(
        &self,
        args: &[&str],
        start_env: Option<&[(String, String)]>,
        deadline: Instant,
    ) -> Result<String, String> {
        // The host CLI only: a WSL executable is refused like an absent capability.
        if launch::wsl(&self.binary) {
            return Err("WSL OpenCode is not supported by this backend".into());
        }
        let start = start_env.is_some();
        let label = args.join(" ");
        let timeout = remaining(deadline, &label)?;
        let spec = launch::spec(&self.binary, args)?;
        let result = if let Some(environment) = start_env
            && native_parent::available()
        {
            self.delegate(&spec, environment, timeout).await
        } else {
            execute(&spec, start_env, timeout).await
        };
        let result = if remaining(deadline, &label).is_err() {
            Err(ExecError {
                code: None,
                detail: timed_out(&label),
                output: Output { stdout: String::new(), stderr: String::new() },
            })
        } else {
            result
        };
        match result {
            Ok(output) if service_unavailable(&output.stdout, &output.stderr) => Err(V2_REQUIRED.into()),
            Ok(output) => Ok(output.stdout),
            Err(e) if service_unavailable(&e.output.stdout, &e.output.stderr) => Err(V2_REQUIRED.into()),
            Err(e) if start || label == "service get password" => {
                let operation = if start { "start" } else { "password retrieval" };
                Err(format!(
                    "Host OpenCode {operation} failed{}",
                    e.code.map(|c| format!(" (exit code {c})")).unwrap_or_default()
                ))
            }
            Err(e) => Err(format!(
                "Host OpenCode {label} failed{}",
                Some(clip(&e.detail)).filter(|d| !d.is_empty()).map(|d| format!(": {d}")).unwrap_or_default()
            )),
        }
    }

    /// Only the start crosses to the desktop host, outside this backend's containment.
    async fn delegate(
        &self,
        spec: &launch::Spec,
        env: &[(String, String)],
        timeout: Duration,
    ) -> Result<Output, ExecError> {
        let env: serde_json::Map<String, Value> = env.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
        let params = json!({"file": spec.command, "args": spec.args, "env": env, "cwd": cwd, "windowsVerbatimArguments": spec.verbatim});
        let empty = || Output { stdout: String::new(), stderr: String::new() };
        match native_parent::request("opencode.service.start", params, timeout).await {
            Ok(result) => {
                let text = |key: &str| result[key].as_str().unwrap_or_default().to_owned();
                Ok(Output { stdout: text("stdout"), stderr: text("stderr") })
            }
            Err(detail) => Err(ExecError { code: None, detail, output: empty() }),
        }
    }

    /// `server.info` on the authenticated endpoint; the older `status` then `health` only after a 404.
    async fn validate(&self, raw: &str, url: &Url, password: &str, deadline: Instant) -> Result<(String, u64), Health> {
        let mut kind = "info";
        let mut response = self.fetch(raw, url, password, kind, deadline).await?;
        for older in ["status", "health"] {
            if response.status() != 404 {
                break;
            }
            kind = older;
            response = self.fetch(raw, url, password, kind, deadline).await?;
        }
        if response.status() == 401 {
            return Err(Health::Failed(format!("Host OpenCode service authentication failed at {raw} (HTTP 401)")));
        }
        if !response.status().is_success() {
            let status = response.status().as_u16();
            return Err(Health::Failed(format!("Host OpenCode service {kind} check failed at {raw} (HTTP {status})")));
        }
        let invalid = || Health::Failed(format!("Host OpenCode service returned an invalid {kind} response at {raw}"));
        let left = remaining(deadline, &format!("{kind} response")).map_err(|_| invalid())?;
        let body = tokio::time::timeout(left, super::read_json(response, MAX_OUTPUT)).await;
        let payload = body.map_err(|_| invalid())?.map_err(|_| invalid())?;
        let pid = payload["pid"].as_u64().filter(|p| *p < (1 << 53));
        let version = payload["version"].as_str().filter(|v| !v.trim().is_empty());
        let valid = if kind == "health" {
            payload["healthy"] == true && pid.is_some_and(|p| p > 0)
        } else {
            pid.is_some() && payload["urls"].as_array().is_some_and(|u| u.iter().all(Value::is_string))
        };
        let (Some(version), Some(pid), true) = (version, pid, valid) else { return Err(invalid()) };
        remaining(deadline, &format!("{kind} validation")).map_err(Health::Failed)?;
        Ok((version.to_owned(), pid))
    }

    async fn fetch(
        &self,
        raw: &str,
        url: &Url,
        password: &str,
        kind: &str,
        deadline: Instant,
    ) -> Result<reqwest::Response, Health> {
        let unreachable = || Health::Failed(format!("Cannot reach the Host OpenCode service at {raw}"));
        let left = remaining(deadline, &format!("{kind} validation")).map_err(|_| unreachable())?;
        let target = url.join(&format!("/api/{kind}")).map_err(|_| unreachable())?;
        let sent = self.client.get(target).basic_auth("opencode", Some(password)).timeout(left).send().await;
        match sent {
            // `redirect: "error"`: a credentialed health read never follows a redirect.
            Ok(response) if response.status().is_redirection() => Err(unreachable()),
            Ok(response) => Ok(response),
            Err(e) if refused(&e) => Err(Health::Refused),
            Err(_) => Err(unreachable()),
        }
    }
}

fn absolute(directory: &str) -> bool {
    let windows =
        directory.len() >= 3 && directory.as_bytes()[1] == b':' && matches!(directory.as_bytes()[2], b'\\' | b'/')
            || directory.starts_with("\\\\");
    (directory.starts_with('/') || directory.starts_with('\\') || windows) && !directory.chars().any(|c| c.is_control())
}

fn record(file: &Path) -> Result<Option<serde_json::Map<String, Value>>, String> {
    use std::io::Read;
    let handle = match std::fs::File::open(file) {
        Ok(handle) => handle,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read native service metadata".into()),
    };
    // Records hold credentials: never quote their contents.
    let invalid = || "Invalid native service metadata".to_owned();
    let mut bytes = Vec::new();
    handle.take(MAX_OUTPUT as u64 + 1).read_to_end(&mut bytes).map_err(|_| invalid())?;
    if bytes.len() > MAX_OUTPUT {
        return Err(invalid());
    }
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(record)) => Ok(Some(record)),
        _ => Err(invalid()),
    }
}

/// `readNativeServiceRegistration`: the channel whose config holds this password, then its record;
/// without a record, the configured port (no PID) to authenticate before any start.
fn registration(state: &str, config: &str, password: &str) -> Result<Option<(String, Option<u64>)>, String> {
    if !absolute(state) || !absolute(config) {
        return Err("OpenCode returned an invalid native service directory".into());
    }
    static NAME: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^service(?:-[a-zA-Z0-9._-]+)?\.json$").unwrap());
    let names: Vec<String> = std::fs::read_dir(config)
        .map_err(|_| "Cannot read native service metadata".to_owned())?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| NAME.is_match(n))
        .collect();
    if names.len() > 64 {
        return Err("Too many native service configurations".into());
    }
    let mut matches = Vec::new();
    for name in names {
        if let Some(found) = record(&Path::new(config).join(&name))?
            && found.get("password").and_then(Value::as_str) == Some(password)
        {
            matches.push((name, found));
        }
    }
    let [(name, channel)] = &matches[..] else {
        return Err("Cannot uniquely identify the selected OpenCode service channel".into());
    };
    let Some(found) = record(&Path::new(state).join(name))? else {
        let Some(port) = channel.get("port") else { return Ok(None) };
        let port = port
            .as_u64()
            .filter(|p| (1..=65535).contains(p))
            .ok_or_else(|| "Invalid native service port".to_owned())?;
        let host = match channel.get("hostname") {
            None => "127.0.0.1",
            Some(h) => h
                .as_str()
                .filter(|h| !h.is_empty() && h.bytes().all(|b| b.is_ascii_alphanumeric() || b".:[]-".contains(&b)))
                .ok_or_else(|| "Invalid native service hostname".to_owned())?,
        };
        let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.into() };
        let url = format!("http://{host}:{port}");
        service_url(&url).map_err(|_| format!("OpenCode service endpoint must be loopback: {host}"))?;
        return Ok(Some((url, None)));
    };
    let pid = found.get("pid").and_then(Value::as_u64).filter(|p| *p > 0 && *p < (1 << 53));
    match (
        found.get("url").and_then(Value::as_str),
        pid,
        found.get("password").and_then(Value::as_str) == Some(password),
    ) {
        (Some(url), Some(pid), true) => Ok(Some((url.into(), Some(pid)))),
        _ => Err("Invalid native service registration or credential mismatch".into()),
    }
}

#[cfg(test)]
#[path = "daemon_tests.rs"]
mod tests;
