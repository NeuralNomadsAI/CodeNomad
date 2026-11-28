//! Each test installs under an identity and folders of its own, so none touches the user's Start
//! menu or an install's entry.

use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use windows_registry::CURRENT_USER;

use super::*;

const IDENTITIES: &str = r"Software\Classes\AppUserModelId";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A scratch install: a folder holding an install root and a shortcut folder, and an identity no
/// other test or install has. Dropping it removes the folder and whatever it registered.
struct Scratch {
    dir: PathBuf,
    product: Product,
}

impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let tag = format!("test-{}-{n}", std::process::id());
        let dir = std::env::temp_dir().join(format!("codenomad-windows-install-{tag}"));
        std::fs::create_dir_all(dir.join("root")).unwrap();
        std::fs::create_dir_all(dir.join("links")).unwrap();
        std::fs::write(dir.join("root").join(EXE), b"").unwrap();
        let product = Product {
            name: format!("CodeNomad {tag}"),
            id: format!("{APP_ID}.{tag}"),
            version: "1.2.3".into(),
        };
        Self { dir, product }
    }

    fn root(&self) -> PathBuf {
        self.dir.join("root")
    }

    fn links(&self) -> Vec<PathBuf> {
        vec![self.dir.join("links")]
    }

    fn link(&self) -> PathBuf {
        self.dir
            .join("links")
            .join(format!("{}.lnk", self.product.name))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        registry::remove_entry(&self.product);
        registry::remove_identities(&self.product);
        remove_dir(&self.dir);
    }
}

fn entry_string(p: &Product, name: &str) -> Option<String> {
    let key = format!(
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{}",
        p.id
    );
    CURRENT_USER.open(key).ok()?.get_string(name).ok()
}

#[test]
fn register_writes_the_shortcut_and_the_entry_and_unregister_takes_them_away() {
    let s = Scratch::new();
    let exe = s.root().join(EXE);

    register_in(&s.product, &s.root(), &s.links()).unwrap();

    assert!(same_path(&shortcut::target_of(&s.link()).unwrap(), &exe));
    assert_eq!(
        shortcut::app_id_of(&s.link()).as_deref(),
        Some(s.product.id.as_str())
    );
    assert!(same_path(&installed_root(&s.product).unwrap(), &s.root()));
    assert_eq!(
        entry_string(&s.product, "DisplayName").as_deref(),
        Some(s.product.name.as_str())
    );
    assert_eq!(
        entry_string(&s.product, "DisplayVersion").as_deref(),
        Some("1.2.3")
    );
    assert_eq!(
        entry_string(&s.product, "UninstallString"),
        Some(format!("\"{}\" --uninstall", exe.display()))
    );

    let done = unregister_in(&s.product, &s.root(), &s.links());

    assert!(!s.link().exists(), "{done:?}");
    assert_eq!(installed_root(&s.product), None, "{done:?}");
}

#[test]
fn register_never_replaces_a_shortcut_that_starts_another_program() {
    let s = Scratch::new();
    let other = s.dir.join("other.exe");
    std::fs::write(&other, b"").unwrap();
    shortcut::create(&s.link(), &other, "another.app", "Another", &s.dir).unwrap();

    let refused = register_in(&s.product, &s.root(), &s.links());

    assert!(refused.is_err());
    assert!(same_path(&shortcut::target_of(&s.link()).unwrap(), &other));
    assert_eq!(installed_root(&s.product), None);
}

#[test]
fn register_takes_over_the_shortcut_of_its_own_install_in_another_folder() {
    let s = Scratch::new();
    register_in(&s.product, &s.root(), &s.links()).unwrap();
    let moved = s.dir.join("moved");
    std::fs::create_dir_all(&moved).unwrap();
    std::fs::write(moved.join(EXE), b"").unwrap();

    register_in(&s.product, &moved, &s.links()).unwrap();

    assert!(same_path(
        &shortcut::target_of(&s.link()).unwrap(),
        &moved.join(EXE)
    ));
    assert!(same_path(&installed_root(&s.product).unwrap(), &moved));
}

