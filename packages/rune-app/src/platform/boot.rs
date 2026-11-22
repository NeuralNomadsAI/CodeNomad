//! Explicit isolated local-server bootstrap; one worker owns process start through shutdown.
use crate::{backend::Backend, history::Result};
use codenomad_client::Receiver;
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock, mpsc},
    thread::JoinHandle,
};

#[derive(Default)]
struct Workers(Vec<(mpsc::SyncSender<()>, JoinHandle<()>)>);
impl Workers {
    fn finish(self) {
        for (stop, _) in &self.0 {
            let _ = stop.try_send(());
        }
        for (_, worker) in self.0 {
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
    shutdown: mpsc::SyncSender<()>,
}
impl Drop for LocalHost {
    fn drop(&mut self) {
        let _ = self.shutdown.try_send(());
    }
}
struct Request {
    executable: PathBuf,
    root: PathBuf,
    profile: String,
}
impl Request {
    fn parse(
        executable: Option<String>,
        root: Option<String>,
        profile: Option<String>,
    ) -> Option<Result<Self>> {
        if executable.is_none() && root.is_none() {
            return None;
        }
        Some((|| {
            let executable = PathBuf::from(executable.ok_or("missing local server executable")?);
            let root = PathBuf::from(root.ok_or("missing isolated host root")?);
            let profile = crate::host::profile_name(&profile.ok_or("missing trial profile")?)?;
            if !executable.is_absolute() || !root.is_absolute() || !profile.starts_with("trial-") {
                return Err("invalid isolated launch settings".into());
            }
            if !executable.is_file() || root.exists() {
                return Err("local server or isolated root unavailable".into());
            }
            Ok(Self {
                executable,
                root,
                profile,
            })
        })())
    }
}
pub fn start(wake: rune::Waker) -> Option<Receiver<Result<(Backend, LocalHost)>>> {
    let request = Request::parse(
        super::setting("RUNE_SERVER_BIN"),
        super::setting("RUNE_HOST_ROOT"),
        super::setting("CODENOMAD_PROFILE"),
    )?;
    let (out, input) = codenomad_client::bounded(1);
    let (shutdown, stop) = mpsc::sync_channel(1);
    let registry_shutdown = shutdown.clone();
    let worker = std::thread::spawn(move || {
        let result = request.and_then(|request| {
            let config = crate::host::LaunchConfig::trial(
                request.executable,
                &request.root,
                &request.profile,
            )?;
            let controller = crate::host::Controller::default();
            let mut child = controller.launch(config)?;
            let backend = child.connect()?;
            let guard = LocalHost { shutdown };
            if out.send_blocking(Ok((backend, guard))).is_ok() {
                wake();
                // Dropping the UI guard only signals; shutdown waits stay on this owner worker.
                let _ = stop.recv();
            }
            let _ = child.stop();
            Ok(())
        });
        if result.is_err() {
            // Do not expose paths, auth output or process diagnostics in the UI.
            let _ = out.send_blocking(Err("connect_error".into()));
            wake();
        }
    });
    workers()
        .lock()
        .unwrap()
        .0
        .push((registry_shutdown, worker));
    Some(input)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_mode_requires_complete_absolute_isolated_inputs() {
        assert!(Request::parse(None, None, None).is_none());
        assert!(
            Request::parse(Some("server".into()), None, None)
                .unwrap()
                .is_err()
        );
        for profile in ["default", "trial-../escape", "trial-/escape"] {
            assert!(
                Request::parse(
                    Some("relative".into()),
                    Some("relative".into()),
                    Some(profile.into())
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
                Some("trial-fixture".into())
            )
            .unwrap()
            .is_err(),
            "an existing directory must never become a trial root"
        );
    }
    #[test]
    fn releasing_ui_ownership_signals_the_worker() {
        let (shutdown, owner) = mpsc::sync_channel(1);
        drop(LocalHost { shutdown });
        assert_eq!(owner.try_recv(), Ok(()));
    }
    #[test]
    fn final_shutdown_waits_for_owned_worker_completion() {
        let (shutdown, stop) = mpsc::sync_channel(1);
        let (done, result) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            stop.recv().unwrap();
            done.send(()).unwrap();
        });
        Workers(vec![(shutdown, worker)]).finish();
        assert_eq!(result.try_recv(), Ok(()));
    }
}
