//! OpenCode 1.x npm (`opencode-ai`) verification, native image preflight and removal
//! (`opencode-update/legacy-installation.ts`, `shared-installation.ts`).
use std::{
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

use serde_json::Value;

use super::{Error, assert_writable, layout::Prefix};
use crate::opencode::admission;

/// OpenCode 1.x is published on npm as `opencode-ai`; 2.x as `@opencode/cli`.
/// Both declare an `opencode` bin, so 2.x cannot replace a 1.x shim without explicit consent.
pub const LEGACY_NPM_PACKAGE: &str = "opencode-ai";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Legacy {
    pub command: String,
    pub prefix: PathBuf,
    pub binary: PathBuf,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyConsent {
    pub path: String,
    pub version: String,
}

pub fn legacy_package_root(prefix: &Prefix) -> PathBuf {
    let modules =
        if cfg!(windows) { prefix.root.join("node_modules") } else { prefix.root.join("lib").join("node_modules") };
    modules.join(LEGACY_NPM_PACKAGE)
}

/// Files a running OpenCode 1.x may have mapped: `bin/` and nested platform packages'
/// `node_modules/opencode-<os>-<arch>[-variant]/bin/`. Bounded; a missing directory contributes nothing.
pub fn legacy_native_images(root: &Path, limit: usize) -> Vec<PathBuf> {
    let mut directories = vec![root.join("bin")];
    if let Ok(entries) = fs::read_dir(root.join("node_modules")) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let platform_pkg = name.strip_prefix("opencode-").is_some_and(|rest| {
                !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            });
            if entry.file_type().is_ok_and(|t| t.is_dir()) && platform_pkg {
                directories.push(entry.path().join("bin"));
            }
        }
    }
    let mut images = Vec::new();
    for directory in directories {
        if images.len() >= limit {
            break;
        }
        let Ok(entries) = fs::read_dir(directory) else { continue };
        for entry in entries.flatten() {
            if images.len() >= limit {
                break;
            }
            if entry.file_type().is_ok_and(|t| t.is_file()) {
                images.push(entry.path());
            }
        }
    }
    images
}

/// Lexical `path.resolve`: joins relative paths against `base` (or cwd) and collapses `.` / `..`.
pub(crate) fn resolve_from(base: Option<&Path>, path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else if let Some(base) = base {
        base.join(path)
    } else {
        std::env::current_dir().map(|cwd| cwd.join(path)).unwrap_or_else(|_| path.to_path_buf())
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(
                    normalized.components().next_back(),
                    None | Some(Component::Prefix(_) | Component::RootDir)
                ) {
                    normalized.pop();
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn normalized_key(path: &Path) -> String {
    let resolved = resolve_from(None, path).to_string_lossy().into_owned();
    if cfg!(windows) { resolved.replace('/', "\\").to_lowercase() } else { resolved }
}

pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    normalized_key(left) == normalized_key(right)
}

fn under_dir(child: &Path, root: &Path) -> bool {
    let child_key = normalized_key(child);
    let mut root_key = normalized_key(root);
    let sep = if cfg!(windows) { '\\' } else { '/' };
    if !root_key.ends_with(sep) {
        root_key.push(sep);
    }
    child_key.starts_with(&root_key)
}

fn is_legacy_version(version: &str) -> bool {
    static PATTERN: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^[01]\.[0-9]+\.[0-9]+$").unwrap());
    PATTERN.is_match(version) && admission::below_minimum(version)
}

/// Recognizes only the shim npm generated in `prefix.commands()` for `opencode-ai`'s own
/// `opencode` bin, verified through its manifest and shim target.
pub fn legacy_npm_installation(command: &str, prefix: &Prefix) -> Option<Legacy> {
    let command_path = Path::new(command);
    let parent = command_path.parent()?;
    if !same_path(parent, &prefix.commands()) {
        return None;
    }
    let file_name = command_path.file_name()?.to_string_lossy();
    let stem = if cfg!(windows) {
        let lower = file_name.to_ascii_lowercase();
        if lower.ends_with(".cmd") { &file_name[..file_name.len() - 4] } else { &file_name }
    } else {
        &file_name
    };
    if stem != "opencode" {
        return None;
    }
    let root = legacy_package_root(prefix);
    let manifest: Value = serde_json::from_slice(&fs::read(root.join("package.json")).ok()?).ok()?;
    let relative =
        manifest.get("bin").and_then(Value::as_object).and_then(|bin| bin.get("opencode")).and_then(Value::as_str)?;
    let version = manifest.get("version").and_then(Value::as_str)?;
    if manifest.get("name").and_then(Value::as_str) != Some(LEGACY_NPM_PACKAGE) || !is_legacy_version(version) {
        return None;
    }
    let binary = resolve_from(Some(&root), Path::new(relative));
    if !under_dir(&binary, &root) || !binary.is_file() {
        return None;
    }
    if cfg!(windows) {
        let bytes = fs::read(command_path).ok()?;
        if bytes.len() > 64 * 1024 {
            return None;
        }
        let script = String::from_utf8(bytes).ok()?;
        static TARGET: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r#"(?i)(?:%~dp0|%dp0%)[\\/]([^"'\r\n]+?)["']\s+%\*"#).unwrap()
        });
        let target = TARGET.captures(&script)?.get(1)?.as_str();
        let resolved_target = resolve_from(Some(parent), Path::new(target));
        if !same_path(&resolved_target, &binary) {
            return None;
        }
    } else if dunce::canonicalize(command_path).ok()? != dunce::canonicalize(&binary).ok()? {
        return None;
    }
    Some(Legacy { command: command.to_owned(), prefix: prefix.root.clone(), binary, version: version.to_owned() })
}

