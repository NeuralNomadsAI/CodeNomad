use super::*;
use std::sync::Arc;

fn admit_close(coordinator: &ShutdownCoordinator, label: &str, removes_state: bool) -> u64 {
    let generation = coordinator.begin_local_close(label.into(), "a".into(), removes_state, || vec!["other".into()]).unwrap();
    coordinator.acknowledge_local(label, "a", generation).unwrap();
    assert!(coordinator.admit_local_removal(label, generation).is_some());
    generation
}

fn release_close(coordinator: &ShutdownCoordinator, label: &str, generation: u64) -> client_state::RendererFlushRequest {
    let LocalCloseCompletion::Release { request, .. } =
        coordinator.complete_local_removal(label, generation, Ok(()))
    else {
        panic!("successful removal should release");
    };
    request
}

#[test]
fn close_generations_are_label_isolated_and_stale_ack_is_ignored() {
    let coordinator = ShutdownCoordinator::default();
    let first = coordinator
        .begin_local_close("local-a".into(), "a".into(), false, Vec::new)
        .unwrap();
    let second = coordinator
        .begin_local_close("local-b".into(), "b".into(), false, Vec::new)
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
        .begin_local_close("local-a".into(), "a".into(), false, Vec::new)
        .unwrap();

    assert!(coordinator.cancel_local_close("local-a", generation));
    assert!(coordinator
        .begin_local_close("local-a".into(), "a".into(), false, Vec::new)
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
    assert!(coordinator.begin_cleanup());
    assert!(!coordinator.begin_cleanup());
    coordinator.cleanup_failed(|| {});
    assert!(!coordinator.shutdown_started());
    assert!(coordinator.with_navigation_authority(|| ()).is_some());
    assert!(coordinator.begin_shutdown(std::iter::empty()).is_some());
    assert!(coordinator.begin_cleanup());
}

#[test]
fn restart_waits_for_cleanup_and_is_cancelled_when_cleanup_fails() {
    let coordinator = ShutdownCoordinator::default();
    coordinator.request_restart();
    coordinator.begin_shutdown(std::iter::empty()).unwrap();
    assert!(coordinator.begin_cleanup());
    assert!(coordinator.complete_cleanup());

    let coordinator = ShutdownCoordinator::default();
    coordinator.request_restart();
    coordinator.begin_shutdown(std::iter::empty()).unwrap();
    assert!(coordinator.begin_cleanup());
    coordinator.cleanup_failed(|| {});
    assert!(!coordinator.complete_cleanup());
}

#[test]
fn developer_restart_keeps_the_scoped_plan_through_graceful_shutdown() {
    let coordinator = ShutdownCoordinator::default();
    let label = "local-a";
    let fence = restart_fence(|| true);
    let generation = coordinator
        .reserve_automation_restart(label, &fence)
        .unwrap();
    let requests = coordinator
        .begin_automation_restart(
            [label.into()],
            label,
            generation,
            developer_restart_plan(),
            &fence,
        )
        .unwrap();
    coordinator.request_restart();
    assert!(coordinator.acknowledge_global(label, requests[0].1));
    assert!(coordinator.begin_cleanup());
    assert!(!coordinator.complete_cleanup(), "the generic restart must not run");
    assert_eq!(
        coordinator.state.lock().unwrap().automation_restart.as_ref()
            .unwrap().handoff.profile,
        "dev"
    );
}

fn restart_fence(current: impl Fn() -> bool + Send + Sync + 'static) -> RequestFence {
    let deadline = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        + Duration::from_secs(30);
    RequestFence::new(deadline.as_millis() as u64, current)
}

#[test]
fn developer_restart_checks_the_fence_after_reading_native_windows() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let coordinator = ShutdownCoordinator::default();
    let label = "local-a";
    let current = Arc::new(AtomicBool::new(true));
    let backend = Arc::clone(&current);
    let fence = restart_fence(move || backend.load(Ordering::SeqCst));
    let read_windows = || {
        current.store(false, Ordering::SeqCst);
        [label.into()]
    };

    let generation = coordinator
        .reserve_automation_restart(label, &fence)
        .unwrap();
    fence.check().unwrap();
    assert!(coordinator
        .begin_automation_restart(
            read_windows(),
            label,
            generation,
            developer_restart_plan(),
            &fence,
        )
        .is_none());
    let state = coordinator.state.lock().unwrap();
    assert!(!state.shutdown_started && state.automation_restart.is_none());
    assert!(state.pending_automation_restart.is_none());
    drop(state);
    assert!(coordinator.reserve_automation_restart(label, &fence).is_err());
}

