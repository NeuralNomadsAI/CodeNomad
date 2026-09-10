use crate::{client_state, local_windows::LocalWindows, AppState};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
#[cfg(windows)]
use tauri::WebviewWindow;
use tauri::{AppHandle, Emitter, Manager};

const RENDERER_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);
const SHUTDOWN_STOP_ATTEMPTS: usize = 2;
const FLUSH_CANCELLED_EVENT: &str = "client-state:flush-cancelled";
#[cfg(windows)]
const WINDOWS_SESSION_END_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingClose {
    window_id: String,
    generation: u64,
    persisted: bool,
}

#[cfg(windows)]
struct WindowsSessionEndPreparation {
    generation: u64,
    deadline: Instant,
    requests: Option<Vec<(String, u64)>>,
}

enum PendingShutdownTimeoutAction {
    Cancel(Vec<(String, u64)>),
    #[cfg(windows)]
    Cleanup,
}

#[derive(Default)]
struct ShutdownState {
    next_generation: u64,
    local_closes: HashMap<String, PendingClose>,
    committed_local_closes: HashMap<String, PendingClose>,
    approved_local_closes: HashSet<String>,
    global_pending: HashMap<String, u64>,
    global_requests: HashMap<String, u64>,
    shutdown_started: bool,
    cleanup_started: bool,
    exit_allowed: bool,
    restart_requested: bool,
    #[cfg(windows)]
    windows_session_end_generation: Option<u64>,
    #[cfg(windows)]
    windows_session_end_deadline: Option<Instant>,
    #[cfg(windows)]
    windows_session_end_owns_shutdown: bool,
    #[cfg(windows)]
    windows_renderer_deadline: Option<Instant>,
    #[cfg(windows)]
    windows_native_flush_complete: bool,
}

#[derive(Default)]
pub(crate) struct ShutdownCoordinator {
    state: Mutex<ShutdownState>,
}

