//! Linux AppImage environment. The AppImage's AppRun hook points GTK, GIO and
//! GSettings at modules inside its mount (`GIO_MODULE_DIR`, `GTK_PATH`, a
//! prefixed `XDG_DATA_DIRS`, ...) for this process's own WebKit. The backend,
//! the shared OpenCode service it starts, the editors CodeNomad opens and link
//! handlers outlive that mount, so they get the host's environment: variables
//! inside the mount are dropped, mount entries are removed from path lists and
//! they start outside the mount.
//! Paths are bytes on Linux; nothing here assumes UTF-8.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::process::Command;

/// GTK prefers X11 (XWayland) and falls back to Wayland where no X server runs,
/// unless the session chooses: the F11 fullscreen shortcut is an X11 key grab.
/// Only this process's GTK: children keep the session's own backend choice.
pub(crate) fn prefer_x11_display() {
    if std::env::var_os("GDK_BACKEND").is_none() {
        gtk::gdk::set_allowed_backends("x11,wayland");
    }
}

/// `environment`, to replace a child's whole environment, without this AppImage's mount paths.
pub(crate) fn host_environment(environment: HashMap<String, String>) -> HashMap<String, String> {
    match mount() {
        Some(mount) => without_mount_in(environment, &mount),
        None => environment,
    }
}

/// A Unicode environment snapshot (the login shell's, serialized by Node) spells
/// a non-UTF-8 mount with U+FFFD, as the lossy conversion does.
fn without_mount_in(
    environment: HashMap<String, String>,
    mount: &OsStr,
) -> HashMap<String, String> {
    let mount = mount.to_string_lossy();
    environment
        .into_iter()
        .filter_map(
            |(key, value)| match without_mount(value.as_bytes(), mount.as_bytes()) {
                Some(kept) if kept.is_empty() => None,
                // The kept entries of a UTF-8 value, split at ':', are UTF-8.
                Some(kept) => String::from_utf8(kept).ok().map(|kept| (key, kept)),
                None => Some((key, value)),
            },
        )
        .collect()
}

/// Gives a child that inherits this process's environment the host's environment,
/// and `/` as its working directory while ours is inside the mount (AppRun's
/// `usr`); a caller may still choose another one.
pub(crate) fn use_host_environment(command: &mut Command) {
    let Some(mount) = mount() else {
        return;
    };
    let cwd = std::env::current_dir();
    if cwd.is_ok_and(|dir| inside(dir.as_os_str().as_bytes(), mount.as_bytes())) {
        command.current_dir("/");
    }
    for (key, value) in std::env::vars_os() {
        match without_mount(value.as_bytes(), mount.as_bytes()) {
            Some(kept) if kept.is_empty() => {
                command.env_remove(&key);
            }
            Some(kept) => {
                command.env(&key, OsString::from_vec(kept));
            }
            None => {}
        }
    }
}

/// The mount, as AppRun's hooks spell it, when this process runs from an AppImage.
fn mount() -> Option<OsString> {
    let appimage = std::env::var_os("APPIMAGE")?;
    let mut appdir = std::env::var_os("APPDIR")?.into_vec();
    while appdir.last() == Some(&b'/') {
        appdir.pop();
    }
    (!appimage.is_empty() && !appdir.is_empty()).then(|| OsString::from_vec(appdir))
}

/// `value` without its colon-separated entries inside `mount`, when it has any.
fn without_mount(value: &[u8], mount: &[u8]) -> Option<Vec<u8>> {
    let entries: Vec<&[u8]> = value.split(|byte| *byte == b':').collect();
    let kept: Vec<&[u8]> = entries
        .iter()
        .copied()
        .filter(|entry| !inside(entry, mount))
        .collect();
    (kept.len() != entries.len()).then(|| kept.join(&b':'))
}

fn inside(entry: &[u8], mount: &[u8]) -> bool {
    entry
        .strip_prefix(mount)
        .is_some_and(|rest| rest.is_empty() || rest[0] == b'/')
}

#[cfg(test)]
mod tests {
    use super::{without_mount, without_mount_in};
    use std::collections::HashMap;
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    #[test]
    fn a_unicode_snapshot_matches_a_non_utf8_mount_lossily() {
        let mount = OsStr::from_bytes(b"/tmp/.mount_Code\xff");
        let snapshot = HashMap::from([
            (
                "GIO_MODULE_DIR".to_string(),
                "/tmp/.mount_Code\u{fffd}/usr/lib/gio/modules".to_string(),
            ),
            (
                "LD_LIBRARY_PATH".to_string(),
                "/tmp/.mount_Code\u{fffd}/usr/lib:/usr/lib".to_string(),
            ),
            ("HOME".to_string(), "/home/u".to_string()),
        ]);
        assert_eq!(
            without_mount_in(snapshot, mount),
            HashMap::from([
                ("LD_LIBRARY_PATH".to_string(), "/usr/lib".to_string()),
                ("HOME".to_string(), "/home/u".to_string()),
            ])
        );
    }

    const MOUNT: &[u8] = b"/tmp/.mount_CodeNoAb12";

    #[test]
    fn drops_mount_paths_and_keeps_host_entries() {
        let cases: [(&[u8], &[u8]); 5] = [
            (b"/tmp/.mount_CodeNoAb12//usr/lib/gio/modules", b""),
            (b"/tmp/.mount_CodeNoAb12", b""),
            (
                b"/tmp/.mount_CodeNoAb12/usr/share:/usr/share:/home/u/.local/share",
                b"/usr/share:/home/u/.local/share",
            ),
            (
                b"/tmp/.mount_CodeNoAb12/usr/share:/usr/share:",
                b"/usr/share:",
            ),
            // A host entry need not be UTF-8.
            (
                b"/tmp/.mount_CodeNoAb12/usr/lib:/opt/caf\xe9/lib",
                b"/opt/caf\xe9/lib",
            ),
        ];
        for (value, expected) in cases {
            assert_eq!(without_mount(value, MOUNT).as_deref(), Some(expected));
        }
        for untouched in [
            &b"/usr/lib/x86_64-linux-gnu/gio/modules"[..],
            b"/tmp/.mount_CodeNoAb123/usr/lib",
            b"/home/u/CodeNomad.AppImage",
            b"https://example.com:8443/tmp/.mount_CodeNoAb12",
            b"x11,wayland",
            b"",
        ] {
            assert_eq!(without_mount(untouched, MOUNT), None);
        }
        let non_utf8_mount: &[u8] = b"/tmp/.mount_\xff";
        assert_eq!(
            without_mount(b"/tmp/.mount_\xff/usr/lib:/usr/lib", non_utf8_mount).as_deref(),
            Some(&b"/usr/lib"[..])
        );
    }
}
