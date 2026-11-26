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
    pub(super) fn from_workspace(saved: &crate::workspace::Workspace, key: &str) -> Option<Self> {
        let text = saved
            .drafts
            .get(key)
            .filter(|text| !text.is_empty())
            .cloned();
        let attachment_draft = saved.attachment_drafts.contains(key);
        let attachment_parts = saved
            .attachment_parts
            .get(key)
            .cloned()
            .or_else(|| attachment_draft.then(SavedParts::missing));
        (text.is_some() || attachment_draft || attachment_parts.is_some()).then_some(Self {
            text,
            attachment_draft,
            attachment_parts,
        })
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

pub(super) fn drain_window_deleted_sessions(s: &mut State) -> bool {
    let incoming: Vec<(super::ProjectScope, String)> = {
        let Some(ui) = &s.workspace else {
            return false;
        };
        let mut items = Vec::new();
        while let Ok(item) = ui.deleted_sessions.1.try_recv() {
            items.push(item);
        }
        items
    };
    let mut changed = false;
    for (scope, id) in incoming {
        let open_idx = s.workspace.as_ref().and_then(|ui| {
            ui.entries
                .iter()
                .position(|entry| matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w)))
        });
        if let Some(idx) = open_idx {
            changed |= recover_missing_session_draft_in(s, Some(idx), &id);
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
    changed
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
    let outgoing_deleted = if !same_session && let Some(prev) = previous.as_deref() {
        let stream_deleted = drain_incoming_session_deleted(s.incoming.as_ref());
        drain_window_deleted_sessions(s);
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
        item.clear_authority.remove(id);
        item.restored_drafts.remove(id);
        item.derived_from.remove(id);
        item.superseded_on_delete.remove(id);
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
                    item.clear_authority
                        .insert(id.into(), ClearAuthority::Persisted);
                }
                None => {}
            }
            if let Some(copy) = DraftCopy::from_workspace(saved, id) {
                item.restored_drafts.insert(id.into(), copy.clone());
                item.derived_from.insert(id.into(), copy);
            }
        }
    }
    for w in ui.closed.iter_mut().filter(|w| same_project(&scope, w)) {
        w.drafts.remove(id);
        w.attachment_drafts.remove(id);
        w.attachment_parts.remove(id);
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

fn next_recovered_draft_id(ui: &Ui, scope: &crate::workspace::Workspace) -> Option<String> {
    for _ in 0..8 {
        if let Ok(uuid) = codenomad_client::http::random_uuid_v4() {
            let candidate = format!("{RECOVERED_DRAFT_PREFIX}{uuid}");
            if is_uuid_recovered_draft_id(&candidate)
                && !project_has_any_draft_key(ui, scope, &candidate)
            {
                return Some(candidate);
            }
        }
    }
    None
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

fn move_draft_between_keys(
    item: &mut super::Entry,
    saved: &mut crate::workspace::Workspace,
    from: &str,
    to: &str,
) {
    let text = saved.drafts.remove(from);
    let had_attachment_flag = saved.attachment_drafts.remove(from);
    let parts = saved.attachment_parts.remove(from);
    let live = item.live_drafts.remove(from);
    item.cleared.remove(from);
    item.pending_drafts.remove(from);

    if let Some(text) = text
        && !text.is_empty()
    {
        saved.drafts.insert(to.into(), text);
    }
    if had_attachment_flag || parts.is_some() {
        saved.attachment_drafts.insert(to.into());
    }
    if let Some(parts) = parts {
        saved.attachment_parts.insert(to.into(), parts);
    }
    if let Some(live) = live
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

struct ClosedBundle {
    text: Option<String>,
    attachment_draft: bool,
    attachment_parts: Option<SavedParts>,
}

impl ClosedBundle {
    fn has_content(&self) -> bool {
        self.text.as_deref().is_some_and(|t| !t.is_empty())
            || self.attachment_draft
            || self.attachment_parts.is_some()
    }
}

struct ClosedState {
    bundle: Option<ClosedBundle>,
    explicitly_cleared: bool,
}

fn peek_closed_state(
    ui: &Ui,
    scope: &crate::workspace::Workspace,
    session_id: &str,
) -> ClosedState {
    let mut text: Option<String> = None;
    let mut attachment_draft = false;
    let mut attachment_parts: Option<SavedParts> = None;
    let mut explicitly_cleared = false;
    for w in ui.closed.iter().filter(|w| same_project(scope, w)) {
        if let Some(entry_text) = w.drafts.get(session_id) {
            attachment_draft = false;
            attachment_parts = None;
            if entry_text.is_empty() {
                text = None;
                explicitly_cleared = true;
            } else {
                text = Some(entry_text.clone());
                explicitly_cleared = false;
            }
        }
        if w.attachment_drafts.contains(session_id) {
            attachment_draft = true;
            attachment_parts = None;
            explicitly_cleared = false;
        }
        if let Some(parts) = w.attachment_parts.get(session_id) {
            attachment_draft = true;
            attachment_parts = Some(parts.clone());
            explicitly_cleared = false;
        }
    }
    let bundle = ClosedBundle {
        text,
        attachment_draft,
        attachment_parts,
    };
    let bundle = bundle.has_content().then_some(bundle);
    ClosedState {
        explicitly_cleared: explicitly_cleared && bundle.is_none(),
        bundle,
    }
}

fn purge_closed_session(
    ui: &mut Ui,
    scope: &crate::workspace::Workspace,
    session_id: &str,
) -> bool {
    let mut cleaned = false;
    for w in ui.closed.iter_mut().filter(|w| same_project(scope, w)) {
        cleaned |= w.drafts.remove(session_id).is_some();
        cleaned |= w.attachment_drafts.remove(session_id);
        cleaned |= w.attachment_parts.remove(session_id).is_some();
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

fn recover_target_key(ui: &Ui, scope: &crate::workspace::Workspace) -> Option<String> {
    if project_has_draft_content(ui, scope, NO_SESSION_DRAFT_ID) {
        next_recovered_draft_id(ui, scope)
    } else {
        Some(NO_SESSION_DRAFT_ID.into())
    }
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
    if session_id.is_empty() || is_local_draft_id(session_id) {
        return false;
    }
    let on_launcher = s.screen.is_launcher();
    let (recovered, mutated) = {
        let Some(ui) = &mut s.workspace else {
            return false;
        };
        let origin = origin_tab.unwrap_or(ui.active);
        let scope = match ui.entries.get(origin).map(|item| &item.saved) {
            Some(Tab::Workspace(saved)) => saved.clone(),
            _ => return false,
        };
        let closed_state = peek_closed_state(ui, &scope, session_id);
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

        // Collect clear authorities across open sibling tabs AND closed occurrences so an
        // explicit clear suppresses only targeted restored copies (even after closing or deferral)
        // without discarding independent sibling edits.
        let mut clear_authorities: Vec<ClearAuthority> = matching_tabs
            .iter()
            .filter_map(|&idx| {
                let entry = &ui.entries[idx];
                if !entry.cleared.contains(session_id) {
                    return None;
                }
                let Tab::Workspace(saved) = &entry.saved else {
                    return None;
                };
                if has_draft_content(entry, saved, session_id) {
                    return None;
                }
                entry.clear_authority.get(session_id).cloned()
            })
            .collect();
        if closed_state.explicitly_cleared {
            clear_authorities.push(ClearAuthority::Persisted);
        }

        // Recover any authoritative closed-tab draft into the originating tab before purging.
        let closed_handled = if let Some(bundle) = closed_state.bundle {
            if let Some(target) = recover_target_key(ui, &scope) {
                if let Some(entry) = ui.entries.get_mut(origin)
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
                true
            } else {
                ui.entries[origin].pending_deleted.insert(session_id.into());
                false
            }
        } else {
            true
        };

        if closed_handled {
            mutated |= purge_closed_session(ui, &scope, session_id);
            // Clear undelivered copies from sibling pending_drafts before moving independent edits.
            for &idx in &matching_tabs {
                if occurrence_in_active_chat_on(on_launcher, ui, idx, session_id) {
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
        }

        // Recover independent drafts (or clean remnants) across every same-project occurrence.
        for &idx in &matching_tabs {
            if occurrence_in_active_chat_on(on_launcher, ui, idx, session_id) {
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
            let restored = ui.entries[idx].restored_drafts.get(session_id);
            let superseded_restored = (ui.entries[idx].superseded_on_delete.contains(session_id)
                && restored.is_some())
                || clear_authorities
                    .iter()
                    .any(|auth| auth.matches_restored(restored));
            let has_content = !superseded_restored
                && matches!(
                    &ui.entries[idx].saved,
                    Tab::Workspace(saved) if has_draft_content(&ui.entries[idx], saved, session_id)
                );
            let target = if has_content {
                match recover_target_key(ui, &scope) {
                    Some(target) => Some(target),
                    None => {
                        ui.entries[idx].pending_deleted.insert(session_id.into());
                        continue;
                    }
                }
            } else {
                None
            };
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

        let any_deferred = matching_tabs
            .iter()
            .any(|&idx| ui.entries[idx].pending_deleted.contains(session_id));
        if closed_handled && !any_deferred {
            ui.closed_pending_deleted
                .retain(|(c_scope, c_id)| !(c_scope.matches(&scope) && c_id == session_id));
        }

        if mutated {
            ui.changed();
            ui.stage();
        }
        (recovered, mutated)
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
    recovered
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
            if let Some(idx) = ui.entries.iter().enumerate().find_map(|(idx, entry)| {
                (matches!(&entry.saved, Tab::Workspace(w) if scope.matches(w))
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
        changed |= recover_missing_session_draft_in(s, Some(idx), &id);
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
}
