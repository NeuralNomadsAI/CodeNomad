use super::{Cache, State, Tab, Tx, Ui, drafts, notification};

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
    let mut projection_sync: Vec<(super::ProjectScope, String)> = Vec::new();
    let mut deleted_by_tab: Vec<(usize, String)> = Vec::new();
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
            let prev_unconfirmed = s.composer.unconfirmed_id().map(str::to_owned);
            let (hidden_changed, session_deleted) =
                crate::chat::events::poll_hidden_chat(s, 8, other_healthy_stream);
            changed |= hidden_changed;
            let mut capture_here = |item: &mut super::Entry, s: &State| {
                let before = match &item.saved {
                    super::Tab::Workspace(w) => w.active_session_id.as_ref().map(|id| {
                        (
                            super::ProjectScope::from_workspace(w),
                            id.clone(),
                            item.clear_authority.get(id).cloned(),
                        )
                    }),
                    super::Tab::Blank => None,
                };
                let captured = drafts::capture_draft(item, s);
                let auth_changed = before
                    .as_ref()
                    .is_some_and(|(_, id, prev)| item.clear_authority.get(id) != prev.as_ref());
                if captured || auth_changed {
                    drafts_changed = true;
                    if let Some((scope, id, _)) = before {
                        projection_sync.push((scope, id));
                    }
                }
            };
            if session_deleted
                && let Some(id) = match &item.saved {
                    super::Tab::Workspace(saved) => saved.active_session_id.clone(),
                    super::Tab::Blank => None,
                }
            {
                capture_here(item, s);
                item.pending_deleted.insert(id);
            }
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
                capture_here(item, s);
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
    for (scope, id) in projection_sync {
        drafts::sync_pending_closed_projections(ui, &scope, &id);
    }
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
    (changed, deleted_by_tab)
}

/// Drains queued conversation events (including prompt confirmations and `Event::SessionDeleted`)
/// on an inactive tab before tab closure recovers or archives drafts.
pub(super) fn drain_inactive_for_close(s: &mut State, index: usize) -> bool {
    let Some(mut ui) = s.workspace.take() else {
        return false;
    };
    if index == ui.active || index >= ui.entries.len() {
        s.workspace = Some(ui);
        return false;
    }
    let active = Cache::take(s);
    let other_healthy_stream = active.has_healthy_conversation_stream()
        || ui.entries.iter().enumerate().any(|(other_index, other)| {
            other_index != index
                && other
                    .cache
                    .as_ref()
                    .is_some_and(Cache::has_healthy_conversation_stream)
        });
    let mut session_deleted = false;
    let mut drafts_changed = false;
    let mut projection_sync: Vec<(super::ProjectScope, String)> = Vec::new();
    let mut unconfirmed_update = None;
    {
        let item = &mut ui.entries[index];
        if let Some(cache) = item.cache.take() {
            cache.apply(s);
            let prev_unconfirmed = s.composer.unconfirmed_id().map(str::to_owned);
            let (_, deleted) = crate::chat::events::poll_hidden_chat(s, 1024, other_healthy_stream);
            session_deleted = deleted;
            let next_unconfirmed = s.composer.unconfirmed_id().map(str::to_owned);
            if prev_unconfirmed != next_unconfirmed
                && let Tab::Workspace(saved) = &item.saved
                && let Some(session_id) = saved.active_session_id.as_deref()
                && item
                    .binding
                    .as_ref()
                    .is_some_and(|b| b.session == session_id)
            {
                unconfirmed_update = Some((
                    saved.clone(),
                    session_id.to_owned(),
                    prev_unconfirmed,
                    next_unconfirmed,
                ));
            }
            let before = match &item.saved {
                super::Tab::Workspace(w) => w.active_session_id.as_ref().map(|id| {
                    (
                        super::ProjectScope::from_workspace(w),
                        id.clone(),
                        item.clear_authority.get(id).cloned(),
                    )
                }),
                super::Tab::Blank => None,
            };
            let captured = drafts::capture_draft(item, s);
            let auth_changed = before
                .as_ref()
                .is_some_and(|(_, id, prev)| item.clear_authority.get(id) != prev.as_ref());
            if captured || auth_changed {
                drafts_changed = true;
                if let Some((scope, id, _)) = before {
                    projection_sync.push((scope, id));
                }
            }
            item.cache = Some(Cache::take(s));
        }
    }
    active.apply(s);
    for (scope, id) in projection_sync {
        drafts::sync_pending_closed_projections(&mut ui, &scope, &id);
    }
    if let Some((saved, session_id, prev, next)) = unconfirmed_update {
        if let Some(attempt_id) = next {
            drafts::note_unconfirmed_for(s, &mut ui, &saved, &session_id, &attempt_id);
        } else if let Some(attempt_id) = prev {
            drafts::confirm_unconfirmed_for(s, &mut ui, &saved, &session_id, &attempt_id);
        }
    }
    if drafts_changed {
        ui.changed();
    }
    s.workspace = Some(ui);
    session_deleted
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn poll_cached_notifications(s: &mut State, tx: &mut Tx) -> bool {
    let Some(mut ui) = s.workspace.take() else {
        return false;
    };
    crate::platform::pairing::set_defer_checks(s, true);
    let (mut changed, deleted_by_tab) = poll_cached(s, &mut ui, None, tx);
    s.workspace = Some(ui);
    crate::platform::pairing::flush_deferred_checks(s);
    for (index, id) in deleted_by_tab {
        changed |= drafts::recover_missing_session_draft_in(s, Some(index), &id);
    }
    changed
}
