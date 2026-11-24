use super::{Backend, State, Tab, Tx, Ui, same_backend, same_project};
use crate::composer::{
    draft::{Draft, MAX_FILES},
    draft_storage::SavedParts,
};

const MAX_WINDOW_DEVICE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_WINDOW_DEVICE_FILES: usize = super::super::MAX_DRAFTS * MAX_FILES;

#[derive(Default)]
pub(super) struct LiveDraft {
    text: Option<String>,
    parts: Option<(Draft, bool)>,
    unconfirmed: Option<crate::composer::PendingSend>,
}

impl LiveDraft {
    pub(super) fn unconfirmed_id(&self) -> Option<&str> {
        self.unconfirmed.as_ref().map(|send| send.id())
    }

    pub(super) fn unconfirmed_restored_text(&self) -> Option<&str> {
        self.unconfirmed
            .as_ref()
            .and_then(|send| send.restored_text())
    }

    pub(super) fn clear_unconfirmed_matching(
        &mut self,
        attempt_id: &str,
        saved_text: Option<&str>,
    ) -> bool {
        if self.unconfirmed_id() != Some(attempt_id) {
            return false;
        }
        let Some(send) = self.unconfirmed.take() else {
            return false;
        };
        let text = self.text.as_deref().or(saved_text);
        if send.matches_restored_draft(text, self.parts.as_ref().map(|(draft, _)| draft)) {
            self.text = None;
            self.parts = None;
            return true;
        }
        false
    }
}

impl Ui {
    pub(crate) fn has_unsaved_large_drafts(&self) -> bool {
        self.entries
            .iter()
            .any(super::Entry::has_unsaved_large_drafts)
    }
}

impl super::Entry {
    pub(super) fn has_unsaved_large_drafts(&self) -> bool {
        self.live_drafts.values().any(|draft| draft.text.is_some())
    }
}

fn oversized(text: &str) -> bool {
    text.encode_utf16().nth(super::super::MAX_DRAFT).is_some()
}

pub fn window_inline_usage_without_history(
    s: &State,
    seen: &mut std::collections::HashSet<usize>,
) -> (usize, usize) {
    let (mut files, mut bytes) = s.composer.add_unique_inline_usage(seen, true);
    let Some(ui) = &s.workspace else {
        return (files, bytes);
    };
    let active_session = super::active_session(s);
    for (index, entry) in ui.entries.iter().enumerate() {
        if index != ui.active
            && let Some(cache) = entry.cache.as_ref()
        {
            let (f, b) = cache.add_unique_inline_usage(seen);
            files = files.saturating_add(f);
            bytes = bytes.saturating_add(b);
        }
        for (key, draft) in &entry.live_drafts {
            if index == ui.active && Some(key.as_str()) == active_session {
                continue;
            }
            if let Some((base, _)) = draft.parts.as_ref() {
                let (f, b) = base.add_unique_inline_usage(seen);
                files = files.saturating_add(f);
                bytes = bytes.saturating_add(b);
            }
            if let Some(send) = draft.unconfirmed.as_ref() {
                let (f, b) = send.draft().add_unique_inline_usage(seen);
                files = files.saturating_add(f);
                bytes = bytes.saturating_add(b);
            }
        }
    }
    (files, bytes)
}

