use super::{MAX_BYTES, native::Files};
use std::{fs, path::PathBuf};

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let parent =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/rune-store-tests");
        fs::create_dir_all(&parent).unwrap();
        let root = parent.join(format!(
            "trial-rune-store-{}",
            codenomad_client::http::client_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn open(&self) -> Files {
        Files::open(self.0.join("rune")).unwrap()
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn restart_retains_last_complete_write_and_releases_lock() {
    let root = Root::new();
    let first = root.open();
    assert_eq!(first.load().unwrap(), None);
    first.save(br#"{"draft":"first"}"#).unwrap();
    assert!(Files::open(root.0.join("rune")).is_err());
    first.save(br#"{"draft":"second"}"#).unwrap();
    drop(first);
    let second = root.open();
    assert_eq!(second.load().unwrap().unwrap(), br#"{"draft":"second"}"#);
    assert_eq!(fs::read_dir(root.0.join("rune")).unwrap().count(), 2);
}

#[test]
fn oversized_write_preserves_previous_snapshot() {
    let root = Root::new();
    let store = root.open();
    store.save(b"retained").unwrap();
    assert!(store.save(&vec![0; MAX_BYTES + 1]).is_err());
    assert_eq!(store.load().unwrap().unwrap(), b"retained");
    fs::rename(root.0.join("rune/state.json"), root.0.join("retained.json")).unwrap();
    fs::create_dir(root.0.join("rune/state.json")).unwrap();
    assert!(store.save(b"replacement").is_err());
    assert_eq!(fs::read(root.0.join("retained.json")).unwrap(), b"retained");
}

#[test]
fn truncated_data_remains_available_for_validation_without_overwrite() {
    let root = Root::new();
    let store = root.open();
    fs::write(root.0.join("rune/state.json"), b"{\"version\":").unwrap();
    assert_eq!(store.load().unwrap().unwrap(), b"{\"version\":");
    fs::write(root.0.join("rune/state.json"), vec![0; MAX_BYTES + 1]).unwrap();
    assert!(store.load().is_err());
    assert_eq!(
        fs::metadata(root.0.join("rune/state.json")).unwrap().len(),
        MAX_BYTES as u64 + 1
    );
}

#[test]
fn relative_directory_and_file_in_place_of_directory_are_rejected() {
    assert!(Files::open("relative".into()).is_err());
    let root = Root::new();
    fs::write(root.0.join("rune"), b"foreign").unwrap();
    assert!(Files::open(root.0.join("rune")).is_err());
    assert_eq!(fs::read(root.0.join("rune")).unwrap(), b"foreign");
}
