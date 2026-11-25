use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};

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

fn directory_with(
    value: &str,
    cwd: &Path,
    is_dir: &mut impl FnMut(&Path) -> bool,
) -> Option<String> {
    let path = if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        cwd.join(value)
    };
    is_dir(&path).then(|| path.to_string_lossy().into_owned())
}

pub(crate) fn parse_launch_intent(arguments: &[String], cwd: &Path) -> LaunchIntent {
    parse_launch_intent_with(arguments, cwd, &mut |path| path.is_dir())
}

fn parse_launch_intent_with(
    arguments: &[String],
    cwd: &Path,
    is_dir: &mut impl FnMut(&Path) -> bool,
) -> LaunchIntent {
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
                if let Some(folder) = directory_with(folder, cwd, is_dir) {
                    if seen.insert(folder.clone()) {
                        intent.folders.push(folder);
                    }
                }
            }
        } else if let Some(value) = value.strip_prefix("--folder=") {
            if let Some(folder) = directory_with(value, cwd, is_dir) {
                if seen.insert(folder.clone()) {
                    intent.folders.push(folder);
                }
            }
        } else if !value.starts_with('-') {
            if let Some(folder) = directory_with(value, cwd, is_dir) {
                if seen.insert(folder.clone()) {
                    intent.folders.push(folder);
                }
            }
        }
        index += 1;
    }
    intent
}

#[cfg(any(windows, test))]
pub(crate) fn parse_windows_forwarded_launch_intent(
    arguments: &[String],
    cwd: &Path,
) -> LaunchIntent {
    parse_windows_forwarded_launch_intent_with(arguments, cwd, &mut |path| path.is_dir())
}

fn parse_windows_forwarded_launch_intent_with(
    arguments: &[String],
    cwd: &Path,
    is_dir: &mut impl FnMut(&Path) -> bool,
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
                if let Some(folder) = directory_with(folder, cwd, is_dir) {
                    if seen.insert(folder.clone()) {
                        intent.folders.push(folder);
                    }
                }
            }
        } else if let Some(value) = value.strip_prefix("--folder=") {
            if let Some(folder) = directory_with(value, cwd, is_dir) {
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
    intent: LaunchIntent,
    config_path: &Path,
) -> LaunchIntent {
    prepare_second_launch_intent_with(intent, config_path, &mut |path| {
        std::fs::read_to_string(path)
    })
}

fn prepare_second_launch_intent_with(
    mut intent: LaunchIntent,
    config_path: &Path,
    read_config: &mut impl FnMut(&Path) -> std::io::Result<String>,
) -> LaunchIntent {
    // A connection runs in an existing window; a new window would be left empty beside the remote one.
    if intent.is_connect_only() {
        return intent;
    }
    let focus_existing = read_config(config_path)
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
struct LaunchQueueState {
    pending: VecDeque<LaunchIntent>,
    ready: bool,
}

#[derive(Default)]
pub(crate) struct LaunchQueue {
    state: Mutex<LaunchQueueState>,
}

impl LaunchQueue {
    /// Enqueues a launch intent and returns whether startup has already enabled draining.
    pub(crate) fn enqueue(&self, intent: LaunchIntent) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.pending.push_back(intent);
        state.ready
    }

    /// Enables draining once startup restoration has completed.
    pub(crate) fn mark_ready(&self) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .ready = true;
    }

    pub(crate) fn drain(&self) -> Vec<LaunchIntent> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state.ready {
            return Vec::new();
        }
        state.pending.drain(..).collect()
    }
}

type RawForwardedLaunch<T> = (T, Vec<String>, String);

pub(crate) struct ForwardedLaunchWorker<T> {
    // Only admission is locked; filesystem work runs on the dedicated FIFO worker thread.
    admission: Mutex<mpsc::Sender<RawForwardedLaunch<T>>>,
}

