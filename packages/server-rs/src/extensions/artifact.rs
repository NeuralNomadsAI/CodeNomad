//! Content-addressed plugin payloads, after the reference
//! `opencode/desktop-plugin-artifact.ts`: a payload is published only by
//! renaming a complete private copy over its name, then verified through one
//! handle (single regular file, same identity as the name, exact bytes). Links
//! are never followed and an ordinary directory is never removed.

use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

/// Waits before each verify-and-publish pass (about 3 s in all), as TS.
const REPAIR_DELAYS_MS: [u64; 8] = [0, 25, 50, 100, 200, 400, 800, 1600];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Identity {
    dev: u64,
    ino: u128,
    nlink: u64,
    size: u64,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(unix)]
fn open_nofollow(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    #[cfg(target_os = "linux")]
    const NOFOLLOW: i32 = 0o400000;
    #[cfg(not(target_os = "linux"))]
    const NOFOLLOW: i32 = 0x100;
    #[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd"))]
    const NONBLOCK: i32 = 0x0004;
    #[cfg(not(any(target_os = "macos", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd")))]
    const NONBLOCK: i32 = 0x0800;
    fs::OpenOptions::new().read(true).custom_flags(NOFOLLOW | NONBLOCK).open(path)
}
#[cfg(windows)]
fn open_nofollow(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_FLAG_OPEN_REPARSE_POINT: a link is opened as itself, never followed.
    fs::OpenOptions::new().read(true).custom_flags(0x0020_0000).open(path)
}

#[cfg(unix)]
fn handle_identity(file: &File) -> io::Result<(Identity, bool)> {
    use std::os::unix::fs::MetadataExt;
    let m = file.metadata()?;
    Ok((Identity { dev: m.dev(), ino: m.ino().into(), nlink: m.nlink(), size: m.size() }, m.file_type().is_file()))
}
#[cfg(windows)]
fn handle_identity(file: &File) -> io::Result<(Identity, bool)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: a live handle owned by `file` and a properly sized output struct.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let m = file.metadata()?;
    Ok((
        Identity {
            dev: info.dwVolumeSerialNumber.into(),
            ino: (u128::from(info.nFileIndexHigh) << 32) | u128::from(info.nFileIndexLow),
            nlink: info.nNumberOfLinks.into(),
            size: (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
        },
        m.file_type().is_file() && info.dwFileAttributes & 0x400 == 0,
    ))
}

