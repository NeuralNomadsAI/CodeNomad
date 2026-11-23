//! Stage bytes beside the physical target before replacing its name.
#[cfg(unix)]
mod metadata;
use std::{
    fs::{self, File, OpenOptions},
    hash::{DefaultHasher, Hash, Hasher},
    io::{self, Seek},
    path::{Path, PathBuf},
};

use axum::http::StatusCode as Status;
use same_file::Handle;
use uuid::Uuid;

use super::{MAX, bounded, io_error, version};
use crate::{Error, error};

fn changed() -> Error {
    error(Status::CONFLICT, "File changed on disk")
}

pub(super) fn file_identity(path: &Path, conditional: bool) -> Result<Option<u64>, Error> {
    target(path, conditional)?
        .map(|file| Handle::from_file(file).map(|identity| fingerprint(&identity)))
        .transpose()
        .map_err(io_error)
}

fn target(path: &Path, conditional: bool) -> Result<Option<File>, Error> {
    open_original(path)
        .map_err(|err| if conditional && err.kind() == io::ErrorKind::InvalidInput { changed() } else { io_error(err) })
}

pub(super) fn replace(
    path: &Path,
    expected: Option<&str>,
    current: impl FnOnce() -> Result<(), Error>,
    write: impl FnOnce(&mut File) -> io::Result<()>,
) -> Result<(), Error> {
    let mut original = target(path, expected.is_some())?;
    let identity =
        original.as_ref().map(|file| file.try_clone().and_then(Handle::from_file)).transpose().map_err(io_error)?;
    if let Some(expected) = expected {
        let file = original.as_ref().ok_or_else(changed)?;
        if expected != version(&bounded(file, MAX)?) {
            return Err(changed());
        }
    }
    if let Some(file) = original.as_mut()
        && link_count(file).map_err(io_error)? > 1
    {
        // A rename would split the aliases. Keep the original inode, like the TS save.
        current()?;
        if file_identity(path, expected.is_some())? != identity.as_ref().map(fingerprint) {
            return Err(changed());
        }
        file.rewind().map_err(io_error)?;
        file.set_len(0).map_err(io_error)?;
        write(file).map_err(io_error)?;
        return file.sync_all().map_err(io_error);
    }
    let parent = path.parent().ok_or_else(super::unavailable)?;
    let directory = directory_identity(parent).map_err(io_error)?;
    let staging = original.is_some().then(|| PrivateStage::new(parent)).transpose().map_err(io_error)?;
    let temp = staging.as_ref().map_or_else(
        || parent.join(format!(".codenomad-save-{}.tmp", Uuid::new_v4())),
        |stage| stage.0.join("write.tmp"),
    );
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if original.is_some() {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut staged = options.open(&temp).map_err(io_error)?;
    let staged_id = fingerprint(&Handle::from_file(staged.try_clone().map_err(io_error)?).map_err(io_error)?);
    let cleanup = Temporary(temp, staged_id);
    write(&mut staged).map_err(io_error)?;
    #[cfg(unix)]
    if let Some(file) = &original {
        metadata::copy(file, &staged).map_err(io_error)?;
    }
    staged.sync_all().map_err(io_error)?;
    drop(staged);
    current()?;
    if directory_identity(parent).ok().as_ref() != Some(&directory)
        || staging.as_ref().is_some_and(|stage| !stage.current())
        || file_identity(&cleanup.0, false)? != Some(cleanup.1)
    {
        return Err(changed());
    }
    match target(path, expected.is_some())? {
        Some(actual) if identity.is_some() && link_count(&actual).map_err(io_error)? == 1 => {
            let same = actual.try_clone().and_then(Handle::from_file).map_err(io_error)?;
            if Some(&same) != identity.as_ref() {
                return Err(changed());
            }
            if let Some(expected) = expected
                && expected != version(&bounded(&actual, MAX)?)
            {
                return Err(changed());
            }
            // ReplaceFileW opens the staged file without sharing. Leave no
            // outstanding write handles on either file at publication.
            drop((actual, same, identity, original));
            publish(&cleanup.0, path, true).map_err(io_error)
        }
        None if identity.is_none() => publish(&cleanup.0, path, false).map_err(io_error),
        _ => Err(changed()),
    }
}

fn fingerprint(handle: &Handle) -> u64 {
    let mut hash = DefaultHasher::new();
    handle.hash(&mut hash);
    hash.finish()
}

struct Temporary(PathBuf, u64);
impl Drop for Temporary {
    fn drop(&mut self) {
        if file_identity(&self.0, false).ok().flatten() == Some(self.1) {
            let _ = fs::remove_file(&self.0);
        }
    }
}

struct PrivateStage(PathBuf, u64);
impl PrivateStage {
    fn new(parent: &Path) -> io::Result<Self> {
        let dir = parent.join(format!(".codenomad-save-{}", Uuid::new_v4()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&dir)?;
        }
        #[cfg(windows)]
        create_private_stage(&dir)?;
        let identity = directory_identity(&dir).map(|identity| fingerprint(&identity.0)).inspect_err(|_| {
            let _ = fs::remove_dir(&dir);
        })?;
        Ok(Self(dir, identity))
    }

    fn current(&self) -> bool {
        directory_identity(&self.0).ok().map(|identity| fingerprint(&identity.0)) == Some(self.1)
    }
}

impl Drop for PrivateStage {
    fn drop(&mut self) {
        if self.current() {
            // A backup left after a failed restore is never removed here.
            let _ = fs::remove_dir(&self.0);
        }
    }
}

#[derive(PartialEq)]
struct DirectoryIdentity(Handle);
fn directory_identity(path: &Path) -> io::Result<DirectoryIdentity> {
    let directory = cap_std::fs::Dir::open_ambient_dir(path, cap_std::ambient_authority())?;
    Handle::from_file(directory.into_std_file()).map(DirectoryIdentity)
}

#[cfg(windows)]
fn create_private_stage(path: &Path) -> io::Result<()> {
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

fn open_original(path: &Path) -> io::Result<Option<File>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => return Err(io::ErrorKind::InvalidInput.into()),
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    Ok(Some(file))
}

#[cfg(unix)]
fn link_count(file: &File) -> io::Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata()?.nlink())
}

