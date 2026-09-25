//! Best-effort shell environment discovery, never the long-lived backend launcher.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const MARKER: &str = "\0CODENOMAD_SHELL_ENV\0";
const MAX_OUTPUT: usize = 1024 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(3);

#[derive(serde::Deserialize)]
pub struct ShellEnvironment {
    pub executable: String,
    pub env: HashMap<String, String>,
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// The root is not reaped until its process group is cleaned up, preventing PID reuse.
struct Probe(Child);
impl Drop for Probe {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn parse(output: &[u8]) -> anyhow::Result<Option<ShellEnvironment>> {
    let Some(marker) = output
        .windows(MARKER.len())
        .position(|part| part == MARKER.as_bytes())
    else {
        return Ok(None);
    };
    let start = marker + MARKER.len();
    let Some(end) = output[start..].iter().position(|byte| *byte == 0) else {
        return Ok(None);
    };
    let result: ShellEnvironment = serde_json::from_slice(&output[start..start + end])?;
    anyhow::ensure!(
        std::path::Path::new(&result.executable).is_absolute() && !result.executable.contains('\0'),
        "invalid shell runtime path"
    );
    anyhow::ensure!(
        result.env.iter().all(|(key, value)| !key.is_empty()
            && !key.contains(['=', '\0'])
            && !value.contains('\0')),
        "invalid shell environment"
    );
    Ok(Some(result))
}

pub fn resolve(
    shell: &str,
    node: &str,
    cwd: Option<&std::path::Path>,
    is_current: impl Fn() -> bool,
) -> anyhow::Result<ShellEnvironment> {
    let script = format!("exec {} -e {}", quote(node), quote(
        "process.stdout.write('\\0CODENOMAD_SHELL_ENV\\0'+JSON.stringify({executable:process.execPath,env:process.env})+'\\0')"
    ));
    // Preserve the existing Bash rc path: a login profile need not source it.
    // Zsh reads .zshrc automatically and must not source it again.
    let script = if std::path::Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("bash"))
    {
        format!("if [ -f ~/.bashrc ]; then source ~/.bashrc >/dev/null 2>&1; fi; {script}")
    } else {
        script
    };
    let mut command = Command::new(shell);
    command
        .args(["-i", "-l", "-c", &script])
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env_remove("npm_config_prefix")
        .env_remove("NPM_CONFIG_PREFIX")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    // No controlling terminal, and only this short-lived probe belongs to the group.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    collect(command, TIMEOUT, is_current)
}

fn collect(
    mut command: Command,
    timeout: Duration,
    is_current: impl Fn() -> bool,
) -> anyhow::Result<ShellEnvironment> {
    anyhow::ensure!(is_current(), "shell environment discovery cancelled");
    let mut probe = Probe(command.spawn()?);
    let mut stdout = probe
        .0
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("shell stdout unavailable"))?;
    let fd = stdout.as_raw_fd();
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        anyhow::ensure!(
            flags >= 0 && libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) >= 0,
            "cannot configure shell stdout"
        );
    }
    let deadline = Instant::now() + timeout;
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        anyhow::ensure!(is_current(), "shell environment discovery cancelled");
        anyhow::ensure!(
            Instant::now() < deadline,
            "shell environment discovery timed out"
        );
        match stdout.read(&mut buffer) {
            Ok(0) => {
                return Err(anyhow::anyhow!(
                    "shell environment frame missing or incomplete"
                ))
            }
            Ok(count) => {
                anyhow::ensure!(
                    output.len() + count <= MAX_OUTPUT,
                    "shell environment output exceeded limit"
                );
                output.write_all(&buffer[..count])?;
                if let Some(environment) = parse(&output)? {
                    return Ok(environment);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_startup_noise_and_preserves_environment_values() {
        let frame = b"startup banner\n\0CODENOMAD_SHELL_ENV\0{\"executable\":\"/usr/bin/node\",\"env\":{\"PATH\":\"/custom/bin\",\"VALUE\":\"a=b\\nnext\"}}\0";
        let result = parse(frame).unwrap().unwrap();
        assert_eq!(result.env["VALUE"], "a=b\nnext");
        assert_eq!(result.env["PATH"], "/custom/bin");
        assert!(parse(b"not an environment").unwrap().is_none());
        for end in 0..frame.len() {
            assert!(parse(&frame[..end]).unwrap().is_none());
        }
        assert!(
            parse(b"\0CODENOMAD_SHELL_ENV\0{\"executable\":\"/node\\u0000\",\"env\":{}}\0")
                .is_err()
        );
    }

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command
    }

    #[test]
    fn bounds_wait_even_when_a_descendant_keeps_stdout_open() {
        let start = Instant::now();
        assert!(
            collect(shell("sleep 30 & wait"), Duration::from_millis(100), || {
                true
            })
            .is_err()
        );
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn bounds_output_and_honors_cancellation() {
        assert!(collect(shell("yes x"), Duration::from_secs(2), || true).is_err());
        assert!(collect(shell("sleep 30"), Duration::from_secs(2), || false).is_err());
    }

    #[test]
    fn real_zsh_environment_is_loaded_once_and_a_prompt_is_bounded() {
        use std::os::unix::fs::PermissionsExt;
        let zsh = std::env::var("CODENOMAD_TEST_ZSH").unwrap_or_else(|_| "/bin/zsh".into());
        let node = std::env::var("CODENOMAD_TEST_NODE").unwrap_or_else(|_| "node".into());
        assert!(
            std::path::Path::new(&zsh).exists(),
            "Install zsh or set CODENOMAD_TEST_ZSH for POSIX regressions"
        );
        let directory = tempfile::tempdir().unwrap();
        let rc = directory.path().join(".zshrc");
        std::fs::write(
            &rc,
            "print loaded >> \"$ZDOTDIR/count\"\nexport PATH=\"/fixture/bin:$PATH\"\n",
        )
        .unwrap();
        let wrapper = directory.path().join("zsh");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nexport ZDOTDIR={}\nexec {} \"$@\"\n",
                quote(directory.path().to_str().unwrap()),
                quote(&zsh)
            ),
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = resolve(wrapper.to_str().unwrap(), &node, None, || true).unwrap();
        assert!(result.env["PATH"].starts_with("/fixture/bin:"));
        assert_eq!(
            std::fs::read_to_string(directory.path().join("count")).unwrap(),
            "loaded\n"
        );
        std::fs::write(&rc, "export FIXTURE_RC=background\nsleep 30 &\n").unwrap();
        let start = Instant::now();
        let background = resolve(wrapper.to_str().unwrap(), &node, None, || true).unwrap();
        assert_eq!(background.env["FIXTURE_RC"], "background");
        assert!(start.elapsed() < Duration::from_millis(2500));
        std::fs::write(rc, "sleep 30 &\nwait\n").unwrap();
        let start = Instant::now();
        assert!(resolve(wrapper.to_str().unwrap(), &node, None, || true).is_err());
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn bash_rc_exports_survive_a_profile_that_does_not_source_them() {
        use std::os::unix::fs::PermissionsExt;
        let node = std::env::var("CODENOMAD_TEST_NODE").unwrap_or_else(|_| "node".into());
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join(".bash_profile"),
            "export FIXTURE_PROFILE=loaded\n",
        )
        .unwrap();
        std::fs::write(
            directory.path().join(".bashrc"),
            "export FIXTURE_RC=loaded\nexport PATH=\"/fixture/bash/bin:$PATH\"\n",
        )
        .unwrap();
        let wrapper = directory.path().join("bash");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nexport HOME={}\nexec /bin/bash \"$@\"\n",
                quote(directory.path().to_str().unwrap())
            ),
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = resolve(wrapper.to_str().unwrap(), &node, None, || true).unwrap();
        assert_eq!(result.env["FIXTURE_PROFILE"], "loaded");
        assert_eq!(result.env["FIXTURE_RC"], "loaded");
        assert!(result.env["PATH"].starts_with("/fixture/bash/bin:"));
    }
}
