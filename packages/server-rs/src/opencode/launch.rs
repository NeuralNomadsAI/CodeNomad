//! The OpenCode executable and how it is launched (`spawn.ts`, `settings/binaries.ts`,
//! `host-opencode-service.ts`): default installation, PATH lookup, Windows launch forms and
//! the environment a started daemon inherits.
use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

use crate::settings::{Kind, Settings};

/// `BinaryResolver.resolveDefault`: a saved custom path wins over automatic discovery.
pub fn custom_binary(settings: &Settings) -> Option<String> {
    settings
        .owner(Kind::Config, "server")
        .get("opencodeBinary")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !matches!(*s, "" | "opencode" | "opencode2") && !retired(s))
        .map(resolve)
}

/// One CLI invocation: `verbatim` passes the arguments to `cmd.exe` unquoted (Windows only).
#[derive(Debug, PartialEq)]
pub struct Spec {
    pub command: String,
    pub args: Vec<String>,
    pub verbatim: bool,
}

/// Never inherited by the shared daemon: its storage roots, the desktop host's profile and
/// backend hand-offs, and this backend's own `CNRS_*` settings (its password among them).
const DAEMON_EXCLUDED: &[&str] = &[
    "OPENCODE_DB",
    "XDG_STATE_HOME",
    "CODENOMAD_PROFILE",
    "CODENOMAD_UPDATE_CHANNEL",
    "CODENOMAD_PROFILE_CONFIG_IDENTITY",
    "CLI_CONFIG",
    "CODENOMAD_NATIVE_PARENT",
    "CODENOMAD_NATIVE_BROWSER_AUTOMATION",
    "CODENOMAD_TAURI_WEBKIT",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_NO_ASAR",
];

/// `daemonProcessEnvironment` without configured overrides.
pub fn daemon_environment() -> Vec<(String, String)> {
    daemon_environment_with_overrides(None).expect("host environment without overrides is always valid")
}

/// `daemonProcessEnvironment(serviceStartupEnvironment())` (`host-opencode-service.ts:51-57`,
/// `manager.ts:1183-1214`): backend environment merged with profile `server.environmentVariables`,
/// omitting internal storage/profile/auth variables and preserving backend `NODE_EXTRA_CA_CERTS`.
pub fn daemon_environment_with_overrides(
    overrides: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<Vec<(String, String)>, String> {
    use std::collections::BTreeMap;

    let excluded = |key: &str| {
        let upper = key.to_ascii_uppercase();
        upper.starts_with("CNRS_") || DAEMON_EXCLUDED.contains(&upper.as_str())
    };
    let map_key = |key: &str| if cfg!(windows) { key.to_ascii_uppercase() } else { key.to_owned() };

    let mut merged: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (key, value) in env::vars() {
        if !excluded(&key) {
            merged.insert(map_key(&key), (key, value));
        }
    }
    if let Some(configured) = overrides {
        for (key, value) in configured {
            let Some(val) = value.as_str() else { continue };
            let upper = key.to_ascii_uppercase();
            if upper == "OPENCODE_DB" || upper == "XDG_STATE_HOME" {
                continue;
            }
            if key.is_empty() || key.contains(['=', '\0']) || val.contains('\0') {
                return Err(format!(
                    "Invalid OpenCode service environment variable name: {}",
                    if key.is_empty() { "(empty)" } else { key }
                ));
            }
            if excluded(key) {
                continue;
            }
            merged.insert(map_key(key), (key.clone(), val.to_owned()));
        }
    }
    if let Ok(ca) = env::var("NODE_EXTRA_CA_CERTS") {
        merged.retain(|_, (k, _)| !k.eq_ignore_ascii_case("NODE_EXTRA_CA_CERTS"));
        merged.insert(map_key("NODE_EXTRA_CA_CERTS"), ("NODE_EXTRA_CA_CERTS".into(), ca));
    }
    Ok(merged.into_values().collect())
}

/// Reads profile `server.environmentVariables` from `config.yaml` (display read, matching TS
/// `settings.getOwner("config", "server").environmentVariables`) and merges it for `service start`.
pub fn daemon_environment_from_config(config_path: Option<&Path>) -> Result<Vec<(String, String)>, String> {
    let overrides = config_path
        .and_then(|path| crate::settings::document::read(path).ok())
        .and_then(|doc| doc.get("server").and_then(serde_json::Value::as_object).cloned())
        .and_then(|server| server.get("environmentVariables").and_then(serde_json::Value::as_object).cloned());
    daemon_environment_with_overrides(overrides.as_ref())
}

/// `\\wsl$\<distro>\…` or `\\wsl.localhost\<distro>\…`: a WSL executable.
pub fn wsl(binary: &str) -> bool {
    let lower = binary.trim().replace('/', "\\").to_ascii_lowercase();
    ["\\\\wsl$\\", "\\\\wsl.localhost\\"].iter().any(|p| lower.strip_prefix(p).is_some_and(|rest| !rest.is_empty()))
}

/// The retired prerelease private runtime under `.local/share/codenomad/opencode`.
pub fn retired(binary: &str) -> bool {
    let lexical = |value: &str| {
        let value = value.replace('\\', "/").to_ascii_lowercase();
        value.split('/').collect::<Vec<_>>().windows(4).any(|w| w == [".local", "share", "codenomad", "opencode"])
    };
    lexical(binary)
        || !binary.replace('\\', "/").starts_with("//")
            && dunce::canonicalize(binary).is_ok_and(|p| lexical(&p.to_string_lossy()))
}

fn current(binary: &str) -> Result<(), String> {
    let mut binary = binary.to_owned();
    if !cfg!(windows)
        && !binary.contains('/')
        && let Some(found) = path_entries().map(|d| d.join(&binary)).find(|c| executable(c))
    {
        binary = found.to_string_lossy().into_owned();
    }
    if retired(&binary) { Err("opencode_private_installation_retired".into()) } else { Ok(()) }
}

fn path_entries() -> impl Iterator<Item = PathBuf> {
    let path = env::var_os("PATH").unwrap_or_default();
    env::split_paths(&path)
        .map(|p| PathBuf::from(p.to_string_lossy().trim().trim_matches('"')))
        .collect::<Vec<_>>()
        .into_iter()
}

fn extensions() -> Vec<String> {
    let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    pathext
        .split(';')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(|e| if e.starts_with('.') { e.to_ascii_lowercase() } else { format!(".{}", e.to_ascii_lowercase()) })
        .collect()
}

fn executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    path.is_file()
}