pub fn attachment_draft_admissible(s: &State) -> bool {
    let mut seen = std::collections::HashSet::new();
    let (mut files, mut bytes) = window_inline_usage_without_history(s, &mut seen);
    let (history_files, history_bytes) = s.prompt_history.unique_inline_usage(&mut seen);
    files = files.saturating_add(history_files);
    bytes = bytes.saturating_add(history_bytes);
    if files > MAX_WINDOW_DEVICE_FILES || bytes > MAX_WINDOW_DEVICE_BYTES {
        return false;
    }
    let Some(ui) = &s.workspace else { return true };
    let Some(id) = super::active_session(s) else {
        return false;
    };
    let Some(Tab::Workspace(active)) = ui.entries.get(ui.active).map(|entry| &entry.saved) else {
        return false;
    };
    let distinct: std::collections::BTreeSet<_> = ui
        .entries
        .iter()
        .filter_map(|entry| match &entry.saved {
            Tab::Workspace(saved) => Some(saved),
            _ => None,
        })
        .chain(&ui.closed)
        .filter(|saved| same_project(active, saved))
        .flat_map(|saved| saved.attachment_drafts.iter().map(String::as_str))
        .chain([id])
        .collect();
    if distinct.len() > super::super::MAX_DRAFTS {
        return false;
    }
    let mut snapshot = ui.snapshot();
    let Some(Tab::Workspace(saved)) = snapshot.tabs.get_mut(ui.active) else {
        return false;
    };
    saved.attachment_drafts.insert(id.into());
    if let Some(parts) =
        SavedParts::capture(&s.composer.draft, s.composer.attachments_missing, &s.draft)
    {
        saved.attachment_parts.insert(id.into(), parts);
    }
    if !s.draft.text.is_empty() && !oversized(&s.draft.text) {
        saved.drafts.insert(id.into(), s.draft.text.clone());
    }
    super::super::encode(&snapshot).is_ok()
}

pub(super) fn note_unconfirmed_for(
    s: &mut State,
    ui: &mut Ui,
    saved: &super::Workspace,
    key: &str,
    attempt_id: &str,
) {
    let already_confirmed = ui.entries.iter().enumerate().any(|(index, entry)| {
        matches!(
            &entry.saved,
            Tab::Workspace(current)
                if same_backend(current, saved)
                    && current.active_session_id.as_deref() == Some(key)
        ) && if index == ui.active {
            s.composer
                .has_confirmed_user_message(&s.messages, attempt_id)
        } else {
            entry
                .cache
                .as_ref()
                .is_some_and(|cache| cache.has_confirmed_user_message(attempt_id))
        }
    });
    if already_confirmed {
        confirm_unconfirmed_for(s, ui, saved, key, attempt_id);
        return;
    }
    let restored_text = s
        .composer
        .unconfirmed_state()
        .filter(|send| send.id() == attempt_id)
        .and_then(|send| send.restored_text())
        .filter(|text| !oversized(text))
        .map(str::to_owned);
    ui.remember_closed_unconfirmed(saved, key.to_owned(), attempt_id.to_owned(), restored_text);
    for (index, entry) in ui.entries.iter_mut().enumerate() {
        if matches!(&entry.saved, Tab::Workspace(current) if same_backend(current, saved)) {
            let same_active_session = matches!(
                &entry.saved,
                Tab::Workspace(current) if current.active_session_id.as_deref() == Some(key)
            );
            if index == ui.active {
                if same_active_session && s.composer.unconfirmed_state().is_none() {
                    s.composer
                        .restore_unconfirmed(crate::composer::PendingSend::locked(
                            attempt_id.to_owned(),
                        ));
                }
            } else if same_active_session && let Some(cache) = &mut entry.cache {
                cache.restore_unconfirmed(crate::composer::PendingSend::locked(
                    attempt_id.to_owned(),
                ));
            }
            if let Some(live) = entry.live_drafts.get_mut(key)
                && live.unconfirmed.is_none()
            {
                live.unconfirmed =
                    Some(crate::composer::PendingSend::locked(attempt_id.to_owned()));
            }
        }
    }
}

pub fn note_unconfirmed(s: &mut State, attempt_id: &str) {
    let Some(mut ui) = s.workspace.take() else {
        return;
    };
    let target = ui.entries.get(ui.active).and_then(|item| {
        let Tab::Workspace(saved) = &item.saved else {
            return None;
        };
        let key = saved.active_session_id.as_deref()?;
        let owns = item.binding.as_ref().is_some_and(|b| b.session == key);
        owns.then(|| (saved.clone(), key.to_owned()))
    });
    if let Some((saved, key)) = target {
        note_unconfirmed_for(s, &mut ui, &saved, &key, attempt_id);
    }
    s.workspace = Some(ui);
}

