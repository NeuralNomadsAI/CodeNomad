use crate::{client_state, AppState};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static SHUTDOWN_STATE: AtomicU8 = AtomicU8::new(ShutdownPhase::Idle as u8);
static RENDERER_FLUSH_GENERATION: AtomicU64 = AtomicU64::new(0);
const RENDERER_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub(crate) enum ShutdownPhase {
    Idle = 0,
    WaitingForShutdownRenderer = 1,
    CleanupInProgress = 2,
    ExitAllowed = 3,
    WaitingForMainWindowRenderer = 4,
    FlushingMainWindow = 5,
    FlushingMainWindowForShutdown = 6,
    MainWindowCloseAllowed = 7,
}

impl ShutdownPhase {
    pub(crate) fn from_raw(value: u8) -> Self {
        match value {
            1 => Self::WaitingForShutdownRenderer,
            2 => Self::CleanupInProgress,
            3 => Self::ExitAllowed,
            4 => Self::WaitingForMainWindowRenderer,
            5 => Self::FlushingMainWindow,
            6 => Self::FlushingMainWindowForShutdown,
            7 => Self::MainWindowCloseAllowed,
            _ => Self::Idle,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ShutdownEvent {
    BeginShutdown { renderer_available: bool },
    BeginMainWindowClose,
    RendererFlushed,
    RendererTimeout,
    RendererUnavailable,
    MainWindowFlushed,
    MainWindowCloseFailed,
    MainWindowDestroyed,
    CleanupFinished,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ShutdownAction {
    None,
    RequestRendererFlush,
    FlushMainWindow,
    CloseMainWindow,
    StartCleanup,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ShutdownTransition {
    pub(crate) next: ShutdownPhase,
    pub(crate) action: ShutdownAction,
}

pub(crate) fn transition(phase: ShutdownPhase, event: ShutdownEvent) -> ShutdownTransition {
    use ShutdownAction::{
        CloseMainWindow, FlushMainWindow, None, RequestRendererFlush, StartCleanup,
    };
    use ShutdownEvent::{
        BeginMainWindowClose, BeginShutdown, CleanupFinished, MainWindowCloseFailed,
        MainWindowDestroyed, MainWindowFlushed, RendererFlushed, RendererTimeout,
        RendererUnavailable,
    };
    use ShutdownPhase::{
        CleanupInProgress, ExitAllowed, FlushingMainWindow, FlushingMainWindowForShutdown, Idle,
        MainWindowCloseAllowed, WaitingForMainWindowRenderer, WaitingForShutdownRenderer,
    };

    match (phase, event) {
        (
            Idle,
            BeginShutdown {
                renderer_available: true,
            },
        ) => ShutdownTransition {
            next: WaitingForShutdownRenderer,
            action: RequestRendererFlush,
        },
        (
            Idle,
            BeginShutdown {
                renderer_available: false,
            },
        )
        | (WaitingForShutdownRenderer, RendererUnavailable)
        | (WaitingForShutdownRenderer, RendererFlushed | RendererTimeout)
        | (WaitingForShutdownRenderer, MainWindowDestroyed) => ShutdownTransition {
            next: CleanupInProgress,
            action: StartCleanup,
        },
        (Idle, BeginMainWindowClose) => ShutdownTransition {
            next: WaitingForMainWindowRenderer,
            action: RequestRendererFlush,
        },
        (WaitingForMainWindowRenderer, RendererFlushed | RendererTimeout) => ShutdownTransition {
            next: FlushingMainWindow,
            action: FlushMainWindow,
        },
        (WaitingForMainWindowRenderer, RendererUnavailable | MainWindowDestroyed) => {
            ShutdownTransition {
                next: Idle,
                action: None,
            }
        }
        (WaitingForMainWindowRenderer, BeginShutdown { .. }) => ShutdownTransition {
            next: WaitingForShutdownRenderer,
            action: None,
        },
        (FlushingMainWindow, BeginShutdown { .. }) => ShutdownTransition {
            next: FlushingMainWindowForShutdown,
            action: None,
        },
        (FlushingMainWindow, MainWindowFlushed) => ShutdownTransition {
            next: MainWindowCloseAllowed,
            action: CloseMainWindow,
        },
        (FlushingMainWindow, MainWindowDestroyed) => ShutdownTransition {
            next: Idle,
            action: None,
        },
        (FlushingMainWindowForShutdown, MainWindowFlushed | MainWindowDestroyed) => {
            ShutdownTransition {
                next: CleanupInProgress,
                action: StartCleanup,
            }
        }
        (MainWindowCloseAllowed, MainWindowDestroyed | MainWindowCloseFailed) => {
            ShutdownTransition {
                next: Idle,
                action: None,
            }
        }
        (MainWindowCloseAllowed, BeginShutdown { .. }) => ShutdownTransition {
            next: CleanupInProgress,
            action: StartCleanup,
        },
        (CleanupInProgress, CleanupFinished) => ShutdownTransition {
            next: ExitAllowed,
            action: None,
        },
        _ => ShutdownTransition {
            next: phase,
            action: None,
        },
    }
}

fn start_cleanup(app: AppHandle) {
    std::thread::spawn(move || {
        if let Some(state) = app.try_state::<AppState>() {
            state.desktop_events.stop();
            let _ = state.manager.stop();
        }
        client_state::flush_and_release(&app);
        apply_event(app.clone(), ShutdownEvent::CleanupFinished);
        app.exit(0);
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

fn request_renderer_flush(app: AppHandle) {
    let generation = RENDERER_FLUSH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(window) = app.get_webview_window("main") else {
        apply_event(app, ShutdownEvent::RendererUnavailable);
        return;
    };

    if let Err(err) = window.emit("client-state:flush-requested", ()) {
        eprintln!("[client-state] failed to request renderer shutdown flush: {err}");
    }

    std::thread::spawn(move || {
        std::thread::sleep(RENDERER_FLUSH_TIMEOUT);
        if RENDERER_FLUSH_GENERATION.load(Ordering::SeqCst) == generation {
            apply_event(app, ShutdownEvent::RendererTimeout);
        }
    });
}

fn apply_event(app: AppHandle, event: ShutdownEvent) {
    loop {
        let current_raw = SHUTDOWN_STATE.load(Ordering::SeqCst);
        let current = ShutdownPhase::from_raw(current_raw);
        let next = transition(current, event);
        if next.next == current {
            return;
        }
        if SHUTDOWN_STATE
            .compare_exchange(
                current_raw,
                next.next as u8,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_err()
        {
            continue;
        }

        match next.action {
            ShutdownAction::RequestRendererFlush => request_renderer_flush(app),
            ShutdownAction::FlushMainWindow => flush_main_window(app),
            ShutdownAction::CloseMainWindow => close_main_window(app),
            ShutdownAction::StartCleanup => start_cleanup(app),
            ShutdownAction::None => {}
        }
        return;
    }
}

pub(crate) fn request(app: AppHandle) {
    let renderer_available = app.get_webview_window("main").is_some();
    apply_event(app, ShutdownEvent::BeginShutdown { renderer_available });
}

pub(crate) fn request_main_window_close(app: AppHandle) {
    apply_event(app, ShutdownEvent::BeginMainWindowClose);
}

pub(crate) fn renderer_flushed(app: AppHandle) {
    apply_event(app, ShutdownEvent::RendererFlushed);
}

pub(crate) fn main_window_destroyed(app: AppHandle) {
    apply_event(app, ShutdownEvent::MainWindowDestroyed);
}

pub(crate) fn main_window_close_allowed() -> bool {
    ShutdownPhase::from_raw(SHUTDOWN_STATE.load(Ordering::SeqCst))
        == ShutdownPhase::MainWindowCloseAllowed
}

pub(crate) fn exit_allowed() -> bool {
    ShutdownPhase::from_raw(SHUTDOWN_STATE.load(Ordering::SeqCst)) == ShutdownPhase::ExitAllowed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_shutdown_waits_for_an_available_renderer() {
        assert_eq!(
            transition(
                ShutdownPhase::Idle,
                ShutdownEvent::BeginShutdown {
                    renderer_available: true,
                },
            ),
            ShutdownTransition {
                next: ShutdownPhase::WaitingForShutdownRenderer,
                action: ShutdownAction::RequestRendererFlush,
            }
        );
    }

    #[test]
    fn shutdown_without_a_renderer_starts_cleanup_directly() {
        assert_eq!(
            transition(
                ShutdownPhase::Idle,
                ShutdownEvent::BeginShutdown {
                    renderer_available: false,
                },
            ),
            ShutdownTransition {
                next: ShutdownPhase::CleanupInProgress,
                action: ShutdownAction::StartCleanup,
            }
        );
    }

    #[test]
    fn close_only_acknowledgement_flushes_and_closes_main_without_cleanup() {
        let waiting = transition(ShutdownPhase::Idle, ShutdownEvent::BeginMainWindowClose);
        assert_eq!(waiting.next, ShutdownPhase::WaitingForMainWindowRenderer);
        assert_eq!(waiting.action, ShutdownAction::RequestRendererFlush);

        for event in [
            ShutdownEvent::RendererFlushed,
            ShutdownEvent::RendererTimeout,
        ] {
            assert_eq!(
                transition(waiting.next, event),
                ShutdownTransition {
                    next: ShutdownPhase::FlushingMainWindow,
                    action: ShutdownAction::FlushMainWindow,
                }
            );
        }

        assert_eq!(
            transition(
                ShutdownPhase::FlushingMainWindow,
                ShutdownEvent::MainWindowFlushed,
            ),
            ShutdownTransition {
                next: ShutdownPhase::MainWindowCloseAllowed,
                action: ShutdownAction::CloseMainWindow,
            }
        );
    }

    #[test]
    fn destroyed_main_resets_close_only_state_for_later_remote_shutdown() {
        let reset = transition(
            ShutdownPhase::MainWindowCloseAllowed,
            ShutdownEvent::MainWindowDestroyed,
        );
        assert_eq!(reset.next, ShutdownPhase::Idle);
        assert_eq!(reset.action, ShutdownAction::None);
        assert_eq!(
            transition(
                reset.next,
                ShutdownEvent::BeginShutdown {
                    renderer_available: false,
                },
            ),
            ShutdownTransition {
                next: ShutdownPhase::CleanupInProgress,
                action: ShutdownAction::StartCleanup,
            }
        );
    }

    #[test]
    fn full_shutdown_upgrades_an_in_progress_close_only_flush() {
        assert_eq!(
            transition(
                ShutdownPhase::WaitingForMainWindowRenderer,
                ShutdownEvent::BeginShutdown {
                    renderer_available: true,
                },
            ),
            ShutdownTransition {
                next: ShutdownPhase::WaitingForShutdownRenderer,
                action: ShutdownAction::None,
            }
        );
        assert_eq!(
            transition(
                ShutdownPhase::FlushingMainWindow,
                ShutdownEvent::BeginShutdown {
                    renderer_available: true,
                },
            ),
            ShutdownTransition {
                next: ShutdownPhase::FlushingMainWindowForShutdown,
                action: ShutdownAction::None,
            }
        );
        assert_eq!(
            transition(
                ShutdownPhase::FlushingMainWindowForShutdown,
                ShutdownEvent::MainWindowFlushed,
            ),
            ShutdownTransition {
                next: ShutdownPhase::CleanupInProgress,
                action: ShutdownAction::StartCleanup,
            }
        );
    }

    #[test]
    fn cleanup_completion_allows_exit_and_cannot_restart_shutdown() {
        let completed = transition(
            ShutdownPhase::CleanupInProgress,
            ShutdownEvent::CleanupFinished,
        );
        assert_eq!(completed.next, ShutdownPhase::ExitAllowed);
        assert_eq!(
            transition(
                completed.next,
                ShutdownEvent::BeginShutdown {
                    renderer_available: true,
                },
            ),
            ShutdownTransition {
                next: ShutdownPhase::ExitAllowed,
                action: ShutdownAction::None,
            }
        );
    }
}
