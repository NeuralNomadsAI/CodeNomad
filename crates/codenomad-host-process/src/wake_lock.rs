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
    fn release(&mut self);
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

    fn release(&mut self) {
        use windows_sys::Win32::System::Power::{ES_CONTINUOUS, SetThreadExecutionState};
        // SAFETY: Clears ES_SYSTEM_REQUIRED on the same worker thread that acquired it.
        unsafe {
            let _ = SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}

#[cfg(any(windows, test))]
enum WakeCommand {
    Set(bool),
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
                        WakeCommand::Set(true) if !held => {
                            held = backend.acquire();
                        }
                        WakeCommand::Set(false) if held => {
                            backend.release();
                            held = false;
                        }
                        WakeCommand::Set(_) => {}
                        WakeCommand::Stop => break,
                    }
                }
                if held {
                    backend.release();
                }
            })
            .ok()?;
        Some(Self {
            commands,
            thread: Some(thread),
        })
    }

    fn send(&self, desired: bool) -> bool {
        self.commands.send(WakeCommand::Set(desired)).is_ok()
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

    fn release(&mut self) {
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
            worker: None,
            factory: Some(Box::new(factory)),
        }
    }

    pub fn set_desired(&mut self, desired: bool) {
        if self.desired == desired {
            return;
        }
        #[cfg(any(windows, test))]
        {
            if desired && self.worker.is_none() {
                self.worker = self.spawn_worker();
            }
            if let Some(worker) = &self.worker {
                if worker.send(desired) {
                    self.desired = desired;
                } else {
                    self.worker = None;
                    self.desired = false;
                }
            } else if !desired {
                self.desired = false;
            }
        }
        #[cfg(not(any(windows, test)))]
        {
            self.desired = desired;
        }
    }

    pub fn release(&mut self) {
        self.desired = false;
        #[cfg(any(windows, test))]
        if let Some(worker) = self.worker.take() {
            worker.stop();
        }
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
        succeed: bool,
    }

    impl WakeBackend for FakeBackend {
        fn acquire(&mut self) -> bool {
            self.events
                .lock()
                .unwrap()
                .push(Event::Acquire(thread::current().id()));
            self.succeed
        }

        fn release(&mut self) {
            self.events
                .lock()
                .unwrap()
                .push(Event::Release(thread::current().id()));
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
                succeed: true,
            })
        });

        // Initial false is a no-op and spawns no worker thread.
        lock.set_desired(false);
        assert!(lock.worker.is_none());

        lock.set_desired(true);
        lock.set_desired(true);
        lock.set_desired(false);
        lock.set_desired(false);
        lock.set_desired(true);
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
    fn failed_acquire_does_not_issue_spurious_release_on_drop() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let mut lock = WakeLock::with_factory(move || {
            Box::new(FakeBackend {
                events: Arc::clone(&recorded),
                succeed: false,
            })
        });

        lock.set_desired(true);
        lock.set_desired(false);
        drop(lock);

        let log = events.lock().unwrap().clone();
        assert_eq!(log.len(), 1);
        assert!(matches!(log[0], Event::Acquire(_)));
    }

    #[cfg(windows)]
    #[test]
    fn windows_wake_lock_acquires_and_releases_cleanly() {
        let mut lock = WakeLock::new();
        lock.set_desired(true);
        lock.set_desired(false);
        lock.set_desired(true);
        lock.release();
    }
}
