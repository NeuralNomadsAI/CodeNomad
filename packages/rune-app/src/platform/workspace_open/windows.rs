use super::{DefaultMode, OpenError, Target, windows_default_mode};
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

pub async fn open(
    backend: crate::backend::Backend,
    slug: String,
    directory: String,
    path: String,
    target: Target,
    owner: Weak<()>,
) -> Result<(), OpenError> {
    let checkout = backend.workspace_checkout(&slug).await.map_err(|error| {
        if error.downcast_ref::<GitError>() == Some(&GitError::CheckoutUnavailable) {
            OpenError::CheckoutUnavailable
        } else if let Some(message) = error.downcast_ref::<Refusal>().and_then(Refusal::message) {
            OpenError::Server(message.to_owned())
        } else {
            OpenError::Failed
        }
    })?;
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
    let encoded = |script: String| {
        STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        )
    };
    let literal = || path.to_string_lossy().replace('\'', "''");
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
                .args(["/D", "/C", "start", ""])
                .arg(&powershell)
                .args(["-NoExit", "-EncodedCommand"])
                .arg(encoded(format!(
                    "Set-Location -LiteralPath '{}'",
                    literal()
                ))),
        ),
        Target::Terminal => Err(io::ErrorKind::NotADirectory.into()),
        Target::Default => {
            let mode = windows_default_mode(&selected.to_string_lossy());
            if folder || mode == DefaultMode::Open {
                return start(explorer().arg(&path));
            }
            if mode == DefaultMode::Edit
                && hidden(Command::new(&powershell).args(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
                    .arg(encoded(format!("$ErrorActionPreference='Stop'; Start-Process -FilePath '{}' -Verb Edit", literal())))).is_ok()
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
}
