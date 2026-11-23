//! Workspace persistence, background tabs and active-panel updates.
#[cfg(target_arch = "wasm32")]
use super::platform;
use super::{
    Cache, State, Tx, Ui, catalogue, drafts, history_budget, notification, panel_state, resume,
};

fn poll_cached(s: &mut State, ui: &mut Ui, now: Option<f64>, tx: &mut Tx) -> bool {
    let active = Cache::take(s);
    let mut changed = false;
    let mut drafts_changed = false;
    for item in &mut ui.entries {
        if let Some(cache) = item.cache.take() {
            cache.apply(s);
            let awaiting_prompt = s.composer.pending();
            let uncertain_prompt = s.composer.unconfirmed_id().is_some();
            changed |= crate::poll_chat(s, 8);
            changed |= crate::files::poll_notices(s);
            crate::shell::notifications::collect(s, |s| notification::entry_target(item, s));
            if awaiting_prompt && !s.composer.pending()
                || uncertain_prompt && s.composer.unconfirmed_id().is_none()
            {
                drafts_changed |= drafts::capture_draft(item, s);
            }
            if let Some(now) = now {
                changed |= s.files.as_mut().is_some_and(|files| files.poll(now));
                changed |= crate::git::poll(s, now, tx);
            }
            #[cfg(target_arch = "wasm32")]
            if now.is_none() {
                changed |= crate::git::poll_notices(s);
            }
            item.cache = Some(Cache::take(s));
        }
    }
    active.apply(s);
    if drafts_changed {
        ui.changed();
    }
    changed
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn poll_cached_notifications(s: &mut State, tx: &mut Tx) -> bool {
    let Some(mut ui) = s.workspace.take() else {
        return false;
    };
    let changed = poll_cached(s, &mut ui, None, tx);
    s.workspace = Some(ui);
    changed
}

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
