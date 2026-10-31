use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct LaunchIntent {
    pub(crate) new_window: bool,
    pub(crate) folders: Vec<String>,
    /// `--connect-server` value: a saved server name or id, or an http(s) URL; empty when the value is missing.
    pub(crate) connect_server: Option<String>,
}

impl LaunchIntent {
    /// A launch that only asks for a remote window: it opens no local window of its own when the connection succeeds.
    pub(crate) fn is_connect_only(&self) -> bool {
        self.connect_server.is_some() && !self.new_window && self.folders.is_empty()
    }
}

/// Reads `--connect-server <value>` or `--connect-server=<value>` at `index` with the count of extra arguments it consumed.
fn connect_server_argument(arguments: &[String], index: usize) -> Option<(String, usize)> {
    let value = &arguments[index];
    if let Some(inline) = value.strip_prefix("--connect-server=") {
        return Some((inline.to_string(), 0));
    }
    if value != "--connect-server" {
        return None;
    }
    Some(
        match arguments
            .get(index + 1)
            .filter(|target| !target.starts_with('-'))
        {
            Some(target) => (target.to_string(), 1),
            None => (String::new(), 0),
        },
    )
}

fn directory(value: &str, cwd: &Path) -> Option<String> {
    let path = if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        cwd.join(value)
    };
    path.is_dir().then(|| path.to_string_lossy().into_owned())
}

pub(crate) fn parse_launch_intent(arguments: &[String], cwd: &Path) -> LaunchIntent {
    let mut intent = LaunchIntent::default();
    let mut seen = HashSet::new();
    let mut index = 0;
    while index < arguments.len() {
        let value = &arguments[index];
        if let Some((target, consumed)) = connect_server_argument(arguments, index) {
            intent.connect_server = Some(target.trim().to_string());
            index += consumed;
        } else if value == "--new-window" {
            intent.new_window = true;
        } else if value == "--folder" {
            if let Some(folder) = arguments
                .get(index + 1)
                .filter(|folder| !folder.starts_with('-'))
            {
                index += 1;
                if let Some(folder) = directory(folder, cwd) {
                    if seen.insert(folder.clone()) {
                        intent.folders.push(folder);
                    }
                }
            }
        } else if let Some(value) = value.strip_prefix("--folder=") {
            if let Some(folder) = directory(value, cwd) {
                if seen.insert(folder.clone()) {
                    intent.folders.push(folder);
                }
            }
        } else if !value.starts_with('-') {
            if let Some(folder) = directory(value, cwd) {
                if seen.insert(folder.clone()) {
                    intent.folders.push(folder);
                }
            }
        }
        index += 1;
    }
    intent
}

pub(crate) fn parse_windows_forwarded_launch_intent(
    arguments: &[String],
    cwd: &Path,
) -> LaunchIntent {
    let mut intent = LaunchIntent::default();
    let mut seen = HashSet::new();
    let mut unknown_fragment = false;
    let mut index = 0;
    while index < arguments.len() {
        let value = &arguments[index];
        if let Some((target, consumed)) = connect_server_argument(arguments, index) {
            // `pipe_argument_error` refuses `|` before forwarding, so this value is exact.
            intent.connect_server = Some(target.trim().to_string());
            index += consumed;
        } else if value == "--new-window" {
            intent.new_window = true;
        } else if value == "--folder" {
            if let Some(folder) = arguments
                .get(index + 1)
                .filter(|folder| !folder.starts_with('-'))
            {
                index += 1;
                if let Some(folder) = directory(folder, cwd) {
                    if seen.insert(folder.clone()) {
                        intent.folders.push(folder);
                    }
                }
            }
        } else if let Some(value) = value.strip_prefix("--folder=") {
            if let Some(folder) = directory(value, cwd) {
                if seen.insert(folder.clone()) {
                    intent.folders.push(folder);
                }
            }
        } else if !value.starts_with('-') {
            unknown_fragment = true;
        }
        index += 1;
    }
    if unknown_fragment {
        intent.folders.clear();
    }
    intent
}