pub fn has_unconfirmed(s: &State) -> bool {
    let Some(ui) = &s.workspace else {
        return false;
    };
    let Some(item) = ui.entries.get(ui.active) else {
        return false;
    };
    let Tab::Workspace(saved) = &item.saved else {
        return false;
    };
    let Some(key) = saved.active_session_id.as_deref() else {
        return false;
    };
    if ui.closed_unconfirmed_id(saved, key).is_some() {
        return true;
    }
    ui.entries.iter().enumerate().any(|(index, entry)| {
        index != ui.active
            && matches!(&entry.saved, Tab::Workspace(other) if same_backend(other, saved))
            && (matches!(
                &entry.saved,
                Tab::Workspace(other) if other.active_session_id.as_deref() == Some(key)
            ) && entry
                .cache
                .as_ref()
                .is_some_and(|cache| cache.is_sending() || cache.unconfirmed_id().is_some())
                || entry
                    .live_drafts
                    .get(key)
                    .is_some_and(|live| live.unconfirmed_id().is_some()))
    })
}

pub(super) fn confirm_unconfirmed_for(
    s: &mut State,
    ui: &mut Ui,
    saved: &super::Workspace,
    key: &str,
    attempt_id: &str,
) {
    let mut restored_text = ui.forget_closed_unconfirmed(saved, key, attempt_id);
    if restored_text.is_none() {
        restored_text = ui.entries.iter().enumerate().find_map(|(index, entry)| {
            if !matches!(&entry.saved, Tab::Workspace(current) if same_backend(current, saved)) {
                return None;
            }
            if index == ui.active {
                s.composer
                    .unconfirmed_state()
                    .filter(|send| send.id() == attempt_id)
                    .and_then(|send| send.restored_text())
                    .map(str::to_owned)
            } else {
                entry
                    .cache
                    .as_ref()
                    .filter(|cache| cache.unconfirmed_id() == Some(attempt_id))
                    .and_then(|cache| cache.unconfirmed_restored_text())
                    .map(str::to_owned)
            }
            .or_else(|| {
                entry
                    .live_drafts
                    .get(key)
                    .filter(|live| live.unconfirmed_id() == Some(attempt_id))
                    .and_then(|live| live.unconfirmed_restored_text())
                    .map(str::to_owned)
            })
        });
    }
    let mut persisted_changed = false;
    for (index, entry) in ui.entries.iter_mut().enumerate() {
        if matches!(&entry.saved, Tab::Workspace(current) if same_backend(current, saved)) {
            let same_active_session = matches!(
                &entry.saved,
                Tab::Workspace(current) if current.active_session_id.as_deref() == Some(key)
            );
            let mut cleared_draft = false;
            if index == ui.active {
                if same_active_session {
                    cleared_draft |= s
                        .composer
                        .confirm_unconfirmed_matching(&mut s.draft, attempt_id);
                }
            } else if same_active_session && let Some(cache) = &mut entry.cache {
                cleared_draft |= cache.clear_unconfirmed_matching(attempt_id);
            }
            let saved_text = match &entry.saved {
                Tab::Workspace(current) => current.drafts.get(key).map(String::as_str),
                _ => None,
            };
            if let Some(live) = entry.live_drafts.get_mut(key) {
                cleared_draft |= live.clear_unconfirmed_matching(attempt_id, saved_text);
            }
            if cleared_draft && let Tab::Workspace(current) = &mut entry.saved {
                if current.drafts.remove(key).is_some() {
                    entry.cleared.insert(key.into());
                    persisted_changed = true;
                }
                persisted_changed |= current.attachment_drafts.remove(key);
                persisted_changed |= current.attachment_parts.remove(key).is_some();
                if entry.live_drafts.get(key).is_some_and(|live| {
                    live.text.is_none() && live.parts.is_none() && live.unconfirmed.is_none()
                }) {
                    entry.live_drafts.remove(key);
                }
            }
        }
    }
    if let Some(expected_text) = restored_text.as_deref() {
        for closed in &mut ui.closed {
            if same_project(closed, saved)
                && closed.drafts.get(key).map(String::as_str) == Some(expected_text)
            {
                closed.drafts.remove(key);
                closed.attachment_drafts.remove(key);
                closed.attachment_parts.remove(key);
            }
        }
    }
    if persisted_changed {
        ui.changed();
    }
}

