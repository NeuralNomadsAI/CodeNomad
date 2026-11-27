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
    unconfirmed: Option<crate::composer::UnconfirmedPrompt>,
}

impl LiveDraft {
    pub(super) fn unconfirmed_id(&self) -> Option<&str> {
        self.unconfirmed
            .as_ref()
            .map(crate::composer::UnconfirmedPrompt::id)
    }

    pub(super) fn unconfirmed_state(&self) -> Option<&crate::composer::UnconfirmedPrompt> {
        self.unconfirmed.as_ref()
    }

    pub(super) fn is_empty(&self) -> bool {
        self.text.is_none() && self.parts.is_none() && self.unconfirmed.is_none()
    }

    pub(super) fn clear_unconfirmed_matching(
        &mut self,
        attempt_id: &str,
        saved_text: Option<&str>,
        saved_parts: Option<&SavedParts>,
        saved_has_attachment_draft: bool,
    ) -> bool {
        if self.unconfirmed_id() != Some(attempt_id) {
            return false;
        }
        let Some(send) = self.unconfirmed.take() else {
            return false;
        };
        let matches = if let Some((draft, missing)) = self.parts.as_ref() {
            let edit = rune::edit::TextEdit::new(self.text.as_deref().or(saved_text).unwrap_or(""));
            send.matches_live(&edit, draft, *missing || saved_has_attachment_draft)
        } else {
            send.matches_saved(
                self.text.as_deref().or(saved_text),
                saved_parts,
                saved_has_attachment_draft,
            )
        };
        if matches {
            self.text = None;
            self.parts = None;
            return true;
        }
        false
    }
}

impl LiveDraft {
    pub(super) fn has_content(&self) -> bool {
        self.text.as_deref().is_some_and(|t| !t.trim().is_empty())
            || self
                .parts
                .as_ref()
                .is_some_and(|(draft, _)| !draft.attachments.is_empty())
            || self.unconfirmed.is_some()
    }

    #[cfg(test)]
    pub(super) fn fixture_oversized(text: String) -> Self {
        Self {
            text: Some(text),
            ..Self::default()
        }
    }

    #[cfg(test)]
    pub(super) fn fixture_device_attachment(name: &str, bytes: &[u8]) -> Self {
        let mut draft = Draft::default();
        let _ = draft.attach(crate::composer::draft::Attachment::Device {
            name: name.into(),
            mime: "application/octet-stream".into(),
            bytes: std::sync::Arc::from(bytes),
            token: None,
        });
        Self {
            parts: Some((draft, false)),
            ..Self::default()
        }
    }

    pub(super) fn retained_bytes(&self, seen: &mut std::collections::HashSet<usize>) -> usize {
        self.text.as_ref().map_or(0, String::len).saturating_add(
            self.parts
                .as_ref()
                .map_or(0, |(draft, _)| draft.retained_bytes(seen)),
        )
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

    pub(super) fn has_local_draft(&self, id: &str) -> bool {
        if self.live_drafts.contains_key(id) {
            return true;
        }
        match &self.saved {
            Tab::Workspace(saved) => {
                saved.drafts.get(id).is_some_and(|text| !text.is_empty())
                    || saved.attachment_drafts.contains(id)
                    || saved.attachment_parts.contains_key(id)
            }
            Tab::Blank => false,
        }
    }

    pub(super) fn has_in_memory_only_drafts(&self) -> bool {
        self.live_drafts.values().any(|draft| {
            draft.text.is_some()
                || draft
                    .parts
                    .as_ref()
                    .is_some_and(|(d, _)| d.inline_usage().0 != 0)
                || draft.unconfirmed.is_some()
        })
    }
}

fn oversized(text: &str) -> bool {
    text.encode_utf16().nth(super::super::MAX_DRAFT).is_some()
}

pub fn window_inline_usage_without_history(
    s: &State,
    seen: &mut std::collections::HashSet<usize>,
    include_active_draft: bool,
) -> (usize, usize) {
    let (mut files, mut bytes) = s
        .composer
        .add_unique_inline_usage(seen, include_active_draft);
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
        }
    }
    (files, bytes)
}

