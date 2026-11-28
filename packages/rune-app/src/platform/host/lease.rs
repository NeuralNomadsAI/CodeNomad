//! Exclusive OS file lease for autonomous desktop host profiles.
//!
//! Ensures at most one managed desktop `codenomad-rs` process runs per `(profile, config_identity)`
//! scope. The kernel releases the lock automatically if the owning process crashes.
use super::config::LaunchConfig;
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
};

pub(super) struct DesktopLease {
    file: File,
}

impl Drop for DesktopLease {
    fn drop(&mut self) {
        // Release explicitly before close; Unix forks can briefly duplicate descriptors.
        let _ = self.file.unlock();
    }
}

fn busy() -> io::Error {
    io::Error::new(
        io::ErrorKind::WouldBlock,
        "Desktop host profile is already in use",
    )
}

fn is_symlink_or_non_file(meta: &fs::Metadata) -> bool {
    !meta.is_file() || meta.file_type().is_symlink()
}

fn acquire_at(path: &Path) -> io::Result<DesktopLease> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Desktop host lock has no parent directory"))?;
    let parent_meta = fs::symlink_metadata(parent)?;
    if !parent_meta.is_dir() || parent_meta.file_type().is_symlink() {
        return Err(io::Error::other("Invalid desktop host lock directory"));
    }
    match fs::symlink_metadata(path) {
        Ok(meta) if is_symlink_or_non_file(&meta) => {
            return Err(io::Error::other("Invalid desktop host lock file"));
        }
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }

    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Exclusive share mode + FILE_FLAG_OPEN_REPARSE_POINT (never follow symlinks/junctions).
        options.share_mode(0).custom_flags(0x0020_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "linux")]
        const NOFOLLOW: i32 = 0o400_000;
        #[cfg(not(target_os = "linux"))]
        const NOFOLLOW: i32 = 0x100;
        options.custom_flags(NOFOLLOW);
    }

    let file = match options.open(path) {
        Ok(file) => file,
        #[cfg(windows)]
        Err(e) if matches!(e.raw_os_error(), Some(32 | 33)) => return Err(busy()),
        Err(e) => return Err(e),
    };
    let meta = file.metadata()?;
    if is_symlink_or_non_file(&meta) {
        return Err(io::Error::other("Invalid desktop host lock file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err(io::Error::other("Invalid desktop host lock file"));
        }
    }
    match file.try_lock() {
        Ok(()) => Ok(DesktopLease { file }),
        Err(fs::TryLockError::WouldBlock) => Err(busy()),
        Err(fs::TryLockError::Error(e)) => Err(e),
    }
}

pub(super) fn acquire(config: &LaunchConfig) -> io::Result<Option<DesktopLease>> {
    let Some(path) = config.desktop_lock.as_deref() else {
        return Ok(None);
    };
    acquire_at(path).map(Some)
}
