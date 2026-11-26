//! The global npm layout of `@opencode/cli` in the user npm prefix, as `npm install --global`
//! leaves it and as discovery reads it: the package (`[lib/]node_modules/@opencode/cli`, its
//! platform package nested below it and `bin/opencode.exe` linked to that binary), npm's command
//! shims, the reference's installation lock and installer folders, the previous package kept for
//! a rollback, and the user PATH registration of `user-path.ts`.
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde_json::Value;

const LOCK: &str = ".codenomad-opencode-install.lock";
const PREVIOUS: &str = ".codenomad-opencode-previous";
/// The binary every `@opencode/cli` declares (`bin` of its package.json), on every platform.
pub const BIN: &str = "bin/opencode.exe";
/// That binary as the manifest's `bin` declares it.
pub const DECLARED_BIN: &str = "./bin/opencode.exe";

pub struct Prefix {
    pub root: PathBuf,
}

impl Prefix {
    pub fn package(&self) -> PathBuf {
        let modules =
            if cfg!(windows) { self.root.join("node_modules") } else { self.root.join("lib").join("node_modules") };
        modules.join("@opencode").join("cli")
    }
    pub fn binary(&self) -> PathBuf {
        self.package().join("bin").join("opencode.exe")
    }
    /// Where npm publishes the terminal commands (the prefix on Windows, `bin/` elsewhere).
    pub fn commands(&self) -> PathBuf {
        if cfg!(windows) { self.root.clone() } else { self.root.join("bin") }
    }
    pub fn previous(&self) -> PathBuf {
        self.root.join(PREVIOUS)
    }
    /// A private installer folder beside the lock; the reference removes leftovers of its name.
    pub fn staging(&self) -> Result<PathBuf, String> {
        let dir = self.root.join(format!(".codenomad-npm-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir(&dir).map_err(|_| "Cannot create the OpenCode installer folder".to_owned())?;
        Ok(dir)
    }
}

/// The installed version of a package folder (its package.json, `@opencode/cli` only).
pub fn version(package: &Path) -> Option<String> {
    let manifest: Value = serde_json::from_slice(&fs::read(package.join("package.json")).ok()?).ok()?;
    (manifest["name"] == super::package::CLI).then(|| manifest["version"].as_str().map(str::to_owned)).flatten()
}

/// `withInstallationLock`: exclusive creation, never stolen; leftover installer folders of an
/// interrupted installer are removed once it is held.
pub struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
pub fn lock(prefix: &Prefix) -> Result<Lock, super::Error> {
    fs::create_dir_all(&prefix.root).map_err(|_| super::Error::failed("Cannot create the npm prefix"))?;
    let file = prefix.root.join(LOCK);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut handle = match options.open(&file) {
        Ok(handle) => handle,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(super::Error::busy(format!("OpenCode installation lock exists: {}", file.display())));
        }
        Err(_) => return Err(super::Error::failed("Cannot create the OpenCode installation lock")),
    };
    let started = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let _ = handle.write_all(serde_json::json!({"pid": std::process::id(), "started": started}).to_string().as_bytes());
    let held = Lock(file);
    for entry in fs::read_dir(&prefix.root).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().is_ok_and(|t| t.is_dir())
            && (name.starts_with(".codenomad-npm-") || name.starts_with(".codenomad-upgrade-"))
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(held)
}

/// Swaps a complete staged package in place of the current one, which becomes the previous
/// package (the older previous is parked in `staging` for removal). Renames only, all inside the
/// prefix: a running daemon keeps its image, and a failed step restores what it moved.
pub fn swap(prefix: &Prefix, staged: &Path, staging: &Path) -> Result<(), String> {
    let (current, previous, parked) = (prefix.package(), prefix.previous(), staging.join("replaced-previous"));
    let failed = |_| "Cannot replace the OpenCode installation".to_owned();
    fs::create_dir_all(current.parent().unwrap()).map_err(failed)?;
    let had_current = current.exists();
    let had_previous = had_current && previous.exists();
    if had_previous {
        fs::rename(&previous, &parked).map_err(failed)?;
    }
    if had_current && let Err(e) = fs::rename(&current, &previous) {
        if had_previous {
            let _ = fs::rename(&parked, &previous);
        }
        return Err(failed(e));
    }
    if let Err(e) = fs::rename(staged, &current) {
        if had_current {
            let _ = fs::rename(&previous, &current);
        }
        if had_previous {
            let _ = fs::rename(&parked, &previous);
        }
        return Err(failed(e));
    }
    Ok(())
}

/// The previous package back in place; the replaced one becomes the previous (reversible).
pub fn roll_back(prefix: &Prefix, staging: &Path) -> Result<(), String> {
    let (current, previous, parked) = (prefix.package(), prefix.previous(), staging.join("rolled-back"));
    let failed = |_| "Cannot restore the previous OpenCode installation".to_owned();
    fs::rename(&current, &parked).map_err(failed)?;
    if let Err(e) = fs::rename(&previous, &current) {
        let _ = fs::rename(&parked, &current);
        return Err(failed(e));
    }
    fs::rename(&parked, &previous).map_err(failed)
}

/// A hard link (as the package's postinstall makes), else a copy.
pub fn link_or_copy(source: &Path, target: &Path) -> Result<(), String> {
    fs::hard_link(source, target)
        .or_else(|_| fs::copy(source, target).map(|_| ()))
        .map_err(|_| "Cannot place the OpenCode binary".to_owned())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(target, fs::Permissions::from_mode(0o755))
            .map_err(|_| "Cannot place the OpenCode binary".to_owned())?;
    }
    Ok(())
}