impl<T: Send + 'static> ForwardedLaunchWorker<T> {
    pub(crate) fn new(
        config_path: PathBuf,
        windows_forwarding: bool,
        dispatch: impl FnMut(T, LaunchIntent) + Send + 'static,
    ) -> Self {
        Self::with_io(
            config_path,
            windows_forwarding,
            |path| path.is_dir(),
            |path| std::fs::read_to_string(path),
            dispatch,
        )
    }

    fn with_io(
        config_path: PathBuf,
        windows_forwarding: bool,
        mut is_dir: impl FnMut(&Path) -> bool + Send + 'static,
        mut read_config: impl FnMut(&Path) -> std::io::Result<String> + Send + 'static,
        mut dispatch: impl FnMut(T, LaunchIntent) + Send + 'static,
    ) -> Self {
        let (send, receive) = mpsc::channel::<RawForwardedLaunch<T>>();
        std::thread::Builder::new()
            .name("forwarded-launch".into())
            .spawn(move || {
                for (context, args, callback_cwd) in receive {
                    let arguments = args.into_iter().skip(1).collect::<Vec<_>>();
                    if arguments == [crate::developer_relaunch::MARKER] {
                        continue;
                    }
                    let cwd = PathBuf::from(callback_cwd);
                    let intent = if windows_forwarding {
                        parse_windows_forwarded_launch_intent_with(&arguments, &cwd, &mut is_dir)
                    } else {
                        parse_launch_intent_with(&arguments, &cwd, &mut is_dir)
                    };
                    let intent =
                        prepare_second_launch_intent_with(intent, &config_path, &mut read_config);
                    dispatch(context, intent);
                }
            })
            .expect("start forwarded launch worker");
        Self {
            admission: Mutex::new(send),
        }
    }

    pub(crate) fn enqueue(&self, context: T, args: Vec<String>, cwd: String) {
        let _ = self
            .admission
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .send((context, args, cwd));
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

    #[test]
    fn forwarded_launch_callback_enqueues_without_disk_io_and_preserves_order() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc,
        };
        use std::time::Duration;

        let caller_thread = std::thread::current().id();
        let timeout = Duration::from_secs(5);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (dispatch_tx, dispatch_rx) = mpsc::channel();
        let worker_threads = Arc::new(Mutex::new(Vec::new()));
        let dir_threads = Arc::clone(&worker_threads);
        let config_threads = Arc::clone(&worker_threads);
        let config_reads = Arc::new(AtomicUsize::new(0));
        let config_reads_in_worker = Arc::clone(&config_reads);
        let root = tempfile::tempdir().unwrap();
        let slow_path = root.path().join("slow");
        let fast_path = root.path().join("fast");
        let expected_slow = slow_path.to_string_lossy().into_owned();
        let expected_fast = fast_path.to_string_lossy().into_owned();
        let expected_config = root.path().join("config.yaml");

        let worker = ForwardedLaunchWorker::with_io(
            expected_config.clone(),
            true,
            move |path| {
                let current = std::thread::current().id();
                assert_ne!(
                    current, caller_thread,
                    "directory validation must not run on the native callback thread"
                );
                dir_threads.lock().unwrap().push(current);
                if path == slow_path {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(timeout).unwrap();
                    true
                } else {
                    path == fast_path
                }
            },
            move |path| {
                let current = std::thread::current().id();
                assert_ne!(
                    current, caller_thread,
                    "config read must not run on the native callback thread"
                );
                assert_eq!(path, expected_config);
                config_threads.lock().unwrap().push(current);
                let read_index = config_reads_in_worker.fetch_add(1, Ordering::SeqCst);
                if read_index == 0 {
                    Err(std::io::Error::from(std::io::ErrorKind::NotFound))
                } else {
                    Ok("ui:\n  settings:\n    focusExistingWindowOnSecondLaunch: true\n".into())
                }
            },
            move |tag: &'static str, intent| {
                dispatch_tx.send((tag, intent)).unwrap();
            },
        );

        let cwd = root.path().to_string_lossy().into_owned();
        worker.enqueue(
            "first",
            vec![
                "codenomad.exe".into(),
                "--folder".into(),
                "slow".into(),
                "--connect-server".into(),
                "prod".into(),
            ],
            cwd.clone(),
        );
        entered_rx.recv_timeout(timeout).unwrap();
        // A second forwarded launch must enqueue without waiting on the blocked disk check.
        worker.enqueue(
            "second",
            vec!["codenomad.exe".into(), "--folder".into(), "fast".into()],
            cwd,
        );
        assert!(dispatch_rx.try_recv().is_err());

        release_tx.send(()).unwrap();
        let first = dispatch_rx.recv_timeout(timeout).unwrap();
        let second = dispatch_rx.recv_timeout(timeout).unwrap();
        assert_eq!(
            first,
            (
                "first",
                LaunchIntent {
                    new_window: true,
                    folders: vec![expected_slow],
                    connect_server: Some("prod".into()),
                }
            )
        );
        assert_eq!(
            second,
            (
                "second",
                LaunchIntent {
                    new_window: false,
                    folders: vec![expected_fast],
                    connect_server: None,
                }
            )
        );
        let threads = worker_threads.lock().unwrap();
        assert_eq!(threads.len(), 4);
        assert!(threads.iter().all(|id| *id == threads[0]));
        assert_eq!(config_reads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn forwarded_launch_worker_skips_automation_relaunch_and_connect_only_config_read() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc,
        };
        use std::time::Duration;

        let timeout = Duration::from_secs(5);
        let dir_checks = Arc::new(AtomicUsize::new(0));
        let config_reads = Arc::new(AtomicUsize::new(0));
        let dir_checks_worker = Arc::clone(&dir_checks);
        let config_reads_worker = Arc::clone(&config_reads);
        let (dispatch_tx, dispatch_rx) = mpsc::channel();
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("workspace");
        let expected_folder = folder.to_string_lossy().into_owned();

        let worker = ForwardedLaunchWorker::with_io(
            root.path().join("config.yaml"),
            false,
            move |path| {
                dir_checks_worker.fetch_add(1, Ordering::SeqCst);
                path == folder
            },
            move |_| {
                config_reads_worker.fetch_add(1, Ordering::SeqCst);
                Ok(String::new())
            },
            move |tag: &'static str, intent| {
                dispatch_tx.send((tag, intent)).unwrap();
            },
        );

        let cwd = root.path().to_string_lossy().into_owned();
        worker.enqueue(
            "relaunch",
            vec!["codenomad".into(), crate::developer_relaunch::MARKER.into()],
            cwd.clone(),
        );
        worker.enqueue(
            "connect-only",
            vec![
                "codenomad".into(),
                "--connect-server".into(),
                "https://server.example.com".into(),
            ],
            cwd.clone(),
        );
        worker.enqueue(
            "positional-folder",
            vec!["codenomad".into(), "workspace".into()],
            cwd,
        );

        assert_eq!(
            dispatch_rx.recv_timeout(timeout).unwrap(),
            (
                "connect-only",
                LaunchIntent {
                    new_window: false,
                    folders: Vec::new(),
                    connect_server: Some("https://server.example.com".into()),
                }
            )
        );
        assert_eq!(
            dispatch_rx.recv_timeout(timeout).unwrap(),
            (
                "positional-folder",
                LaunchIntent {
                    new_window: true,
                    folders: vec![expected_folder],
                    connect_server: None,
                }
            )
        );
        assert_eq!(dir_checks.load(Ordering::SeqCst), 1);
        assert_eq!(config_reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn launch_queue_holds_intents_until_ready_and_preserves_order() {
        let queue = LaunchQueue::default();
        let first = LaunchIntent {
            new_window: false,
            folders: vec!["first".into()],
            connect_server: None,
        };
        let second = LaunchIntent {
            new_window: true,
            folders: vec!["second".into()],
            connect_server: None,
        };
        let third = LaunchIntent {
            new_window: true,
            folders: vec!["third".into()],
            connect_server: None,
        };
        assert!(!queue.enqueue(first.clone()));
        assert!(!queue.enqueue(second.clone()));
        assert!(queue.drain().is_empty());
        queue.mark_ready();
        assert_eq!(queue.drain(), vec![first, second]);
        assert!(queue.enqueue(third.clone()));
        assert_eq!(queue.drain(), vec![third]);
    }
}
