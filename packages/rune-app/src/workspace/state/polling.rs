//! Workspace persistence, background tabs and active-panel updates.
#[cfg(target_arch = "wasm32")]
use super::platform;
use super::{
    State, Tx, blank_cleanup, catalogue, idle_markers, observation::poll_cached, panel_state,
    resume,
};

pub fn poll(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let Some(mut ui) = s.workspace.take() else {
        return false;
    };
    ui.clock = now;
    let loading = ui.persistence.loading;
    if let Some((saved, drafts)) = ui.persistence.poll_load() {
        ui.persistence.file_draft_read_error = match drafts {
            Ok(Some(bytes)) => !s.documents.hydrate_file_drafts(&bytes),
            Ok(None) => false,
            Err(_) => true,
        };
        s.documents
            .block_file_draft_updates(ui.persistence.file_draft_read_error);
        if let Some(saved) = saved {
            ui.hydrate(saved);
            s.shell.restore_widths(ui.panel_widths);
            s.shell.file_wrap = ui.file_wrap.unwrap_or(false);
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    let booting = s
        .screen
        .launcher()
        .is_some_and(crate::launcher::Launcher::booting);
    #[cfg(target_arch = "wasm32")]
    let booting = false;
    let became_ready = loading && !ui.persistence.loading;
    if ui.persistence.restore_enabled
        && !ui.persistence.mutating
        && let Some(store) = &ui.persistence.store
    {
        s.saved_outlines.poll(store, s.wake.clone());
    }
    if became_ready && !booting {
        ui.ready = true;
        #[cfg(target_arch = "wasm32")]
        if let Some(wrap) = platform::storage::browser_file_wrap() {
            s.shell.file_wrap = wrap;
        }
    }
    let mut changed = ui.persistence.poll_file_draft_retry(&s.documents);
    #[cfg(target_arch = "wasm32")]
    platform::pairing::set_defer_checks(s, true);
    let (cached_changed, deleted_by_tab) = poll_cached(s, &mut ui, Some(now), tx);
    changed |= cached_changed;
    changed |= blank_cleanup::poll(s, &mut ui, tx);
    changed |= idle_markers::poll(s, &mut ui, now, tx);
    changed |= crate::timeline::sync_outline_mutation(s);
    let (missions_changed, mission_auth_expired) = panel_state::poll_missions(&mut ui, s, tx);
    changed |= missions_changed;
    let stashed = s.temporary.stashed_for_snapshot();
    ui.stage_with_stashed(stashed);
    let previous_error = (
        ui.persistence.read_error,
        ui.persistence.write_error,
        ui.persistence.partial,
    );
    if ui.persistence.poll_save_ready(ui.revision, now, tx) {
        let snapshot = ui.snapshot_with_stashed(stashed);
        ui.persistence.start_save(&snapshot, s.wake.clone());
    }
    let error = (
        ui.persistence.read_error,
        ui.persistence.write_error,
        ui.persistence.partial,
    );
    s.workspace = Some(ui);
    #[cfg(target_arch = "wasm32")]
    platform::pairing::flush_deferred_checks(s);
    if !mission_auth_expired.is_empty() {
        #[cfg(not(target_arch = "wasm32"))]
        for expired in mission_auth_expired {
            changed |= crate::settings::authentication_required(s, &expired);
        }
        #[cfg(target_arch = "wasm32")]
        {
            let _ = mission_auth_expired;
            crate::platform::pairing::observe(s);
        }
    }
    changed |= catalogue::poll(s, now, tx);
    for (index, id) in deleted_by_tab {
        changed |= super::drafts::recover_missing_session_draft_in(s, Some(index), &id);
    }
    changed |= super::drafts::drain_window_deleted_sessions(s);
    changed |= super::drafts::poll_restored_draft_checks(s);
    changed |= super::drafts::poll_pending_deleted(s);
    if became_ready {
        resume(s, tx);
    }
    changed || became_ready || error != previous_error
}
pub fn poll_file_drafts(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let Some(mut ui) = s.workspace.take() else {
        return false;
    };
    let previous_error = ui.persistence.file_draft_error;
    ui.persistence
        .poll_file_drafts(&s.documents, now, tx, s.wake.clone());
    let changed = ui.persistence.file_draft_error != previous_error;
    s.workspace = Some(ui);
    changed
}
pub fn file_draft_status(s: &State) -> Option<&'static str> {
    let ui = s.workspace.as_ref()?;
    (ui.persistence.file_draft_error
        || ui.persistence.file_draft_read_error
        || s.documents.has_unretained_file_drafts())
    .then_some("filesPanel.draftLimit")
}

pub fn status(s: &State) -> Option<&'static str> {
    let ui = s.workspace.as_ref()?;
    if ui.persistence.read_error {
        Some("rune.restore_error")
    } else if ui.persistence.write_error || ui.persistence.partial || ui.has_unsaved_large_drafts()
    {
        Some("rune.save_error")
    } else {
        file_draft_status(s)
    }
}

