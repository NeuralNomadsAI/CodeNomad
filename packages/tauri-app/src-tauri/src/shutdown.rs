use crate::{client_state, local_windows::LocalWindows, AppState};
use std::collections::{HashMap, HashSet};
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
#[cfg(windows)]
use tauri::WebviewWindow;
use tauri::{AppHandle, Emitter, Manager};

const RENDERER_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);
const SHUTDOWN_STOP_ATTEMPTS: usize = 2;
const FLUSH_CANCELLED_EVENT: &str = "client-state:flush-cancelled";
#[cfg(windows)]
const WINDOWS_SESSION_END_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
struct PendingClose {
    window_id: String,
    generation: u64,
    persisted: bool,
}

#[derive(Default)]
struct ShutdownState {
    next_generation: u64,
    local_closes: HashMap<String, PendingClose>,
    close_allowed: HashSet<String>,
    global_pending: HashMap<String, u64>,
    shutdown_started: bool,
    cleanup_started: bool,
    exit_allowed: bool,
}

#[derive(Default)]
pub(crate) struct ShutdownCoordinator {
    state: Mutex<ShutdownState>,
    #[cfg(windows)]
    windows_session_end_started: AtomicBool,
}

impl ShutdownCoordinator {
    fn begin_local_close(&self, label: String, window_id: String, persisted: bool) -> Option<u64> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.shutdown_started
            || state.local_closes.contains_key(&label)
            || state.close_allowed.contains(&label)
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
        let mut requests = Vec::new();
        for label in labels {
            state.next_generation += 1;
            let generation = state.next_generation;
            state.global_pending.insert(label.clone(), generation);
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
        state.global_pending.clear();
        state.cleanup_started = true;
        true
    }

    fn cleanup_failed(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.cleanup_started = false;
        state.shutdown_started = false;
        state.global_pending.clear();
        state.close_allowed.clear();
    }

    fn commit_local_close(&self, label: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.shutdown_started {
            return false;
        }
        state.close_allowed.insert(label.to_string());
        true
    }

    fn rollback_local_close(&self, label: &str) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .close_allowed
            .remove(label);
    }

    fn close_allowed(&self, label: &str) -> bool {
        self.state
            .lock()
            .map(|state| state.close_allowed.contains(label))
            .unwrap_or(false)
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

    fn navigation_allowed(&self) -> bool {
        self.state
            .lock()
            .map(|state| !state.shutdown_started)
            .unwrap_or(false)
    }

    fn shutdown_started(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.shutdown_started)
            .unwrap_or(true)
    }

    #[cfg(windows)]
    fn begin_windows_session_end(&self) -> bool {
        !self
            .windows_session_end_started
            .swap(true, Ordering::SeqCst)
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

fn emit_flush_cancelled(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.emit(FLUSH_CANCELLED_EVENT, ());
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
        finish_local_close(app, label, record.id, generation);
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
            .commit_local_close(&label)
        {
            return;
        }
        if pending.persisted {
            if let Some(state) = app.try_state::<client_state::ClientState>() {
                if let Err(error) = state.remove_window(&pending.window_id) {
                    eprintln!("[client-state] failed to remove closed window: {error}");
                    app.state::<ShutdownCoordinator>()
                        .rollback_local_close(&label);
                    emit_flush_cancelled(&app, &label);
                    return;
                }
            }
        }
        let close_app = app.clone();
        let close_label = label.clone();
        if app
            .run_on_main_thread(move || {
                if let Some(window) = close_app.get_webview_window(&close_label) {
                    if window.close().is_err() {
                        close_app
                            .state::<ShutdownCoordinator>()
                            .rollback_local_close(&close_label);
                        emit_flush_cancelled(&close_app, &close_label);
                    }
                }
            })
            .is_err()
        {
            app.state::<ShutdownCoordinator>()
                .rollback_local_close(&label);
            emit_flush_cancelled(&app, &label);
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
        start_cleanup(app, true);
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
            app.state::<ShutdownCoordinator>().cleanup_failed();
            crate::local_windows::emit_all(&app, FLUSH_CANCELLED_EVENT, ());
            return;
        }
        client_state::release(&app);
        app.state::<ShutdownCoordinator>().allow_exit();
        app.exit(0);
    });
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
        .navigation_allowed()
        .then(operation)
}

pub(crate) fn local_window_close_allowed(app: &AppHandle, label: &str) -> bool {
    app.state::<ShutdownCoordinator>().close_allowed(label)
}

pub(crate) fn exit_allowed(app: &AppHandle) -> bool {
    app.state::<ShutdownCoordinator>().exit_allowed()
}

#[cfg(windows)]
pub(crate) fn request_windows_session_end(app: AppHandle) {
    if !app
        .state::<ShutdownCoordinator>()
        .begin_windows_session_end()
    {
        return;
    }
    if app.state::<ShutdownCoordinator>().shutdown_started() {
        let deadline = std::time::Instant::now() + WINDOWS_SESSION_END_TIMEOUT;
        while !exit_allowed(&app) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        return;
    }
    let _ = app
        .state::<ShutdownCoordinator>()
        .begin_shutdown(std::iter::empty());
    let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);
    let cleanup_app = app.clone();
    std::thread::spawn(move || {
        client_state::flush_and_release_without_window_capture(&cleanup_app);
        let result = {
            cleanup_app
                .try_state::<AppState>()
                .map(|state| {
                    retry_bounded(SHUTDOWN_STOP_ATTEMPTS, || {
                        state.manager.stop().map_err(|error| error.to_string())
                    })
                })
                .unwrap_or(Ok(()))
        };
        cleanup_app.state::<ShutdownCoordinator>().allow_exit();
        let _ = finished_tx.send(result);
    });
    if finished_rx
        .recv_timeout(WINDOWS_SESSION_END_TIMEOUT)
        .is_err()
    {
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
        return 1;
    }
    if message == WM_ENDSESSION && wparam != 0 {
        let context = &*(reference_data as *const WindowsSessionEndContext);
        request_windows_session_end(context.app.clone());
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