fn replace(file: &Path, content: &[u8]) -> Result<(), String> {
    if fs::read(file).is_ok_and(|c| c == content) {
        return Ok(());
    }
    let temp = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let written = fs::write(&temp, content).and_then(|_| fs::rename(&temp, file));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written.map_err(|_| "Cannot publish the OpenCode terminal command".into())
}

/// npm's `cmd-shim` (Windows: `.cmd`, `.ps1` and `sh` beside each other) or a relative symlink
/// in `bin/`, for every command the manifest's `bin` names.
pub fn publish_commands(prefix: &Prefix, names: &[String]) -> Result<(), String> {
    let commands = prefix.commands();
    fs::create_dir_all(&commands).map_err(|_| "Cannot publish the OpenCode terminal command".to_owned())?;
    for name in names {
        if name.is_empty() || name.contains(['/', '\\', ':', '.']) {
            return Err("Invalid OpenCode command name".into());
        }
        if cfg!(windows) {
            let target = WINDOWS_TARGET;
            let forward = target.replace('\\', "/");
            let expected = prefix.binary();
            replace(&commands.join(format!("{name}.cmd")), cmd(target).as_bytes())?;
            let ps1_path = commands.join(format!("{name}.ps1"));
            if !ps1_path.exists() || super::legacy::is_npm_companion_shim(&ps1_path, &expected) {
                replace(&ps1_path, ps1(&forward).as_bytes())?;
            }
            let sh_path = commands.join(name);
            if !sh_path.exists() || super::legacy::is_npm_companion_shim(&sh_path, &expected) {
                replace(&sh_path, sh(&forward).as_bytes())?;
            }
        } else {
            #[cfg(unix)]
            {
                let link = commands.join(name);
                let target = Path::new("../lib/node_modules/@opencode/cli/bin/opencode.exe");
                if fs::read_link(&link).is_ok_and(|t| t == target) {
                    continue;
                }
                let temp = commands.join(format!(".{name}.{}", uuid::Uuid::new_v4().simple()));
                std::os::unix::fs::symlink(target, &temp)
                    .and_then(|_| fs::rename(&temp, &link))
                    .map_err(|_| "Cannot publish the OpenCode terminal command".to_owned())?;
            }
        }
    }
    Ok(())
}

const WINDOWS_TARGET: &str = "node_modules\\@opencode\\cli\\bin\\opencode.exe";

