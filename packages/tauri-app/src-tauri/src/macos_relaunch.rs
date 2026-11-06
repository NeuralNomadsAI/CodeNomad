//! macOS restart that keeps this process's environment. Tauri relaunches packaged
//! bundles through LaunchServices (`open -n`), whose new instance gets launchd's
//! environment instead, so a launch pinned by `CODENOMAD_PROFILE` or `CLI_CONFIG`
//! would reopen another data profile. Like Tauri's direct fallback, the new
//! instance gets its own process group and no inherited stdio.
use std::ffi::OsString;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

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
        Ok(binary) => {
            if let Err(error) = command(&binary, env.args_os.iter().skip(1).cloned()).spawn() {
                eprintln!("[tauri] failed to restart: {error}");
            }
        }
        Err(error) => eprintln!("[tauri] failed to resolve the application for restart: {error}"),
    }
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relaunch_runs_the_same_binary_with_its_arguments_and_inherited_environment() {
        let command = command(Path::new("/Applications/CodeNomad.app/Contents/MacOS/codenomad-tauri"), [OsString::from("--flag")]);
        assert_eq!(command.get_program(), "/Applications/CodeNomad.app/Contents/MacOS/codenomad-tauri");
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["--flag"]);
        // No environment override: the child inherits CODENOMAD_PROFILE, CLI_CONFIG, ...
        assert_eq!(command.get_envs().count(), 0);
    }
}
