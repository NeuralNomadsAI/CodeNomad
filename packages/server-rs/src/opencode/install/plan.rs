//! Where OpenCode may be installed and which one runs (`sharedInstallationPlan`,
//! `resolveDefaultInstallation`, `foreign-probe.ts`): a verified `@opencode/cli` npm launcher is
//! updated in its prefix; an OpenCode 1.x `opencode-ai` npm shim in the same prefix may be
//! replaced only with explicit consent; a foreign PATH command that cannot run or reports a
//! release below the minimum is never modified, OpenCode 2 is installed beside it in the user
//! npm prefix (the user's explicit install action) and then preferred; any other foreign command
//! keeps its authority.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

use serde_json::{Value, json};

use super::{Error, layout, layout::Prefix, legacy, legacy::Legacy};
use crate::opencode::{admission, launch};

pub struct Foreign {
    pub command: String,
    pub version: Option<String>,
    pub source: &'static str,
    pub package_id: Option<String>,
    /// Why OpenCode 2 cannot go beside it: `occupied` or `unwritable`, and the path.
    pub blocked: Option<(&'static str, String)>,
}

#[derive(Default)]
pub struct Plan {
    pub prefix: Option<Prefix>,
    pub legacy: Option<Legacy>,
    pub foreign: Option<Foreign>,
}

pub fn user_prefix() -> Option<Prefix> {
    launch::npm_prefix().map(|root| Prefix { root })
}

/// `commandPrefix`: the prefix of a command in its npm bin directory.
fn command_prefix(command: &str) -> Prefix {
    let directory = Path::new(command).parent().unwrap_or(Path::new(""));
    let root =
        if cfg!(windows) { directory.to_path_buf() } else { directory.parent().unwrap_or(directory).to_path_buf() };
    Prefix { root }
}

fn same(a: &Path, b: &Path) -> bool {
    dunce::canonicalize(a).ok().zip(dunce::canonicalize(b).ok()).is_some_and(|(a, b)| a == b)
}

/// `npmLauncher`: `command` is the npm shim of `prefix`'s `@opencode/cli` and runs its binary.
fn launcher(command: &str, prefix: &Prefix) -> bool {
    let manifest: Option<Value> =
        std::fs::read(prefix.package().join("package.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let name = Path::new(command).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name = if cfg!(windows) {
        name.strip_suffix(".cmd").or(name.strip_suffix(".CMD")).unwrap_or(&name).to_owned()
    } else {
        name
    };
    let declared =
        manifest.is_some_and(|m| m["name"] == super::package::CLI && m["bin"][&name] == layout::DECLARED_BIN);
    let resolved =
        if cfg!(windows) { launch::npm_executable(command).map(PathBuf::from) } else { Some(PathBuf::from(command)) };
    declared && resolved.is_some_and(|r| prefix.binary().is_file() && same(&r, &prefix.binary()))
}

/// `isIncompleteWindowsNpmShim`: npm's exact shim left in the user prefix without its package.
fn incomplete_shim(command: &str, user: &Prefix) -> bool {
    cfg!(windows)
        && Path::new(command).parent().is_some_and(|d| same(d, &user.root))
        && Path::new(command)
            .file_name()
            .is_some_and(|n| matches!(n.to_string_lossy().to_lowercase().as_str(), "opencode.cmd" | "opencode2.cmd"))
        && !user.binary().exists()
        && std::fs::read(command).is_ok_and(|t| layout::cmd_shim_matches(&t))
}

/// `npmCommand`: the user prefix's own `opencode2`/`opencode` launcher.
pub fn npm_command(prefix: &Prefix) -> Option<String> {
    ["opencode2", "opencode"].iter().find_map(|name| {
        let command = prefix.commands().join(if cfg!(windows) { format!("{name}.cmd") } else { name.to_string() });
        let command = command.to_string_lossy().into_owned();
        launcher(&command, prefix).then_some(command)
    })
}

/// `findPathOpenCode` restricted to the prefix's command directory.
fn command_in(prefix: &Prefix) -> Option<String> {
    let extensions: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat"] } else { &[""] };
    ["opencode2", "opencode"].iter().find_map(|name| {
        extensions
            .iter()
            .map(|e| prefix.commands().join(format!("{name}{e}")))
            .find(|c| c.is_file())
            .map(|c| c.to_string_lossy().into_owned())
    })
}

fn writable(path: &Path, allow_missing: bool) -> bool {
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let Ok(cstr) = CString::new(path.as_os_str().as_bytes()) else { return false };
        // SAFETY: `cstr` is a valid NUL-terminated path passed to POSIX `access(2)`.
        if unsafe { libc::access(cstr.as_ptr(), libc::W_OK) } == 0 {
            return true;
        }
        allow_missing && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT)
    }
    #[cfg(not(unix))]
    match std::fs::metadata(path) {
        Ok(meta) => !meta.permissions().readonly(),
        Err(e) => allow_missing && e.kind() == std::io::ErrorKind::NotFound,
    }
}