/// Identity of the name itself (never a link's target), or `None` when absent.
fn named_identity(path: &Path) -> io::Result<Option<(Identity, fs::Metadata)>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !meta.file_type().is_file() {
        return Ok(Some((Identity { dev: 0, ino: 0, nlink: 0, size: 0 }, meta)));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Some((Identity { dev: meta.dev(), ino: meta.ino().into(), nlink: meta.nlink(), size: meta.size() }, meta)))
    }
    #[cfg(windows)]
    {
        match open_nofollow(path) {
            Ok(file) => Ok(Some((handle_identity(&file)?.0, meta))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
}

fn single_file(identity: &Identity, meta: &fs::Metadata) -> bool {
    meta.file_type().is_file() && !meta.file_type().is_symlink() && identity.nlink == 1
}

#[cfg(unix)]
fn handle_times(file: &File) -> io::Result<(i64, i64, i64, i64)> {
    use std::os::unix::fs::MetadataExt;
    let m = file.metadata()?;
    Ok((m.mtime(), m.mtime_nsec(), m.ctime(), m.ctime_nsec()))
}

#[cfg(windows)]
fn handle_times(file: &File) -> io::Result<(i64, i64, i64, i64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandleEx};
    let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: live handle owned by `file` and properly sized `FILE_BASIC_INFO` output struct.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as _,
            FileBasicInfo,
            (&mut basic as *mut FILE_BASIC_INFO).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok((basic.LastWriteTime, 0, basic.ChangeTime, 0))
}

/// Bounded, existing-only read with the same single-file nofollow identity rules as publication
/// (`readDesktopPluginFile` in `desktop-plugin-artifact.ts`).
pub(crate) fn read_regular_nofollow(path: &Path, max_bytes: usize) -> Option<Vec<u8>> {
    let (before_named, meta) = named_identity(path).ok()??;
    if !single_file(&before_named, &meta) || before_named.size > max_bytes as u64 {
        return None;
    }
    let mut file = open_nofollow(path).ok()?;
    let (held, regular) = handle_identity(&file).ok()?;
    let before_times = handle_times(&file).ok()?;
    if !regular
        || held.nlink != 1
        || held.ino == 0
        || held.dev != before_named.dev
        || held.ino != before_named.ino
        || held.size != before_named.size
    {
        return None;
    }
    let mut bytes = vec![0u8; held.size as usize];
    file.read_exact(&mut bytes).ok()?;
    let mut trailing = [0u8; 1];
    if file.read(&mut trailing).ok()? != 0 {
        return None;
    }
    let (after_held, after_regular) = handle_identity(&file).ok()?;
    let after_times = handle_times(&file).ok()?;
    let (after_named, after_meta) = named_identity(path).ok()??;
    if !after_regular
        || after_held.nlink != 1
        || !single_file(&after_named, &after_meta)
        || after_held.dev != held.dev
        || after_held.ino != held.ino
        || after_held.size != held.size
        || after_named.dev != held.dev
        || after_named.ino != held.ino
        || after_named.size != held.size
        || after_times != before_times
    {
        return None;
    }
    Some(bytes)
}

/// The identity of one regular file holding exactly `bundle`, or the reason it is not.
fn verified(plugin: &Path, bundle: &[u8], hash: &str) -> io::Result<Result<Identity, &'static str>> {
    let Some((before, meta)) = named_identity(plugin)? else {
        return Ok(Err("payload missing or not a single regular file"));
    };
    if !single_file(&before, &meta) {
        return Ok(Err("payload missing or not a single regular file"));
    }
    let mut file = match open_nofollow(plugin) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Err("payload disappeared or became a link")),
        #[cfg(unix)]
        Err(e) if e.raw_os_error() == Some(40) || e.raw_os_error() == Some(62) => {
            return Ok(Err("payload disappeared or became a link"));
        }
        Err(e) => return Err(e),
    };
    let (held, regular) = handle_identity(&file)?;
    let Some((named, meta)) = named_identity(plugin)? else { return Ok(Err("payload is not a single regular file")) };
    if !regular || held.nlink != 1 || !single_file(&named, &meta) {
        return Ok(Err("payload is not a single regular file"));
    }
    if held.size != bundle.len() as u64 || named.size != held.size {
        return Ok(Err("payload size differs from bundle"));
    }
    if held.dev != named.dev || held.ino != named.ino || held.ino == 0 {
        return Ok(Err("payload device or inode differs from open handle"));
    }
    let mut actual = Sha256::new();
    let mut chunk = vec![0; 64 * 1024];
    let mut left = bundle.len();
    while left > 0 {
        let read = file.read(&mut chunk[..left.min(64 * 1024)])?;
        if read == 0 {
            return Ok(Err("payload ended before bundle length"));
        }
        actual.update(&chunk[..read]);
        left -= read;
    }
    if format!("{:x}", actual.finalize()) != hash {
        return Ok(Err("payload SHA-256 differs from bundle"));
    }
    if file.read(&mut chunk[..1])? != 0 { Ok(Err("payload has trailing bytes")) } else { Ok(Ok(held)) }
}

fn temporary(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    PathBuf::from(name)
}

fn refuse_directory(plugin: &Path) -> io::Result<()> {
    match fs::symlink_metadata(plugin) {
        Ok(m) if m.file_type().is_dir() => Err(io::Error::other(format!(
            "Managed plugin bundle path is a directory, which CodeNomad never removes: {}. Delete it, then reconnect.",
            plugin.display()
        ))),
        _ => Ok(()),
    }
}

/// Write a complete private copy, then rename it over the name (never over a
/// link's target). A directory link that Windows cannot rename over is removed
/// with `rmdir`, which never removes a regular file or a link's target.
pub fn write_replacing(path: &Path, bytes: &[u8]) -> io::Result<()> {
    refuse_directory(path)?;
    let temp = temporary(path);
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        match fs::rename(&temp, path) {
            Ok(()) => return Ok(()),
            Err(e) if matches!(e.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::IsADirectory) => {
                refuse_directory(path)?;
                let link = fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
                if !link {
                    return Err(e);
                }
            }
            Err(e) => return Err(e),
        }
        match fs::remove_dir(path) {
            Ok(()) => fs::rename(&temp, path),
            // Another installer repaired the name meanwhile: the caller verifies it.
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::NotFound
                        | io::ErrorKind::NotADirectory
                        | io::ErrorKind::DirectoryNotEmpty
                        | io::ErrorKind::AlreadyExists
                ) =>
            {
                Ok(())
            }
            Err(e) => Err(e),
        }
    })();
    let _ = fs::remove_file(&temp);
    result
}

