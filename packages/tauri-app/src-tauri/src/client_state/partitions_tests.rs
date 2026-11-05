use super::*;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Observation { bytes: usize, max_read: usize, dropped: bool }

struct ObservedFile {
    file: fs::File,
    observation: Arc<Mutex<Observation>>,
    grow: Option<PathBuf>,
    fail: bool,
}

impl Read for ObservedFile {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if let Some(path) = self.grow.take() {
            fs::OpenOptions::new().append(true).open(path)?.write_all(&vec![b'x'; 4 * MAX_PARTITION_BYTES])?;
        }
        if self.fail { return Err(std::io::Error::other("owned read failure")); }
        // Real file short reads, including a UTF-8 sequence split across chunks.
        let length = bytes.len().min(1001);
        let read = self.file.read(&mut bytes[..length])?;
        let mut observed = self.observation.lock().unwrap();
        observed.bytes += read;
        observed.max_read = observed.max_read.max(bytes.len());
        Ok(read)
    }
}

impl Drop for ObservedFile {
    fn drop(&mut self) { self.observation.lock().unwrap().dropped = true; }
}

#[test]
fn bounded_partition_real_files_exact_limit_oversize_growth_errors_and_release() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("owned");
    for size in [0, MAX_PARTITION_BYTES, MAX_PARTITION_BYTES + 1, 16 * MAX_PARTITION_BYTES] {
        fs::write(&path, []).unwrap();
        fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(size as u64).unwrap();
        let observation = Arc::new(Mutex::new(Observation::default()));
        let result = read_bounded_partition(ObservedFile { file: fs::File::open(&path).unwrap(), observation: observation.clone(), grow: None, fail: false }).unwrap();
        assert_eq!(result.as_ref().map(Vec::len), (size <= MAX_PARTITION_BYTES).then_some(size));
        let observed = observation.lock().unwrap();
        assert!(observed.bytes <= MAX_PARTITION_BYTES + 1);
        assert!(observed.max_read <= 64 * 1024);
        assert!(observed.dropped);
        drop(observed);
        fs::remove_file(&path).unwrap();
        fs::write(&path, "fresh").unwrap();
        assert_eq!(read_bounded_partition(fs::File::open(&path).unwrap()).unwrap().unwrap(), b"fresh");
    }
    for fail in [false, true] {
        fs::write(&path, "été").unwrap();
        assert_eq!(fs::symlink_metadata(&path).unwrap().len(), 5);
        let observation = Arc::new(Mutex::new(Observation::default()));
        let result = read_bounded_partition(ObservedFile { file: fs::File::open(&path).unwrap(), observation: observation.clone(), grow: (!fail).then_some(path.clone()), fail });
        if fail { assert!(result.is_err()); } else {
            assert!(result.unwrap().is_none());
            assert_eq!(observation.lock().unwrap().bytes, MAX_PARTITION_BYTES + 1);
        }
        assert!(observation.lock().unwrap().dropped);
        assert!(observation.lock().unwrap().bytes <= MAX_PARTITION_BYTES + 1);
        fs::remove_file(&path).unwrap();
        fs::write(&path, "été").unwrap();
        assert_eq!(read_bounded_partition(fs::File::open(&path).unwrap()).unwrap().unwrap(), "été".as_bytes());
    }
}

#[test]
fn verified_partition_store_preserves_hash_authority_paths_and_positive_recovery() {
    let root = tempfile::tempdir().unwrap();
    let store = PartitionStore::new(root.path());
    fs::create_dir(&store.directory).unwrap();
    let content = "é".repeat(MAX_PARTITION_BYTES / 2);
    let key = hex_digest(content.as_bytes());
    let path = store.directory.join(&key);
    fs::write(&path, &content).unwrap();
    assert_eq!(store.load(&key, &|| true).unwrap().as_deref(), Some(content.as_str()));
    assert!(store.load(&key, &|| false).is_err());
    for bytes in [b"wrong hash".to_vec(), vec![0; MAX_PARTITION_BYTES + 1], vec![0; 16 * MAX_PARTITION_BYTES]] {
        fs::write(&path, bytes).unwrap();
        assert!(store.load(&key, &|| true).unwrap().is_none());
        fs::write(&path, &content).unwrap();
        assert_eq!(store.load(&key, &|| true).unwrap().as_deref(), Some(content.as_str()));
    }
    fs::remove_file(&path).unwrap();
    assert!(store.load(&key, &|| true).unwrap().is_none());
    fs::create_dir(&path).unwrap();
    assert!(store.load(&key, &|| true).unwrap().is_none());
    fs::remove_dir(&path).unwrap();
    let target = root.path().join("target");
    fs::write(&target, &content).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(&target, &path).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(store.load(&key, &|| true).unwrap().is_none());
    fs::remove_file(&path).unwrap();
    fs::write(&path, &content).unwrap();
    assert_eq!(store.load(&key, &|| true).unwrap().as_deref(), Some(content.as_str()));
}
