//! Windows shows a desktop app's notifications only under an AppUserModelID it knows.
//! The installer's Start menu shortcut carries the default profile's ID, while data
//! profiles run under their own (`<identifier>.scope.s<hash>`). Registering the running
//! ID under `HKCU\Software\Classes\AppUserModelId` names it and gives it an icon, so
//! notifications from every profile show.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
    REG_OPTION_NON_VOLATILE, REG_SZ,
};

const DISPLAY_NAME: &str = "CodeNomad";

pub(crate) fn register(identifier: &str) {
    if let Err(status) = write(&key_path(identifier), toast_icon().as_deref(), None) {
        eprintln!("[tauri] failed to register AppUserModelID for notifications: {status}");
    }
}

pub(crate) fn register_activation(
    identifier: &str,
    clsid: &str,
    argument: &str,
) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = std::ffi::OsString::from("\"");
    command.push(exe);
    command.push(format!("\" {argument}"));
    with_key(
        &format!(r"Software\Classes\CLSID\{clsid}\LocalServer32"),
        |key| set_string(key, "", &command),
    )
    .and_then(|()| write(&key_path(identifier), toast_icon().as_deref(), Some(clsid)))
    .map_err(|status| format!("Windows toast identity registration failed: {status}"))
}

fn key_path(identifier: &str) -> String {
    format!(r"Software\Classes\AppUserModelId\{identifier}")
}

/// The web app's icon, which the bundled server's UI build always ships (its manifest
/// references it; `scripts/smoke-packaged-resources.cjs` checks it).
fn toast_icon() -> Option<PathBuf> {
    let icon = std::env::current_exe()
        .ok()?
        .parent()?
        .join(r"resources\server\public\pwa-192x192.png");
    icon.is_file().then_some(icon)
}

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn with_key(path: &str, write: impl FnOnce(HKEY) -> Result<(), u32>) -> Result<(), u32> {
    let path = wide(path);
    let mut key: HKEY = std::ptr::null_mut();
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(status);
    }
    let result = write(key);
    unsafe { RegCloseKey(key) };
    result
}

fn write(path: &str, icon: Option<&Path>, activator: Option<&str>) -> Result<(), u32> {
    with_key(path, |key| {
        set_string(key, "DisplayName", DISPLAY_NAME)?;
        if let Some(icon) = icon {
            set_string(key, "IconUri", icon)?;
        }
        if let Some(activator) = activator {
            set_string(key, "CustomActivator", activator)?;
        }
        Ok(())
    })
}

fn set_string(key: HKEY, name: &str, value: impl AsRef<OsStr>) -> Result<(), u32> {
    let name = wide(name);
    let data = wide(value);
    let status = unsafe {
        RegSetValueExW(
            key,
            if name.len() == 1 {
                std::ptr::null()
            } else {
                name.as_ptr()
            },
            0,
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * std::mem::size_of::<u16>()) as u32,
        )
    };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn registers_the_identifier_with_a_name_and_icon_under_the_current_user() {
        let identifier = format!("ai.neuralnomads.codenomad.test.s{}", std::process::id());
        let path = key_path(&identifier);
        let icon = Path::new(r"C:\CodeNomad\resources\server\public\pwa-192x192.png");
        write(&path, Some(icon), None).unwrap();
        let key = format!(r"HKCU\{path}");
        let query = Command::new("reg").args(["query", &key]).output().unwrap();
        let _ = Command::new("reg").args(["delete", &key, "/f"]).output();
        let values = String::from_utf8_lossy(&query.stdout);
        assert!(
            values.contains("DisplayName    REG_SZ    CodeNomad"),
            "{values}"
        );
        assert!(
            values.contains(&format!("IconUri    REG_SZ    {}", icon.display())),
            "{values}"
        );
    }
}
