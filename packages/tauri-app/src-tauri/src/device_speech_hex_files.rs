use std::{
    fs::{self, Metadata},
    io,
    path::{Path, PathBuf},
};

// Snapshot only paths that the bundled preparation worker verified. A capture
// can outlive a cache removal or repair; do not send its WAV to the old service.
pub(super) struct Snapshot {
    directories: Vec<PathBuf>,
    files: Vec<(PathBuf, Stamp)>,
}

impl Snapshot {
    pub(super) fn read(directories: Vec<PathBuf>, files: Vec<PathBuf>) -> io::Result<Self> {
        check_directories(&directories)?;
        let files = files
            .into_iter()
            .map(|path| {
                let stamp = stamp(&path)?;
                Ok((path, stamp))
            })
            .collect::<io::Result<_>>()?;
        Ok(Self { directories, files })
    }

    pub(super) fn unchanged(&self) -> bool {
        check_directories(&self.directories).is_ok()
            && self
                .files
                .iter()
                .all(|(path, then)| stamp(path).is_ok_and(|now| now == *then))
    }
}

fn check_directories(directories: &[PathBuf]) -> io::Result<()> {
    for path in directories {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_dir() || !plain(&metadata) {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn plain(meta: &Metadata) -> bool {
    !meta.is_symlink()
}

#[cfg(windows)]
fn plain(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
}

#[cfg(unix)]
type Stamp = (u64, u64, u64, i64, i64, i64, i64);

#[cfg(unix)]
fn stamp(path: &Path) -> io::Result<Stamp> {
    use std::os::unix::fs::MetadataExt;
    let info = fs::symlink_metadata(path)?;
    if !info.is_file() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok((
        info.dev(),
        info.ino(),
        info.len(),
        info.mtime(),
        info.mtime_nsec(),
        info.ctime(),
        info.ctime_nsec(),
    ))
}

#[cfg(windows)]
type Stamp = (u32, u64, u64, i64, i64);

#[cfg(windows)]
fn stamp(path: &Path) -> io::Result<Stamp> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES,
    };
    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || !plain(&meta) {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    let mut identity: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
    let handle = file.as_raw_handle();
    let success = unsafe {
        GetFileInformationByHandle(handle, &mut identity) != 0
            && GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of_val(&basic) as u32,
            ) != 0
    };
    if !success {
        return Err(io::Error::last_os_error());
    }
    let index = (u64::from(identity.nFileIndexHigh) << 32) | u64::from(identity.nFileIndexLow);
    Ok((
        identity.dwVolumeSerialNumber,
        index,
        meta.len(),
        basic.LastWriteTime,
        basic.ChangeTime,
    ))
}

#[cfg(test)]
#[test]
fn deleting_a_receipt_or_replacing_an_artifact_invalidates_the_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let model = root.path().join("model");
    let receipt = root.path().join("ready.json");
    fs::write(&model, b"model").unwrap();
    fs::write(&receipt, b"ready").unwrap();
    let snapshot = Snapshot::read(
        vec![root.path().into()],
        vec![model.clone(), receipt.clone()],
    )
    .unwrap();
    assert!(snapshot.unchanged());
    fs::remove_file(&receipt).unwrap();
    assert!(!snapshot.unchanged());
    fs::write(&receipt, b"ready").unwrap();
    let snapshot = Snapshot::read(vec![], vec![model.clone()]).unwrap();
    let replacement = root.path().join("replacement");
    fs::write(&replacement, b"MODEL").unwrap();
    fs::rename(&replacement, &model).unwrap();
    assert!(!snapshot.unchanged());
}
