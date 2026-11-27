//! Thread-affine OS wake lock for the native desktop host.
//!
//! Windows `SetThreadExecutionState` is per-thread, so acquire, release and drop teardown
//! all run on one dedicated worker thread spawned lazily on the first acquisition.
#[cfg(any(windows, test))]
use std::{
    sync::mpsc,
    thread::{self, JoinHandle},
};

#[cfg(any(windows, test))]
trait WakeBackend: Send + 'static {
    fn acquire(&mut self) -> bool;
    fn release(&mut self) -> bool;
}

#[cfg(windows)]
struct WindowsWakeBackend;

#[cfg(windows)]
impl WakeBackend for WindowsWakeBackend {
    fn acquire(&mut self) -> bool {
        use windows_sys::Win32::System::Power::{
            ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
        };
        // SAFETY: SetThreadExecutionState takes only bitflags and applies to the calling
        // worker thread, which also clears the state before exiting.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) != 0 }
    }

    fn release(&mut self) -> bool {
        use windows_sys::Win32::System::Power::{ES_CONTINUOUS, SetThreadExecutionState};
        // SAFETY: Clears ES_SYSTEM_REQUIRED on the same worker thread that acquired it.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) != 0 }
    }
}

#[cfg(any(windows, test))]
enum WakeCommand {
    Set(bool, mpsc::SyncSender<bool>),
    Stop,
}

#[cfg(any(windows, test))]
struct Worker {
    commands: mpsc::Sender<WakeCommand>,
    thread: Option<JoinHandle<()>>,
}

#[cfg(any(windows, test))]
impl Worker {
    fn start(mut backend: impl WakeBackend) -> Option<Self> {
        let (commands, rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("codenomad-wake-lock".into())
            .spawn(move || {
                let mut held = false;
                while let Ok(command) = rx.recv() {
                    match command {
                        WakeCommand::Set(true, reply) => {
                            if !held {
                                held = backend.acquire();
                            }
                            let _ = reply.send(held);
                        }
                        WakeCommand::Set(false, reply) => {
                            if held && backend.release() {
                                held = false;
                            }
                            let _ = reply.send(held);
                        }
                        WakeCommand::Stop => break,
                    }
                }
                if held {
                    let _ = backend.release();
                }
            })
            .ok()?;
        Some(Self {
            commands,
            thread: Some(thread),
        })
    }

    fn apply(&self, desired: bool) -> Option<bool> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.commands.send(WakeCommand::Set(desired, tx)).ok()?;
        rx.recv().ok()
    }

