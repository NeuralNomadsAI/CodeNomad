use super::{Cache, State, Tab, Tx, Ui, drafts, notification};

pub(super) fn poll_cached(s: &mut State, ui: &mut Ui, now: Option<f64>, tx: &mut Tx) -> bool {
    let active = Cache::take(s);
    let active_has_healthy_stream = active.has_healthy_conversation_stream();
    let mut changed = false;
    let mut drafts_changed = false;
    let mut unconfirmed_updates = Vec::new();
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
        if let Some(cache) = item.cache.take() {
            cache.apply(s);
            let awaiting_prompt = s.composer.pending();
            let prev_unconfirmed = s.composer.unconfirmed_id().map(str::to_owned);
            changed |= crate::chat::events::poll_hidden_chat(s, 8, other_healthy_stream);
            changed |= crate::files::poll_notices(s);
            crate::shell::notifications::collect(s, |s| notification::entry_target(item, s));
            let next_unconfirmed = s.composer.unconfirmed_id().map(str::to_owned);
            let unconfirmed_cleared = prev_unconfirmed.is_some() && next_unconfirmed.is_none();
            if prev_unconfirmed != next_unconfirmed
                && let Tab::Workspace(saved) = &item.saved
                && let Some(session_id) = saved.active_session_id.as_deref()
                && item
                    .binding
                    .as_ref()
                    .is_some_and(|b| b.session == session_id)
            {
                unconfirmed_updates.push((
                    saved.clone(),
                    session_id.to_owned(),
                    prev_unconfirmed,
                    next_unconfirmed,
                ));
            }
            if awaiting_prompt && !s.composer.pending() || unconfirmed_cleared {
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
    for (saved, session_id, prev, next) in unconfirmed_updates {
        if let Some(attempt_id) = next {
            drafts::note_unconfirmed_for(s, ui, &saved, &session_id, &attempt_id);
        } else if let Some(attempt_id) = prev {
            drafts::confirm_unconfirmed_for(s, ui, &saved, &session_id, &attempt_id);
        }
    }
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
    crate::platform::pairing::set_defer_checks(s, true);
    let changed = poll_cached(s, &mut ui, None, tx);
    s.workspace = Some(ui);
    crate::platform::pairing::flush_deferred_checks(s);
    changed
}
