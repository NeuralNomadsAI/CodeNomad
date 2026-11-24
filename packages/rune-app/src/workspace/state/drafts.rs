use super::{Backend, Cache, State, Tab, Tx, Ui, same_project};
use crate::composer::{
    draft::{Draft, MAX_FILES},
    draft_storage::SavedParts,
};

const MAX_WINDOW_DEVICE_BYTES: usize = 64 * 1024 * 1024;
const MAX_WINDOW_DEVICE_FILES: usize = super::super::MAX_DRAFTS * MAX_FILES;

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

pub fn attachment_draft_admissible(s: &State) -> bool {
    let Some(ui) = &s.workspace else { return true };
    let Some(id) = super::active_session(s) else {
        return false;
    };
    let (current_files, current_bytes) = {
        let (draft_files, draft_bytes) = s.composer.draft.inline_usage();
        let (sending_files, sending_bytes) = s
            .composer
            .sending_state()
            .map_or((0, 0), |send| send.inline_usage());
        let (held_files, held_bytes) = s
            .composer
            .unconfirmed_state()
            .map_or((0, 0), |send| send.unique_inline_usage(&s.composer.draft));
        (
            draft_files
                .saturating_add(sending_files)
                .saturating_add(held_files),
            draft_bytes
                .saturating_add(sending_bytes)
                .saturating_add(held_bytes),
        )
    };
    let inactive_sending = ui
        .entries
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != ui.active)
        .filter_map(|(_, entry)| entry.cache.as_ref())
        .fold((0usize, 0usize), |(files, bytes), cache| {
            let (send_files, send_bytes) = cache.sending_inline_usage();
            (
                files.saturating_add(send_files),
                bytes.saturating_add(send_bytes),
            )
        });
    let (files, bytes) = ui
        .entries
        .iter()
        .enumerate()
        .flat_map(|(index, entry)| {
            entry
                .live_drafts
                .iter()
                .filter(move |(key, _)| index != ui.active || key.as_str() != id)
        })
        .fold(
            (
                current_files.saturating_add(inactive_sending.0),
                current_bytes.saturating_add(inactive_sending.1),
            ),
            |(files, bytes), (_, draft)| {
                let base_draft = draft.parts.as_ref().map(|(draft, _)| draft);
                let (part_files, part_bytes) = base_draft.map_or((0, 0), Draft::inline_usage);
                let (held_files, held_bytes) = draft.unconfirmed.as_ref().map_or((0, 0), |send| {
                    base_draft.map_or_else(
                        || send.inline_usage(),
                        |base| send.unique_inline_usage(base),
                    )
                });
                (
                    files.saturating_add(part_files).saturating_add(held_files),
                    bytes.saturating_add(part_bytes).saturating_add(held_bytes),
                )
            },
        );
    if files > MAX_WINDOW_DEVICE_FILES || bytes > MAX_WINDOW_DEVICE_BYTES {
        return false;
    }
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

pub fn confirm_unconfirmed(s: &mut State, attempt_id: &str) {
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let Some(item) = ui.entries.get(ui.active) else {
        return;
    };
    let Tab::Workspace(saved) = &item.saved else {
        return;
    };
    let Some(key) = saved.active_session_id.as_deref() else {
        return;
    };
    let owns = item.binding.as_ref().is_some_and(|b| b.session == key);
    if owns {
        let saved = saved.clone();
        let key = key.to_owned();
        ui.forget_closed_unconfirmed(&saved, &key, attempt_id);
    }
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
            .closed_unconfirmed_id(saved, &backend.session)
            .map(str::to_owned),
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
        } else if let Some(attempt_id) = closed_unconfirmed {
            s.composer
                .restore_unconfirmed(crate::composer::PendingSend::locked(attempt_id));
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