fn extension(path: &str) -> String {
    Path::new(path).extension().map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase())).unwrap_or_default()
}

/// The user npm prefix (`npm_config_prefix`, else `%APPDATA%\npm` or `~/.local`).
pub fn npm_prefix() -> Option<PathBuf> {
    let configured =
        env::vars().find(|(k, _)| k.eq_ignore_ascii_case("npm_config_prefix")).map(|(_, v)| PathBuf::from(v));
    if let Some(prefix) = configured.filter(|p| p.is_absolute()) {
        return Some(prefix);
    }
    if cfg!(windows) {
        let appdata = env::var_os("APPDATA").map(PathBuf::from);
        appdata
            .or_else(|| env::var_os("USERPROFILE").map(|h| Path::new(&h).join("AppData").join("Roaming")))
            .map(|a| a.join("npm"))
    } else {
        env::var_os("HOME").map(|h| Path::new(&h).join(".local"))
    }
}

/// `findPathOpenCode`: the first `opencode2` or `opencode` command in PATH (PATHEXT order on Windows).
pub fn path_command() -> Option<String> {
    let extensions = if cfg!(windows) { extensions() } else { vec![String::new()] };
    for directory in path_entries().filter(|d| d.is_absolute()) {
        for name in ["opencode2", "opencode"] {
            for extension in &extensions {
                let candidate = directory.join(format!("{name}{extension}"));
                if candidate.is_file()
                    && !retired(&candidate.to_string_lossy())
                    && (cfg!(windows) || executable(&candidate))
                {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

/// `resolveBinaryPath`: a bare name through `where`/`which`; Windows prefers `.exe`, `.cmd`, `.bat`, `.ps1`.
pub fn resolve(identifier: &str) -> String {
    let path_like =
        identifier.contains(['/', '\\']) || identifier.starts_with('.') || Path::new(identifier).is_absolute();
    if identifier.is_empty() || path_like {
        return identifier.into();
    }
    let mut locator = Command::new(if cfg!(windows) { "where" } else { "which" });
    locator.arg(identifier);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut locator, 0x0800_0000);
    let Ok(output) = locator.output() else { return identifier.into() };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let candidates: Vec<&str> = stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.to_ascii_uppercase().starts_with("INFO:"))
        .collect();
    if !output.status.success() || candidates.is_empty() {
        return identifier.into();
    }
    let preferred = cfg!(windows)
        .then(|| {
            [".exe", ".cmd", ".bat", ".ps1"]
                .iter()
                .find_map(|e| candidates.iter().find(|c| c.to_ascii_lowercase().ends_with(e)))
        })
        .flatten();
    preferred.unwrap_or(&candidates[0]).to_string()
}

/// `buildSpawnSpec` for this host (WSL executables are refused before reaching it).
pub fn spec(binary: &str, args: &[&str]) -> Result<Spec, String> {
    if binary.contains('\0') || cfg!(windows) && binary.contains(['"', '\r', '\n']) {
        return Err("The configured OpenCode binary path is invalid".into());
    }
    if cfg!(windows) && binary.replace('/', "\\").starts_with("\\\\") {
        return Err("OpenCode binary must be on a local drive".into());
    }
    current(binary)?;
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    if !cfg!(windows) {
        return Ok(Spec { command: binary.into(), args, verbatim: false });
    }
    let resolved = bare_windows_command(binary).unwrap_or_else(|| binary.into());
    let resolved = npm_executable(&resolved).unwrap_or(resolved);
    current(&resolved)?;
    Ok(match extension(&resolved).as_str() {
        ".cmd" | ".bat" => {
            if resolved.contains(['"', '\r', '\n', '%']) {
                return Err("The configured OpenCode command path is invalid".into());
            }
            let comspec = env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
            // cmd.exe takes the whole line as one string: `""<script>" <args>"` keeps spaces.
            let line = format!("\"\"{resolved}\" {}\"", args.join(" "));
            Spec { command: comspec, args: vec!["/d".into(), "/s".into(), "/c".into(), line], verbatim: true }
        }
        ".ps1" => {
            let mut all: Vec<String> = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"].map(String::from).into();
            all.push(resolved);
            all.extend(args);
            Spec { command: "powershell.exe".into(), args: all, verbatim: false }
        }
        _ => Spec { command: resolved, args, verbatim: false },
    })
}

/// A bare Windows name without extension, in the working directory then PATH, in PATHEXT order.
fn bare_windows_command(binary: &str) -> Option<String> {
    if binary.contains(['\\', '/', ':']) || !extension(binary).is_empty() {
        return None;
    }
    let cwd = env::current_dir().ok()?;
    let directories = std::iter::once(cwd.clone()).chain(path_entries().map(|e| cwd.join(e)));
    let extensions = extensions();
    for directory in directories {
        for extension in &extensions {
            let candidate = directory.join(format!("{binary}{extension}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// An npm `.cmd` shim that only forwards to an `.exe` beside it: launch that `.exe` directly.
pub fn npm_executable(command: &str) -> Option<String> {
    if !matches!(extension(command).as_str(), ".cmd" | ".bat") {
        return None;
    }
    let script = std::fs::read(command).ok().filter(|s| s.len() <= 64 * 1024)?;
    let script = String::from_utf8(script).ok()?;
    static SHIM: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"(?i)["'](?:%~dp0|%dp0%)[\\/]([^"'\r\n]+\.exe)["']\s+%\*"#).unwrap()
    });
    let relative = SHIM.captures(&script)?.get(1)?.as_str().replace('/', "\\");
    let executable = Path::new(command).parent()?.join(relative);
    let executable = executable.components().collect::<PathBuf>();
    executable.is_file().then(|| executable.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_and_retired_paths_are_recognised_lexically() {
        assert!(wsl(r"\\wsl$\Ubuntu\usr\bin\opencode"));
        assert!(wsl("//wsl.localhost/Ubuntu/home/u/opencode"));
        assert!(!wsl(r"\\server\share\opencode.exe") && !wsl(r"\\wsl$\"));
        assert!(retired("/home/u/.local/share/codenomad/opencode/bin/opencode"));
        assert!(retired(r"C:\Users\u\.local\share\CodeNomad\OpenCode\opencode.exe"));
        assert!(!retired("/home/u/.local/share/opencode/bin/opencode"));
        assert_eq!(
            spec("/x/.local/share/codenomad/opencode/opencode", &[]).unwrap_err(),
            "opencode_private_installation_retired"
        );
    }

    #[test]
    fn the_daemon_never_inherits_storage_roots_or_backend_hand_offs() {
        let kept = daemon_environment();
        for (key, _) in &kept {
            let key = key.to_ascii_uppercase();
            assert!(!DAEMON_EXCLUDED.contains(&key.as_str()) && !key.starts_with("CNRS_"), "{key}");
        }
        assert!(kept.iter().any(|(k, _)| k.eq_ignore_ascii_case("PATH")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_launch_forms_follow_the_reference() {
        let dir = std::env::temp_dir().join(format!("cnrs-launch-{}", uuid::Uuid::new_v4()));
        let bin = dir.join(r"node_modules\@opencode\cli\bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("opencode.exe"), b"").unwrap();
        let shim = dir.join("opencode2.cmd");
        std::fs::write(&shim, "@ECHO off\r\n\"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe\"   %*\r\n")
            .unwrap();
        let plain = dir.join("other.cmd");
        std::fs::write(&plain, "@echo %*\r\n").unwrap();
        let ps1 = dir.join("oc.ps1");
        std::fs::write(&ps1, "").unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        assert_eq!(
            spec(&s(&shim), &["service", "status"]).unwrap(),
            Spec {
                command: s(&bin.join("opencode.exe")),
                args: vec!["service".into(), "status".into()],
                verbatim: false
            }
        );
        let wrapped = spec(&s(&plain), &["service", "get", "password"]).unwrap();
        assert!(wrapped.verbatim && wrapped.command.to_ascii_lowercase().ends_with("cmd.exe"));
        assert_eq!(wrapped.args, ["/d", "/s", "/c", &format!("\"\"{}\" service get password\"", s(&plain))]);
        let script = spec(&s(&ps1), &["--version"]).unwrap();
        assert_eq!(script.command, "powershell.exe");
        assert_eq!(script.args[4..], [s(&ps1), "--version".into()]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
