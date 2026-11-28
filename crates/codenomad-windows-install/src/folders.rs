//! The user's shell folders, where Windows says they are (a Desktop OneDrive moved, a Start menu
//! redirected by policy).

use std::path::PathBuf;

use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_LocalAppData,
    FOLDERID_Profile, FOLDERID_ProgramFiles, FOLDERID_Programs, FOLDERID_RoamingAppData,
    FOLDERID_UserProgramFiles, FOLDERID_Windows, KF_FLAG_DEFAULT, SHGetKnownFolderPath,
};
use windows::core::GUID;

fn known(id: &GUID) -> Option<PathBuf> {
    // SAFETY: the shell allocates the path, which is copied out and then freed once.
    unsafe {
        let path = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let out = path.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(path.0 as *const _));
        out
    }
}

/// `%LOCALAPPDATA%\Programs`, where per-user applications install.
pub fn user_programs() -> Option<PathBuf> {
    known(&FOLDERID_UserProgramFiles)
}

/// The Start menu's Programs folder.
pub fn programs() -> Option<PathBuf> {
    known(&FOLDERID_Programs)
}

pub fn desktop() -> Option<PathBuf> {
    known(&FOLDERID_Desktop)
}

/// The user's home folder, where a shortcut starts the application, so no process holds the
/// install folder open against an update's swap.
pub fn profile() -> Option<PathBuf> {
    known(&FOLDERID_Profile)
}

/// Where the taskbar keeps its pinned shortcuts.
pub fn taskbar_pins() -> Option<PathBuf> {
    Some(
        known(&FOLDERID_RoamingAppData)?
            .join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"),
    )
}

/// The folders an uninstall must never delete as a whole: the profile, the application data
/// roots, the program folders, Windows, the Desktop, Documents, Downloads and the Start menu.
pub fn protected() -> Vec<PathBuf> {
    [
        &FOLDERID_Profile,
        &FOLDERID_LocalAppData,
        &FOLDERID_RoamingAppData,
        &FOLDERID_UserProgramFiles,
        &FOLDERID_ProgramFiles,
        &FOLDERID_Windows,
        &FOLDERID_Desktop,
        &FOLDERID_Documents,
        &FOLDERID_Downloads,
        &FOLDERID_Programs,
    ]
    .into_iter()
    .filter_map(known)
    .collect()
}