/// The exact shim npm writes (`isIncompleteWindowsNpmShim`), spacing before `%*` aside.
pub fn cmd_shim_matches(text: &[u8]) -> bool {
    let lines = |text: &str| -> Vec<String> {
        text.trim()
            .lines()
            .map(|l| {
                let l = l.trim();
                match l.strip_suffix("%*") {
                    Some(head) => format!("{} %*", head.trim_end()),
                    None => l.to_owned(),
                }
            })
            .collect()
    };
    text.len() <= 4096 && std::str::from_utf8(text).is_ok_and(|t| lines(t) == lines(&cmd(WINDOWS_TARGET)))
}

pub fn cmd(target: &str) -> String {
    format!(
        "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\{target}\"   %*\r\n"
    )
}
pub(super) fn ps1(target: &str) -> String {
    format!(
        "#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=\"\"\n\
         if ($PSVersionTable.PSVersion -lt \"6.0\" -or $IsWindows) {{\n  # Fix case when both the Windows and Linux builds of Node\n\
         \x20 # are installed in the same directory\n  $exe=\".exe\"\n}}\n# Support pipeline input\nif ($MyInvocation.ExpectingInput) {{\n\
         \x20 $input | & \"$basedir/{target}\"   $args\n}} else {{\n  & \"$basedir/{target}\"   $args\n}}\nexit $LASTEXITCODE\n"
    )
}
pub(super) fn sh(target: &str) -> String {
    format!(
        "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\nbasedir_win=\"$basedir\"\n\ncase `uname -a` in\n\
         \x20 *CYGWIN*|*MINGW*|*MSYS*)\n    if command -v cygpath > /dev/null 2>&1; then\n      basedir_win=`cygpath -w \"$basedir\"`\n    fi\n  ;;\n\
         \x20 *WSL2*)\n    if command -v wslpath > /dev/null 2>&1; then\n      basedir_win=\"$(wslpath -w \"$basedir\" 2> /dev/null)\"\n\
         \x20     if [ $? -ne 0 ] || [ -z \"$basedir_win\" ]; then\n        echo \"Error: wslpath failed to convert path. WSL environment may be misconfigured.\" >&2\n\
         \x20       exit 1\n      fi\n    fi\n  ;;\nesac\n\nexec \"$basedir/{target}\"   \"$@\"\n"
    )
}

/// `registerUserPath`: the user PATH (Windows registry, kept unexpanded, then a settings broadcast)
/// or the shell profiles.
pub fn register_path(bin: &Path) -> Result<(), String> {
    let bin_text = bin.to_string_lossy().into_owned();
    if cfg!(windows) {
        let script = format!(
            "$ErrorActionPreference = 'Stop'\n$bin = '{}'\n$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')\ntry {{\n\
             \x20 $raw = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)\n\
             \x20 $kind = if ($key.GetValueNames() -contains 'Path') {{ $key.GetValueKind('Path') }} else {{ [Microsoft.Win32.RegistryValueKind]::ExpandString }}\n\
             \x20 $found = @($raw -split ';' | Where-Object {{ [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\\\') -ieq $bin.TrimEnd('\\\\') }}).Count -gt 0\n\
             \x20 if (-not $found) {{ $key.SetValue('Path', (($raw.TrimEnd(';') + ';' + $bin).TrimStart(';')), $kind) }}\n}} finally {{ $key.Dispose() }}\n\
             Add-Type -Namespace CodeNomad -Name EnvironmentBroadcast -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h, uint m, System.UIntPtr w, string l, uint f, uint t, out System.UIntPtr r);'\n\
             $result = [UIntPtr]::Zero\n[void][CodeNomad.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$result)\n",
            bin_text.replace('\'', "''")
        );
        use base64::Engine;
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let mut command =
            std::process::Command::new(Path::new(&root).join("System32\\WindowsPowerShell\\v1.0\\powershell.exe"));
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &base64::engine::general_purpose::STANDARD.encode(utf16),
        ]);
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        let status = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if !status.is_ok_and(|s| s.success()) {
            return Err("Could not register the user terminal PATH".into());
        }
    } else {
        let home = PathBuf::from(
            std::env::var_os("HOME")
                .ok_or("Register the OpenCode installation directory in this shell's PATH manually")?,
        );
        let shell = std::env::var("SHELL")
            .unwrap_or_else(|_| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() });
        let quoted = format!("'{}'", bin_text.replace('\'', "'\\''"));
        let line = format!("case \":$PATH:\" in *:{quoted}:*) ;; *) export PATH=\"$PATH\":{quoted} ;; esac");
        match Path::new(&shell).file_name().and_then(|n| n.to_str()).unwrap_or("") {
            "fish" => {
                let config =
                    std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
                let fish = format!("'{}'", bin_text.replace('\\', "\\\\").replace('\'', "\\'"));
                profile_line(
                    &config.join("fish/conf.d/opencode-path.fish"),
                    &format!("if not contains -- {fish} $PATH; set -gx PATH $PATH {fish}; end"),
                )?;
            }
            "zsh" => {
                let dir = std::env::var_os("ZDOTDIR").map(PathBuf::from).unwrap_or_else(|| home.clone());
                for name in [".zprofile", ".zshrc"] {
                    profile_line(&dir.join(name), &line)?;
                }
            }
            shell @ ("bash" | "sh") => {
                profile_line(&home.join(".profile"), &line)?;
                if shell == "bash" {
                    profile_line(&home.join(".bashrc"), &line)?;
                    for name in [".bash_profile", ".bash_login"] {
                        if home.join(name).exists() {
                            profile_line(&home.join(name), &line)?;
                        }
                    }
                }
            }
            _ => return Err("Register the OpenCode installation directory in this shell's PATH manually".into()),
        }
    }
    Ok(())
}

