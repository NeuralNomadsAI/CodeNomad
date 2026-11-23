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
use cap_std::{ambient_authority, fs::Dir};
use same_file::Handle;
use uuid::Uuid;

use super::{MAX, bounded, version};
use crate::{Error, error};

fn changed() -> Error {
    error(Status::CONFLICT, "File changed on disk")
}

fn save_error(err: io::Error) -> Error {
    error(Status::BAD_REQUEST, &err.to_string())
}

pub(super) fn file_identity(path: &Path, conditional: bool) -> Result<Option<u64>, Error> {
    target(path, conditional)?
        .map(|file| Handle::from_file(file).map(|identity| fingerprint(&identity)))
        .transpose()
        .map_err(save_error)
}

fn target(path: &Path, conditional: bool) -> Result<Option<File>, Error> {
    open_original(path, conditional).map_err(|err| {
        if conditional && err.kind() == io::ErrorKind::InvalidInput { changed() } else { save_error(err) }
    })
}

pub(super) fn replace(
    path: &Path,
    expected: Option<&str>,
    current: impl Fn() -> Result<(), Error>,
    write: impl Fn(&mut File) -> io::Result<()>,
) -> Result<(), Error> {
    replace_with(path, expected, current, write, publish)
}

fn replace_with(
    path: &Path,
    expected: Option<&str>,
    current: impl Fn() -> Result<(), Error>,
    write: impl Fn(&mut File) -> io::Result<()>,
    publish: impl FnOnce(&PrivateStage<'_>, &Path, bool) -> Result<Publication, PublishError>,
) -> Result<(), Error> {
    let parent = path.parent().ok_or_else(super::unavailable)?;
    let leaf = Path::new(path.file_name().ok_or_else(super::unavailable)?);
    let directory = Directory::open(parent);
    let original = target(path, expected.is_some())?;
    let identity =
        original.as_ref().map(|file| file.try_clone().and_then(Handle::from_file)).transpose().map_err(save_error)?;
    check_version(original.as_ref(), expected)?;
    let verify = || {
        current()?;
        let actual = target(path, expected.is_some())?;
        let handle =
            actual.as_ref().map(|file| file.try_clone().and_then(Handle::from_file)).transpose().map_err(save_error)?;
        if handle != identity {
            return Err(changed());
        }
        check_version(actual.as_ref(), expected)?;
        if let Ok(directory) = &directory
            && !directory.current(parent)
        {
            return Err(changed());
        }
        Ok(actual)
    };
    let in_place = || {
        let mut file = verify()?.ok_or_else(changed)?;
        file.rewind().map_err(save_error)?;
        write(&mut file).map_err(save_error)?;
        let len = file.stream_position().map_err(save_error)?;
        file.set_len(len).map_err(save_error)?;
        file.sync_all().map_err(save_error)
    };
    if let Some(file) = &original
        && link_count(file).map_err(save_error)? > 1
    {
        return in_place();
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if original.is_some() {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let exclusive = |directory: &Directory| {
        verify()?;
        let mut file = directory.dir.open_with(leaf, &options).map_err(publication_error)?.into_std();
        write(&mut file).map_err(save_error)?;
        file.sync_all().map_err(save_error)?;
        #[cfg(unix)]
        if let Ok(parent) = directory.dir.open(".") {
            parent.sync_all().map_err(save_error)?;
        }
        Ok(())
    };
    let limitation = |err: io::Error| -> Result<(), Error> {
        if can_fallback(&err) {
            if original.is_some() {
                return in_place();
            }
            if let Ok(directory) = &directory {
                return exclusive(directory);
            }
        }
        Err(save_error(err))
    };
    let directory = match &directory {
        Ok(directory) => directory,
        Err(err) => {
            return limitation(err.raw_os_error().map_or_else(|| err.kind().into(), io::Error::from_raw_os_error));
        }
    };
    let stage = match PrivateStage::new(parent, directory) {
        Ok(stage) => stage,
        Err(err) => return limitation(err),
    };
    let mut staged = match stage.dir().open_with(STAGED, &options) {
        Ok(file) => file.into_std(),
        Err(err) => return limitation(err),
    };
    let staged_id = fingerprint(&Handle::from_file(staged.try_clone().map_err(save_error)?).map_err(save_error)?);
    #[cfg(unix)]
    if let Some(file) = &original
        && let Err(err) = metadata::copy(file, &staged)
    {
        return limitation(err);
    }
    write(&mut staged).map_err(save_error)?;
    staged.sync_all().map_err(save_error)?;
    drop(staged);
    if !stage.current() || stage.file_identity()? != staged_id {
        return Err(changed());
    }
    #[cfg(windows)]
    if original.is_none()
        && let Err(err) = inherit_new_file_acl(&stage)
    {
        return limitation(err);
    }
    #[cfg(unix)]
    let sync_parent = match directory.dir.open(".") {
        Ok(file) => file,
        Err(err) => return limitation(err),
    };
    let actual = verify()?;
    if let Some(actual) = &actual
        && link_count(actual).map_err(save_error)? != 1
    {
        return Err(changed());
    }
    drop(actual);
    match publish(&stage, leaf, original.is_some()) {
        Ok(Publication::Published) => {
            drop(stage);
            #[cfg(unix)]
            sync_parent.sync_all().map_err(save_error)?;
            Ok(())
        }
        #[cfg(unix)]
        Ok(Publication::Exclusive) => exclusive(directory),
        Err(PublishError::Unchanged(err)) if err.kind() == io::ErrorKind::AlreadyExists => Err(changed()),
        Err(PublishError::Unchanged(err)) => limitation(err),
        #[cfg(windows)]
        Err(PublishError::Interrupted(err)) => Err(save_error(err)),
    }
}

fn can_fallback(err: &io::Error) -> bool {
    matches!(err.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported)
        // ERROR_INVALID_FUNCTION (e.g. no ACL support) or ERROR_SHARING_VIOLATION.
        || (cfg!(windows) && matches!(err.raw_os_error(), Some(1 | 32)))
}

fn check_version(file: Option<&File>, expected: Option<&str>) -> Result<(), Error> {
    if let Some(expected) = expected
        && expected != version(&bounded(file.ok_or_else(changed)?, MAX)?)
    {
        return Err(changed());
    }
    Ok(())
}

fn publication_error(err: io::Error) -> Error {
    if err.kind() == io::ErrorKind::AlreadyExists { changed() } else { save_error(err) }
}

fn fingerprint(handle: &Handle) -> u64 {
    let mut hash = DefaultHasher::new();
    handle.hash(&mut hash);
    hash.finish()
}

const STAGED: &str = "write.tmp";

struct PrivateStage<'a> {
    root: &'a Directory,
    path: PathBuf,
    name: PathBuf,
    opened: Option<Directory>,
}

impl<'a> PrivateStage<'a> {
    fn new(parent: &Path, root: &'a Directory) -> io::Result<Self> {
        let name = PathBuf::from(format!(".codenomad-save-{}", Uuid::new_v4()));
        let path = parent.join(&name);
        #[cfg(unix)]
        {
            use cap_std::fs::{DirBuilder, DirBuilderExt};
            let mut builder = DirBuilder::new();
            builder.mode(0o700);
            root.dir.create_dir_with(&name, &builder)?;
        }
        #[cfg(windows)]
        create_private_stage(&path)?;
        let opened = root.dir.open_dir(&name).and_then(Directory::from_dir).inspect_err(|_| {
            let _ = root.dir.remove_dir(&name);
        })?;
        Ok(Self { root, path, name, opened: Some(opened) })
    }

    fn dir(&self) -> &Dir {
        &self.opened.as_ref().unwrap().dir
    }

    fn current(&self) -> bool {
        self.opened.as_ref().unwrap().current(&self.path)
    }

    fn file_identity(&self) -> Result<u64, Error> {
        let file =
            self.dir().open_with(STAGED, cap_std::fs::OpenOptions::new().write(true)).map_err(save_error)?.into_std();
        Handle::from_file(file).map(|id| fingerprint(&id)).map_err(save_error)
    }
}

impl Drop for PrivateStage<'_> {
    fn drop(&mut self) {
        let same = self
            .root
            .dir
            .open_dir(&self.name)
            .and_then(Directory::from_dir)
            .is_ok_and(|dir| dir.identity == self.opened.as_ref().unwrap().identity);
        let _ = self.dir().remove_file(STAGED);
        drop(self.opened.take());
        if same {
            // Leave a backup from an interrupted publication intact.
            let _ = self.root.dir.remove_dir(&self.name);
        }
    }
}

struct Directory {
    dir: Dir,
    identity: Handle,
}
impl Directory {
    fn open(path: &Path) -> io::Result<Self> {
        Self::from_dir(Dir::open_ambient_dir(path, ambient_authority())?)
    }

    fn from_dir(dir: Dir) -> io::Result<Self> {
        let identity = Handle::from_file(dir.try_clone()?.into_std_file())?;
        Ok(Self { dir, identity })
    }

    fn current(&self, path: &Path) -> bool {
        Self::open(path).is_ok_and(|dir| dir.identity == self.identity)
    }
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

fn open_original(path: &Path, read: bool) -> io::Result<Option<File>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => return Err(io::ErrorKind::InvalidInput.into()),
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut options = OpenOptions::new();
    options.read(read).write(true);
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

enum Publication {
    Published,
    #[cfg(unix)]
    Exclusive,
}

enum PublishError {
    Unchanged(io::Error),
    #[cfg(windows)]
    Interrupted(io::Error),
}

#[cfg(unix)]
fn publish(stage: &PrivateStage<'_>, leaf: &Path, exists: bool) -> Result<Publication, PublishError> {
    let parent = &stage.root.dir;
    if exists {
        stage.dir().rename(STAGED, parent, leaf).map_err(PublishError::Unchanged)?;
    } else if let Err(err) = stage.dir().hard_link(STAGED, parent, leaf) {
        if err.kind() == io::ErrorKind::Unsupported || matches!(err.raw_os_error(), Some(libc::EPERM | libc::ENOSYS)) {
            return Ok(Publication::Exclusive);
        }
        return Err(PublishError::Unchanged(err));
    }
    Ok(Publication::Published)
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

    #[test]
    fn a_moved_parent_cannot_redirect_the_save() {
        let dir = crate::shared::test_dir("atomic-save-moved");
        let parent = dir.join("parent");
        let moved = dir.join("moved");
        let path = parent.join("note.txt");
        fs::create_dir(&parent).unwrap();
        fs::write(&path, b"old").unwrap();
        let result = replace(
            &path,
            None,
            || Ok(()),
            |file| {
                file.write_all(b"new")?;
                match fs::rename(&parent, &moved) {
                    Ok(()) => {
                        fs::create_dir(&parent)?;
                        fs::write(&path, b"replacement")
                    }
                    // The Windows directory handle can block the move itself.
                    #[cfg(windows)]
                    Err(err) if err.kind() == io::ErrorKind::PermissionDenied || err.raw_os_error() == Some(32) => {
                        Ok(())
                    }
                    Err(err) => Err(err),
                }
            },
        );
        if moved.exists() {
            assert_eq!(result.unwrap_err().0, Status::CONFLICT);
            assert_eq!(fs::read(&path).unwrap(), b"replacement");
            assert_eq!(fs::read(moved.join("note.txt")).unwrap(), b"old");
            assert_eq!(fs::read_dir(&moved).unwrap().count(), 1);
        } else {
            assert!(cfg!(windows));
            result.unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"new");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn publication_failure_does_not_overwrite_the_original() {
        let dir = crate::shared::test_dir("atomic-save-publish-failure");
        let path = dir.join("note.txt");
        fs::write(&path, b"old").unwrap();
        let result = replace_with(
            &path,
            None,
            || Ok(()),
            |file| file.write_all(b"new"),
            |_stage, _leaf, _exists| Err(PublishError::Unchanged(io::Error::other("injected publication failure"))),
        );
        assert_eq!(result.unwrap_err().0, Status::BAD_REQUEST);
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn permission_failure_at_publication_uses_the_verified_original() {
        let dir = crate::shared::test_dir("atomic-save-permission");
        let path = dir.join("note.txt");
        fs::write(&path, b"old contents").unwrap();
        let identity = file_identity(&path, false).unwrap();
        replace_with(
            &path,
            Some(&version(b"old contents")),
            || Ok(()),
            |file| file.write_all(b"new"),
            |_stage, _leaf, _exists| Err(PublishError::Unchanged(io::ErrorKind::PermissionDenied.into())),
        )
        .unwrap();
        assert_eq!(file_identity(&path, false).unwrap(), identity);
        assert_eq!(fs::read(&path).unwrap(), b"new");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn exclusive_creation_never_overwrites_a_concurrent_file() {
        let dir = crate::shared::test_dir("atomic-save-exclusive");
        let path = dir.join("note.txt");
        replace_with(&path, None, || Ok(()), |f| f.write_all(b"new"), |_, _, _| Ok(Publication::Exclusive)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        fs::remove_file(&path).unwrap();
        let result = replace_with(
            &path,
            None,
            || Ok(()),
            |f| f.write_all(b"new"),
            |_, _, _| {
                fs::write(&path, b"external").unwrap();
                Ok(Publication::Exclusive)
            },
        );
        assert_eq!(result.unwrap_err().0, Status::CONFLICT);
        assert_eq!(fs::read(&path).unwrap(), b"external");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn interrupted_replacement_restores_its_backup_without_overwriting() {
        use windows_sys::Win32::Foundation::ERROR_UNABLE_TO_MOVE_REPLACEMENT_2;
        let dir = crate::shared::test_dir("atomic-save-restore");
        let path = dir.join("note.txt");
        let backup = dir.join("backup");
        let failure = || io::Error::from_raw_os_error(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 as i32);
        fs::write(&backup, b"old").unwrap();
        assert!(matches!(recover_replacement(&path, &backup, failure()), PublishError::Interrupted(_)));
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert!(!backup.exists());
        fs::write(&backup, b"backup").unwrap();
        assert!(matches!(recover_replacement(&path, &backup, failure()), PublishError::Interrupted(_)));
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(fs::read(&backup).unwrap(), b"backup");
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
        let before = Handle::from_path(&path).unwrap();
        replace(&path, None, || Ok(()), |file| file.write_all(b"new")).unwrap();
        assert_ne!(before, Handle::from_path(&path).unwrap());
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read(&stream).unwrap(), b"metadata");
        drop(before);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_handle_that_blocks_replacement_but_allows_writes_keeps_the_file_writable() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        let dir = crate::shared::test_dir("atomic-save-sharing");
        let path = dir.join("note.txt");
        fs::write(&path, b"old contents").unwrap();
        let opened = OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).open(&path).unwrap();
        let before = file_identity(&path, false).unwrap();
        replace(&path, None, || Ok(()), |file| file.write_all(b"new")).unwrap();
        assert_eq!(file_identity(&path, false).unwrap(), before);
        assert_eq!(fs::read(&path).unwrap(), b"new");
        drop(opened);
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

    #[test]
    fn failed_in_place_write_does_not_truncate_the_original_tail() {
        let dir = crate::shared::test_dir("atomic-save-in-place");
        let path = dir.join("note.txt");
        let alias = dir.join("alias.txt");
        fs::write(&path, b"old contents").unwrap();
        fs::hard_link(&path, &alias).unwrap();
        let result = replace(
            &path,
            None,
            || Ok(()),
            |file| {
                file.write_all(b"new")?;
                Err(io::Error::other("injected write failure"))
            },
        );
        assert_eq!(result.unwrap_err().0, Status::BAD_REQUEST);
        assert_eq!(fs::read(alias).unwrap(), b"new contents");
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
fn publish(stage: &PrivateStage<'_>, leaf: &Path, exists: bool) -> Result<Publication, PublishError> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let temp = stage.path.join(STAGED);
    let path = stage.path.with_file_name(leaf);
    if !exists {
        return move_new(&temp, &path).map(|()| Publication::Published).map_err(PublishError::Unchanged);
    }
    let (from, to) = (wide_path(&temp), wide_path(&path));
    let backup = temp.with_extension("backup");
    let original = wide_path(&backup);
    // SAFETY: all inputs are live, NUL-terminated paths; reserved pointers are null.
    if unsafe { ReplaceFileW(to.as_ptr(), from.as_ptr(), original.as_ptr(), 0, null_mut(), null_mut()) } != 0 {
        let _ = fs::remove_file(backup);
        return Ok(Publication::Published);
    }
    Err(recover_replacement(&path, &backup, io::Error::last_os_error()))
}

#[cfg(windows)]
fn inherit_new_file_acl(stage: &PrivateStage<'_>) -> io::Result<()> {
    use std::{
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        ptr::null_mut,
    };
    use windows_sys::Win32::{
        Foundation::{ERROR_SUCCESS, LocalFree},
        Security::{
            Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
            DACL_SECURITY_INFORMATION, SetFileSecurityW,
        },
        Storage::FileSystem::FILE_FLAG_DELETE_ON_CLOSE,
    };
    // A same-volume move keeps the staged file's DACL. An empty delete-on-close
    // sibling supplies the normal DACL for a new file in the destination.
    let probe = stage.path.with_extension("acl");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
        .open(probe)?;
    let mut descriptor = null_mut();
    let temp = wide_path(&stage.path.join(STAGED));
    // SAFETY: file and the NUL-terminated temp path remain live; GetSecurityInfo
    // allocates the descriptor on success and LocalFree releases it.
    unsafe {
        let result = GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        );
        if result != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(result as i32));
        }
        let result = if SetFileSecurityW(temp.as_ptr(), DACL_SECURITY_INFORMATION, descriptor) == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        };
        LocalFree(descriptor);
        result
    }
}

#[cfg(windows)]
fn recover_replacement(path: &Path, backup: &Path, failure: io::Error) -> PublishError {
    use windows_sys::Win32::Foundation::{ERROR_UNABLE_TO_MOVE_REPLACEMENT_2, ERROR_UNABLE_TO_REMOVE_REPLACED};
    // Only failures known to leave the original in place may fall back.
    match fs::symlink_metadata(backup) {
        Ok(_) => match move_new(backup, path) {
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

#[cfg(windows)]
fn move_new(from: &Path, to: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let (from, to) = (wide_path(from), wide_path(to));
    // SAFETY: both inputs are live, NUL-terminated Windows paths.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
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