fn developer_restart_plan() -> crate::developer_relaunch::RelaunchPlan {
    use crate::developer_relaunch::{DeveloperRestart, Handoff, RelaunchPlan};

    RelaunchPlan {
        executable: "codenomad.exe".into(),
        handoff: Handoff {
            restart: DeveloperRestart {
                run_id: "old".into(),
                native_identity: "tauri:test".into(),
                window_id: "a".into(),
                window_instance: Some("incarnation".into()),
                restart_id: "7c3e5066-017d-4ce1-a371-187ac459c4b2".into(),
            },
            profile: "dev".into(),
            pinned: true,
            config: None,
        },
    }
}

#[cfg(windows)]
#[test]
fn windows_query_and_cancel_revoke_unarmed_developer_restart() {
    let coordinator = ShutdownCoordinator::default();
    let label = "local-a";
    let fence = restart_fence(|| true);
    let old = coordinator
        .reserve_automation_restart(label, &fence)
        .unwrap();
    coordinator.begin_windows_session_end([label.into()]);
    assert!(coordinator.reserve_automation_restart(label, &fence).is_err());
    coordinator.cancel_windows_session_end();
    let fresh = coordinator
        .reserve_automation_restart(label, &fence)
        .unwrap();
    let arm = |generation| {
        coordinator.begin_automation_restart(
            [label.into()],
            label,
            generation,
            developer_restart_plan(),
            &fence,
        )
    };
    assert!(arm(old).is_none(), "a delayed restart admitted before query is revoked");
    coordinator.cancel_automation_restart(old);
    assert!(coordinator.reserve_automation_restart(label, &fence).is_err());
    assert!(arm(fresh).is_some());
    coordinator.begin_windows_session_end([label.into()]);
    coordinator.cancel_windows_session_end();
    assert!(coordinator.state.lock().unwrap().automation_restart.is_none());
}

#[test]
fn failed_shutdown_paths_emit_the_renderer_resume_event() {
    let source = include_str!("shutdown.rs");
    assert_eq!(FLUSH_CANCELLED_EVENT, "client-state:flush-cancelled");
    assert!(source.contains("emit_prepare(&app, &label, generation)"));
    assert!(source.contains("emit_flush_cancellations(&app, cancellations)"));
}

#[test]
fn global_shutdown_wins_an_uncommitted_local_close() {
    let coordinator = ShutdownCoordinator::default();
    let generation = coordinator
        .begin_local_close("local-a".into(), "a".into(), false, Vec::new)
        .unwrap();
    coordinator
        .acknowledge_local("local-a", "a", generation)
        .unwrap();
    coordinator.begin_shutdown(["local-a".to_string()]).unwrap();
    assert!(coordinator.admit_local_removal("local-a", generation).is_none());
}

#[test]
fn acknowledged_local_close_retains_exact_authority_until_removal() {
    let coordinator = ShutdownCoordinator::default();
    let generation = coordinator
        .begin_local_close("local-a".into(), "window-a".into(), true, || vec!["local-other".into()])
        .unwrap();
    coordinator.acknowledge_local("local-a", "window-a", generation).unwrap();
    assert!(coordinator.admit_local_removal("local-a", generation + 1).is_none());
    assert_eq!(
        coordinator.admit_local_removal("local-a", generation),
        Some(PendingClose { window_id: "window-a".into(), generation, removes_state: true })
    );
    assert!(coordinator.admit_local_removal("local-a", generation).is_none());
}

