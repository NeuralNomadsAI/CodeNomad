//! The host half of `plugin-control-document.ts`: destination resolution, bounded reads,
//! and the prepared temporary file, lock directory and verified rename.
use super::{DocError, Document, Style};
use std::io::{ErrorKind, Read};
use std::time::{Duration, Instant, SystemTime};

const MAX: u64 = 4 * 1024 * 1024;
type R<T> = Result<T, DocError>;

fn resolve(current: &str, depth: usize, seen: &mut Vec<String>) -> R<String> {
    if depth >= 16 {
        return Err(DocError::Filesystem("OpenCode configuration symlink chain is too deep"));
    }
    match dunce::canonicalize(current) {
        Ok(p) => return Ok(p.to_string_lossy().into_owned()),
        Err(e) if e.kind() != ErrorKind::NotFound => {
            return Err(DocError::Filesystem("Unable to resolve OpenCode configuration"));
        }
        Err(_) => {}
    }
    let style = Style::host();
    let info = match std::fs::symlink_metadata(current) {
        Ok(i) => i,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            let parent = style.dirname(current);
            if parent == current {
                return Ok(current.into());
            }
            return Ok(style.join(&resolve(&parent, depth, seen)?, &style.basename(current)));
        }
        Err(_) => return Err(DocError::Filesystem("Unable to inspect OpenCode configuration")),
    };
    if !info.file_type().is_symlink() {
        return Ok(current.into());
    }
    if seen.iter().any(|s| s == current) {
        return Err(DocError::Filesystem("OpenCode configuration symlink is circular"));
    }
    seen.push(current.into());
    let target =
        std::fs::read_link(current).map_err(|_| DocError::Filesystem("Unable to resolve OpenCode configuration"))?;
    let next = style.join(&style.dirname(current), &target.to_string_lossy());
    let next =
        if style.is_absolute(&target.to_string_lossy()) { style.normalize(&target.to_string_lossy()) } else { next };
    resolve(&next, depth + 1, seen)
}
/// `resolveHostWriteDestination`.
pub fn destination(requested: &str) -> R<String> {
    resolve(&Style::host().normalize(requested), 0, &mut Vec::new())
}
pub fn inspect(requested: &str) -> R<(String, bool)> {
    let write = destination(requested)?;
    match std::fs::symlink_metadata(&write) {
        Ok(i) if i.is_file() => Ok((write, true)),
        Ok(_) => Err(DocError::Filesystem("OpenCode configuration target is not a regular file")),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok((write, false)),
        Err(_) => Err(DocError::Filesystem("Unable to inspect OpenCode configuration")),
    }
}
enum ReadError {
    Io(ErrorKind),
    Doc(DocError),
}
fn mode(m: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        m.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        // libuv reports 0o444 for read-only files and 0o666 otherwise.
        if m.permissions().readonly() { 0o444 } else { 0o666 }
    }
}
fn read_bounded(path: &str) -> Result<(Vec<u8>, u32), ReadError> {
    let meta = std::fs::metadata(path).map_err(|e| ReadError::Io(e.kind()))?;
    if !meta.is_file() {
        return Err(ReadError::Doc(DocError::Filesystem("OpenCode configuration target is not a file")));
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Avoid blocking forever if the path is swapped for a FIFO between `metadata` and `open`
        // (including during the second `verify()` while workspace/connection guards are held).
        opts.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = opts.open(path).map_err(|e| ReadError::Io(e.kind()))?;
    let meta = file.metadata().map_err(|e| ReadError::Io(e.kind()))?;
    if !meta.is_file() {
        return Err(ReadError::Doc(DocError::Filesystem("OpenCode configuration target is not a file")));
    }
    let too_large = ReadError::Doc(DocError::Invalid("OpenCode configuration file is too large"));
    if meta.len() > MAX {
        return Err(too_large);
    }
    let mut contents = Vec::new();
    (&mut file).take(MAX + 1).read_to_end(&mut contents).map_err(|e| ReadError::Io(e.kind()))?;
    if contents.len() as u64 > MAX { Err(too_large) } else { Ok((contents, mode(&meta))) }
}
/// `readPluginControlDocument` on the host file system.
pub fn load(requested: &str) -> R<Document> {
    let write = destination(requested)?;
    let (contents, mode, exists) = match read_bounded(&write) {
        Ok((c, m)) => (c, m, true),
        Err(ReadError::Io(ErrorKind::NotFound)) => (b"{}\n".to_vec(), 0o600, false),
        Err(ReadError::Doc(e)) => return Err(e),
        Err(ReadError::Io(_)) => return Err(DocError::Filesystem("Unable to read OpenCode configuration")),
    };
    crate::subagent_depth::document::decode(requested.into(), write, exists, mode, &contents)
}
fn hex(n: usize) -> R<String> {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).map_err(|_| DocError::Filesystem("Unable to atomically replace OpenCode configuration"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}
fn assert_unchanged(d: &Document) -> R<()> {
    let style = Style::host();
    let checked = (|| -> Result<(), ReadError> {
        let destination = destination(&d.requested).map_err(ReadError::Doc)?;
        if !style.relative(&destination, &d.write).is_empty() {
            return Err(ReadError::Doc(DocError::Conflict(
                "OpenCode configuration destination changed during the update",
            )));
        }
        let (current, current_mode) = read_bounded(&d.write)?;
        if !d.exists
            || current != crate::subagent_depth::jsonc::string(&crate::subagent_depth::document::full(d)).into_bytes()
        {
            return Err(ReadError::Doc(DocError::Conflict("OpenCode configuration changed during the update")));
        }
        if cfg!(unix) && current_mode != d.mode {
            return Err(ReadError::Doc(DocError::Conflict("OpenCode configuration changed during the update")));
        }
        Ok(())
    })();
    match checked {
        Ok(()) => Ok(()),
        Err(ReadError::Io(ErrorKind::NotFound)) if !d.exists => Ok(()),
        Err(ReadError::Doc(DocError::Filesystem(m)))
            if d.exists && (m.contains("not a file") || m.contains("not a regular file")) =>
        {
            Err(DocError::Conflict("OpenCode configuration changed during the update"))
        }
        Err(ReadError::Doc(e)) => Err(e),
        Err(ReadError::Io(_)) => {
            Err(DocError::Filesystem("Unable to verify OpenCode configuration before replacement"))
        }
    }
}
struct Lock {
    path: String,
    nonce: String,
    released: bool,
}
/// Non-blocking, nofollow, bounded read of the 32-hex lock owner nonce so `Lock::verify`
/// can never block under global workspace/connection guards if `owner` is swapped for a FIFO.
fn read_lock_owner(path: &str) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let mut file = opts.open(path).ok()?;
    let handle_meta = file.metadata().ok()?;
    if !handle_meta.is_file() || handle_meta.len() > 64 {
        return None;
    }
    let mut buf = Vec::with_capacity(64);
    (&mut file).take(65).read_to_end(&mut buf).ok()?;
    if buf.len() > 64 {
        return None;
    }
    String::from_utf8(buf).ok()
}

impl Lock {
    fn owner(&self) -> String {
        format!("{}{}owner", self.path, std::path::MAIN_SEPARATOR)
    }
    fn verify(&self) -> bool {
        read_lock_owner(&self.owner()).as_deref() == Some(self.nonce.as_str())
    }
    fn release(&mut self) {
        if std::mem::replace(&mut self.released, true) {
            return;
        }
        // Only a lock still owned by this acquisition is removed.
        if self.verify() {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
fn acquire(write: &str) -> R<Lock> {
    let path = format!("{write}.codenomad-plugin-controls.lock");
    let nonce = hex(16)?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let unable = DocError::Filesystem("Unable to lock OpenCode configuration");
    loop {
        match std::fs::create_dir(&path) {
            Ok(()) => {
                let lock = Lock { path: path.clone(), nonce: nonce.clone(), released: false };
                if std::fs::write(lock.owner(), &nonce).is_err() {
                    let _ = std::fs::remove_dir_all(&path);
                    return Err(unable);
                }
                return Ok(lock);
            }
            Err(e) if e.kind() != ErrorKind::AlreadyExists => return Err(unable),
            Err(_) => {}
        }
        match std::fs::symlink_metadata(&path) {
            Ok(info) => {
                let age =
                    info.modified().ok().and_then(|m| SystemTime::now().duration_since(m).ok()).unwrap_or_default();
                if age > Duration::from_secs(30) {
                    let _ = std::fs::remove_dir_all(&path).or_else(|_| std::fs::remove_file(&path));
                    continue;
                }
            }
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(_) => return Err(DocError::Filesystem("Unable to inspect OpenCode configuration lock")),
        }
        if Instant::now() >= deadline {
            return Err(DocError::Conflict("OpenCode configuration is being updated by another process"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn set_mode(path: &str, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let mut p = std::fs::metadata(path)?.permissions();
        p.set_readonly(mode & 0o200 == 0);
        std::fs::set_permissions(path, p)
    }
}
/// `replaceHostDocument`: temporary file, lock, unchanged-source checks, then one rename.
pub fn replace(d: &Document, updated: &[u16]) -> R<()> {
    prepare(d, updated)?.commit()
}

pub(crate) struct Prepared {
    source: Document,
    temporary: String,
    lock: Option<Lock>,
    committed: bool,
}

impl Drop for Prepared {
    fn drop(&mut self) {
        if let Some(lock) = &mut self.lock {
            lock.release();
        }
        if !self.temporary.is_empty() {
            let _ = std::fs::remove_file(&self.temporary);
        }
    }
}

impl Prepared {
    pub(crate) fn verify(&self) -> R<()> {
        if self.committed {
            return Err(DocError::Conflict("OpenCode configuration preparation is closed"));
        }
        assert_unchanged(&self.source)?;
        if !self.lock.as_ref().is_some_and(Lock::verify) {
            return Err(DocError::Conflict("OpenCode configuration is being updated by another process"));
        }
        Ok(())
    }

    pub(crate) fn commit(self) -> R<()> {
        self.commit_checked(|e| e, || Ok(()))
    }

    pub(crate) fn commit_checked<E, G>(
        mut self,
        map: impl Fn(DocError) -> E,
        before_rename: impl FnOnce() -> Result<G, E>,
    ) -> Result<(), E> {
        self.commit_in_place(map, before_rename, || Ok(()))
    }

    /// Commits the prepared replacement while keeping its replacement lock held until `self` drops.
    /// Re-verifies the source bytes and lock nonce both before and after `before_commit` (matching
    /// `plugin-control-document.ts:314-328`), then calls `admit_rename` right before `rename`.
    pub(crate) fn commit_in_place<E, G>(
        &mut self,
        map: impl Fn(DocError) -> E,
        before_commit: impl FnOnce() -> Result<G, E>,
        admit_rename: impl FnOnce() -> Result<(), E>,
    ) -> Result<(), E> {
        self.verify().map_err(&map)?;
        let guard = before_commit()?;
        self.verify().map_err(&map)?;
        admit_rename()?;
        let result = match std::fs::rename(&self.temporary, &self.source.write) {
            Ok(()) => {
                self.temporary.clear();
                self.committed = true;
                Ok(())
            }
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::IsADirectory
                        | ErrorKind::NotADirectory
                        | ErrorKind::AlreadyExists
                        | ErrorKind::DirectoryNotEmpty
                ) =>
            {
                Err(map(DocError::Conflict("OpenCode configuration changed during the update")))
            }
            Err(_) => Err(map(DocError::Filesystem("Unable to atomically replace OpenCode configuration"))),
        };
        drop(guard);
        result
    }
}

fn access_writable(path: &str) -> bool {
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let Ok(cstr) = CString::new(std::path::Path::new(path).as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: `cstr` is NUL-terminated for the duration of the syscall.
        unsafe { libc::access(cstr.as_ptr(), libc::W_OK) == 0 }
    }
    #[cfg(not(unix))]
    {
        let Ok(meta) = std::fs::metadata(path) else {
            return false;
        };
        meta.is_dir() || !meta.permissions().readonly()
    }
}

/// A caller may await a durable attempt while holding the exact replacement.
/// Dropping the prepared edit discards its temporary bytes without publishing them.
pub(crate) fn prepare(d: &Document, updated: &[u16]) -> R<Prepared> {
    let style = Style::host();
    let failed = DocError::Filesystem("Unable to atomically replace OpenCode configuration");
    let temporary = format!("{}.{}.{}.tmp", d.write, std::process::id(), hex(8)?);
    let mut prepared = Prepared { source: d.clone(), temporary: String::new(), lock: None, committed: false };
    let directory = style.dirname(&d.write);
    std::fs::create_dir_all(&directory).map_err(|_| failed.clone())?;
    if d.exists {
        if d.mode & 0o222 == 0 {
            return Err(DocError::Filesystem("OpenCode configuration is read-only"));
        }
        if !access_writable(&d.write) {
            return Err(failed.clone());
        }
    }
    if !access_writable(&directory) {
        return Err(failed.clone());
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(d.mode & 0o777);
    }
    let mut file = options.open(&temporary).map_err(|_| failed.clone())?;
    prepared.temporary = temporary.clone();
    use std::io::Write;
    file.write_all(crate::subagent_depth::jsonc::string(updated).as_bytes()).map_err(|_| failed.clone())?;
    file.sync_all().map_err(|_| failed.clone())?;
    drop(file);
    set_mode(&temporary, d.mode).map_err(|_| failed.clone())?;
    prepared.lock = Some(acquire(&d.write)?);
    prepared.verify()?;
    Ok(prepared)
}
