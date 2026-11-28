use super::super::{
    NO_SESSION_DRAFT_ID, RECOVERED_DRAFT_PREFIX, is_local_draft_id, is_recovered_draft_id,
    is_uuid_recovered_draft_id,
};
use super::{Backend, State, Tab, Tx, Ui, same_backend, same_project};
use crate::composer::{
    draft::{Draft, MAX_FILES},
    draft_storage::SavedParts,
};

const MAX_WINDOW_DEVICE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_WINDOW_DEVICE_FILES: usize = super::super::MAX_DRAFTS * MAX_FILES;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct DraftCopy {
    text: Option<String>,
    attachment_draft: bool,
    attachment_parts: Option<SavedParts>,
}

impl DraftCopy {
    pub(super) fn from_parts(
        text: Option<String>,
        attachment_draft: bool,
        attachment_parts: Option<SavedParts>,
    ) -> Option<Self> {
        let text = text.filter(|text| !text.is_empty());
        let attachment_draft = attachment_draft || attachment_parts.is_some();
        let attachment_parts =
            attachment_parts.or_else(|| attachment_draft.then(SavedParts::missing));
        (text.is_some() || attachment_draft || attachment_parts.is_some()).then_some(Self {
            text,
            attachment_draft,
            attachment_parts,
        })
    }

    pub(super) fn from_workspace(saved: &crate::workspace::Workspace, key: &str) -> Option<Self> {
        Self::from_parts(
            saved.drafts.get(key).cloned(),
            saved.attachment_drafts.contains(key),
            saved.attachment_parts.get(key).cloned(),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ClearAuthority {
    /// Hydrated from an explicit persisted `""` tombstone in a v1 snapshot.
    Persisted,
    /// Cleared/sent a specific restored or closed-delivered copy; targets only matching copies.
    Copy(DraftCopy),
    /// Cleared an independent local draft that was not derived from any restored/closed copy;
    /// suppresses older closed entries on reopen without targeting sibling restored copies.
    LocalOnly,
}

impl ClearAuthority {
    pub(super) fn matches_restored(&self, restored: Option<&DraftCopy>) -> bool {
        let Some(restored) = restored else {
            return false;
        };
        match self {
            Self::Persisted => true,
            Self::Copy(origin) => origin == restored,
            Self::LocalOnly => false,
        }
    }
}

pub fn session_deleted_hook(
    s: &State,
    session_id: &str,
) -> Option<std::sync::Arc<dyn Fn() + Send + Sync>> {
    if session_id.is_empty() || is_local_draft_id(session_id) {
        return None;
    }
    let ui = s.workspace.as_ref()?;
    let Tab::Workspace(saved) = &ui.entries.get(ui.active)?.saved else {
        return None;
    };
    let scope = super::ProjectScope::from_workspace(saved);
    let tx = ui.deleted_sessions.0.clone();
    let wake = s.wake.clone();
    let id = session_id.to_owned();
    Some(std::sync::Arc::new(move || {
        let _ = tx.try_send((scope.clone(), id.clone()));
        wake();
    }))
}

pub(super) struct RecoveryOutcome {
    pub(super) recovered: bool,
    pub(super) deferred: bool,
}

pub(super) fn drain_window_deleted_sessions(s: &mut State) -> bool {
    drain_window_deleted_sessions_closing_with_uuid(s, None, || {
        codenomad_client::http::random_uuid_v4().ok()
    })
    .recovered
}

pub(super) fn drain_window_deleted_sessions_closing_with_uuid(
    s: &mut State,
    closing_tab: Option<usize>,
    mut next_uuid: impl FnMut() -> Option<String>,
) -> RecoveryOutcome {
    let incoming: Vec<(super::ProjectScope, String)> = {
        let Some(ui) = &s.workspace else {
            return RecoveryOutcome {
                recovered: false,
                deferred: false,
            };
        };
        let mut items = Vec::new();
        while let Ok(item) = ui.deleted_sessions.1.try_recv() {
            items.push(item);
        }
        items
    };
    let mut recovered = false;
    let mut deferred = false;
    for (scope, id) in incoming {
        let event_closing_tab = closing_tab.filter(|&idx| {
            s.workspace
                .as_ref()
                .and_then(|ui| ui.entries.get(idx))
                .is_some_and(|entry| matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w)))
        });
        let open_idx = s.workspace.as_ref().and_then(|ui| {
            ui.entries
                .iter()
                .enumerate()
                .find_map(|(idx, entry)| {
                    (Some(idx) != event_closing_tab
                        && !entry.closing_deferred
                        && matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w)))
                    .then_some(idx)
                })
                .or_else(|| {
                    ui.entries.iter().position(
                        |entry| matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w)),
                    )
                })
        });
        if let Some(idx) = open_idx {
            let outcome = recover_missing_session_draft_with_uuid_impl(
                s,
                Some(idx),
                event_closing_tab,
                &id,
                &mut next_uuid,
            );
            recovered |= outcome.recovered;
            if closing_tab.is_none() || event_closing_tab.is_some() {
                deferred |= outcome.deferred;
            }
        } else if let Some(ui) = &mut s.workspace {
            ui.forget_closed_unconfirmed_for_scope(&scope, &id);
            if ui
                .closed
                .iter()
                .any(|w| scope.matches(w) && workspace_has_draft_content(w, &id))
                && !ui
                    .closed_pending_deleted
                    .iter()
                    .any(|(existing_scope, existing_id)| {
                        existing_scope.same_scope(&scope) && existing_id == &id
                    })
            {
                ui.closed_pending_deleted.push((scope, id));
                ui.changed();
                ui.stage_with_stashed(s.temporary.stashed_for_snapshot());
            }
        }
    }
    RecoveryOutcome {
        recovered,
        deferred,
    }
}

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
                let mut removed_any = current.drafts.remove(key).is_some();
                removed_any |= current.attachment_drafts.remove(key);
                removed_any |= current.attachment_parts.remove(key).is_some();
                if removed_any {
                    entry.cleared.insert(key.into());
                    entry.restored_drafts.remove(key);
                    entry.superseded_on_delete.remove(key);
                    let auth = match entry.derived_from.remove(key) {
                        Some(origin) => ClearAuthority::Copy(origin),
                        None => ClearAuthority::LocalOnly,
                    };
                    entry.clear_authority.insert(key.into(), auth);
                    persisted_changed = true;
                }
            }
        }
    }
    if let Some(unconfirmed) = matched.as_ref() {
        for (closed_idx, closed) in ui.closed.iter_mut().enumerate() {
            let owns_attempt = ui
                .closed_unconfirmed_attempts
                .get(closed_idx)
                .and_then(|attempts| attempts.get(key))
                .is_some_and(|recorded| recorded == attempt_id);
            if owns_attempt
                && same_project(closed, saved)
                && unconfirmed.matches_saved(
                    closed.drafts.get(key).map(String::as_str),
                    closed.attachment_parts.get(key),
                    closed.attachment_drafts.contains(key),
                )
            {
                let mut removed_closed = closed.drafts.remove(key).is_some();
                removed_closed |= closed.attachment_drafts.remove(key);
                removed_closed |= closed.attachment_parts.remove(key).is_some();
                if let Some(restored) = ui.closed_restored.get_mut(closed_idx) {
                    restored.remove(key);
                }
                if let Some(derived) = ui.closed_derived_from.get_mut(closed_idx) {
                    derived.remove(key);
                }
                if let Some(attempts) = ui.closed_unconfirmed_attempts.get_mut(closed_idx) {
                    attempts.remove(key);
                }
                persisted_changed |= removed_closed;
            }
        }
    }
    if persisted_changed {
        let scope = super::ProjectScope::from_workspace(saved);
        sync_pending_closed_projections(ui, &scope, key);
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
    let active = ui.active;
    let no_session_capture = s.no_session_composer_active() && s.composer.no_session_bound;
    let before = ui.entries.get(active).and_then(|item| match &item.saved {
        Tab::Workspace(w) => {
            let key = match w.active_session_id.as_deref() {
                Some(id) => Some(id),
                None if no_session_capture => Some(NO_SESSION_DRAFT_ID),
                None => None,
            }?;
            Some((
                super::ProjectScope::from_workspace(w),
                key.to_owned(),
                item.clear_authority.get(key).cloned(),
            ))
        }
        Tab::Blank => None,
    });
    let captured = ui
        .entries
        .get_mut(active)
        .is_some_and(|item| capture_draft(item, s));
    let auth_changed = before.as_ref().is_some_and(|(_, id, prev)| {
        ui.entries
            .get(active)
            .is_some_and(|item| item.clear_authority.get(id) != prev.as_ref())
    });
    if captured || auth_changed {
        if let Some((scope, id, _)) = before {
            sync_pending_closed_projections(&mut ui, &scope, &id);
        }
        ui.changed();
    }
    ui.stage_with_stashed(s.temporary.stashed_for_snapshot());
    s.workspace = Some(ui);
    crate::shell::blank_cleanup::abort_if_protected(s);
}

/// Hydrates the active project's `__no_session_draft__` into the composer when viewing a project
/// without a selected session.
pub(crate) fn sync_no_session_draft(s: &mut State) -> bool {
    if !s.no_session_composer_active()
        || s.composer.no_session_bound
        || s.pending_auto_session.is_some()
    {
        return false;
    }
    let Some(mut ui) = s.workspace.take() else {
        s.composer.no_session_bound = true;
        return false;
    };
    let active = ui.active;
    let is_no_session_tab = ui.entries.get(active).is_some_and(
        |item| matches!(&item.saved, Tab::Workspace(w) if w.active_session_id.is_none()),
    );
    if !is_no_session_tab {
        s.workspace = Some(ui);
        return false;
    }
    let mut loaded = false;
    if s.draft.text.is_empty() && s.composer.draft.attachments.is_empty() {
        let _ = deliver_draft(&mut ui, NO_SESSION_DRAFT_ID);
        let item = &ui.entries[active];
        if let Tab::Workspace(saved) = &item.saved {
            let live = item.live_drafts.get(NO_SESSION_DRAFT_ID);
            if let Some((draft, missing)) = live.and_then(|d| d.parts.as_ref()) {
                s.composer.draft = draft.clone();
                s.composer.attachments_missing = *missing;
                loaded |= !s.composer.draft.attachments.is_empty() || *missing;
            } else if let Some(parts) = saved.attachment_parts.get(NO_SESSION_DRAFT_ID) {
                (s.composer.draft, s.composer.attachments_missing) = parts.restore();
                loaded |=
                    !s.composer.draft.attachments.is_empty() || s.composer.attachments_missing;
            } else if saved.attachment_drafts.contains(NO_SESSION_DRAFT_ID) {
                s.composer.attachments_missing = true;
                loaded = true;
            }
            let text = live
                .and_then(|d| d.text.as_ref())
                .or_else(|| saved.drafts.get(NO_SESSION_DRAFT_ID))
                .cloned()
                .unwrap_or_default();
            if !text.is_empty() {
                s.draft = rune::edit::TextEdit::new(text);
                crate::composer::literal::restore(&mut s.draft, &s.composer.draft.literal_spans);
                loaded = true;
            }
        }
    }
    s.composer.no_session_bound = true;
    s.workspace = Some(ui);
    loaded
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
        .unwrap_or(NO_SESSION_DRAFT_ID);
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
    let no_session_capture = s.no_session_composer_active() && s.composer.no_session_bound;
    if let Tab::Workspace(saved) = &mut item.saved
        && let Some(key) = match saved.active_session_id.as_deref() {
            Some(key) if item.binding.as_ref().is_some_and(|b| b.session == key) => {
                Some(key.to_owned())
            }
            None if no_session_capture => Some(NO_SESSION_DRAFT_ID.to_owned()),
            _ => None,
        }
    {
        let key = key.as_str();
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
            item.restored_drafts.remove(key);
            item.superseded_on_delete.remove(key);
            item.cleared.remove(key);
            item.clear_authority.remove(key);
            return false;
        }
        let restored_before = item.restored_drafts.get(key).cloned();
        let parts = SavedParts::capture(draft, missing, edit);
        let had_parts = parts.is_some();
        let mut parts_changed = false;
        parts_changed |= if had_parts {
            saved.attachment_drafts.insert(key.into())
        } else {
            saved.attachment_drafts.remove(key)
        };
        match parts {
            Some(parts) if saved.attachment_parts.get(key) != Some(&parts) => {
                saved.attachment_parts.insert(key.into(), parts);
                parts_changed = true;
            }
            None => parts_changed |= saved.attachment_parts.remove(key).is_some(),
            _ => {}
        }
        changed |= parts_changed;
        let text_changed = if text.is_empty() {
            saved.drafts.remove(key).is_some()
        } else if saved.drafts.get(key).is_none_or(|value| value != text) {
            saved.drafts.insert(key.into(), text.clone());
            true
        } else {
            false
        };
        changed |= text_changed;
        let still_restored = !has_device_parts
            && restored_before
                .as_ref()
                .is_some_and(|orig| DraftCopy::from_workspace(saved, key).as_ref() == Some(orig));
        if !still_restored && (parts_changed || text_changed || has_device_parts) {
            item.restored_drafts.remove(key);
            item.superseded_on_delete.remove(key);
        }
        let now_empty = text.is_empty() && !had_parts && !has_device_parts;
        if now_empty {
            if text_changed || parts_changed {
                item.cleared.insert(key.into());
                let auth = match item.derived_from.remove(key) {
                    Some(origin) => ClearAuthority::Copy(origin),
                    None => ClearAuthority::LocalOnly,
                };
                item.clear_authority.insert(key.into(), auth);
            }
        } else if !still_restored && (text_changed || parts_changed || has_device_parts) {
            item.cleared.remove(key);
            item.clear_authority.remove(key);
        }
    }
    changed
}
pub fn draft_changed(s: &mut State, _: &mut Tx) {
    if s.no_session_composer_active() {
        s.composer.no_session_bound = true;
    }
    s.composer.mark_edited();
    capture(s);
}

pub fn bound(s: &mut State, backend: &Backend) -> String {
    bound_with_adopt(s, backend, false)
}

