//! Explicit isolated local-server bootstrap; one worker owns process start through shutdown.
use crate::{backend::Backend, history::Result};
use codenomad_client::Receiver;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
};

enum HostCommand {
    Stop,
    Renew(codenomad_client::Sender<crate::host::ManagedRenewal>),
}

#[derive(Default)]
struct Workers(Vec<(Arc<AtomicBool>, mpsc::Sender<HostCommand>, JoinHandle<()>)>);
impl Workers {
    fn finish(self) {
        for (stopping, commands, _) in &self.0 {
            stopping.store(true, Ordering::SeqCst);
            let _ = commands.send(HostCommand::Stop);
        }
        for (_, _, worker) in self.0 {
            let _ = worker.join();
        }
    }
}
fn workers() -> &'static Mutex<Workers> {
    static WORKERS: OnceLock<Mutex<Workers>> = OnceLock::new();
    WORKERS.get_or_init(|| Mutex::new(Workers::default()))
}
pub fn finish() {
    let pending = std::mem::take(&mut *workers().lock().unwrap());
    pending.finish();
}

#[derive(Debug)]
pub struct LocalHost {
    stopping: Arc<AtomicBool>,
    commands: mpsc::Sender<HostCommand>,
    state_directory: Option<PathBuf>,
}
impl LocalHost {
    pub fn state_directory(&self) -> Option<PathBuf> {
        self.state_directory.clone()
    }
    pub fn renew_managed_session(&self) -> Option<Receiver<crate::host::ManagedRenewal>> {
        if self.stopping.load(Ordering::SeqCst) {
            return None;
        }
        let (reply, receiver) = codenomad_client::bounded(1);
        self.commands
            .send(HostCommand::Renew(reply))
            .ok()
            .map(|()| receiver)
    }
    #[cfg(test)]
    pub(crate) fn fixture(
        handler: impl FnMut() -> crate::host::ManagedRenewal + Send + 'static,
    ) -> Self {
        let (commands, rx) = mpsc::channel();
        let stopping = Arc::new(AtomicBool::new(false));
        let mut handler = handler;
        std::thread::spawn(move || {
            while let Ok(command) = rx.recv() {
                match command {
                    HostCommand::Stop => break,
                    HostCommand::Renew(reply) => {
                        let _ = reply.send_blocking(handler());
                    }
                }
            }
        });
        Self {
            stopping,
            commands,
            state_directory: None,
        }
    }
    #[cfg(test)]
    pub(crate) fn with_state_directory(mut self, directory: PathBuf) -> Self {
        self.state_directory = Some(directory);
        self
    }
}
impl Drop for LocalHost {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        let _ = self.commands.send(HostCommand::Stop);
    }
}
struct Request {
    executable: PathBuf,
    root: PathBuf,
    profile: String,
    persistent: bool,
}
impl Request {
    fn parse(
        executable: Option<String>,
        root: Option<String>,
        profile: Option<String>,
        persistent: Option<String>,
    ) -> Option<Result<Self>> {
        if executable.is_none() && root.is_none() && persistent.is_none() {
            return None;
        }
        Some((|| {
            let executable = PathBuf::from(executable.ok_or("missing local server executable")?);
            let root = PathBuf::from(root.ok_or("missing isolated host root")?);
            let profile = crate::host::profile_name(&profile.ok_or("missing trial profile")?)?;
            let persistent = match persistent.as_deref() {
                None | Some("false") => false,
                Some("true") => true,
                _ => return Err("invalid persistent host setting".into()),
            };
            if !executable.is_absolute() || !root.is_absolute() || !profile.starts_with("trial-") {
                return Err("invalid isolated launch settings".into());
            }
            if !executable.is_file() || (!persistent && root.exists()) {
                return Err("local server or isolated root unavailable".into());
            }
            Ok(Self {
                executable,
                root,
                profile,
                persistent,
            })
        })())
    }
}
enum BootPlan {
    Isolated(Request),
    Desktop { executable: PathBuf },
}

struct BootInputs<'a> {
    backend: Option<String>,
    server_bin: Option<String>,
    host_root: Option<String>,
    profile: Option<String>,
    persistent: Option<String>,
    no_autolaunch: Option<String>,
    headless: bool,
    args: &'a [String],
    current_exe: Option<PathBuf>,
}

fn autolaunch_disabled(no_autolaunch: Option<&str>, headless: bool, args: &[String]) -> bool {
    if headless {
        return true;
    }
    if no_autolaunch.is_some_and(|raw| {
        matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes"
        )
    }) {
        return true;
    }
    args.iter().any(|arg| {
        arg == "--snap"
            || arg.starts_with("--snap=")
            || arg == "--tree"
            || arg.starts_with("--tree=")
            || arg == "--scene"
            || arg.starts_with("--scene=")
            || arg == "--test-support-info"
            || arg.starts_with("--gallery-")
            || arg.starts_with("--probe-")
    })
}