/// The Windows single-instance plugin forwards `args.join("|")` split on `|`, so an argument
/// containing `|` would reach the running instance as other arguments (another server, a flag).
/// Every Windows launch refuses such an argument before the plugin can forward it.
pub(crate) fn pipe_argument_error(arguments: &[String]) -> Option<String> {
    arguments
        .iter()
        .any(|argument| argument.contains('|'))
        .then(|| {
            "CodeNomad cannot start: launch arguments cannot contain \"|\" on Windows. \
         Use the saved server's URL, or rename the server without \"|\"."
                .to_string()
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchUiSettings {
    focus_existing_window_on_second_launch: Option<bool>,
}

#[derive(Deserialize)]
struct LaunchUiConfig {
    settings: Option<LaunchUiSettings>,
}

#[derive(Deserialize)]
struct LaunchConfig {
    ui: Option<LaunchUiConfig>,
}

pub(crate) fn prepare_second_launch_intent(
    mut intent: LaunchIntent,
    config_path: &Path,
) -> LaunchIntent {
    // A connection runs in an existing window; a new window would be left empty beside the remote one.
    if intent.is_connect_only() {
        return intent;
    }
    let focus_existing = std::fs::read_to_string(config_path)
        .ok()
        .and_then(|content| serde_yaml::from_str::<LaunchConfig>(&content).ok())
        .and_then(|config| config.ui)
        .and_then(|ui| ui.settings)
        .and_then(|settings| settings.focus_existing_window_on_second_launch)
        == Some(true);
    if !focus_existing {
        intent.new_window = true;
    }
    intent
}

#[derive(Default)]
pub(crate) struct LaunchQueue {
    pending: Mutex<VecDeque<LaunchIntent>>,
}

impl LaunchQueue {
    pub(crate) fn enqueue(&self, intent: LaunchIntent) {
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push_back(intent);
    }

    pub(crate) fn drain(&self) -> Vec<LaunchIntent> {
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain(..)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_arguments_use_callback_cwd_and_ignore_flags() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("workspace");
        std::fs::create_dir(&folder).unwrap();
        let args = [
            "--ignored",
            "--new-window",
            "--folder",
            "workspace",
            "missing",
            "workspace",
        ]
        .map(str::to_string);
        assert_eq!(
            parse_launch_intent(&args, root.path()),
            LaunchIntent {
                new_window: true,
                folders: vec![folder.to_string_lossy().into_owned()],
                connect_server: None,
            }
        );
    }

    #[test]
    fn connect_server_takes_a_separate_or_inline_value_beside_folders() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("workspace");
        std::fs::create_dir(&folder).unwrap();
        let parse = |args: &[&str]| {
            let arguments = args
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>();
            parse_launch_intent(&arguments, root.path())
        };
        assert_eq!(
            parse(&["--connect-server", "https://server.example.com"]).connect_server,
            Some("https://server.example.com".to_string())
        );
        assert_eq!(
            parse(&["--connect-server= Build box "]).connect_server,
            Some("Build box".to_string())
        );
        let combined = parse(&["workspace", "--connect-server", "Build box"]);
        assert_eq!(
            combined.folders,
            vec![folder.to_string_lossy().into_owned()]
        );
        assert_eq!(combined.connect_server, Some("Build box".to_string()));
        assert!(!combined.is_connect_only());
        // The value is never taken for a folder, even when a directory of that name exists.
        let only = parse(&["--connect-server", "workspace"]);
        assert!(only.folders.is_empty());
        assert!(only.is_connect_only());
    }

    #[test]
    fn connect_server_without_a_value_is_empty_and_keeps_the_next_flag() {
        let root = tempfile::tempdir().unwrap();
        let parsed = parse_launch_intent(
            &["--connect-server".to_string(), "--new-window".to_string()],
            root.path(),
        );
        assert_eq!(parsed.connect_server, Some(String::new()));
        assert!(parsed.new_window);
        assert_eq!(
            parse_launch_intent(&["--connect-server".to_string()], root.path()).connect_server,
            Some(String::new())
        );
    }

    #[test]
    fn windows_launches_refuse_pipes_so_forwarding_keeps_argument_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let args = |values: &[&str]| {
            values
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        };
        // The single-instance plugin sends `args.join("|")` and splits it again on `|`.
        let forward = |values: &[String]| {
            let arguments = values
                .join("|")
                .split('|')
                .map(str::to_string)
                .collect::<Vec<_>>();
            parse_windows_forwarded_launch_intent(&arguments, root.path())
        };
        // `Lab|--new-window` would arrive as server `Lab` plus a new-window flag: refused at the source.
        assert!(pipe_argument_error(&args(&["--connect-server", "Lab|--new-window"])).is_some());
        assert!(pipe_argument_error(&args(&["--connect-server=a|b"])).is_some());
        let plain = args(&["--connect-server", "Build box", "--new-window"]);
        assert!(pipe_argument_error(&plain).is_none());
        let forwarded = forward(&plain);
        assert_eq!(forwarded.connect_server, Some("Build box".to_string()));
        assert!(forwarded.new_window);
        // A positional argument after the value is never glued onto it; Windows forwarding still
        // ignores positional folders, as it always has.
        let positional = forward(&args(&["--connect-server", "prod", "packages"]));
        assert_eq!(positional.connect_server, Some("prod".to_string()));
        assert!(positional.folders.is_empty());
        assert_eq!(
            forward(&args(&["--connect-server", "--new-window"])).connect_server,
            Some(String::new())
        );
    }

    #[test]
    fn forwarded_connect_only_launches_run_in_an_existing_window() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config.yaml");
        let intent = LaunchIntent {
            connect_server: Some("prod".into()),
            ..LaunchIntent::default()
        };
        assert_eq!(
            prepare_second_launch_intent(intent.clone(), &config),
            intent
        );
        let with_folder = LaunchIntent {
            folders: vec!["workspace".into()],
            ..intent
        };
        assert!(prepare_second_launch_intent(with_folder, &config).new_window);
    }

    #[test]
    fn windows_forwarding_requires_explicit_valid_folders_and_rejects_fragments() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("workspace");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(
            parse_windows_forwarded_launch_intent(
                &["--folder".into(), "workspace".into()],
                root.path(),
            )
            .folders,
            vec![folder.to_string_lossy().into_owned()]
        );
        assert!(
            parse_windows_forwarded_launch_intent(&["workspace".into()], root.path())
                .folders
                .is_empty()
        );
        assert!(parse_windows_forwarded_launch_intent(
            &[
                "--folder".into(),
                "workspace".into(),
                "pipe-fragment".into()
            ],
            root.path(),
        )
        .folders
        .is_empty());
    }

    #[test]
    fn second_launches_open_a_new_window_unless_the_profile_requests_focus() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config.yaml");
        let intent = LaunchIntent {
            new_window: false,
            folders: vec!["workspace".into()],
            connect_server: None,
        };
        assert!(prepare_second_launch_intent(intent.clone(), &config).new_window);
        std::fs::write(
            &config,
            "ui:\n  settings:\n    focusExistingWindowOnSecondLaunch: true\n",
        )
        .unwrap();
        assert!(!prepare_second_launch_intent(intent.clone(), &config).new_window);
        std::fs::write(&config, "ui: [invalid").unwrap();
        assert!(prepare_second_launch_intent(intent, &config).new_window);
    }
}
