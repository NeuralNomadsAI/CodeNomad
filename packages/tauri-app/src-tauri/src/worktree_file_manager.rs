use crate::client_state::ClientState;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_GIT_OUTPUT_BYTES: usize = 1024 * 1024;

fn validate_registered_directory(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.chars().any(|value| value.is_control()) {
        return Err("Worktree directory must be a valid absolute local path".to_string());
    }
    let prefix = value.chars().take(2).collect::<String>().replace('\\', "/");
    if prefix == "//" {
        return Err("Network and device paths are not allowed".to_string());
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("Worktree directory must be absolute".to_string());
    }
    #[cfg(windows)]
    {
        let invalid_component = Path::new(value).components().any(|component| {
            let value = component.as_os_str().to_string_lossy();
            let stem = value
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            value == "."
                || value == ".."
                || value.ends_with([' ', '.'])
                || matches!(
                    stem.as_str(),
                    "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                )
                || stem
                    .strip_prefix("COM")
                    .or_else(|| stem.strip_prefix("LPT"))
                    .is_some_and(|number| {
                        matches!(
                            number,
                            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                        )
                    })
        });
        if value
            .get(2..)
            .is_some_and(|suffix| suffix.chars().any(|value| ":<>\"|?*".contains(value)))
            || invalid_component
        {
            return Err("Worktree directory must be an absolute drive path".to_string());
        }
    }
    #[cfg(not(windows))]
    if value == "/dev" || value.starts_with("/dev/") {
        return Err("Device paths are not allowed".to_string());
    }
    Ok(path)
}

fn parse_worktree_inventory(output: &[u8]) -> Result<Vec<PathBuf>, String> {
    let mut entries = Vec::new();
    for field in output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        let value = std::str::from_utf8(field)
            .map_err(|_| "Git worktree inventory contains an invalid path".to_string())?;
        if let Some(path) = value.strip_prefix("worktree ") {
            entries.push(validate_registered_directory(path)?);
        }
    }
    if entries.is_empty() {
        return Err("Git returned an empty worktree inventory".to_string());
    }
    Ok(entries)
}

fn read_bounded(stream: impl Read) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    stream
        .take((MAX_GIT_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|err| format!("failed to read Git worktree inventory: {err}"))?;
    if output.len() > MAX_GIT_OUTPUT_BYTES {
        return Err("Git worktree inventory output exceeded the limit".to_string());
    }
    Ok(output)
}

fn git_worktree_inventory(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["worktree", "list", "--porcelain", "-z"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to run Git worktree inventory: {err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture Git worktree inventory".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture Git worktree inventory errors".to_string())?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout));
    let stderr_reader = thread::spawn(move || read_bounded(stderr));
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|err| err.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Git worktree inventory timed out".to_string());
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "Git worktree inventory reader failed".to_string())??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Git worktree inventory error reader failed".to_string())??;
    if !status.success() {
        let message = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if message.is_empty() {
            "Git worktree inventory failed".to_string()
        } else {
            message
        });
    }
    parse_worktree_inventory(&stdout)
}

fn same_canonical_path(left: &Path, right: &Path) -> bool {
    left == right
}

fn canonicalize_local(path: PathBuf) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|err| err.to_string())?;
    #[cfg(windows)]
    {
        let value = canonical.to_string_lossy();
        let local = value.strip_prefix(r"\\?\").unwrap_or(&value);
        return validate_registered_directory(local);
    }
    #[cfg(not(windows))]
    Ok(canonical)
}

fn require_inventory_membership(
    inventory: &[PathBuf],
    root: &Path,
    target: &Path,
) -> Result<(), String> {
    if !inventory
        .iter()
        .any(|entry| same_canonical_path(entry, root))
    {
        return Err("Workspace root is not registered in the Git worktree inventory".to_string());
    }
    if !inventory
        .iter()
        .any(|entry| same_canonical_path(entry, target))
    {
        return Err("Worktree is not registered in the Git worktree inventory".to_string());
    }
    Ok(())
}