impl ShutdownCoordinator {
    fn begin_local_close(&self, label: String, window_id: String, persisted: bool) -> Option<u64> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.shutdown_started
            || state.local_closes.contains_key(&label)
            || state.committed_local_closes.contains_key(&label)
            || state.approved_local_closes.contains(&label)
        {
            return None;
        }
        state.next_generation += 1;
        let generation = state.next_generation;
        state.local_closes.insert(
            label,
            PendingClose {
                window_id,
                generation,
                persisted,
            },
        );
        Some(generation)
    }

    fn acknowledge_local(
        &self,
        label: &str,
        window_id: &str,
        generation: u64,
    ) -> Option<PendingClose> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let pending = state.local_closes.get(label)?;
        if pending.window_id != window_id || pending.generation != generation {
            return None;
        }
        state.local_closes.remove(label)
    }

    fn cancel_local_close(&self, label: &str, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state
            .local_closes
            .get(label)
            .map(|pending| pending.generation)
            != Some(generation)
        {
            return false;
        }
        state.local_closes.remove(label);
        true
    }

    fn begin_shutdown(
        &self,
        labels: impl IntoIterator<Item = String>,
    ) -> Option<Vec<(String, u64)>> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.shutdown_started {
            return None;
        }
        state.shutdown_started = true;
        state.local_closes.clear();
        state.committed_local_closes.clear();
        state.global_requests.clear();
        let mut requests = Vec::new();
        for label in labels {
            state.next_generation += 1;
            let generation = state.next_generation;
            state.global_pending.insert(label.clone(), generation);
            state.global_requests.insert(label.clone(), generation);
            requests.push((label, generation));
        }
        Some(requests)
    }

    fn acknowledge_global(&self, label: &str, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.global_pending.get(label).copied() != Some(generation) {
            return false;
        }
        state.global_pending.remove(label);
        state.global_pending.is_empty()
    }

    fn begin_cleanup(&self, deadline_reached: bool) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state.shutdown_started
            || state.cleanup_started
            || (!deadline_reached && !state.global_pending.is_empty())
        {
            return false;
        }
        #[cfg(windows)]
        if state.windows_session_end_owns_shutdown {
            return false;
        }
        state.global_pending.clear();
        state.cleanup_started = true;
        true
    }

    fn cleanup_failed(&self) -> Vec<(String, u64)> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let cancellations = state.global_requests.drain().collect();
        state.cleanup_started = false;
        state.shutdown_started = false;
        state.restart_requested = false;
        state.global_pending.clear();
        state.committed_local_closes.clear();
        #[cfg(windows)]
        {
            state.windows_session_end_generation = None;
            state.windows_session_end_deadline = None;
            state.windows_session_end_owns_shutdown = false;
            state.windows_renderer_deadline = None;
            state.windows_native_flush_complete = false;
        }
        cancellations
    }

    fn expire_pending_shutdown(&self) -> PendingShutdownTimeoutAction {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state.shutdown_started || state.cleanup_started {
            return PendingShutdownTimeoutAction::Cancel(Vec::new());
        }
        #[cfg(windows)]
        if state.windows_session_end_generation.is_some() {
            return PendingShutdownTimeoutAction::Cleanup;
        }
        state.shutdown_started = false;
        state.restart_requested = false;
        state.global_pending.clear();
        PendingShutdownTimeoutAction::Cancel(state.global_requests.drain().collect())
    }

    fn commit_local_close(&self, label: String, pending: PendingClose) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.shutdown_started {
            return false;
        }
        state.committed_local_closes.insert(label, pending);
        true
    }

    fn rollback_local_close(&self, label: &str) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .committed_local_closes
            .remove(label);
    }

    fn take_committed_local_close(&self, label: &str) -> Option<PendingClose> {
        self.state.lock().ok()?.committed_local_closes.remove(label)
    }

    fn local_close_in_flight(&self, label: &str) -> bool {
        self.state.lock().map_or(true, |state| {
            state.local_closes.contains_key(label)
                || state.committed_local_closes.contains_key(label)
                || state.approved_local_closes.contains(label)
        })
    }

    fn approve_local_close(&self, label: String) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .approved_local_closes
            .insert(label);
    }

    fn local_window_destroyed(&self, label: &str) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .approved_local_closes
            .remove(label);
    }

    fn exit_allowed(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.exit_allowed)
            .unwrap_or(false)
    }

    fn allow_exit(&self) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .exit_allowed = true;
    }

    fn request_restart(&self) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .restart_requested = true;
    }

    fn complete_cleanup(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.exit_allowed = true;
        state.restart_requested
    }

    fn with_navigation_authority<T>(&self, operation: impl FnOnce() -> T) -> Option<T> {
        let state = self.state.lock().ok()?;
        if state.shutdown_started {
            return None;
        }
        Some(operation())
    }

    fn shutdown_started(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.shutdown_started)
            .unwrap_or(true)
    }

    #[cfg(windows)]
    fn begin_windows_session_end(
        &self,
        labels: impl IntoIterator<Item = String>,
    ) -> WindowsSessionEndPreparation {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(generation) = state.windows_session_end_generation {
            return WindowsSessionEndPreparation {
                generation,
                deadline: state
                    .windows_session_end_deadline
                    .unwrap_or_else(Instant::now),
                requests: None,
            };
        }
        state.next_generation += 1;
        let session_generation = state.next_generation;
        let session_deadline = Instant::now() + WINDOWS_SESSION_END_TIMEOUT;
        state.windows_session_end_generation = Some(session_generation);
        state.windows_session_end_deadline = Some(session_deadline);
        if state.shutdown_started {
            return WindowsSessionEndPreparation {
                generation: session_generation,
                deadline: session_deadline,
                requests: Some(Vec::new()),
            };
        }
        state.windows_session_end_owns_shutdown = true;
        state.windows_renderer_deadline = Some(Instant::now() + RENDERER_FLUSH_TIMEOUT);
        state.windows_native_flush_complete = false;
        state.shutdown_started = true;
        state.local_closes.clear();
        state.committed_local_closes.clear();
        state.global_requests.clear();
        let mut requests = Vec::new();
        for label in labels {
            state.next_generation += 1;
            let generation = state.next_generation;
            state.global_pending.insert(label.clone(), generation);
            state.global_requests.insert(label.clone(), generation);
            requests.push((label, generation));
        }
        WindowsSessionEndPreparation {
            generation: session_generation,
            deadline: session_deadline,
            requests: Some(requests),
        }
    }

    #[cfg(windows)]
    fn windows_session_end_owns_shutdown(&self, generation: u64) -> bool {
        self.state
            .lock()
            .map(|state| {
                state.windows_session_end_generation == Some(generation)
                    && state.windows_session_end_owns_shutdown
            })
            .unwrap_or(false)
    }

    #[cfg(windows)]
    fn windows_renderer_wait(&self, generation: u64) -> Option<(bool, Instant)> {
        self.state.lock().ok().and_then(|state| {
            (state.windows_session_end_generation == Some(generation)
                && state.windows_session_end_owns_shutdown)
                .then(|| {
                    state
                        .windows_renderer_deadline
                        .map(|deadline| (!state.global_pending.is_empty(), deadline))
                })
                .flatten()
        })
    }

    #[cfg(windows)]
    fn begin_windows_cleanup(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.windows_session_end_generation != Some(generation)
            || !state.windows_session_end_owns_shutdown
            || state.cleanup_started
        {
            return false;
        }
        state.cleanup_started = true;
        state.global_pending.clear();
        true
    }

    #[cfg(windows)]
    fn complete_windows_native_flush(&self, generation: u64) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.windows_session_end_generation == Some(generation)
            && state.windows_session_end_owns_shutdown
        {
            state.windows_native_flush_complete = true;
        }
    }

    #[cfg(windows)]
    fn windows_native_flush_complete(&self, generation: u64) -> bool {
        self.state
            .lock()
            .map(|state| {
                state.windows_session_end_generation == Some(generation)
                    && state.windows_native_flush_complete
            })
            .unwrap_or(false)
    }

    #[cfg(windows)]
    fn windows_session_end_remaining(&self, generation: u64, now: Instant) -> Option<Duration> {
        self.state.lock().ok().and_then(|state| {
            (state.windows_session_end_generation == Some(generation))
                .then(|| {
                    state
                        .windows_session_end_deadline
                        .map(|deadline| deadline.saturating_duration_since(now))
                })
                .flatten()
        })
    }

    #[cfg(windows)]
    fn cancel_windows_session_end(&self) -> Vec<(String, u64)> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.windows_session_end_generation.is_none() {
            return Vec::new();
        }
        state.windows_session_end_generation = None;
        state.windows_session_end_deadline = None;
        state.windows_renderer_deadline = None;
        state.windows_native_flush_complete = false;
        if !state.windows_session_end_owns_shutdown || state.cleanup_started {
            return Vec::new();
        }
        state.windows_session_end_owns_shutdown = false;
        state.shutdown_started = false;
        state.global_pending.clear();
        state.global_requests.drain().collect()
    }
}

