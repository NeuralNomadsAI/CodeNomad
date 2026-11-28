use crate::{cli_manager::CliProcessManager, AppState};
use tauri::Manager;
#[cfg(windows)]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::de::DeserializeOwned;
use serde::Deserialize;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::State;

#[derive(Clone)]
struct LaunchCandidate {
    command: PathBuf,
    args: Vec<String>,
    pass_path: bool,
    wait_for_exit: bool,
    verify_start: bool,
}

#[derive(Deserialize)]
struct WorkspaceDescriptor {
    path: String,
}

#[derive(Deserialize)]
struct WorktreeDescriptor {
    slug: String,
    directory: String,
}

#[derive(Deserialize)]
struct WorktreeListResponse {
    worktrees: Vec<WorktreeDescriptor>,
}

fn get_local_json<T: DeserializeOwned>(
    manager: &CliProcessManager,
    path: &str,
) -> Result<T, String> {
    let config = manager
        .local_cli_access()
        .ok_or("Local CodeNomad server is unavailable")?;
    let url = format!("{}{}", config.base_url.trim_end_matches('/'), path);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.get(url);
    request = request.header(
        reqwest::header::COOKIE,
        format!("{}={}", config.cookie_name, config.session_cookie),
    );
    request
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| error.to_string())?
        .json::<T>()
        .map_err(|error| error.to_string())
}

fn resolve_active_workspace_folder(
    manager: &CliProcessManager,
    instance_id: &str,
    worktree_slug: &str,
) -> Result<String, String> {
    if instance_id.is_empty()
        || !instance_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid workspace id".into());
    }
    let workspace: WorkspaceDescriptor =
        get_local_json(manager, &format!("/api/workspaces/{instance_id}"))?;
    if worktree_slug == "root" {
        return Ok(workspace.path);
    }
    let payload: WorktreeListResponse =
        get_local_json(manager, &format!("/api/workspaces/{instance_id}/worktrees"))?;
    payload
        .worktrees
        .into_iter()
        .find(|worktree| worktree.slug == worktree_slug)
        .map(|worktree| worktree.directory)
        .ok_or_else(|| "Selected worktree is unavailable".into())
}

fn editor_candidates(editor: &str) -> Result<Vec<LaunchCandidate>, String> {
    #[cfg(target_os = "macos")]
    {
        let name = match editor {
            "vscode" => "Visual Studio Code",
            "cursor" => "Cursor",
            "zed" => "Zed",
            "vscodium" => "VSCodium",
            _ => return Err("Unsupported editor".into()),
        };
        return Ok(vec![LaunchCandidate {
            command: "/usr/bin/open".into(),
            args: vec!["-a".into(), name.into()],
            pass_path: true,
            wait_for_exit: true,
            verify_start: false,
        }]);
    }

    #[cfg(windows)]
    {
        let paths: Vec<PathBuf> = match editor {
            "vscode" => vec![
                std::env::var_os("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .map(|path| path.join("Programs/Microsoft VS Code/Code.exe")),
                std::env::var_os("ProgramFiles")
                    .map(PathBuf::from)
                    .map(|path| path.join("Microsoft VS Code/Code.exe")),
            ],
            "cursor" => vec![std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|path| path.join("Programs/cursor/Cursor.exe"))],
            "zed" => vec![std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|path| path.join("Programs/Zed/Zed.exe"))],
            "vscodium" => vec![
                std::env::var_os("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .map(|path| path.join("Programs/VSCodium/VSCodium.exe")),
                std::env::var_os("ProgramFiles")
                    .map(PathBuf::from)
                    .map(|path| path.join("VSCodium/VSCodium.exe")),
            ],
            _ => return Err("Unsupported editor".into()),
        }
        .into_iter()
        .flatten()
        .filter(|path| !path.is_absolute() || path.is_file())
        .collect();
        return Ok(paths
            .into_iter()
            .map(|command| LaunchCandidate {
                command,
                args: Vec::new(),
                pass_path: true,
                wait_for_exit: false,
                verify_start: false,
            })
            .collect());
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let command = match editor {
            "vscode" => "code",
            "cursor" => "cursor",
            "zed" => "zed",
            "vscodium" => "codium",
            _ => return Err("Unsupported editor".into()),
        };
        Ok(vec![LaunchCandidate {
            command: command.into(),
            args: Vec::new(),
            pass_path: true,
            wait_for_exit: false,
            verify_start: true,
        }])
    }
}

