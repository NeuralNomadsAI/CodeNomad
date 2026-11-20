//! Running as a user service: a graceful stop on Ctrl+C or SIGTERM (systemd's default stop signal).
use tokio_util::sync::CancellationToken;

pub fn stop_on_terminate(stop: CancellationToken) {
    #[cfg(unix)]
    tokio::spawn({
        let stop = stop.clone();
        async move {
            use tokio::signal::unix::{SignalKind, signal};
            if let Ok(mut term) = signal(SignalKind::terminate()) {
                term.recv().await;
                stop.cancel();
            }
        }
    });
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        stop.cancel();
    });
}
