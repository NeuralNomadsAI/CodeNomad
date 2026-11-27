//! Handle-anchored directory and file operations for temporary workspaces.
//!
//! Every create, inspect, enumerate, read, atomic replace and delete runs strictly relative to
//! already-open `cap_std::fs::Dir` handles using kernel handle-relative syscalls (`openat` /
//! `mkdirat` / `unlinkat` / `renameat` on Unix; `NtCreateFile` / `NtSetInformationFile` /
//! `GetFileInformationByHandleEx` / `SetFileInformationByHandle` on Windows), without following
//! symlinks or Windows reparse points and without path-reconstructing `cap_std` fallbacks.
use std::{
    ffi::{OsStr, OsString},
    fs,
    io::{self, ErrorKind, Read, Write},
    path::{Path, PathBuf},
};

use cap_std::{ambient_authority, fs::Dir};

#[cfg(windows)]
fn validate_component(name: &OsStr) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    if name.is_empty() || name == OsStr::new(".") || name == OsStr::new("..") {
        return Err(io::Error::new(ErrorKind::InvalidInput, "Invalid path component"));
    }
    let wide: Vec<u16> = name.encode_wide().collect();
    if wide.is_empty()
        || wide.len() > (u16::MAX as usize / 2)
        || wide.iter().any(|&u| u == 0 || u == b'\\' as u16 || u == b'/' as u16)
    {
        return Err(io::Error::new(ErrorKind::InvalidInput, "Invalid path component"));
    }
    Ok(wide)
}

#[cfg(not(windows))]
fn validate_component(name: &OsStr) -> io::Result<std::ffi::CString> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.contains(&b'/') || bytes == b"." || bytes == b".." {
        return Err(io::Error::new(ErrorKind::InvalidInput, "Invalid path component"));
    }
    CString::new(bytes).map_err(|_| io::Error::new(ErrorKind::InvalidInput, "Invalid NUL in name"))
}

#[cfg(windows)]
fn nt_status_to_io(status: windows_sys::Win32::Foundation::NTSTATUS) -> io::Error {
    use windows_sys::Win32::Foundation::{RtlNtStatusToDosError, STATUS_OBJECT_NAME_COLLISION};
    if status == STATUS_OBJECT_NAME_COLLISION {
        return io::Error::new(ErrorKind::AlreadyExists, "Object already exists");
    }
    // SAFETY: `RtlNtStatusToDosError` accepts any NTSTATUS value.
    let dos = unsafe { RtlNtStatusToDosError(status) };
    io::Error::from_raw_os_error(dos as i32)
}

#[cfg(windows)]
const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;

/// Opens a single direct child directory of `parent` strictly WITHOUT following symlinks or
/// Windows junctions/reparse points, even when the link target lies inside `parent`.
#[cfg(windows)]
pub(super) fn open_dir_nofollow(parent: &Dir, name: &OsStr) -> io::Result<Dir> {
    use cap_std::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, GetFileInformationByHandle,
    };
    let _ = validate_component(name)?;
    let mut opts = cap_std::fs::OpenOptions::new();
    opts.read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    let file = parent.open_with(name, &opts)?.into_std();
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `file` owns the handle and `info` is valid writable memory for this call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
    {
        return Err(io::Error::new(ErrorKind::InvalidInput, "Not a physical directory"));
    }
    Ok(Dir::from_std_file(file))
}

#[cfg(not(windows))]
pub(super) fn open_dir_nofollow(parent: &Dir, name: &OsStr) -> io::Result<Dir> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    let c_name = validate_component(name)?;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: `parent` owns the fd and `c_name` is a valid NUL-terminated C string.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), c_name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `fd` is a newly opened owned file descriptor from `openat`.
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    Ok(Dir::from_std_file(fs::File::from(owned)))
}

