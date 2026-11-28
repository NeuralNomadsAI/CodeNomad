//! The native CodeNomad desktop application's per-user Windows install, shared by its setup and
//! by the application, which removes itself and refreshes its entry after an update.
//!
//! ```text
//! %LOCALAPPDATA%\Programs\<name>\                      the install root, replaced whole by an update
//!   codenomad-rune.exe
//! Start menu\Programs\<name>.lnk                       carries the AppUserModelID, so a pin, the
//! Desktop\<name>.lnk (optional)                        window and the toasts share one identity
//! HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<id>    Apps & features
//! ```
//!
//! Every file is under the user's profile and every key under `HKEY_CURRENT_USER`, so nothing
//! needs an administrator. A copy is the install when the entry names its folder
//! ([`installed_root`]); any other copy (a build folder, an unpacked archive) registers nothing.
//!
//! Derived from `crates/win-install` of `anomalyco/opencode-rune` (MIT, see
//! `THIRD_PARTY_NOTICES.md`).
#![cfg(windows)]
#![deny(unsafe_op_in_unsafe_fn)]

use std::path::{Path, PathBuf};
use std::time::Duration;

mod folders;
mod process;
mod registry;
mod root;
mod shortcut;
#[cfg(test)]
mod tests;
mod uninstall;

pub use process::{close_running, running_under};
pub use root::check_install_target;
pub use uninstall::run_if_asked as run_uninstall_if_asked;

/// The application's executable in the install root.
pub const EXE: &str = "codenomad-rune.exe";
/// The AppUserModelID the application takes for its window and toasts
/// (`codenomad-windows-notifications`), and the key of its Apps & features entry.
pub const APP_ID: &str = "ai.neuralnomads.codenomad.rune";
/// The publisher Apps & features shows, as for the Tauri application.
pub const PUBLISHER: &str = "neuralnomads";

/// What one build installs as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Product {
    /// The Start menu entry, the install folder and the Apps & features name.
    pub name: String,
    /// The AppUserModelID and the key of the Apps & features entry.
    pub id: String,
    pub version: String,
}

impl Product {
    /// What a release installs as. The name differs from the Tauri application's `CodeNomad`
    /// while both can be installed, so each keeps its Start menu entry and install folder; it
    /// becomes `CodeNomad` when the Tauri application is retired.
    pub fn release(version: &str) -> Product {
        Product {
            name: "CodeNomad Rune".into(),
            id: APP_ID.into(),
            version: version.into(),
        }
    }
}

/// Where the setup installs `p` by default: `%LOCALAPPDATA%\Programs\<name>`.
pub fn default_root(p: &Product) -> Option<PathBuf> {
    Some(folders::user_programs()?.join(&p.name))
}

/// The folder `p`'s Apps & features entry names, when it is installed.
pub fn installed_root(p: &Product) -> Option<PathBuf> {
    registry::entry_root(p)
}

/// Registers the install at `root`: the Start menu shortcut (and the desktop one when asked) and
/// the Apps & features entry. A shortcut of the same name that starts another program is never
/// replaced: nothing is written and the error names it ([`check_shortcuts`] says so beforehand).
pub fn register(p: &Product, root: &Path, desktop_shortcut: bool) -> Result<(), String> {
    register_in(p, root, &link_dirs(desktop_shortcut)?)
}

/// Refuses when a shortcut `register` would write already starts another program, so the setup
/// can say so before it replaces any file.
pub fn check_shortcuts(p: &Product, root: &Path, desktop_shortcut: bool) -> Result<(), String> {
    check_links(p, root, &links(p, &link_dirs(desktop_shortcut)?))
}

fn link_dirs(desktop_shortcut: bool) -> Result<Vec<PathBuf>, String> {
    let mut dirs = vec![folders::programs().ok_or("no Start menu folder")?];
    if desktop_shortcut {
        dirs.push(folders::desktop().ok_or("no Desktop folder")?);
    }
    Ok(dirs)
}

