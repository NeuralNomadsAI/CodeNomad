use super::{DefaultMode, Editor, OpenError, Target, WorkspaceTarget, windows_default_mode};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use codenomad_client::git::{GitError, Refusal};
use std::{
    io,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::Weak,
    time::Duration,
};

fn map_checkout_error(error: &codenomad_client::history::Error) -> OpenError {
    if error.downcast_ref::<GitError>() == Some(&GitError::CheckoutUnavailable) {
        OpenError::CheckoutUnavailable
    } else if let Some(refusal) = error.downcast_ref::<Refusal>() {
        match refusal.status {
            403 | 404 => OpenError::CheckoutUnavailable,
            409 => OpenError::WorktreeChanged,
            _ => OpenError::Failed,
        }
    } else {
        OpenError::Failed
    }
}

pub async fn open(
    backend: crate::backend::Backend,
    slug: String,
    directory: String,
    path: String,
    target: Target,
    owner: Weak<()>,
) -> Result<(), OpenError> {
    let checkout = backend
        .workspace_checkout(&slug)
        .await
        .map_err(|error| map_checkout_error(&error))?;
    if !codenomad_client::same_server_path(&checkout, &directory) {
        return Err(OpenError::WorktreeChanged);
    }
    tokio::task::spawn_blocking(move || {
        let selected = resolve(Path::new(&checkout), &path)?;
        if owner.strong_count() == 0 {
            return Ok(());
        }
        launch(&selected, target)
    })
    .await
    .map_err(|_| OpenError::Failed)?
    .map_err(|_| OpenError::Failed)
}

pub async fn open_workspace(
    backend: crate::backend::Backend,
    slug: String,
    expected_root: Option<String>,
    target: WorkspaceTarget,
    owner: Weak<()>,
) -> Result<(), String> {
    let checkout = backend
        .workspace_checkout(&slug)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(expected) = expected_root.as_deref()
        && !codenomad_client::same_server_path(&checkout, expected)
    {
        return Err("Workspace changed".into());
    }
    tokio::task::spawn_blocking(move || {
        let folder = resolve_root(Path::new(&checkout))?;
        if owner.strong_count() == 0 {
            return Ok(());
        }
        launch_workspace(&folder, target)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

fn resolve_root(root: &Path) -> io::Result<PathBuf> {
    if !root.is_absolute() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let canonical = root.canonicalize()?;
    if !canonical.is_dir() {
        return Err(io::ErrorKind::NotADirectory.into());
    }
    Ok(canonical)
}

fn editor_candidates(
    editor: Editor,
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
) -> Vec<PathBuf> {
    let raw = match editor {
        Editor::VsCode => vec![
            local_app_data.map(|path| path.join("Programs/Microsoft VS Code/Code.exe")),
            program_files.map(|path| path.join("Microsoft VS Code/Code.exe")),
        ],
        Editor::Cursor => vec![local_app_data.map(|path| path.join("Programs/cursor/Cursor.exe"))],
        Editor::Zed => vec![local_app_data.map(|path| path.join("Programs/Zed/Zed.exe"))],
        Editor::VsCodium => vec![
            local_app_data.map(|path| path.join("Programs/VSCodium/VSCodium.exe")),
            program_files.map(|path| path.join("VSCodium/VSCodium.exe")),
        ],
    };
    raw.into_iter()
        .flatten()
        .filter(|path| path.is_absolute() && path.is_file())
        .collect()
}

fn launch_workspace(folder: &Path, target: WorkspaceTarget) -> io::Result<()> {
    match target {
        WorkspaceTarget::Folder => launch(folder, Target::Default),
        WorkspaceTarget::Terminal => launch(folder, Target::Terminal),
        WorkspaceTarget::Editor(editor) => {
            let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
            let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
            let candidates =
                editor_candidates(editor, local_app_data.as_deref(), program_files.as_deref());
            let path = launch_path(folder);
            let mut last_error = None;
            for executable in candidates {
                let result = Command::new(&executable)
                    .arg(&path)
                    .current_dir(&path)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();
                match result {
                    Ok(_) => return Ok(()),
                    Err(error) => last_error = Some(error),
                }
            }
            Err(last_error.unwrap_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "No supported application was found",
                )
            }))
        }
    }
}

fn resolve(root: &Path, path: &str) -> io::Result<PathBuf> {
    use std::path::Component::Normal;
    if !root.is_absolute()
        || path.contains(['\\', ':', '\0'])
        || path.split('/').any(|part| matches!(part, "" | "." | ".."))
        || !Path::new(path)
            .components()
            .all(|part| matches!(part, Normal(_)))
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let root = root.canonicalize()?;
    let selected = root.join(path).canonicalize()?;
    if !root.is_dir() || selected == root || !selected.starts_with(&root) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(selected)
}

fn launch_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}").into();
    }
    value.strip_prefix(r"\\?\").unwrap_or(&value).into()
}

