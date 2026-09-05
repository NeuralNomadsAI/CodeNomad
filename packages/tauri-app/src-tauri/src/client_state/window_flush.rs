use super::ClientState;
use std::sync::{
    mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError},
    Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const SAVE_DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Default)]
struct SchedulerState {
    sender: Option<SyncSender<AppHandle>>,
    worker: Option<JoinHandle<()>>,
    stopped: bool,
}

#[derive(Default)]
pub(super) struct WindowFlushScheduler {
    state: Mutex<SchedulerState>,
}

impl WindowFlushScheduler {
    pub(super) fn schedule(&self, app: &AppHandle) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state.stopped {
            return Ok(());
        }
        if state.sender.is_none() {
            // Keep at most one wakeup queued while the single worker is busy.
            let (sender, receiver): (SyncSender<AppHandle>, Receiver<AppHandle>) = sync_channel(1);
            let worker = thread::Builder::new()
                .name("client-state-window-flush".to_string())
                .spawn(move || {
                    run_debounced(receiver, SAVE_DEBOUNCE, |worker_app| {
                        let Some(client_state) = worker_app.try_state::<ClientState>() else {
                            return;
                        };
                        if let Err(error) = client_state.flush() {
                            eprintln!("[client-state] failed to save window state: {error}");
                        }
                    });
                })
                .map_err(|error| format!("failed to start window-state flush worker: {error}"))?;
            state.sender = Some(sender);
            state.worker = Some(worker);
        }

        match state
            .sender
            .as_ref()
            .expect("initialized sender")
            .try_send(app.clone())
        {
            Ok(()) | Err(TrySendError::Full(_)) => Ok(()),
            Err(TrySendError::Disconnected(_)) => {
                Err("window-state flush worker disconnected".to_string())
            }
        }
    }

    pub(super) fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.stopped = true;
        // Disconnect wakes the worker and makes it drain a pending flush before ownership release.
        drop(state.sender.take());
        if let Some(worker) = state.worker.take() {
            if worker.join().is_err() {
                eprintln!("[client-state] window-state flush worker panicked");
            }
        }
    }
}

pub(super) fn run_debounced<T>(
    receiver: Receiver<T>,
    debounce: Duration,
    mut flush: impl FnMut(T),
) {
    while let Ok(mut request) = receiver.recv() {
        loop {
            match receiver.recv_timeout(debounce) {
                Ok(next) => request = next,
                Err(RecvTimeoutError::Timeout) => {
                    flush(request);
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    flush(request);
                    return;
                }
            }
        }
    }
}