pub fn attachment_draft_admissible(s: &State) -> bool {
    let mut seen = std::collections::HashSet::new();
    let (mut files, mut bytes) = window_inline_usage_without_history(s, &mut seen, true);
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
            s.composer.has_confirmed_prompt(
                &s.messages,
                s.transcript_display.queue.items(),
                attempt_id,
            )
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
    let unconfirmed = s
        .composer
        .unconfirmed_state()
        .filter(|send| send.id() == attempt_id)
        .cloned()
        .or_else(|| {
            ui.entries.iter().enumerate().find_map(|(index, entry)| {
                if !matches!(&entry.saved, Tab::Workspace(current) if same_backend(current, saved))
                {
                    return None;
                }
                if index != ui.active
                    && let Some(found) = entry
                        .cache
                        .as_ref()
                        .and_then(super::Cache::unconfirmed_state)
                        .filter(|send| send.id() == attempt_id)
                {
                    return Some(found.clone());
                }
                entry
                    .live_drafts
                    .get(key)
                    .and_then(LiveDraft::unconfirmed_state)
                    .filter(|send| send.id() == attempt_id)
                    .cloned()
            })
        })
        .unwrap_or_else(|| crate::composer::UnconfirmedPrompt::locked(attempt_id.to_owned()));
    ui.remember_closed_unconfirmed(saved, key.to_owned(), unconfirmed);
    for (index, entry) in ui.entries.iter_mut().enumerate() {
        if matches!(&entry.saved, Tab::Workspace(current) if same_backend(current, saved)) {
            let same_active_session = matches!(
                &entry.saved,
                Tab::Workspace(current) if current.active_session_id.as_deref() == Some(key)
            );
            if index == ui.active {
                if same_active_session && s.composer.unconfirmed_state().is_none() {
                    s.composer
                        .restore_unconfirmed(crate::composer::UnconfirmedPrompt::locked(
                            attempt_id.to_owned(),
                        ));
                }
            } else if same_active_session && let Some(cache) = &mut entry.cache {
                cache.restore_unconfirmed(crate::composer::UnconfirmedPrompt::locked(
                    attempt_id.to_owned(),
                ));
            }
            if let Some(live) = entry.live_drafts.get_mut(key)
                && live.unconfirmed.is_none()
            {
                live.unconfirmed = Some(crate::composer::UnconfirmedPrompt::locked(
                    attempt_id.to_owned(),
                ));
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
    crate::shell::blank_cleanup::abort_if_protected(s);
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
    let mut matched = ui
        .forget_closed_unconfirmed(saved, key, attempt_id)
        .filter(|send| !send.is_edited());
    if matched.is_none() {
        matched = ui.entries.iter().enumerate().find_map(|(index, entry)| {
            if !matches!(&entry.saved, Tab::Workspace(current) if same_backend(current, saved)) {
                return None;
            }
            let active_or_cached = if index == ui.active {
                s.composer
                    .unconfirmed_state()
                    .filter(|send| send.id() == attempt_id && !send.is_edited())
                    .cloned()
            } else {
                entry
                    .cache
                    .as_ref()
                    .and_then(super::Cache::unconfirmed_state)
                    .filter(|send| send.id() == attempt_id && !send.is_edited())
                    .cloned()
            };
            active_or_cached.or_else(|| {
                entry
                    .live_drafts
                    .get(key)
                    .and_then(LiveDraft::unconfirmed_state)
                    .filter(|send| send.id() == attempt_id && !send.is_edited())
                    .cloned()
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
            let (saved_text, saved_parts, saved_has_attachment_draft) = match &entry.saved {
                Tab::Workspace(current) => (
                    current.drafts.get(key).map(String::as_str),
                    current.attachment_parts.get(key),
                    current.attachment_drafts.contains(key),
                ),
                _ => (None, None, false),
            };
            if let Some(live) = entry.live_drafts.get_mut(key) {
                cleared_draft |= live.clear_unconfirmed_matching(
                    attempt_id,
                    saved_text,
                    saved_parts,
                    saved_has_attachment_draft,
                );
            }
            if entry.live_drafts.get(key).is_some_and(LiveDraft::is_empty) {
                entry.live_drafts.remove(key);
            }
            if cleared_draft && let Tab::Workspace(current) = &mut entry.saved {
                if current.drafts.remove(key).is_some() {
                    entry.cleared.insert(key.into());
                    persisted_changed = true;
                }
                persisted_changed |= current.attachment_drafts.remove(key);
                persisted_changed |= current.attachment_parts.remove(key).is_some();
            }
        }
    }
    if let Some(unconfirmed) = matched.as_ref() {
        for closed in &mut ui.closed {
            if same_project(closed, saved)
                && unconfirmed.matches_saved(
                    closed.drafts.get(key).map(String::as_str),
                    closed.attachment_parts.get(key),
                    closed.attachment_drafts.contains(key),
                )
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
    ui.stage_with_stashed(s.temporary.stashed_for_snapshot());
    s.workspace = Some(ui);
    crate::shell::blank_cleanup::abort_if_protected(s);
}

pub fn unconfirmed_drafts_full(s: &State) -> bool {
    if s.composer.unconfirmed_id().is_none() {
        return false;
    }
    let Some(ui) = &s.workspace else {
        return false;
    };
    let Some(item) = ui.entries.get(ui.active) else {
        return false;
    };
    let Tab::Workspace(saved) = &item.saved else {
        return false;
    };
    let key = saved
        .active_session_id
        .as_deref()
        .unwrap_or("__no_session_draft__");
    let closed_full = ui.closed_unconfirmed_count() >= super::MAX_UNCONFIRMED_LOCKS
        && !ui.has_closed_unconfirmed_for(saved, key);
    closed_full
        || item
            .live_drafts
            .iter()
            .filter(|(existing, draft)| existing.as_str() != key && draft.unconfirmed.is_some())
            .count()
            >= super::super::MAX_DRAFTS
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
            let unconfirmed = s.composer.clone_unconfirmed();
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
    crate::shell::blank_cleanup::abort_for_session(s, &backend.session);
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
            .cloned(),
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
        } else if let Some(unconfirmed) = closed_unconfirmed {
            s.composer.restore_unconfirmed(unconfirmed);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pure_unconfirmed_live_drafts_stay_bounded_to_max_drafts() {
        let mut s = crate::init();
        let mut ui = Ui::new();
        ui.fixture_ready();
        ui.entries[0].saved = Tab::Workspace(crate::workspace::Workspace {
            backend_id: None,
            server_id: None,
            folder: "/repo".into(),
            project_name: None,
            temporary: false,
            occurrence: 0,
            workspace_id: Some("ws".into()),
            active_session_id: None,
            drafts: Default::default(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        });
        s.workspace = Some(ui);
        let mut b = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        b.workspace = "ws".into();
        // A session with an edited saved draft must never lose its draft when other sessions
        // accumulate unconfirmed locks.
        b.session = "kept-edited".into();
        let _ = bound(&mut s, &b);
        s.draft = rune::edit::TextEdit::new("edited user draft");
        s.composer
            .restore_unconfirmed(crate::composer::UnconfirmedPrompt::locked(
                "msg_kept_edited".into(),
            ));
        capture(&mut s);

        // Sessions with unconfirmed locks preserve every lock up to MAX_DRAFTS (including those
        // with saved draft text) and then block leaving an additional unconfirmed session instead
        // of evicting earlier locks.
        for index in 0..(crate::workspace::MAX_DRAFTS - 1) {
            b.session = format!("ses-{index}");
            let _ = bound(&mut s, &b);
            s.draft = rune::edit::TextEdit::new("");
            s.composer
                .restore_unconfirmed(crate::composer::UnconfirmedPrompt::locked(format!(
                    "msg_{index}"
                )));
            assert!(!unconfirmed_drafts_full(&s));
            capture(&mut s);
        }
        b.session = "ses-overflow".into();
        let _ = bound(&mut s, &b);
        s.draft = rune::edit::TextEdit::new("draft with unconfirmed lock");
        s.composer
            .restore_unconfirmed(crate::composer::UnconfirmedPrompt::locked(
                "msg_overflow".into(),
            ));
        assert!(unconfirmed_drafts_full(&s));
        // Every previously recorded unconfirmed session retains its anti-replay lock.
        b.session = "ses-0".into();
        let _ = bound(&mut s, &b);
        assert_eq!(s.composer.unconfirmed_id(), Some("msg_0"));
        b.session = "kept-edited".into();
        assert_eq!(bound(&mut s, &b), "edited user draft");
        assert_eq!(s.composer.unconfirmed_id(), Some("msg_kept_edited"));
    }

    #[test]
    fn slash_unconfirmed_persists_across_tab_switch_and_recall_until_settled() {
        use crate::transport::{Command, PromptOutcome};
        let (sender, receiver) = codenomad_client::bounded(4);
        let mut s = crate::init();
        crate::gallery::shell::fixture(&mut s);
        let mut ui = Ui::new();
        ui.fixture_ready();
        s.workspace = Some(ui);
        let project = crate::catalog::Project {
            id: "ws".into(),
            path: "/repo".into(),
            temporary: false,
        };
        let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        backend.workspace = "ws".into();
        backend.session = "ses-a".into();
        s.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut s, &project);
        let _ = bound(&mut s, &backend);
        s.phase = crate::Phase::Ready;
        s.commands = Some(sender.clone());
        s.composer.picker.add_test_command("compact");
        let mut rt = rune::Runtime::new(s, crate::view, (800.0, 600.0), rune::Env::new(false, 1.0));
        rt.state.draft = rune::edit::TextEdit::new("/compact now");
        rt.update(|s, tx| crate::composer::send(s, tx, false));
        let Command::Slash { attempt, .. } = receiver.try_recv().unwrap() else {
            panic!("expected slash command")
        };
        crate::composer::acknowledge(&mut rt.state, &attempt, PromptOutcome::Unconfirmed);
        assert_eq!(rt.state.draft.text.trim(), "/compact now");
        assert!(crate::composer::command_held(&rt.state));

        // Open a second tab, switch back to Tab 1, recall the command and confirm the hold remains.
        let first_tab = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
        rt.update(|s, tx| crate::workspace::new_tab(s, tx));
        let second_tab = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
        assert_ne!(
            second_tab, first_tab,
            "new_tab must activate a distinct tab"
        );
        rt.update(|s, tx| crate::workspace::select(s, &first_tab, tx));
        assert_eq!(
            rt.state.workspace.as_ref().unwrap().active_key(),
            first_tab,
            "select must return to the original tab"
        );
        rt.state.draft.clear();
        rt.update(|s, tx| assert!(crate::composer::recall::step(s, true, true, tx)));
        assert_eq!(rt.state.draft.text.trim(), "/compact now");
        assert!(crate::composer::command_held(&rt.state));
        assert!(!crate::composer::can_send(&rt.state));

        // An unrelated attempt receipt must not release the hold.
        crate::composer::acknowledge(
            &mut rt.state,
            "cmd_unrelated",
            PromptOutcome::Confirmed("cmd_unrelated".into()),
        );
        assert!(crate::composer::command_held(&rt.state));

        // Exact late receipt releases the hold.
        crate::composer::acknowledge(
            &mut rt.state,
            &attempt,
            PromptOutcome::Confirmed(attempt.clone()),
        );
        assert!(!crate::composer::command_held(&rt.state));
    }
}