    fn stop(mut self) {
        let _ = self.commands.send(WakeCommand::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub struct WakeLock {
    desired: bool,
    held: bool,
    #[cfg(any(windows, test))]
    worker: Option<Worker>,
    #[cfg(test)]
    factory: Option<Box<dyn FnMut() -> Box<dyn WakeBackend> + Send>>,
}

#[cfg(test)]
impl WakeBackend for Box<dyn WakeBackend> {
    fn acquire(&mut self) -> bool {
        (**self).acquire()
    }

    fn release(&mut self) -> bool {
        (**self).release()
    }
}

impl Default for WakeLock {
    fn default() -> Self {
        Self::new()
    }
}

impl WakeLock {
    pub fn new() -> Self {
        Self {
            desired: false,
            held: false,
            #[cfg(any(windows, test))]
            worker: None,
            #[cfg(test)]
            factory: None,
        }
    }

    #[cfg(test)]
    fn with_factory(factory: impl FnMut() -> Box<dyn WakeBackend> + Send + 'static) -> Self {
        Self {
            desired: false,
            held: false,
            worker: None,
            factory: Some(Box::new(factory)),
        }
    }

    pub fn is_held(&self) -> bool {
        self.held
    }

    pub fn set_desired(&mut self, desired: bool) -> bool {
        if self.desired == desired && self.held == desired {
            return self.held;
        }
        // Avoid retrying a refused acquire on every frame until the desired state changes.
        if desired && self.desired && !self.held {
            return false;
        }
        self.desired = desired;
        #[cfg(any(windows, test))]
        {
            if desired && self.worker.is_none() {
                self.worker = self.spawn_worker();
            }
            if let Some(worker) = &self.worker {
                match worker.apply(desired) {
                    Some(held) => self.held = held,
                    None => {
                        self.worker = None;
                        self.held = false;
                    }
                }
            } else {
                self.held = false;
            }
        }
        #[cfg(not(any(windows, test)))]
        {
            self.held = false;
        }
        self.held
    }

    pub fn release(&mut self) {
        self.desired = false;
        #[cfg(any(windows, test))]
        if let Some(worker) = self.worker.take() {
            worker.stop();
        }
        self.held = false;
    }

    #[cfg(any(windows, test))]
    fn spawn_worker(&mut self) -> Option<Worker> {
        #[cfg(test)]
        if let Some(factory) = &mut self.factory {
            return Worker::start(factory());
        }
        #[cfg(windows)]
        {
            Worker::start(WindowsWakeBackend)
        }
        #[cfg(not(windows))]
        {
            None
        }
    }
}

impl Drop for WakeLock {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
        thread::ThreadId,
    };

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Event {
        Acquire(ThreadId),
        Release(ThreadId),
    }

    struct FakeBackend {
        events: Arc<Mutex<Vec<Event>>>,
        acquire_results: VecDeque<bool>,
        release_results: VecDeque<bool>,
    }

    impl WakeBackend for FakeBackend {
        fn acquire(&mut self) -> bool {
            self.events
                .lock()
                .unwrap()
                .push(Event::Acquire(thread::current().id()));
            self.acquire_results.pop_front().unwrap_or(true)
        }

        fn release(&mut self) -> bool {
            self.events
                .lock()
                .unwrap()
                .push(Event::Release(thread::current().id()));
            self.release_results.pop_front().unwrap_or(true)
        }
    }

    #[test]
    fn lazy_start_coalesces_transitions_and_releases_on_same_worker_thread() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let caller = thread::current().id();
        let mut lock = WakeLock::with_factory(move || {
            Box::new(FakeBackend {
                events: Arc::clone(&recorded),
                acquire_results: VecDeque::new(),
                release_results: VecDeque::new(),
            })
        });

        // Initial false is a no-op and spawns no worker thread.
        assert!(!lock.set_desired(false));
        assert!(lock.worker.is_none());

        assert!(lock.set_desired(true));
        assert!(lock.is_held());
        assert!(lock.set_desired(true));
        assert!(!lock.set_desired(false));
        assert!(!lock.is_held());
        assert!(!lock.set_desired(false));
        assert!(lock.set_desired(true));
        drop(lock);

        let log = events.lock().unwrap().clone();
        assert_eq!(log.len(), 4);
        let worker_id = match log[0] {
            Event::Acquire(id) => id,
            Event::Release(_) => panic!("expected Acquire first"),
        };
        assert_ne!(worker_id, caller);
        assert_eq!(
            log,
            vec![
                Event::Acquire(worker_id),
                Event::Release(worker_id),
                Event::Acquire(worker_id),
                Event::Release(worker_id),
            ]
        );
    }

    #[test]
    fn failed_acquire_reports_unheld_and_does_not_issue_spurious_release() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let mut lock = WakeLock::with_factory(move || {
            Box::new(FakeBackend {
                events: Arc::clone(&recorded),
                acquire_results: VecDeque::from([false, true]),
                release_results: VecDeque::new(),
            })
        });

        assert!(!lock.set_desired(true));
        assert!(!lock.is_held());
        // Repeated desired=true does not spin-retry every frame.
        assert!(!lock.set_desired(true));
        assert!(!lock.set_desired(false));
        // A later transition retries and succeeds.
        assert!(lock.set_desired(true));
        assert!(lock.is_held());
        drop(lock);

        let log = events.lock().unwrap().clone();
        assert_eq!(log.len(), 3);
        assert!(matches!(log[0], Event::Acquire(_)));
        assert!(matches!(log[1], Event::Acquire(_)));
        assert!(matches!(log[2], Event::Release(_)));
    }

    #[test]
    fn failed_release_keeps_held_truth_and_retries_on_release_or_drop() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let mut lock = WakeLock::with_factory(move || {
            Box::new(FakeBackend {
                events: Arc::clone(&recorded),
                acquire_results: VecDeque::from([true]),
                release_results: VecDeque::from([false, true]),
            })
        });

        assert!(lock.set_desired(true));
        assert!(lock.is_held());
        // First release fails: controller still reports held so next release or drop retries.
        assert!(lock.set_desired(false));
        assert!(lock.is_held());
        // Retrying release succeeds.
        assert!(!lock.set_desired(false));
        assert!(!lock.is_held());
        drop(lock);

        let log = events.lock().unwrap().clone();
        assert_eq!(log.len(), 3);
        assert!(matches!(log[0], Event::Acquire(_)));
        assert!(matches!(log[1], Event::Release(_)));
        assert!(matches!(log[2], Event::Release(_)));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "exercises real Windows SetThreadExecutionState"]
    fn windows_wake_lock_acquires_and_releases_cleanly() {
        let mut lock = WakeLock::new();
        assert!(lock.set_desired(true));
        assert!(lock.is_held());
        assert!(!lock.set_desired(false));
        assert!(!lock.is_held());
        lock.release();
    }
}