fn emit_flush(app: &AppHandle, label: &str, generation: u64) -> bool {
    app.get_webview_window(label).is_some_and(|window| {
        window
            .emit(
                "client-state:flush-requested",
                client_state::RendererFlushRequest { generation },
            )
            .is_ok()
    })
}

fn emit_flush_cancelled(app: &AppHandle, label: &str, generation: u64) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.emit(
            FLUSH_CANCELLED_EVENT,
            client_state::RendererFlushRequest { generation },
        );
    }
}

fn emit_flush_cancellations(app: &AppHandle, cancellations: Vec<(String, u64)>) {
    for (label, generation) in cancellations {
        emit_flush_cancelled(app, &label, generation);
    }
}

pub(crate) fn request_local_window_close(app: AppHandle, label: String) {
    let Some(record) = app.state::<LocalWindows>().record(&label) else {
        return;
    };
    let Some(generation) = app.state::<ShutdownCoordinator>().begin_local_close(
        label.clone(),
        record.id.clone(),
        record.persisted,
    ) else {
        return;
    };
    if !emit_flush(&app, &label, generation) {
        finish_local_close(app, label, record.id, generation);
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(RENDERER_FLUSH_TIMEOUT);
        if app
            .state::<ShutdownCoordinator>()
            .cancel_local_close(&label, generation)
        {
            emit_flush_cancelled(&app, &label, generation);
        }
    });
}