pub fn bound_with_adopt(s: &mut State, backend: &Backend, adopt_recovered: bool) -> String {
    crate::shell::blank_cleanup::abort_for_session(s, &backend.session);
    crate::composer::recall::restore(s);
    let previous = super::active_session(s).map(str::to_owned);
    let same_session =
        !s.screen.is_launcher() && previous.as_deref() == Some(backend.session.as_str());
    let stream_deleted = if !same_session && previous.is_some() {
        crate::chat::events::drain_outgoing_incoming_deleted(s)
    } else {
        false
    };
    capture(s);
    let outgoing_deleted = if !same_session {
        drain_window_deleted_sessions(s);
        if let Some(prev) = previous.as_deref() {
            let had_pending = s.workspace.as_mut().is_some_and(|ui| {
                let entry = &mut ui.entries[ui.active];
                let pending = entry.pending_deleted.remove(prev) || stream_deleted;
                if pending && let Tab::Workspace(saved) = &mut entry.saved {
                    saved.active_session_id = None;
                }
                pending
            });
            had_pending.then(|| prev.to_owned())
        } else {
            None
        }
    } else {
        None
    };
    if let Some(prev) = outgoing_deleted {
        recover_missing_session_draft(s, &prev);
    }
    if adopt_recovered {
        adopt_recovered_draft(s, &backend.session);
    }
    if !same_session {
        s.composer = Default::default();
    } else {
        s.composer.draft.literal_spans = crate::composer::literal::ranges(&s.draft).collect();
    }
    let Some(ui) = &mut s.workspace else {
        return String::new();
    };
    let delivered = deliver_draft(ui, &backend.session);
    if let Some(Tab::Workspace(saved)) = ui.entries.get(ui.active).map(|e| &e.saved) {
        let scope = super::ProjectScope::from_workspace(saved);
        let session = backend.session.clone();
        note_session_present_in_scope(ui, &scope, &session);
    }
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
    if !same_session
        && item.superseded_on_delete.remove(&backend.session)
        && item.restored_drafts.remove(&backend.session).is_some()
    {
        saved.drafts.remove(&backend.session);
        saved.attachment_drafts.remove(&backend.session);
        saved.attachment_parts.remove(&backend.session);
        item.live_drafts.remove(&backend.session);
        item.derived_from.remove(&backend.session);
    }
    saved.active_session_id = Some(backend.session.clone());
    let live = item.live_drafts.get(&backend.session);
    if !same_session {
        if let Some(unconfirmed) = live.and_then(|draft| draft.unconfirmed.as_ref()) {
            s.composer.restore_unconfirmed(unconfirmed.clone());
        } else if let Some(unconfirmed) = closed_unconfirmed {
            // Preserve the erasable unconfirmed payload ONLY when this tab actually received the
            // closed tab that owned that attempt; otherwise restore an anti-replay lock only so
            // late confirmation cannot erase an independent draft with identical text.
            let owns_draft = matches!(
                &delivered,
                DeliveredClosed::OwnedAttempt(attempt) if attempt == unconfirmed.id()
            );
            let restored = if owns_draft {
                unconfirmed
            } else {
                crate::composer::UnconfirmedPrompt::locked(unconfirmed.id().to_owned())
            };
            s.composer.restore_unconfirmed(restored);
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
enum DeliveredClosed {
    None,
    OwnedAttempt(String),
    Independent,
}

fn deliver_draft(ui: &mut Ui, id: &str) -> DeliveredClosed {
    let item = &ui.entries[ui.active];
    let Tab::Workspace(scope) = &item.saved else {
        return DeliveredClosed::None;
    };
    if !item.pending_drafts.contains(id) {
        return DeliveredClosed::None;
    }
    let scope = scope.clone();
    let project_scope = super::ProjectScope::from_workspace(&scope);
    let clear_authorities = collect_open_clear_authorities(ui, &project_scope, id);
    let closed = peek_closed_state_for_scope(ui, &project_scope, id, &clear_authorities);
    let mut delivered_copy = None;
    let mut delivered_origin = None;
    let mut delivered_closed_idx = None;
    let mut retired_siblings = Vec::new();
    for (index, item) in ui.entries.iter_mut().enumerate() {
        if !matches!(&item.saved, Tab::Workspace(w) if same_project(&scope, w))
            || !item.pending_drafts.remove(id)
        {
            continue;
        }
        if index != ui.active {
            retired_siblings.push(index);
        }
        let Tab::Workspace(saved) = &mut item.saved else {
            continue;
        };
        saved.drafts.remove(id);
        saved.attachment_drafts.remove(id);
        saved.attachment_parts.remove(id);
        item.live_drafts.remove(id);
        item.cleared.remove(id);
        item.clear_authority.remove(id);
        item.restored_drafts.remove(id);
        item.derived_from.remove(id);
        item.superseded_on_delete.remove(id);
        if index == ui.active {
            if let Some(bundle) = closed.bundle.as_ref() {
                if let Some(text) = bundle.text.as_ref()
                    && !text.is_empty()
                {
                    saved.drafts.insert(id.into(), text.clone());
                }
                if bundle.attachment_draft || bundle.attachment_parts.is_some() {
                    saved.attachment_drafts.insert(id.into());
                }
                if let Some(parts) = bundle.attachment_parts.as_ref() {
                    saved.attachment_parts.insert(id.into(), parts.clone());
                }
                delivered_copy = DraftCopy::from_workspace(saved, id);
                delivered_origin = bundle.derived_from.clone();
                delivered_closed_idx = Some(bundle.closed_idx);
                if let Some(origin) = bundle.derived_from.as_ref() {
                    item.derived_from.insert(id.into(), origin.clone());
                }
                if bundle.from_restored
                    && let Some(copy) = delivered_copy.as_ref()
                {
                    item.restored_drafts.insert(id.into(), copy.clone());
                    item.derived_from
                        .entry(id.into())
                        .or_insert_with(|| copy.clone());
                }
            } else if closed.explicitly_cleared {
                item.cleared.insert(id.into());
                item.clear_authority
                    .insert(id.into(), ClearAuthority::Persisted);
            }
        }
    }
    let delivered_outcome = match delivered_closed_idx {
        None => DeliveredClosed::None,
        Some(idx) => match ui
            .closed_unconfirmed_attempts
            .get(idx)
            .and_then(|attempts| attempts.get(id))
            .cloned()
        {
            Some(attempt_id) => DeliveredClosed::OwnedAttempt(attempt_id),
            None => DeliveredClosed::Independent,
        },
    };
    let last_tombstone_idx = ui.closed.iter().enumerate().rev().find_map(|(idx, w)| {
        (same_project(&scope, w)
            && w.drafts.get(id).is_some_and(String::is_empty)
            && !w.attachment_drafts.contains(id)
            && !w.attachment_parts.contains_key(id))
        .then_some(idx)
    });
    for (idx, w) in ui.closed.iter_mut().enumerate() {
        if !same_project(&scope, w) {
            continue;
        }
        let is_restored = ui
            .closed_restored
            .get(idx)
            .is_none_or(|set| set.contains(id));
        let should_remove = if closed.explicitly_cleared {
            true
        } else if delivered_closed_idx == Some(idx)
            || last_tombstone_idx.is_some_and(|tomb| idx <= tomb)
        {
            true
        } else if is_restored {
            let copy = DraftCopy::from_workspace(w, id);
            copy.is_some()
                && (copy == delivered_copy
                    || (delivered_origin.is_some() && copy == delivered_origin)
                    || clear_authorities
                        .iter()
                        .any(|auth| auth.matches_restored(copy.as_ref())))
        } else {
            false
        };
        if should_remove {
            w.drafts.remove(id);
            w.attachment_drafts.remove(id);
            w.attachment_parts.remove(id);
            if let Some(restored) = ui.closed_restored.get_mut(idx) {
                restored.remove(id);
            }
            if let Some(derived) = ui.closed_derived_from.get_mut(idx) {
                derived.remove(id);
            }
            if let Some(attempts) = ui.closed_unconfirmed_attempts.get_mut(idx) {
                attempts.remove(id);
            }
        }
    }
    if !retired_siblings.is_empty()
        && peek_closed_state_for_scope(ui, &project_scope, id, &clear_authorities)
            .bundle
            .is_some()
    {
        for &idx in &retired_siblings {
            ui.entries[idx].pending_drafts.insert(id.into());
        }
        sync_pending_closed_projections(ui, &project_scope, id);
    }
    delivered_outcome
}

/// Projects each remaining admissible closed-tab draft 1-to-1 onto available open tabs that
/// still carry `id` in `pending_drafts`, so a restart before binding persists every distinct
/// closed draft once without duplicating a single closed source across multiple tabs.
pub(super) fn sync_pending_closed_projections(ui: &mut Ui, scope: &super::ProjectScope, id: &str) {
    let pending_tabs: Vec<usize> = ui
        .entries
        .iter()
        .enumerate()
        .filter_map(|(idx, entry)| {
            (entry.pending_drafts.contains(id)
                && matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w)))
            .then_some(idx)
        })
        .collect();
    if pending_tabs.is_empty() {
        return;
    }
    for &idx in &pending_tabs {
        let entry = &mut ui.entries[idx];
        if let Tab::Workspace(saved) = &mut entry.saved {
            saved.drafts.remove(id);
            saved.attachment_drafts.remove(id);
            saved.attachment_parts.remove(id);
        }
        entry.live_drafts.remove(id);
        entry.cleared.remove(id);
        entry.clear_authority.remove(id);
        entry.restored_drafts.remove(id);
        entry.derived_from.remove(id);
        entry.superseded_on_delete.remove(id);
    }
    let clear_authorities = collect_open_clear_authorities(ui, scope, id);
    let (bundles, explicitly_cleared) =
        collect_closed_bundles_for_recovery(ui, scope, id, &clear_authorities);
    if bundles.is_empty() {
        if explicitly_cleared {
            for &idx in &pending_tabs {
                let entry = &mut ui.entries[idx];
                entry.cleared.insert(id.into());
                entry
                    .clear_authority
                    .insert(id.into(), ClearAuthority::Persisted);
            }
        }
        return;
    }
    for (idx, bundle) in pending_tabs.into_iter().zip(bundles) {
        let holder = &mut ui.entries[idx];
        if let Tab::Workspace(saved) = &mut holder.saved {
            if let Some(text) = bundle.text.as_ref()
                && !text.is_empty()
            {
                saved.drafts.insert(id.into(), text.clone());
            }
            if bundle.attachment_draft || bundle.attachment_parts.is_some() {
                saved.attachment_drafts.insert(id.into());
            }
            if let Some(parts) = bundle.attachment_parts.as_ref() {
                saved.attachment_parts.insert(id.into(), parts.clone());
            }
            if let Some(origin) = bundle.derived_from.as_ref() {
                holder.derived_from.insert(id.into(), origin.clone());
            }
            if bundle.from_restored
                && let Some(copy) = DraftCopy::from_workspace(saved, id)
            {
                holder.restored_drafts.insert(id.into(), copy.clone());
                holder.derived_from.entry(id.into()).or_insert(copy);
            }
        }
    }
}

fn live_has_authored_content(draft: &LiveDraft) -> bool {
    draft.text.as_deref().is_some_and(|text| !text.is_empty())
        || draft
            .parts
            .as_ref()
            .is_some_and(|(parts, missing)| !parts.attachments.is_empty() || *missing)
}

fn has_draft_content(item: &super::Entry, saved: &crate::workspace::Workspace, key: &str) -> bool {
    saved.drafts.get(key).is_some_and(|text| !text.is_empty())
        || saved.attachment_drafts.contains(key)
        || saved.attachment_parts.contains_key(key)
        || item
            .live_drafts
            .get(key)
            .is_some_and(live_has_authored_content)
}

fn workspace_has_draft_key(saved: &crate::workspace::Workspace, key: &str) -> bool {
    saved.drafts.contains_key(key)
        || saved.attachment_drafts.contains(key)
        || saved.attachment_parts.contains_key(key)
}

fn workspace_has_draft_content(saved: &crate::workspace::Workspace, key: &str) -> bool {
    saved.drafts.get(key).is_some_and(|text| !text.is_empty())
        || saved.attachment_drafts.contains(key)
        || saved.attachment_parts.contains_key(key)
}

fn project_has_any_draft_key(ui: &Ui, scope: &crate::workspace::Workspace, key: &str) -> bool {
    ui.entries.iter().any(|entry| {
        matches!(&entry.saved, Tab::Workspace(w) if same_project(scope, w)
            && (workspace_has_draft_key(w, key) || entry.live_drafts.contains_key(key)))
    }) || ui
        .closed
        .iter()
        .any(|w| same_project(scope, w) && workspace_has_draft_key(w, key))
}

fn project_has_draft_content(ui: &Ui, scope: &crate::workspace::Workspace, key: &str) -> bool {
    ui.entries.iter().any(|entry| {
        matches!(&entry.saved, Tab::Workspace(w) if same_project(scope, w)
            && has_draft_content(entry, w, key))
    }) || ui
        .closed
        .iter()
        .any(|w| same_project(scope, w) && workspace_has_draft_content(w, key))
}

fn other_project_has_draft_content(
    ui: &Ui,
    exclude_index: usize,
    scope: &crate::workspace::Workspace,
    key: &str,
) -> bool {
    ui.entries.iter().enumerate().any(|(idx, entry)| {
        idx != exclude_index
            && matches!(&entry.saved, Tab::Workspace(w) if same_project(scope, w)
                && has_draft_content(entry, w, key))
    }) || ui
        .closed
        .iter()
        .any(|w| same_project(scope, w) && workspace_has_draft_content(w, key))
}

fn earliest_recovered_draft_id(
    item: &super::Entry,
    saved: &crate::workspace::Workspace,
) -> Option<String> {
    saved
        .drafts
        .keys()
        .chain(saved.attachment_drafts.iter())
        .chain(saved.attachment_parts.keys())
        .chain(item.live_drafts.keys())
        .filter(|id| is_recovered_draft_id(id) && has_draft_content(item, saved, id))
        .min()
        .cloned()
}

struct MovedDraft {
    text: Option<String>,
    had_attachment_flag: bool,
    parts: Option<SavedParts>,
    live: Option<LiveDraft>,
}

fn take_draft_for_move(
    item: &mut super::Entry,
    saved: &mut crate::workspace::Workspace,
    from: &str,
) -> MovedDraft {
    let text = saved.drafts.remove(from);
    let had_attachment_flag = saved.attachment_drafts.remove(from);
    let parts = saved.attachment_parts.remove(from);
    let live = item.live_drafts.remove(from);
    item.cleared.remove(from);
    item.pending_drafts.remove(from);
    MovedDraft {
        text,
        had_attachment_flag,
        parts,
        live,
    }
}

fn insert_moved_draft(
    item: &mut super::Entry,
    saved: &mut crate::workspace::Workspace,
    to: &str,
    moved: MovedDraft,
) {
    if let Some(text) = moved.text
        && !text.is_empty()
    {
        saved.drafts.insert(to.into(), text);
    }
    if moved.had_attachment_flag || moved.parts.is_some() {
        saved.attachment_drafts.insert(to.into());
    }
    if let Some(parts) = moved.parts {
        saved.attachment_parts.insert(to.into(), parts);
    }
    if let Some(live) = moved.live
        && live_has_authored_content(&live)
    {
        // Never carry a dead session's unconfirmed send lock onto a recovered or new draft.
        item.live_drafts.insert(
            to.into(),
            LiveDraft {
                text: live.text.filter(|t| !t.is_empty()),
                parts: live.parts,
                unconfirmed: None,
            },
        );
    }
    item.cleared.remove(to);
}

fn move_draft_between_keys(
    item: &mut super::Entry,
    saved: &mut crate::workspace::Workspace,
    from: &str,
    to: &str,
) {
    let moved = take_draft_for_move(item, saved, from);
    insert_moved_draft(item, saved, to, moved);
}

pub(super) struct ClosedBundle {
    pub(super) closed_idx: usize,
    pub(super) text: Option<String>,
    pub(super) attachment_draft: bool,
    pub(super) attachment_parts: Option<SavedParts>,
    pub(super) from_restored: bool,
    pub(super) derived_from: Option<DraftCopy>,
}

impl ClosedBundle {
    fn has_content(&self) -> bool {
        self.text.as_deref().is_some_and(|t| !t.is_empty())
            || self.attachment_draft
            || self.attachment_parts.is_some()
    }

    fn as_copy(&self) -> Option<DraftCopy> {
        DraftCopy::from_parts(
            self.text.clone(),
            self.attachment_draft,
            self.attachment_parts.clone(),
        )
    }
}

pub(super) struct ClosedState {
    pub(super) bundle: Option<ClosedBundle>,
    pub(super) explicitly_cleared: bool,
}

pub(super) fn collect_open_clear_authorities(
    ui: &Ui,
    scope: &super::ProjectScope,
    session_id: &str,
) -> Vec<ClearAuthority> {
    collect_open_clear_authorities_for(&ui.entries, scope, session_id)
}

pub(super) fn collect_open_clear_authorities_for<'a>(
    entries: impl IntoIterator<Item = &'a super::Entry>,
    scope: &super::ProjectScope,
    session_id: &str,
) -> Vec<ClearAuthority> {
    entries
        .into_iter()
        .filter_map(|entry| {
            let Tab::Workspace(saved) = &entry.saved else {
                return None;
            };
            if !scope.matches(saved)
                || !entry.cleared.contains(session_id)
                || has_draft_content(entry, saved, session_id)
            {
                return None;
            }
            entry.clear_authority.get(session_id).cloned()
        })
        .collect()
}

pub(super) fn peek_closed_state_for_scope(
    ui: &Ui,
    scope: &super::ProjectScope,
    session_id: &str,
    open_clear_authorities: &[ClearAuthority],
) -> ClosedState {
    let (bundles, explicitly_cleared) =
        collect_closed_bundles_for_recovery(ui, scope, session_id, open_clear_authorities);
    let bundle = bundles.into_iter().next();
    ClosedState {
        explicitly_cleared: explicitly_cleared && bundle.is_none(),
        bundle,
    }
}