#[cfg(test)]
mod tests {
    use super::{file_draft_status, status};
    use crate::workspace::Ui;

    #[test]
    fn file_draft_error_stays_visible_alongside_workspace_restore_error() {
        let mut s = crate::init();
        let mut ui = Ui::new();
        ui.persistence.read_error = true;
        ui.persistence.file_draft_error = true;
        s.workspace = Some(ui);
        assert_eq!(status(&s), Some("rune.restore_error"));
        assert_eq!(file_draft_status(&s), Some("filesPanel.draftLimit"));
        let mut rt = rune::Runtime::new(
            s,
            |s, cx| crate::shell::view(s, cx, |_, _| rune::el()),
            (1000.0, 600.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let alerts: Vec<_> = rt
            .elements()
            .iter()
            .filter(|e| e.role == "alert")
            .filter_map(|e| e.text.clone())
            .collect();
        assert_eq!(alerts.len(), 2);
        assert!(
            alerts
                .iter()
                .any(|l| l == crate::strings::t("rune.restore_error"))
        );
        assert!(
            alerts
                .iter()
                .any(|l| l == crate::strings::t("filesPanel.draftLimit"))
        );
        // At narrow mobile widths, French alert text wraps within the viewport instead of clipping.
        rt.set_viewport((320.0, 600.0), 1.0);
        crate::strings::with_locale("fr", || {
            rt.frame(0.02);
        });
        let narrow_alerts: Vec<_> = rt
            .elements()
            .into_iter()
            .filter(|e| e.role == "alert")
            .collect();
        assert_eq!(narrow_alerts.len(), 2);
        for node in &narrow_alerts {
            assert!(
                node.rect[0] + node.rect[2] <= 320.5,
                "alert overflowed 320px viewport: {node:?}"
            );
        }
        rt.state.workspace.as_mut().unwrap().persistence.read_error = false;
        rt.set_viewport((1000.0, 600.0), 1.0);
        rt.frame(0.02);
        let alerts: Vec<_> = rt
            .elements()
            .iter()
            .filter(|e| e.role == "alert")
            .filter_map(|e| e.text.clone())
            .collect();
        assert_eq!(alerts, vec![crate::strings::t("filesPanel.draftLimit")]);
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn post_files_poll_schedules_file_draft_wake_in_same_frame() {
        let parent = std::env::temp_dir().join(codenomad_client::http::client_id().unwrap());
        std::fs::create_dir(&parent).unwrap();
        let store =
            crate::platform::block_on(crate::platform::storage::Store::open(parent.join("rune")))
                .unwrap();
        let mut s = crate::init();
        let mut ui = Ui::new();
        ui.ready = true;
        ui.persistence.store = Some(store.clone());
        s.workspace = Some(ui);
        let mut rt = rune::Runtime::new(
            s,
            |_, _| rune::el(),
            (100.0, 100.0),
            rune::Env::new(false, 1.0),
        );
        rt.poll = Some(crate::poll);
        rt.frame(1.0);
        assert!(rt.wake_deadline().is_none());
        rt.state
            .documents
            .insert_test_file_draft("src/lib.rs", "edited");
        rt.frame(0.02);
        let due = rt
            .wake_deadline()
            .expect("crate::poll must arm tx.wake_at for pending file drafts");
        assert!(due > rt.clock);
        let step = (due - rt.clock).max(0.0) + 0.01;
        rt.frame(step);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while store.file_draft_write_count() == 0 {
            assert!(std::time::Instant::now() < deadline);
            rt.frame(0.02);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        drop(rt);
        while store.file_draft_worker_running() || store.files_refcount() > 1 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let persisted = crate::platform::block_on(store.load_file_drafts())
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&persisted).contains("edited"));
        drop(store);
        std::fs::remove_dir_all(parent).unwrap();
    }
}