fn finish_local_close(app: AppHandle, label: String, window_id: String, generation: u64) {
    let Some(pending) = app
        .state::<ShutdownCoordinator>()
        .acknowledge_local(&label, &window_id, generation)
    else {
        return;
    };
    std::thread::spawn(move || {
        client_state::capture_and_flush_window(&app, &label);
        if !app
            .state::<ShutdownCoordinator>()
            .commit_local_close(label.clone(), pending)
        {
            return;
        }
        let close_app = app.clone();
        let close_label = label.clone();
        if app
            .run_on_main_thread(move || {
                let dispatched = close_app
                    .get_webview_window(&close_label)
                    .is_some_and(|window| window.close().is_ok());
                if !dispatched {
                    close_app
                        .state::<ShutdownCoordinator>()
                        .rollback_local_close(&close_label);
                    emit_flush_cancelled(&close_app, &close_label, generation);
                }
            })
            .is_err()
        {
            app.state::<ShutdownCoordinator>()
                .rollback_local_close(&label);
            emit_flush_cancelled(&app, &label, generation);
        }
    });
}

pub(crate) fn request(app: AppHandle) {
    let labels = app
        .state::<LocalWindows>()
        .records()
        .into_iter()
        .map(|record| record.label)
        .collect::<Vec<_>>();
    let Some(requests) = app.state::<ShutdownCoordinator>().begin_shutdown(labels) else {
        start_cleanup(app, false);
        return;
    };
    for (label, generation) in &requests {
        if !emit_flush(&app, label, *generation) {
            app.state::<ShutdownCoordinator>()
                .acknowledge_global(label, *generation);
        }
    }
    if requests.is_empty()
        || requests.iter().all(|(label, generation)| {
            app.state::<ShutdownCoordinator>()
                .state
                .lock()
                .ok()
                .is_some_and(|state| state.global_pending.get(label) != Some(generation))
        })
    {
        start_cleanup(app, false);
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(RENDERER_FLUSH_TIMEOUT);
        match app.state::<ShutdownCoordinator>().expire_pending_shutdown() {
            PendingShutdownTimeoutAction::Cancel(cancellations) => {
                emit_flush_cancellations(&app, cancellations)
            }
            #[cfg(windows)]
            PendingShutdownTimeoutAction::Cleanup => start_cleanup(app, true),
        }
    });
}

pub(crate) fn renderer_flushed(app: AppHandle, label: String, window_id: String, generation: u64) {
    if app
        .state::<ShutdownCoordinator>()
        .acknowledge_global(&label, generation)
    {
        start_cleanup(app, false);
        return;
    }
    finish_local_close(app, label, window_id, generation);
}

fn start_cleanup(app: AppHandle, deadline_reached: bool) {
    if !app
        .state::<ShutdownCoordinator>()
        .begin_cleanup(deadline_reached)
    {
        return;
    }
    std::thread::spawn(move || {
        client_state::capture_and_flush_all_windows(&app);
        let result = if let Some(state) = app.try_state::<AppState>() {
            retry_bounded(SHUTDOWN_STOP_ATTEMPTS, || {
                state.manager.stop().map_err(|error| error.to_string())
            })
        } else {
            Ok(())
        };
        if let Err(error) = result {
            eprintln!("[tauri] shutdown cleanup remains unconfirmed: {error}");
            let cancellations = app.state::<ShutdownCoordinator>().cleanup_failed();
            emit_flush_cancellations(&app, cancellations);
            return;
        }
        client_state::release(&app);
        let restart = app.state::<ShutdownCoordinator>().complete_cleanup();
        if restart {
            app.request_restart();
        } else {
            app.exit(0);
        }
    });
}

pub(crate) fn request_restart(app: AppHandle) {
    app.state::<ShutdownCoordinator>().request_restart();
    request(app);
}

