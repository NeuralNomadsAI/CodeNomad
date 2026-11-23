use std::sync::{mpsc, Mutex};
use std::time::Instant;

type Job = Box<dyn FnOnce() + Send>;

pub(crate) struct IpcQueue {
    // Only admission is locked; jobs never execute under this mutex.
    admission: Mutex<(mpsc::Sender<Job>, bool)>,
}

impl IpcQueue {
    pub(crate) fn new() -> Self {
        Self::named("client-state-ipc")
    }

    pub(crate) fn named(name: &str) -> Self {
        let (send, receive) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || receive.into_iter().for_each(|job| job()))
            .expect("start client state IPC worker");
        Self { admission: Mutex::new((send, true)) }
    }

    pub(crate) fn enqueue(&self, job: Job) -> Result<(), &'static str> {
        let admission = self.admission.lock().unwrap_or_else(|err| err.into_inner());
        if !admission.1 {
            return Err("Client state IPC is closed for shutdown");
        }
        admission.0.send(job).map_err(|_| "Client state IPC worker stopped")
    }

    pub(crate) fn seal_and_drain_until(&self, deadline: Instant) -> bool {
        let (done, barrier) = mpsc::channel();
        {
            let mut admission = self.admission.lock().unwrap_or_else(|err| err.into_inner());
            admission.1 = false;
            if admission.0.send(Box::new(move || { let _ = done.send(()); })).is_err() {
                return false;
            }
        }
        barrier.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_ok()
    }

    pub(crate) fn reopen(&self) {
        self.admission.lock().unwrap_or_else(|err| err.into_inner()).1 = true;
    }
}
