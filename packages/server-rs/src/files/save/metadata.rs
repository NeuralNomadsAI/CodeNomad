//! Preserve the old file's permissions and metadata without restoring privileges
//! that a normal write would clear.
use std::{
    fs::{File, Permissions},
    io,
    os::unix::fs::{MetadataExt, PermissionsExt, fchown},
};

pub(super) fn copy(original: &File, staged: &File) -> io::Result<()> {
    let source = original.metadata()?;
    let temp = staged.metadata()?;
    if (source.uid(), source.gid()) != (temp.uid(), temp.gid()) {
        fchown(staged, Some(source.uid()), Some(source.gid()))?;
    }
    staged.set_permissions(Permissions::from_mode(source.mode() & 0o1777))?;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    platform::copy(original, staged)?;
    Ok(())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::{os::fd::AsRawFd, ptr};

    pub(super) fn copy(original: &File, staged: &File) -> io::Result<()> {
        // SAFETY: both descriptors are live and null selects the default state.
        let result = unsafe {
            libc::fcopyfile(
                original.as_raw_fd(),
                staged.as_raw_fd(),
                ptr::null_mut(),
                libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
            )
        };
        if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::{ffi::CString, os::fd::AsRawFd};

    fn buffer(call: impl Fn(*mut u8, usize) -> libc::ssize_t) -> io::Result<Vec<u8>> {
        let size = call(std::ptr::null_mut(), 0);
        if size < 0 {
            return Err(io::Error::last_os_error());
        }
        if size > 65_536 {
            return Err(io::Error::other("File attributes exceed the platform limit"));
        }
        let mut bytes = vec![0; size as usize];
        let received = call(bytes.as_mut_ptr(), bytes.len());
        if received < 0 {
            return Err(io::Error::last_os_error());
        }
        if received > size {
            return Err(io::Error::other("File attributes changed"));
        }
        bytes.truncate(received as usize);
        Ok(bytes)
    }

    fn names(file: &File) -> io::Result<Vec<CString>> {
        // SAFETY: buffer supplies a valid list buffer or a null pointer with length zero.
        let list = match buffer(|out, len| unsafe { libc::flistxattr(file.as_raw_fd(), out.cast(), len) }) {
            Err(error) if error.raw_os_error() == Some(libc::EOPNOTSUPP) => return Ok(Vec::new()),
            result => result?,
        };
        list.split(|&byte| byte == 0)
            .filter(|name| !name.is_empty())
            .map(|name| CString::new(name).map_err(io::Error::other))
            .collect()
    }

    fn value(file: &File, name: &CString) -> io::Result<Vec<u8>> {
        // SAFETY: name is NUL-terminated and buffer owns the destination.
        buffer(|out, len| unsafe { libc::fgetxattr(file.as_raw_fd(), name.as_ptr(), out.cast(), len) })
    }

    pub(super) fn copy(original: &File, staged: &File) -> io::Result<()> {
        let source = names(original)?;
        let inherited = names(staged)?;
        for name in &inherited {
            if !source.contains(name) || name.as_bytes() == b"security.capability" {
                // SAFETY: descriptor and NUL-terminated name are live.
                if unsafe { libc::fremovexattr(staged.as_raw_fd(), name.as_ptr()) } != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
        }
        for name in &source {
            if name.as_bytes() == b"security.capability" {
                continue;
            }
            let data = value(original, name)?;
            if inherited.contains(name) && value(staged, name)? == data {
                continue;
            }
            // SAFETY: descriptor, name and data are live for this call.
            if unsafe { libc::fsetxattr(staged.as_raw_fd(), name.as_ptr(), data.as_ptr().cast(), data.len(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}
