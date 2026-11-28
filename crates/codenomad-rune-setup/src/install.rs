//! The installing itself, shared by the pages and `--silent`.

use std::fs::OpenOptions;
use std::io::Write as _;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use codenomad_windows_install::{self as windows_install, EXE, Product};

/// The application: a zip of its install folder (see `build.rs`).
static PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.zip"));

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
/// How long a running copy has to close on its own before the setup ends it.
const CLOSE_GRACE: Duration = Duration::from_secs(10);

fn product() -> Product {
    let version = option_env!("CODENOMAD_RUNE_VERSION").filter(|v| !v.is_empty());
    Product::release(version.unwrap_or(env!("CARGO_PKG_VERSION")))
}

/// What the command line asked for.
#[derive(Clone, Default)]
pub struct Args {
    pub silent: bool,
    pub desktop_shortcut: bool,
    pub launch: bool,
    pub dir: Option<PathBuf>,
    pub log: Option<PathBuf>,
}

impl Args {
    fn parse() -> Args {
        let mut a = Args::default();
        let mut it = std::env::args().skip(1);
        while let Some(flag) = it.next() {
            match flag.as_str() {
                "--silent" | "/S" => a.silent = true,
                "--desktop-shortcut" => a.desktop_shortcut = true,
                "--launch" => a.launch = true,
                "--dir" => a.dir = it.next().map(PathBuf::from),
                "--log" => a.log = it.next().map(PathBuf::from),
                _ => {}
            }
        }
        a
    }

    pub fn log(&self, line: &str) {
        let Some(path) = &self.log else { return };
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
            writeln!(f, "[setup pid {}] {line}", std::process::id()).ok();
        }
    }
}

pub fn run() -> i32 {
    let args = Args::parse();
    let p = product();
    let Some(root) = args
        .dir
        .clone()
        .or_else(|| windows_install::default_root(&p))
    else {
        args.log("no folder to install in");
        return 1;
    };
    if !args.silent {
        return crate::pages::run(&p, &root, &args);
    }
    match install(&p, &root, args.desktop_shortcut, &|line| args.log(line)) {
        Ok(()) if args.launch => launch(&root, &args),
        Ok(()) => 0,
        Err(e) => {
            args.log(&format!("couldn't install: {e}"));
            1
        }
    }
}

/// Whether a copy of the application runs from `root`, which installing closes.
pub fn running(root: &Path) -> bool {
    !windows_install::running_under(root).is_empty()
}

/// Installs the payload at `root` and registers it.
pub fn install(
    p: &Product,
    root: &Path,
    desktop_shortcut: bool,
    log: &dyn Fn(&str),
) -> Result<(), String> {
    log(&format!(
        "installing {} {} into {}",
        p.name,
        p.version,
        root.display()
    ));
    if !windows_install::close_running(root, CLOSE_GRACE) {
        return Err(format!(
            "{} is still running. Close it and try again.",
            p.name
        ));
    }
    place(PAYLOAD, root, log)?;
    windows_install::register(p, root, desktop_shortcut)?;
    log(&format!(
        "registered {} (Start menu{}, Apps & features)",
        p.name,
        if desktop_shortcut { ", desktop" } else { "" }
    ));
    Ok(())
}

/// Puts the install folder `payload` zips at `root`. A version already there is replaced with
/// renames on one volume and comes back if the new one cannot take its place.
pub(crate) fn place(payload: &[u8], root: &Path, log: &dyn Fn(&str)) -> Result<(), String> {
    if payload.is_empty() {
        return Err(
            "This setup was built without the application, so there is nothing to install.".into(),
        );
    }
    let parent = root
        .parent()
        .ok_or("The install folder has no parent folder.")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let staging = beside(root, &format!("setup-{}", std::process::id()));
    let result = unpack(payload, &staging).and_then(|app| swap(root, &app, log));
    windows_install::remove_dir(&staging);
    result
}