enum Target {
    Writable(Prefix, Option<Legacy>),
    Unwritable,
}

/// `npmTarget`: an `@opencode/cli` launcher (or an incomplete user shim) may be updated in place;
/// a verified `opencode-ai` 1.x shim in a writable prefix may be replaced with explicit consent.
fn npm_target(command: &str, prefix: Prefix, user: &Prefix) -> Option<Target> {
    if launcher(command, &prefix) || incomplete_shim(command, user) {
        return Some(if writable(&prefix.root, false) { Target::Writable(prefix, None) } else { Target::Unwritable });
    }
    let found = legacy::legacy_npm_installation(command, &prefix)?;
    writable(&prefix.root, false).then_some(Target::Writable(prefix, Some(found)))
}

type Probe = Option<(bool, Option<String>)>;
/// Definite results per file identity; an unknown (timed out) one is retried after a minute.
/// Per command: its file identity, the result and when an unknown one expires.
type Cached = (String, Probe, Option<Instant>);
static PROBES: Mutex<Option<HashMap<String, Cached>>> = Mutex::new(None);

fn identity(command: &str) -> Option<String> {
    let mut files = vec![dunce::canonicalize(command).ok()?];
    if let Some(target) = launch::npm_executable(command) {
        files.push(dunce::canonicalize(target).ok()?);
    }
    let parts: Option<Vec<String>> = files
        .iter()
        .map(|f| {
            let meta = std::fs::metadata(f).ok()?;
            let modified = meta.modified().ok()?.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_nanos();
            Some(format!("{}:{modified}:{}", f.display(), meta.len()))
        })
        .collect();
    Some(parts?.join("|"))
}

/// `probeForeignCommand`: a bounded `--version` (5 s), cached; `None` is unknown.
async fn probe_foreign(command: &str, force: bool) -> Probe {
    let key = identity(command)?;
    if !force {
        let cached = PROBES.lock().unwrap().as_ref().and_then(|m| m.get(command).cloned());
        if let Some((k, result, expires)) = cached
            && k == key
            && expires.is_none_or(|e| Instant::now() < e)
        {
            return result;
        }
    }
    let result = match super::probe_version(command, Duration::from_secs(5)).await {
        super::Probed::Version(version) => Some((true, Some(version).filter(|v| !v.is_empty()))),
        super::Probed::Unknown => None,
        _ => Some((false, None)),
    };
    if identity(command).as_deref() == Some(key.as_str()) {
        let expires = result.is_none().then(|| Instant::now() + Duration::from_secs(60));
        PROBES.lock().unwrap().get_or_insert_with(HashMap::new).insert(command.into(), (key, result.clone(), expires));
    }
    result
}

/// `supersededForeign`: a foreign command that cannot run or reports a comparable release below
/// the minimum; valid, custom-labelled and unknown ones keep PATH precedence.
async fn superseded_foreign(command: &str, force: bool) -> Option<Foreign> {
    let (valid, version) = probe_foreign(command, force).await?;
    let comparable = version.as_deref().is_some_and(|v| super::package::exact(v) || v.starts_with("0.0.0-beta-"));
    if valid && !(comparable && admission::below_minimum(version.as_deref().unwrap_or_default())) {
        return None;
    }
    let package = winget(command);
    let version = if valid { version } else { None };
    Some(Foreign {
        command: command.into(),
        version,
        source: if package.is_some() { "winget" } else { "other" },
        package_id: package.flatten(),
        blocked: None,
    })
}

/// `wingetInstallation`: a default winget Links or Packages location; the package ID only when the
/// resolved folder name proves it.
fn winget(command: &str) -> Option<Option<String>> {
    if !cfg!(windows) {
        return None;
    }
    let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let (local, files, files86) = (var("LOCALAPPDATA"), var("ProgramFiles"), var("ProgramFiles(x86)"));
    let links =
        [local.as_ref().map(|l| l.join("Microsoft\\WinGet\\Links")), files.as_ref().map(|p| p.join("WinGet\\Links"))];
    let roots = [
        local.map(|l| l.join("Microsoft\\WinGet\\Packages")),
        files.map(|p| p.join("WinGet\\Packages")),
        files86.map(|p| p.join("WinGet\\Packages")),
    ];
    let target = dunce::canonicalize(command).unwrap_or_else(|_| command.into());
    let lower = |p: &Path| p.to_string_lossy().to_lowercase();
    let parent = Path::new(command).parent().map(lower).unwrap_or_default();
    let linked = links.iter().flatten().any(|l| lower(l) == parent);
    let root = roots.iter().flatten().find(|r| lower(&target).starts_with(&(lower(r) + "\\")));
    if !linked && root.is_none() {
        return None;
    }
    let directory = root.and_then(|r| {
        target.strip_prefix(r).ok()?.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned())
    });
    let id = directory.and_then(|d| d.strip_suffix("_Microsoft.Winget.Source_8wekyb3d8bbwe").map(str::to_owned));
    Some(id.filter(|i| {
        i.starts_with(|c: char| c.is_ascii_alphanumeric())
            && i.bytes().all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
    }))
}