fn verify_inventory(root: &str, registered: &str, target: &str) -> Result<PathBuf, String> {
    let root_input = validate_registered_directory(root)?;
    let registered_input = validate_registered_directory(registered)?;
    let target_input = validate_registered_directory(target)?;
    let root = canonicalize_local(root_input)
        .map_err(|err| format!("failed to resolve workspace root: {err}"))?;
    let registered = canonicalize_local(registered_input)
        .map_err(|err| format!("failed to resolve registered worktree directory: {err}"))?;
    let target = canonicalize_local(target_input)
        .map_err(|err| format!("failed to resolve worktree directory: {err}"))?;
    let inventory = git_worktree_inventory(&root)?
        .into_iter()
        .map(canonicalize_local)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to resolve Git worktree inventory: {err}"))?;
    require_inventory_membership(&inventory, &root, &registered)?;
    target
        .strip_prefix(&registered)
        .map_err(|_| "Worktree target is outside the registered directory".to_string())?;
    if !target.is_dir() {
        return Err("Worktree target must be a directory".to_string());
    }
    Ok(target)
}

fn validate_access(
    window: &WebviewWindow,
    state: &ClientState,
    access_token: &str,
) -> Result<u64, String> {
    if window.label() != "main" {
        return Err("Worktree commands are only available to the local main window".to_string());
    }
    let url = window
        .url()
        .map_err(|err| format!("failed to inspect current renderer URL: {err}"))?;
    state.validate_renderer_access(access_token, &url)
}

#[tauri::command]
pub async fn open_worktree_in_file_manager(
    window: WebviewWindow,
    state: tauri::State<'_, ClientState>,
    access_token: String,
    root_directory: String,
    registered_directory: String,
    target_directory: String,
) -> Result<(), String> {
    let generation = validate_access(&window, &state, &access_token)?;
    let first_root = root_directory.clone();
    let first_registered = registered_directory.clone();
    let first_target = target_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        verify_inventory(&first_root, &first_registered, &first_target)
    })
    .await
    .map_err(|err| err.to_string())??;
    if validate_access(&window, &state, &access_token)? != generation {
        return Err("Renderer authority changed while opening worktree".to_string());
    }
    let target = tauri::async_runtime::spawn_blocking(move || {
        verify_inventory(&root_directory, &registered_directory, &target_directory)
    })
    .await
    .map_err(|err| err.to_string())??;
    if validate_access(&window, &state, &access_token)? != generation {
        return Err("Renderer authority changed while opening worktree".to_string());
    }
    window
        .app_handle()
        .opener()
        .open_path(target.to_string_lossy(), None::<&str>)
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        parse_worktree_inventory, require_inventory_membership, validate_registered_directory,
    };
    use std::path::PathBuf;

    #[test]
    fn parses_exact_nul_delimited_worktree_records() {
        let root = if cfg!(windows) { "C:/repo" } else { "/repo" };
        let worktree = if cfg!(windows) {
            "C:/repo/wt"
        } else {
            "/repo/wt"
        };
        let output = format!(
            "worktree {root}\0HEAD abc\0branch refs/heads/main\0\0worktree {worktree}\0HEAD def\0detached\0\0"
        );
        assert_eq!(
            parse_worktree_inventory(output.as_bytes()).unwrap(),
            vec![PathBuf::from(root), PathBuf::from(worktree)]
        );
    }

    #[test]
    fn rejects_relative_control_network_and_device_paths() {
        for value in [
            "relative/path",
            "/bad\0path",
            "/dev/null",
            "C:/repo/../other",
            "C:/repo/NUL.txt",
            "C:/repo/trailing.",
            "//server/share",
            "\\\\server\\share",
            "/\\server\\share",
            "\\/server/share",
            "\\\\?\\C:\\repo",
            "\\\\.\\pipe\\name",
        ] {
            assert!(validate_registered_directory(value).is_err(), "{value}");
        }
    }

    #[test]
    fn requires_exact_root_and_target_inventory_membership() {
        let root = PathBuf::from(if cfg!(windows) { "C:/repo" } else { "/repo" });
        let target = PathBuf::from(if cfg!(windows) {
            "C:/repo/wt"
        } else {
            "/repo/wt"
        });
        assert!(
            require_inventory_membership(&[root.clone(), target.clone()], &root, &target).is_ok()
        );
        assert!(require_inventory_membership(&[root.clone()], &root, &target).is_err());
        assert!(require_inventory_membership(&[target], &root, &root).is_err());
    }
}
