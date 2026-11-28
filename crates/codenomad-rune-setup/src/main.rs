//! `codenomad-rune-setup.exe`: installs the native CodeNomad desktop application for the current
//! user, with no administrator (`codenomad_windows_install` describes the install).
//!
//! 1. Install, with "Create a desktop shortcut", on the first page.
//! 2. Copies of the application running from the install are asked to close.
//! 3. The embedded zip of the install folder unpacks beside the install and takes its place with
//!    a rename, so a failed install leaves the previous version as it was.
//! 4. The Start menu shortcut (and the desktop one) and the Apps & features entry are registered.
//! 5. "Launch" on the last page starts the application.
//!
//! ```text
//! codenomad-rune-setup.exe [--silent | /S] [--desktop-shortcut] [--launch] [--dir <folder>] [--log <file>]
//! ```
//!
//! `--silent` installs without a window, with the desktop shortcut and the launch only when
//! asked. `--dir` installs somewhere else than `%LOCALAPPDATA%\Programs\<name>`.
//!
//! Derived from `apps/installer` of `anomalyco/opencode-rune` (MIT, see
//! `THIRD_PARTY_NOTICES.md`).
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod install;
#[cfg(windows)]
mod pages;

fn main() {
    #[cfg(windows)]
    std::process::exit(install::run());
    #[cfg(not(windows))]
    eprintln!("codenomad-rune-setup installs CodeNomad on Windows.");
}
