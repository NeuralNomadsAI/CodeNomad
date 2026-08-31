use super::*;
use std::sync::Arc;

#[test]
fn close_generations_are_label_isolated_and_stale_ack_is_ignored() {
    let coordinator = ShutdownCoordinator::default();
    let first = coordinator
        .begin_local_close("local-a".into(), "a".into(), true)
        .unwrap();
    let second = coordinator
        .begin_local_close("local-b".into(), "b".into(), true)
        .unwrap();
    assert!(coordinator
        .acknowledge_local("local-a", "a", second)
        .is_none());
    assert!(coordinator
        .acknowledge_local("local-a", "a", first)
        .is_some());
    assert!(coordinator
        .acknowledge_local("local-b", "b", first)
        .is_none());
    assert!(coordinator
        .acknowledge_local("local-b", "b", second)
        .is_some());
}

#[test]
fn timed_out_local_close_reopens_close_authority() {
    let coordinator = ShutdownCoordinator::default();
    let generation = coordinator
        .begin_local_close("local-a".into(), "a".into(), true)
        .unwrap();

    assert!(coordinator.cancel_local_close("local-a", generation));
    assert!(coordinator
        .begin_local_close("local-a".into(), "a".into(), true)
        .is_some());
}

#[test]
fn final_shutdown_and_cleanup_start_once() {
    let coordinator = ShutdownCoordinator::default();
    let requests = coordinator
        .begin_shutdown(["local-a".to_string(), "local-b".to_string()])
        .unwrap();
    assert!(coordinator.begin_shutdown(std::iter::empty()).is_none());
    assert!(!coordinator.acknowledge_global(&requests[0].0, requests[0].1));
    assert!(coordinator.acknowledge_global(&requests[1].0, requests[1].1));
    assert!(coordinator.begin_cleanup(false));
    assert!(!coordinator.begin_cleanup(false));
    coordinator.cleanup_failed();
    assert!(!coordinator.shutdown_started());
    assert!(coordinator.with_navigation_authority(|| ()).is_some());
    assert!(coordinator.begin_shutdown(std::iter::empty()).is_some());
    assert!(coordinator.begin_cleanup(false));
}

#[test]
fn failed_shutdown_paths_emit_the_renderer_resume_event() {
    let source = include_str!("shutdown.rs");
    assert_eq!(FLUSH_CANCELLED_EVENT, "client-state:flush-cancelled");
    assert!(source.contains("RendererFlushRequest { generation }"));
    assert!(source.contains("emit_flush_cancellations(&app, cancellations)"));
}

#[test]
fn global_shutdown_wins_an_uncommitted_local_close() {
    let coordinator = ShutdownCoordinator::default();
    let generation = coordinator
        .begin_local_close("local-a".into(), "a".into(), true)
        .unwrap();
    let pending = coordinator
        .acknowledge_local("local-a", "a", generation)
        .unwrap();
    coordinator.begin_shutdown(["local-a".to_string()]).unwrap();
    assert!(!coordinator.commit_local_close("local-a".into(), pending));
}

#[test]
fn committed_local_close_retains_exact_authority_until_consumed() {
    let coordinator = ShutdownCoordinator::default();
    let generation = coordinator
        .begin_local_close("local-a".into(), "window-a".into(), true)
        .unwrap();
    let pending = coordinator
        .acknowledge_local("local-a", "window-a", generation)
        .unwrap();

    assert!(coordinator.commit_local_close("local-a".into(), pending.clone()));
    assert_eq!(
        coordinator.take_committed_local_close("local-a"),
        Some(pending)
    );
    assert!(coordinator.take_committed_local_close("local-a").is_none());
}

#[test]
fn local_close_dispatch_rollback_reopens_close_authority() {
    let coordinator = ShutdownCoordinator::default();
    let generation = coordinator
        .begin_local_close("local-a".into(), "window-a".into(), true)
        .unwrap();
    let pending = coordinator
        .acknowledge_local("local-a", "window-a", generation)
        .unwrap();
    assert!(coordinator.commit_local_close("local-a".into(), pending));

    coordinator.rollback_local_close("local-a");

    assert!(coordinator.take_committed_local_close("local-a").is_none());
    assert!(coordinator
        .begin_local_close("local-a".into(), "window-a".into(), true)
        .is_some());
}

#[test]
fn navigation_authority_blocks_shutdown_start_until_dispatch_returns() {
    let coordinator = Arc::new(ShutdownCoordinator::default());
    let guarded = Arc::clone(&coordinator);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let navigation = std::thread::spawn(move || {
        guarded.with_navigation_authority(|| {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        })
    });
    entered_rx.recv().unwrap();

    let shutting_down = Arc::clone(&coordinator);
    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel();
    let shutdown = std::thread::spawn(move || {
        let started = shutting_down.begin_shutdown(std::iter::empty()).is_some();
        shutdown_tx.send(started).unwrap();
    });
    assert!(shutdown_rx.recv_timeout(Duration::from_millis(20)).is_err());

    release_tx.send(()).unwrap();
    assert!(navigation.join().unwrap().is_some());
    assert!(shutdown_rx.recv_timeout(Duration::from_secs(1)).unwrap());
    shutdown.join().unwrap();
}