pub fn matches_consent(legacy: &Legacy, consent: Option<&LegacyConsent>) -> bool {
    consent.is_some_and(|c| same_path(Path::new(&c.path), Path::new(&legacy.command)) && c.version == legacy.version)
}

fn is_busy_or_permission(err: &std::io::Error) -> bool {
    err.kind() == ErrorKind::PermissionDenied || matches!(err.raw_os_error(), Some(5 | 16 | 32 | 33))
}

fn normalized_shim_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect()
}

pub(crate) fn is_npm_companion_shim(path: &Path, expected_binary: &Path) -> bool {
    let Some(parent) = path.parent() else { return false };
    let Ok(bytes) = fs::read(path) else { return false };
    if bytes.len() > 8192 {
        return false;
    }
    let Ok(script) = String::from_utf8(bytes) else { return false };
    let Ok(rel) = expected_binary.strip_prefix(parent) else { return false };
    let target = rel.to_string_lossy().replace('\\', "/");
    if target.is_empty() {
        return false;
    }
    let actual = normalized_shim_lines(&script);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.to_ascii_lowercase().ends_with(".ps1") {
        let header = "#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n$exe=\"\"\n\
             if ($PSVersionTable.PSVersion -lt \"6.0\" -or $IsWindows) {\n\
             # Fix case when both the Windows and Linux builds of Node\n\
             # are installed in the same directory\n\
             $exe=\".exe\"\n\
             }\n";
        let direct_with_ret = format!(
            "{header}$ret=0\n# Support pipeline input\n\
             if ($MyInvocation.ExpectingInput) {{\n  $input | & \"$basedir/{target}\" $args\n}} else {{\n  & \"$basedir/{target}\" $args\n}}\n\
             $ret=$LASTEXITCODE\nexit $ret\n"
        );
        // npm `cmd-shim` template when the package bin has `#!/usr/bin/env node` (OpenCode 1.0–1.15.0).
        let node_launcher = format!(
            "{header}$ret=0\nif (Test-Path \"$basedir/node$exe\") {{\n  # Support pipeline input\n\
             if ($MyInvocation.ExpectingInput) {{\n    $input | & \"$basedir/node$exe\" \"$basedir/{target}\" $args\n\
             }} else {{\n    & \"$basedir/node$exe\" \"$basedir/{target}\" $args\n  }}\n  $ret=$LASTEXITCODE\n\
             }} else {{\n  # Support pipeline input\n  if ($MyInvocation.ExpectingInput) {{\n\
             $input | & \"node$exe\" \"$basedir/{target}\" $args\n  }} else {{\n    & \"node$exe\" \"$basedir/{target}\" $args\n\
             }}\n  $ret=$LASTEXITCODE\n}}\nexit $ret\n"
        );
        return [super::layout::ps1(&target), direct_with_ret, node_launcher]
            .iter()
            .any(|candidate| actual == normalized_shim_lines(candidate));
    }
    if !name.contains('.') {
        let header_wsl2 = "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\nbasedir_win=\"$basedir\"\n\
             case `uname -a` in\n\
             *CYGWIN*|*MINGW*|*MSYS*)\n  if command -v cygpath > /dev/null 2>&1; then\n    basedir_win=`cygpath -w \"$basedir\"`\n  fi\n;;\n\
             *WSL2*)\n  if command -v wslpath > /dev/null 2>&1; then\n    basedir_win=\"$(wslpath -w \"$basedir\" 2> /dev/null)\"\n\
             if [ $? -ne 0 ] || [ -z \"$basedir_win\" ]; then\n      echo \"Error: wslpath failed to convert path. WSL environment may be misconfigured.\" >&2\n\
             exit 1\n    fi\n  fi\n;;\nesac\n";
        let header_v6 = "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n\
             case `uname` in\n\
             *CYGWIN*|*MINGW*|*MSYS*)\n  if command -v cygpath > /dev/null 2>&1; then\n    basedir=`cygpath -w \"$basedir\"`\n  fi\n;;\nesac\n";
        let header_v5 = "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n\
             case `uname` in\n  *CYGWIN*|*MINGW*|*MSYS*) basedir=`cygpath -w \"$basedir\"`;;\nesac\n";
        let header_v4 = "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n\
             case `uname` in\n  *CYGWIN*) basedir=`cygpath -w \"$basedir\"`;;\nesac\n";
        let bodies = [
            format!("exec \"$basedir/{target}\" \"$@\"\n"),
            format!(
                "if [ -x \"$basedir/node\" ]; then\n  exec \"$basedir/node\" \"$basedir/{target}\" \"$@\"\n\
                 else\n  exec node \"$basedir/{target}\" \"$@\"\nfi\n"
            ),
            format!(
                "if [ -x \"$basedir/node\" ]; then\n  exec \"$basedir/node\" \"$basedir_win/{target}\" \"$@\"\n\
                 else\n  exec node \"$basedir_win/{target}\" \"$@\"\nfi\n"
            ),
            format!(
                "if [ -x \"$basedir/node.exe\" ]; then\n  exec \"$basedir/node.exe\" \"$basedir/{target}\" \"$@\"\n\
                 else\n  exec node \"$basedir/{target}\" \"$@\"\nfi\n"
            ),
        ];
        for header in [header_wsl2, header_v6, header_v5, header_v4] {
            for body in &bodies {
                if actual == normalized_shim_lines(&format!("{header}{body}")) {
                    return true;
                }
            }
        }
    }
    false
}

