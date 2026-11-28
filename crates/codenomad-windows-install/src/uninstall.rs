//! `codenomad-rune.exe --uninstall [--quiet]`: the installed application removes itself, as its
//! Apps & features entry asks. It is its own uninstaller, so an update never leaves a stale one.
//!
//! It asks first unless `--quiet`, closes the copies running from the install, removes the
//! shortcuts, the entry and the notification identities, then leaves the install folder to a
//! command that deletes it once this process has exited: a running program cannot delete its own
//! folder. Only the folder the entry names is ever deleted, and only when it can be an install
//! folder (`root::check_installed`).
//!
//! The settings and conversations stay: the Tauri application reads the same ones.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use windows::Win32::UI::WindowsAndMessaging::{
    IDYES, MB_ICONERROR, MB_ICONQUESTION, MB_YESNO, MESSAGEBOX_STYLE, MessageBoxW,
};
use windows::core::HSTRING;

use crate::{Product, installed_root, root, same_path};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// How long a running copy has to close on its own before it is ended.
const CLOSE_GRACE: Duration = Duration::from_secs(10);

/// Uninstalls and exits when this run is the uninstaller: 0 once removed, 1 when it could not,
/// 2 when the person declined. Call it first in `main`, before any window or server.
pub fn run_if_asked(p: &Product) {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("--uninstall") {
        return;
    }
    let quiet = args.iter().any(|arg| arg == "--quiet");
    let Some(root) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    else {
        std::process::exit(1);
    };
    // Refused before the question: a copy that is not the install has nothing to ask about.
    let outcome = check(p, &root).and_then(|()| {
        if !quiet && !ask(p, MB_YESNO | MB_ICONQUESTION, &question(p, &root)) {
            return Ok(2);
        }
        remove(p, &root).map(|()| 0)
    });
    let code = outcome.unwrap_or_else(|why| {
        if !quiet {
            let text = format!("{} was not uninstalled: {why}.", p.name);
            ask(p, MB_ICONERROR, &text);
        }
        1
    });
    std::process::exit(code);
}
fn question(p: &Product, root: &Path) -> String {
    format!(
        "Uninstall {} from {}?\n\nYour settings and conversations are kept.",
        p.name,
        root.display()
    )
}

fn ask(p: &Product, style: MESSAGEBOX_STYLE, text: &str) -> bool {
    // SAFETY: both strings outlive the modal call.
    unsafe { MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(&p.name), style) == IDYES }
}

fn check(p: &Product, root: &Path) -> Result<(), String> {
    if !installed_root(p).is_some_and(|r| same_path(&r, root)) {
        return Err("this copy was not installed by its setup".into());
    }
    // The entry is the user's to write: what it names must still be an install folder.
    root::check_installed(root).map_err(|why| format!("its folder cannot be removed ({why})"))
}

fn remove(p: &Product, root: &Path) -> Result<(), String> {
    if !crate::close_running(root, CLOSE_GRACE) {
        return Err("a running copy did not close".into());
    }
    crate::unregister(p, root);
    for left in setup_folders(root) {
        crate::remove_dir(&left);
    }
    remove_after_exit(root).map_err(|e| format!("the files could not be removed ({e})"))
}

/// The setup's folders beside the install (`.<name>.setup-*`, `.<name>.old-*`), which an
/// interrupted install leaves, and no other sibling.
fn setup_folders(root: &Path) -> Vec<PathBuf> {
    let (Some(name), Some(parent)) = (root.file_name(), root.parent()) else {
        return Vec::new();
    };
    let prefix = format!(".{}.", name.to_string_lossy());
    let ours = |file: &str| {
        file.strip_prefix(&prefix)
            .is_some_and(|rest| rest.starts_with("setup-") || rest.starts_with("old-"))
    };
    std::fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| ours(&e.file_name().to_string_lossy()) && !root::is_link(&e.path()))
        .map(|e| e.path())
        .collect()
}

/// Starts a command that deletes `root` once nothing holds it, trying for a minute and stopping
/// as soon as it is gone, so a folder installed there afterwards stays. The path reaches
/// `cmd.exe` through the environment, read with delayed expansion after the line is parsed, so
/// no character in a folder's name can run a command.
///
/// `CREATE_NO_WINDOW` alone: with `DETACHED_PROCESS` Windows ignores it, and each `ping` the
/// command starts would open a console window of its own.
pub(crate) fn remove_after_exit(root: &Path) -> std::io::Result<()> {
    let system = std::env::var_os("SystemRoot")
        .map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from)
        .join("System32");
    Command::new(system.join("cmd.exe"))
        .args(["/d", "/v:on", "/c"])
        .raw_arg(
            "for /l %i in (1,1,30) do @(rd /s /q \"!CODENOMAD_UNINSTALL_ROOT!\" 2>nul \
             & if not exist \"!CODENOMAD_UNINSTALL_ROOT!\" (exit) else (ping -n 3 127.0.0.1 >nul))",
        )
        .env("CODENOMAD_UNINSTALL_ROOT", root)
        .current_dir(&system)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(drop)
}
