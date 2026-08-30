use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct LaunchIntent {
    pub(crate) new_window: bool,
    pub(crate) folders: Vec<String>,
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
        if value == "--new-window" {
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
        if value == "--new-window" {
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
                folders: vec![folder.to_string_lossy().into_owned()]
            }
        );
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
}
