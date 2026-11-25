use super::*;
use std::os::windows::io::AsRawHandle;

const BACKUP: &str = "write.backup";

pub(super) fn create_private_stage(path: &Path) -> io::Result<()> {
    use std::ptr::null_mut;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES},
        Storage::FileSystem::CreateDirectoryW,
    };
    // Protect the directory at creation, before any other principal can open it.
    let rule: Vec<_> = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)".encode_utf16().chain([0]).collect();
    let path = wide_path(path);
    let mut descriptor = null_mut();
    // SAFETY: both strings are terminated, and all output pointers/attributes
    // remain live through the OS call. LocalFree owns the descriptor afterward.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(rule.as_ptr(), 1, &mut descriptor, null_mut()) == 0 {
            return Err(io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let result =
            if CreateDirectoryW(path.as_ptr(), &attributes) != 0 { Ok(()) } else { Err(io::Error::last_os_error()) };
        LocalFree(descriptor);
        result
    }
}

pub(super) fn link_count(file: &File) -> io::Result<u64> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: file owns the handle and info is writable for this call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info.nNumberOfLinks.into())
}

pub(super) fn publish(
    stage: &PrivateStage<'_>,
    leaf: &Path,
    actual: Option<&File>,
) -> Result<Publication, PublishError> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let temp = stage.path.join(STAGED);
    let path = stage.path.with_file_name(leaf);
    let Some(actual) = actual else {
        let file = stage.creation.as_ref().ok_or(PublishError::Changed)?;
        inherit_new_file_acl(stage, file).map_err(PublishError::Unchanged)?;
        rename_new(file, &stage.root.dir, leaf).map_err(PublishError::Unchanged)?;
        return Ok(Publication::Published);
    };
    let (from, to) = (wide_path(&temp), wide_path(&path));
    let backup = stage.path.join(BACKUP);
    let original = wide_path(&backup);
    // ReplaceFileW preserves the DACL and named streams. Reopen through the
    // pinned directory and keep the full ancestor chain pinned while Win32
    // resolves the names. cap-std directory handles omit FILE_SHARE_DELETE.
    let _ancestors = pin_ancestors(stage).map_err(PublishError::Unchanged)?;
    let expected = actual.try_clone().and_then(Handle::from_file).map_err(PublishError::Unchanged)?;
    if stage_file_handle(&stage.root.dir, leaf).ok().as_ref() != Some(&expected) {
        return Err(PublishError::Changed);
    }
    // SAFETY: all inputs are live, NUL-terminated paths; reserved pointers are null.
    if unsafe { ReplaceFileW(to.as_ptr(), from.as_ptr(), original.as_ptr(), 0, null_mut(), null_mut()) } != 0 {
        if stage_file_handle(stage.dir(), Path::new(BACKUP)).ok().as_ref() == Some(&expected) {
            let _ = stage.dir().remove_file(BACKUP);
        }
        return Ok(Publication::Published);
    }
    Err(recover_replacement(stage, leaf, &expected, io::Error::last_os_error()))
}

fn pin_ancestors(stage: &PrivateStage<'_>) -> io::Result<Vec<Dir>> {
    let mut path: Vec<_> = stage.path.ancestors().skip(1).collect();
    path.reverse();
    let mut held: Vec<Dir> = Vec::with_capacity(path.len());
    for ancestor in path {
        let dir = if let Some(parent) = held.last() {
            parent.open_dir(ancestor.file_name().ok_or(io::ErrorKind::InvalidInput)?)?
        } else {
            Dir::open_ambient_dir(ancestor, ambient_authority())?
        };
        held.push(dir);
    }
    let last = held.last().ok_or(io::ErrorKind::InvalidInput)?;
    let id = Handle::from_file(last.try_clone()?.into_std_file())?;
    if id != stage.root.identity
        || Directory::from_dir(last.open_dir(&stage.name)?)?.identity != stage.opened.as_ref().unwrap().identity
    {
        return Err(io::ErrorKind::NotFound.into());
    }
    Ok(held)
}

pub(super) fn create_for_publish(dir: &Dir, options: &cap_std::fs::OpenOptions) -> io::Result<File> {
    use cap_std::fs::OpenOptionsExt;
    use windows_sys::Win32::{
        Foundation::GENERIC_WRITE,
        Storage::FileSystem::{DELETE, WRITE_DAC},
    };
    let mut options = options.clone();
    // Hold the exact file from creation through the rename, without sharing
    // writes or deletion even once the final DACL is installed.
    options.access_mode(GENERIC_WRITE | DELETE | WRITE_DAC).share_mode(0);
    dir.open_with(STAGED, &options).map(cap_std::fs::File::into_std)
}

