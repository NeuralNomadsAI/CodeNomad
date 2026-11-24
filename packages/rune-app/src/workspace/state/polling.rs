//! Workspace persistence, background tabs and active-panel updates.
#[cfg(target_arch = "wasm32")]
use super::platform;
use super::{State, Tx, catalogue, history_budget, observation::poll_cached, panel_state, resume};

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
    let became_ready = loading && !ui.persistence.loading;
    if let Some(store) = &ui.persistence.store {
        s.saved_outlines.poll(store, s.wake.clone());
    }
    if became_ready {
        ui.ready = true;
        #[cfg(target_arch = "wasm32")]
        if let Some(wrap) = platform::storage::browser_file_wrap() {
            s.shell.file_wrap = wrap;
        }
    }
    let mut changed = ui.persistence.poll_file_draft_retry(&s.documents);
    changed |= poll_cached(s, &mut ui, Some(now), tx);
    changed |= crate::timeline::sync_outline_mutation(s);
    changed |= panel_state::poll_missions(&mut ui, s, tx);
    ui.stage();
    let previous_error = (
        ui.persistence.read_error,
        ui.persistence.write_error,
        ui.persistence.partial,
    );
    let snapshot = ui.snapshot();
    ui.persistence.poll_save(&snapshot, now, tx, s.wake.clone());
    let error = (
        ui.persistence.read_error,
        ui.persistence.write_error,
        ui.persistence.partial,
    );
    s.workspace = Some(ui);
    if became_ready {
        resume(s, tx);
    }
    if changed {
        history_budget::enforce(s);
    }
    changed |= catalogue::poll(s, now, tx);
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
    use super::{file_draft_status, poll_file_drafts, status};
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
        rt.state.workspace.as_mut().unwrap().persistence.read_error = false;
        rt.frame(0.0);
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
        ui.persistence.store = Some(store);
        s.workspace = Some(ui);
        let mut rt = rune::Runtime::new(
            s,
            |_, _| rune::el(),
            (100.0, 100.0),
            rune::Env::new(false, 1.0),
        );
        rt.update(|s, tx| {
            // Simulate a draft mutation happening during files::poll after workspace::poll.
            s.documents.insert_test_file_draft("src/lib.rs", "edited");
            let _ = poll_file_drafts(s, 1.0, tx);
        });
        assert_eq!(
            rt.state
                .workspace
                .as_ref()
                .unwrap()
                .persistence
                .file_drafts_due,
            1.25
        );
        drop(rt);
        std::fs::remove_dir_all(parent).unwrap();
    }
}