#[test]
fn unregister_from_another_copy_removes_nothing() {
    let s = Scratch::new();
    register_in(&s.product, &s.root(), &s.links()).unwrap();
    let copy = s.dir.join("copy");
    std::fs::create_dir_all(&copy).unwrap();
    std::fs::write(copy.join(EXE), b"").unwrap();

    let done = unregister_in(&s.product, &copy, &s.links());

    assert!(done.is_empty(), "{done:?}");
    assert!(s.link().exists());
    assert!(same_path(&installed_root(&s.product).unwrap(), &s.root()));
}

#[test]
fn refresh_updates_the_version_of_the_registered_install_only() {
    let s = Scratch::new();
    register_in(&s.product, &s.root(), &s.links()).unwrap();
    let newer = Product {
        version: "1.2.4".into(),
        ..s.product.clone()
    };

    refresh(&newer, &s.dir.join("copy")).unwrap();
    assert_eq!(
        entry_string(&s.product, "DisplayVersion").as_deref(),
        Some("1.2.3")
    );

    refresh(&newer, &s.root()).unwrap();
    assert_eq!(
        entry_string(&s.product, "DisplayVersion").as_deref(),
        Some("1.2.4")
    );
}

#[test]
fn unregister_removes_the_notification_identities_of_this_product_only() {
    let s = Scratch::new();
    register_in(&s.product, &s.root(), &s.links()).unwrap();
    let id = &s.product.id;
    let (plain, scoped, sibling) = (
        format!(r"{IDENTITIES}\{id}"),
        format!(r"{IDENTITIES}\{id}.scope.trial"),
        format!(r"{IDENTITIES}\{id}-sibling"),
    );
    for key in [&plain, &scoped, &sibling] {
        CURRENT_USER.create(key).unwrap();
    }

    unregister_in(&s.product, &s.root(), &s.links());

    let left = [&plain, &scoped, &sibling].map(|key| CURRENT_USER.open(key).is_ok());
    CURRENT_USER.remove_tree(&sibling).unwrap();
    assert_eq!(left, [false, false, true]);
}

