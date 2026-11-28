//! Private backend-to-host OpenCode service starter (`opencode.service.start`).
//! Runs outside the backend's Job Object / process group so the shared OpenCode daemon
//! survives backend containment shutdown, and uses private temporary files so inherited
//! pipes never hang when a CLI wrapper leaves daemon descendants running.
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_OUTPUT: u64 = 64 * 1024;
const MAX_DEADLINE_MS: u64 = 30_000;
static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Error {
    Expired,
    Cancelled,
    Failed,
}

struct Request {
    file: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    cwd: String,
    windows_verbatim_arguments: bool,
}

impl Request {
    fn parse(params: Value) -> Result<Self, Error> {
        let Value::Object(mut map) = params else {
            return Err(Error::Failed);
        };
        let file = match map.remove("file") {
            Some(Value::String(value)) if !value.is_empty() => value,
            _ => return Err(Error::Failed),
        };
        let args = match map.remove("args") {
            Some(Value::Array(items)) => items
                .into_iter()
                .map(|item| match item {
                    Value::String(value) => Ok(value),
                    _ => Err(Error::Failed),
                })
                .collect::<Result<Vec<_>, _>>()?,
            _ => return Err(Error::Failed),
        };
        let env = match map.remove("env") {
            Some(Value::Object(entries)) => entries
                .into_iter()
                .map(|(key, value)| match value {
                    Value::String(value) => Ok((key, value)),
                    _ => Err(Error::Failed),
                })
                .collect::<Result<BTreeMap<_, _>, _>>()?,
            _ => return Err(Error::Failed),
        };
        let cwd = match map.remove("cwd") {
            Some(Value::String(value)) if !value.is_empty() => value,
            _ => return Err(Error::Failed),
        };
        let windows_verbatim_arguments = match map.remove("windowsVerbatimArguments") {
            Some(Value::Bool(value)) => value,
            _ => return Err(Error::Failed),
        };
        if !map.is_empty() {
            return Err(Error::Failed);
        }
        Ok(Self {
            file,
            args,
            env,
            cwd,
            windows_verbatim_arguments,
        })
    }
}

struct TempOutput {
    file: File,
    #[cfg(windows)]
    path: PathBuf,
}

impl TempOutput {
    fn create(stream: &str) -> io::Result<Self> {
        let dir = std::env::temp_dir();
        let pid = std::process::id();
        for _ in 0..32 {
            let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let path: PathBuf = dir.join(format!(
                "codenomad-service-start-{pid}-{seq}-{nanos}-{stream}.tmp"
            ));
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                // FILE_FLAG_DELETE_ON_CLOSE with read/write/delete sharing so inherited handles
                // can write and the kernel removes the file as soon as the last handle closes.
                options
                    .share_mode(0x1 | 0x2 | 0x4)
                    .custom_flags(0x0400_0000);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(file) => {
                    #[cfg(unix)]
                    let _ = fs::remove_file(&path);
                    return Ok(Self {
                        file,
                        #[cfg(windows)]
                        path,
                    });
                }
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(err),
            }
        }
        Err(io::Error::other("Temporary output allocation failed"))
    }

    fn read_bounded(&mut self) -> Result<String, Error> {
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|_| Error::Failed)?;
        let mut bytes = Vec::new();
        (&mut self.file)
            .take(MAX_OUTPUT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Failed)?;
        if bytes.len() as u64 > MAX_OUTPUT {
            return Err(Error::Failed);
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[cfg(windows)]
impl Drop for TempOutput {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(u64::MAX)
}

pub(super) fn run(
    params: Value,
    deadline: u64,
    cancelled: impl Fn() -> bool,
) -> Result<Value, Error> {
    if cancelled() {
        return Err(Error::Cancelled);
    }
    let request = Request::parse(params)?;
    let deadline = deadline.min(now_ms().saturating_add(MAX_DEADLINE_MS));
    if now_ms() >= deadline {
        return Err(Error::Expired);
    }
    let mut stdout = TempOutput::create("stdout").map_err(|_| Error::Failed)?;
    let mut stderr = TempOutput::create("stderr").map_err(|_| Error::Failed)?;
    let mut command = Command::new(&request.file);
    command
        .current_dir(&request.cwd)
        .env_clear()
        .envs(&request.env)
        .stdin(Stdio::null())
        .stdout(stdout.file.try_clone().map_err(|_| Error::Failed)?)
        .stderr(stderr.file.try_clone().map_err(|_| Error::Failed)?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if request.windows_verbatim_arguments {
            for argument in &request.args {
                command.raw_arg(argument);
            }
        } else {
            command.args(&request.args);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = request.windows_verbatim_arguments;
        command.args(&request.args);
    }
    let mut child =
        codenomad_host_process::spawn_detached(&mut command).map_err(|_| Error::Failed)?;
    let outcome = loop {
        if cancelled() {
            break Err(Error::Cancelled);
        }
        let stdout_len = stdout.file.metadata().map_err(|_| Error::Failed)?.len();
        let stderr_len = stderr.file.metadata().map_err(|_| Error::Failed)?.len();
        if stdout_len > MAX_OUTPUT || stderr_len > MAX_OUTPUT {
            break Err(Error::Failed);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    break Err(Error::Failed);
                }
                break Ok(json!({
                    "stdout": stdout.read_bounded()?,
                    "stderr": stderr.read_bounded()?,
                }));
            }
            Ok(None) => {}
            Err(_) => break Err(Error::Failed),
        }
        if now_ms() >= deadline {
            break Err(Error::Expired);
        }
        thread::sleep(Duration::from_millis(10));
    };
    if outcome.is_err() {
        // Only the short-lived starter belongs to this wait. Never kill its daemon descendants.
        let _ = child.kill();
        let _ = child.wait();
    }
    outcome
}
