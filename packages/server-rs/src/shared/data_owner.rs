//! The data folder belongs to the account running the server and is private
//! from the first start (audit F2): extension HTML, preferences, receipts and
//! identities under it are never writable by another local account.
use std::{io, path::Path};

/// Creates `data` if needed, refuses a folder owned by another account, then
/// protects it like `tls/` and `devices/` (owner and SYSTEM only).
pub fn protect(data: &Path) -> io::Result<()> {
    std::fs::create_dir_all(data)?;
    if !owned_by_current_user(data)? {
        return Err(io::Error::other("Data folder is owned by another account"));
    }
    // A folder left by an earlier start keeps its files' inherited entries
    // until the new DACL is propagated once (an unchanged DACL is not
    // propagated again); later starts skip the walk.
    #[cfg(windows)]
    if !dacl_protected(data)? {
        if std::fs::symlink_metadata(data)?.file_type().is_symlink() {
            return Err(io::Error::other("Private directory must be physical"));
        }
        propagate(data)?;
    }
    crate::auth::tls::private_directory(data)
}

#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain([0]).collect()
}

#[cfg(windows)]
pub fn dacl_protected(path: &Path) -> io::Result<bool> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT},
            DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl, SE_DACL_PROTECTED,
        },
    };
    let name = wide(path);
    // SAFETY: valid out-pointers; the descriptor is released.
    unsafe {
        let mut descriptor = std::ptr::null_mut();
        let mut dacl = std::ptr::null_mut();
        let status = GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        );
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let (mut control, mut revision) = (0u16, 0u32);
        let ok = GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) != 0;
        let e = io::Error::last_os_error();
        LocalFree(descriptor);
        if !ok {
            return Err(e);
        }
        Ok(control & SE_DACL_PROTECTED != 0)
    }
}

#[cfg(windows)]
fn propagate(path: &Path) -> io::Result<()> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SE_FILE_OBJECT, SetNamedSecurityInfoW,
            },
            DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, PROTECTED_DACL_SECURITY_INFORMATION,
        },
    };
    let rule: Vec<u16> = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)".encode_utf16().chain([0]).collect();
    let name = wide(path);
    // SAFETY: valid out-pointers; the descriptor owning the DACL is released
    // after the call that reads it.
    unsafe {
        let mut descriptor = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(rule.as_ptr(), 1, &mut descriptor, std::ptr::null_mut())
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        let (mut present, mut defaulted, mut dacl) = (0, 0, std::ptr::null_mut());
        let status = if GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) == 0 {
            Err(io::Error::last_os_error())
        } else {
            match SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl,
                std::ptr::null(),
            ) {
                0 => Ok(()),
                e => Err(io::Error::from_raw_os_error(e as i32)),
            }
        };
        LocalFree(descriptor);
        status
    }
}

/// A file that exists and is owned by another account is refused.
pub fn foreign(path: &Path) -> io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(!owned_by_current_user(path)?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
pub fn owned_by_current_user(path: &Path) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions.
    Ok(std::fs::symlink_metadata(path)?.uid() == unsafe { libc::geteuid() })
}

/// The owner is the token's user or its default owner (an elevated
/// administrator's new files belong to `Administrators`).
#[cfg(windows)]
pub fn owned_by_current_user(path: &Path) -> io::Result<bool> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree},
        Security::{
            Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT},
            EqualSid, GetTokenInformation, OWNER_SECURITY_INFORMATION, TOKEN_OWNER, TOKEN_QUERY, TOKEN_USER,
            TokenOwner, TokenUser,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: every out-pointer is valid for the call; buffers are 8-aligned
    // and large enough for one SID; handles and descriptors are released.
    unsafe {
        let mut owner = std::ptr::null_mut();
        let mut descriptor = std::ptr::null_mut();
        let status = GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        );
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            let e = io::Error::last_os_error();
            LocalFree(descriptor);
            return Err(e);
        }
        let mut user = [0u64; 64];
        let mut default = [0u64; 64];
        let mut length = 0;
        let read = GetTokenInformation(token, TokenUser, user.as_mut_ptr().cast(), 512, &mut length) != 0
            && GetTokenInformation(token, TokenOwner, default.as_mut_ptr().cast(), 512, &mut length) != 0;
        let e = io::Error::last_os_error();
        CloseHandle(token);
        if !read {
            LocalFree(descriptor);
            return Err(e);
        }
        let user = &*(user.as_ptr() as *const TOKEN_USER);
        let default = &*(default.as_ptr() as *const TOKEN_OWNER);
        let same = EqualSid(owner, user.User.Sid) != 0 || EqualSid(owner, default.Owner) != 0;
        LocalFree(descriptor);
        Ok(same)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_folder_is_private_from_the_first_start() {
        let parent = crate::shared::test_dir("data-owner");
        let data = parent.join("server.data");
        // A file from an earlier start inherited the parent's entries.
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("state-ui.json"), "{}").unwrap();
        #[cfg(windows)]
        assert!(!dacl_protected(&data).unwrap());
        protect(&data).unwrap();
        assert!(owned_by_current_user(&data).unwrap());
        #[cfg(windows)]
        {
            assert!(dacl_protected(&data).unwrap());
            // Propagated: the existing file now carries only the folder's entries.
            let acl = std::process::Command::new("icacls").arg(data.join("state-ui.json")).output().unwrap();
            let text = String::from_utf8_lossy(&acl.stdout).to_string();
            assert!(
                !text.contains("BUILTIN\\") && !text.contains("authentifi") && !text.contains("Authenticated"),
                "{text}"
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&data).unwrap().permissions().mode() & 0o777, 0o700);
        }
        // Idempotent on the next start.
        protect(&data).unwrap();
        assert!(!foreign(&data).unwrap() && !foreign(&data.join("absent")).unwrap());
        let _ = std::fs::remove_dir_all(parent);
    }
}
