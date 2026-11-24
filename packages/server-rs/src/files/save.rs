//! Stage bytes beside the physical target before replacing its name.
#[cfg(unix)]
mod metadata;
#[cfg(windows)]
mod windows;
use std::{
    fs::{self, File, OpenOptions},
    hash::{DefaultHasher, Hash, Hasher},
    io::{self, Seek},
    path::{Path, PathBuf},
};
#[cfg(windows)]
use windows::{create_private_stage, link_count};

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
    publish: impl FnOnce(&PrivateStage<'_>, &Path, Option<&File>) -> Result<Publication, PublishError>,
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
        if let Err(err) = write(&mut file).and_then(|()| file.sync_all()) {
            let identity = file.try_clone().and_then(Handle::from_file).ok();
            if identity.is_some() && stage_file_handle(&directory.dir, leaf).ok() == identity {
                let _ = directory.dir.remove_file(leaf);
            }
            drop(file);
            return Err(save_error(err));
        }
        #[cfg(unix)]
        if let Ok(parent) = directory.dir.open(".") {
            parent.sync_all().map_err(save_error)?;
        }
        Ok(())
    };
    let limitation = |err: io::Error| -> Result<(), Error> {
        if original.is_some() && can_fallback(&err) {
            return in_place();
        }
        Err(save_error(err))
    };
    let directory = match &directory {
        Ok(directory) => directory,
        Err(err) => {
            return limitation(err.raw_os_error().map_or_else(|| err.kind().into(), io::Error::from_raw_os_error));
        }
    };
    let mut stage = match PrivateStage::new(parent, directory) {
        Ok(stage) => stage,
        Err(err) if original.is_none() && can_fallback(&err) => return exclusive(directory),
        Err(err) => return limitation(err),
    };
    let mut staged = match stage.create_file(&options, original.is_none()) {
        Ok(file) => file,
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
    if !stage.current() || !stage.retain_for_publish(staged, staged_id, original.is_none())? {
        return Err(changed());
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
    match publish(&stage, leaf, actual.as_ref()) {
        Ok(Publication::Published) => {
            drop(stage);
            #[cfg(unix)]
            sync_parent.sync_all().map_err(save_error)?;
            Ok(())
        }
        #[cfg(unix)]
        Ok(Publication::Exclusive) => exclusive(directory),
        Err(PublishError::Changed) => Err(changed()),
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
        || busy_mount(err)
}

#[cfg(target_os = "linux")]
fn busy_mount(err: &io::Error) -> bool {
    err.raw_os_error() == Some(libc::EBUSY)
}

#[cfg(not(target_os = "linux"))]
fn busy_mount(_err: &io::Error) -> bool {
    false
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

fn stage_file_handle(dir: &Dir, leaf: &Path) -> io::Result<Handle> {
    let mut options = cap_std::fs::OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    Handle::from_file(dir.open_with(leaf, &options)?.into_std())
}

struct PrivateStage<'a> {
    root: &'a Directory,
    path: PathBuf,
    name: PathBuf,
    opened: Option<Directory>,
    #[cfg(windows)]
    creation: Option<File>,
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
        Ok(Self {
            root,
            path,
            name,
            opened: Some(opened),
            #[cfg(windows)]
            creation: None,
        })
    }

    fn create_file(&self, options: &cap_std::fs::OpenOptions, _new: bool) -> io::Result<File> {
        #[cfg(windows)]
        if _new {
            return windows::create_for_publish(self.dir(), options);
        }
        self.dir().open_with(STAGED, options).map(cap_std::fs::File::into_std)
    }

    fn retain_for_publish(&mut self, file: File, identity: u64, _new: bool) -> Result<bool, Error> {
        #[cfg(windows)]
        if _new {
            self.creation = Some(file);
            return Ok(true);
        }
        drop(file);
        Ok(self.file_identity()? == identity)
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
        #[cfg(windows)]
        drop(self.creation.take());
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

enum Publication {
    Published,
    #[cfg(unix)]
    Exclusive,
}

enum PublishError {
    Changed,
    Unchanged(io::Error),
    #[cfg(windows)]
    Interrupted(io::Error),
}

fn publish(stage: &PrivateStage<'_>, leaf: &Path, actual: Option<&File>) -> Result<Publication, PublishError> {
    // Directory handles keep a renamed ancestor from redirecting the write.
    // No platform rename compares the target inode or hash: an outside writer
    // can still change the same name between the final check and the operation.
    if !stage.root.current(stage.path.parent().unwrap()) || !stage.current() {
        return Err(PublishError::Changed);
    }
    #[cfg(windows)]
    return windows::publish(stage, leaf, actual);
    #[cfg(unix)]
    publish_unix(stage, leaf, actual.is_some())
}

#[cfg(unix)]
fn publish_unix(stage: &PrivateStage<'_>, leaf: &Path, exists: bool) -> Result<Publication, PublishError> {
    let parent = &stage.root.dir;
    if exists {
        stage.dir().rename(STAGED, parent, leaf).map_err(PublishError::Unchanged)?;
        return Ok(Publication::Published);
    }
    match rename_new(stage.dir(), parent, leaf) {
        Ok(()) => Ok(Publication::Published),
        Err(err) if no_exclusive_rename(&err) => Ok(Publication::Exclusive),
        Err(err) => Err(PublishError::Unchanged(err)),
    }
}

#[cfg(unix)]
fn no_exclusive_rename(err: &io::Error) -> bool {
    matches!(err.raw_os_error(), Some(libc::EINVAL | libc::ENOSYS))
        || (cfg!(target_os = "macos") && err.raw_os_error() == Some(libc::ENOTSUP))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn rename_new(source: &Dir, destination: &Dir, leaf: &Path) -> io::Result<()> {
    use std::{
        ffi::CString,
        os::{fd::AsRawFd, unix::ffi::OsStrExt},
    };
    let leaf = CString::new(leaf.as_os_str().as_bytes())?;
    let (from, to) = (source.as_raw_fd(), destination.as_raw_fd());
    // SAFETY: live directory descriptors and NUL-terminated single names.
    #[cfg(target_os = "linux")]
    let result = unsafe { libc::renameat2(from, c"write.tmp".as_ptr(), to, leaf.as_ptr(), libc::RENAME_NOREPLACE) };
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renameatx_np(from, c"write.tmp".as_ptr(), to, leaf.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn rename_new(source: &Dir, destination: &Dir, leaf: &Path) -> io::Result<()> {
    match source.hard_link(STAGED, destination, leaf) {
        Err(err) if err.kind() == io::ErrorKind::Unsupported => Err(io::Error::from_raw_os_error(libc::ENOSYS)),
        result => result,
    }
}

#[cfg(test)]
mod tests;