/// Creates a single direct child directory of `parent` strictly relative to `parent`'s open OS
/// handle (`NtCreateFile` with `RootDirectory` on Windows, `mkdirat` on Unix), never rebuilding a
/// filesystem path.
#[cfg(windows)]
pub(super) fn create_dir_anchored(parent: &Dir, name: &OsStr) -> io::Result<()> {
    use std::{
        mem::size_of,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr::{null, null_mut},
    };
    use windows_sys::{
        Wdk::{
            Foundation::OBJECT_ATTRIBUTES,
            Storage::FileSystem::{
                FILE_CREATE, FILE_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT, NtCreateFile,
            },
        },
        Win32::{
            Foundation::{HANDLE, STATUS_SUCCESS, UNICODE_STRING},
            Storage::FileSystem::{
                FILE_ATTRIBUTE_NORMAL, FILE_LIST_DIRECTORY, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
                SYNCHRONIZE,
            },
            System::IO::IO_STATUS_BLOCK,
        },
    };

    let mut wide = validate_component(name)?;
    let byte_len = (wide.len() * 2) as u16;
    let obj_name = UNICODE_STRING { Length: byte_len, MaximumLength: byte_len, Buffer: wide.as_mut_ptr() };
    let oa = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &obj_name,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let mut handle: HANDLE = null_mut();
    let mut iosb: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    // SAFETY: `parent` owns `RootDirectory`, `obj_name` points into live `wide`, and output buffers are valid.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_LIST_DIRECTORY | SYNCHRONIZE,
            &oa,
            &mut iosb,
            null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_CREATE,
            FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    };
    if status != STATUS_SUCCESS {
        return Err(nt_status_to_io(status));
    }
    if !handle.is_null() {
        // SAFETY: `NtCreateFile` returned a freshly created owned handle.
        let _owned = unsafe { OwnedHandle::from_raw_handle(handle) };
    }
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn create_dir_anchored(parent: &Dir, name: &OsStr) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let c_name = validate_component(name)?;
    // SAFETY: `parent` owns the fd and `c_name` is a valid NUL-terminated C string.
    if unsafe { libc::mkdirat(parent.as_raw_fd(), c_name.as_ptr(), 0o777) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Enumerates direct entry names of `dir` strictly through its open OS handle, without
/// reconstructing paths (`GetFileInformationByHandleEx` on Windows, `fdopendir` on Unix).
#[cfg(windows)]
pub(super) fn list_dir_entries_anchored(dir: &Dir) -> io::Result<Vec<OsString>> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::{
        Foundation::ERROR_NO_MORE_FILES,
        Storage::FileSystem::{
            FILE_FULL_DIR_INFO, FileFullDirectoryInfo, FileFullDirectoryRestartInfo, GetFileInformationByHandleEx,
        },
    };

    let handle = dir.as_raw_handle();
    let mut entries = Vec::new();
    // 8-byte aligned buffer for `FILE_FULL_DIR_INFO` records.
    let mut buf = vec![0u64; 2048];
    let buf_bytes = buf.len() * std::mem::size_of::<u64>();
    let mut first = true;
    loop {
        let class = if first { FileFullDirectoryRestartInfo } else { FileFullDirectoryInfo };
        first = false;
        // SAFETY: `handle` is live and `buf` has valid aligned storage of `buf_bytes` bytes.
        let ok = unsafe { GetFileInformationByHandleEx(handle, class, buf.as_mut_ptr().cast(), buf_bytes as u32) };
        if ok == 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                break;
            }
            return Err(err);
        }
        let base = buf.as_ptr().cast::<u8>();
        let mut offset = 0usize;
        loop {
            if offset + std::mem::size_of::<FILE_FULL_DIR_INFO>() > buf_bytes {
                return Err(io::Error::new(ErrorKind::InvalidData, "Truncated directory entry record"));
            }
            // SAFETY: `offset` is bounded within `buf` and aligned by Windows to 8 bytes.
            let info = unsafe { &*(base.add(offset).cast::<FILE_FULL_DIR_INFO>()) };
            let name_bytes = info.FileNameLength as usize;
            let name_start = offset + std::mem::offset_of!(FILE_FULL_DIR_INFO, FileName);
            if !name_bytes.is_multiple_of(2) || name_start + name_bytes > buf_bytes {
                return Err(io::Error::new(ErrorKind::InvalidData, "Invalid directory entry name length"));
            }
            // SAFETY: `name_start..name_start + name_bytes` lies inside `buf` with u16 alignment.
            let units = unsafe { std::slice::from_raw_parts(base.add(name_start).cast::<u16>(), name_bytes / 2) };
            let name = OsString::from_wide(units);
            if name != OsStr::new(".") && name != OsStr::new("..") {
                entries.push(name);
            }
            if info.NextEntryOffset == 0 {
                break;
            }
            offset = offset.saturating_add(info.NextEntryOffset as usize);
        }
    }
    Ok(entries)
}

#[cfg(not(windows))]
pub(super) fn list_dir_entries_anchored(dir: &Dir) -> io::Result<Vec<OsString>> {
    let mut out = Vec::new();
    for entry in dir.entries()? {
        out.push(entry?.file_name());
    }
    Ok(out)
}

pub(super) fn is_dir_empty_anchored(dir: &Dir) -> io::Result<bool> {
    Ok(list_dir_entries_anchored(dir)?.is_empty())
}

