//! Running as a user service: a graceful stop on Ctrl+C or SIGTERM (systemd's default stop signal).
use tokio_util::sync::CancellationToken;

/// A signal during a stop already under way, from stdin or a first signal, exits 1 at once
/// (`createServerShutdownHandler`).
pub fn stop_on_terminate(stop: CancellationToken) {
    let trigger = |stop: &CancellationToken| {
        if stop.is_cancelled() {
            std::process::exit(1);
        }
        stop.cancel();
    };
    #[cfg(unix)]
    tokio::spawn({
        let stop = stop.clone();
        async move {
            use tokio::signal::unix::{SignalKind, signal};
            if let Ok(mut term) = signal(SignalKind::terminate()) {
                while term.recv().await.is_some() {
                    trigger(&stop);
                }
            }
        }
    });
    tokio::spawn(async move {
        while tokio::signal::ctrl_c().await.is_ok() {
            trigger(&stop);
        }
    });
}
