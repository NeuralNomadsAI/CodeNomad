use super::*;

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
    assert!(coordinator.navigation_allowed());
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
    assert!(coordinator
        .acknowledge_local("local-a", "a", generation)
        .is_some());
    coordinator.begin_shutdown(["local-a".to_string()]).unwrap();
    assert!(!coordinator.commit_local_close("local-a"));
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
    assert!(coordinator.navigation_allowed());
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