/// Reads a direct regular file inside `parent` strictly without following symlinks or reparse
/// points. Returns `Ok(None)` when the entry does not exist.
#[cfg(windows)]
pub(super) fn read_file_anchored(parent: &Dir, name: &OsStr) -> io::Result<Option<String>> {
    use cap_std::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_OPEN_REPARSE_POINT, GetFileInformationByHandle,
    };
    let _ = validate_component(name)?;
    let mut opts = cap_std::fs::OpenOptions::new();
    opts.read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let mut file = match parent.open_with(name, &opts) {
        Ok(f) => f.into_std(),
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `file` owns the handle and `info` is valid writable memory.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) != 0 {
        return Err(io::Error::new(ErrorKind::InvalidInput, "Registry file is not a regular file"));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(Some(text))
}

#[cfg(not(windows))]
pub(super) fn read_file_anchored(parent: &Dir, name: &OsStr) -> io::Result<Option<String>> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    let c_name = validate_component(name)?;
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: `parent` owns the fd and `c_name` is a valid NUL-terminated C string.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), c_name.as_ptr(), flags) };
    if fd < 0 {
        let err = io::Error::last_os_error();
        return if err.kind() == ErrorKind::NotFound { Ok(None) } else { Err(err) };
    }
    // SAFETY: `fd` is a newly opened owned file descriptor from `openat`.
    let mut file = fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(ErrorKind::InvalidInput, "Registry file is not a regular file"));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(Some(text))
}

/// Atomically writes and replaces `name` inside `parent` strictly relative to `parent`'s open OS
/// handle (no ambient paths, no symlink following).
#[cfg(windows)]
pub(super) fn write_file_atomic_anchored(parent: &Dir, name: &OsStr, body: &[u8]) -> io::Result<()> {
    use std::{
        mem::{offset_of, size_of},
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr::{null, null_mut},
    };
    use windows_sys::{
        Wdk::{
            Foundation::OBJECT_ATTRIBUTES,
            Storage::FileSystem::{
                FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION,
                FILE_RENAME_INFORMATION_0, FILE_SYNCHRONOUS_IO_NONALERT, FileRenameInformation, NtCreateFile,
                NtSetInformationFile,
            },
        },
        Win32::{
            Foundation::{HANDLE, STATUS_SUCCESS, UNICODE_STRING},
            Storage::FileSystem::{
                DELETE, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_DATA,
                SYNCHRONIZE,
            },
            System::IO::IO_STATUS_BLOCK,
        },
    };

    let dst_wide = validate_component(name)?;
    let tmp_name = OsString::from(format!("{}.{}.tmp", name.to_string_lossy(), uuid::Uuid::new_v4().simple()));
    let mut tmp_wide = validate_component(&tmp_name)?;
    let tmp_bytes = (tmp_wide.len() * 2) as u16;
    let obj_name = UNICODE_STRING { Length: tmp_bytes, MaximumLength: tmp_bytes, Buffer: tmp_wide.as_mut_ptr() };
    let oa = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &obj_name,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let mut handle: HANDLE = null_mut();
    let mut iosb: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    // SAFETY: `parent` owns `RootDirectory`, `obj_name` points into live `tmp_wide`, and output buffers are valid.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            DELETE | FILE_WRITE_DATA | SYNCHRONIZE,
            &oa,
            &mut iosb,
            null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    };
    if status != STATUS_SUCCESS {
        return Err(nt_status_to_io(status));
    }
    // SAFETY: `NtCreateFile` returned a freshly created owned handle.
    let mut file = fs::File::from(unsafe { OwnedHandle::from_raw_handle(handle) });
    if let Err(err) = file.write_all(body).and_then(|()| file.flush()) {
        drop(file);
        let _ = delete_entry_anchored(parent, &tmp_name, false, None, None);
        return Err(err);
    }

    let name_bytes = dst_wide.len() * 2;
    let total_bytes =
        (offset_of!(FILE_RENAME_INFORMATION, FileName) + name_bytes).max(size_of::<FILE_RENAME_INFORMATION>());
    let words = total_bytes.div_ceil(size_of::<u64>());
    let mut buf = vec![0u64; words];
    let info_ptr = buf.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    // SAFETY: `buf` is 8-byte aligned and at least `total_bytes` long, covering header + `dst_wide`.
    unsafe {
        (*info_ptr).Anonymous = FILE_RENAME_INFORMATION_0 { ReplaceIfExists: true };
        (*info_ptr).RootDirectory = parent.as_raw_handle();
        (*info_ptr).FileNameLength = name_bytes as u32;
        let dst_ptr = buf.as_mut_ptr().cast::<u8>().add(offset_of!(FILE_RENAME_INFORMATION, FileName)).cast::<u16>();
        std::ptr::copy_nonoverlapping(dst_wide.as_ptr(), dst_ptr, dst_wide.len());
    }
    let mut rename_iosb: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    // SAFETY: `file` owns its handle and `buf` holds a valid `FILE_RENAME_INFORMATION` payload of `total_bytes`.
    let rename_status = unsafe {
        NtSetInformationFile(
            file.as_raw_handle(),
            &mut rename_iosb,
            buf.as_ptr().cast(),
            total_bytes as u32,
            FileRenameInformation,
        )
    };
    drop(file);
    if rename_status != STATUS_SUCCESS {
        let _ = delete_entry_anchored(parent, &tmp_name, false, None, None);
        return Err(nt_status_to_io(rename_status));
    }
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn write_file_atomic_anchored(parent: &Dir, name: &OsStr, body: &[u8]) -> io::Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    let c_dst = validate_component(name)?;
    let tmp_name = OsString::from(format!("{}.{}.tmp", name.to_string_lossy(), uuid::Uuid::new_v4().simple()));
    let c_tmp = validate_component(&tmp_name)?;
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: `parent` owns the fd and `c_tmp` is a valid NUL-terminated C string.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), c_tmp.as_ptr(), flags, 0o600 as libc::c_uint) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `fd` is a newly created owned file descriptor from `openat`.
    let mut file = fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    if let Err(err) = file.write_all(body).and_then(|()| file.flush()) {
        drop(file);
        let _ = delete_entry_anchored(parent, &tmp_name, false, None, None);
        return Err(err);
    }
    drop(file);
    // SAFETY: `parent` owns the fd and both `c_tmp` and `c_dst` are valid NUL-terminated C strings.
    if unsafe { libc::renameat(parent.as_raw_fd(), c_tmp.as_ptr(), parent.as_raw_fd(), c_dst.as_ptr()) } != 0 {
        let err = io::Error::last_os_error();
        let _ = delete_entry_anchored(parent, &tmp_name, false, None, None);
        return Err(err);
    }
    Ok(())
}