fn resolve_boot_plan(inputs: BootInputs<'_>) -> Option<Result<BootPlan>> {
    if inputs.backend.is_some() {
        return None;
    }
    if let Some(request) = Request::parse(
        inputs.server_bin,
        inputs.host_root,
        inputs.profile,
        inputs.persistent,
    ) {
        return Some(request.map(BootPlan::Isolated));
    }
    if autolaunch_disabled(
        inputs.no_autolaunch.as_deref(),
        inputs.headless,
        inputs.args,
    ) {
        return None;
    }
    let current_exe = inputs.current_exe?;
    let executable = crate::host::discover_sibling_server(&current_exe)?;
    Some(Ok(BootPlan::Desktop { executable }))
}

pub fn start(wake: rune::Waker) -> Option<Receiver<Result<(Backend, LocalHost)>>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let plan = resolve_boot_plan(BootInputs {
        backend: super::setting("RUNE_BACKEND"),
        server_bin: super::setting("RUNE_SERVER_BIN"),
        host_root: super::setting("RUNE_HOST_ROOT"),
        profile: super::setting("CODENOMAD_PROFILE"),
        persistent: super::setting("RUNE_HOST_PERSISTENT"),
        no_autolaunch: super::setting("RUNE_NO_AUTOLAUNCH"),
        headless: rune_theme_codenomad::shell::is_headless(),
        args: &args,
        current_exe: std::env::current_exe().ok(),
    })?;
    let (out, input) = codenomad_client::bounded(1);
    let stopping = Arc::new(AtomicBool::new(false));
    let (commands, rx) = mpsc::channel();
    let registry_stopping = stopping.clone();
    let registry_commands = commands.clone();
    let worker = std::thread::spawn(move || {
        let result = plan.and_then(|plan| {
            let config = match plan {
                BootPlan::Isolated(request) => {
                    let configure = if request.persistent {
                        crate::host::LaunchConfig::persistent
                    } else {
                        crate::host::LaunchConfig::trial
                    };
                    configure(request.executable, &request.root, &request.profile)?
                }
                BootPlan::Desktop { executable } => crate::host::LaunchConfig::desktop(executable)?,
            };
            let state_directory = config.state_directory();
            let controller = crate::host::Controller::default();
            let mut child = controller.launch(config)?;
            let backend = child.connect()?;
            let guard = LocalHost {
                stopping: stopping.clone(),
                commands,
                state_directory,
            };
            if out.send_blocking(Ok((backend, guard))).is_ok() {
                wake();
                // Dropping the UI guard only signals; shutdown waits stay on this owner worker.
                while let Ok(command) = rx.recv() {
                    match command {
                        HostCommand::Stop => break,
                        HostCommand::Renew(reply) => {
                            let renewed = if stopping.load(Ordering::SeqCst) {
                                crate::host::ManagedRenewal::Denied
                            } else {
                                child
                                    .renew_managed_session(&stopping)
                                    .unwrap_or(crate::host::ManagedRenewal::Denied)
                            };
                            let _ = reply.send_blocking(renewed);
                        }
                    }
                }
            }
            let _ = child.stop();
            Ok(())
        });
        if result.is_err() {
            // Do not expose paths, auth output or process diagnostics in the UI.
            let _ = out.send_blocking(Err("rune.connect_error".into()));
            wake();
        }
    });
    workers()
        .lock()
        .unwrap()
        .0
        .push((registry_stopping, registry_commands, worker));
    Some(input)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_mode_requires_complete_absolute_isolated_inputs() {
        assert!(Request::parse(None, None, None, None).is_none());
        assert!(
            Request::parse(Some("server".into()), None, None, None)
                .unwrap()
                .is_err()
        );
        for profile in ["default", "trial-../escape", "trial-/escape"] {
            assert!(
                Request::parse(
                    Some("relative".into()),
                    Some("relative".into()),
                    Some(profile.into()),
                    None
                )
                .unwrap()
                .is_err()
            );
        }
        let executable = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let existing = env!("CARGO_MANIFEST_DIR").to_string();
        assert!(
            Request::parse(
                Some(executable),
                Some(existing),
                Some("trial-fixture".into()),
                None
            )
            .unwrap()
            .is_err(),
            "an existing directory must never become a trial root"
        );
    }
    #[test]
    fn releasing_ui_ownership_signals_the_worker() {
        let (commands, owner) = mpsc::channel();
        let stopping = Arc::new(AtomicBool::new(false));
        drop(LocalHost {
            stopping: stopping.clone(),
            commands,
            state_directory: None,
        });
        assert!(stopping.load(Ordering::SeqCst));
        assert!(matches!(owner.try_recv(), Ok(HostCommand::Stop)));
    }
    #[test]
    fn persistent_setting_requires_explicit_true_and_complete_inputs() {
        let executable = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let root = env!("CARGO_MANIFEST_DIR").to_string();
        for value in ["1", "yes", ""] {
            assert!(
                Request::parse(
                    Some(executable.clone()),
                    Some(root.clone()),
                    Some("trial-fixture".into()),
                    Some(value.into())
                )
                .unwrap()
                .is_err()
            );
        }
        let request = Request::parse(
            Some(executable),
            Some(root),
            Some("trial-fixture".into()),
            Some("true".into()),
        )
        .unwrap()
        .unwrap();
        assert!(request.persistent);
        assert!(
            Request::parse(None, None, None, Some("true".into()))
                .unwrap()
                .is_err()
        );
    }
    #[test]
    fn final_shutdown_waits_for_owned_worker_completion() {
        let stopping = Arc::new(AtomicBool::new(false));
        let (commands, stop) = mpsc::channel();
        let (done, result) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            assert!(matches!(stop.recv(), Ok(HostCommand::Stop)));
            done.send(()).unwrap();
        });
        Workers(vec![(stopping, commands, worker)]).finish();
        assert_eq!(result.try_recv(), Ok(()));
    }

    #[test]
    fn autonomous_launch_discovers_sibling_and_respects_all_opt_out_guards() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/host-tests")
            .join(format!(
                "boot-sibling-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&dir).unwrap();
        let fake_exe = dir.join(if cfg!(windows) {
            "codenomad-rune.exe"
        } else {
            "codenomad-rune"
        });
        std::fs::write(&fake_exe, b"rune").unwrap();

        fn make_inputs<'a>(fake_exe: &std::path::Path, args: &'a [String]) -> BootInputs<'a> {
            BootInputs {
                backend: None,
                server_bin: None,
                host_root: None,
                profile: None,
                persistent: None,
                no_autolaunch: None,
                headless: false,
                args,
                current_exe: Some(fake_exe.to_path_buf()),
            }
        }

        // 1. Absent sibling server -> None (manual Connect screen).
        assert!(resolve_boot_plan(make_inputs(&fake_exe, &[])).is_none());

        // 2. Directory named like the server binary -> ignored.
        let sibling = dir.join(if cfg!(windows) {
            "codenomad-rs.exe"
        } else {
            "codenomad-rs"
        });
        std::fs::create_dir(&sibling).unwrap();
        assert!(resolve_boot_plan(make_inputs(&fake_exe, &[])).is_none());
        std::fs::remove_dir(&sibling).unwrap();

        // 3. Symlink pointing outside exe dir -> ignored on Unix.
        #[cfg(unix)]
        {
            let outside = dir.join("outside.bin");
            std::fs::write(&outside, b"outside").unwrap();
            std::os::unix::fs::symlink(&outside, &sibling).unwrap();
            assert!(resolve_boot_plan(make_inputs(&fake_exe, &[])).is_none());
            std::fs::remove_file(&sibling).unwrap();
            std::fs::remove_file(&outside).unwrap();
        }

        // 4. Plain regular sibling file -> BootPlan::Desktop with exact path.
        std::fs::write(&sibling, b"server").unwrap();
        match resolve_boot_plan(make_inputs(&fake_exe, &[])) {
            Some(Ok(BootPlan::Desktop { executable })) => assert_eq!(executable, sibling),
            other => panic!("expected BootPlan::Desktop, got {}", other.is_some()),
        }

        // 5. Explicit RUNE_BACKEND suppresses autonomous launch.
        let mut with_backend = make_inputs(&fake_exe, &[]);
        with_backend.backend = Some("http://127.0.0.1:9899/".into());
        assert!(resolve_boot_plan(with_backend).is_none());

        // 6. Explicit RUNE_NO_AUTOLAUNCH opt-out suppresses autonomous launch.
        for val in ["1", "true", "YES"] {
            let mut opt_out = make_inputs(&fake_exe, &[]);
            opt_out.no_autolaunch = Some(val.into());
            assert!(resolve_boot_plan(opt_out).is_none(), "{val}");
        }

        // 7. Headless and qualification/offscreen CLI flags suppress autonomous launch.
        let mut headless = make_inputs(&fake_exe, &[]);
        headless.headless = true;
        assert!(resolve_boot_plan(headless).is_none());
        for flag in [
            "--snap",
            "--snap=out.png",
            "--tree",
            "--tree=out.json",
            "--scene",
            "--scene=synthetic",
            "--test-support-info",
            "--gallery-shell",
            "--probe-window-restore",
        ] {
            let args = vec![flag.to_owned()];
            assert!(
                resolve_boot_plan(make_inputs(&fake_exe, &args)).is_none(),
                "{flag}"
            );
        }

        // 8. Explicit trial inputs still route to BootPlan::Isolated, never Desktop.
        let trial_root = dir.join("fresh-trial-root");
        let isolated = resolve_boot_plan(BootInputs {
            backend: None,
            server_bin: Some(sibling.to_string_lossy().into_owned()),
            host_root: Some(trial_root.to_string_lossy().into_owned()),
            profile: Some("trial-keep-contract".into()),
            persistent: None,
            no_autolaunch: None,
            headless: false,
            args: &[],
            current_exe: Some(fake_exe),
        });
        assert!(matches!(isolated, Some(Ok(BootPlan::Isolated(_)))));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