pub(super) fn collect_closed_bundles_for_recovery(
    ui: &Ui,
    scope: &super::ProjectScope,
    session_id: &str,
    open_clear_authorities: &[ClearAuthority],
) -> (Vec<ClosedBundle>, bool) {
    let mut raw: Vec<ClosedBundle> = Vec::new();
    let mut explicitly_cleared = false;
    for (idx, w) in ui.closed.iter().enumerate() {
        if !scope.matches(w) {
            continue;
        }
        let entry_text = w.drafts.get(session_id);
        let has_att =
            w.attachment_drafts.contains(session_id) || w.attachment_parts.contains_key(session_id);
        if entry_text.is_none() && !has_att {
            continue;
        }
        if entry_text.is_some_and(String::is_empty) && !has_att {
            raw.clear();
            explicitly_cleared = true;
            continue;
        }
        let is_restored = ui
            .closed_restored
            .get(idx)
            .is_none_or(|set| set.contains(session_id));
        if is_restored {
            let copy = DraftCopy::from_workspace(w, session_id);
            if copy.is_some()
                && open_clear_authorities
                    .iter()
                    .any(|auth| auth.matches_restored(copy.as_ref()))
            {
                continue;
            }
        }
        let derived_from = ui
            .closed_derived_from
            .get(idx)
            .and_then(|map| map.get(session_id))
            .cloned()
            .or_else(|| {
                is_restored
                    .then(|| DraftCopy::from_workspace(w, session_id))
                    .flatten()
            });
        let bundle = ClosedBundle {
            closed_idx: idx,
            text: entry_text.filter(|t| !t.is_empty()).cloned(),
            attachment_draft: has_att,
            attachment_parts: w.attachment_parts.get(session_id).cloned(),
            from_restored: is_restored,
            derived_from,
        };
        if bundle.has_content() {
            explicitly_cleared = false;
            raw.push(bundle);
        }
    }
    let mut superseded_origins: Vec<DraftCopy> = Vec::new();
    for bundle in &raw {
        if !bundle.from_restored {
            if let Some(origin) = bundle.derived_from.as_ref() {
                superseded_origins.push(origin.clone());
            }
            if let Some(copy) = bundle.as_copy() {
                superseded_origins.push(copy);
            }
        }
    }
    let mut independent = Vec::new();
    let mut restored = Vec::new();
    let mut seen_restored: Vec<DraftCopy> = Vec::new();
    // Walk newest-first so both independent and restored candidates share one canonical
    // priority order across projection, delivery, and deletion recovery.
    for bundle in raw.into_iter().rev() {
        if bundle.from_restored {
            let Some(copy) = bundle.as_copy() else {
                continue;
            };
            if superseded_origins.contains(&copy) || seen_restored.contains(&copy) {
                continue;
            }
            seen_restored.push(copy);
            restored.push(bundle);
        } else {
            independent.push(bundle);
        }
    }
    independent.extend(restored);
    let cleared = explicitly_cleared && independent.is_empty();
    (independent, cleared)
}

fn purge_closed_session(
    ui: &mut Ui,
    scope: &crate::workspace::Workspace,
    session_id: &str,
) -> bool {
    let mut cleaned = false;
    for (idx, w) in ui.closed.iter_mut().enumerate() {
        if !same_project(scope, w) {
            continue;
        }
        cleaned |= w.drafts.remove(session_id).is_some();
        cleaned |= w.attachment_drafts.remove(session_id);
        cleaned |= w.attachment_parts.remove(session_id).is_some();
        if let Some(restored) = ui.closed_restored.get_mut(idx) {
            restored.remove(session_id);
        }
        if let Some(derived) = ui.closed_derived_from.get_mut(idx) {
            derived.remove(session_id);
        }
        if let Some(attempts) = ui.closed_unconfirmed_attempts.get_mut(idx) {
            attempts.remove(session_id);
        }
    }
    cleaned
}

fn occurrence_in_active_chat_on(
    on_launcher: bool,
    ui: &Ui,
    index: usize,
    session_id: &str,
) -> bool {
    let Some(entry) = ui.entries.get(index) else {
        return false;
    };
    let Tab::Workspace(saved) = &entry.saved else {
        return false;
    };
    if saved.active_session_id.as_deref() != Some(session_id) {
        return false;
    }
    if index == ui.active {
        !on_launcher
    } else {
        entry
            .cache
            .as_ref()
            .is_some_and(|cache| !cache.is_launcher_visible())
    }
}

fn reserve_recovery_keys_with(
    ui: &Ui,
    scope: &crate::workspace::Workspace,
    count: usize,
    mut next_uuid: impl FnMut() -> Option<String>,
) -> Option<Vec<String>> {
    let mut keys = Vec::with_capacity(count);
    let mut no_session_free = !project_has_draft_content(ui, scope, NO_SESSION_DRAFT_ID);
    for _ in 0..count {
        if no_session_free {
            keys.push(NO_SESSION_DRAFT_ID.into());
            no_session_free = false;
            continue;
        }
        let mut allocated = None;
        for _ in 0..8 {
            if let Some(uuid) = next_uuid() {
                let candidate = format!("{RECOVERED_DRAFT_PREFIX}{uuid}");
                if is_uuid_recovered_draft_id(&candidate)
                    && !project_has_any_draft_key(ui, scope, &candidate)
                    && !keys.contains(&candidate)
                {
                    allocated = Some(candidate);
                    break;
                }
            }
        }
        keys.push(allocated?);
    }
    Some(keys)
}

/// Records confirmed deletion of the active conversation (e.g. native `session.deleted`)
/// so its authored draft is recovered as soon as the session is unselected, switched, or closed.
pub fn note_session_deleted(s: &mut State) {
    let Some(id) = super::active_session(s).map(str::to_owned) else {
        return;
    };
    if s.screen.is_launcher() {
        recover_missing_session_draft(s, &id);
        return;
    }
    if let Some(ui) = &mut s.workspace
        && let Some(entry) = ui.entries.get_mut(ui.active)
    {
        entry.pending_deleted.insert(id);
    }
}

/// Recovers authored draft text and attachments from a confirmed-deleted session across
/// all occurrences of the originating project (including `ui.closed` and sibling tabs) into
/// `__no_session_draft__` (or collision-free `__recovered_draft__<uuid>`), matching Solid's
/// `recoverRemovedSessionDraft` (`stores/session-draft-recovery.ts`), and removes the dead
/// session ID from local and persisted draft storage.
pub fn recover_missing_session_draft(s: &mut State, session_id: &str) -> bool {
    recover_missing_session_draft_in(s, None, session_id)
}

pub(super) fn recover_missing_session_draft_in(
    s: &mut State,
    origin_tab: Option<usize>,
    session_id: &str,
) -> bool {
    recover_missing_session_draft_with_uuid_impl(s, origin_tab, None, session_id, || {
        codenomad_client::http::random_uuid_v4().ok()
    })
    .recovered
}

pub(super) fn recover_missing_session_draft_closing_with_uuid(
    s: &mut State,
    closing_tab: usize,
    session_id: &str,
    next_uuid: impl FnMut() -> Option<String>,
) -> RecoveryOutcome {
    recover_missing_session_draft_with_uuid_impl(
        s,
        Some(closing_tab),
        Some(closing_tab),
        session_id,
        next_uuid,
    )
}

#[cfg(test)]
fn recover_missing_session_draft_with_uuid(
    s: &mut State,
    origin_tab: Option<usize>,
    session_id: &str,
    next_uuid: impl FnMut() -> Option<String>,
) -> bool {
    recover_missing_session_draft_with_uuid_impl(s, origin_tab, None, session_id, next_uuid)
        .recovered
}

fn recover_missing_session_draft_with_uuid_impl(
    s: &mut State,
    origin_tab: Option<usize>,
    closing_tab: Option<usize>,
    session_id: &str,
    mut next_uuid: impl FnMut() -> Option<String>,
) -> RecoveryOutcome {
    if session_id.is_empty() || is_local_draft_id(session_id) {
        return RecoveryOutcome {
            recovered: false,
            deferred: false,
        };
    }
    let on_launcher = s.screen.is_launcher();
    let (recovered, deferred, mutated) = {
        let Some(ui) = &mut s.workspace else {
            return RecoveryOutcome {
                recovered: false,
                deferred: false,
            };
        };
        let origin = origin_tab.unwrap_or(ui.active);
        let scope = match ui.entries.get(origin).map(|item| &item.saved) {
            Some(Tab::Workspace(saved)) => saved.clone(),
            _ => {
                return RecoveryOutcome {
                    recovered: false,
                    deferred: false,
                };
            }
        };
        let mut mutated = false;
        let mut recovered = false;

        let matching_tabs: Vec<usize> = ui
            .entries
            .iter()
            .enumerate()
            .filter_map(|(idx, entry)| {
                matches!(&entry.saved, Tab::Workspace(w) if same_project(&scope, w)).then_some(idx)
            })
            .collect();
        let preferred_sibling = matching_tabs
            .iter()
            .copied()
            .find(|&idx| {
                Some(idx) != closing_tab
                    && !ui.entries[idx].closing_deferred
                    && !occurrence_in_active_chat_on(on_launcher, ui, idx, session_id)
            })
            .or_else(|| {
                matching_tabs
                    .iter()
                    .copied()
                    .find(|&idx| Some(idx) != closing_tab && !ui.entries[idx].closing_deferred)
            })
            .or_else(|| {
                closing_tab
                    .and_then(|closing| matching_tabs.iter().copied().find(|&idx| idx != closing))
            });

        let project_scope = super::ProjectScope::from_workspace(&scope);
        // Never deposit background recovery drafts onto a closing_deferred tab when no surviving
        // sibling exists yet; wait until a sibling opens or the user explicitly retries close.
        if closing_tab.is_none()
            && ui.entries[origin].closing_deferred
            && preferred_sibling.is_none()
        {
            ui.entries[origin].pending_deleted.insert(session_id.into());
            if !ui
                .closed_pending_deleted
                .iter()
                .any(|(existing_scope, existing_id)| {
                    existing_scope.same_scope(&project_scope) && existing_id == session_id
                })
            {
                ui.closed_pending_deleted
                    .push((project_scope.clone(), session_id.into()));
                ui.changed();
                ui.stage_with_stashed(s.temporary.stashed_for_snapshot());
            }
            return RecoveryOutcome {
                recovered: false,
                deferred: true,
            };
        }
        let mut clear_authorities = collect_open_clear_authorities(ui, &project_scope, session_id);
        let (closed_bundles, closed_explicitly_cleared) =
            collect_closed_bundles_for_recovery(ui, &project_scope, session_id, &clear_authorities);
        if closed_explicitly_cleared {
            clear_authorities.push(ClearAuthority::Persisted);
        }

        let open_to_recover: Vec<usize> = matching_tabs
            .iter()
            .copied()
            .filter(|&idx| {
                if Some(idx) != closing_tab
                    && occurrence_in_active_chat_on(on_launcher, ui, idx, session_id)
                {
                    return false;
                }
                if ui.entries[idx].pending_drafts.contains(session_id) {
                    return false;
                }
                let restored = ui.entries[idx].restored_drafts.get(session_id);
                let superseded_restored =
                    (ui.entries[idx].superseded_on_delete.contains(session_id)
                        && restored.is_some())
                        || clear_authorities
                            .iter()
                            .any(|auth| auth.matches_restored(restored));
                !superseded_restored
                    && matches!(
                        &ui.entries[idx].saved,
                        Tab::Workspace(saved) if has_draft_content(&ui.entries[idx], saved, session_id)
                    )
            })
            .collect();

        // Reserve every recovery slot (both closed and open occurrences) atomically before
        // mutating any tab so a UUID allocation failure never partially modifies an open tab
        // or drops pending_deleted / clear_authority.
        let total_slots = closed_bundles.len() + open_to_recover.len();
        let reserved = if total_slots == 0 {
            Some(Vec::new())
        } else {
            reserve_recovery_keys_with(ui, &scope, total_slots, &mut next_uuid)
        };

        let Some(all_targets) = reserved else {
            ui.entries[origin].pending_deleted.insert(session_id.into());
            for &idx in &open_to_recover {
                ui.entries[idx].pending_deleted.insert(session_id.into());
            }
            let added_closed =
                !ui.closed_pending_deleted
                    .iter()
                    .any(|(existing_scope, existing_id)| {
                        existing_scope.same_scope(&project_scope) && existing_id == session_id
                    });
            if added_closed {
                ui.closed_pending_deleted
                    .push((project_scope.clone(), session_id.into()));
                if !closed_bundles.is_empty() {
                    ui.changed();
                    ui.stage_with_stashed(s.temporary.stashed_for_snapshot());
                }
            }
            return RecoveryOutcome {
                recovered: false,
                deferred: true,
            };
        };

        let mut targets = all_targets.into_iter();
        if !closed_bundles.is_empty() {
            let closed_target_tab = if closing_tab == Some(origin)
                || ui.entries[origin].closing_deferred
                || occurrence_in_active_chat_on(on_launcher, ui, origin, session_id)
            {
                preferred_sibling.unwrap_or(origin)
            } else {
                origin
            };
            for bundle in closed_bundles {
                let target = targets.next().expect("reserved closed recovery key");
                if let Some(entry) = ui.entries.get_mut(closed_target_tab)
                    && let Tab::Workspace(saved) = &mut entry.saved
                {
                    if let Some(text) = bundle.text
                        && !text.is_empty()
                    {
                        saved.drafts.insert(target.clone(), text);
                    }
                    if bundle.attachment_draft || bundle.attachment_parts.is_some() {
                        saved.attachment_drafts.insert(target.clone());
                    }
                    if let Some(parts) = bundle.attachment_parts {
                        saved.attachment_parts.insert(target.clone(), parts);
                    }
                    entry.cleared.remove(&target);
                    entry.clear_authority.remove(&target);
                    entry.pending_drafts.remove(&target);
                    entry.restored_drafts.remove(&target);
                    entry.derived_from.remove(&target);
                    entry.superseded_on_delete.remove(&target);
                    recovered = true;
                    mutated = true;
                }
                if let Some(w) = ui.closed.get_mut(bundle.closed_idx) {
                    w.drafts.remove(session_id);
                    w.attachment_drafts.remove(session_id);
                    w.attachment_parts.remove(session_id);
                }
                if let Some(restored) = ui.closed_restored.get_mut(bundle.closed_idx) {
                    restored.remove(session_id);
                }
                if let Some(derived) = ui.closed_derived_from.get_mut(bundle.closed_idx) {
                    derived.remove(session_id);
                }
                if let Some(attempts) = ui.closed_unconfirmed_attempts.get_mut(bundle.closed_idx) {
                    attempts.remove(session_id);
                }
            }
        }

        mutated |= purge_closed_session(ui, &scope, session_id);
        // Clear undelivered copies from sibling pending_drafts before moving independent edits.
        for &idx in &matching_tabs {
            if Some(idx) != closing_tab
                && occurrence_in_active_chat_on(on_launcher, ui, idx, session_id)
            {
                continue;
            }
            let entry = &mut ui.entries[idx];
            if entry.pending_drafts.remove(session_id)
                && let Tab::Workspace(saved) = &mut entry.saved
            {
                mutated |= saved.drafts.remove(session_id).is_some();
                mutated |= saved.attachment_drafts.remove(session_id);
                mutated |= saved.attachment_parts.remove(session_id).is_some();
                mutated |= entry.live_drafts.remove(session_id).is_some();
                mutated |= entry.cleared.remove(session_id);
                entry.clear_authority.remove(session_id);
                entry.restored_drafts.remove(session_id);
                entry.derived_from.remove(session_id);
                entry.superseded_on_delete.remove(session_id);
            }
        }

        // Recover independent drafts (or clean remnants) across every same-project occurrence.
        for &idx in &matching_tabs {
            if Some(idx) != closing_tab
                && occurrence_in_active_chat_on(on_launcher, ui, idx, session_id)
            {
                ui.entries[idx].pending_deleted.insert(session_id.into());
                if clear_authorities.iter().any(|auth| {
                    auth.matches_restored(ui.entries[idx].restored_drafts.get(session_id))
                }) {
                    ui.entries[idx]
                        .superseded_on_delete
                        .insert(session_id.into());
                }
                continue;
            }
            let target = open_to_recover
                .contains(&idx)
                .then(|| targets.next().expect("reserved open recovery key"));
            ui.entries[idx].pending_deleted.remove(session_id);
            let entry = &mut ui.entries[idx];
            let Tab::Workspace(mut saved) = std::mem::replace(&mut entry.saved, Tab::Blank) else {
                continue;
            };
            if saved.active_session_id.as_deref() == Some(session_id) {
                saved.active_session_id = None;
                if let Some(binding) = entry.binding.as_mut()
                    && binding.session == session_id
                {
                    binding.session.clear();
                }
                mutated = true;
            }
            if let Some(target) = target {
                if (Some(idx) == closing_tab || entry.closing_deferred)
                    && let Some(dest_idx) = preferred_sibling
                {
                    let moved = take_draft_for_move(entry, &mut saved, session_id);
                    entry.clear_authority.remove(session_id);
                    entry.restored_drafts.remove(session_id);
                    entry.derived_from.remove(session_id);
                    entry.superseded_on_delete.remove(session_id);
                    entry.saved = Tab::Workspace(saved);
                    if let Some(dest) = ui.entries.get_mut(dest_idx) {
                        let Tab::Workspace(mut dest_saved) =
                            std::mem::replace(&mut dest.saved, Tab::Blank)
                        else {
                            continue;
                        };
                        insert_moved_draft(dest, &mut dest_saved, &target, moved);
                        dest.clear_authority.remove(&target);
                        dest.pending_drafts.remove(&target);
                        dest.restored_drafts.remove(&target);
                        dest.derived_from.remove(&target);
                        dest.superseded_on_delete.remove(&target);
                        dest.saved = Tab::Workspace(dest_saved);
                    }
                    recovered = true;
                    mutated = true;
                    continue;
                }
                move_draft_between_keys(entry, &mut saved, session_id, &target);
                entry.clear_authority.remove(session_id);
                entry.clear_authority.remove(&target);
                entry.restored_drafts.remove(session_id);
                entry.restored_drafts.remove(&target);
                entry.derived_from.remove(session_id);
                entry.derived_from.remove(&target);
                entry.superseded_on_delete.remove(session_id);
                entry.superseded_on_delete.remove(&target);
                recovered = true;
                mutated = true;
            } else {
                mutated |= saved.drafts.remove(session_id).is_some();
                mutated |= saved.attachment_drafts.remove(session_id);
                mutated |= saved.attachment_parts.remove(session_id).is_some();
                mutated |= entry.live_drafts.remove(session_id).is_some();
                mutated |= entry.cleared.remove(session_id);
                mutated |= entry.pending_drafts.remove(session_id);
                entry.clear_authority.remove(session_id);
                entry.restored_drafts.remove(session_id);
                entry.derived_from.remove(session_id);
                entry.superseded_on_delete.remove(session_id);
            }
            entry.saved = Tab::Workspace(saved);
        }

        let any_eligible_deferred = matching_tabs.iter().any(|&idx| {
            ui.entries[idx].pending_deleted.contains(session_id)
                && (Some(idx) == closing_tab
                    || !occurrence_in_active_chat_on(on_launcher, ui, idx, session_id))
        });
        if !any_eligible_deferred {
            ui.closed_pending_deleted
                .retain(|(c_scope, c_id)| !(c_scope.matches(&scope) && c_id == session_id));
            ui.forget_closed_unconfirmed_session(&scope, session_id);
        }

        if mutated {
            ui.changed();
            ui.stage_with_stashed(s.temporary.stashed_for_snapshot());
        }
        (recovered, false, mutated)
    };
    let _ = mutated;
    if recovered {
        let message = crate::strings::with_locale(crate::settings::app_locale(s), || {
            crate::strings::t("sessionState.cleanup.draftRecovered")
        });
        crate::shell::notifications::emit(
            s,
            crate::shell::notifications::Category::Projects,
            None,
            message,
        );
    }
    RecoveryOutcome {
        recovered,
        deferred,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RestoredProbeOutcome {
    Resolved,
    Transient(u64),
}

pub(super) struct RestoredProbeResult {
    pub scope: super::ProjectScope,
    pub id: String,
    pub connection_generation: u64,
    pub backend_base: String,
    pub started_epoch: u64,
    pub absence: Option<Option<codenomad_client::catalog::SessionAbsence>>,
}

pub(super) struct RestoredProbeTarget {
    pub scope: super::ProjectScope,
    pub backend: Backend,
    pub project: crate::catalog::Project,
    pub connection_generation: u64,
}

const RESTORED_DRAFT_PROBE_CAP: usize = super::super::MAX_DRAFTS * 2;

fn current_probe_connection(s: &State) -> Option<(u64, String)> {
    let l = s.screen.launcher()?;
    if l.authentication_required {
        return None;
    }
    let conn = l.connection.as_ref()?;
    Some((l.connection_generation, conn.base.clone()))
}

fn scope_has_restored_key(ui: &Ui, scope: &super::ProjectScope, id: &str) -> bool {
    !is_local_draft_id(id)
        && ui.entries.iter().any(|entry| {
            matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w))
                && entry.restored_drafts.contains_key(id)
        })
}