/// Verifies `root` stays inside `scope`, opens its anchor without following symlinks, creates any
/// missing directories strictly through open handles (`create_dir_anchored` + `open_dir_nofollow`),
/// and returns the canonical root path together with its verified open `Dir` handle.
///
/// When `scope` is non-empty, components under `scope` are never pre-canonicalized so any
/// preexisting symlink/junction inside `scope` is refused. When `scope` is empty (unrestricted
/// mode), the parent prefix may resolve OS symlinks (e.g. macOS `/var -> /private/var`), while the
/// final leaf component is always opened/created without following symlinks.
pub(super) fn ensure_verified_root(root: &Path, scope: &Path) -> Result<(PathBuf, Dir), String> {
    use std::path::Component;
    if !root.is_absolute() {
        return Err("Temporary workspaces root must be absolute".into());
    }
    if !scope.as_os_str().is_empty() {
        if !scope.is_absolute() {
            return Err("Authorized workspace scope must be absolute".into());
        }
        let rel = root
            .strip_prefix(scope)
            .map_err(|_| "Temporary workspaces root is outside authorized workspace scope".to_owned())?;
        let mut cur = open_verified_ancestor(scope, scope)?;
        let mut resolved = scope.to_path_buf();
        for comp in rel.components() {
            match comp {
                Component::Normal(seg) => {
                    cur = open_or_create_dir_anchored(&cur, seg)?;
                    resolved.push(seg);
                }
                Component::CurDir => {}
                _ => return Err("Temporary workspaces root path contains disallowed component".into()),
            }
        }
        verify_open_root_handle(&cur, &resolved, scope)?;
        return Ok((resolved, cur));
    }

    let Some(leaf) = root.file_name() else {
        return Err("Temporary workspaces root must have a directory name".into());
    };
    let Some(parent) = root.parent() else {
        return Err("Temporary workspaces root must have a parent directory".into());
    };
    let mut existing = parent.to_path_buf();
    let mut parent_tail: Vec<OsString> = Vec::new();
    loop {
        match fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                let Some(name) = existing.file_name() else {
                    return Err("Temporary workspaces root has no existing ancestor".into());
                };
                parent_tail.push(name.to_os_string());
                let Some(up) = existing.parent() else {
                    return Err("Temporary workspaces root has no existing ancestor".into());
                };
                existing = up.to_path_buf();
            }
            Err(err) => return Err(format!("Failed to inspect temporary root ancestor: {err}")),
        }
    }
    parent_tail.reverse();

    let canonical_ancestor =
        dunce::canonicalize(&existing).map_err(|e| format!("Failed to resolve temporary root ancestor: {e}"))?;
    let mut cur = open_verified_ancestor(&canonical_ancestor, scope)?;
    let mut resolved = canonical_ancestor;
    for seg in &parent_tail {
        cur = open_or_create_dir_anchored(&cur, seg)?;
        resolved.push(seg);
    }
    cur = open_or_create_dir_anchored(&cur, leaf)?;
    resolved.push(leaf);
    verify_open_root_handle(&cur, &resolved, scope)?;
    Ok((resolved, cur))
}

