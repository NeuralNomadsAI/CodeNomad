use super::{Cache, State, Tx, Ui, drafts, notification};

pub(super) fn poll_cached(
    s: &mut State,
    ui: &mut Ui,
    now: Option<f64>,
    tx: &mut Tx,
) -> (bool, Vec<(usize, String)>) {
    let active = Cache::take(s);
    let active_has_healthy_stream = active.has_healthy_conversation_stream();
    let mut changed = false;
    let mut drafts_changed = false;
    let mut deleted_by_tab: Vec<(usize, String)> = Vec::new();
    for index in 0..ui.entries.len() {
        let other_healthy_stream = active_has_healthy_stream
            || ui.entries.iter().enumerate().any(|(other_index, other)| {
                other_index != index
                    && other
                        .cache
                        .as_ref()
                        .is_some_and(Cache::has_healthy_conversation_stream)
            });
        let item = &mut ui.entries[index];
        if index != ui.active {
            let checked = item.visits.poll_checks();
            changed |= checked.changed;
            for id in checked.deleted {
                deleted_by_tab.push((index, id));
            }
        }
        if let Some(cache) = item.cache.take() {
            cache.apply(s);
            let awaiting_prompt = s.composer.pending();
            let uncertain_prompt = s.composer.unconfirmed_id().is_some();
            let (hidden_changed, session_deleted) =
                crate::chat::events::poll_hidden_chat(s, 8, other_healthy_stream);
            changed |= hidden_changed;
            if session_deleted
                && let Some(id) = match &item.saved {
                    super::Tab::Workspace(saved) => saved.active_session_id.clone(),
                    super::Tab::Blank => None,
                }
            {
                drafts_changed |= drafts::capture_draft(item, s);
                item.pending_deleted.insert(id);
            }
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
                changed |= crate::git::poll_notices(s, tx);
            }
            item.cache = Some(Cache::take(s));
        }
    }
    active.apply(s);
    if drafts_changed {
        ui.changed();
    }
    (changed, deleted_by_tab)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn poll_cached_notifications(s: &mut State, tx: &mut Tx) -> bool {
    let Some(mut ui) = s.workspace.take() else {
        return false;
    };
    let (mut changed, deleted_by_tab) = poll_cached(s, &mut ui, None, tx);
    s.workspace = Some(ui);
    for (index, id) in deleted_by_tab {
        changed |= drafts::recover_missing_session_draft_in(s, Some(index), &id);
    }
    changed
}
