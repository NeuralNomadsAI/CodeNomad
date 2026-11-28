//! The install's keys, all under `HKEY_CURRENT_USER`: its Apps & features entry, and the
//! notification identities the application registers when it shows toasts.

use std::path::{Path, PathBuf};

use windows::UI::Notifications::ToastNotificationManager;
use windows::core::HSTRING;
use windows_registry::CURRENT_USER;

use crate::{EXE, PUBLISHER, Product};

const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
const IDENTITIES: &str = r"Software\Classes\AppUserModelId";
const NOTIFICATION_SETTINGS: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings";

fn entry_key(p: &Product) -> String {
    format!(r"{UNINSTALL}\{}", p.id)
}

/// Apps & features' entry: the name, version, publisher, icon and size, and the application
/// itself as the uninstaller (`--uninstall`; `--quiet` for a silent one). The entry has no Modify
/// or Repair: the setup installs over an install.
pub fn write_entry(p: &Product, root: &Path, size_kb: u32) -> Result<(), String> {
    let key = CURRENT_USER
        .create(entry_key(p))
        .map_err(|e| format!("uninstall entry: {e}"))?;
    let exe = root.join(EXE);
    let exe = exe.to_string_lossy();
    let strings = [
        ("DisplayName", p.name.clone()),
        ("DisplayVersion", p.version.clone()),
        ("DisplayIcon", format!("{exe},0")),
        ("Publisher", PUBLISHER.to_owned()),
        ("InstallLocation", root.to_string_lossy().into_owned()),
        ("UninstallString", format!("\"{exe}\" --uninstall")),
        (
            "QuietUninstallString",
            format!("\"{exe}\" --uninstall --quiet"),
        ),
    ];
    for (name, value) in strings {
        key.set_string(name, value)
            .map_err(|e| format!("uninstall entry {name}: {e}"))?;
    }
    for (name, value) in [("NoModify", 1), ("NoRepair", 1), ("EstimatedSize", size_kb)] {
        key.set_u32(name, value)
            .map_err(|e| format!("uninstall entry {name}: {e}"))?;
    }
    Ok(())
}

pub fn entry_root(p: &Product) -> Option<PathBuf> {
    let location = CURRENT_USER
        .open(entry_key(p))
        .ok()?
        .get_string("InstallLocation")
        .ok()?;
    (!location.is_empty()).then(|| PathBuf::from(location))
}

pub fn remove_entry(p: &Product) -> Option<String> {
    let key = entry_key(p);
    CURRENT_USER.open(&key).ok()?;
    CURRENT_USER
        .remove_tree(&key)
        .ok()
        .map(|()| format!("removed HKCU\\{key}"))
}

/// The identities the application registered for its toasts (`<id>`, and `<id>.scope.<profile>`
/// for a named profile), the notification settings Windows keeps for each, and their toasts in
/// the notification center, which keeps them after the application goes.
pub fn remove_identities(p: &Product) -> Vec<String> {
    let scoped = format!("{}.scope.", p.id);
    let ours = |name: &String| *name == p.id || name.starts_with(&scoped);
    let mut done = Vec::new();
    for parent in [IDENTITIES, NOTIFICATION_SETTINGS] {
        let Ok(key) = CURRENT_USER.open(parent) else {
            continue;
        };
        let Ok(names) = key.keys() else {
            continue;
        };
        for name in names.filter(ours).collect::<Vec<_>>() {
            if parent == IDENTITIES {
                let id = HSTRING::from(&name);
                _ = ToastNotificationManager::History().and_then(|h| h.ClearWithId(&id));
            }
            let key = format!(r"{parent}\{name}");
            if CURRENT_USER.remove_tree(&key).is_ok() {
                done.push(format!("removed HKCU\\{key}"));
            }
        }
    }
    done
}