fn open_or_create_dir_anchored(parent: &Dir, seg: &OsStr) -> Result<Dir, String> {
    let dir = match open_dir_nofollow(parent, seg) {
        Ok(dir) => dir,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            match create_dir_anchored(parent, seg) {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
                Err(e) => return Err(format!("Failed to create temporary root directory: {e}")),
            }
            open_dir_nofollow(parent, seg)
                .map_err(|e| format!("Failed to open created temporary root component without symlinks: {e}"))?
        }
        Err(err) => return Err(format!("Failed to open temporary root component without symlinks: {err}")),
    };
    ensure_same_mount(parent, &dir).map_err(|e| format!("Temporary workspaces root crosses mount boundary: {e}"))?;
    Ok(dir)
}

pub(super) fn open_verified_scope(scope: &Path) -> Result<Dir, String> {
    open_verified_ancestor(scope, scope)
}

fn open_verified_ancestor(canonical_ancestor: &Path, scope: &Path) -> Result<Dir, String> {
    #[cfg(not(windows))]
    {
        use std::path::Component;
        let _ = scope;
        let rel = canonical_ancestor
            .strip_prefix(Path::new("/"))
            .map_err(|_| "Temporary workspaces root must be absolute".to_owned())?;
        let mut cur = Dir::open_ambient_dir(Path::new("/"), ambient_authority())
            .map_err(|e| format!("Failed to open filesystem root: {e}"))?;
        for comp in rel.components() {
            match comp {
                Component::Normal(seg) => {
                    cur = open_dir_nofollow(&cur, seg)
                        .map_err(|e| format!("Failed to open temporary root component without symlinks: {e}"))?;
                }
                Component::CurDir => {}
                _ => return Err("Temporary workspaces root path contains disallowed component".into()),
            }
        }
        Ok(cur)
    }

    #[cfg(windows)]
    {
        let dir = Dir::open_ambient_dir(canonical_ancestor, ambient_authority())
            .map_err(|e| format!("Failed to open temporary root handle: {e}"))?;
        verify_open_root_handle(&dir, canonical_ancestor, scope)?;
        Ok(dir)
    }
}

#[cfg(windows)]
fn verify_raw_handle_path(
    handle: windows_sys::Win32::Foundation::HANDLE,
    expected_path: &Path,
    scope: &Path,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW};
    let mut buf = vec![0u16; 260];
    let len = loop {
        // SAFETY: `handle` is live and `buf` has capacity `buf.len()`.
        let n = unsafe { GetFinalPathNameByHandleW(handle, buf.as_mut_ptr(), buf.len() as u32, FILE_NAME_NORMALIZED) };
        if n == 0 {
            return Err(format!("Failed to verify temporary root handle path: {}", io::Error::last_os_error()));
        }
        if (n as usize) < buf.len() {
            break n as usize;
        }
        buf.resize(n as usize + 1, 0);
    };
    let final_os = OsString::from_wide(&buf[..len]);
    let resolved = dunce::simplified(Path::new(&final_os));
    if resolved != expected_path || (!scope.as_os_str().is_empty() && !resolved.starts_with(scope)) {
        return Err("Temporary workspaces root handle resolved outside expected directory".into());
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn verify_open_root_handle(dir: &Dir, canonical_root: &Path, scope: &Path) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, GetFileInformationByHandle,
    };
    let handle = dir.as_raw_handle();
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `dir` owns `handle` and `info` is valid writable memory for this call.
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(format!("Failed to inspect temporary root handle: {}", io::Error::last_os_error()));
    }
    if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
    {
        return Err("Temporary workspaces root handle is not a physical directory".into());
    }
    verify_raw_handle_path(handle, canonical_root, scope)
}