/// Unpacks the payload into `staging` with Windows' own bsdtar; returns the application's folder
/// in it. bsdtar reads its arguments in the ANSI code page, where a user folder named `测试`
/// arrives as `??`: so the zip goes in on standard input and `staging` is the working directory,
/// and no path is an argument.
fn unpack(payload: &[u8], staging: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(staging).map_err(|e| format!("{}: {e}", staging.display()))?;
    let zip = staging.join("payload.zip");
    std::fs::write(&zip, payload).map_err(|e| format!("couldn't write the application: {e}"))?;
    let archive =
        std::fs::File::open(&zip).map_err(|e| format!("couldn't read the application: {e}"))?;
    let system =
        std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
    let out = Command::new(system.join("System32").join("tar.exe"))
        .args(["-xf", "-"])
        .current_dir(staging)
        .stdin(archive)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("couldn't run tar: {e}"))?;
    std::fs::remove_file(&zip).ok();
    if !out.status.success() {
        return Err(format!(
            "couldn't unpack the application: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    if staging.join(EXE).is_file() {
        return Ok(staging.to_path_buf());
    }
    let dirs: Vec<PathBuf> = std::fs::read_dir(staging)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    match dirs.as_slice() {
        [one] if one.join(EXE).is_file() => Ok(one.clone()),
        _ => Err(format!("The application in this setup has no {EXE}.")),
    }
}

fn swap(root: &Path, app: &Path, log: &dyn Fn(&str)) -> Result<(), String> {
    if !root.exists() {
        return rename(app, root)
            .map_err(|e| format!("couldn't put the application in {}: {e}", root.display()));
    }
    let old = beside(root, &format!("old-{}", std::process::id()));
    rename(root, &old).map_err(|e| format!("couldn't move the installed version aside: {e}"))?;
    if let Err(e) = rename(app, root) {
        rename(&old, root).ok();
        return Err(format!(
            "couldn't put the application in {}: {e}",
            root.display()
        ));
    }
    log("replaced the installed version");
    windows_install::remove_dir(&old);
    Ok(())
}

fn rename(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last = None;
    for _ in 0..40 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

/// `<parent>\.<folder>.<what>`, beside the install.
fn beside(root: &Path, what: &str) -> PathBuf {
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    root.parent()
        .unwrap_or(root)
        .join(format!(".{name}.{what}"))
}

/// Starts the installed application in the user's home folder, as its Start menu shortcut does.
///
/// Without `__COMPAT_LAYER`: Windows starts a setup program with its Program Compatibility
/// Assistant's layer in the environment, and a process created with that variable runs with the
/// shim engine hooking every module, as would every process the application starts afterwards.
pub fn launch(root: &Path, args: &Args) -> i32 {
    let exe = root.join(EXE);
    let home = std::env::var_os("USERPROFILE").map_or_else(|| root.to_path_buf(), PathBuf::from);
    match Command::new(&exe)
        .current_dir(home)
        .env_remove("__COMPAT_LAYER")
        .creation_flags(DETACHED_PROCESS)
        .spawn()
    {
        Ok(child) => {
            args.log(&format!("started {} (pid {})", exe.display(), child.id()));
            0
        }
        Err(e) => {
            args.log(&format!("couldn't start {}: {e}", exe.display()));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch folder, and a zip of an install folder holding `files`.
    fn scratch(tag: &str, files: &[(&str, &str)]) -> (PathBuf, Vec<u8>) {
        let dir =
            std::env::temp_dir().join(format!("codenomad-rune-setup-{}-{tag}", std::process::id()));
        windows_install::remove_dir(&dir);
        let source = dir.join("source");
        std::fs::create_dir_all(&source).unwrap();
        for (name, text) in files {
            std::fs::write(source.join(name), text).unwrap();
        }
        let zipped = Command::new("tar.exe")
            .args(["-a", "-cf", "../payload.zip", "*"])
            .current_dir(&source)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .unwrap();
        assert!(zipped.success());
        let payload = std::fs::read(dir.join("payload.zip")).unwrap();
        (dir, payload)
    }

    fn left_beside(root: &Path) -> Vec<String> {
        std::fs::read_dir(root.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with('.'))
            .collect()
    }

    #[test]
    fn place_installs_then_replaces_the_previous_version_and_leaves_nothing_beside() {
        let (dir, first) = scratch("replace", &[(EXE, "one"), ("old-only.txt", "x")]);
        let root = dir.join("测试 app");
        place(&first, &root, &|_| {}).unwrap();
        assert_eq!(std::fs::read_to_string(root.join(EXE)).unwrap(), "one");

        let (other, second) = scratch("replace-2", &[(EXE, "two")]);
        place(&second, &root, &|_| {}).unwrap();

        assert_eq!(std::fs::read_to_string(root.join(EXE)).unwrap(), "two");
        assert!(!root.join("old-only.txt").exists());
        assert_eq!(left_beside(&root), Vec::<String>::new());
        windows_install::remove_dir(&dir);
        windows_install::remove_dir(&other);
    }

    #[test]
    fn a_payload_without_the_application_leaves_the_install_as_it_was() {
        let (dir, good) = scratch("keep", &[(EXE, "one")]);
        let root = dir.join("app");
        place(&good, &root, &|_| {}).unwrap();
        let (other, bad) = scratch("keep-2", &[("readme.txt", "no exe")]);

        assert!(place(&bad, &root, &|_| {}).is_err());
        assert!(place(&[], &root, &|_| {}).is_err());
        assert!(place(b"not a zip", &root, &|_| {}).is_err());

        assert_eq!(std::fs::read_to_string(root.join(EXE)).unwrap(), "one");
        assert_eq!(left_beside(&root), Vec::<String>::new());
        windows_install::remove_dir(&dir);
        windows_install::remove_dir(&other);
    }
}