#[test]
fn pending_and_approved_local_closes_remain_visible_to_final_window_decisions() {
    let coordinator = ShutdownCoordinator::default();
    let generation = coordinator
        .begin_local_close("local-a".into(), "window-a".into(), false, Vec::new)
        .unwrap();
    assert_eq!(coordinator.local_close_status("local-a"), Some(false));
    coordinator
        .acknowledge_local("local-a", "window-a", generation)
        .unwrap();
    assert_eq!(coordinator.local_close_status("local-a"), Some(false));
    coordinator.admit_local_removal("local-a", generation).unwrap();
    assert_eq!(coordinator.local_close_status("local-a"), Some(false));
    let release = release_close(&coordinator, "local-a", generation);
    assert_eq!(release.prepare_generation, Some(generation));
    assert_eq!(coordinator.local_close_status("local-a"), Some(false));
    assert!(!coordinator.finish_local_release("local-a", generation));
    assert!(coordinator.finish_local_release("local-a", release.generation));
    assert_eq!(coordinator.local_close_status("local-a"), Some(true));
    coordinator.local_window_destroyed("local-a");
    assert_eq!(coordinator.local_close_status("local-a"), None);
}

#[test]
fn refused_close_never_gains_workspace_release_authority() {
    let coordinator = ShutdownCoordinator::default();
    let generation = admit_close(&coordinator, "local-a", true);
    assert!(matches!(
        coordinator.complete_local_removal("local-a", generation, Err("refused".into())),
        LocalCloseCompletion::Refused { deferred_prepare: None, .. }
    ));
    assert!(!coordinator.finish_local_release("local-a", 1));
    assert!(coordinator.begin_local_close("local-a".into(), "a".into(), false, Vec::new).is_some());
}

#[test]
fn pages_without_the_application_never_hold_a_close_or_quit() {
    // A local window stuck on the sign-in page could neither close nor let CodeNomad quit.
    for url in [
        "about:blank",
        "http://127.0.0.1:9898/login",
        "http://127.0.0.1:9898/remote-pair",
        "http://127.0.0.1:9898/auth/token",
        "tauri://localhost/loading.html",
    ] {
        assert!(
            !awaits_renderer_flush(Some(&tauri::Url::parse(url).unwrap())),
            "{url}"
        );
    }
    for url in [
        "http://127.0.0.1:9898/",
        "http://127.0.0.1:9898/workspaces/a",
    ] {
        assert!(
            awaits_renderer_flush(Some(&tauri::Url::parse(url).unwrap())),
            "{url}"
        );
    }
    assert!(awaits_renderer_flush(None));
}

#[test]
fn the_last_user_window_keeps_its_state_while_another_close_is_capturing() {
    let coordinator = ShutdownCoordinator::default();
    let labels = || vec!["local-a".into(), "local-b".into()];
    let first = coordinator
        .begin_local_close("local-a".into(), "window-a".into(), true, labels)
        .unwrap();
    coordinator.acknowledge_local("local-a", "window-a", first).unwrap();
    let last = coordinator
        .begin_local_close("local-b".into(), "window-b".into(), true, labels)
        .unwrap();
    coordinator.acknowledge_local("local-b", "window-b", last).unwrap();
    assert!(coordinator.admit_local_removal("local-a", first).unwrap().removes_state);
    assert!(!coordinator.admit_local_removal("local-b", last).unwrap().removes_state);
}

#[test]
fn stale_capture_cannot_remove_a_reopened_close_after_cancelled_quit() {
    let coordinator = ShutdownCoordinator::default();
    let generation = coordinator
        .begin_local_close("local-a".into(), "window-a".into(), false, Vec::new)
        .unwrap();
    coordinator
        .acknowledge_local("local-a", "window-a", generation)
        .unwrap();
    let requests = coordinator.begin_shutdown(["local-a".into()]).unwrap();
    coordinator.expire_pending_shutdown(&requests);
    let fresh = coordinator.begin_local_close("local-a".into(), "window-a".into(), false, Vec::new).unwrap();
    coordinator.acknowledge_local("local-a", "window-a", fresh).unwrap();
    assert!(coordinator.admit_local_removal("local-a", generation).is_none());
    assert!(coordinator.admit_local_removal("local-a", fresh).is_some());
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
    assert!(coordinator.begin_cleanup());

    let mut cancellations = coordinator.cleanup_failed(|| {});
    requests.sort();
    cancellations.sort();
    assert_eq!(cancellations, requests);
}