fn retry_bounded<E>(
    attempts: usize,
    mut operation: impl FnMut() -> Result<(), E>,
) -> Result<(), E> {
    assert!(attempts > 0);
    for attempt in 1..=attempts {
        match operation() {
            Ok(()) => return Ok(()),
            Err(error) if attempt == attempts => return Err(error),
            Err(_) => {}
        }
    }
    unreachable!()
}

pub(crate) fn with_navigation_authority<T>(
    app: &AppHandle,
    operation: impl FnOnce() -> T,
) -> Option<T> {
    app.state::<ShutdownCoordinator>()
        .with_navigation_authority(operation)
}

pub(crate) fn consume_local_window_close(app: &AppHandle, label: &str) -> Option<bool> {
    let coordinator = app.state::<ShutdownCoordinator>();
    if coordinator
        .state
        .lock()
        .ok()
        .is_some_and(|state| state.approved_local_closes.contains(label))
    {
        return Some(true);
    }
    let pending = app
        .state::<ShutdownCoordinator>()
        .take_committed_local_close(label)?;
    if !pending.persisted {
        app.state::<ShutdownCoordinator>()
            .approve_local_close(label.to_string());
        return Some(true);
    }
    let result = app
        .try_state::<client_state::ClientState>()
        .ok_or_else(|| "client state is unavailable".to_string())
        .and_then(|state| match state.remove_window(&pending.window_id) {
            Ok(true) => Ok(()),
            Ok(false) => Err("persistent window state was not removed".to_string()),
            Err(error) => Err(error),
        });
    if let Err(error) = result {
        eprintln!("[client-state] failed to remove closed window: {error}");
        emit_flush_cancelled(app, label, pending.generation);
        return Some(false);
    }
    app.state::<ShutdownCoordinator>()
        .approve_local_close(label.to_string());
    Some(true)
}

pub(crate) fn local_window_close_in_flight(app: &AppHandle, label: &str) -> bool {
    app.state::<ShutdownCoordinator>()
        .local_close_in_flight(label)
}

pub(crate) fn local_window_destroyed(app: &AppHandle, label: &str) {
    app.state::<ShutdownCoordinator>()
        .local_window_destroyed(label);
}

pub(crate) fn exit_allowed(app: &AppHandle) -> bool {
    app.state::<ShutdownCoordinator>().exit_allowed()
}

#[cfg(windows)]
fn prepare_windows_session_end(app: &AppHandle) -> (u64, Instant) {
    let labels = app
        .state::<LocalWindows>()
        .records()
        .into_iter()
        .map(|record| record.label)
        .collect::<Vec<_>>();
    let preparation = app
        .state::<ShutdownCoordinator>()
        .begin_windows_session_end(labels);
    let generation = preparation.generation;
    let deadline = preparation.deadline;
    let Some(requests) = preparation.requests else {
        return (generation, deadline);
    };
    for (label, flush_generation) in requests {
        if !emit_flush(app, &label, flush_generation) {
            app.state::<ShutdownCoordinator>()
                .acknowledge_global(&label, flush_generation);
        }
    }
    if !app
        .state::<ShutdownCoordinator>()
        .windows_session_end_owns_shutdown(generation)
    {
        return (generation, deadline);
    }
    let flush_app = app.clone();
    std::thread::spawn(move || {
        while flush_app
            .state::<ShutdownCoordinator>()
            .windows_renderer_wait(generation)
            .is_some_and(|(pending, deadline)| pending && Instant::now() < deadline)
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        if !flush_app
            .state::<ShutdownCoordinator>()
            .windows_session_end_owns_shutdown(generation)
        {
            return;
        }
        client_state::flush_without_window_capture(&flush_app);
        flush_app
            .state::<ShutdownCoordinator>()
            .complete_windows_native_flush(generation);
    });
    (generation, deadline)
}

#[cfg(windows)]
fn cancel_windows_session_end(app: &AppHandle) {
    let cancellations = app
        .state::<ShutdownCoordinator>()
        .cancel_windows_session_end();
    emit_flush_cancellations(app, cancellations);
}

