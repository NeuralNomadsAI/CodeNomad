//! macOS restart that keeps this process's environment. Tauri relaunches packaged
//! bundles through LaunchServices (`open -n`), whose new instance gets launchd's
//! environment instead, so a launch pinned by `CODENOMAD_PROFILE` or `CLI_CONFIG`
//! would reopen another data profile. Like Tauri's direct fallback, the new
//! instance runs the bundle's current executable in its own process group
//! without inherited stdio.
use std::ffi::{OsStr, OsString};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

/// The executable to relaunch. An installed update can rename a bundle's
/// executable, so inside `<bundle>/Contents/MacOS/` the bundle's
/// `CFBundleExecutable` decides; any other location relaunches `current`.
fn relaunch_binary(current: &Path) -> PathBuf {
    let named = |directory: &&Path, name: &str| directory.file_name() == Some(OsStr::new(name));
    let bundle_executable = || {
        let macos = current.parent().filter(|directory| named(directory, "MacOS"))?;
        let contents = macos.parent().filter(|directory| named(directory, "Contents"))?;
        let info = plist::from_file::<_, plist::Dictionary>(contents.join("Info.plist")).ok()?;
        let name = info.get("CFBundleExecutable")?.as_string()?;
        // A bare file name inside Contents/MacOS, never a path elsewhere.
        (Path::new(name).file_name() == Some(OsStr::new(name))).then(|| macos.join(name))
    };
    bundle_executable().unwrap_or_else(|| current.to_path_buf())
}

fn command(binary: &Path, args: impl IntoIterator<Item = OsString>) -> Command {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    command
}

/// Called from `RunEvent::Exit`, in place of Tauri's own restart at the same point.
pub(crate) fn relaunch_and_exit(app: &AppHandle) -> ! {
    let env = app.env();
    app.cleanup_before_exit();
    match tauri::process::current_binary(&env) {
        Ok(current) => {
            let binary = relaunch_binary(&current);
            if let Err(error) = command(&binary, env.args_os.iter().skip(1).cloned()).spawn() {
                eprintln!("[tauri] failed to restart {}: {error}", binary.display());
            }
        }
        Err(error) => eprintln!("[tauri] failed to resolve the application for restart: {error}"),
    }
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(info_plist: Option<&str>) -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let macos = root.path().join("CodeNomad.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        if let Some(info_plist) = info_plist {
            std::fs::write(macos.parent().unwrap().join("Info.plist"), info_plist).unwrap();
        }
        (root, macos)
    }

    fn info_plist(executable: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.neuralnomads.codenomad.client</string>
<key>CFBundleExecutable</key><string>{executable}</string>
</dict></plist>"#
        )
    }

    #[test]
    fn updated_bundle_relaunches_its_declared_executable() {
        let (_root, macos) = bundle(Some(&info_plist("codenomad-renamed")));
        assert_eq!(relaunch_binary(&macos.join("codenomad-tauri")), macos.join("codenomad-renamed"));
    }

    #[test]
    fn unusable_bundle_metadata_relaunches_the_current_executable() {
        let current = |macos: &Path| macos.join("codenomad-tauri");
        let (_missing, macos) = bundle(None);
        assert_eq!(relaunch_binary(&current(&macos)), current(&macos));
        let (_invalid, macos) = bundle(Some("not a property list"));
        assert_eq!(relaunch_binary(&current(&macos)), current(&macos));
        let (_escaping, macos) = bundle(Some(&info_plist("../../evil")));
        assert_eq!(relaunch_binary(&current(&macos)), current(&macos));
        let (_empty, macos) = bundle(Some(&info_plist("")));
        assert_eq!(relaunch_binary(&current(&macos)), current(&macos));
    }

    #[test]
    fn executables_outside_a_bundle_relaunch_themselves() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("Info.plist"), info_plist("other")).unwrap();
        let unpackaged = root.path().join("MacOS/codenomad-tauri");
        assert_eq!(relaunch_binary(&unpackaged), unpackaged);
    }

    #[test]
    fn relaunch_runs_the_binary_with_its_arguments_and_inherited_environment() {
        let command = command(Path::new("/Applications/CodeNomad.app/Contents/MacOS/codenomad-tauri"), [OsString::from("--flag")]);
        assert_eq!(command.get_program(), "/Applications/CodeNomad.app/Contents/MacOS/codenomad-tauri");
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["--flag"]);
        // No environment override: the child inherits CODENOMAD_PROFILE, CLI_CONFIG, ...
        assert_eq!(command.get_envs().count(), 0);
    }
}