fn terminal_candidates(folder: &Path) -> Vec<LaunchCandidate> {
    #[cfg(target_os = "macos")]
    return vec![LaunchCandidate {
        command: "/usr/bin/open".into(),
        args: vec!["-a".into(), "Terminal".into()],
        pass_path: true,
        wait_for_exit: true,
        verify_start: false,
    }];

    #[cfg(windows)]
    {
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| r"C:\Windows".into());
        let command = std::env::var_os("ComSpec")
            .map(PathBuf::from)
            .unwrap_or_else(|| system_root.join("System32/cmd.exe"));
        let powershell = system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let escaped = folder.to_string_lossy().replace('\'', "''");
        let script = format!("Set-Location -LiteralPath '{escaped}'");
        return vec![LaunchCandidate {
            command,
            args: vec![
                "/D".into(),
                "/C".into(),
                "start".into(),
                "".into(),
                powershell.to_string_lossy().into_owned(),
                "-NoExit".into(),
                "-EncodedCommand".into(),
                encode_powershell_script(&script),
            ],
            pass_path: false,
            wait_for_exit: true,
            verify_start: false,
        }];
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let configured = std::env::var("TERMINAL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .into_iter();
        configured
            .chain(
                [
                    "xdg-terminal-exec",
                    "x-terminal-emulator",
                    "gnome-terminal",
                    "konsole",
                    "kitty",
                    "alacritty",
                    "wezterm",
                ]
                .map(str::to_string),
            )
            .map(|command| LaunchCandidate {
                command: command.into(),
                args: Vec::new(),
                pass_path: false,
                wait_for_exit: false,
                verify_start: true,
            })
            .collect()
    }
}

#[cfg(windows)]
fn encode_powershell_script(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    BASE64.encode(bytes)
}

fn spawn_candidate(
    candidate: &LaunchCandidate,
    selected_path: &Path,
    cwd: &Path,
) -> std::io::Result<()> {
    let mut command = Command::new(&candidate.command);
    command.args(&candidate.args);
    // The editor outlives this AppImage's mount.
    #[cfg(target_os = "linux")]
    crate::appimage_environment::use_host_environment(&mut command);
    if candidate.pass_path {
        command.arg(selected_path);
    }
    let mut child = command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    if candidate.wait_for_exit {
        let status = child.wait()?;
        if !status.success() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("{} exited with {status}", candidate.command.display()),
            ));
        }
    } else if candidate.verify_start {
        for _ in 0..10 {
            if let Some(status) = child.try_wait()? {
                if status.success() {
                    return Ok(());
                }
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("{} exited with {status}", candidate.command.display()),
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(())
}

fn launch_first(
    candidates: Vec<LaunchCandidate>,
    selected_path: &Path,
    cwd: &Path,
) -> Result<(), String> {
    let mut last_error = None;
    for candidate in candidates {
        match spawn_candidate(&candidate, selected_path, cwd) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error
        .map(|error| error.to_string())
        .unwrap_or_else(|| "No supported application was found".into()))
}

fn resolve_workspace_path(
    workspace_folder: &str,
    path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = PathBuf::from(workspace_folder)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("Workspace folder does not exist".into());
    }
    let selected = root
        .join(path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !selected.starts_with(&root) {
        return Err("Selected path is outside the workspace".into());
    }
    Ok((root, selected))
}

#[cfg(windows)]
fn platform_launch_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}").into();
    }
    value.strip_prefix(r"\\?\").unwrap_or(&value).into()
}