#[cfg(windows)]
fn link_count(file: &File) -> io::Result<u64> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: file owns the handle and info is writable for this call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info.nNumberOfLinks.into())
}

#[cfg(unix)]
fn publish(temp: &Path, path: &Path, exists: bool) -> io::Result<()> {
    if exists { fs::rename(temp, path) } else { fs::hard_link(temp, path) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn an_error_after_a_partial_write_leaves_original_and_version_intact() {
        let dir = crate::shared::test_dir("atomic-save");
        let path = dir.join("note.txt");
        fs::write(&path, b"old contents").unwrap();
        let tag = version(b"old contents");
        let error = replace(
            &path,
            Some(&tag),
            || Ok(()),
            |file| {
                file.write_all(b"new but incomplete")?;
                Err(io::Error::other("injected write failure"))
            },
        );
        assert!(error.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old contents");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        replace(&path, Some(&tag), || Ok(()), |file| file.write_all(b"new")).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_external_edit_while_preparing_the_save_keeps_its_contents() {
        let dir = crate::shared::test_dir("atomic-save-conflict");
        let path = dir.join("note.txt");
        fs::write(&path, b"old").unwrap();
        let result = replace(
            &path,
            Some(&version(b"old")),
            || Ok(()),
            |file| {
                file.write_all(b"our edit")?;
                fs::write(&path, b"external edit")
            },
        );
        assert_eq!(result.unwrap_err().0, Status::CONFLICT);
        assert_eq!(fs::read(&path).unwrap(), b"external edit");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn replacing_a_windows_file_keeps_its_named_stream() {
        let dir = crate::shared::test_dir("atomic-save-stream");
        let path = dir.join("note.txt");
        let stream = dir.join("note.txt:fixture");
        fs::write(&path, b"old").unwrap();
        fs::write(&stream, b"metadata").unwrap();
        replace(&path, None, || Ok(()), |file| file.write_all(b"new")).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read(&stream).unwrap(), b"metadata");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hard_links_keep_their_identity_and_see_the_new_shorter_contents() {
        let dir = crate::shared::test_dir("atomic-save-hardlinks");
        let (path, alias) = (dir.join("note.txt"), dir.join("alias.txt"));
        fs::write(&path, b"old contents").unwrap();
        fs::hard_link(&path, &alias).unwrap();
        let etag = version(b"old contents");
        replace(&path, Some(&etag), || Ok(()), |file| file.write_all(b"new")).unwrap();
        assert_eq!(Handle::from_path(&path).unwrap(), Handle::from_path(&alias).unwrap());
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read(&alias).unwrap(), b"new");
        assert!(!replace(&alias, Some(&etag), || Ok(()), |_| panic!("must refuse before writing")).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_refused_without_opening_a_blocked_reader() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let dir = crate::shared::test_dir("atomic-save-fifo");
        let pipe = dir.join("pipe");
        let name = CString::new(pipe.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is an owned, NUL-terminated path inside the test directory.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert_eq!(file_identity(&pipe, false).unwrap_err().0, Status::BAD_REQUEST);
        assert_eq!(file_identity(&pipe, true).unwrap_err().0, Status::CONFLICT);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn keeps_mode_and_replaces_a_symlinks_target() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = crate::shared::test_dir("atomic-save-link");
        let (path, alias) = (dir.join("note.txt"), dir.join("alias.txt"));
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
        symlink("note.txt", &alias).unwrap();
        let target = super::super::links::write_target(alias.clone()).unwrap();
        replace(&target, None, || Ok(()), |file| file.write_all(b"new")).unwrap();
        assert_eq!(fs::read_link(&alias).unwrap(), Path::new("note.txt"));
        assert_eq!(fs::read(&alias).unwrap(), b"new");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o750);
        fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(windows)]
fn publish(temp: &Path, path: &Path, exists: bool) -> io::Result<()> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, ReplaceFileW};
    let (from, to) = (wide_path(temp), wide_path(path));
    if !exists {
        // SAFETY: both inputs are live, NUL-terminated Windows paths.
        return if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        };
    }
    let backup = temp.with_extension("backup");
    let original = wide_path(&backup);
    // SAFETY: all inputs are live, NUL-terminated paths; reserved pointers are null.
    if unsafe { ReplaceFileW(to.as_ptr(), from.as_ptr(), original.as_ptr(), 0, null_mut(), null_mut()) } != 0 {
        let _ = fs::remove_file(backup);
        return Ok(());
    }
    let failure = io::Error::last_os_error();
    // Windows can leave the old file under the backup name on a failed rename.
    // Restore only into an empty slot, and keep the backup if restoration fails.
    if backup.is_file() && fs::symlink_metadata(path).is_err_and(|e| e.kind() == io::ErrorKind::NotFound) {
        if let Err(restore) = publish(&backup, path, false) {
            eprintln!("Could not restore the original save target; backup at {}: {restore}", backup.display());
        }
    }
    Err(failure)
}

#[cfg(windows)]
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