pub fn confirm_unconfirmed(s: &mut State, attempt_id: &str) {
    let Some(mut ui) = s.workspace.take() else {
        return;
    };
    let target = ui.entries.get(ui.active).and_then(|item| {
        let Tab::Workspace(saved) = &item.saved else {
            return None;
        };
        let key = saved.active_session_id.as_deref()?;
        let owns = item.binding.as_ref().is_some_and(|b| b.session == key);
        owns.then(|| (saved.clone(), key.to_owned()))
    });
    if let Some((saved, key)) = target {
        confirm_unconfirmed_for(s, &mut ui, &saved, &key, attempt_id);
    }
    s.workspace = Some(ui);
}

pub fn capture(s: &mut State) {
    let Some(mut ui) = s.workspace.take() else {
        return;
    };
    if ui
        .entries
        .get_mut(ui.active)
        .is_some_and(|item| capture_draft(item, s))
    {
        ui.changed();
    }
    ui.stage();
    s.workspace = Some(ui);
}

pub(super) fn capture_draft(item: &mut super::Entry, s: &State) -> bool {
    let (edit, draft, missing) = crate::composer::recall::fresh(s);
    let text = &edit.text;
    let mut changed = false;
    if let Tab::Workspace(saved) = &mut item.saved {
        let key = saved
            .active_session_id
            .as_deref()
            .unwrap_or("__no_session_draft__");
        let owns_draft = item.binding.as_ref().is_some_and(|b| {
            b.session == key || b.session.is_empty() && key == "__no_session_draft__"
        });
        if owns_draft {
            let too_long = oversized(text);
            let has_device_parts = draft.inline_usage().0 != 0;
            let unconfirmed = s.composer.unconfirmed_state().cloned();
            if too_long || has_device_parts || unconfirmed.is_some() {
                let live = item.live_drafts.entry(key.into()).or_default();
                live.text = too_long.then(|| text.clone());
                live.parts = (too_long || has_device_parts).then(|| {
                    let mut draft = draft.clone();
                    draft.literal_spans = crate::composer::literal::ranges(edit).collect();
                    (draft, missing)
                });
                live.unconfirmed = unconfirmed;
            } else {
                item.live_drafts.remove(key);
            }
            if too_long {
                return false;
            }
            let parts = SavedParts::capture(draft, missing, edit);
            changed |= if parts.is_some() {
                saved.attachment_drafts.insert(key.into())
            } else {
                saved.attachment_drafts.remove(key)
            };
            match parts {
                Some(parts) if saved.attachment_parts.get(key) != Some(&parts) => {
                    saved.attachment_parts.insert(key.into(), parts);
                    changed = true;
                }
                None => changed |= saved.attachment_parts.remove(key).is_some(),
                _ => {}
            }
            if text.is_empty() {
                if saved.drafts.remove(key).is_some() {
                    item.cleared.insert(key.into());
                    return true;
                }
            } else if saved.drafts.get(key).is_none_or(|value| value != text) {
                saved.drafts.insert(key.into(), text.clone());
                item.cleared.remove(key);
                return true;
            }
        }
    }
    changed
}
pub fn draft_changed(s: &mut State, _: &mut Tx) {
    s.composer.mark_edited();
    capture(s);
}

