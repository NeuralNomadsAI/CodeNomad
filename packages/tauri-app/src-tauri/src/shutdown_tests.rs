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
    assert!(source.matches("emit_flush_cancelled(&app, &label)").count() >= 2);
    assert!(source.contains("emit_all(&app, FLUSH_CANCELLED_EVENT"));
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