#[derive(Debug, PartialEq, Eq)]
enum DefaultOpenMode {
    Open,
    Edit,
    Choose,
}

fn default_open_mode(path: &Path) -> Result<DefaultOpenMode, String> {
    #[cfg(not(windows))]
    const BLOCKED: &[&str] = &[
        "appimage",
        "application",
        "chm",
        "com",
        "cpl",
        "desktop",
        "exe",
        "fileloc",
        "inetloc",
        "jar",
        "lnk",
        "msi",
        "msp",
        "pif",
        "scr",
        "terminal",
        "url",
        "webloc",
    ];
    #[cfg(windows)]
    const SAFE_WINDOWS_OPEN: &[&str] = &[
        "7z", "avi", "bmp", "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "dart", "diff",
        "docx", "env", "flac", "fs", "fsx", "gif", "go", "gz", "h", "hpp", "htm", "html", "ini",
        "java", "jpeg", "jpg", "json", "jsonc", "jsx", "kt", "kts", "less", "lock", "log", "lua",
        "md", "markdown", "mkv", "mov", "mp3", "mp4", "ogg", "patch", "pdf", "png", "pptx", "r",
        "rar", "rmd", "rs", "scss", "sql", "svg", "svelte", "swift", "tar", "toml", "ts", "tsx",
        "txt", "vue", "wav", "webm", "webp", "xlsx", "xml", "yaml", "yml", "zip",
    ];
    #[cfg(windows)]
    const WINDOWS_EDIT: &[&str] = &[
        "bat", "cmd", "js", "jse", "pl", "ps1", "psd1", "psm1", "py", "pyw", "rb", "reg", "vbe",
        "vbs", "wsf", "wsh",
    ];
    let metadata = path.metadata().map_err(|error| error.to_string())?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if metadata.is_dir() {
        if cfg!(target_os = "macos") && (extension == "app" || extension == "workflow") {
            return Err("Application bundles cannot be opened externally".into());
        }
        return Ok(DefaultOpenMode::Open);
    }
    #[cfg(windows)]
    {
        return Ok(if SAFE_WINDOWS_OPEN.contains(&extension.as_str()) {
            DefaultOpenMode::Open
        } else if WINDOWS_EDIT.contains(&extension.as_str()) {
            DefaultOpenMode::Edit
        } else {
            DefaultOpenMode::Choose
        });
    }

    #[cfg(unix)]
    {
        if BLOCKED.contains(&extension.as_str()) {
            return Err("Executable files cannot be opened externally".into());
        }
        if metadata.is_file() && metadata.permissions().mode() & 0o111 != 0 {
            return Err("Executable files cannot be opened externally".into());
        }
        return Ok(DefaultOpenMode::Open);
    }

    #[cfg(not(any(windows, unix)))]
    Ok(DefaultOpenMode::Open)
}

