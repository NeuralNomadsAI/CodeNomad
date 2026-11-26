use super::super::{
    NO_SESSION_DRAFT_ID, RECOVERED_DRAFT_PREFIX, is_local_draft_id, is_recovered_draft_id,
    is_uuid_recovered_draft_id,
};
use super::{Backend, State, Tab, Tx, Ui, same_project};
use crate::composer::{
    draft::{Draft, MAX_FILES},
    draft_storage::SavedParts,
};

const MAX_WINDOW_DEVICE_BYTES: usize = 64 * 1024 * 1024;
const MAX_WINDOW_DEVICE_FILES: usize = super::super::MAX_DRAFTS * MAX_FILES;

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
        let effective_closing = closing_tab.or_else(|| {
            s.workspace.as_ref().and_then(|ui| {
                ui.entries.iter().position(|entry| {
                    entry.closing_deferred
                        && matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w))
                })
            })
        });
        let open_idx = s.workspace.as_ref().and_then(|ui| {
            ui.entries
                .iter()
                .enumerate()
                .find_map(|(idx, entry)| {
                    (Some(idx) != effective_closing
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
                effective_closing,
                &id,
                &mut next_uuid,
            );
            recovered |= outcome.recovered;
            deferred |= outcome.deferred;
        } else if let Some(ui) = &mut s.workspace
            && ui
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
        }
    }
    RecoveryOutcome {
        recovered,
        deferred,
    }
}

pub(super) fn drain_incoming_session_deleted(
    incoming: Option<&codenomad_client::Receiver<crate::transport::Event>>,
) -> bool {
    let mut deleted = false;
    if let Some(incoming) = incoming {
        while let Ok(event) = incoming.try_recv() {
            if matches!(event, crate::transport::Event::SessionDeleted) {
                deleted = true;
            }
        }
    }
    deleted
}