fn rename_new(file: &File, to: &Dir, name: &Path) -> io::Result<()> {
    use std::{
        mem::{offset_of, size_of},
        os::windows::ffi::OsStrExt,
    };
    use windows_sys::{
        Wdk::Storage::FileSystem::{FileRenameInformation, NtSetInformationFile},
        Win32::{
            Foundation::RtlNtStatusToDosError, Storage::FileSystem::FILE_RENAME_INFO, System::IO::IO_STATUS_BLOCK,
        },
    };
    let name: Vec<_> = name.as_os_str().encode_wide().chain([0]).collect();
    let bytes = offset_of!(FILE_RENAME_INFO, FileName) + name.len() * size_of::<u16>();
    let mut storage = vec![0usize; bytes.max(size_of::<FILE_RENAME_INFO>()).div_ceil(size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // Win32 FileRenameInfo rejects RootDirectory with ERROR_INVALID_PARAMETER
    // on Windows 11. The NT call accepts the same structure and relative name.
    // SAFETY: the source is synchronous, both handles are live, and storage
    // fits the aligned header and its trailing UTF-16 name.
    unsafe {
        (*info).RootDirectory = to.as_raw_handle();
        (*info).FileNameLength = ((name.len() - 1) * size_of::<u16>()) as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), std::ptr::addr_of_mut!((*info).FileName).cast(), name.len());
        let mut result = IO_STATUS_BLOCK::default();
        let status =
            NtSetInformationFile(file.as_raw_handle(), &mut result, info.cast(), bytes as u32, FileRenameInformation);
        if status >= 0 { Ok(()) } else { Err(io::Error::from_raw_os_error(RtlNtStatusToDosError(status) as i32)) }
    }
}

fn inherit_new_file_acl(stage: &PrivateStage<'_>, staged: &File) -> io::Result<()> {
    use cap_std::fs::OpenOptionsExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::{
        Foundation::{ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED, ERROR_SUCCESS, LocalFree},
        Security::{
            Authorization::{GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo},
            DACL_SECURITY_INFORMATION,
        },
        Storage::FileSystem::FILE_FLAG_DELETE_ON_CLOSE,
    };
    // A same-volume move keeps the staged file's DACL. An empty delete-on-close
    // sibling supplies the normal DACL for a new file in the destination.
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true).write(true).create_new(true).custom_flags(FILE_FLAG_DELETE_ON_CLOSE);
    let file = stage.root.dir.open_with(stage.name.with_extension("acl"), &options)?.into_std();
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: both handles are live; the DACL borrows the descriptor until LocalFree.
    unsafe {
        let result = GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        );
        if matches!(result, ERROR_INVALID_FUNCTION | ERROR_NOT_SUPPORTED) {
            return Ok(()); // FAT/exFAT have no persistent DACL.
        }
        if result != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(result as i32));
        }
        let result = SetSecurityInfo(
            staged.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            dacl,
            null_mut(),
        );
        LocalFree(descriptor);
        if result == ERROR_SUCCESS { Ok(()) } else { Err(io::Error::from_raw_os_error(result as i32)) }
    }
}

pub(super) fn recover_replacement(
    stage: &PrivateStage<'_>,
    leaf: &Path,
    expected: &Handle,
    failure: io::Error,
) -> PublishError {
    use windows_sys::Win32::Foundation::{ERROR_UNABLE_TO_MOVE_REPLACEMENT_2, ERROR_UNABLE_TO_REMOVE_REPLACED};
    let backup = stage.path.join(BACKUP);
    // Only failures known to leave the original in place may fall back.
    match stage.dir().symlink_metadata(BACKUP) {
        Ok(_) => match restore_backup(stage, leaf, expected) {
            Ok(()) => PublishError::Interrupted(failure),
            Err(restore) => PublishError::Interrupted(io::Error::other(format!(
                "{failure}; could not restore the original: {restore}; backup: {}",
                backup.display()
            ))),
        },
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            if can_fallback(&failure) || failure.raw_os_error() == Some(ERROR_UNABLE_TO_REMOVE_REPLACED as i32) {
                PublishError::Unchanged(io::Error::new(io::ErrorKind::PermissionDenied, failure))
            } else if failure.raw_os_error() == Some(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 as i32) {
                PublishError::Interrupted(io::Error::other(format!(
                    "{failure}; original backup unavailable: {}",
                    backup.display()
                )))
            } else {
                PublishError::Interrupted(failure)
            }
        }
        Err(err) => {
            PublishError::Interrupted(io::Error::other(format!("{failure}; could not check the backup: {err}")))
        }
    }
}

fn restore_backup(stage: &PrivateStage<'_>, leaf: &Path, expected: &Handle) -> io::Result<()> {
    use cap_std::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_FLAG_OPEN_REPARSE_POINT};
    let mut options = cap_std::fs::OpenOptions::new();
    options.access_mode(DELETE).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let file = stage.dir().open_with(BACKUP, &options)?.into_std();
    let id = Handle::from_file(file.try_clone()?)?;
    if &id != expected {
        return Err(io::Error::other("Backup identity changed"));
    }
    rename_new(&file, &stage.root.dir, leaf)
}

fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<_> = path.as_os_str().encode_wide().collect();
    let slash = u16::from(b'\\');
    let verbatim = [slash, slash, u16::from(b'?'), slash];
    if path.starts_with(&verbatim) {
        path.into_iter().chain([0]).collect()
    } else if let Some(unc) = path.strip_prefix(&[slash, slash]) {
        verbatim.into_iter().chain("UNC\\".encode_utf16()).chain(unc.iter().copied()).chain([0]).collect()
    } else {
        verbatim.into_iter().chain(path).chain([0]).collect()
    }
}
