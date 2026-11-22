//! Explicit private roots only; a kernel lock owns each backend lifetime.
use super::config::{LaunchConfig, identity};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const MARKER: &str = ".rune-host.json";
const LOCK: &str = ".rune-host.lock";
fn expected(root: &Path, profile: &str) -> io::Result<Value> {
    Ok(json!({
        "version": 1,
        "kind": "codenomad-rune-isolated-host",
        "root": identity(root)?,
        "profile": profile,
        "config_identity": identity(&root.join("config/config.yaml"))?,
    }))
}
fn rejected() -> io::Error {
    io::Error::other("Persistent isolated host ownership unavailable")
}
fn unlinked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        !meta.file_type().is_symlink() && meta.file_attributes() & 0x400 == 0
    }
    #[cfg(not(windows))]
    {
        !meta.file_type().is_symlink()
    }
}
fn directories(path: &Path) -> io::Result<()> {
    for ancestor in path.ancestors() {
        let meta = fs::symlink_metadata(ancestor)?;
        if !meta.is_dir() || !unlinked(&meta) {
            return Err(rejected());
        }
    }
    Ok(())
}
fn open(path: &Path, create: bool) -> io::Result<File> {
    directories(path.parent().ok_or_else(rejected)?)?;
    if !create {
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_file() || !unlinked(&meta) {
            return Err(rejected());
        }
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(create || path.file_name() == Some(LOCK.as_ref()))
        .create_new(create);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0).custom_flags(0x00200000);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || !unlinked(&meta) {
        return Err(rejected());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err(rejected());
        }
    }
    directories(path.parent().ok_or_else(rejected)?)?;
    Ok(file)
}
fn owner(root: &Path) -> io::Result<Value> {
    let file = open(&root.join(MARKER), false)?;
    if file.metadata()?.len() > 8192 {
        return Err(rejected());
    }
    let mut bytes = Vec::new();
    file.take(8193).read_to_end(&mut bytes)?;
    if bytes.len() > 8192 {
        return Err(rejected());
    }
    serde_json::from_slice(&bytes).map_err(|_| rejected())
}
fn validate(root: &Path, expected: &Value) -> io::Result<()> {
    directories(root)?;
    if owner(root)? != *expected {
        return Err(rejected());
    }
    for key in super::config::TRIAL_DIRS {
        directories(&root.join(key))?;
    }
    directories(&root.join("rune"))?;
    open(&root.join("config/config.yaml"), false)?;
    Ok(())
}
pub(super) struct Lease {
    file: File,
}
impl Drop for Lease {
    fn drop(&mut self) {
        // A concurrent fork can retain a duplicate until exec.
        let _ = self.file.unlock();
    }
}
fn lock(root: &Path, create: bool) -> io::Result<Lease> {
    let file = open(&root.join(LOCK), create)?;
    file.try_lock()
        .map_err(|_| io::Error::other("Persistent isolated host is in use"))?;
    Ok(Lease { file })
}
pub(super) fn prepare(executable: PathBuf, root: &Path, profile: &str) -> io::Result<LaunchConfig> {
    let profile = LaunchConfig::trial_profile(root, profile)?;
    directories(root.parent().ok_or_else(rejected)?)?;
    let fresh = match fs::create_dir(root) {
        Ok(()) => true,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => false,
        Err(e) => return Err(e),
    };
    directories(root)?;
    let root = fs::canonicalize(root)?;
    let expected = expected(&root, &profile)?;
    // Existing foreign roots are read-only even when their marker is absent or invalid.
    if !fresh && owner(&root)? != expected {
        return Err(rejected());
    }
    let _lease = lock(&root, fresh)?;
    if fresh {
        LaunchConfig::initialize(&root)?;
        fs::create_dir(root.join("rune"))?;
        let mut file = open(&root.join(MARKER), true)?;
        file.write_all(&serde_json::to_vec(&expected).map_err(|_| rejected())?)?;
        file.sync_all()?;
    }
    validate(&root, &expected)?;
    let mut config = LaunchConfig::isolated(executable, &root, &profile)?;
    config.persistent_root = Some(root);
    Ok(config)
}
pub(super) fn acquire(config: &LaunchConfig) -> io::Result<Option<Lease>> {
    let Some(root) = &config.persistent_root else {
        return Ok(None);
    };
    let profile = LaunchConfig::trial_profile(root, &config.profile)?;
    let expected = expected(root, &profile)?;
    if config.config_identity != identity(&root.join("config/config.yaml"))?
        || config.config_file != root.join("config/config.yaml")
        || config.working_directory != root.join("working")
    {
        return Err(rejected());
    }
    let lease = lock(root, false)?;
    validate(root, &expected)?;
    Ok(Some(lease))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let workspace =
                fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap();
            let parent = workspace.join("target/rune-host-tests");
            fs::create_dir_all(&parent).unwrap();
            let parent = fs::canonicalize(parent).unwrap();
            assert!(parent.starts_with(workspace));
            Self(parent.join(format!(
                        "trial-persistent-{}-{}",
                        std::process::id(),
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_nanos()
                    )))
        }
        fn config(&self, profile: &str) -> io::Result<LaunchConfig> {
            prepare(std::env::current_exe().unwrap(), &self.0, profile)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn reopens_preserving_configuration_and_excludes_concurrent_owners() {
        let root = Root::new();
        let first = root.config("trial-reopen").unwrap();
        let bytes = b"{\"server\":{},\"alphaFixture\":true}\n";
        fs::write(&first.config_file, bytes).unwrap();
        let lease = acquire(&first).unwrap();
        assert!(acquire(&first.clone()).is_err());
        assert!(root.config("trial-reopen").is_err());
        drop(lease);
        let second = root.config("trial-reopen").unwrap();
        assert_eq!(fs::read(&second.config_file).unwrap(), bytes);
        assert_eq!(first.config_identity, second.config_identity);
        assert!(acquire(&second).unwrap().is_some());
        let mut missing = second.clone();
        missing.executable = root.0.join("absent-server");
        assert!(super::super::Controller::default().launch(missing).is_err());
        assert!(
            acquire(&second).unwrap().is_some(),
            "failed spawn must release its owned lock"
        );
    }
    #[cfg(unix)]
    #[test]
    fn releasing_a_lease_does_not_wait_for_inherited_descriptors() {
        let root = Root::new();
        let config = root.config("trial-inherited").unwrap();
        let file = open(&root.0.join(LOCK), false).unwrap();
        file.try_lock().unwrap();
        let inherited = file.try_clone().unwrap();
        drop(file);
        assert!(
            acquire(&config).is_err(),
            "control: a duplicate retains a close-only lock"
        );
        drop(inherited);

        let lease = acquire(&config).unwrap().unwrap();
        let inherited = lease.file.try_clone().unwrap();
        drop(lease);
        let replacement = acquire(&config).unwrap().unwrap();
        assert!(
            acquire(&config).is_err(),
            "the replacement still owns the lock"
        );
        drop(inherited);
        assert!(acquire(&config).is_err());
        drop(replacement);
        assert!(acquire(&config).unwrap().is_some());
    }
    #[test]
    fn foreign_version_profile_and_identity_fail_closed() {
        let root = Root::new();
        fs::create_dir(&root.0).unwrap();
        fs::write(root.0.join("foreign"), b"keep").unwrap();
        assert!(root.config("trial-foreign").is_err());
        assert!(!root.0.join(LOCK).exists());
        fs::remove_dir_all(&root.0).unwrap();
        let config = root.config("trial-owned").unwrap();
        assert!(root.config("trial-other").is_err());
        let mut changed = config.clone();
        changed.config_file = root.0.join("another.yaml");
        assert!(acquire(&changed).is_err());
        let marker = config.persistent_root.as_ref().unwrap().join(MARKER);
        let original = fs::read(&marker).unwrap();
        let mut value: Value = serde_json::from_slice(&original).unwrap();
        value["version"] = 2.into();
        fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(root.config("trial-owned").is_err());
        fs::write(&marker, original).unwrap();
        assert!(root.config("trial-owned").is_ok());
    }
    #[test]
    fn one_fresh_initializer_wins_without_overwriting_foreign_data() {
        let root = Root::new();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let path = root.0.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    prepare(std::env::current_exe().unwrap(), &path, "trial-race")
                })
            })
            .collect();
        let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert!(results.iter().any(Result::is_ok));
        assert!(root.config("trial-race").is_ok());
        let marker = root.0.join(MARKER);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
        value["extra"] = true.into();
        let bytes = serde_json::to_vec(&value).unwrap();
        fs::write(&marker, &bytes).unwrap();
        assert!(root.config("trial-race").is_err());
        assert_eq!(fs::read(marker).unwrap(), bytes);
    }
    #[test]
    #[ignore = "requires explicit real Rust server executable"]
    fn owned_process_releases_lock_only_after_closure() {
        let executable = PathBuf::from(
            std::env::var_os("CODENOMAD_HOST_TEST_SERVER").expect("explicit real server"),
        );
        let root = Root::new();
        let config = prepare(executable, &root.0, "trial-process-lock").unwrap();
        let controller = super::super::Controller::default();
        let mut child = controller.launch(config.clone()).unwrap();
        child.connect().unwrap();
        let generation = controller
            .generation
            .load(std::sync::atomic::Ordering::SeqCst);
        assert!(controller.launch(config.clone()).is_err());
        assert_eq!(
            controller
                .generation
                .load(std::sync::atomic::Ordering::SeqCst),
            generation
        );
        assert!(acquire(&config).is_err());
        assert!(root.config("trial-process-lock").is_err());
        let report = child.stop().unwrap();
        assert!(!report.forced && report.native_cleanup_confirmed);
        assert_eq!(report.exit_code, Some(0));
        let bytes = fs::read(&config.config_file).unwrap();
        assert!(acquire(&config).unwrap().is_some());
        let reopened = prepare(config.executable.clone(), &root.0, "trial-process-lock").unwrap();
        assert!(fs::read(&config.config_file).unwrap() == bytes);
        let mut next = controller.launch(reopened).unwrap();
        next.connect().unwrap();
        let report = next.stop().unwrap();
        assert!(!report.forced && report.native_cleanup_confirmed);
        assert_eq!(report.exit_code, Some(0));
        assert!(fs::read(&config.config_file).unwrap() == bytes);
    }
    #[cfg(unix)]
    #[test]
    fn linked_root_and_config_are_refused() {
        let root = Root::new();
        let config = root.config("trial-links").unwrap();
        let alias = Root::new();
        std::os::unix::fs::symlink(&root.0, &alias.0).unwrap();
        assert!(alias.config("trial-links").is_err());
        fs::remove_file(&alias.0).unwrap();
        let source = root.0.join("source");
        fs::rename(&config.config_file, &source).unwrap();
        std::os::unix::fs::symlink(&source, &config.config_file).unwrap();
        assert!(acquire(&config).is_err());
    }
}
