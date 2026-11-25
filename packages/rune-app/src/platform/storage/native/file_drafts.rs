use super::{FILE_DRAFT_BYTES, Files, Store, WriteGate};
use crate::history::Result;
use std::fs;

const DRAFT_ACTIVE: u8 = 0;
const DRAFT_PUBLISHING: u8 = 1;
const DRAFT_CANCELLED: u8 = 2;

fn cancel_draft(state: &std::sync::atomic::AtomicU8) -> bool {
    state
        .compare_exchange(
            DRAFT_ACTIVE,
            DRAFT_CANCELLED,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_ok()
}

struct PendingFileDraft {
    state: std::sync::Arc<std::sync::atomic::AtomicU8>,
    generation: u64,
    deadline: std::time::Instant,
    bytes: Vec<u8>,
    reply: tokio::sync::oneshot::Sender<Result<bool>>,
}

#[derive(Default)]
pub(super) struct FileDraftQueue {
    running: bool,
    active: Option<std::sync::Arc<std::sync::atomic::AtomicU8>>,
    pending: Option<PendingFileDraft>,
    #[cfg(test)]
    writes: u64,
}

impl FileDraftQueue {
    pub(super) fn cancel_all(&mut self) {
        if let Some(active) = self.active.take() {
            let _ = cancel_draft(&active);
        }
        if let Some(evicted) = self.pending.take() {
            let _ = cancel_draft(&evicted.state);
            let _ = evicted.reply.send(Ok(false));
        }
    }
}

fn spawn_file_draft_worker(
    files: std::sync::Arc<Files>,
    file_drafts_lock: std::sync::Arc<std::sync::Mutex<()>>,
    queue: std::sync::Arc<std::sync::Mutex<FileDraftQueue>>,
    gate: std::sync::Arc<std::sync::Mutex<WriteGate>>,
) {
    tokio::task::spawn_blocking(move || {
        loop {
            let task = {
                let Ok(mut state) = queue.lock() else {
                    return;
                };
                match state.pending.take() {
                    Some(task) => task,
                    None => {
                        state.running = false;
                        return;
                    }
                }
            };
            let current = || {
                task.state.load(std::sync::atomic::Ordering::Acquire) == DRAFT_ACTIVE
                    && std::time::Instant::now() < task.deadline
                    && gate.lock().is_ok_and(|g| g.allows(task.generation))
            };
            let outcome = if !current() {
                Ok(false)
            } else {
                match file_drafts_lock.lock() {
                    Ok(_guard) => files.save_file_with(
                        "workspace-file-drafts.json",
                        FILE_DRAFT_BYTES,
                        &task.bytes,
                        current,
                        |temporary, destination| {
                            // Enforce the deadline and claim PUBLISHING atomically without
                            // holding a mutex across fs::rename so a stalled filesystem cannot
                            // block admission or timeout beyond the 5 s wait bound; re-check
                            // the deadline and write gate after claiming PUBLISHING so a pause
                            // before the CAS cannot publish after expiry or Clear/Disable.
                            if std::time::Instant::now() >= task.deadline
                                || !gate.lock().is_ok_and(|g| g.allows(task.generation))
                                || task
                                    .state
                                    .compare_exchange(
                                        DRAFT_ACTIVE,
                                        DRAFT_PUBLISHING,
                                        std::sync::atomic::Ordering::AcqRel,
                                        std::sync::atomic::Ordering::Acquire,
                                    )
                                    .is_err()
                            {
                                return Ok(false);
                            }
                            if std::time::Instant::now() >= task.deadline
                                || !gate.lock().is_ok_and(|g| g.allows(task.generation))
                            {
                                task.state
                                    .store(DRAFT_CANCELLED, std::sync::atomic::Ordering::Release);
                                return Ok(false);
                            }
                            fs::rename(temporary, destination)?;
                            Ok(true)
                        },
                    ),
                    Err(_) => Err("state store unavailable".into()),
                }
            };
            #[cfg(test)]
            if matches!(outcome, Ok(true)) {
                if let Ok(mut state) = queue.lock() {
                    state.writes += 1;
                }
            }
            let _ = task.reply.send(outcome);
        }
    });
}

impl Store {
    pub async fn load_file_drafts(&self) -> Result<Option<Vec<u8>>> {
        let files = self.files.clone();
        let file_drafts_lock = self.file_drafts_lock.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = file_drafts_lock
                .lock()
                .map_err(|_| "state store unavailable")?;
            files.load_file("workspace-file-drafts.json", FILE_DRAFT_BYTES)
        })
        .await?
    }
    #[cfg(test)]
    pub fn save_file_drafts(&self, bytes: &[u8]) -> Result<()> {
        self.cancel_file_drafts_save();
        let _guard = self
            .file_drafts_lock
            .lock()
            .map_err(|_| "state store unavailable")?;
        self.files
            .save_file("workspace-file-drafts.json", FILE_DRAFT_BYTES, bytes)
    }
    pub fn cancel_file_drafts_save(&self) {
        if let Ok(mut state) = self.file_drafts_queue.lock() {
            if let Some(active) = state.active.take() {
                let _ = cancel_draft(&active);
            }
            if let Some(evicted) = state.pending.take() {
                let _ = cancel_draft(&evicted.state);
                let _ = evicted.reply.send(Ok(false));
            }
        }
    }
    pub fn start_file_drafts_save(
        &self,
        bytes: Vec<u8>,
    ) -> impl std::future::Future<Output = Result<bool>> + Send + 'static {
        self.start_file_drafts_save_with_timeout(bytes, std::time::Duration::from_secs(5))
    }
    pub(in crate::platform::storage) fn start_file_drafts_save_with_timeout(
        &self,
        bytes: Vec<u8>,
        timeout: std::time::Duration,
    ) -> impl std::future::Future<Output = Result<bool>> + Send + 'static {
        let deadline = std::time::Instant::now() + timeout;
        self.start_file_drafts_save_with_deadlines(bytes, deadline, timeout)
    }
    pub(in crate::platform::storage) fn start_file_drafts_save_with_deadlines(
        &self,
        bytes: Vec<u8>,
        deadline: std::time::Instant,
        wait_timeout: std::time::Duration,
    ) -> impl std::future::Future<Output = Result<bool>> + Send + 'static {
        // Enqueue synchronously at admission so an unpolled task cannot outrank a later save
        // or exit flush, and repeated retries share one worker without blocking on disk I/O.
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let files = self.files.clone();
        let file_drafts_lock = self.file_drafts_lock.clone();
        let queue = self.file_drafts_queue.clone();
        let gate = self.gate.clone();
        let write_state = std::sync::Arc::new(std::sync::atomic::AtomicU8::new(DRAFT_ACTIVE));
        let wait_deadline = std::time::Instant::now() + wait_timeout;
        let generation = gate.lock().ok().and_then(|g| g.admit());
        let admitted = match (generation, queue.lock()) {
            (Some(generation), Ok(mut state)) => {
                if let Some(previous) = state.active.replace(write_state.clone()) {
                    let _ = cancel_draft(&previous);
                }
                if let Some(evicted) = state.pending.replace(PendingFileDraft {
                    state: write_state.clone(),
                    generation,
                    deadline,
                    bytes,
                    reply: tx,
                }) {
                    let _ = cancel_draft(&evicted.state);
                    let _ = evicted.reply.send(Ok(false));
                }
                true
            }
            (None, _) => {
                let _ = tx.send(Ok(false));
                false
            }
            (_, Err(_)) => {
                let _ = tx.send(Err("state store unavailable".into()));
                false
            }
        };
        async move {
            if !admitted {
                return match rx.await {
                    Ok(outcome) => outcome,
                    Err(_) => Err("state store unavailable".into()),
                };
            }
            let start_worker = queue
                .lock()
                .map(|mut state| {
                    if !state.running && state.pending.is_some() {
                        state.running = true;
                        true
                    } else {
                        false
                    }
                })
                .unwrap_or(false);
            if start_worker {
                spawn_file_draft_worker(files, file_drafts_lock, queue.clone(), gate);
            }
            let remaining = wait_deadline
                .checked_duration_since(std::time::Instant::now())
                .unwrap_or(std::time::Duration::ZERO);
            match tokio::time::timeout(remaining, &mut rx).await {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(_)) => Err("state store unavailable".into()),
                Err(elapsed) => {
                    let cancelled = cancel_draft(&write_state);
                    if let Ok(mut state) = queue.lock() {
                        if state
                            .active
                            .as_ref()
                            .is_some_and(|active| std::sync::Arc::ptr_eq(active, &write_state))
                        {
                            state.active = None;
                        }
                        if state.pending.as_ref().is_some_and(|pending| {
                            std::sync::Arc::ptr_eq(&pending.state, &write_state)
                        }) {
                            state.pending = None;
                        }
                    }
                    if !cancelled && let Ok(outcome) = rx.try_recv() {
                        return outcome;
                    }
                    Err(elapsed.into())
                }
            }
        }
    }
    #[cfg(test)]
    pub fn save_file_drafts_exit(&self, bytes: Vec<u8>) -> Result<()> {
        self.save_file_drafts_exit_within(bytes, std::time::Duration::from_secs(5))
    }
    pub fn save_file_drafts_exit_within(
        &self,
        bytes: Vec<u8>,
        timeout: std::time::Duration,
    ) -> Result<()> {
        let write = self.start_file_drafts_save_with_timeout(bytes, timeout);
        match crate::platform::block_on(write)? {
            true => Ok(()),
            false => Err("file draft write superseded".into()),
        }
    }
    #[cfg(test)]
    pub(crate) fn lock_file_drafts(&self) -> std::sync::MutexGuard<'_, ()> {
        self.file_drafts_lock.lock().unwrap()
    }
    #[cfg(test)]
    pub(crate) fn files_refcount(&self) -> usize {
        std::sync::Arc::strong_count(&self.files)
    }
    #[cfg(test)]
    pub(crate) fn file_draft_worker_running(&self) -> bool {
        self.file_drafts_queue
            .lock()
            .is_ok_and(|state| state.running)
    }
    #[cfg(test)]
    pub(in crate::platform::storage) fn file_draft_pending(&self) -> bool {
        self.file_drafts_queue
            .lock()
            .is_ok_and(|state| state.pending.is_some())
    }
    #[cfg(test)]
    pub(crate) fn file_draft_write_count(&self) -> u64 {
        self.file_drafts_queue
            .lock()
            .map_or(0, |state| state.writes)
    }
}