#[cfg(not(windows))]
fn platform_launch_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn open_default(selected: &Path, launch_path: &Path, launch_cwd: &Path) -> Result<(), String> {
    let mode = default_open_mode(selected)?;
    #[cfg(windows)]
    if mode != DefaultOpenMode::Open {
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| r"C:\Windows".into());
        let powershell = system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let rundll32 = system_root.join("System32/rundll32.exe");
        let escaped = launch_path.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$ErrorActionPreference='Stop'; Start-Process -FilePath '{escaped}' -Verb Edit"
        );
        let mut candidates = Vec::new();
        if mode == DefaultOpenMode::Edit {
            candidates.push(LaunchCandidate {
                command: powershell,
                args: vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-EncodedCommand".into(),
                    encode_powershell_script(&script),
                ],
                pass_path: false,
                wait_for_exit: true,
                verify_start: false,
            });
        }
        candidates.push(LaunchCandidate {
            command: rundll32,
            args: vec!["shell32.dll,OpenAs_RunDLL".into()],
            pass_path: true,
            wait_for_exit: false,
            verify_start: true,
        });
        return launch_first(candidates, launch_path, launch_cwd);
    }
    #[cfg(target_os = "macos")]
    let candidates = vec![LaunchCandidate {
        command: "/usr/bin/open".into(),
        args: Vec::new(),
        pass_path: true,
        wait_for_exit: true,
        verify_start: false,
    }];
    #[cfg(windows)]
    let candidates = vec![LaunchCandidate {
        command: "explorer.exe".into(),
        args: Vec::new(),
        pass_path: true,
        wait_for_exit: false,
        verify_start: false,
    }];
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let candidates = vec![
        LaunchCandidate {
            command: "xdg-open".into(),
            args: Vec::new(),
            pass_path: true,
            wait_for_exit: false,
            verify_start: true,
        },
        LaunchCandidate {
            command: "gio".into(),
            args: vec!["open".into()],
            pass_path: true,
            wait_for_exit: false,
            verify_start: true,
        },
    ];
    launch_first(candidates, launch_path, launch_cwd)
}

fn open_workspace_target_impl(
    manager: &CliProcessManager,
    target: String,
    instance_id: String,
    worktree_slug: String,
    path: Option<String>,
    editor: Option<String>,
) -> Result<(), String> {
    let workspace_folder = resolve_active_workspace_folder(manager, &instance_id, &worktree_slug)?;
    let (root, selected) =
        resolve_workspace_path(&workspace_folder, path.as_deref().unwrap_or("."))?;
    let cwd = if selected.is_dir() {
        selected.clone()
    } else {
        selected.parent().unwrap_or(root.as_path()).to_path_buf()
    };
    let launch_path = platform_launch_path(&selected);
    let launch_cwd = platform_launch_path(&cwd);

    match target.as_str() {
        "default" => open_default(&selected, &launch_path, &launch_cwd),
        "reveal" => {
            #[cfg(target_os = "macos")]
            let candidates = vec![LaunchCandidate {
                command: "/usr/bin/open".into(),
                args: vec!["-R".into()],
                pass_path: true,
                wait_for_exit: true,
                verify_start: false,
            }];
            #[cfg(windows)]
            let candidates = vec![LaunchCandidate {
                command: "explorer.exe".into(),
                args: vec![format!("/select,{}", launch_path.display())],
                pass_path: false,
                wait_for_exit: false,
                verify_start: false,
            }];
            #[cfg(all(not(windows), not(target_os = "macos")))]
            let candidates = vec![
                LaunchCandidate {
                    command: "xdg-open".into(),
                    args: Vec::new(),
                    pass_path: true,
                    wait_for_exit: false,
                    verify_start: true,
                },
                LaunchCandidate {
                    command: "gio".into(),
                    args: vec!["open".into()],
                    pass_path: true,
                    wait_for_exit: false,
                    verify_start: true,
                },
            ];
            let reveal_path = if cfg!(all(not(windows), not(target_os = "macos"))) {
                launch_cwd.as_path()
            } else {
                launch_path.as_path()
            };
            launch_first(candidates, reveal_path, &launch_cwd)
        }
        "terminal" => {
            if !selected.is_dir() {
                return Err("Terminal target is not a folder".into());
            }
            launch_first(terminal_candidates(&launch_path), &launch_path, &launch_cwd)
        }
        "editor" => launch_first(
            editor_candidates(editor.as_deref().ok_or("Editor is required")?)?,
            &launch_path,
            &launch_cwd,
        ),
        _ => Err("Unsupported workspace open target".into()),
    }
}

