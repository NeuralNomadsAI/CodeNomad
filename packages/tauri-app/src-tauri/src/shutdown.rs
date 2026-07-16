use crate::{client_state, AppState};
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
#[cfg(windows)]
use tauri::WebviewWindow;
use tauri::{AppHandle, Emitter, Manager};

const RENDERER_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);
#[cfg(windows)]
const WINDOWS_SESSION_END_TIMEOUT: Duration = Duration::from_millis(1_500);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum ShutdownPhase {
    #[default]
    Idle,
    WaitingForShutdownRenderer,
    CleanupInProgress,
    ExitAllowed,
    WaitingForMainWindowRenderer,
    FlushingMainWindow,
    FlushingMainWindowForShutdown,
    MainWindowCloseAllowed,
}

#[derive(Default)]
pub(crate) struct ShutdownCoordinator {
    state: Mutex<ShutdownState>,
    #[cfg(windows)]
    windows_session_end_started: AtomicBool,
}

#[derive(Default)]
struct ShutdownState {
    phase: ShutdownPhase,
    flush_generation: u64,
    active_flush_generation: Option<u64>,
}

impl ShutdownCoordinator {
    fn apply(&self, event: ShutdownEvent) -> (ShutdownAction, Option<u64>) {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(generation) = event.renderer_generation() {
            if state.active_flush_generation != Some(generation) {
                return (ShutdownAction::None, None);
            }
        }
        let (next, action) = transition(state.phase, event);
        state.phase = next;
        if action == ShutdownAction::RequestRendererFlush {
            state.flush_generation += 1;
            state.active_flush_generation = Some(state.flush_generation);
        } else if !matches!(
            next,
            ShutdownPhase::WaitingForShutdownRenderer | ShutdownPhase::WaitingForMainWindowRenderer
        ) {
            state.active_flush_generation = None;
        }
        (action, state.active_flush_generation)
    }

    fn phase(&self) -> ShutdownPhase {
        self.state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .phase
    }

    fn with_navigation<T>(&self, operation: impl FnOnce() -> T) -> Option<T> {
        let state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        (state.phase == ShutdownPhase::Idle).then(operation)
    }