/// `sharedInstallationPlan`.
pub async fn plan(force: bool) -> Plan {
    let Some(user) = user_prefix().filter(|u| !launch::retired(&u.root.to_string_lossy())) else {
        return Plan::default();
    };
    let command = launch::path_command();
    let user_command = command_in(&user);
    let from_target = |t: Option<Target>| match t {
        Some(Target::Writable(prefix, legacy)) => (Some(prefix), legacy),
        _ => (None, None),
    };
    let Some(command) = command else {
        return match &user_command {
            Some(c) => {
                let (prefix, legacy) = from_target(npm_target(c, Prefix { root: user.root.clone() }, &user));
                Plan { prefix, legacy, foreign: None }
            }
            None => Plan { prefix: Some(user), legacy: None, foreign: None },
        };
    };
    if let Some(found) = npm_target(&command, command_prefix(&command), &user) {
        let (prefix, legacy) = from_target(Some(found));
        return Plan { prefix, legacy, foreign: None };
    }
    let Some(mut foreign) = superseded_foreign(&command, force).await else { return Plan::default() };
    let unwritable = Some(("unwritable", user.root.to_string_lossy().into_owned()));
    let Some(user_command) = user_command else {
        if writable(&user.root, true) {
            return Plan { prefix: Some(user), legacy: None, foreign: Some(foreign) };
        }
        foreign.blocked = unwritable;
        return Plan { prefix: None, legacy: None, foreign: Some(foreign) };
    };
    match npm_target(&user_command, Prefix { root: user.root.clone() }, &user) {
        Some(Target::Writable(prefix, legacy)) => Plan { prefix: Some(prefix), legacy, foreign: Some(foreign) },
        // A recognized npm installation there only lacks write access; anything else holds the name.
        Some(Target::Unwritable) => {
            Plan { prefix: None, legacy: None, foreign: Some(Foreign { blocked: unwritable, ..foreign }) }
        }
        None => {
            let blocked = if legacy::legacy_npm_installation(&user_command, &user).is_some() {
                unwritable
            } else {
                Some(("occupied", user_command))
            };
            Plan { prefix: None, legacy: None, foreign: Some(Foreign { blocked, ..foreign }) }
        }
    }
}

/// `resolveDefaultInstallation`: the PATH command, or the managed installation beside a superseded
/// one; else the user prefix's binary; else `opencode2`. Source `path`, `managed`, `user` or none.
pub async fn resolve_default() -> (String, Option<&'static str>) {
    let user = user_prefix();
    let managed = user.as_ref().and_then(|u| npm_command(u).map(|_| u.binary()));
    let binary = user.as_ref().map(Prefix::binary);
    if let Some(command) = launch::path_command() {
        if let Some(user) = &user
            && incomplete_shim(&command, user)
        {
            return (user.binary().to_string_lossy().into_owned(), Some("user"));
        }
        let prefix = command_prefix(&command);
        if let Some(managed) = &managed
            && !launcher(&command, &prefix)
            && (legacy::legacy_npm_installation(&command, &prefix).is_some()
                || superseded_foreign(&command, false).await.is_some())
        {
            return (managed.to_string_lossy().into_owned(), Some("managed"));
        }
        return (command, Some("path"));
    }
    match binary.filter(|b| b.is_file() && !launch::retired(&b.to_string_lossy())) {
        Some(binary) => (binary.to_string_lossy().into_owned(), Some("user")),
        None => ("opencode2".into(), None),
    }
}

/// `legacyReplacement` and `foreignInstallation` of the status read (`inspectInstallation`).
pub fn notice(plan: &Plan) -> Value {
    let mut out = serde_json::Map::new();
    if plan.prefix.is_some()
        && let Some(l) = &plan.legacy
    {
        out.insert("legacyReplacement".into(), json!({"path": l.command, "version": l.version}));
    }
    if let Some(f) = &plan.foreign {
        let mut foreign = json!({"path": f.command, "source": f.source});
        if let Some(v) = &f.version {
            foreign["version"] = json!(v);
        }
        if let Some(id) = &f.package_id {
            foreign["packageId"] = json!(id);
        }
        if let Some((reason, path)) = &f.blocked {
            foreign["blocked"] = json!({"reason": reason, "path": path});
        }
        out.insert("foreignInstallation".into(), foreign);
    }
    Value::Object(out)
}

impl Plan {
    pub fn prefix(self) -> Result<Prefix, Error> {
        self.prefix.ok_or_else(|| Error::failed("The PATH executable is not a writable npm installation"))
    }
}
