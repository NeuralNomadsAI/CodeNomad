use super::{Cache, State, Tx, Ui, drafts, notification};

pub(super) fn poll_cached(s: &mut State, ui: &mut Ui, now: Option<f64>, tx: &mut Tx) -> bool {
    let active = Cache::take(s);
    let was_polling_cached = std::mem::replace(&mut s.polling_cached, true);
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
    s.polling_cached = was_polling_cached;
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