#[derive(Default)]
pub(super) struct LiveDraft {
    text: Option<String>,
    parts: Option<(Draft, bool)>,
    unconfirmed: Option<crate::composer::UnconfirmedPrompt>,
    command_unconfirmed: Option<crate::composer::UnconfirmedCommand>,
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
        .filter_map(|(_, draft)| draft.parts.as_ref())
        .fold(
            s.composer.draft.inline_usage(),
            |(files, bytes), (draft, _)| {
                let (count, len) = draft.inline_usage();
                (files.saturating_add(count), bytes.saturating_add(len))
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

pub fn capture(s: &mut State) {
    let Some(mut ui) = s.workspace.take() else {
        return;
    };
    let active = ui.active;
    let before = ui.entries.get(active).and_then(|item| match &item.saved {
        Tab::Workspace(w) => w.active_session_id.as_ref().map(|id| {
            (
                super::ProjectScope::from_workspace(w),
                id.clone(),
                item.clear_authority.get(id).cloned(),
            )
        }),
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
    ui.stage();
    s.workspace = Some(ui);
}

pub fn unconfirmed_drafts_full(s: &State) -> bool {
    if s.composer.unconfirmed_id().is_none() && s.composer.command_unconfirmed.is_none() {
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
    item.live_drafts
        .iter()
        .filter(|(existing, draft)| {
            existing.as_str() != key
                && (draft.unconfirmed.is_some() || draft.command_unconfirmed.is_some())
        })
        .count()
        >= super::super::MAX_DRAFTS
}

pub(super) fn capture_draft(item: &mut super::Entry, s: &State) -> bool {
    let (edit, draft, missing) = crate::composer::recall::fresh(s);
    let text = &edit.text;
    let mut changed = false;
    if let Tab::Workspace(saved) = &mut item.saved
        && let Some(key) = saved.active_session_id.as_deref()
        && item.binding.as_ref().is_some_and(|b| b.session == key)
    {
        let too_long = oversized(text);
        let has_device_parts = draft.inline_usage().0 != 0;
        let unconfirmed = s.composer.clone_unconfirmed();
        let has_unconfirmed = unconfirmed.is_some() || s.composer.command_unconfirmed.is_some();
        if too_long || has_device_parts || has_unconfirmed {
            let live = item.live_drafts.entry(key.into()).or_default();
            live.text = too_long.then(|| text.clone());
            live.parts = (too_long || has_device_parts).then(|| {
                let mut draft = draft.clone();
                draft.literal_spans = crate::composer::literal::ranges(edit).collect();
                (draft, missing)
            });
            live.unconfirmed = unconfirmed;
            live.command_unconfirmed = s.composer.command_unconfirmed.clone();
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
    s.composer.mark_edited();
    capture(s);
}

pub fn bound(s: &mut State, backend: &Backend) -> String {
    bound_with_adopt(s, backend, false)
}

pub fn bound_with_adopt(s: &mut State, backend: &Backend, adopt_recovered: bool) -> String {
    crate::composer::recall::restore(s);
    capture(s);
    let previous = super::active_session(s).map(str::to_owned);
    let same_session =
        !s.screen.is_launcher() && previous.as_deref() == Some(backend.session.as_str());
    let outgoing_deleted = if !same_session {
        let stream_deleted = previous
            .is_some()
            .then(|| drain_incoming_session_deleted(s.incoming.as_ref()))
            .unwrap_or(false);
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
    deliver_draft(ui, &backend.session);
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
    if !same_session && let Some(unconfirmed) = live.and_then(|draft| draft.unconfirmed.as_ref()) {
        s.composer.restore_unconfirmed(unconfirmed.clone());
    }
    if !same_session && let Some(slash) = live.and_then(|draft| draft.command_unconfirmed.as_ref())
    {
        s.composer.command_unconfirmed = Some(slash.clone());
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
                command_unconfirmed: None,
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
    ui.entries
        .iter()
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

#[cfg_attr(not(test), allow(dead_code))]
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
                    ui.stage();
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
        }

        if mutated {
            ui.changed();
            ui.stage();
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

/// Returns bounded distinct non-local session IDs that hold hydrated drafts in the active
/// tab's project so startup listing reconciliation can confirm whether any were deleted while
/// the app was closed (including fallback projections under a dead session key).
pub fn restored_draft_session_ids(s: &State) -> Vec<String> {
    let Some(ui) = &s.workspace else {
        return Vec::new();
    };
    let Some(Tab::Workspace(scope)) = ui.entries.get(ui.active).map(|e| &e.saved) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    let order = std::iter::once(ui.active).chain((0..ui.entries.len()).filter(|&i| i != ui.active));
    for idx in order {
        let entry = &ui.entries[idx];
        if !matches!(&entry.saved, Tab::Workspace(w) if same_project(scope, w)) {
            continue;
        }
        for id in entry.restored_drafts.keys() {
            if is_local_draft_id(id) || ids.iter().any(|existing| existing == id) {
                continue;
            }
            ids.push(id.clone());
            if ids.len() >= super::super::MAX_DRAFTS * 2 {
                return ids;
            }
        }
    }
    ids
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
        for (idx, entry) in ui.entries.iter().enumerate() {
            for id in &entry.pending_deleted {
                if !occurrence_in_active_chat_on(on_launcher, ui, idx, id) && !seen(&work, idx, id)
                {
                    work.push((idx, id.clone()));
                }
            }
        }
        for (scope, id) in &ui.closed_pending_deleted {
            if let Some(idx) = ui
                .entries
                .iter()
                .enumerate()
                .find_map(|(idx, entry)| {
                    (!entry.closing_deferred
                        && matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w))
                        && !occurrence_in_active_chat_on(on_launcher, ui, idx, id))
                    .then_some(idx)
                })
                .or_else(|| {
                    ui.entries.iter().enumerate().find_map(|(idx, entry)| {
                        (matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w))
                            && !occurrence_in_active_chat_on(on_launcher, ui, idx, id))
                        .then_some(idx)
                    })
                })
                && !seen(&work, idx, id)
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
    ui.stage();
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
        s.composer.command_unconfirmed = Some(crate::composer::UnconfirmedCommand::new(
            "compact",
            &"x".repeat(1024),
        ));
        capture(&mut s);

        // Sessions with unconfirmed locks preserve every lock up to MAX_DRAFTS (including those
        // with saved draft text) and then block leaving an additional unconfirmed session instead
        // of evicting earlier locks.
        for index in 0..(crate::workspace::MAX_DRAFTS - 1) {
            b.session = format!("ses-{index}");
            let _ = bound(&mut s, &b);
            s.draft = rune::edit::TextEdit::new("");
            s.composer.command_unconfirmed = Some(crate::composer::UnconfirmedCommand::new(
                "compact",
                &"x".repeat(1024),
            ));
            assert!(!unconfirmed_drafts_full(&s));
            capture(&mut s);
        }
        b.session = "ses-overflow".into();
        let _ = bound(&mut s, &b);
        s.draft = rune::edit::TextEdit::new("draft with unconfirmed lock");
        s.composer.command_unconfirmed = Some(crate::composer::UnconfirmedCommand::new(
            "compact",
            &"x".repeat(1024),
        ));
        assert!(unconfirmed_drafts_full(&s));
        // Every previously recorded unconfirmed session retains its anti-replay lock.
        b.session = "ses-0".into();
        let _ = bound(&mut s, &b);
        assert!(s.composer.command_unconfirmed.is_some());
        b.session = "kept-edited".into();
        assert_eq!(bound(&mut s, &b), "edited user draft");
        assert!(s.composer.command_unconfirmed.is_some());
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
}
