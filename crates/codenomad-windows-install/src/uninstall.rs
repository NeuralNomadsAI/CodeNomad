//! `codenomad-rune.exe --uninstall [--quiet]`: the installed application removes itself, as its
//! Apps & features entry asks. It is its own uninstaller, so an update never leaves a stale one.
//!
//! It asks first unless `--quiet`, closes the copies running from the install, removes the
//! shortcuts, the entry and the notification identities, then leaves the install folder to a
//! command that deletes it once this process has exited: a running program cannot delete its own
//! folder. Only the folder the entry names is ever deleted, and only when it can be an install
//! folder ([`check_root`]).
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

use crate::{EXE, Product, folders, installed_root, same_path};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
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
    let root = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let code = match root.ok_or("the running program has no folder".to_owned()) {
        Ok(root) if !quiet && !ask(p, MB_YESNO | MB_ICONQUESTION, &question(p, &root)) => 2,
        Ok(root) => match uninstall(p, &root) {
            Ok(()) => 0,
            Err(why) => {
                if !quiet {
                    ask(
                        p,
                        MB_ICONERROR,
                        &format!("{} was not uninstalled: {why}.", p.name),
                    );
                }
                1
            }
        },
        Err(_) => 1,
    };
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

fn uninstall(p: &Product, root: &Path) -> Result<(), String> {
    if !installed_root(p).is_some_and(|r| same_path(&r, root)) {
        return Err("this copy was not installed by its setup".into());
    }
    // The entry is the user's to write: what it names must still be an install folder.
    check_root(root)?;
    if !crate::close_running(root, CLOSE_GRACE) {
        return Err("a running copy did not close".into());
    }
    crate::unregister(p, root);
    for left in setup_folders(root) {
        crate::remove_dir(&left);
    }
    remove_after_exit(root).map_err(|e| format!("the files could not be removed ({e})"))
}

/// Refuses `root` unless it can be an install folder: absolute and below a drive's top, not one
/// of the user's own folders (nor holding one), not a junction or link, and holding the
/// application.
pub(crate) fn check_root(root: &Path) -> Result<(), String> {
    let below_top = root.parent().and_then(Path::parent).is_some();
    if !root.is_absolute() || root.file_name().is_none() || !below_top {
        return Err("its folder is a drive or sits at a drive's top".into());
    }
    if folders::protected().iter().any(|kept| inside(kept, root)) {
        return Err("its folder is, or holds, one of your own folders".into());
    }
    if is_link(root) {
        return Err("its folder is a junction or link".into());
    }
    if !root.join(EXE).is_file() {
        return Err(format!("its folder has no {EXE}"));
    }
    Ok(())
}

/// Whether `path` is `base` or lies inside it, compared without regard to case.
fn inside(path: &Path, base: &Path) -> bool {
    let lower = |p: &Path| {
        p.components()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect::<Vec<_>>()
    };
    lower(path).starts_with(&lower(base))
}

/// A junction, a symbolic link or another reparse point.
fn is_link(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    std::fs::symlink_metadata(path)
        .is_ok_and(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
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
        .filter(|e| ours(&e.file_name().to_string_lossy()) && !is_link(&e.path()))
        .map(|e| e.path())
        .collect()
}

/// Starts a command that deletes `root` once nothing holds it, trying for a minute. The path
/// reaches `cmd.exe` through the environment, read with delayed expansion after the line is
/// parsed, so no character in a folder's name can run a command.
pub(crate) fn remove_after_exit(root: &Path) -> std::io::Result<()> {
    let system = std::env::var_os("SystemRoot")
        .map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from)
        .join("System32");
    Command::new(system.join("cmd.exe"))
        .args(["/d", "/v:on", "/c"])
        .raw_arg(
            "for /l %i in (1,1,30) do @if exist \"!CODENOMAD_UNINSTALL_ROOT!\" \
             (rd /s /q \"!CODENOMAD_UNINSTALL_ROOT!\" 2>nul & ping -n 3 127.0.0.1 >nul)",
        )
        .env("CODENOMAD_UNINSTALL_ROOT", root)
        .current_dir(&system)
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn()
        .map(drop)
}