fn confirm_chooser_start(mut child: Child) -> io::Result<()> {
    if !chooser_started(|| child.try_wait(), std::thread::sleep)? {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(())
}

// True when the selector already exited successfully; false when it remains open.
fn chooser_started(
    mut status: impl FnMut() -> io::Result<Option<ExitStatus>>,
    mut wait: impl FnMut(Duration),
) -> io::Result<bool> {
    // Match the desktop hosts: report immediate failure without waiting for the chooser to close.
    for attempt in 0..=10 {
        if let Some(status) = status()? {
            return if status.success() {
                Ok(true)
            } else {
                Err(io::Error::other(status.to_string()))
            };
        }
        if attempt < 10 {
            wait(Duration::from_millis(25));
        }
    }
    Ok(false)
}

const OPEN_TARGET_ENV: &str = "CODENOMAD_OPEN_TARGET";
// Constant scripts read the target path from the process environment so no path
// characters (including PowerShell 5.1 typographic quotes) are ever parsed as code.
const POWERSHELL_TERMINAL_SCRIPT: &str = "$p=$env:CODENOMAD_OPEN_TARGET; Remove-Item Env:CODENOMAD_OPEN_TARGET -ErrorAction SilentlyContinue; Set-Location -LiteralPath $p";
const POWERSHELL_EDIT_SCRIPT: &str = "$ErrorActionPreference='Stop'; $p=$env:CODENOMAD_OPEN_TARGET; Remove-Item Env:CODENOMAD_OPEN_TARGET -ErrorAction SilentlyContinue; Start-Process -FilePath $p -Verb Edit";

fn encode_powershell(script: &str) -> String {
    STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    )
}