#[cfg(windows)]
pub(crate) fn request_windows_session_end(app: AppHandle) {
    let (generation, session_deadline) = prepare_windows_session_end(&app);
    if !app
        .state::<ShutdownCoordinator>()
        .windows_session_end_owns_shutdown(generation)
    {
        while !exit_allowed(&app) && Instant::now() < session_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        return;
    }

    while !app
        .state::<ShutdownCoordinator>()
        .windows_native_flush_complete(generation)
        && Instant::now() < session_deadline
    {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !app
        .state::<ShutdownCoordinator>()
        .windows_native_flush_complete(generation)
    {
        eprintln!(
            "[tauri] Windows session-end state flush exceeded {:?}",
            WINDOWS_SESSION_END_TIMEOUT
        );
        return;
    }
    if !app
        .state::<ShutdownCoordinator>()
        .begin_windows_cleanup(generation)
    {
        return;
    }

    let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);
    let cleanup_app = app.clone();
    std::thread::spawn(move || {
        let result = {
            cleanup_app
                .try_state::<AppState>()
                .map(|state| {
                    retry_bounded(SHUTDOWN_STOP_ATTEMPTS, || {
                        state
                            .manager
                            .stop_until(session_deadline)
                            .map_err(|error| error.to_string())
                    })
                })
                .unwrap_or(Ok(()))
        };
        client_state::release(&cleanup_app);
        cleanup_app.state::<ShutdownCoordinator>().allow_exit();
        let _ = finished_tx.send(result);
    });
    let remaining = app
        .state::<ShutdownCoordinator>()
        .windows_session_end_remaining(generation, Instant::now())
        .unwrap_or_default();
    if finished_rx.recv_timeout(remaining).is_err() {
        eprintln!(
            "[tauri] Windows session-end cleanup exceeded {:?}",
            WINDOWS_SESSION_END_TIMEOUT
        );
    }
}

#[cfg(windows)]
struct WindowsSessionEndContext {
    app: AppHandle,
}

#[cfg(windows)]
unsafe extern "system" fn windows_session_end_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    subclass_id: usize,
    reference_data: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WM_ENDSESSION, WM_NCDESTROY, WM_QUERYENDSESSION,
    };
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(windows_session_end_proc), subclass_id);
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        drop(Box::from_raw(
            reference_data as *mut WindowsSessionEndContext,
        ));
        return result;
    }
    if message == WM_QUERYENDSESSION {
        // Windows requires this message to return promptly. Start the bounded state-flush
        // worker now, but leave CLI cleanup and lock release for WM_ENDSESSION.
        let context = &*(reference_data as *const WindowsSessionEndContext);
        prepare_windows_session_end(&context.app);
        return 1;
    }
    if message == WM_ENDSESSION {
        let context = &*(reference_data as *const WindowsSessionEndContext);
        if wparam != 0 {
            request_windows_session_end(context.app.clone());
        } else {
            cancel_windows_session_end(&context.app);
        }
        return 0;
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

#[cfg(windows)]
pub(crate) fn install_windows_session_end_handler(window: &WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::SetWindowSubclass;
    const SUBCLASS_ID: usize = 0x434E_5345;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let context = Box::into_raw(Box::new(WindowsSessionEndContext {
        app: window.app_handle().clone(),
    }));
    let installed = unsafe {
        SetWindowSubclass(
            hwnd.0,
            Some(windows_session_end_proc),
            SUBCLASS_ID,
            context as usize,
        )
    };
    if installed == 0 {
        unsafe { drop(Box::from_raw(context)) };
        return Err("failed to install Windows session-end handler".to_string());
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn schedule_windows_session_end_handler(window: &WebviewWindow) -> Result<(), String> {
    let window = window.clone();
    let app = window.app_handle().clone();
    app.run_on_main_thread(move || {
        if let Err(error) = install_windows_session_end_handler(&window) {
            eprintln!("[client-state] failed to install Windows session-end handler: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "shutdown_tests.rs"]
mod tests;