fn require_local_window(webview: &tauri::Webview, state: &AppState) -> Result<(), String> {
    crate::identity::local_window_id(webview.label())?;
    let config = state
        .manager
        .local_cli_access()
        .ok_or("Local CodeNomad server is unavailable")?;
    let expected = url::Url::parse(&config.base_url).map_err(|error| error.to_string())?;
    let current = webview.url().map_err(|error| error.to_string())?;
    if current.origin() != expected.origin() {
        return Err("Workspace open requests require the local CodeNomad origin".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn open_workspace_target(
    webview: tauri::Webview,
    state: State<'_, AppState>,
    target: String,
    instance_id: String,
    worktree_slug: String,
    path: Option<String>,
    editor: Option<String>,
) -> Result<(), String> {
    let manager = state.manager.clone();
    // The check reads the WebView URL, which waits on the native thread: keep it off the executor.
    tauri::async_runtime::spawn_blocking(move || {
        require_local_window(&webview, &webview.state::<AppState>())?;
        open_workspace_target_impl(&manager, target, instance_id, worktree_slug, path, editor)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Opens an absolute local `path` with the system: a folder in the file
/// manager, a file with its default application under `default_open_mode`'s
/// protections. `missing` for a missing path, and `kept`, opening nothing,
/// when it leaves the path to the caller (`keep`): text files (`text`), every
/// file (`files`), and paths off the local disks or naming special files.
/// Under `none` those are errors, as are inaccessible paths and failed
/// openings; otherwise `opened`.
#[tauri::command]
pub async fn open_local_path(
    webview: tauri::Webview,
    path: String,
    keep: String,
) -> Result<&'static str, String> {
    tauri::async_runtime::spawn_blocking(move || {
        require_local_window(&webview, &webview.state::<AppState>())?;
        open_local_path_impl(&path, &keep)
    })
    .await
        .map_err(|error| error.to_string())?
}

/// An absolute path on a local disk: a drive path on Windows, never a UNC or
/// device path, which reach the network or devices.
fn is_local_disk_path(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut components = path.components();
        matches!(components.next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
            && matches!(components.next(), Some(Component::RootDir))
    }
    #[cfg(not(windows))]
    {
        path.is_absolute() && !path.to_string_lossy().starts_with("//")
    }
}

/// Whether a file's first bytes read as text, as the file preview decides: no
/// NUL byte and valid UTF-8 (a character cut at a full sample's end still counts).
fn looks_like_text(path: &Path) -> std::io::Result<bool> {
    use std::io::Read;
    let mut sample = [0u8; 8192];
    let mut file = std::fs::File::open(path)?;
    let mut length = 0;
    while length < sample.len() {
        match file.read(&mut sample[length..])? {
            0 => break,
            read => length += read,
        }
    }
    let bytes = &sample[..length];
    if bytes.contains(&0) {
        return Ok(false);
    }
    Ok(match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(error) => error.error_len().is_none() && length == sample.len(),
    })
}

fn open_local_path_impl(path: &str, keep: &str) -> Result<&'static str, String> {
    if !matches!(keep, "none" | "text" | "files") {
        return Err("Invalid local path request".into());
    }
    let path = Path::new(path);
    // Checked before any filesystem access: a UNC path would reach the network.
    if !is_local_disk_path(path) {
        if keep != "none" {
            return Ok("kept");
        }
        return Err("Only absolute paths on a local disk can be opened".into());
    }
    let selected = match path.canonicalize() {
        Ok(selected) => selected,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok("missing"),
        Err(error) => return Err(error.to_string()),
    };
    let metadata = std::fs::metadata(&selected).map_err(|error| error.to_string())?;
    let folder = metadata.is_dir();
    // A FIFO or device is neither shown nor read: reading one can block forever.
    if !folder && !metadata.is_file() {
        if keep != "none" {
            return Ok("kept");
        }
        return Err("Only files and folders can be opened".into());
    }
    // The file reader shows text up to the server's 5 MiB read limit.
    let text = !folder
        && keep == "text"
        && metadata.len() <= 5 * 1024 * 1024
        && looks_like_text(&selected).map_err(|error| error.to_string())?;
    if !folder && (keep == "files" || text) {
        return Ok("kept");
    }
    let cwd = if folder {
        selected.clone()
    } else {
        selected.parent().unwrap_or(&selected).to_path_buf()
    };
    open_default(
        &selected,
        &platform_launch_path(&selected),
        &platform_launch_path(&cwd),
    )?;
    Ok("opened")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_outside_the_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let result = resolve_workspace_path(
            workspace.path().to_str().unwrap(),
            outside.path().to_str().unwrap(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn unless_text_leaves_text_and_missing_paths_to_the_caller() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("notes.txt"), "héllo").unwrap();
        let mut long = "a".repeat(8191).into_bytes();
        long.extend_from_slice("é".as_bytes());
        std::fs::write(workspace.path().join("long.txt"), long).unwrap();
        std::fs::write(workspace.path().join("clip.mp4"), [0, 0, 0, 24, 102, 116]).unwrap();
        assert!(looks_like_text(&workspace.path().join("notes.txt")).unwrap());
        assert!(looks_like_text(&workspace.path().join("long.txt")).unwrap());
        assert!(!looks_like_text(&workspace.path().join("clip.mp4")).unwrap());
        assert!(looks_like_text(&workspace.path().join("missing")).is_err());
        for (name, result) in [("notes.txt", "kept"), ("missing", "missing")] {
            let path = workspace.path().join(name);
            assert_eq!(
                open_local_path_impl(path.to_str().unwrap(), "text"),
                Ok(result),
                "{name}"
            );
        }
        assert_eq!(
            open_local_path_impl(workspace.path().join("missing").to_str().unwrap(), "none"),
            Ok("missing")
        );
        assert_eq!(open_local_path_impl(r"\\host\share\x", "text"), Ok("kept"));
        assert!(open_local_path_impl("relative", "none").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn special_files_are_never_read_or_opened() {
        let workspace = tempfile::tempdir().unwrap();
        let fifo = workspace.path().join("pipe");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let fifo = fifo.to_str().unwrap();
        assert_eq!(open_local_path_impl(fifo, "text"), Ok("kept"));
        assert!(open_local_path_impl(fifo, "none").is_err());
    }

    #[test]
    fn local_paths_exclude_network_shares_and_devices() {
        assert!(!is_local_disk_path(Path::new("relative")));
        #[cfg(windows)]
        {
            assert!(is_local_disk_path(Path::new(r"C:\x")));
            for path in [
                r"\\host\share\x",
                r"/\host\share\x",
                "//host/share",
                r"\\?\C:\x",
                r"\\.\pipe\x",
                r"\x",
                "C:x",
            ] {
                assert!(!is_local_disk_path(Path::new(path)), "{path}");
            }
        }
        #[cfg(not(windows))]
        {
            assert!(is_local_disk_path(Path::new("/home/x")));
            assert!(!is_local_disk_path(Path::new("//host/x")));
        }
    }
    #[test]
    fn edits_windows_scripts_and_rejects_executable_default_open_targets() {
        let workspace = tempfile::tempdir().unwrap();
        let script = workspace.path().join("run.cmd");
        std::fs::write(&script, "echo unsafe").unwrap();
        #[cfg(windows)]
        assert_eq!(default_open_mode(&script).unwrap(), DefaultOpenMode::Edit);
        let document = workspace.path().join("notes.txt");
        std::fs::write(&document, "safe").unwrap();
        #[cfg(windows)]
        assert_eq!(default_open_mode(&document).unwrap(), DefaultOpenMode::Open);
        let executable = workspace.path().join("run.exe");
        std::fs::write(&executable, "unsafe").unwrap();
        #[cfg(windows)]
        assert_eq!(
            default_open_mode(&executable).unwrap(),
            DefaultOpenMode::Choose
        );
        #[cfg(unix)]
        assert!(default_open_mode(&executable).is_err());
    }
}