    #[cfg(windows)]
    fn begin_windows_session_end(&self) -> bool {
        !self
            .windows_session_end_started
            .swap(true, Ordering::SeqCst)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShutdownEvent {
    BeginShutdown,
    BeginMainWindowClose,
    RendererFlushed(u64),
    RendererUnavailable,
    RendererTimeout(u64),
    MainWindowFlushed,
    MainWindowCloseFailed,
    MainWindowDestroyed,
    CleanupFinished,
}

impl ShutdownEvent {
    fn renderer_generation(self) -> Option<u64> {
        match self {
            Self::RendererFlushed(generation) | Self::RendererTimeout(generation) => {
                Some(generation)
            }
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShutdownAction {
    None,
    RequestRendererFlush,
    FlushMainWindow,
    CloseMainWindow,
    StartCleanup,
}

fn transition(phase: ShutdownPhase, event: ShutdownEvent) -> (ShutdownPhase, ShutdownAction) {
    use ShutdownAction::*;
    use ShutdownEvent::*;
    use ShutdownPhase::*;

    match (phase, event) {
        (Idle, BeginShutdown) => (WaitingForShutdownRenderer, RequestRendererFlush),
        (
            WaitingForShutdownRenderer,
            RendererFlushed(_) | RendererUnavailable | RendererTimeout(_) | MainWindowDestroyed,
        ) => (CleanupInProgress, StartCleanup),
        (Idle, BeginMainWindowClose) => (WaitingForMainWindowRenderer, RequestRendererFlush),
        (WaitingForMainWindowRenderer, RendererFlushed(_) | RendererTimeout(_)) => {
            (FlushingMainWindow, FlushMainWindow)
        }
        (WaitingForMainWindowRenderer, RendererUnavailable | MainWindowDestroyed) => (Idle, None),
        (WaitingForMainWindowRenderer, BeginShutdown) => (WaitingForShutdownRenderer, None),
        (FlushingMainWindow, BeginShutdown) => (FlushingMainWindowForShutdown, None),
        (FlushingMainWindow, MainWindowFlushed) => (MainWindowCloseAllowed, CloseMainWindow),
        (FlushingMainWindow, MainWindowDestroyed) => (Idle, None),
        (FlushingMainWindowForShutdown, MainWindowFlushed | MainWindowDestroyed) => {
            (CleanupInProgress, StartCleanup)
        }
        (MainWindowCloseAllowed, MainWindowDestroyed | MainWindowCloseFailed) => (Idle, None),
        (MainWindowCloseAllowed, BeginShutdown) => (CleanupInProgress, StartCleanup),
        (CleanupInProgress, CleanupFinished) => (ExitAllowed, None),
        _ => (phase, None),
    }
}

fn apply_event(app: AppHandle, event: ShutdownEvent) {
    let (action, generation) = app.state::<ShutdownCoordinator>().apply(event);

    match action {
        ShutdownAction::RequestRendererFlush => request_renderer_flush(app, generation.unwrap()),
        ShutdownAction::FlushMainWindow => flush_main_window(app),
        ShutdownAction::CloseMainWindow => close_main_window(app),
        ShutdownAction::StartCleanup => start_cleanup(app),
        ShutdownAction::None => {}
    }
}

fn request_renderer_flush(app: AppHandle, generation: u64) {
    let Some(window) = app.get_webview_window("main") else {
        apply_event(app, ShutdownEvent::RendererUnavailable);
        return;
    };
    if let Err(err) = window.emit(
        "client-state:flush-requested",
        client_state::RendererFlushRequest { generation },
    ) {
        eprintln!("[client-state] failed to request renderer shutdown flush: {err}");
    }
    std::thread::spawn(move || {
        std::thread::sleep(RENDERER_FLUSH_TIMEOUT);
        apply_event(app, ShutdownEvent::RendererTimeout(generation));
    });
}

fn flush_main_window(app: AppHandle) {
    std::thread::spawn(move || {
        client_state::capture_and_flush_main_window(&app);
        apply_event(app, ShutdownEvent::MainWindowFlushed);
    });
}

fn close_main_window(app: AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        apply_event(app, ShutdownEvent::MainWindowDestroyed);
        return;
    };
    if let Err(err) = window.close() {
        eprintln!("[client-state] failed to close main window after state flush: {err}");
        apply_event(app, ShutdownEvent::MainWindowCloseFailed);
    }
}

fn start_cleanup(app: AppHandle) {
    std::thread::spawn(move || {
        client_state::flush_and_release(&app);
        if let Some(state) = app.try_state::<AppState>() {
            state.desktop_events.stop();
            let _ = state.manager.stop();
        }
        apply_event(app.clone(), ShutdownEvent::CleanupFinished);
        app.exit(0);
    });
}

pub(crate) fn request(app: AppHandle) {
    apply_event(app, ShutdownEvent::BeginShutdown);
}

#[cfg(windows)]
pub(crate) fn request_windows_session_end(app: AppHandle) {
    if !app
        .state::<ShutdownCoordinator>()
        .begin_windows_session_end()
    {
        return;
    }

    request(app.clone());
    std::thread::spawn(move || {
        std::thread::sleep(WINDOWS_SESSION_END_TIMEOUT);
        if !exit_allowed(&app) {
            eprintln!("[client-state] Windows session-end shutdown timed out; forcing exit");
            app.exit(0);
        }
    });
}

pub(crate) fn request_main_window_close(app: AppHandle) {
    apply_event(app, ShutdownEvent::BeginMainWindowClose);
}

pub(crate) fn renderer_flushed(app: AppHandle, generation: u64) {
    apply_event(app, ShutdownEvent::RendererFlushed(generation));
}

pub(crate) fn main_window_destroyed(app: AppHandle) {
    apply_event(app, ShutdownEvent::MainWindowDestroyed);
}

fn phase(app: &AppHandle) -> ShutdownPhase {
    app.state::<ShutdownCoordinator>().phase()
}

pub(crate) fn with_navigation_authority<T>(
    app: &AppHandle,
    operation: impl FnOnce() -> T,
) -> Option<T> {
    app.state::<ShutdownCoordinator>()
        .with_navigation(operation)
}

pub(crate) fn main_window_close_allowed(app: &AppHandle) -> bool {
    phase(app) == ShutdownPhase::MainWindowCloseAllowed
}

pub(crate) fn exit_allowed(app: &AppHandle) -> bool {
    phase(app) == ShutdownPhase::ExitAllowed
}

#[cfg(windows)]
fn is_confirmed_windows_session_end(message: u32, wparam: usize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::WM_ENDSESSION;

    message == WM_ENDSESSION && wparam != 0
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
    use windows_sys::Win32::UI::WindowsAndMessaging::{WM_NCDESTROY, WM_QUERYENDSESSION};

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

    if is_confirmed_windows_session_end(message, wparam) {
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
    let hwnd = window.hwnd().map_err(|err| err.to_string())?;
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
        if let Err(err) = install_windows_session_end_handler(&window) {
            eprintln!("[client-state] failed to install Windows session-end handler: {err}");
        }
    })
    .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};

    #[test]
    fn close_only_flushes_and_closes_without_cleanup() {
        let waiting = transition(ShutdownPhase::Idle, ShutdownEvent::BeginMainWindowClose);
        assert_eq!(
            waiting,
            (
                ShutdownPhase::WaitingForMainWindowRenderer,
                ShutdownAction::RequestRendererFlush
            )
        );
        let flushing = transition(waiting.0, ShutdownEvent::RendererFlushed(1));
        assert_eq!(
            flushing,
            (
                ShutdownPhase::FlushingMainWindow,
                ShutdownAction::FlushMainWindow
            )
        );
        assert_eq!(
            transition(flushing.0, ShutdownEvent::MainWindowFlushed),
            (
                ShutdownPhase::MainWindowCloseAllowed,
                ShutdownAction::CloseMainWindow
            )
        );
    }

    #[test]
    fn shutdown_promotes_each_close_only_phase() {
        for (phase, event, expected) in [
            (
                ShutdownPhase::WaitingForMainWindowRenderer,
                ShutdownEvent::BeginShutdown,
                (
                    ShutdownPhase::WaitingForShutdownRenderer,
                    ShutdownAction::None,
                ),
            ),
            (
                ShutdownPhase::FlushingMainWindow,
                ShutdownEvent::BeginShutdown,
                (
                    ShutdownPhase::FlushingMainWindowForShutdown,
                    ShutdownAction::None,
                ),
            ),
            (
                ShutdownPhase::FlushingMainWindowForShutdown,
                ShutdownEvent::MainWindowFlushed,
                (
                    ShutdownPhase::CleanupInProgress,
                    ShutdownAction::StartCleanup,
                ),
            ),
            (
                ShutdownPhase::MainWindowCloseAllowed,
                ShutdownEvent::BeginShutdown,
                (
                    ShutdownPhase::CleanupInProgress,
                    ShutdownAction::StartCleanup,
                ),
            ),
        ] {
            assert_eq!(transition(phase, event), expected);
        }
    }

    #[test]
    fn stale_renderer_completion_cannot_advance_a_later_close() {
        let coordinator = ShutdownCoordinator::default();
        let (_, first) = coordinator.apply(ShutdownEvent::BeginMainWindowClose);
        assert_eq!(first, Some(1));
        coordinator.apply(ShutdownEvent::RendererFlushed(1));
        coordinator.apply(ShutdownEvent::MainWindowFlushed);
        coordinator.apply(ShutdownEvent::MainWindowDestroyed);
        let (_, second) = coordinator.apply(ShutdownEvent::BeginMainWindowClose);
        assert_eq!(second, Some(2));
        for stale in [
            ShutdownEvent::RendererFlushed(1),
            ShutdownEvent::RendererTimeout(1),
        ] {
            assert_eq!(coordinator.apply(stale), (ShutdownAction::None, None));
            assert_eq!(
                coordinator.phase(),
                ShutdownPhase::WaitingForMainWindowRenderer
            );
        }
        assert_eq!(
            coordinator.apply(ShutdownEvent::RendererTimeout(2)).0,
            ShutdownAction::FlushMainWindow
        );
    }

    #[test]
    fn cleanup_completion_permanently_allows_exit() {
        let completed = transition(
            ShutdownPhase::CleanupInProgress,
            ShutdownEvent::CleanupFinished,
        );
        assert_eq!(
            completed,
            (ShutdownPhase::ExitAllowed, ShutdownAction::None)
        );
        assert_eq!(
            transition(completed.0, ShutdownEvent::BeginShutdown),
            (ShutdownPhase::ExitAllowed, ShutdownAction::None)
        );
    }

    #[test]
    fn shutdown_waits_for_the_final_navigation_invocation() {
        let coordinator = Arc::new(ShutdownCoordinator::default());
        let navigating = Arc::clone(&coordinator);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let navigation = std::thread::spawn(move || {
            navigating.with_navigation(|| {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
        });
        started_rx.recv().unwrap();
        let shutting_down = Arc::clone(&coordinator);
        let (finished_tx, finished_rx) = mpsc::channel();
        let shutdown = std::thread::spawn(move || {
            shutting_down.apply(ShutdownEvent::BeginShutdown);
            finished_tx.send(()).unwrap();
        });
        assert!(finished_rx.recv_timeout(Duration::from_millis(20)).is_err());
        release_tx.send(()).unwrap();
        navigation.join().unwrap();
        finished_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        shutdown.join().unwrap();
        assert_eq!(
            coordinator.phase(),
            ShutdownPhase::WaitingForShutdownRenderer
        );
        assert!(coordinator.with_navigation(|| ()).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_session_end_is_bounded_and_starts_once() {
        let coordinator = ShutdownCoordinator::default();
        assert!(coordinator.begin_windows_session_end());
        assert!(!coordinator.begin_windows_session_end());
        assert!(WINDOWS_SESSION_END_TIMEOUT <= Duration::from_millis(1_500));
    }

    #[cfg(windows)]
    #[test]
    fn only_confirmed_end_session_starts_shutdown() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            WM_CLOSE, WM_ENDSESSION, WM_QUERYENDSESSION,
        };

        assert!(!is_confirmed_windows_session_end(WM_QUERYENDSESSION, 0));
        assert!(is_confirmed_windows_session_end(WM_ENDSESSION, 1));
        assert!(!is_confirmed_windows_session_end(WM_ENDSESSION, 0));
        assert!(!is_confirmed_windows_session_end(WM_CLOSE, 0));
    }
}
