//! Linux AppImage environment. The AppImage's AppRun hook points GTK, GIO and
//! GSettings at modules inside its mount (`GIO_MODULE_DIR`, `GTK_PATH`, a
//! prefixed `XDG_DATA_DIRS`, ...) for this process's own WebKit. The backend,
//! the shared OpenCode service it starts and the editors CodeNomad opens outlive
//! that mount, so they get the host's environment: variables inside the mount
//! are dropped and mount entries are removed from path lists.

use std::collections::HashMap;
use std::process::Command;

/// GTK prefers X11 (XWayland) and falls back to Wayland where no X server runs,
/// unless the session chooses: the F11 fullscreen shortcut is an X11 key grab.
pub(crate) fn prefer_x11_display() {
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11,wayland");
    }
}

/// `environment`, to replace a child's whole environment, without this AppImage's mount paths.
pub(crate) fn host_environment(environment: HashMap<String, String>) -> HashMap<String, String> {
    let Some(mount) = mount() else {
        return environment;
    };
    environment
        .into_iter()
        .filter_map(|(key, value)| match without_mount(&value, &mount) {
            Some(kept) if kept.is_empty() => None,
            Some(kept) => Some((key, kept)),
            None => Some((key, value)),
        })
        .collect()
}

/// Gives a child that inherits this process's environment the host's environment.
pub(crate) fn use_host_environment(command: &mut Command) {
    let Some(mount) = mount() else {
        return;
    };
    for (key, value) in std::env::vars_os() {
        let (Some(key), Some(value)) = (key.to_str(), value.to_str()) else {
            continue;
        };
        match without_mount(value, &mount) {
            Some(kept) if kept.is_empty() => {
                command.env_remove(key);
            }
            Some(kept) => {
                command.env(key, kept);
            }
            None => {}
        }
    }
}

/// The mount, as AppRun's hooks spell it, when this process runs from an AppImage.
fn mount() -> Option<String> {
    let appimage = std::env::var_os("APPIMAGE")?;
    let appdir = std::env::var("APPDIR").ok()?;
    let appdir = appdir.trim_end_matches('/');
    (!appimage.is_empty() && !appdir.is_empty()).then(|| appdir.to_string())
}

/// `value` without its colon-separated entries inside `mount`, when it has any.
fn without_mount(value: &str, mount: &str) -> Option<String> {
    let entries: Vec<&str> = value.split(':').collect();
    let kept: Vec<&str> = entries
        .iter()
        .copied()
        .filter(|entry| !inside(entry, mount))
        .collect();
    (kept.len() != entries.len()).then(|| kept.join(":"))
}

fn inside(entry: &str, mount: &str) -> bool {
    entry
        .strip_prefix(mount)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::without_mount;

    const MOUNT: &str = "/tmp/.mount_CodeNoAb12";

    #[test]
    fn drops_mount_paths_and_keeps_host_entries() {
        for (value, expected) in [
            ("/tmp/.mount_CodeNoAb12//usr/lib/gio/modules", Some("")),
            ("/tmp/.mount_CodeNoAb12", Some("")),
            (
                "/tmp/.mount_CodeNoAb12/usr/share:/usr/share:/home/u/.local/share",
                Some("/usr/share:/home/u/.local/share"),
            ),
            (
                "/tmp/.mount_CodeNoAb12/usr/share:/usr/share:",
                Some("/usr/share:"),
            ),
        ] {
            assert_eq!(without_mount(value, MOUNT).as_deref(), expected, "{value}");
        }
        for untouched in [
            "/usr/lib/x86_64-linux-gnu/gio/modules",
            "/tmp/.mount_CodeNoAb123/usr/lib",
            "/home/u/CodeNomad.AppImage",
            "https://example.com:8443/tmp/.mount_CodeNoAb12",
            "x11,wayland",
            "",
        ] {
            assert_eq!(without_mount(untouched, MOUNT), None, "{untouched}");
        }
    }
}