#[cfg(target_os = "linux")]
pub(super) fn verify_open_root_handle(dir: &Dir, canonical_root: &Path, scope: &Path) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let handle_meta = dir.dir_metadata().map_err(|e| format!("Failed to stat temporary root handle: {e}"))?;
    if !handle_meta.is_dir() {
        return Err("Temporary workspaces root handle is not a directory".into());
    }
    let resolved = fs::read_link(format!("/proc/self/fd/{}", dir.as_raw_fd()))
        .map_err(|e| format!("Failed to verify temporary root handle path: {e}"))?;
    if resolved != canonical_root || (!scope.as_os_str().is_empty() && !resolved.starts_with(scope)) {
        return Err("Temporary workspaces root handle resolved outside expected directory".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn verify_open_root_handle(dir: &Dir, canonical_root: &Path, scope: &Path) -> Result<(), String> {
    use std::{
        ffi::CStr,
        os::{fd::AsRawFd, unix::ffi::OsStrExt},
    };
    let handle_meta = dir.dir_metadata().map_err(|e| format!("Failed to stat temporary root handle: {e}"))?;
    if !handle_meta.is_dir() {
        return Err("Temporary workspaces root handle is not a directory".into());
    }
    let mut buf = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: `dir` owns the fd and `buf` provides at least `PATH_MAX` writable bytes required by `F_GETPATH`.
    if unsafe { libc::fcntl(dir.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) } < 0 {
        return Err(format!("Failed to verify temporary root handle path: {}", io::Error::last_os_error()));
    }
    let cstr =
        CStr::from_bytes_until_nul(&buf).map_err(|_| "Failed to decode temporary root handle path".to_owned())?;
    let resolved = Path::new(OsStr::from_bytes(cstr.to_bytes()));
    if resolved != canonical_root || (!scope.as_os_str().is_empty() && !resolved.starts_with(scope)) {
        return Err("Temporary workspaces root handle resolved outside expected directory".into());
    }
    Ok(())
}

#[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
pub(super) fn verify_open_root_handle(dir: &Dir, _canonical_root: &Path, _scope: &Path) -> Result<(), String> {
    let handle_meta = dir.dir_metadata().map_err(|e| format!("Failed to stat temporary root handle: {e}"))?;
    if !handle_meta.is_dir() {
        return Err("Temporary workspaces root handle is not a directory".into());
    }
    Ok(())
}

/// Deletes a single direct entry of `parent` strictly by handle/fd without following links.
/// When `require_physical_dir` is true, refuses symlinks/reparse points and non-directories,
/// and returns `ERROR_DIR_NOT_EMPTY` / `DirectoryNotEmpty` atomically if the directory is non-empty.
/// On Windows, `expected_identity` and `expected_path` are verified directly on the opened `DELETE`
/// handle before setting `FileDispositionInfo`, eliminating any close-then-reopen swap window.
#[cfg(windows)]
pub(super) fn delete_entry_anchored(
    parent: &Dir,
    name: &OsStr,
    require_physical_dir: bool,
    expected_identity: Option<DirIdentity>,
    expected_path: Option<(&Path, &Path)>,
) -> io::Result<()> {
    use cap_std::fs::OpenOptionsExt;
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_WRITE_ATTRIBUTES, FileBasicInfo, FileDispositionInfo,
        GetFileInformationByHandle, SetFileInformationByHandle,
    };

    let _ = validate_component(name)?;
    let open = |access: u32| {
        let mut opts = cap_std::fs::OpenOptions::new();
        opts.access_mode(access).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
        parent.open_with(name, &opts).map(cap_std::fs::File::into_std)
    };
    let (file, can_write_attrs) = match open(DELETE | FILE_WRITE_ATTRIBUTES) {
        Ok(f) => (f, true),
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(_) => match open(DELETE) {
            Ok(f) => (f, false),
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err),
        },
    };
    let handle = file.as_raw_handle();
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `file` owns `handle` and `info` is valid writable memory for this call.
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if require_physical_dir
        && ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
            || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
    {
        return Err(io::Error::new(ErrorKind::InvalidInput, "Temporary workspace folder identity changed"));
    }
    if let Some(expected_id) = expected_identity {
        let ino = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        let actual_id = DirIdentity { dev: u64::from(info.dwVolumeSerialNumber), ino };
        if actual_id != expected_id {
            return Err(io::Error::new(ErrorKind::InvalidInput, "Temporary workspace folder identity changed"));
        }
    }
    if let Some((expected_entry, scope)) = expected_path {
        verify_raw_handle_path(handle, expected_entry, scope)
            .map_err(|m| io::Error::new(ErrorKind::InvalidInput, m))?;
    }
    if can_write_attrs && (info.dwFileAttributes & FILE_ATTRIBUTE_READONLY) != 0 {
        let cleared = info.dwFileAttributes & !FILE_ATTRIBUTE_READONLY;
        let basic = FILE_BASIC_INFO {
            CreationTime: 0,
            LastAccessTime: 0,
            LastWriteTime: 0,
            ChangeTime: 0,
            FileAttributes: if cleared == 0 { FILE_ATTRIBUTE_NORMAL } else { cleared },
        };
        // SAFETY: `handle` is live and `basic` matches `FileBasicInfo` layout.
        let _ = unsafe {
            SetFileInformationByHandle(
                handle,
                FileBasicInfo,
                (&raw const basic).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        };
    }
    let disp = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: `handle` is live and `disp` matches `FileDispositionInfo` layout.
    if unsafe {
        SetFileInformationByHandle(
            handle,
            FileDispositionInfo,
            (&raw const disp).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    drop(file);
    Ok(())
}

/// POSIX kernel limit: Unix provides neither `unlink_by_fd` nor an atomic
/// verify-parent-path-and-`unlinkat` syscall. We check `(st_dev, st_ino)` via
/// `fstatat(AT_SYMLINK_NOFOLLOW)` immediately before `unlinkat` while callers keep the target
/// directory fd open to prevent inode recycling.
#[cfg(not(windows))]
pub(super) fn delete_entry_anchored(
    parent: &Dir,
    name: &OsStr,
    require_physical_dir: bool,
    expected_identity: Option<DirIdentity>,
    expected_path: Option<(&Path, &Path)>,
) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let _ = expected_path;
    let c_name = validate_component(name)?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: `parent` owns the fd, `c_name` is a valid NUL-terminated C string, and `st` is writable.
    if unsafe { libc::fstatat(parent.as_raw_fd(), c_name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        let err = io::Error::last_os_error();
        if err.kind() == ErrorKind::NotFound {
            return Ok(());
        }
        return Err(err);
    }
    let is_dir = (st.st_mode & libc::S_IFMT) == libc::S_IFDIR;
    if require_physical_dir && !is_dir {
        return Err(io::Error::new(ErrorKind::InvalidInput, "Temporary workspace folder identity changed"));
    }
    if let Some(expected_id) = expected_identity {
        #[allow(clippy::unnecessary_cast)]
        let actual = DirIdentity { dev: st.st_dev as u64, ino: st.st_ino as u64 };
        if actual != expected_id {
            return Err(io::Error::new(ErrorKind::InvalidInput, "Temporary workspace folder identity changed"));
        }
    }
    let flags = if is_dir { libc::AT_REMOVEDIR } else { 0 };
    // SAFETY: `parent` owns the fd and `c_name` is a valid NUL-terminated C string.
    if unsafe { libc::unlinkat(parent.as_raw_fd(), c_name.as_ptr(), flags) } != 0 {
        let err = io::Error::last_os_error();
        if err.kind() == ErrorKind::NotFound {
            return Ok(());
        }
        return Err(err);
    }
    Ok(())
}

/// Physical directory identity (`(volume_serial, file_index)` on Windows, `(st_dev, st_ino)` on
/// Unix) captured from an already-open directory handle so replacing a temporary folder at the same
/// path with a different directory is refused before deletion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(super) struct DirIdentity {
    pub(super) dev: u64,
    pub(super) ino: u64,
}

#[cfg(windows)]
pub(super) fn dir_identity(dir: &Dir) -> io::Result<DirIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `dir` owns the handle and `info` is valid writable memory.
    if unsafe { GetFileInformationByHandle(dir.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let ino = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok(DirIdentity { dev: u64::from(info.dwVolumeSerialNumber), ino })
}

#[cfg(not(windows))]
pub(super) fn dir_identity(dir: &Dir) -> io::Result<DirIdentity> {
    use std::os::fd::AsRawFd;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: `dir` owns the fd and `st` is valid writable memory for `fstat`.
    if unsafe { libc::fstat(dir.as_raw_fd(), &mut st) } != 0 {
        return Err(io::Error::last_os_error());
    }
    #[allow(clippy::unnecessary_cast)]
    Ok(DirIdentity { dev: st.st_dev as u64, ino: st.st_ino as u64 })
}

#[cfg(target_os = "linux")]
fn linux_mount_id(dir: &Dir) -> io::Result<u64> {
    use std::os::fd::AsRawFd;
    let info = fs::read_to_string(format!("/proc/self/fdinfo/{}", dir.as_raw_fd()))?;
    for line in info.lines() {
        if let Some(rest) = line.strip_prefix("mnt_id:") {
            return rest
                .trim()
                .parse::<u64>()
                .map_err(|_| io::Error::new(ErrorKind::InvalidData, "Invalid mount id in fdinfo"));
        }
    }
    Err(io::Error::new(ErrorKind::InvalidData, "Missing mount id in fdinfo"))
}

/// Ensures `child` resides on the same filesystem and mount point as `parent` (catching both
/// cross-device mounts via `dev` and same-filesystem Linux bind mounts via `/proc/self/fdinfo`
/// `mnt_id`).
pub(super) fn ensure_same_mount(parent: &Dir, child: &Dir) -> io::Result<()> {
    if dir_identity(parent)?.dev != dir_identity(child)?.dev {
        return Err(io::Error::new(ErrorKind::InvalidInput, "Temporary workspace crosses filesystem mount boundary"));
    }
    #[cfg(target_os = "linux")]
    if linux_mount_id(parent)? != linux_mount_id(child)? {
        return Err(io::Error::new(ErrorKind::InvalidInput, "Temporary workspace crosses mount point"));
    }
    Ok(())
}

/// Read-only preflight walk verifying that no physical subdirectory beneath `dir` crosses a
/// filesystem or Linux bind-mount boundary before irreversible conversation/tab removal.
pub(super) fn verify_tree_same_mount(dir: &Dir, expected_dir: &Path, scope: &Path) -> io::Result<()> {
    verify_open_root_handle(dir, expected_dir, scope).map_err(|m| io::Error::new(ErrorKind::InvalidInput, m))?;
    for entry_name in list_dir_entries_anchored(dir)? {
        let expected_entry = expected_dir.join(&entry_name);
        match open_dir_nofollow(dir, &entry_name) {
            Ok(sub) => {
                verify_open_root_handle(&sub, &expected_entry, scope)
                    .map_err(|m| io::Error::new(ErrorKind::InvalidInput, m))?;
                ensure_same_mount(dir, &sub)?;
                verify_tree_same_mount(&sub, &expected_entry, scope)?;
            }
            Err(err) if err.kind() == ErrorKind::NotFound || is_not_physical_dir(&err) => {}
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

/// Recursively deletes `name` under `parent` strictly via `open_dir_nofollow` handles,
/// handle-anchored enumeration and handle-based unlinks, verifying live kernel handle paths
/// against `expected_parent` / `scope`, same-mount boundaries, and `expected_identity` on the
/// target folder at every directory level without ever following links or crossing mount points.
pub(super) fn remove_dir_all_anchored(
    parent: &Dir,
    name: &OsStr,
    expected_parent: &Path,
    scope: &Path,
    expected_identity: Option<DirIdentity>,
) -> io::Result<()> {
    verify_open_root_handle(parent, expected_parent, scope).map_err(|m| io::Error::new(ErrorKind::InvalidInput, m))?;
    let expected_child = expected_parent.join(name);
    let child = match open_dir_nofollow(parent, name) {
        Ok(dir) => dir,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(err) if is_not_physical_dir(&err) => {
            return Err(io::Error::new(ErrorKind::InvalidInput, "Temporary workspace folder identity changed"));
        }
        Err(err) => return Err(err),
    };
    verify_open_root_handle(&child, &expected_child, scope).map_err(|m| io::Error::new(ErrorKind::InvalidInput, m))?;
    ensure_same_mount(parent, &child)?;
    let child_id = dir_identity(&child)?;
    if let Some(expected_id) = expected_identity
        && child_id != expected_id
    {
        return Err(io::Error::new(ErrorKind::InvalidInput, "Temporary workspace folder identity changed"));
    }
    remove_children_anchored(&child, &expected_child, scope)?;
    #[cfg(windows)]
    drop(child);
    verify_open_root_handle(parent, expected_parent, scope).map_err(|m| io::Error::new(ErrorKind::InvalidInput, m))?;
    let res = delete_entry_anchored(parent, name, true, Some(child_id), Some((&expected_child, scope)));
    #[cfg(not(windows))]
    drop(child);
    res
}

pub(super) fn is_not_physical_dir(err: &io::Error) -> bool {
    if matches!(err.kind(), ErrorKind::InvalidInput | ErrorKind::NotADirectory) {
        return true;
    }
    #[cfg(not(windows))]
    {
        if matches!(err.raw_os_error(), Some(code) if code == libc::ELOOP || code == libc::ENOTDIR) {
            return true;
        }
    }
    false
}

fn remove_children_anchored(dir: &Dir, expected_dir: &Path, scope: &Path) -> io::Result<()> {
    verify_open_root_handle(dir, expected_dir, scope).map_err(|m| io::Error::new(ErrorKind::InvalidInput, m))?;
    for entry_name in list_dir_entries_anchored(dir)? {
        let expected_entry = expected_dir.join(&entry_name);
        match open_dir_nofollow(dir, &entry_name) {
            Ok(sub) => {
                verify_open_root_handle(&sub, &expected_entry, scope)
                    .map_err(|m| io::Error::new(ErrorKind::InvalidInput, m))?;
                ensure_same_mount(dir, &sub)?;
                let sub_id = dir_identity(&sub)?;
                remove_children_anchored(&sub, &expected_entry, scope)?;
                #[cfg(windows)]
                drop(sub);
                verify_open_root_handle(dir, expected_dir, scope)
                    .map_err(|m| io::Error::new(ErrorKind::InvalidInput, m))?;
                let res = delete_entry_anchored(dir, &entry_name, true, Some(sub_id), Some((&expected_entry, scope)));
                #[cfg(not(windows))]
                drop(sub);
                res?;
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) if is_not_physical_dir(&err) => {
                verify_open_root_handle(dir, expected_dir, scope)
                    .map_err(|m| io::Error::new(ErrorKind::InvalidInput, m))?;
                // Regular file, symlink, or Windows junction: unlink the entry directly without traversing.
                delete_entry_anchored(dir, &entry_name, false, None, None)?;
            }
            Err(err) => return Err(err),
        }
    }
    Ok(())
}