fn launch(selected: &Path, target: Target) -> io::Result<()> {
    let folder = selected.is_dir();
    let path = launch_path(selected);
    let cwd = if folder {
        path.as_path()
    } else {
        path.parent().ok_or(io::ErrorKind::InvalidInput)?
    };
    let system =
        std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
    let powershell = system.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let spawn = |command: &mut Command| {
        command
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };
    let start = |command: &mut Command| spawn(command).map(drop);
    let hidden = |command: &mut Command| {
        command
            .creation_flags(0x0800_0000)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err(io::Error::other(status.to_string()))
                }
            })
    };
    let explorer = || Command::new(system.join("explorer.exe"));
    match target {
        Target::Reveal => start(explorer().raw_arg(format!("/select,\"{}\"", path.display()))),
        Target::Terminal if folder => hidden(
            Command::new(system.join("System32/cmd.exe"))
                .env(OPEN_TARGET_ENV, &path)
                .args(["/D", "/C", "start", ""])
                .arg(&powershell)
                .args(["-NoExit", "-EncodedCommand"])
                .arg(encode_powershell(POWERSHELL_TERMINAL_SCRIPT)),
        ),
        Target::Terminal => Err(io::ErrorKind::NotADirectory.into()),
        Target::Default => {
            let mode = windows_default_mode(&selected.to_string_lossy());
            if folder || mode == DefaultMode::Open {
                return start(explorer().arg(&path));
            }
            if mode == DefaultMode::Edit
                && hidden(
                    Command::new(&powershell)
                        .env(OPEN_TARGET_ENV, &path)
                        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
                        .arg(encode_powershell(POWERSHELL_EDIT_SCRIPT)),
                )
                .is_ok()
            {
                return Ok(());
            }
            confirm_chooser_start(spawn(
                Command::new(system.join("System32/rundll32.exe"))
                    .arg("shell32.dll,OpenAs_RunDLL")
                    .arg(&path),
            )?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_existing_relative_entries() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .canonicalize()
            .unwrap();
        assert_eq!(
            resolve(&root, "Cargo.toml").unwrap(),
            root.join("Cargo.toml")
        );
        for path in [
            "../Cargo.toml",
            "/Cargo.toml",
            "a\\b",
            "Cargo.toml:stream",
            "missing",
            ".",
        ] {
            assert!(resolve(&root, path).is_err(), "{path}");
        }
        for (path, expected) in [
            ("docs/ÉTÉ.TXT", DefaultMode::Open),
            (r"docs.txt\README", DefaultMode::Choose),
            ("script.ps1", DefaultMode::Edit),
            ("setup.exe", DefaultMode::Choose),
            (".txt", DefaultMode::Choose),
        ] {
            assert_eq!(windows_default_mode(path), expected);
        }
    }

    #[test]
    fn chooser_checks_the_exit_status_at_the_startup_deadline() {
        use std::{cell::Cell, os::windows::process::ExitStatusExt};
        for exit in [None, Some(0), Some(7)] {
            let elapsed = Cell::new(Duration::ZERO);
            let started = chooser_started(
                || {
                    Ok(exit
                        .filter(|_| elapsed.get() >= Duration::from_millis(250))
                        .map(ExitStatus::from_raw))
                },
                |wait| elapsed.set(elapsed.get() + wait),
            );
            assert_eq!(elapsed.get(), Duration::from_millis(250));
            match exit {
                Some(7) => assert!(started.is_err()),
                Some(0) => assert!(started.unwrap()),
                _ => assert!(!started.unwrap()),
            }
        }
    }

    #[test]
    fn checkout_refusals_map_to_localized_open_errors_without_raw_server_text() {
        let not_found: codenomad_client::history::Error =
            Refusal::new(404, None, Some("Workspace not found".into())).into();
        let forbidden: codenomad_client::history::Error =
            Refusal::new(403, None, Some("Access denied".into())).into();
        let conflict: codenomad_client::history::Error =
            Refusal::new(409, None, Some("Worktree deletion is in progress".into())).into();
        let server: codenomad_client::history::Error =
            Refusal::new(500, None, Some("Internal server error".into())).into();
        let transport: codenomad_client::history::Error =
            "reqwest: error sending request for url (http://127.0.0.1:9999)".into();

        assert_eq!(
            map_checkout_error(&not_found),
            OpenError::CheckoutUnavailable
        );
        assert_eq!(
            map_checkout_error(&forbidden),
            OpenError::CheckoutUnavailable
        );
        assert_eq!(map_checkout_error(&conflict), OpenError::WorktreeChanged);
        assert_eq!(map_checkout_error(&server), OpenError::Failed);
        assert_eq!(map_checkout_error(&transport), OpenError::Failed);
        assert_eq!(
            map_checkout_error(&GitError::CheckoutUnavailable.into()),
            OpenError::CheckoutUnavailable
        );
        let (en_unavailable, en_changed, en_failed) = crate::strings::with_locale("en", || {
            (
                crate::strings::t("gitPanel.error.checkoutUnavailable"),
                crate::strings::t("gitPanel.error.worktreeChanged"),
                crate::strings::t("rune.failed"),
            )
        });
        for lang in ["en", "fr"] {
            crate::strings::with_locale(lang, || {
                let unavailable = map_checkout_error(&not_found).localized(lang);
                let changed = map_checkout_error(&conflict).localized(lang);
                let failed = map_checkout_error(&server).localized(lang);
                assert_eq!(
                    unavailable,
                    crate::strings::t("gitPanel.error.checkoutUnavailable")
                );
                assert_eq!(changed, crate::strings::t("gitPanel.error.worktreeChanged"));
                assert_eq!(failed, crate::strings::t("rune.failed"));
                if lang == "fr" {
                    assert_ne!(unavailable, en_unavailable);
                    assert_ne!(changed, en_changed);
                    assert_ne!(failed, en_failed);
                }
            });
        }
    }

    #[test]
    fn resolve_root_accepts_only_existing_absolute_directories() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .canonicalize()
            .unwrap();
        assert_eq!(resolve_root(&root).unwrap(), root);
        assert!(resolve_root(Path::new("relative/dir")).is_err());
        assert!(resolve_root(&root.join("Cargo.toml")).is_err());
        assert!(resolve_root(&root.join("nonexistent-dir-xyz")).is_err());
    }

    #[test]
    fn editor_candidates_discovers_only_existing_absolute_executables() {
        let base = std::env::temp_dir().join(format!(
            "codenomad-editor-candidates-{}",
            std::process::id()
        ));
        let local = base.join("local");
        let prog = base.join("prog");
        let vscode_local = local.join("Programs/Microsoft VS Code/Code.exe");
        let vscode_prog = prog.join("Microsoft VS Code/Code.exe");
        let zed_local = local.join("Programs/Zed/Zed.exe");
        std::fs::create_dir_all(vscode_local.parent().unwrap()).unwrap();
        std::fs::create_dir_all(vscode_prog.parent().unwrap()).unwrap();
        std::fs::create_dir_all(zed_local.parent().unwrap()).unwrap();
        std::fs::write(&vscode_local, b"").unwrap();
        std::fs::write(&vscode_prog, b"").unwrap();
        std::fs::write(&zed_local, b"").unwrap();

        assert_eq!(
            editor_candidates(Editor::VsCode, Some(&local), Some(&prog)),
            vec![vscode_local, vscode_prog]
        );
        assert_eq!(
            editor_candidates(Editor::Zed, Some(&local), Some(&prog)),
            vec![zed_local]
        );
        assert!(editor_candidates(Editor::Cursor, Some(&local), Some(&prog)).is_empty());
        assert!(editor_candidates(Editor::VsCodium, Some(&local), Some(&prog)).is_empty());
        assert!(
            editor_candidates(Editor::VsCode, Some(Path::new("relative/local")), None).is_empty()
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn powershell_scripts_pass_target_as_env_data_without_interpolation() {
        for script in [POWERSHELL_TERMINAL_SCRIPT, POWERSHELL_EDIT_SCRIPT] {
            assert!(script.contains("$env:CODENOMAD_OPEN_TARGET"));
            assert!(!script.contains('\u{2019}'));
            let decoded_bytes = STANDARD.decode(encode_powershell(script)).unwrap();
            let utf16: Vec<u16> = decoded_bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            assert_eq!(String::from_utf16(&utf16).unwrap(), script);
        }
    }
}
