use std::sync::{
    mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError},
    Condvar, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const SAVE_DEBOUNCE: Duration = Duration::from_millis(250);
type Flush = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct SchedulerState {
    sender: Option<SyncSender<Flush>>,
    worker: Option<JoinHandle<()>>,
    stopping: bool,
    stopped: bool,
}

#[derive(Default)]
pub(super) struct WindowFlushScheduler {
    state: Mutex<SchedulerState>,
    stopped: Condvar,
}

impl WindowFlushScheduler {
    // Each callback persists the latest mailbox state, never reads native APIs.
    // Consume it after flushing so no AppHandle is retained while the worker idles.
    pub(super) fn schedule(&self, flush: impl FnOnce() + Send + 'static) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state.stopping || state.stopped {
            return Ok(());
        }
        if state.sender.is_none() {
            // Keep at most one wakeup queued while the single worker is busy.
            let (sender, receiver) = sync_channel::<Flush>(1);
            let worker = thread::Builder::new()
                .name("client-state-window-flush".to_string())
                .spawn(move || run_debounced(receiver, SAVE_DEBOUNCE, |flush| flush()))
                .map_err(|error| format!("failed to start window-state flush worker: {error}"))?;
            state.sender = Some(sender);
            state.worker = Some(worker);
        }

        match state
            .sender
            .as_ref()
            .expect("initialized sender")
            .try_send(Box::new(flush))
        {
            Ok(()) | Err(TrySendError::Full(_)) => Ok(()),
            Err(TrySendError::Disconnected(_)) => {
                Err("window-state flush worker disconnected".to_string())
            }
        }
    }

    pub(super) fn stop(&self) {
        let (sender, worker) = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            while state.stopping {
                state = self
                    .stopped
                    .wait(state)
                    .unwrap_or_else(|error| error.into_inner());
            }
            if state.stopped {
                return;
            }
            state.stopping = true;
            (state.sender.take(), state.worker.take())
        };
        // Disconnect drains immediately. Never hold the scheduler mutex while
        // joining: late UI event submissions must not wait for the worker's I/O.
        drop(sender);
        if let Some(worker) = worker {
            if worker.join().is_err() {
                eprintln!("[client-state] window-state flush worker panicked");
            }
        }
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.stopping = false;
        state.stopped = true;
        self.stopped.notify_all();
    }
}

#[cfg(test)]
#[path = "window_flush_tests.rs"]
mod tests;

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
