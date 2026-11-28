//! Shell shortcuts (`.lnk`) that carry the application's AppUserModelID, so Windows groups a
//! window the application opens with the shortcut it was started from: one taskbar button, the
//! shortcut's icon and name, and toasts that name the application.

use std::path::{Path, PathBuf};

use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0, PropVariantClear,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoUninitialize, IPersistFile, STGM_READ,
};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{IShellLinkW, SHStrDupW, ShellLink};
use windows::core::{HSTRING, Interface};

/// This thread's stay in COM, left when dropped. Declare it before any COM or Windows Runtime
/// object, so they are released first. Every call into either holds one: a thread that relies on
/// another thread's stay loses it when that thread leaves.
pub(crate) struct Com(bool);

pub(crate) fn com() -> Com {
    // SAFETY: joins this thread to COM; a thread already in COM in the other model keeps its
    // mode (the call fails and nothing is left later), and shell links work in both.
    Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balances the successful `CoInitializeEx` of `com` on this thread.
            unsafe { CoUninitialize() };
        }
    }
}

/// Writes a shortcut at `path` that starts `target` in `workdir`, with its icon, `app_id` as its
/// AppUserModelID and `description` as its tooltip.
pub fn create(
    path: &Path,
    target: &Path,
    app_id: &str,
    description: &str,
    workdir: &Path,
) -> Result<(), String> {
    let _com = com();
    let err = |what: &'static str| {
        move |e: windows::core::Error| format!("shortcut {}: {what}: {e}", path.display())
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    // SAFETY: COM calls on an object this function made, with strings that outlive each call.
    unsafe {
        let link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(err("create"))?;
        link.SetPath(&HSTRING::from(target.as_os_str()))
            .map_err(err("target"))?;
        link.SetWorkingDirectory(&HSTRING::from(workdir.as_os_str()))
            .map_err(err("working folder"))?;
        link.SetIconLocation(&HSTRING::from(target.as_os_str()), 0)
            .map_err(err("icon"))?;
        link.SetDescription(&HSTRING::from(description))
            .map_err(err("description"))?;
        let store: IPropertyStore = link.cast().map_err(err("properties"))?;
        // A string value in COM memory, as `InitPropVariantFromString` makes one: the store
        // copies it, and the copy here is cleared after.
        let id = SHStrDupW(&HSTRING::from(app_id)).map_err(err("app id"))?;
        let string = PROPVARIANT_0_0 {
            vt: VT_LPWSTR,
            Anonymous: PROPVARIANT_0_0_0 { pwszVal: id },
            ..Default::default()
        };
        let mut value = PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(string),
            },
        };
        let set = store.SetValue(&PKEY_AppUserModel_ID, &value);
        _ = PropVariantClear(&mut value);
        set.map_err(err("app id"))?;
        store.Commit().map_err(err("app id"))?;
        let file: IPersistFile = link.cast().map_err(err("file"))?;
        file.Save(&HSTRING::from(path.as_os_str()), true)
            .map_err(err("save"))?;
    }
    Ok(())
}

/// The program the shortcut at `path` starts.
pub fn target_of(path: &Path) -> Option<PathBuf> {
    let _com = com();
    // SAFETY: the buffer outlives `GetPath`.
    unsafe {
        let mut buf = [0u16; 1024];
        load(path)?
            .GetPath(&mut buf, std::ptr::null_mut(), 0)
            .ok()?;
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..len])))
    }
}

fn load(path: &Path) -> Option<IShellLinkW> {
    if !path.is_file() {
        return None;
    }
    // SAFETY: COM calls on an object this function made.
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let file: IPersistFile = link.cast().ok()?;
        file.Load(&HSTRING::from(path.as_os_str()), STGM_READ)
            .ok()?;
        Some(link)
    }
}

/// The AppUserModelID the shortcut at `path` carries.
#[cfg(test)]
pub fn app_id_of(path: &Path) -> Option<String> {
    let _com = com();
    let store: IPropertyStore = load(path)?.cast().ok()?;
    // SAFETY: the store hands out a value this function owns and clears once.
    unsafe {
        let mut value = store.GetValue(&PKEY_AppUserModel_ID).ok()?;
        let id = (value.Anonymous.Anonymous.vt == VT_LPWSTR)
            .then(|| value.Anonymous.Anonymous.Anonymous.pwszVal.to_string().ok())
            .flatten();
        _ = PropVariantClear(&mut value);
        id
    }
}
