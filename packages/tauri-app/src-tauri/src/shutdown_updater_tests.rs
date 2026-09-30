use super::*;
use crate::desktop_updater::PreparedUpdate;
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

fn prepared() -> (PreparedUpdate, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let installed = Arc::new(AtomicUsize::new(0));
    let cancelled = Arc::new(AtomicUsize::new(0));
    let install = installed.clone();
    let cancel = cancelled.clone();
    (PreparedUpdate::new(
        move || { install.fetch_add(1, Ordering::SeqCst); Ok(()) },
        move || { cancel.fetch_add(1, Ordering::SeqCst); },
    ), installed, cancelled)
}

#[test]
fn update_claim_includes_restart_and_waits_for_every_renderer() {
    let coordinator = ShutdownCoordinator::default();
    let (update, installed, cancelled) = prepared();
    let requests = coordinator.begin_update(["one".into(), "two".into()], update).unwrap();
    assert!(coordinator.state.lock().unwrap().restart_requested);
    assert!(coordinator.with_navigation_authority(|| ()).is_none());
    assert!(!coordinator.begin_cleanup(false));
    assert!(!coordinator.acknowledge_global(&requests[0].0, requests[0].1));
    assert!(!coordinator.begin_cleanup(false));
    assert_eq!(installed.load(Ordering::SeqCst), 0);
    assert!(coordinator.acknowledge_global(&requests[1].0, requests[1].1));
    assert!(coordinator.begin_cleanup(false));
    let update = coordinator.state.lock().unwrap().update.take().unwrap();
    update.install().unwrap();
    assert!(coordinator.complete_cleanup());
    assert_eq!(installed.load(Ordering::SeqCst), 1);
    assert_eq!(cancelled.load(Ordering::SeqCst), 0);
}

#[test]
fn timeout_and_failed_cleanup_discard_installer_and_permit_a_fresh_check() {
    for timeout in [true, false] {
        let coordinator = ShutdownCoordinator::default();
        let (update, installed, cancelled) = prepared();
        let requests = coordinator.begin_update(["one".into()], update).unwrap();
        if timeout {
            coordinator.expire_pending_shutdown(&requests);
        } else {
            coordinator.acknowledge_global(&requests[0].0, requests[0].1);
            assert!(coordinator.begin_cleanup(false));
            coordinator.cleanup_failed();
        }
        assert!(coordinator.with_navigation_authority(|| ()).is_some());
        assert!(coordinator.state.lock().unwrap().update.is_none());
        assert!(!coordinator.state.lock().unwrap().restart_requested);
        assert_eq!(installed.load(Ordering::SeqCst), 0);
        assert_eq!(cancelled.load(Ordering::SeqCst), 1);
        assert!(!coordinator.acknowledge_global(&requests[0].0, requests[0].1));
        assert!(coordinator.begin_shutdown(["one".into()]).is_some());
        assert!(coordinator.state.lock().unwrap().update.is_none());
    }
}

#[test]
fn an_existing_quit_cannot_be_converted_to_an_update() {
    let coordinator = ShutdownCoordinator::default();
    coordinator.begin_shutdown(["one".into()]).unwrap();
    let (update, installed, cancelled) = prepared();
    assert!(coordinator.begin_update(["one".into()], update).is_none());
    assert!(!coordinator.state.lock().unwrap().restart_requested);
    assert_eq!(installed.load(Ordering::SeqCst), 0);
    assert_eq!(cancelled.load(Ordering::SeqCst), 0, "admission failure is returned to the caller");
}

#[test]
fn a_failed_attempts_timeout_cannot_cancel_a_new_update() {
    let coordinator = ShutdownCoordinator::default();
    let old_requests = coordinator.begin_shutdown(["one".into()]).unwrap();
    coordinator.cleanup_failed();
    let (update, installed, cancelled) = prepared();
    let requests = coordinator.begin_update(["one".into()], update).unwrap();
    coordinator.expire_pending_shutdown(&old_requests);
    assert!(coordinator.state.lock().unwrap().update.is_some());
    assert_eq!(cancelled.load(Ordering::SeqCst), 0);
    coordinator.expire_pending_shutdown(&requests);
    assert!(coordinator.state.lock().unwrap().update.is_none());
    assert_eq!(cancelled.load(Ordering::SeqCst), 1);
    assert_eq!(installed.load(Ordering::SeqCst), 0);
}

#[cfg(windows)]
#[test]
fn windows_logout_discards_a_waiting_update_without_restarting() {
    let coordinator = ShutdownCoordinator::default();
    let (update, installed, cancelled) = prepared();
    coordinator.begin_update(["one".into()], update).unwrap();
    coordinator.begin_windows_session_end(["one".into()]);
    assert!(coordinator.state.lock().unwrap().update.is_none());
    assert!(!coordinator.state.lock().unwrap().restart_requested);
    assert_eq!(installed.load(Ordering::SeqCst), 0);
    assert_eq!(cancelled.load(Ordering::SeqCst), 1);
}
