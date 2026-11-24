//! Private backend-to-host service starter. OpenCode owns all daemon lifecycle state.
//! Launch outside the backend Job Object/process group; never register the daemon
//! with backend cleanup. Temporary output files keep inherited pipes from hanging
//! the host when a CLI wrapper leaves descendants running.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, io::{Read, Seek, SeekFrom}, process::{Command, Stdio}, time::{Duration, SystemTime, UNIX_EPOCH}};

const MAX_OUTPUT: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    file: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: String,
    windows_verbatim_arguments: bool,
}

pub fn start(params: Option<Value>, deadline: u64) -> Result<Value, String> {
    run(params, deadline).map_err(|_| "OpenCode service start failed".into())
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(u64::MAX)
}

fn run(params: Option<Value>, deadline: u64) -> anyhow::Result<Value> {
    let request: Request = serde_json::from_value(params.ok_or_else(|| anyhow::anyhow!("Missing request"))?)?;
    let deadline = deadline.min(now().saturating_add(30_000));
    anyhow::ensure!(now() < deadline && !request.file.is_empty(), "Expired or invalid request");
    let mut stdout = tempfile::tempfile()?;
    let mut stderr = tempfile::tempfile()?;
    let mut command = Command::new(request.file);
    command.current_dir(request.cwd).env_clear().envs(request.env)
        .stdin(Stdio::null()).stdout(stdout.try_clone()?).stderr(stderr.try_clone()?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW; no backend job assignment
        if request.windows_verbatim_arguments {
            for argument in request.args { command.raw_arg(argument); }
        } else {
            command.args(request.args);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let _ = request.windows_verbatim_arguments;
        command.args(request.args);
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 { return Err(std::io::Error::last_os_error()); }
                Ok(())
            });
        }
    }
    let mut child = command.spawn()?;
    let result = (|| -> anyhow::Result<Value> {
        loop {
            anyhow::ensure!(stdout.metadata()?.len() <= MAX_OUTPUT && stderr.metadata()?.len() <= MAX_OUTPUT, "Output limit");
            if let Some(status) = child.try_wait()? {
                anyhow::ensure!(status.success(), "Starter failed");
                let read = |file: &mut std::fs::File| -> anyhow::Result<String> {
                    file.seek(SeekFrom::Start(0))?;
                    let mut bytes = Vec::new();
                    file.take(MAX_OUTPUT + 1).read_to_end(&mut bytes)?;
                    anyhow::ensure!(bytes.len() as u64 <= MAX_OUTPUT, "Output limit");
                    Ok(String::from_utf8_lossy(&bytes).into_owned())
                };
                return Ok(json!({ "stdout": read(&mut stdout)?, "stderr": read(&mut stderr)? }));
            }
            anyhow::ensure!(now() < deadline, "Starter timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
    })();
    if result.is_err() {
        // Only the short-lived starter is ours. Never kill its daemon descendants.
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(script: &str) -> Value {
        json!({ "file": which::which("node").unwrap(), "args": ["-e", script],
            "cwd": std::env::current_dir().unwrap(), "env": std::env::vars().collect::<HashMap<_, _>>(),
            "windowsVerbatimArguments": false })
    }

    #[test]
    fn captures_output_and_bounds_failures_without_leaking_secrets() {
        let result = start(Some(request("process.stdout.write('started'); process.stderr.write('notice')")), now() + 5_000).unwrap();
        assert_eq!(result, json!({ "stdout": "started", "stderr": "notice" }));
        for script in ["process.stderr.write('SECRET'); process.exit(1)", "process.stdout.write('x'.repeat(100000))", "setInterval(()=>{},1000)"] {
            assert_eq!(start(Some(request(script)), now() + 500).unwrap_err(), "OpenCode service start failed");
        }
        assert!(start(Some(request("process.exit(0)")), now() - 1).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn preserves_verbatim_cmd_wrapper_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let wrapper = temp.path().join("service wrapper.cmd");
        std::fs::write(&wrapper, "@echo off\r\necho %~1\r\n").unwrap();
        let params = json!({ "file": "cmd.exe", "args": ["/d", "/s", "/c", format!("\"\"{}\" \"a b\"\"", wrapper.display())],
            "cwd": temp.path(), "env": std::env::vars().collect::<HashMap<_, _>>(), "windowsVerbatimArguments": true });
        assert_eq!(start(Some(params), now() + 5_000).unwrap()["stdout"], "a b\r\n");
    }
}