fn profile_line(file: &Path, line: &str) -> Result<(), String> {
    let existing = fs::read_to_string(file).unwrap_or_default();
    if existing.lines().any(|l| l == line) {
        return Ok(());
    }
    let failed = |_| format!("Cannot update {}", file.display());
    fs::create_dir_all(file.parent().unwrap()).map_err(failed)?;
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
        .open(file)
        .and_then(|mut f| write!(f, "\n# OpenCode user installation PATH (CodeNomad)\n{line}\n"))
        .map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shims_are_npm_cmd_shim_text() {
        let cmd = cmd("node_modules\\@opencode\\cli\\bin\\opencode.exe");
        assert!(cmd.ends_with("\"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe\"   %*\r\n"));
        assert_eq!(cmd.lines().count(), 9);
        assert!(
            ps1("node_modules/@opencode/cli/bin/opencode.exe")
                .contains("  & \"$basedir/node_modules/@opencode/cli/bin/opencode.exe\"   $args\n")
        );
        assert!(sh("x").ends_with("exec \"$basedir/x\"   \"$@\"\n") && !sh("x").contains('\r'));
    }

    #[test]
    fn swap_keeps_the_previous_package_and_rolls_back() {
        let root = crate::shared::test_dir("install-layout");
        let prefix = Prefix { root: root.clone() };
        let package = |version: &str| {
            let dir = prefix.staging().unwrap();
            let cli = dir.join("cli");
            fs::create_dir_all(cli.join("bin")).unwrap();
            fs::write(cli.join("package.json"), format!(r#"{{"name":"@opencode/cli","version":"{version}"}}"#))
                .unwrap();
            (dir, cli)
        };
        for version in ["2.4.0", "2.5.0", "2.6.0"] {
            let (dir, cli) = package(version);
            swap(&prefix, &cli, &dir).unwrap();
            assert_eq!(super::version(&prefix.package()).as_deref(), Some(version));
        }
        assert_eq!(super::version(&prefix.previous()).as_deref(), Some("2.5.0"));
        let dir = prefix.staging().unwrap();
        roll_back(&prefix, &dir).unwrap();
        assert_eq!(
            (super::version(&prefix.package()).as_deref(), super::version(&prefix.previous()).as_deref()),
            (Some("2.5.0"), Some("2.6.0"))
        );
        let held = lock(&prefix).unwrap();
        assert!(
            !fs::read_dir(&root)
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with(".codenomad-npm-"))
        );
        assert!(lock(&prefix).err().unwrap().code == "installation_busy");
        drop(held);
        drop(lock(&prefix).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
}