fn scope_has_in_flight_key(ui: &Ui, scope: &super::ProjectScope, id: &str) -> bool {
    ui.restored_draft_in_flight
        .iter()
        .any(|(sc, existing_id, _)| sc.same_scope(scope) && existing_id == id)
}

fn set_restored_probe_outcome(
    ui: &mut Ui,
    scope: &super::ProjectScope,
    id: &str,
    outcome: RestoredProbeOutcome,
) {
    if !scope_has_restored_key(ui, scope, id) {
        return;
    }
    if let Some((_, _, existing)) = ui
        .restored_draft_checked
        .iter_mut()
        .find(|(sc, existing_id, _)| sc.same_scope(scope) && existing_id == id)
    {
        if *existing != RestoredProbeOutcome::Resolved {
            *existing = outcome;
        }
    } else {
        ui.restored_draft_checked
            .push((scope.clone(), id.to_owned(), outcome));
    }
}

pub(super) fn note_sessions_present_in_scope_epochs<I>(
    ui: &mut Ui,
    scope: &super::ProjectScope,
    proofs: I,
) where
    I: IntoIterator<Item = (String, u64)>,
{
    for (id, epoch) in proofs {
        note_session_present_in_scope_at(ui, scope, &id, epoch);
    }
}

fn note_session_present_in_scope(ui: &mut Ui, scope: &super::ProjectScope, id: &str) {
    if is_local_draft_id(id) {
        return;
    }
    let relevant = scope_has_restored_key(ui, scope, id) || scope_has_in_flight_key(ui, scope, id);
    if !relevant {
        return;
    }
    let epoch = ui
        .restored_draft_presence_epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        .wrapping_add(1);
    note_session_present_in_scope_at(ui, scope, id, epoch);
}

fn note_session_present_in_scope_at(
    ui: &mut Ui,
    scope: &super::ProjectScope,
    id: &str,
    epoch: u64,
) {
    if is_local_draft_id(id) {
        return;
    }
    let relevant = scope_has_restored_key(ui, scope, id) || scope_has_in_flight_key(ui, scope, id);
    if !relevant {
        return;
    }
    if let Some((_, _, existing_epoch)) = ui
        .restored_draft_seen_present
        .iter_mut()
        .find(|(sc, existing_id, _)| sc.same_scope(scope) && existing_id == id)
    {
        *existing_epoch = (*existing_epoch).max(epoch);
    } else {
        ui.restored_draft_seen_present
            .push((scope.clone(), id.to_owned(), epoch));
    }
    if !scope_has_in_flight_key(ui, scope, id) {
        set_restored_probe_outcome(ui, scope, id, RestoredProbeOutcome::Resolved);
    }
}

fn prune_restored_probe_state(ui: &mut Ui, current_conn_gen: Option<u64>) {
    let live_restored: Vec<(super::ProjectScope, String)> = {
        let mut keys = Vec::new();
        for entry in &ui.entries {
            let Tab::Workspace(w) = &entry.saved else {
                continue;
            };
            let scope = super::ProjectScope::from_workspace(w);
            for id in entry.restored_drafts.keys() {
                if !is_local_draft_id(id)
                    && !keys
                        .iter()
                        .any(|(sc, existing): &(super::ProjectScope, String)| {
                            sc.same_scope(&scope) && existing == id
                        })
                {
                    keys.push((scope.clone(), id.clone()));
                }
            }
        }
        keys
    };
    let in_live = |scope: &super::ProjectScope, id: &str| {
        live_restored
            .iter()
            .any(|(sc, existing)| sc.same_scope(scope) && existing == id)
    };
    ui.restored_draft_checked
        .retain(|(sc, id, _)| in_live(sc, id));
    let in_flight = &ui.restored_draft_in_flight;
    ui.restored_draft_seen_present.retain(|(sc, id, _)| {
        in_live(sc, id)
            || in_flight
                .iter()
                .any(|(f_sc, f_id, _)| f_sc.same_scope(sc) && f_id == id)
    });
    ui.restored_draft_targets.retain(|target| {
        current_conn_gen.is_none_or(|cg| target.connection_generation == cg)
            && live_restored.iter().any(|(sc, id)| {
                sc.same_scope(&target.scope)
                    && !ui.restored_draft_checked.iter().any(|(c_sc, c_id, out)| {
                        c_sc.same_scope(sc)
                            && c_id == id
                            && (*out == RestoredProbeOutcome::Resolved
                                || *out
                                    == RestoredProbeOutcome::Transient(
                                        target.connection_generation,
                                    ))
                    })
            })
    });
}

fn session_currently_bound_in_scope(s: &State, scope: &super::ProjectScope, id: &str) -> bool {
    let Some(ui) = &s.workspace else {
        return false;
    };
    let active_matches = ui
        .entries
        .get(ui.active)
        .is_some_and(|e| matches!(&e.saved, Tab::Workspace(w) if scope.matches(w)));
    if active_matches && !s.screen.is_launcher() && super::active_session(s) == Some(id) {
        return true;
    }
    ui.entries.iter().any(|entry| {
        matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w) && w.active_session_id.as_deref() == Some(id))
            && entry.binding.as_ref().is_some_and(|b| b.session == id)
    })
}

fn pump_restored_draft_probes(s: &mut State) {
    let Some((conn_gen, backend_base)) = current_probe_connection(s) else {
        return;
    };
    let batches: Vec<(
        super::ProjectScope,
        Backend,
        crate::catalog::Project,
        std::sync::Arc<std::sync::atomic::AtomicU64>,
        Vec<String>,
        codenomad_client::Sender<RestoredProbeResult>,
    )> = {
        let Some(ui) = &mut s.workspace else {
            return;
        };
        prune_restored_probe_state(ui, Some(conn_gen));
        let targets: Vec<(super::ProjectScope, Backend, crate::catalog::Project)> = ui
            .restored_draft_targets
            .iter()
            .filter(|t| t.connection_generation == conn_gen && t.backend.base == backend_base)
            .map(|t| (t.scope.clone(), t.backend.clone(), t.project.clone()))
            .collect();
        let mut launched = Vec::new();
        for (scope, backend, project) in targets {
            let in_flight_count = ui
                .restored_draft_in_flight
                .iter()
                .filter(|(sc, _, cg)| sc.same_scope(&scope) && *cg == conn_gen)
                .count();
            let available = RESTORED_DRAFT_PROBE_CAP.saturating_sub(in_flight_count);
            if available == 0 {
                continue;
            }
            let order =
                std::iter::once(ui.active).chain((0..ui.entries.len()).filter(|&i| i != ui.active));
            let mut to_check = Vec::new();
            for idx in order {
                let entry = &ui.entries[idx];
                if !matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w)) {
                    continue;
                }
                for id in entry.restored_drafts.keys() {
                    if is_local_draft_id(id)
                        || to_check.iter().any(|existing| existing == id)
                        || ui
                            .restored_draft_checked
                            .iter()
                            .any(|(sc, existing_id, out)| {
                                sc.same_scope(&scope)
                                    && existing_id == id
                                    && (*out == RestoredProbeOutcome::Resolved
                                        || *out == RestoredProbeOutcome::Transient(conn_gen))
                            })
                        || ui
                            .restored_draft_in_flight
                            .iter()
                            .any(|(sc, existing_id, cg)| {
                                sc.same_scope(&scope) && existing_id == id && *cg == conn_gen
                            })
                    {
                        continue;
                    }
                    to_check.push(id.clone());
                    if to_check.len() >= available {
                        break;
                    }
                }
                if to_check.len() >= available {
                    break;
                }
            }
            if to_check.is_empty() {
                continue;
            }
            let presence_epoch = ui.restored_draft_presence_epoch.clone();
            for id in &to_check {
                ui.restored_draft_in_flight
                    .push((scope.clone(), id.clone(), conn_gen));
            }
            launched.push((
                scope,
                backend,
                project,
                presence_epoch,
                to_check,
                ui.restored_draft_checks.0.clone(),
            ));
        }
        launched
    };
    let wake = s.wake.clone();
    for (scope, backend, project, presence_epoch, ids, out) in batches {
        let wake = wake.clone();
        let backend_base = backend.base.clone();
        crate::platform::spawn(async move {
            for id in ids {
                let started_epoch = presence_epoch
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                    .wrapping_add(1);
                let absence = backend.probe_session_absence(&project, &id).await;
                if out
                    .send(RestoredProbeResult {
                        scope: scope.clone(),
                        id,
                        connection_generation: conn_gen,
                        backend_base: backend_base.clone(),
                        started_epoch,
                        absence,
                    })
                    .await
                    .is_err()
                {
                    return;
                }
                wake();
            }
        });
    }
}

/// Records fresh presence proof for listed/created sessions in the active workspace scope
/// without cancelling any in-flight absence probes.
pub fn note_restored_draft_sessions_present(
    s: &mut State,
    listed: &std::collections::HashSet<String>,
) {
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let Some(Tab::Workspace(active_ws)) = ui.entries.get(ui.active).map(|e| &e.saved) else {
        return;
    };
    let scope = super::ProjectScope::from_workspace(active_ws);
    for id in listed {
        note_session_present_in_scope(ui, &scope, id);
    }
}

/// Starts bounded, project-scoped absence checks for hydrated non-local draft session IDs not
/// already present in `listed`, checked, or in-flight. Runs immediately on project open (even
/// when the listing is paginated); only a confirmed 404 from the current connection that is not
/// contradicted by fresher presence proof triggers draft recovery.
pub fn check_restored_draft_sessions(
    s: &mut State,
    backend: &Backend,
    project: &crate::catalog::Project,
    listed: &std::collections::HashSet<String>,
) {
    let Some((conn_gen, backend_base)) = current_probe_connection(s) else {
        return;
    };
    if backend.base != backend_base {
        return;
    }
    if let Some(ui) = &mut s.workspace
        && let Some(Tab::Workspace(active_ws)) = ui.entries.get(ui.active).map(|e| &e.saved)
    {
        let scope = super::ProjectScope::from_workspace(active_ws);
        for id in listed {
            note_session_present_in_scope(ui, &scope, id);
        }
        if let Some(existing) = ui
            .restored_draft_targets
            .iter_mut()
            .find(|t| t.scope.same_scope(&scope))
        {
            existing.backend = backend.clone();
            existing.project = project.clone();
            existing.connection_generation = conn_gen;
        } else {
            ui.restored_draft_targets.push(RestoredProbeTarget {
                scope,
                backend: backend.clone(),
                project: project.clone(),
                connection_generation: conn_gen,
            });
        }
    }
    pump_restored_draft_probes(s);
}