#[test]
fn shutdown_start_rejects_navigation_dispatch() {
    let coordinator = ShutdownCoordinator::default();
    coordinator.begin_shutdown(std::iter::empty()).unwrap();
    let dispatched = std::sync::atomic::AtomicBool::new(false);

    assert!(coordinator
        .with_navigation_authority(|| dispatched.store(true, std::sync::atomic::Ordering::SeqCst))
        .is_none());
    assert!(!dispatched.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn bounded_retry_stops_after_success() {
    let mut calls = 0;
    retry_bounded(2, || {
        calls += 1;
        if calls == 1 {
            Err("retry")
        } else {
            Ok(())
        }
    })
    .unwrap();
    assert_eq!(calls, 2);
}

#[test]
fn failed_global_shutdown_cancels_the_exact_renderer_generations() {
    let coordinator = ShutdownCoordinator::default();
    let mut requests = coordinator
        .begin_shutdown(["local-a".to_string(), "local-b".to_string()])
        .unwrap();
    for (label, generation) in &requests {
        coordinator.acknowledge_global(label, *generation);
    }
    assert!(coordinator.begin_cleanup(false));

    let mut cancellations = coordinator.cleanup_failed();
    requests.sort();
    cancellations.sort();
    assert_eq!(cancellations, requests);
}

#[test]
fn timed_out_global_shutdown_reopens_navigation_authority() {
    let coordinator = ShutdownCoordinator::default();
    let mut requests = coordinator
        .begin_shutdown(["local-a".to_string(), "local-b".to_string()])
        .unwrap();

    let PendingShutdownTimeoutAction::Cancel(mut cancellations) =
        coordinator.expire_pending_shutdown()
    else {
        panic!("ordinary shutdown timeout should cancel");
    };
    requests.sort();
    cancellations.sort();
    assert_eq!(cancellations, requests);
    assert!(!coordinator.shutdown_started());
    assert!(coordinator.with_navigation_authority(|| ()).is_some());
}

#[cfg(windows)]
#[test]
fn windows_session_end_promotes_an_ordinary_shutdown_timeout_to_cleanup() {
    let coordinator = ShutdownCoordinator::default();
    coordinator.begin_shutdown(["local-a".to_string()]).unwrap();
    coordinator.begin_windows_session_end(["local-a".to_string()]);

    assert!(matches!(
        coordinator.expire_pending_shutdown(),
        PendingShutdownTimeoutAction::Cleanup
    ));
    assert!(coordinator.begin_cleanup(true));
}

#[cfg(windows)]
#[test]
fn windows_session_end_defers_native_cleanup_until_renderer_flush_finishes() {
    let coordinator = ShutdownCoordinator::default();
    let preparation = coordinator.begin_windows_session_end(["local-a".to_string()]);
    let generation = preparation.generation;
    let requests = preparation.requests.unwrap();

    assert!(!coordinator.begin_cleanup(false));
    assert!(coordinator.windows_renderer_wait(generation).unwrap().0);
    assert!(coordinator.acknowledge_global(&requests[0].0, requests[0].1));
    assert!(!coordinator.windows_renderer_wait(generation).unwrap().0);
    assert!(!coordinator.windows_native_flush_complete(generation));
    coordinator.complete_windows_native_flush(generation);
    assert!(coordinator.windows_native_flush_complete(generation));
    assert!(coordinator.begin_windows_cleanup(generation));
    assert!(!coordinator.begin_windows_cleanup(generation));
}

#[cfg(windows)]
#[test]
fn cancelled_windows_session_end_reopens_renderer_persistence() {
    let coordinator = ShutdownCoordinator::default();
    coordinator.begin_windows_session_end(["local-a".to_string()]);

    assert_eq!(coordinator.cancel_windows_session_end().len(), 1);
    assert!(!coordinator.shutdown_started());
    assert!(coordinator.with_navigation_authority(|| ()).is_some());
    assert!(coordinator.begin_shutdown(std::iter::empty()).is_some());
}

#[cfg(windows)]
#[test]
fn multi_window_session_end_prepare_reuses_generation_deadline_and_requests() {
    let coordinator = ShutdownCoordinator::default();
    let first =
        coordinator.begin_windows_session_end(["local-a".to_string(), "local-b".to_string()]);
    let second = coordinator.begin_windows_session_end(["local-c".to_string()]);

    assert_eq!(first.requests.as_ref().unwrap().len(), 2);
    assert_eq!(second.generation, first.generation);
    assert_eq!(second.deadline, first.deadline);
    assert!(second.requests.is_none());
}

#[cfg(windows)]
#[test]
fn repeated_session_end_calls_share_timeout_and_cleanup_claim() {
    let coordinator = ShutdownCoordinator::default();
    let preparation = coordinator.begin_windows_session_end(std::iter::empty());
    let generation = preparation.generation;

    assert_eq!(
        coordinator.windows_session_end_remaining(generation, preparation.deadline),
        Some(Duration::ZERO)
    );
    coordinator.complete_windows_native_flush(generation);
    assert!(coordinator.begin_windows_cleanup(generation));
    assert!(!coordinator.begin_windows_cleanup(generation));
    assert_eq!(
        coordinator.windows_session_end_remaining(
            generation,
            preparation.deadline + Duration::from_secs(1)
        ),
        Some(Duration::ZERO)
    );
}

#[cfg(windows)]
#[test]
fn cancelled_session_worker_cannot_complete_a_new_session_flush() {
    let coordinator = ShutdownCoordinator::default();
    let first = coordinator
        .begin_windows_session_end(["local-a".to_string()])
        .generation;
    coordinator.cancel_windows_session_end();
    let second = coordinator
        .begin_windows_session_end(["local-a".to_string()])
        .generation;

    coordinator.complete_windows_native_flush(first);
    assert!(!coordinator.windows_native_flush_complete(second));
    coordinator.complete_windows_native_flush(second);
    assert!(coordinator.windows_native_flush_complete(second));
}