#[test]
fn shutdown_release_has_its_own_bounded_wait_after_persistence() {
    let coordinator = ShutdownCoordinator::default();
    let closing = admit_close(&coordinator, "local-closing", true);
    let closing = release_close(&coordinator, "local-closing", closing);
    let requests = coordinator.begin_shutdown(["local-a".into(), "remote-b".into(), "local-closing".into()]).unwrap();
    assert_eq!(requests.len(), 2, "the already approved close must not preflush a forgotten record");
    assert!(coordinator.finish_local_release("local-closing", closing.generation));
    for (label, generation) in &requests {
        coordinator.acknowledge_global(label, *generation);
    }
    assert!(coordinator.begin_cleanup());
    let releases = coordinator.begin_workspace_releases();
    assert_eq!(releases.len(), 2);
    for (label, generation) in &requests {
        let release = releases.iter().find(|(target, _)| target == label).unwrap().1;
        assert_eq!(release.prepare_generation, Some(*generation));
        assert_ne!(release.generation, *generation);
        assert!(!coordinator.acknowledge_global(label, *generation));
    }
    assert!(!coordinator.acknowledge_global(&releases[0].0, releases[0].1.generation));
    coordinator.wait_for_workspace_releases(Duration::ZERO);
    assert!(coordinator.shutdown_started());
    assert!(coordinator.acknowledge_global(&releases[1].0, releases[1].1.generation));
}

#[test]
fn shutdown_joins_an_in_flight_local_release_without_requesting_it_again() {
    let coordinator = ShutdownCoordinator::default();
    let label = "local-closing";
    let closing = admit_close(&coordinator, label, true);
    let release = release_close(&coordinator, label, closing);
    assert!(coordinator.begin_shutdown([label.into()]).unwrap().is_empty());
    assert!(coordinator.begin_cleanup());
    assert!(coordinator.begin_workspace_releases().is_empty());
    assert!(!coordinator.wait_for_workspace_releases(Duration::ZERO));
    assert!(!coordinator.finish_local_release(label, release.prepare_generation.unwrap()));
    assert!(!coordinator.wait_for_workspace_releases(Duration::ZERO));
    assert!(coordinator.finish_local_release(label, release.generation));
    assert!(coordinator.wait_for_workspace_releases(Duration::ZERO));
}

#[test]
fn quit_defers_only_the_removing_window_without_blocking_admission() {
    for refused in [false, true] {
        let coordinator = ShutdownCoordinator::default();
        let label = "local-closing";
        let closing = admit_close(&coordinator, label, true);
        let requests = coordinator.begin_shutdown([label.into(), "local-other".into()]).unwrap();
        assert!(!coordinator.admit_global_prepare(label, requests[0].1));
        assert!(coordinator.admit_global_prepare("local-other", requests[1].1));
        assert!(!coordinator.acknowledge_global("local-other", requests[1].1));
        assert!(!coordinator.begin_cleanup());
        if refused {
            let result = coordinator.complete_local_removal(label, closing, Err("refused".into()));
            assert!(matches!(result, LocalCloseCompletion::Refused {
                deferred_prepare: Some(generation), ..
            } if generation == requests[0].1));
            assert!(coordinator.admit_global_prepare(label, requests[0].1));
            assert!(coordinator.acknowledge_global(label, requests[0].1));
            assert!(coordinator.begin_cleanup());
            assert_eq!(coordinator.begin_workspace_releases().len(), 2);
        } else {
            let result = coordinator.complete_local_removal(label, closing, Ok(()));
            assert!(matches!(result, LocalCloseCompletion::Release { shutdown_ready: true, .. }));
            assert!(!coordinator.admit_global_prepare(label, requests[0].1));
            assert!(coordinator.begin_cleanup());
            let releases = coordinator.begin_workspace_releases();
            assert_eq!(releases.len(), 1);
            assert_eq!(releases[0].0, "local-other");
        }
    }
}