fn transient(error: &io::Error) -> bool {
    // EPERM/EACCES/EBUSY, plus Windows sharing and lock violations.
    matches!(error.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy)
        || matches!(error.raw_os_error(), Some(32 | 33) if cfg!(windows))
}

/// Publish or repair `plugin` so that it holds exactly `bundle`, within the
/// bounded passes; transient locks back off, other failures are final.
pub fn install(plugin: &Path, bundle: &[u8], hash: &str) -> io::Result<Identity> {
    let mut reason = "payload unavailable";
    let mut failure = None;
    for wait in REPAIR_DELAYS_MS {
        if wait > 0 {
            std::thread::sleep(Duration::from_millis(wait));
        }
        let pass = (|| -> io::Result<Option<Identity>> {
            match verified(plugin, bundle, hash)? {
                Ok(id) => return Ok(Some(id)),
                Err(why) => reason = why,
            }
            write_replacing(plugin, bundle)?;
            match verified(plugin, bundle, hash)? {
                Ok(id) => Ok(Some(id)),
                Err(why) => {
                    reason = why;
                    Ok(None)
                }
            }
        })();
        match pass {
            Ok(Some(identity)) => return Ok(identity),
            Ok(None) => {}
            Err(e) if transient(&e) => failure = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::other(format!(
        "Managed plugin bundle could not be verified or replaced ({reason}): {}. Check filesystem access and other CodeNomad servers using this OpenCode configuration, then reconnect.{}",
        plugin.display(),
        failure.map(|e| format!(" ({e})")).unwrap_or_default()
    )))
}

/// Recheck before the shim may point at the payload; another installer may
/// have published the same bytes meanwhile.
pub fn assert_unchanged(plugin: &Path, identity: &mut Identity, bundle: &[u8], hash: &str) -> io::Result<()> {
    if let Some((named, meta)) = named_identity(plugin)?
        && single_file(&named, &meta)
        && named.size == bundle.len() as u64
        && named.dev == identity.dev
        && named.ino == identity.ino
    {
        return Ok(());
    }
    match verified(plugin, bundle, hash)? {
        Ok(id) => {
            *identity = id;
            Ok(())
        }
        Err(why) => Err(io::Error::other(format!(
            "Managed plugin bundle changed while it was being installed ({why}): {}",
            plugin.display()
        ))),
    }
}

/// Metadata of `path` when it is one regular, single-link file (never a link).
pub fn single_regular(path: &Path) -> io::Result<Option<fs::Metadata>> {
    Ok(named_identity(path)?.filter(|(id, meta)| single_file(id, meta)).map(|(_, meta)| meta))
}

/// Whether the name still designates the file behind `file` (identity-checked cleanup).
pub fn names(file: &File, path: &Path) -> bool {
    let Ok((held, _)) = handle_identity(file) else { return false };
    matches!(named_identity(path), Ok(Some((named, meta))) if single_file(&named, &meta)
        && named.dev == held.dev && named.ino == held.ino)
}

/// Identity of a plain directory (never a link), or `None`.
pub fn directory_identity(path: &Path) -> Option<Identity> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_dir() || meta.file_type().is_symlink() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(Identity { dev: meta.dev(), ino: meta.ino().into(), nlink: 0, size: 0 })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_READ_ATTRIBUTES with FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT.
        let dir = fs::OpenOptions::new().access_mode(0x80).custom_flags(0x0220_0000).open(path).ok()?;
        let (id, _) = handle_identity(&dir).ok()?;
        Some(Identity { nlink: 0, size: 0, ..id })
    }
}

/// Bounded, existing-only read of a regular single-link file.
pub fn read_bounded(path: &Path, max: u64) -> io::Result<Option<Vec<u8>>> {
    let Some((named, meta)) = named_identity(path)? else { return Ok(None) };
    if !single_file(&named, &meta) || named.size > max {
        return Ok(None);
    }
    let file = open_nofollow(path)?;
    let (held, regular) = handle_identity(&file)?;
    if !regular || held.dev != named.dev || held.ino != named.ino {
        return Ok(None);
    }
    let mut bytes = Vec::with_capacity(held.size as usize);
    file.take(max + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() as u64 <= max).then_some(bytes))
}