/// Resumes restored-draft absence checks for already-open projects belonging to the newly
/// reauthenticated connection (covering openings that completed while `authentication_required`
/// was armed and transient failures from an earlier connection generation). Never reuses
/// pre-reauthentication `listed_sessions` as fresh presence proof for the new generation.
pub fn resume_restored_draft_checks(
    s: &mut State,
    live_ids: Option<&std::collections::HashSet<String>>,
) {
    let Some((backend, backend_id, server_id, conn_gen)) = s.screen.launcher().and_then(|l| {
        if l.authentication_required {
            return None;
        }
        let backend = l.connection.clone()?;
        let backend_id = (!l.local_connection()).then(|| {
            if cfg!(target_arch = "wasm32") {
                "web".to_owned()
            } else {
                "external".to_owned()
            }
        });
        Some((
            backend,
            backend_id,
            l.server_id.clone(),
            l.connection_generation,
        ))
    }) else {
        return;
    };
    if let Some(ui) = &mut s.workspace {
        let mut scopes = Vec::new();
        for entry in &ui.entries {
            let Tab::Workspace(w) = &entry.saved else {
                continue;
            };
            let Some(project) = &entry.project else {
                continue;
            };
            if w.backend_id != backend_id
                || (backend_id.is_some() && w.server_id != server_id)
                || live_ids.is_some_and(|ids| !ids.contains(&project.id))
            {
                continue;
            }
            let scope = super::ProjectScope::from_workspace(w);
            if !scopes
                .iter()
                .any(|(sc, _): &(super::ProjectScope, crate::catalog::Project)| {
                    sc.same_scope(&scope)
                })
            {
                scopes.push((scope, project.clone()));
            }
        }
        for (scope, project) in scopes {
            if let Some(existing) = ui
                .restored_draft_targets
                .iter_mut()
                .find(|t| t.scope.same_scope(&scope))
            {
                existing.backend = backend.clone();
                existing.project = project;
                existing.connection_generation = conn_gen;
            } else {
                ui.restored_draft_targets.push(RestoredProbeTarget {
                    scope,
                    backend: backend.clone(),
                    project,
                    connection_generation: conn_gen,
                });
            }
        }
    }
    pump_restored_draft_probes(s);
}

pub(super) fn poll_restored_draft_checks(s: &mut State) -> bool {
    let completed: Vec<_> = {
        let Some(ui) = &mut s.workspace else {
            return false;
        };
        let mut items = Vec::new();
        while let Ok(item) = ui.restored_draft_checks.1.try_recv() {
            items.push(item);
        }
        items
    };
    if completed.is_empty() {
        return false;
    }
    let active_conn = current_probe_connection(s);
    let mut deleted = Vec::new();
    for result in completed {
        let bound_now = session_currently_bound_in_scope(s, &result.scope, &result.id);
        let Some(ui) = &mut s.workspace else {
            break;
        };
        ui.restored_draft_in_flight
            .retain(|(existing_scope, existing_id, existing_gen)| {
                !(existing_scope.same_scope(&result.scope)
                    && existing_id == &result.id
                    && *existing_gen == result.connection_generation)
            });
        let Some((current_gen, ref current_base)) = active_conn else {
            continue;
        };
        if result.connection_generation != current_gen || result.backend_base != *current_base {
            continue;
        }
        let contradicted_by_presence = bound_now
            || ui
                .restored_draft_seen_present
                .iter()
                .any(|(sc, existing_id, epoch)| {
                    sc.same_scope(&result.scope)
                        && existing_id == &result.id
                        && *epoch > result.started_epoch
                });
        if contradicted_by_presence {
            set_restored_probe_outcome(
                ui,
                &result.scope,
                &result.id,
                RestoredProbeOutcome::Resolved,
            );
            continue;
        }
        match result.absence {
            Some(absence) => {
                set_restored_probe_outcome(
                    ui,
                    &result.scope,
                    &result.id,
                    RestoredProbeOutcome::Resolved,
                );
                if absence == Some(codenomad_client::catalog::SessionAbsence::NotFound) {
                    deleted.push((result.scope, result.id));
                }
            }
            None => {
                set_restored_probe_outcome(
                    ui,
                    &result.scope,
                    &result.id,
                    RestoredProbeOutcome::Transient(result.connection_generation),
                );
            }
        }
    }
    let mut changed = false;
    for (scope, id) in deleted {
        let target_idx = s.workspace.as_ref().and_then(|ui| {
            ui.entries
                .iter()
                .enumerate()
                .find_map(|(idx, entry)| {
                    (!entry.closing_deferred
                        && matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w)))
                    .then_some(idx)
                })
                .or_else(|| {
                    ui.entries.iter().position(
                        |entry| matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w)),
                    )
                })
        });
        if let Some(idx) = target_idx {
            changed |= recover_missing_session_draft_in(s, Some(idx), &id);
        } else if let Some(ui) = &mut s.workspace
            && !ui
                .closed_pending_deleted
                .iter()
                .any(|(existing_scope, existing_id)| {
                    existing_scope.same_scope(&scope) && existing_id == &id
                })
        {
            ui.closed_pending_deleted.push((scope, id));
            ui.changed();
            ui.stage_with_stashed(s.temporary.stashed_for_snapshot());
        }
    }
    pump_restored_draft_probes(s);
    changed
}

/// Retries any deferred deletion recoveries (e.g. after temporary UUID entropy failure or
/// reopening a project whose closed occurrence carried pending deletion proof) once eligible.
pub(super) fn poll_pending_deleted(s: &mut State) -> bool {
    let on_launcher = s.screen.is_launcher();
    let eligible: Vec<(usize, String)> = {
        let Some(ui) = &s.workspace else {
            return false;
        };
        let mut work: Vec<(usize, String)> = Vec::new();
        let seen = |work: &[(usize, String)], idx: usize, id: &str| {
            let Tab::Workspace(scope) = &ui.entries[idx].saved else {
                return true;
            };
            work.iter().any(|(other_idx, existing)| {
                existing == id
                    && matches!(&ui.entries[*other_idx].saved, Tab::Workspace(w) if same_project(scope, w))
            })
        };
        let surviving_for = |idx: usize, id: &str| -> Option<usize> {
            let Tab::Workspace(scope) = &ui.entries[idx].saved else {
                return None;
            };
            ui.entries.iter().enumerate().find_map(|(other, entry)| {
                (!entry.closing_deferred
                    && matches!(&entry.saved, Tab::Workspace(w) if same_project(scope, w))
                    && !occurrence_in_active_chat_on(on_launcher, ui, other, id))
                .then_some(other)
            })
        };
        for (idx, entry) in ui.entries.iter().enumerate() {
            for id in &entry.pending_deleted {
                let target_idx = if entry.closing_deferred {
                    surviving_for(idx, id)
                } else if !occurrence_in_active_chat_on(on_launcher, ui, idx, id) {
                    Some(idx)
                } else {
                    None
                };
                if let Some(target) = target_idx
                    && !seen(&work, target, id)
                {
                    work.push((target, id.clone()));
                }
            }
        }
        for (scope, id) in &ui.closed_pending_deleted {
            if let Some(idx) = ui.entries.iter().enumerate().find_map(|(idx, entry)| {
                (!entry.closing_deferred
                    && matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w))
                    && !occurrence_in_active_chat_on(on_launcher, ui, idx, id))
                .then_some(idx)
            }) && !seen(&work, idx, id)
            {
                work.push((idx, id.clone()));
            }
        }
        work
    };
    let mut changed = false;
    for (idx, id) in eligible {
        changed |= recover_missing_session_draft_with_uuid_impl(s, Some(idx), None, &id, || {
            codenomad_client::http::random_uuid_v4().ok()
        })
        .recovered;
    }
    changed
}