#[test]
fn quit_can_still_cancel_after_a_removing_window_joins_release() {
    let coordinator = ShutdownCoordinator::default();
    let label = "local-closing";
    let closing = admit_close(&coordinator, label, true);
    let requests = coordinator.begin_shutdown([label.into(), "local-other".into()]).unwrap();
    assert!(!coordinator.admit_global_prepare(label, requests[0].1));
    release_close(&coordinator, label, closing);

    let cancellations = coordinator.expire_pending_shutdown(&requests);
    assert_eq!(cancellations, vec![requests[1].clone()]);
    assert!(!coordinator.shutdown_started());
}

#[test]
fn timed_out_global_shutdown_reopens_navigation_authority() {
    let coordinator = ShutdownCoordinator::default();
    let mut requests = coordinator
        .begin_shutdown(["local-a".to_string(), "local-b".to_string()])
        .unwrap();

    let mut cancellations = coordinator.expire_pending_shutdown(&requests);
    requests.sort();
    cancellations.sort();
    assert_eq!(cancellations, requests);
    assert!(!coordinator.shutdown_started());
    assert!(coordinator.with_navigation_authority(|| ()).is_some());
}

#[cfg(windows)]
#[test]
fn confirmed_session_end_takes_over_quit_already_in_native_preflight() {
    let coordinator = ShutdownCoordinator::default();
    coordinator.begin_shutdown(std::iter::empty()).unwrap();
    assert!(coordinator.begin_cleanup());
    assert!(coordinator.begin_windows_session_end(["local-a".to_string()]).is_none());
    let (deadline, start) = coordinator.confirm_windows_session_end();
    assert!(start);
    assert_eq!(coordinator.confirm_windows_session_end(), (deadline, false));
    assert!(coordinator.cleanup_failed(|| panic!("must not reopen admission")).is_empty());
    assert!(!coordinator.wait_for_windows_cleanup(Instant::now()));
    coordinator.complete_cleanup();
    assert!(coordinator.wait_for_windows_cleanup(Instant::now()));
}

#[cfg(windows)]
#[test]
fn windows_session_end_keeps_normal_quit_from_claiming_cleanup() {
    let coordinator = ShutdownCoordinator::default();
    let requests = coordinator.begin_windows_session_end(["local-a".to_string()]).unwrap();

    assert!(!coordinator.begin_cleanup());
    assert!(coordinator.acknowledge_global(&requests[0].0, requests[0].1));
    assert!(!coordinator.begin_cleanup());
    let (deadline, start) = coordinator.confirm_windows_session_end();
    assert!(start);
    assert_eq!(coordinator.confirm_windows_session_end(), (deadline, false));
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
fn multi_window_session_end_only_prepares_once() {
    let coordinator = ShutdownCoordinator::default();
    let first =
        coordinator.begin_windows_session_end(["local-a".to_string(), "local-b".to_string()]);
    let second = coordinator.begin_windows_session_end(["local-c".to_string()]);

    assert_eq!(first.unwrap().len(), 2);
    assert!(second.is_none());
}

#[cfg(windows)]
#[test]
fn confirmed_session_end_needs_no_query_or_renderer_acknowledgement() {
    let coordinator = ShutdownCoordinator::default();
    let requests = coordinator.begin_shutdown(["local-a".into()]).unwrap();
    let (deadline, first) = coordinator.confirm_windows_session_end();
    assert!(first);
    assert_eq!(coordinator.confirm_windows_session_end(), (deadline, false));
    assert!(!coordinator.acknowledge_global(&requests[0].0, requests[0].1));
}

#[cfg(windows)]
#[test]
fn session_end_stops_backend_after_failed_or_blocked_persistence() {
    let deadline = Instant::now() + WINDOWS_SESSION_END_STOP_RESERVE + Duration::from_secs(1);
    assert!(!windows_session_end_cleanup(deadline, |_| false, |until| {
        assert_eq!(until, deadline);
        assert!(Instant::now() < until);
    }));
    let (unblock, blocked) = std::sync::mpsc::channel::<()>();
    let deadline = Instant::now() + WINDOWS_SESSION_END_STOP_RESERVE + Duration::from_millis(30);
    assert!(!windows_session_end_cleanup(deadline, move |_| {
        blocked.recv().unwrap();
        true
    }, |until| {
        assert_eq!(until, deadline);
        assert!(Instant::now() < until);
        unblock.send(()).unwrap();
    }));
}