pub fn bound(s: &mut State, backend: &Backend) -> String {
    crate::composer::recall::restore(s);
    capture(s);
    let same_session =
        !s.screen.is_launcher() && super::active_session(s) == Some(&backend.session);
    if !same_session {
        s.composer = Default::default();
    } else {
        s.composer.draft.literal_spans = crate::composer::literal::ranges(&s.draft).collect();
    }
    let Some(ui) = &mut s.workspace else {
        return String::new();
    };
    deliver_draft(ui, &backend.session);
    let closed_unconfirmed = match &ui.entries[ui.active].saved {
        Tab::Workspace(saved) => ui
            .closed_unconfirmed_entry(saved, &backend.session)
            .map(|(id, text)| (id.to_owned(), text.map(str::to_owned))),
        Tab::Blank => None,
    };
    let item = &mut ui.entries[ui.active];
    item.binding = Some(backend.clone());
    let Tab::Workspace(saved) = &mut item.saved else {
        return String::new();
    };
    saved.active_session_id = Some(backend.session.clone());
    let live = item.live_drafts.get(&backend.session);
    if !same_session {
        if let Some(unconfirmed) = live.and_then(|draft| draft.unconfirmed.as_ref()) {
            s.composer.restore_unconfirmed(unconfirmed.clone());
        } else if let Some((attempt_id, restored_text)) = closed_unconfirmed {
            s.composer
                .restore_unconfirmed(crate::composer::PendingSend::locked_with_text(
                    attempt_id,
                    restored_text,
                ));
        }
    }
    if !same_session && let Some((draft, missing)) = live.and_then(|draft| draft.parts.as_ref()) {
        s.composer.draft = draft.clone();
        s.composer.attachments_missing = *missing;
    } else if !same_session && let Some(parts) = saved.attachment_parts.get(&backend.session) {
        (s.composer.draft, s.composer.attachments_missing) = parts.restore();
    } else {
        s.composer.attachments_missing |= saved.attachment_drafts.contains(&backend.session)
            && s.composer.draft.attachments.is_empty();
    }
    let draft = live
        .and_then(|draft| draft.text.as_ref())
        .or_else(|| saved.drafts.get(&backend.session))
        .cloned()
        .unwrap_or_default();
    ui.changed();
    draft
}
fn deliver_draft(ui: &mut Ui, id: &str) {
    let item = &ui.entries[ui.active];
    let Tab::Workspace(scope) = &item.saved else {
        return;
    };
    if !item.pending_drafts.contains(id) {
        return;
    }
    let scope = scope.clone();
    let current = ui
        .closed
        .iter()
        .rev()
        .filter(|w| same_project(&scope, w))
        .find_map(|w| {
            let missing = w.attachment_drafts.contains(id);
            (missing || w.drafts.contains_key(id)).then(|| {
                (
                    w.drafts.get(id).cloned(),
                    missing,
                    w.attachment_parts.get(id).cloned(),
                )
            })
        });
    for (index, item) in ui.entries.iter_mut().enumerate() {
        if !matches!(&item.saved, Tab::Workspace(w) if same_project(&scope, w))
            || !item.pending_drafts.remove(id)
        {
            continue;
        }
        let Tab::Workspace(saved) = &mut item.saved else {
            continue;
        };
        saved.drafts.remove(id);
        saved.attachment_drafts.remove(id);
        saved.attachment_parts.remove(id);
        item.live_drafts.remove(id);
        item.cleared.remove(id);
        if index == ui.active {
            if current.as_ref().is_some_and(|(_, marked, _)| *marked) {
                saved.attachment_drafts.insert(id.into());
            }
            if let Some(parts) = current.as_ref().and_then(|(_, _, parts)| parts.as_ref()) {
                saved.attachment_parts.insert(id.into(), parts.clone());
            }
            match current.as_ref().and_then(|(text, _, _)| text.as_ref()) {
                Some(text) if !text.is_empty() => {
                    saved.drafts.insert(id.into(), text.clone());
                }
                Some(_) => {
                    item.cleared.insert(id.into());
                }
                None => {}
            }
        }
    }
    for w in ui.closed.iter_mut().filter(|w| same_project(&scope, w)) {
        w.drafts.remove(id);
        w.attachment_drafts.remove(id);
        w.attachment_parts.remove(id);
    }
}