/// Preflights every native image of the verified `opencode-ai` installation, then removes its
/// package folder and shims without Node/npm, classifying busy/in-use vs partial removal.
pub fn remove_legacy(prefix: &Prefix, legacy: &Legacy) -> Result<(), Error> {
    let root = legacy_package_root(prefix);
    let images = legacy_native_images(&root, 64);
    for image in &images {
        assert_writable(image)?;
    }

    let staging = prefix.staging().map_err(Error::failed)?;
    let parked = staging.join("legacy-opencode-ai");
    if let Err(err) = fs::rename(&root, &parked) {
        let _ = fs::remove_dir_all(&staging);
        let intact = legacy_npm_installation(&legacy.command, prefix).is_some() && images.iter().all(|p| p.exists());
        if !intact {
            return Err(Error::new(
                "legacy_partially_removed",
                "Removing OpenCode 1.x failed after changing the installation",
            ));
        }
        if is_busy_or_permission(&err) {
            return Err(Error::new(
                "installation_in_use",
                "OpenCode 1.x is in use or not writable; it is still installed",
            ));
        }
        return Err(Error::failed(format!("Removing OpenCode 1.x failed; it is still installed ({err})")));
    }

    let mut shims = vec![PathBuf::from(&legacy.command)];
    if cfg!(windows) {
        for companion in ["opencode.ps1", "opencode"] {
            let candidate = prefix.commands().join(companion);
            if candidate.is_file() && is_npm_companion_shim(&candidate, &legacy.binary) {
                shims.push(candidate);
            }
        }
    }
    let mut removed_any = false;
    for shim in &shims {
        if let Err(err) = fs::remove_file(shim)
            && err.kind() != ErrorKind::NotFound
        {
            let _ = fs::rename(&parked, &root);
            let _ = fs::remove_dir_all(&staging);
            let intact = !removed_any
                && legacy_npm_installation(&legacy.command, prefix).is_some()
                && images.iter().all(|p| p.exists());
            if !intact {
                return Err(Error::new(
                    "legacy_partially_removed",
                    "Removing OpenCode 1.x failed after changing the installation",
                ));
            }
            if is_busy_or_permission(&err) {
                return Err(Error::new(
                    "installation_in_use",
                    "OpenCode 1.x is in use or not writable; it is still installed",
                ));
            }
            return Err(Error::failed(format!("Removing OpenCode 1.x failed; it is still installed ({err})")));
        }
        removed_any = true;
    }

    if fs::remove_dir_all(&staging).is_err() || root.exists() {
        return Err(Error::new("legacy_partially_removed", "Could not completely remove the OpenCode 1.x package"));
    }
    Ok(())
}
