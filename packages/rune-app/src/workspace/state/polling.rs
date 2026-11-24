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
    if became_ready {
        ui.ready = true;
        #[cfg(target_arch = "wasm32")]
        if let Some(wrap) = platform::storage::browser_file_wrap() {
            s.shell.file_wrap = wrap;
        }
    }
    let mut changed = ui.persistence.poll_file_draft_retry(&s.documents);
    changed |= poll_cached(s, &mut ui, Some(now), tx);
    changed |= panel_state::poll_missions(&mut ui, s, tx);
    ui.stage();
    let previous_error = (
        ui.persistence.read_error,
        ui.persistence.write_error,
        ui.persistence.file_draft_error,
        ui.persistence.partial,
    );
    let snapshot = ui.snapshot();
    ui.persistence.poll_save(&snapshot, now, tx, s.wake.clone());
    #[cfg(target_arch = "wasm32")]
    ui.persistence.poll_file_drafts(&s.documents);
    let error = (
        ui.persistence.read_error,
        ui.persistence.write_error,
        ui.persistence.file_draft_error,
        ui.persistence.partial,
    );
    let mission_auth_expired = ui.mission_auth_expired.take();
    s.workspace = Some(ui);
    if let Some(backend) = mission_auth_expired {
        #[cfg(target_arch = "wasm32")]
        platform::pairing::observe(s);
        crate::settings::conversation_authentication(
            s,
            codenomad_client::transport::Authentication {
                backend,
                confirmed: true,
            },
        );
        changed = true;
    }
    if became_ready {
        resume(s, tx);
    }
    if changed {
        history_budget::enforce(s);
    }
    changed |= catalogue::poll(s, now, tx);
    changed || became_ready || error != previous_error
}
pub fn status(s: &State) -> Option<&'static str> {
    let ui = s.workspace.as_ref()?;
    if ui.persistence.read_error {
        Some("rune.restore_error")
    } else if ui.persistence.write_error || ui.persistence.partial || ui.has_unsaved_large_drafts()
    {
        Some("rune.save_error")
    } else if ui.persistence.file_draft_error
        || ui.persistence.file_draft_read_error
        || s.documents.has_unretained_file_drafts()
    {
        Some("filesPanel.draftLimit")
    } else {
        None
    }
}