#[test]
fn close_running_ends_a_copy_started_from_the_install_and_nothing_else() {
    let s = Scratch::new();
    let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
    let exe = s.root().join(EXE);
    std::fs::copy(system.join("ping.exe"), &exe).unwrap();
    let spawn = |program: &Path| {
        std::process::Command::new(program)
            .args(["-n", "60", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap()
    };
    let mut ours = spawn(&exe);
    let mut other = spawn(&system.join("ping.exe"));

    assert_eq!(running_under(&s.root()), [ours.id()]);
    assert!(close_running(&s.root(), Duration::from_millis(300)));

    assert!(ours.wait().is_ok());
    let other_still_runs = other.try_wait().unwrap().is_none();
    other.kill().ok();
    other.wait().ok();
    assert!(other_still_runs);
    assert!(running_under(&s.root()).is_empty());
}

#[test]
fn only_an_install_folder_can_be_removed() {
    let s = Scratch::new();
    assert_eq!(root::check_installed(&s.root()), Ok(()));

    let refused = |path: &Path| root::check_installed(path).is_err();
    let profile = folders::profile().unwrap();
    std::fs::create_dir_all(s.dir.join("empty")).unwrap();
    assert!(refused(&s.dir.join("empty")), "no application in it");
    assert!(refused(&profile), "the user's profile");
    assert!(refused(profile.parent().unwrap()), "holds the profile");
    assert!(refused(Path::new(r"C:\")), "a drive");
    assert!(refused(Path::new(r"C:\Windows")), "at a drive's top");
    assert!(refused(Path::new(r"relative\root")), "not absolute");

    let junction = s.dir.join("junction");
    let made = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .args([&junction, &s.root()])
        .stdout(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .unwrap();
    assert!(made.success() && junction.join(EXE).is_file());
    assert!(refused(&junction), "a junction to an install");
    std::fs::remove_dir(&junction).unwrap();
}

#[test]
fn the_install_folder_goes_once_nothing_holds_it_and_its_siblings_stay() {
    let s = Scratch::new();
    let root = s.dir.join("Code & Nomad ^ 100% !ok! (x)");
    std::fs::create_dir_all(root.join("nested")).unwrap();
    std::fs::write(root.join(EXE), b"").unwrap();
    // Opened without sharing, as Windows holds a running program's file.
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(root.join(EXE))
        .unwrap();

    uninstall::remove_after_exit(&root).unwrap();
    std::thread::sleep(Duration::from_secs(1));
    assert!(root.join(EXE).exists(), "a held file stays");
    drop(held);

    let gone = (0..80).any(|_| {
        std::thread::sleep(Duration::from_millis(250));
        !root.exists()
    });
    assert!(gone);
    assert!(s.root().join(EXE).is_file() && s.dir.join("links").is_dir());

    // A folder installed there afterwards is not the command's to delete.
    std::fs::create_dir_all(&root).unwrap();
    std::thread::sleep(Duration::from_secs(4));
    assert!(root.is_dir());
}

#[test]
fn the_setup_only_takes_a_folder_that_is_absent_empty_or_its_own_install() {
    let s = Scratch::new();
    let target = |path: &Path| check_install_target(&s.product, path);

    assert_eq!(target(&s.dir.join("absent")), Ok(()));
    std::fs::create_dir_all(s.dir.join("empty")).unwrap();
    assert_eq!(target(&s.dir.join("empty")), Ok(()));

    // The scratch root holds a program of the right name, but no entry names it.
    assert!(
        target(&s.root()).is_err(),
        "a folder that is not the install"
    );
    let documents = s.dir.join("documents");
    std::fs::create_dir_all(&documents).unwrap();
    std::fs::write(documents.join("thesis.txt"), b"years of work").unwrap();
    assert!(target(&documents).is_err(), "a folder holding other files");
    std::fs::write(s.dir.join("file"), b"").unwrap();
    assert!(target(&s.dir.join("file")).is_err(), "a file");

    let profile = folders::profile().unwrap();
    assert!(target(&profile).is_err(), "the user's profile");
    assert!(
        target(profile.parent().unwrap()).is_err(),
        "holds the profile"
    );
    assert!(
        target(Path::new(r"D:\CodeNomad Rune")).is_err(),
        "at a drive's top"
    );
    assert!(target(Path::new(r"relative\root")).is_err(), "not absolute");

    // One of the user's folders reached through a junction in a parent is still that folder.
    let users = s.dir.join("users");
    let made = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .args([&users, &profile.parent().unwrap().to_path_buf()])
        .stdout(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .unwrap();
    assert!(made.success());
    let same_profile = users.join(profile.file_name().unwrap());
    assert!(
        target(&same_profile).is_err_and(|why| why.contains("your own folders")),
        "the profile through a junction"
    );
    assert_eq!(target(&users.join("no such user")), Ok(()), "beside it");
    std::fs::remove_dir(&users).unwrap();
    register_in(&s.product, &s.root(), &s.links()).unwrap();
    assert_eq!(target(&s.root()), Ok(()), "the registered install");
}

#[test]
fn a_copy_started_through_a_junction_is_seen_running() {
    let s = Scratch::new();
    let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
    std::fs::copy(system.join("ping.exe"), s.root().join(EXE)).unwrap();
    let junction = s.dir.join("via");
    let made = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .args([&junction, &s.root()])
        .stdout(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .unwrap();
    assert!(made.success());
    let mut copy = std::process::Command::new(s.root().join(EXE))
        .args(["-n", "60", "127.0.0.1"])
        .stdout(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .unwrap();

    let seen = running_under(&junction);
    copy.kill().ok();
    copy.wait().ok();
    std::fs::remove_dir(&junction).unwrap();
    assert_eq!(seen, [copy.id()]);
}