/// Adopts the next recovered draft (`__no_session_draft__`, or the earliest queued
/// `__recovered_draft__<uuid>`) into a newly created blank session so it opens directly
/// in the conversation composer, promoting any next queued recovered draft into
/// `__no_session_draft__`.
pub fn adopt_recovered_draft(s: &mut State, session_id: &str) -> bool {
    if session_id.is_empty() || is_local_draft_id(session_id) {
        return false;
    }
    let Some(ui) = &mut s.workspace else {
        return false;
    };
    let pending_local: Vec<String> = ui
        .entries
        .get(ui.active)
        .map(|item| {
            item.pending_drafts
                .iter()
                .filter(|id| is_local_draft_id(id))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    for id in pending_local {
        deliver_draft(ui, &id);
    }
    let active_idx = ui.active;
    let scope = match ui.entries.get(active_idx).map(|item| &item.saved) {
        Some(Tab::Workspace(saved)) => saved.clone(),
        _ => return false,
    };
    let no_session_occupied_elsewhere =
        other_project_has_draft_content(ui, active_idx, &scope, NO_SESSION_DRAFT_ID);
    let Some(item) = ui.entries.get_mut(active_idx) else {
        return false;
    };
    let Tab::Workspace(mut saved) = std::mem::replace(&mut item.saved, Tab::Blank) else {
        return false;
    };
    if has_draft_content(item, &saved, session_id) {
        item.saved = Tab::Workspace(saved);
        return false;
    }
    let source = if has_draft_content(item, &saved, NO_SESSION_DRAFT_ID) {
        Some(NO_SESSION_DRAFT_ID.to_owned())
    } else {
        earliest_recovered_draft_id(item, &saved)
    };
    let Some(source) = source else {
        item.saved = Tab::Workspace(saved);
        return false;
    };
    move_draft_between_keys(item, &mut saved, &source, session_id);
    item.clear_authority.remove(&source);
    item.clear_authority.remove(session_id);
    item.restored_drafts.remove(&source);
    item.restored_drafts.remove(session_id);
    item.derived_from.remove(&source);
    item.derived_from.remove(session_id);
    item.superseded_on_delete.remove(&source);
    item.superseded_on_delete.remove(session_id);
    if !no_session_occupied_elsewhere
        && !has_draft_content(item, &saved, NO_SESSION_DRAFT_ID)
        && let Some(next_recovered) = earliest_recovered_draft_id(item, &saved)
    {
        move_draft_between_keys(item, &mut saved, &next_recovered, NO_SESSION_DRAFT_ID);
        item.clear_authority.remove(&next_recovered);
        item.clear_authority.remove(NO_SESSION_DRAFT_ID);
        item.restored_drafts.remove(&next_recovered);
        item.restored_drafts.remove(NO_SESSION_DRAFT_ID);
        item.derived_from.remove(&next_recovered);
        item.derived_from.remove(NO_SESSION_DRAFT_ID);
        item.superseded_on_delete.remove(&next_recovered);
        item.superseded_on_delete.remove(NO_SESSION_DRAFT_ID);
    }
    item.saved = Tab::Workspace(saved);
    ui.changed();
    ui.stage_with_stashed(s.temporary.stashed_for_snapshot());
    true
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

    #[test]
    fn failed_closed_recovery_reservation_is_atomic_and_preserves_pending_deleted() {
        let mut s = crate::init();
        s.show_launcher();
        let mut ui = Ui::new();
        ui.fixture_ready();
        let make_ws = |occ: u64, text: Option<&str>| crate::workspace::Workspace {
            backend_id: None,
            server_id: None,
            folder: "/repo".into(),
            project_name: None,
            temporary: false,
            occurrence: occ,
            workspace_id: Some("ws".into()),
            active_session_id: None,
            drafts: text
                .map(|t| [("ses_fail_res".to_string(), t.to_string())].into())
                .unwrap_or_default(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        };
        ui.entries[0].saved = Tab::Workspace(make_ws(0, None));
        ui.closed = vec![
            make_ws(1, Some("closed first")),
            make_ws(2, Some("closed second")),
        ];
        ui.closed_restored = vec![Default::default(), Default::default()];
        ui.closed_derived_from = vec![Default::default(), Default::default()];
        s.workspace = Some(ui);

        // Failing UUID allocation on the second slot must move neither closed draft AND preserve
        // pending_deleted on the origin tab even though origin holds no draft under ses_fail_res.
        assert!(!recover_missing_session_draft_with_uuid(
            &mut s,
            Some(0),
            "ses_fail_res",
            || None,
        ));
        let ui = s.workspace.as_ref().unwrap();
        assert!(ui.entries[0].pending_deleted.contains("ses_fail_res"));
        assert_eq!(
            ui.closed[0].drafts.get("ses_fail_res").map(String::as_str),
            Some("closed first")
        );
        assert_eq!(
            ui.closed[1].drafts.get("ses_fail_res").map(String::as_str),
            Some("closed second")
        );
        let Tab::Workspace(origin) = &ui.entries[0].saved else {
            panic!("expected workspace");
        };
        assert!(origin.drafts.is_empty());

        // Subsequent retry with working UUID recovers BOTH closed drafts and clears pending_deleted.
        assert!(poll_pending_deleted(&mut s));
        let ui = s.workspace.as_ref().unwrap();
        assert!(!ui.entries[0].pending_deleted.contains("ses_fail_res"));
        let Tab::Workspace(origin) = &ui.entries[0].saved else {
            panic!("expected workspace");
        };
        assert_eq!(
            origin.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
            Some("closed second")
        );
        assert!(origin.drafts.values().any(|v| v == "closed first"));

        // R11 Moyen 1: Restored copy X in ui.closed + open sibling holding Copy(X) clear
        // authority + two independent closed drafts. Failed UUID reservation must preserve the
        // open sibling's clear authority so retry recovers the two independent drafts without
        // resurrecting X.
        let mut s2 = crate::init();
        s2.show_launcher();
        let mut ui2 = Ui::new();
        ui2.fixture_ready();
        let make_ws2 = |occ: u64, text: Option<&str>| crate::workspace::Workspace {
            backend_id: None,
            server_id: None,
            folder: "/repo".into(),
            project_name: None,
            temporary: false,
            occurrence: occ,
            workspace_id: Some("ws".into()),
            active_session_id: None,
            drafts: text
                .map(|t| [("ses_r11_auth".to_string(), t.to_string())].into())
                .unwrap_or_default(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        };
        let copy_x = DraftCopy::from_parts(Some("cleared X".into()), false, None).unwrap();
        ui2.entries[0].saved = Tab::Workspace(make_ws2(0, None));
        ui2.entries[0].cleared.insert("ses_r11_auth".into());
        ui2.entries[0]
            .clear_authority
            .insert("ses_r11_auth".into(), ClearAuthority::Copy(copy_x));
        ui2.closed = vec![
            make_ws2(1, Some("cleared X")),
            make_ws2(2, Some("indep 1")),
            make_ws2(3, Some("indep 2")),
        ];
        ui2.closed_restored = vec![
            ["ses_r11_auth".to_string()].into(),
            Default::default(),
            Default::default(),
        ];
        ui2.closed_derived_from = vec![Default::default(), Default::default(), Default::default()];
        s2.workspace = Some(ui2);
        assert!(!recover_missing_session_draft_with_uuid(
            &mut s2,
            Some(0),
            "ses_r11_auth",
            || None,
        ));
        assert!(
            s2.workspace.as_ref().unwrap().entries[0]
                .clear_authority
                .contains_key("ses_r11_auth"),
            "failed reservation must preserve open clear_authority for retry"
        );
        assert!(poll_pending_deleted(&mut s2));
        let Tab::Workspace(after2) = &s2.workspace.as_ref().unwrap().entries[0].saved else {
            panic!("expected workspace");
        };
        assert!(after2.drafts.values().any(|v| v == "indep 1"));
        assert!(after2.drafts.values().any(|v| v == "indep 2"));
        assert!(
            !after2.drafts.values().any(|v| v == "cleared X"),
            "retry must not resurrect X cleared by open sibling"
        );

        // R12 Moyen 2: SSE deletion arrives while Tab 0 displays the deleted session in active
        // chat and Tab 1 (same project) is eligible on launcher. If UUID reservation fails once,
        // project-level retry lets Tab 1 recover the closed drafts on the next poll even while
        // Tab 0 remains in active chat.
        let mut s3 = crate::init();
        s3.show_chat();
        let mut ui3 = Ui::new();
        ui3.fixture_ready();
        let make_ws3 =
            |occ: u64, active_id: Option<&str>, text: Option<&str>| crate::workspace::Workspace {
                backend_id: None,
                server_id: None,
                folder: "/repo".into(),
                project_name: None,
                temporary: false,
                occurrence: occ,
                workspace_id: Some("ws".into()),
                active_session_id: active_id.map(str::to_owned),
                drafts: text
                    .map(|t| [("ses_r12_act".to_string(), t.to_string())].into())
                    .unwrap_or_default(),
                attachment_drafts: Default::default(),
                attachment_parts: Default::default(),
                view: Default::default(),
            };
        ui3.entries[0].saved =
            Tab::Workspace(make_ws3(0, Some("ses_r12_act"), Some("open active")));
        ui3.entries.push(super::super::entry(
            "tab-1".into(),
            Tab::Workspace(make_ws3(1, None, None)),
        ));
        ui3.active = 0;
        ui3.closed = vec![
            make_ws3(2, None, Some("closed one")),
            make_ws3(3, None, Some("closed two")),
        ];
        ui3.closed_restored = vec![Default::default(), Default::default()];
        ui3.closed_derived_from = vec![Default::default(), Default::default()];
        s3.workspace = Some(ui3);
        assert!(!recover_missing_session_draft_with_uuid(
            &mut s3,
            Some(0),
            "ses_r12_act",
            || None,
        ));
        assert!(
            !s3.workspace
                .as_ref()
                .unwrap()
                .closed_pending_deleted
                .is_empty(),
            "failed reservation while origin is in active chat must arm project-level retry"
        );
        // Tab 0 is STILL in active chat, yet Tab 1 is eligible and recovers both closed drafts.
        assert!(poll_pending_deleted(&mut s3));
        let ui3 = s3.workspace.as_ref().unwrap();
        assert!(ui3.closed_pending_deleted.is_empty());
        assert!(ui3.entries[0].pending_deleted.contains("ses_r12_act"));
        let Tab::Workspace(tab1) = &ui3.entries[1].saved else {
            panic!("expected workspace tab 1");
        };
        assert!(tab1.drafts.values().any(|v| v == "closed one"));
        assert!(tab1.drafts.values().any(|v| v == "closed two"));

        // R13 Moyen 2: UUID reservation fails while Tab 0 is in active chat and NO sibling tab
        // exists yet; when a sibling tab opens later, `poll_pending_deleted` recovers the closed
        // drafts onto the new sibling while Tab 0 stays in active chat.
        let mut s4 = crate::init();
        s4.show_chat();
        let mut ui4 = Ui::new();
        ui4.fixture_ready();
        ui4.entries[0].saved =
            Tab::Workspace(make_ws3(0, Some("ses_r12_act"), Some("open active 4")));
        ui4.active = 0;
        ui4.closed = vec![
            make_ws3(1, None, Some("late closed one")),
            make_ws3(2, None, Some("late closed two")),
        ];
        ui4.closed_restored = vec![Default::default(), Default::default()];
        ui4.closed_derived_from = vec![Default::default(), Default::default()];
        s4.workspace = Some(ui4);
        assert!(!recover_missing_session_draft_with_uuid(
            &mut s4,
            Some(0),
            "ses_r12_act",
            || None,
        ));
        // No eligible tab yet -> poll stays quiet and keeps retry armed.
        assert!(!poll_pending_deleted(&mut s4));
        // A sibling tab for the same project arrives later (e.g. via `opened`).
        let ui4 = s4.workspace.as_mut().unwrap();
        ui4.entries.push(super::super::entry(
            "tab-1".into(),
            Tab::Workspace(make_ws3(3, None, None)),
        ));
        assert!(poll_pending_deleted(&mut s4));
        let ui4 = s4.workspace.as_ref().unwrap();
        assert!(ui4.closed_pending_deleted.is_empty());
        assert!(ui4.entries[0].pending_deleted.contains("ses_r12_act"));
        let Tab::Workspace(late_tab1) = &ui4.entries[1].saved else {
            panic!("expected workspace tab 1");
        };
        assert!(late_tab1.drafts.values().any(|v| v == "late closed one"));
        assert!(late_tab1.drafts.values().any(|v| v == "late closed two"));
    }

    #[test]
    fn late_confirmation_clears_only_owning_closed_tab_and_syncs_reopened_projection() {
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
        backend.session = "ses-shared".into();

        let mut rt = rune::Runtime::new(s, crate::view, (800.0, 600.0), rune::Env::new(false, 1.0));
        // Open BOTH Tab B and Tab A concurrently so each authors "same text" independently
        // (neither inherits the other's closed draft).
        rt.state.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut rt.state, &project);
        let _ = bound(&mut rt.state, &backend);
        rt.state.draft = rune::edit::TextEdit::new("same text");
        capture(&mut rt.state);
        let tab_b = rt.state.workspace.as_ref().unwrap().active_key().to_owned();

        // Tab A opens while Tab B is still open, binds ses-shared independently, and authors "same text".
        rt.update(crate::workspace::new_tab);
        rt.state.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut rt.state, &project);
        let _ = bound(&mut rt.state, &backend);
        rt.state.phase = crate::Phase::Ready;
        rt.state.commands = Some(sender.clone());
        rt.state.draft = rune::edit::TextEdit::new("same text");
        capture(&mut rt.state);
        let tab_a = rt.state.workspace.as_ref().unwrap().active_key().to_owned();

        // Close Tab B first (independent closed draft with no unconfirmed attempt).
        rt.update(|s, tx| crate::workspace::close(s, &tab_b, tx));

        // Tab A now sends its own "same text", receives Unconfirmed, and closes.
        rt.update(|s, tx| crate::composer::send(s, tx, false));
        let Command::Prompt(prompt) = receiver.try_recv().unwrap() else {
            panic!("expected prompt command")
        };
        let attempt_id = prompt.id.expect("prompt id");
        crate::composer::acknowledge(&mut rt.state, &attempt_id, PromptOutcome::Unconfirmed);
        capture(&mut rt.state);
        rt.update(crate::workspace::new_tab);
        rt.update(|s, tx| crate::workspace::close(s, &tab_a, tx));

        // Tab C: reopened on the same project with a pending closed projection, not bound to ses-shared.
        rt.state.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut rt.state, &project);
        let saved_scope = match &rt.state.workspace.as_ref().unwrap().entries
            [rt.state.workspace.as_ref().unwrap().active]
            .saved
        {
            Tab::Workspace(w) => w.clone(),
            Tab::Blank => panic!("expected workspace tab C"),
        };

        // Late confirmation arrives: must erase ONLY Tab A's closed copy (index 1), keep Tab B's
        // independent closed copy (index 0) intact, and bump revision.
        let rev_before = rt.state.workspace.as_ref().unwrap().revision;
        let mut ui = rt.state.workspace.take().unwrap();
        assert_eq!(ui.closed.len(), 2);
        assert!(ui.closed_unconfirmed_attempts[0].is_empty());
        assert_eq!(
            ui.closed_unconfirmed_attempts[1]
                .get("ses-shared")
                .map(String::as_str),
            Some(attempt_id.as_str())
        );
        confirm_unconfirmed_for(
            &mut rt.state,
            &mut ui,
            &saved_scope,
            "ses-shared",
            &attempt_id,
        );
        assert!(
            ui.revision > rev_before,
            "clearing a closed unconfirmed draft must mark workspace dirty"
        );
        assert_eq!(
            ui.closed[0].drafts.get("ses-shared").map(String::as_str),
            Some("same text"),
            "independent closed Tab B draft (index 0) must survive Tab A's late confirmation"
        );
        assert_eq!(
            ui.closed[1].drafts.get("ses-shared"),
            None,
            "owning closed Tab A draft (index 1) must be cleared by Tab A's late confirmation"
        );
        rt.state.workspace = Some(ui);

        // Reverse close order (Blocker #1): Tab A closes FIRST with unconfirmed "same text",
        // then Tab B closes SECOND with independent "same text". Tab C opens and binds ses-shared
        // (receiving Tab B's newer draft). Late confirmation of Tab A must release Tab C's lock
        // WITHOUT erasing Tab B's draft in Tab C, while erasing Tab A's closed copy.
        let mut s_rev = crate::init();
        crate::gallery::shell::fixture(&mut s_rev);
        let mut ui_rev = Ui::new();
        ui_rev.fixture_ready();
        s_rev.workspace = Some(ui_rev);
        let mut rt_rev = rune::Runtime::new(
            s_rev,
            crate::view,
            (800.0, 600.0),
            rune::Env::new(false, 1.0),
        );
        rt_rev.state.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut rt_rev.state, &project);
        let _ = bound(&mut rt_rev.state, &backend);
        rt_rev.state.phase = crate::Phase::Ready;
        rt_rev.state.commands = Some(sender.clone());
        rt_rev.state.draft = rune::edit::TextEdit::new("same text");
        rt_rev.update(|s, tx| crate::composer::send(s, tx, false));
        let Command::Prompt(prompt_rev) = receiver.try_recv().unwrap() else {
            panic!("expected prompt command")
        };
        let attempt_rev = prompt_rev.id.expect("prompt id");
        crate::composer::acknowledge(&mut rt_rev.state, &attempt_rev, PromptOutcome::Unconfirmed);
        capture(&mut rt_rev.state);
        let tab_a_rev = rt_rev
            .state
            .workspace
            .as_ref()
            .unwrap()
            .active_key()
            .to_owned();

        // Tab B opens while Tab A is open, binds ses-shared independently, and authors "same text".
        rt_rev.update(crate::workspace::new_tab);
        rt_rev.state.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut rt_rev.state, &project);
        let _ = bound(&mut rt_rev.state, &backend);
        rt_rev.state.draft = rune::edit::TextEdit::new("same text");
        capture(&mut rt_rev.state);
        let tab_b_rev = rt_rev
            .state
            .workspace
            .as_ref()
            .unwrap()
            .active_key()
            .to_owned();

        // Close Tab A FIRST (ui.closed[0]), then Tab B SECOND (ui.closed[1]).
        rt_rev.update(|s, tx| crate::workspace::close(s, &tab_a_rev, tx));
        rt_rev.update(crate::workspace::new_tab);
        rt_rev.update(|s, tx| crate::workspace::close(s, &tab_b_rev, tx));

        // Tab C opens and binds ses-shared -> receives Tab B's independent draft + anti-replay lock.
        rt_rev.state.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut rt_rev.state, &project);
        let delivered_text = bound(&mut rt_rev.state, &backend);
        assert_eq!(delivered_text, "same text");
        rt_rev.state.draft = rune::edit::TextEdit::new(delivered_text);
        assert_eq!(
            rt_rev.state.composer.unconfirmed_id(),
            Some(attempt_rev.as_str()),
            "Tab C must still carry the anti-replay lock until Tab A's attempt settles"
        );
        // Tab A's attempt confirms: Tab C's lock clears, Tab B's draft survives in Tab C,
        // and Tab A's closed copy in ui.closed[0] is cleared.
        confirm_unconfirmed(&mut rt_rev.state, &attempt_rev);
        assert_eq!(rt_rev.state.composer.unconfirmed_id(), None);
        assert_eq!(
            rt_rev.state.draft.text, "same text",
            "late confirmation of Tab A must not erase Tab B's delivered independent draft"
        );
        let ui_rev = rt_rev.state.workspace.as_ref().unwrap();
        assert_eq!(
            ui_rev.closed[0].drafts.get("ses-shared"),
            None,
            "Tab A's closed copy must still be cleared on confirmation"
        );

        // Now test when ONLY Tab A was in ui.closed (no independent Tab B): clearing the closed
        // copy must also clear Tab C's pending closed projection so restart cannot resurrect it.
        let mut s2 = crate::init();
        crate::gallery::shell::fixture(&mut s2);
        let mut ui2 = Ui::new();
        ui2.fixture_ready();
        s2.workspace = Some(ui2);
        let mut rt2 =
            rune::Runtime::new(s2, crate::view, (800.0, 600.0), rune::Env::new(false, 1.0));
        rt2.state.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut rt2.state, &project);
        let _ = bound(&mut rt2.state, &backend);
        rt2.state.phase = crate::Phase::Ready;
        rt2.state.commands = Some(sender);
        rt2.state.draft = rune::edit::TextEdit::new("only sent once");
        rt2.update(|s, tx| crate::composer::send(s, tx, false));
        let Command::Prompt(prompt2) = receiver.try_recv().unwrap() else {
            panic!("expected prompt command")
        };
        let attempt_id2 = prompt2.id.expect("prompt id");
        crate::composer::acknowledge(&mut rt2.state, &attempt_id2, PromptOutcome::Unconfirmed);
        capture(&mut rt2.state);
        let tab_a2 = rt2
            .state
            .workspace
            .as_ref()
            .unwrap()
            .active_key()
            .to_owned();
        rt2.update(crate::workspace::new_tab);
        rt2.update(|s, tx| crate::workspace::close(s, &tab_a2, tx));
        rt2.state.screen.launcher_mut().unwrap().project = Some(project);
        crate::workspace::opened(
            &mut rt2.state,
            &crate::catalog::Project {
                id: "ws".into(),
                path: "/repo".into(),
                temporary: false,
            },
        );
        let saved_scope2 = match &rt2.state.workspace.as_ref().unwrap().entries
            [rt2.state.workspace.as_ref().unwrap().active]
            .saved
        {
            Tab::Workspace(w) => {
                assert_eq!(
                    w.drafts.get("ses-shared").map(String::as_str),
                    Some("only sent once"),
                    "reopened tab should project closed draft before confirmation"
                );
                w.clone()
            }
            Tab::Blank => panic!("expected workspace tab"),
        };
        let mut ui2 = rt2.state.workspace.take().unwrap();
        confirm_unconfirmed_for(
            &mut rt2.state,
            &mut ui2,
            &saved_scope2,
            "ses-shared",
            &attempt_id2,
        );
        let Tab::Workspace(tab_c2) = &ui2.entries[ui2.active].saved else {
            panic!("expected workspace tab");
        };
        assert!(
            !tab_c2.drafts.contains_key("ses-shared"),
            "late confirmation clearing only a closed copy must resync reopened projections"
        );
    }

    #[test]
    fn deleted_session_recovery_releases_closed_unconfirmed_locks() {
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
        s.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut s, &project);
        let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        backend.workspace = "ws".into();
        backend.session = "ses-active".into();
        let _ = bound(&mut s, &backend);
        let saved_ws = match &s.workspace.as_ref().unwrap().entries[0].saved {
            Tab::Workspace(w) => w.clone(),
            Tab::Blank => panic!("expected workspace"),
        };
        {
            let ui = s.workspace.as_mut().unwrap();
            for index in 0..super::super::MAX_UNCONFIRMED_LOCKS {
                ui.remember_closed_unconfirmed(
                    &saved_ws,
                    format!("ses-dead-{index}"),
                    crate::composer::UnconfirmedPrompt::locked(format!("msg_dead_{index}")),
                );
            }
            assert_eq!(
                ui.closed_unconfirmed_count(),
                super::super::MAX_UNCONFIRMED_LOCKS
            );
        }
        s.composer
            .restore_unconfirmed(crate::composer::UnconfirmedPrompt::locked(
                "msg_active".into(),
            ));
        assert!(unconfirmed_drafts_full(&s));
        recover_missing_session_draft(&mut s, "ses-dead-0");
        assert_eq!(
            s.workspace.as_ref().unwrap().closed_unconfirmed_count(),
            super::super::MAX_UNCONFIRMED_LOCKS - 1
        );
        assert!(
            !unconfirmed_drafts_full(&s),
            "recovering a deleted session must free its orphaned closed_unconfirmed lock"
        );

        // Medium #3: when NO tab of the project is open and there is NO closed draft left,
        // draining a deleted-session hook must STILL release its closed_unconfirmed lock.
        let hook_no_tab = session_deleted_hook(&s, "ses-dead-1").expect("hook");
        {
            let ui = s.workspace.as_mut().unwrap();
            ui.entries.clear();
            ui.entries
                .push(super::super::entry("tab-blank".into(), Tab::Blank));
            ui.active = 0;
            ui.closed.clear();
            ui.closed_restored.clear();
            ui.closed_derived_from.clear();
            ui.closed_unconfirmed_attempts.clear();
        }
        hook_no_tab();
        let before_count = s.workspace.as_ref().unwrap().closed_unconfirmed_count();
        let _ = drain_window_deleted_sessions(&mut s);
        assert_eq!(
            s.workspace.as_ref().unwrap().closed_unconfirmed_count(),
            before_count - 1,
            "deleted session arriving with no open project tabs must still release its closed_unconfirmed lock"
        );
    }

    #[test]
    fn closing_active_tab_drains_queued_confirmation_before_session_deleted_recovery() {
        use crate::transport::{Command, Event, PromptOutcome};
        let (cmd_tx, cmd_rx) = codenomad_client::bounded(4);
        let (ev_tx, ev_rx) = codenomad_client::bounded(8);
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
        backend.session = "ses-confirm-close".into();
        let mut rt = rune::Runtime::new(s, crate::view, (800.0, 600.0), rune::Env::new(false, 1.0));
        // Keep a sibling tab open on the same project so any recovered draft would land there.
        rt.state.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut rt.state, &project);
        rt.update(crate::workspace::new_tab);
        rt.state.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut rt.state, &project);
        let _ = bound(&mut rt.state, &backend);
        rt.state.phase = crate::Phase::Ready;
        rt.state.commands = Some(cmd_tx.clone());
        rt.state.incoming = Some(ev_rx);
        rt.state.draft = rune::edit::TextEdit::new("already sent");
        rt.update(|s, tx| crate::composer::send(s, tx, false));
        let Command::Prompt(prompt) = cmd_rx.try_recv().unwrap() else {
            panic!("expected prompt command")
        };
        let attempt_id = prompt.id.expect("prompt id");
        crate::composer::acknowledge(&mut rt.state, &attempt_id, PromptOutcome::Unconfirmed);
        capture(&mut rt.state);

        // Queue the late confirmation in incoming AND trigger the ingress session.deleted hook
        // before closing the active tab.
        ev_tx
            .try_send(Event::InboxDelta(
                codenomad_client::inbox::InboxDelta::Removed(attempt_id),
            ))
            .unwrap();
        let hook = session_deleted_hook(&rt.state, &backend.session).expect("hook");
        hook();
        let active_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
        rt.update(|s, tx| crate::workspace::close(s, &active_key, tx));

        let ui = rt.state.workspace.as_ref().unwrap();
        let any_resurrected = ui
            .entries
            .iter()
            .filter_map(|e| match &e.saved {
                Tab::Workspace(w) => Some(w),
                Tab::Blank => None,
            })
            .chain(ui.closed.iter())
            .any(|w| w.drafts.values().any(|text| text == "already sent"));
        assert!(
            !any_resurrected,
            "queued confirmation on active tab must clear prompt before session.deleted recovery"
        );

        // Medium #4: same scenario when closing an INACTIVE cached tab with queued confirmation
        // and session.deleted already buffered.
        let (ev_tx2, ev_rx2) = codenomad_client::bounded(8);
        backend.session = "ses-confirm-close-inactive".into();
        rt.update(crate::workspace::new_tab);
        rt.state.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut rt.state, &project);
        let _ = bound(&mut rt.state, &backend);
        rt.state.phase = crate::Phase::Ready;
        rt.state.commands = Some(cmd_tx);
        rt.state.incoming = Some(ev_rx2);
        rt.state.draft = rune::edit::TextEdit::new("already sent inactive");
        rt.update(|s, tx| crate::composer::send(s, tx, false));
        let Command::Prompt(prompt2) = cmd_rx.try_recv().unwrap() else {
            panic!("expected prompt command")
        };
        let attempt_id2 = prompt2.id.expect("prompt id");
        crate::composer::acknowledge(&mut rt.state, &attempt_id2, PromptOutcome::Unconfirmed);
        capture(&mut rt.state);
        let inactive_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
        let hook2 = session_deleted_hook(&rt.state, &backend.session).expect("hook");
        // Switch away so the tab becomes an inactive cached tab.
        rt.update(crate::workspace::new_tab);
        // Queue late confirmation + SessionDeleted into the inactive tab's incoming channel and
        // fire the ingress hook before closing that inactive tab.
        ev_tx2
            .try_send(Event::InboxDelta(
                codenomad_client::inbox::InboxDelta::Removed(attempt_id2),
            ))
            .unwrap();
        ev_tx2.try_send(Event::SessionDeleted).unwrap();
        hook2();
        rt.update(|s, tx| crate::workspace::close(s, &inactive_key, tx));

        let ui = rt.state.workspace.as_ref().unwrap();
        let any_inactive_resurrected = ui
            .entries
            .iter()
            .filter_map(|e| match &e.saved {
                Tab::Workspace(w) => Some(w),
                Tab::Blank => None,
            })
            .chain(ui.closed.iter())
            .any(|w| {
                w.drafts
                    .values()
                    .any(|text| text == "already sent inactive")
            });
        assert!(
            !any_inactive_resurrected,
            "queued confirmation on inactive cached tab must clear prompt before session.deleted recovery"
        );
    }

    #[test]
    fn unselect_and_rebind_drain_queued_confirmation_before_session_deleted_recovery() {
        use crate::transport::{Command, Event, PromptOutcome};

        let mut rt = rune::Runtime::new(
            crate::init(),
            crate::view,
            (800.0, 600.0),
            rune::Env::new(false, 1.0),
        );
        let mut ui = Ui::new();
        ui.fixture_ready();
        rt.state.workspace = Some(ui);
        rt.state.screen = crate::Screen::Launcher(Box::new(crate::launcher::Launcher::fixture()));
        let project = crate::catalog::Project {
            id: "ws".into(),
            path: "/repo".into(),
            temporary: false,
        };
        let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        backend.workspace = "ws".into();
        backend.session = "ses-unselect".into();
        let (cmd_tx, cmd_rx) = codenomad_client::bounded(8);
        let (ev_tx, ev_rx) = codenomad_client::bounded(8);
        rt.state.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut rt.state, &project);
        let _ = bound(&mut rt.state, &backend);
        rt.state.phase = crate::Phase::Ready;
        rt.state.commands = Some(cmd_tx.clone());
        rt.state.incoming = Some(ev_rx);
        rt.state.draft = rune::edit::TextEdit::new("confirmed before unselect");
        rt.update(|s, tx| crate::composer::send(s, tx, false));
        let Command::Prompt(prompt) = cmd_rx.try_recv().unwrap() else {
            panic!("expected prompt command")
        };
        let attempt_id = prompt.id.expect("prompt id");
        crate::composer::acknowledge(&mut rt.state, &attempt_id, PromptOutcome::Unconfirmed);
        capture(&mut rt.state);

        // Queue InboxDelta confirmation ahead of SessionDeleted, then unselect the session.
        ev_tx
            .try_send(Event::InboxDelta(
                codenomad_client::inbox::InboxDelta::Removed(attempt_id),
            ))
            .unwrap();
        ev_tx.try_send(Event::SessionDeleted).unwrap();
        assert!(crate::workspace::unselect_session(
            &mut rt.state,
            "ses-unselect"
        ));
        let ui = rt.state.workspace.as_ref().unwrap();
        let resurrected_unselect = ui.entries.iter().any(|e| {
            matches!(&e.saved, Tab::Workspace(w) if w.drafts.values().any(|t| t == "confirmed before unselect"))
        });
        assert!(
            !resurrected_unselect,
            "unselect_session must process queued InboxDelta confirmation before SessionDeleted recovery"
        );

        // Repeat the same check when switching sessions via bound_with_adopt.
        let (ev_tx2, ev_rx2) = codenomad_client::bounded(8);
        backend.session = "ses-rebind-a".into();
        let _ = bound(&mut rt.state, &backend);
        rt.state.phase = crate::Phase::Ready;
        rt.state.commands = Some(cmd_tx.clone());
        rt.state.incoming = Some(ev_rx2);
        rt.state.draft = rune::edit::TextEdit::new("confirmed before rebind");
        rt.update(|s, tx| crate::composer::send(s, tx, false));
        let Command::Prompt(prompt2) = cmd_rx.try_recv().unwrap() else {
            panic!("expected prompt command")
        };
        let attempt_id2 = prompt2.id.expect("prompt id");
        crate::composer::acknowledge(&mut rt.state, &attempt_id2, PromptOutcome::Unconfirmed);
        capture(&mut rt.state);

        ev_tx2
            .try_send(Event::InboxDelta(
                codenomad_client::inbox::InboxDelta::Removed(attempt_id2),
            ))
            .unwrap();
        ev_tx2.try_send(Event::SessionDeleted).unwrap();
        let mut next_backend = backend.clone();
        next_backend.session = "ses-rebind-b".into();
        let _ = bound(&mut rt.state, &next_backend);

        let ui = rt.state.workspace.as_ref().unwrap();
        let resurrected_rebind = ui.entries.iter().any(|e| {
            matches!(&e.saved, Tab::Workspace(w) if w.drafts.values().any(|t| t == "confirmed before rebind"))
        });
        assert!(
            !resurrected_rebind,
            "bound_with_adopt must process queued InboxDelta confirmation before SessionDeleted recovery"
        );

        // Also test the real bound-conversation path where InboxDelta arrives on the Reader lane
        // while SessionDeleted arrives on s.incoming before leaving via unselect_session / bound.
        let (ev_tx3, ev_rx3) = codenomad_client::bounded(8);
        let (mut reader3, lane3) = crate::chat::reader::Reader::fixture_open();
        reader3.install(false);
        let gen3 = reader3.generation();
        backend.session = "ses-reader-lane".into();
        let _ = bound(&mut rt.state, &backend);
        rt.state.phase = crate::Phase::Ready;
        rt.state.commands = Some(cmd_tx);
        rt.state.incoming = Some(ev_rx3);
        rt.state.reader = Some(reader3);
        rt.state.draft = rune::edit::TextEdit::new("confirmed via reader lane");
        rt.update(|s, tx| crate::composer::send(s, tx, false));
        let Command::Prompt(prompt3) = cmd_rx.try_recv().unwrap() else {
            panic!("expected prompt command")
        };
        let attempt_id3 = prompt3.id.expect("prompt id");
        crate::composer::acknowledge(&mut rt.state, &attempt_id3, PromptOutcome::Unconfirmed);
        capture(&mut rt.state);

        lane3
            .events
            .try_send((
                gen3,
                0,
                Event::InboxDelta(codenomad_client::inbox::InboxDelta::Removed(attempt_id3)),
            ))
            .unwrap();
        ev_tx3.try_send(Event::SessionDeleted).unwrap();
        let mut next_backend3 = backend.clone();
        next_backend3.session = "ses-reader-next".into();
        let _ = bound(&mut rt.state, &next_backend3);

        let ui = rt.state.workspace.as_ref().unwrap();
        let resurrected_reader = ui.entries.iter().any(|e| {
            matches!(&e.saved, Tab::Workspace(w) if w.drafts.values().any(|t| t == "confirmed via reader lane"))
        });
        assert!(
            !resurrected_reader,
            "bound_with_adopt must drain queued InboxDelta confirmations from the Reader lane before SessionDeleted recovery"
        );
    }

    #[test]
    fn stashed_projection_and_project_name_budget_in_deferred_fallback() {
        let make_ws =
            |folder: &str, active: Option<&str>, drafts: &[(&str, &str)]| super::super::Workspace {
                backend_id: None,
                server_id: None,
                folder: folder.into(),
                project_name: None,
                temporary: false,
                occurrence: 1,
                workspace_id: None,
                active_session_id: active.map(str::to_owned),
                drafts: drafts
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                    .collect(),
                attachment_drafts: Default::default(),
                attachment_parts: Default::default(),
                view: Default::default(),
            };
        // Medium #2: a stashed temporary tab holding a pending projection must count toward
        // projected_count in snapshot_with_stashed so the deferred closed draft is not duplicated
        // under __no_session_draft__.
        let mut ui = Ui::new();
        ui.fixture_ready();
        let mut closed_ws = make_ws(
            "/tmp/stashed-proj",
            Some("ses-del"),
            &[("ses-del", "only once")],
        );
        closed_ws.temporary = true;
        let scope = super::super::ProjectScope::from_workspace(&closed_ws);
        ui.closed.push(closed_ws.clone());
        ui.closed_restored.push(Default::default());
        ui.closed_derived_from.push(Default::default());
        ui.closed_unconfirmed_attempts.push(Default::default());
        ui.closed_pending_deleted
            .push((scope.clone(), "ses-del".into()));

        let mut stashed_entry =
            super::super::entry("tab-stashed".into(), Tab::Workspace(closed_ws.clone()));
        stashed_entry.pending_drafts.insert("ses-del".into());
        let stashed = super::super::StashedTemporary {
            tab_key: "tab-stashed".into(),
            original_index: 0,
            was_active: true,
            created_blank_key: Some("tab-0".into()),
            project: crate::catalog::Project {
                id: "ws-stashed".into(),
                path: "/tmp/stashed-proj".into(),
                temporary: true,
            },
            backend: Backend::unauthenticated("http://127.0.0.1:9/").unwrap(),
            folder: "/tmp/stashed-proj".into(),
            backend_id: None,
            server_id: None,
            entry: stashed_entry,
            return_focus: None,
        };
        let snap = ui.snapshot_with_stashed(Some(&stashed));
        let local_copies = snap
            .tabs
            .iter()
            .filter(|tab| matches!(tab, Tab::Workspace(w) if w.drafts.contains_key(NO_SESSION_DRAFT_ID)))
            .count();
        assert_eq!(
            local_copies, 0,
            "stashed temporary tab already projecting the closed draft must not duplicate it under __no_session_draft__"
        );

        // Also verify that if archive A (which stashed projected) is removed by confirmation while
        // stashed, leaving archive B in ui.closed, snapshot_with_stashed clears stale A and
        // persists B instead of letting the stale pending_drafts marker skip B.
        let mut closed_b = make_ws(
            "/tmp/stashed-proj",
            Some("ses-del"),
            &[("ses-del", "archive B")],
        );
        closed_b.temporary = true;
        ui.closed = vec![closed_b];
        let snap_resync = ui.snapshot_with_stashed(Some(&stashed));
        let Tab::Workspace(stashed_snap_w) = &snap_resync.tabs[0] else {
            panic!("expected stashed workspace tab")
        };
        assert_eq!(
            stashed_snap_w.drafts.get("ses-del").map(String::as_str),
            Some("archive B"),
            "snapshot_with_stashed must replace stale stashed projection A with surviving archive B"
        );
        assert!(
            !stashed_snap_w.drafts.contains_key(NO_SESSION_DRAFT_ID),
            "surviving archive B projected onto the stashed tab must not also duplicate under __no_session_draft__"
        );

        // Medium #3: an optional project_name that pushes snapshot_string_units close to
        // MAX_STRINGS must yield to a deferred closed_pending_deleted draft.
        let mut ui2 = Ui::new();
        ui2.fixture_ready();
        let mut tab_a = make_ws("/repo/a", Some("ses-a"), &[("ses-a", &"a".repeat(32_000))]);
        tab_a.project_name = Some("N".repeat(200));
        let tab_b = make_ws(
            "/repo/b",
            Some("ses-b"),
            &[
                ("ses-b", &"b".repeat(32_000)),
                ("ses-b2", &"c".repeat(32_000)),
                ("ses-b3", &"e".repeat(2_000)),
            ],
        );
        ui2.entries = vec![
            super::super::entry("tab-0".into(), Tab::Workspace(tab_a.clone())),
            super::super::entry("tab-1".into(), Tab::Workspace(tab_b)),
        ];
        ui2.active = 0;
        // Closed draft for /repo/a fits only once tab_a.project_name (200 UTF-16 units) is dropped.
        let current_u = super::super::super::snapshot_string_units(&ui2.snapshot()).unwrap();
        let remaining_with_name = super::super::super::MAX_STRINGS.saturating_sub(current_u);
        assert!(
            remaining_with_name < 200,
            "expected budget headroom with project_name < 200, got {remaining_with_name}"
        );
        let key_u = NO_SESSION_DRAFT_ID.encode_utf16().count();
        let draft_len = remaining_with_name.saturating_sub(key_u) + 80;
        let deferred_text = "d".repeat(draft_len);
        let closed_a = make_ws("/repo/a", Some("ses-gone"), &[("ses-gone", &deferred_text)]);
        let scope_a = super::super::ProjectScope::from_workspace(&closed_a);
        ui2.closed.push(closed_a);
        ui2.closed_restored.push(Default::default());
        ui2.closed_derived_from.push(Default::default());
        ui2.closed_unconfirmed_attempts.push(Default::default());
        ui2.closed_pending_deleted
            .push((scope_a, "ses-gone".into()));

        let snap2 = ui2.snapshot();
        let Tab::Workspace(saved_a) = &snap2.tabs[0] else {
            panic!("expected workspace tab")
        };
        assert_eq!(
            saved_a.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
            Some(deferred_text.as_str()),
            "deferred closed draft must fit by yielding optional project_name"
        );
        assert!(
            saved_a.project_name.is_none(),
            "optional project_name must be dropped when its budget is needed for the deferred draft"
        );
        assert!(
            crate::workspace::encode(&snap2).is_ok(),
            "resulting snapshot must still encode cleanly within v1 bounds"
        );
    }

    #[test]
    fn stashed_sibling_projections_preserve_both_archives_and_resync_on_restore() {
        let make_ws =
            |folder: &str, active: Option<&str>, drafts: &[(&str, &str)]| super::super::Workspace {
                backend_id: None,
                server_id: None,
                folder: folder.into(),
                project_name: None,
                temporary: true,
                occurrence: 1,
                workspace_id: None,
                active_session_id: active.map(str::to_owned),
                drafts: drafts
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                    .collect(),
                attachment_drafts: Default::default(),
                attachment_parts: Default::default(),
                view: Default::default(),
            };

        let mut rt = rune::Runtime::new(
            crate::init(),
            crate::view,
            (800.0, 600.0),
            rune::Env::new(false, 1.0),
        );
        let mut ui = Ui::new();
        ui.fixture_ready();
        let closed_a = make_ws(
            "/tmp/two-proj",
            Some("ses-del"),
            &[("ses-del", "archive A")],
        );
        let closed_b = make_ws(
            "/tmp/two-proj",
            Some("ses-del"),
            &[("ses-del", "archive B")],
        );
        let scope = super::super::ProjectScope::from_workspace(&closed_a);
        // Push B first, A second so newest-first order is [A, B].
        ui.closed.push(closed_b.clone());
        ui.closed_restored.push(Default::default());
        ui.closed_derived_from.push(Default::default());
        ui.closed_unconfirmed_attempts.push(Default::default());
        ui.closed.push(closed_a.clone());
        ui.closed_restored.push(Default::default());
        ui.closed_derived_from.push(Default::default());
        ui.closed_unconfirmed_attempts.push(Default::default());
        ui.closed_pending_deleted
            .push((scope.clone(), "ses-del".into()));

        // Tab 0 projected A and is stashed; Tab 1 stays open projecting B.
        let mut open_entry =
            super::super::entry("tab-open".into(), Tab::Workspace(closed_b.clone()));
        open_entry.pending_drafts.insert("ses-del".into());
        ui.entries = vec![open_entry];
        ui.active = 0;

        let mut stashed_entry =
            super::super::entry("tab-stashed".into(), Tab::Workspace(closed_a.clone()));
        stashed_entry.pending_drafts.insert("ses-del".into());
        let stashed = super::super::StashedTemporary {
            tab_key: "tab-stashed".into(),
            original_index: 0,
            was_active: true,
            created_blank_key: None,
            project: crate::catalog::Project {
                id: "ws-two".into(),
                path: "/tmp/two-proj".into(),
                temporary: true,
            },
            backend: Backend::unauthenticated("http://127.0.0.1:9/").unwrap(),
            folder: "/tmp/two-proj".into(),
            backend_id: None,
            server_id: None,
            entry: stashed_entry,
            return_focus: None,
        };

        let snap_both = ui.snapshot_with_stashed(Some(&stashed));
        let mut persisted_texts: Vec<&str> = snap_both
            .tabs
            .iter()
            .filter_map(|tab| match tab {
                Tab::Workspace(w) => w.drafts.get("ses-del").map(String::as_str),
                Tab::Blank => None,
            })
            .collect();
        persisted_texts.sort_unstable();
        assert_eq!(
            persisted_texts,
            vec!["archive A", "archive B"],
            "stashing tab 0 while tab 1 projects archive B must persist both A and B without duplicating B or dropping A"
        );
        let fallback_copies = snap_both
            .tabs
            .iter()
            .filter(|tab| {
                matches!(tab, Tab::Workspace(w) if w.drafts.contains_key(NO_SESSION_DRAFT_ID))
            })
            .count();
        assert_eq!(fallback_copies, 0);

        // Now archive A is confirmed/removed while tab 0 is still stashed, leaving only B.
        ui.closed.pop();
        ui.closed_restored.pop();
        ui.closed_derived_from.pop();
        ui.closed_unconfirmed_attempts.pop();

        let snap_one = ui.snapshot_with_stashed(Some(&stashed));
        let surviving_texts: Vec<&str> = snap_one
            .tabs
            .iter()
            .filter_map(|tab| match tab {
                Tab::Workspace(w) => w.drafts.get("ses-del").map(String::as_str),
                Tab::Blank => None,
            })
            .collect();
        assert_eq!(
            surviving_texts,
            vec!["archive B"],
            "snapshot_with_stashed must drop stale A and persist surviving archive B once across open + stashed tabs"
        );

        // On discard refusal (e.g. HTTP 409), restore_stashed must resync the restored tab so
        // ordinary snapshots never resurrect stale A either.
        rt.state.workspace = Some(ui);
        rt.state.screen = crate::Screen::Launcher(Box::new(crate::launcher::Launcher::fixture()));
        rt.update(|s, tx| {
            let _ = super::super::restore_stashed(s, stashed, false, tx);
        });
        let snap_after_restore = rt.state.workspace.as_ref().unwrap().snapshot();
        let restored_texts: Vec<&str> = snap_after_restore
            .tabs
            .iter()
            .filter_map(|tab| match tab {
                Tab::Workspace(w) => w.drafts.get("ses-del").map(String::as_str),
                Tab::Blank => None,
            })
            .collect();
        assert_eq!(
            restored_texts,
            vec!["archive B"],
            "restore_stashed must resync pending closed projections so stale archive A cannot be persisted after 409"
        );
    }

    #[test]
    fn closing_active_tab_settles_queued_reader_sync_confirmation_before_session_deleted_invalidation()
     {
        use crate::transport::{Command, Event, PromptOutcome};

        let mut rt = rune::Runtime::new(
            crate::init(),
            crate::view,
            (800.0, 600.0),
            rune::Env::new(false, 1.0),
        );
        let mut ui = Ui::new();
        ui.fixture_ready();
        rt.state.workspace = Some(ui);
        rt.state.screen = crate::Screen::Launcher(Box::new(crate::launcher::Launcher::fixture()));
        let project = crate::catalog::Project {
            id: "ws-close-sync".into(),
            path: "/repo/close-sync".into(),
            temporary: false,
        };
        let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        backend.workspace = "ws-close-sync".into();
        backend.session = "ses-close-sync".into();
        let (cmd_tx, cmd_rx) = codenomad_client::bounded(8);
        let (ev_tx, ev_rx) = codenomad_client::bounded(8);
        let (mut reader, lane) = crate::chat::reader::Reader::fixture_open();
        reader.install(false);
        let reader_gen = reader.generation();

        rt.state.screen.launcher_mut().unwrap().project = Some(project.clone());
        crate::workspace::opened(&mut rt.state, &project);
        let _ = bound(&mut rt.state, &backend);
        rt.state.phase = crate::Phase::Ready;
        rt.state.commands = Some(cmd_tx);
        rt.state.incoming = Some(ev_rx);
        rt.state.reader = Some(reader);
        rt.state.draft = rune::edit::TextEdit::new("confirmed via reader sync");
        rt.update(|s, tx| crate::composer::send(s, tx, false));
        let Command::Prompt(prompt) = cmd_rx.try_recv().unwrap() else {
            panic!("expected prompt command")
        };
        let attempt_id = prompt.id.expect("prompt id");
        crate::composer::acknowledge(&mut rt.state, &attempt_id, PromptOutcome::Unconfirmed);
        capture(&mut rt.state);

        // Queue ReaderSync confirmation on the Reader lane and SessionDeleted on incoming;
        // closing the active tab must settle the ReaderSync user confirmation even though
        // incoming SessionDeleted invalidates the reader first.
        lane.events
            .try_send((
                reader_gen,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: vec![
                            crate::Message {
                                usage: None,
                                id: attempt_id,
                                role: "user".into(),
                                completed: true,
                                body: "confirmed via reader sync".into(),
                                parts: vec![],
                            }
                            .into(),
                        ],
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        ev_tx.try_send(Event::SessionDeleted).unwrap();

        let active_key = rt.state.workspace.as_ref().unwrap().entries[0].key.clone();
        rt.update(|s, tx| crate::workspace::close(s, &active_key, tx));

        let ui = rt.state.workspace.as_ref().unwrap();
        let resurrected_open = ui.entries.iter().any(|e| {
            matches!(&e.saved, Tab::Workspace(w) if w.drafts.values().any(|t| t == "confirmed via reader sync"))
        });
        let resurrected_closed = ui
            .closed
            .iter()
            .any(|w| w.drafts.values().any(|t| t == "confirmed via reader sync"));
        assert!(
            !resurrected_open && !resurrected_closed,
            "closing active tab must settle queued ReaderSync confirmation before SessionDeleted recovery"
        );

        // Repeat with a ReaderSync already parked in deferred_sync, discarded by suspend() before
        // SessionDeleted arrives on close.
        let (cmd_tx2, cmd_rx2) = codenomad_client::bounded(8);
        let (ev_tx2, ev_rx2) = codenomad_client::bounded(8);
        let (mut reader2, lane2) = crate::chat::reader::Reader::fixture_open();
        reader2.install(false);

        backend.session = "ses-close-deferred-sync".into();
        rt.state.screen.launcher_mut().unwrap().project = Some(project);
        crate::workspace::opened(
            &mut rt.state,
            &crate::catalog::Project {
                id: "ws-close-sync".into(),
                path: "/repo/close-sync".into(),
                temporary: false,
            },
        );
        let _ = bound(&mut rt.state, &backend);
        rt.state.phase = crate::Phase::Ready;
        rt.state.commands = Some(cmd_tx2);
        rt.state.incoming = Some(ev_rx2);
        rt.state.reader = Some(reader2);
        rt.state.draft = rune::edit::TextEdit::new("confirmed via deferred reader sync");
        rt.update(|s, tx| crate::composer::send(s, tx, false));
        let Command::Prompt(prompt2) = cmd_rx2.try_recv().unwrap() else {
            panic!("expected prompt command")
        };
        let attempt_id2 = prompt2.id.expect("prompt id");
        crate::composer::acknowledge(&mut rt.state, &attempt_id2, PromptOutcome::Unconfirmed);
        capture(&mut rt.state);
        crate::chat::reader::invalidate(&mut rt.state);
        let gen2 = rt.state.reader.as_ref().unwrap().generation();

        lane2
            .events
            .try_send((
                gen2,
                0,
                Event::ReaderSync {
                    page: crate::history::Page {
                        rows: vec![
                            crate::Message {
                                usage: None,
                                id: attempt_id2,
                                role: "user".into(),
                                completed: true,
                                body: "confirmed via deferred reader sync".into(),
                                parts: vec![],
                            }
                            .into(),
                        ],
                        older: None,
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        // Park the ReaderSync inside deferred_sync via the real deferred poll path.
        let _ = crate::chat::events::poll_chat_for_window(&mut rt.state, 8, true, 1.0);
        assert!(rt.state.reader.as_ref().unwrap().has_deferred_sync());
        // Suspend drops deferred_sync; then SessionDeleted arrives and active tab closes.
        crate::chat::reader::suspend(&mut rt.state);
        ev_tx2.try_send(Event::SessionDeleted).unwrap();
        let active_key2 = {
            let ui = rt.state.workspace.as_ref().unwrap();
            ui.entries[ui.active].key.clone()
        };
        rt.update(|s, tx| crate::workspace::close(s, &active_key2, tx));

        let ui = rt.state.workspace.as_ref().unwrap();
        let resurrected_deferred_open = ui.entries.iter().any(|e| {
            matches!(&e.saved, Tab::Workspace(w) if w.drafts.values().any(|t| t == "confirmed via deferred reader sync"))
        });
        let resurrected_deferred_closed = ui.closed.iter().any(|w| {
            w.drafts
                .values()
                .any(|t| t == "confirmed via deferred reader sync")
        });
        assert!(
            !resurrected_deferred_open && !resurrected_deferred_closed,
            "closing active tab must settle confirmations from deferred_sync discarded during suspend"
        );
    }

    #[test]
    fn stashed_resync_updates_restored_provenance_against_derived_edit() {
        let make_ws =
            |folder: &str, active: Option<&str>, drafts: &[(&str, &str)]| super::super::Workspace {
                backend_id: None,
                server_id: None,
                folder: folder.into(),
                project_name: None,
                temporary: true,
                occurrence: 1,
                workspace_id: None,
                active_session_id: active.map(str::to_owned),
                drafts: drafts
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                    .collect(),
                attachment_drafts: Default::default(),
                attachment_parts: Default::default(),
                view: Default::default(),
            };

        let mut ui = Ui::new();
        ui.fixture_ready();
        let closed_a = make_ws(
            "/tmp/prov-proj",
            Some("ses-del"),
            &[("ses-del", "restored A")],
        );
        let closed_b = make_ws(
            "/tmp/prov-proj",
            Some("ses-del"),
            &[("ses-del", "restored B")],
        );
        let closed_c = make_ws(
            "/tmp/prov-proj",
            Some("ses-del"),
            &[("ses-del", "restored C")],
        );
        let scope = super::super::ProjectScope::from_workspace(&closed_a);
        // Push C, B, A so newest-first order is [A, B, C], all marked as restored archives.
        for ws in [&closed_c, &closed_b, &closed_a] {
            ui.closed.push(ws.clone());
            ui.closed_restored
                .push(std::collections::HashSet::from(["ses-del".into()]));
            ui.closed_derived_from.push(Default::default());
            ui.closed_unconfirmed_attempts.push(Default::default());
        }
        ui.closed_pending_deleted.push((scope, "ses-del".into()));

        let copy_a = DraftCopy::from_workspace(&closed_a, "ses-del").unwrap();
        let copy_b = DraftCopy::from_workspace(&closed_b, "ses-del").unwrap();

        // Tab 0 (stashed) projected A; Tabs 1 & 2 resynced to A & B while Tab 0 was stashed,
        // so Tab 2 currently carries restored provenance B; Tab 3 has an independent edit derived from B.
        let mut stashed_entry =
            super::super::entry("tab-stashed".into(), Tab::Workspace(closed_a.clone()));
        stashed_entry.pending_drafts.insert("ses-del".into());
        stashed_entry
            .restored_drafts
            .insert("ses-del".into(), copy_a.clone());

        let mut open_1 = super::super::entry("tab-1".into(), Tab::Workspace(closed_a.clone()));
        open_1.pending_drafts.insert("ses-del".into());
        open_1.restored_drafts.insert("ses-del".into(), copy_a);

        let mut open_2 = super::super::entry("tab-2".into(), Tab::Workspace(closed_b.clone()));
        open_2.pending_drafts.insert("ses-del".into());
        open_2
            .restored_drafts
            .insert("ses-del".into(), copy_b.clone());

        let edited_b = make_ws(
            "/tmp/prov-proj",
            Some("ses-del"),
            &[("ses-del", "edited B")],
        );
        let mut open_3 = super::super::entry("tab-3".into(), Tab::Workspace(edited_b));
        open_3.restored_drafts.remove("ses-del");
        open_3.derived_from.insert("ses-del".into(), copy_b);

        ui.entries = vec![open_1, open_2, open_3];
        ui.active = 0;

        let stashed = super::super::StashedTemporary {
            tab_key: "tab-stashed".into(),
            original_index: 0,
            was_active: false,
            created_blank_key: None,
            project: crate::catalog::Project {
                id: "ws-prov".into(),
                path: "/tmp/prov-proj".into(),
                temporary: true,
            },
            backend: Backend::unauthenticated("http://127.0.0.1:9/").unwrap(),
            folder: "/tmp/prov-proj".into(),
            backend_id: None,
            server_id: None,
            entry: stashed_entry,
            return_focus: None,
        };

        let snap = ui.snapshot_with_stashed(Some(&stashed));
        let mut persisted: Vec<&str> = snap
            .tabs
            .iter()
            .filter_map(|tab| match tab {
                Tab::Workspace(w) => w.drafts.get("ses-del").map(String::as_str),
                Tab::Blank => None,
            })
            .collect();
        persisted.sort_unstable();
        assert_eq!(
            persisted,
            vec!["edited B", "restored A", "restored C"],
            "snapshot_with_stashed must move restored provenance with redistributed bundles so derived-from-B suppresses B and preserves C"
        );
    }
}