fn links(p: &Product, link_dirs: &[PathBuf]) -> Vec<PathBuf> {
    link_dirs.iter().map(|d| d.join(link_name(p))).collect()
}

fn check_links(p: &Product, root: &Path, links: &[PathBuf]) -> Result<(), String> {
    let exe = root.join(EXE);
    let installed = installed_root(p).map(|r| r.join(EXE));
    for link in links.iter().filter(|link| link.exists()) {
        let target = shortcut::target_of(link);
        let ours = target.as_deref().is_some_and(|t| {
            same_path(t, &exe) || installed.as_deref().is_some_and(|i| same_path(t, i))
        });
        if !ours {
            return Err(format!("{} already starts another program", link.display()));
        }
    }
    Ok(())
}

fn register_in(p: &Product, root: &Path, link_dirs: &[PathBuf]) -> Result<(), String> {
    let exe = root.join(EXE);
    if !exe.is_file() {
        return Err(format!("{} has no {EXE}", root.display()));
    }
    let links = links(p, link_dirs);
    check_links(p, root, &links)?;
    let workdir = folders::profile().unwrap_or_else(|| root.to_path_buf());
    for link in &links {
        shortcut::create(link, &exe, &p.id, &p.name, &workdir)?;
    }
    registry::write_entry(p, root, size_kb(root))
}
/// After an update put a new version in `root`: its version and size in Apps & features. Does
/// nothing when `root` is not `p`'s registered install.
pub fn refresh(p: &Product, root: &Path) -> Result<(), String> {
    if !installed_root(p).is_some_and(|r| same_path(&r, root)) {
        return Ok(());
    }
    registry::write_entry(p, root, size_kb(root))
}

/// Takes away what the install at `root` left outside its folder: the shortcuts that start it
/// (a taskbar pin too), its Apps & features entry, and the notification identities the
/// application registered with its toasts. Returns what it changed, for the log.
pub fn unregister(p: &Product, root: &Path) -> Vec<String> {
    let dirs = [
        folders::programs(),
        folders::desktop(),
        folders::taskbar_pins(),
    ];
    let dirs: Vec<PathBuf> = dirs.into_iter().flatten().collect();
    unregister_in(p, root, &dirs)
}

fn unregister_in(p: &Product, root: &Path, link_dirs: &[PathBuf]) -> Vec<String> {
    let mut done = Vec::new();
    let exe = root.join(EXE);
    for link in link_dirs.iter().map(|dir| dir.join(link_name(p))) {
        let ours = shortcut::target_of(&link).is_some_and(|target| same_path(&target, &exe));
        if ours && std::fs::remove_file(&link).is_ok() {
            done.push(format!("removed {}", link.display()));
        }
    }
    if installed_root(p).is_some_and(|r| same_path(&r, root)) {
        done.extend(registry::remove_entry(p));
        done.extend(registry::remove_identities(p));
    }
    done
}

/// Removes `dir` and everything in it, retrying while a scanner or an exiting process still
/// holds a file. True once it is gone.
pub fn remove_dir(dir: &Path) -> bool {
    for _ in 0..40 {
        if std::fs::remove_dir_all(dir).is_ok() || !dir.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

fn link_name(p: &Product) -> String {
    format!("{}.lnk", p.name)
}

/// The same path as the setup or the shell writes it: case and a trailing `\` aside. Any other
/// spelling (an 8.3 name, a junction, a `\\?\` prefix) compares unequal, which only ever means
/// nothing is written or removed.
fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

/// What the install takes on disk, for Apps & features.
fn size_kb(root: &Path) -> u32 {
    fn walk(dir: &Path) -> u64 {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| match entry.metadata() {
                Ok(m) if m.is_dir() => walk(&entry.path()),
                Ok(m) => m.len(),
                Err(_) => 0,
            })
            .sum()
    }
    u32::try_from(walk(root) / 1024).unwrap_or(u32::MAX)
}
