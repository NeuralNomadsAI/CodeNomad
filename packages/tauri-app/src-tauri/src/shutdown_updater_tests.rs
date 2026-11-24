use super::*;
use crate::desktop_updater::PreparedUpdate;
use std::{fs, path::Path};
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

const OWNER_RECORD: &str = ".cross-host-election/primary.owner.json/owner.json";

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
    assert!(!coordinator.begin_cleanup());
    assert!(!coordinator.acknowledge_global(&requests[0].0, requests[0].1));
    assert!(!coordinator.begin_cleanup());
    assert_eq!(installed.load(Ordering::SeqCst), 0);
    // An update gives background windows and queued persistence more time than
    // an ordinary close, but still needs the final matching acknowledgement.
    assert!(UPDATE_RENDERER_FLUSH_TIMEOUT > RENDERER_FLUSH_TIMEOUT);
    assert!(coordinator.acknowledge_global(&requests[1].0, requests[1].1));
    assert!(coordinator.begin_cleanup());
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
            assert!(coordinator.begin_cleanup());
            coordinator.cleanup_failed(|| {});
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

fn state_with_unsynced_root(directory: &Path) -> (client_state::ClientState, Arc<AtomicUsize>) {
    let sync_attempts = Arc::new(AtomicUsize::new(0));
    let check = sync_attempts.clone();
    let state = client_state::ClientState::initialize_at_with_publication_checks(
        directory,
        || Ok(()),
        move || {
            if check.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err("injected directory sync failure".into());
            }
            Ok(())
        },
    )
    .unwrap();
    let request = serde_json::from_value(serde_json::json!({ "section": "speech" })).unwrap();
    let error = state.set_preferences(Some(request)).unwrap_err();
    assert!(error.contains("durability unconfirmed"));
    let root = fs::read_to_string(directory.join("client-state.json")).unwrap();
    assert!(root.contains(r#""section":"speech""#));
    assert_eq!(sync_attempts.load(Ordering::SeqCst), 1);
    (state, sync_attempts)
}

#[test]
fn unreadable_owner_with_unsynced_root_cancels_update_quit_and_reopens_admission() {
    let directory = tempfile::tempdir().unwrap();
    let (state, sync_attempts) = state_with_unsynced_root(directory.path());
    let owner = directory.path().join(OWNER_RECORD);
    let backup = owner.with_extension("backup");
    fs::rename(&owner, &backup).unwrap();
    fs::create_dir(&owner).unwrap();
    assert!(state.can_register_window()); // The local primary lock is still held.
    assert!(!state.is_primary_process());

    let queue = client_state::IpcQueue::new();
    let coordinator = ShutdownCoordinator::default();
    let (update, installed, cancelled) = prepared();
    let requests = coordinator.begin_update(["one".into()], update).unwrap();
    assert!(coordinator.acknowledge_global(&requests[0].0, requests[0].1));
    assert!(coordinator.begin_cleanup());
    assert_eq!(
        coordinator.prepare_client_state_release(&queue, &state),
        Err(requests)
    );
    assert!(coordinator.with_navigation_authority(|| ()).is_some());
    queue.enqueue(Box::new(|| {})).unwrap();
    assert_eq!(installed.load(Ordering::SeqCst), 0);
    assert_eq!(cancelled.load(Ordering::SeqCst), 1);
    assert_eq!(sync_attempts.load(Ordering::SeqCst), 1);

    fs::remove_dir(&owner).unwrap();
    fs::rename(&backup, &owner).unwrap();
    assert!(state.is_primary_process());
    assert!(coordinator.begin_shutdown(Vec::<String>::new()).is_some());
    assert!(coordinator.begin_cleanup());
    coordinator.prepare_client_state_release(&queue, &state).unwrap();
    assert_eq!(sync_attempts.load(Ordering::SeqCst), 2);
    assert!(coordinator.state.lock().unwrap().update.is_none());
}

#[test]
fn missing_owner_with_unsynced_root_allows_quit_without_retrying_the_write() {
    let directory = tempfile::tempdir().unwrap();
    let (state, sync_attempts) = state_with_unsynced_root(directory.path());
    fs::remove_file(directory.path().join(OWNER_RECORD)).unwrap();
    assert!(state.can_register_window()); // The local primary lock is still held.
    assert!(!state.is_primary_process());

    let queue = client_state::IpcQueue::new();
    let coordinator = ShutdownCoordinator::default();
    assert!(coordinator.begin_shutdown(Vec::<String>::new()).is_some());
    assert!(coordinator.begin_cleanup());
    coordinator.prepare_client_state_release(&queue, &state).unwrap();
    assert!(queue.enqueue(Box::new(|| {})).is_err());
    assert_eq!(sync_attempts.load(Ordering::SeqCst), 1);
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
    coordinator.cleanup_failed(|| {});
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
