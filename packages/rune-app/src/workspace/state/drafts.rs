use super::super::{
    NO_SESSION_DRAFT_ID, RECOVERED_DRAFT_PREFIX, is_local_draft_id, is_recovered_draft_id,
};
use super::{Backend, State, Tab, Tx, Ui, same_project};
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

fn has_any_draft_key(item: &super::Entry, saved: &crate::workspace::Workspace, key: &str) -> bool {
    saved.drafts.contains_key(key)
        || saved.attachment_drafts.contains(key)
        || saved.attachment_parts.contains_key(key)
        || item.live_drafts.contains_key(key)
}

fn next_recovered_draft_id(item: &super::Entry, saved: &crate::workspace::Workspace) -> String {
    for _ in 0..8 {
        if let Ok(uuid) = codenomad_client::http::client_id() {
            let candidate = format!("{RECOVERED_DRAFT_PREFIX}{uuid}");
            if is_recovered_draft_id(&candidate) && !has_any_draft_key(item, saved, &candidate) {
                return candidate;
            }
        }
    }
    let mut counter: u64 = 1;
    loop {
        let candidate = format!("{RECOVERED_DRAFT_PREFIX}00000000-0000-4000-8000-{counter:012x}");
        if !has_any_draft_key(item, saved, &candidate) {
            return candidate;
        }
        counter = counter.wrapping_add(1);
    }
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

/// Recovers authored draft text and attachments from a confirmed-missing session into
/// `__no_session_draft__` (or `__recovered_draft__<uuid>` when occupied), matching Solid's
/// `recoverRemovedSessionDraft` (`stores/session-draft-recovery.ts`), and removes the dead
/// session ID from local and persisted draft storage.
pub fn recover_missing_session_draft(s: &mut State, session_id: &str) -> bool {
    if session_id.is_empty() || is_local_draft_id(session_id) {
        return false;
    }
    if !s.screen.is_launcher() && super::active_session(s) == Some(session_id) {
        return false;
    }
    let Some(ui) = &mut s.workspace else {
        return false;
    };
    if ui
        .entries
        .get(ui.active)
        .is_some_and(|item| item.pending_drafts.contains(session_id))
    {
        deliver_draft(ui, session_id);
    }
    let scope = match ui.entries.get(ui.active).map(|item| &item.saved) {
        Some(Tab::Workspace(saved)) => saved.clone(),
        _ => return false,
    };
    let mut cleaned_closed = false;
    for closed in ui.closed.iter_mut().filter(|w| same_project(&scope, w)) {
        cleaned_closed |= closed.drafts.remove(session_id).is_some();
        cleaned_closed |= closed.attachment_drafts.remove(session_id);
        cleaned_closed |= closed.attachment_parts.remove(session_id).is_some();
    }
    let item = &mut ui.entries[ui.active];
    let Tab::Workspace(mut saved) = std::mem::replace(&mut item.saved, Tab::Blank) else {
        return false;
    };
    let has_content = has_draft_content(item, &saved, session_id);
    if !has_content {
        let mut cleaned = cleaned_closed;
        cleaned |= saved.drafts.remove(session_id).is_some();
        cleaned |= saved.attachment_drafts.remove(session_id);
        cleaned |= saved.attachment_parts.remove(session_id).is_some();
        cleaned |= item.live_drafts.remove(session_id).is_some();
        cleaned |= item.cleared.remove(session_id);
        cleaned |= item.pending_drafts.remove(session_id);
        item.saved = Tab::Workspace(saved);
        if cleaned {
            ui.changed();
            ui.stage();
        }
        return false;
    }
    let target = if has_draft_content(item, &saved, NO_SESSION_DRAFT_ID) {
        next_recovered_draft_id(item, &saved)
    } else {
        NO_SESSION_DRAFT_ID.into()
    };
    move_draft_between_keys(item, &mut saved, session_id, &target);
    item.saved = Tab::Workspace(saved);
    ui.changed();
    ui.stage();
    let message = crate::strings::with_locale(crate::settings::app_locale(s), || {
        crate::strings::t("sessionState.cleanup.draftRecovered")
    });
    crate::shell::notifications::emit(
        s,
        crate::shell::notifications::Category::Projects,
        None,
        message,
    );
    true
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
    let Some(item) = ui.entries.get_mut(ui.active) else {
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
    if source == NO_SESSION_DRAFT_ID
        && let Some(next_recovered) = earliest_recovered_draft_id(item, &saved)
    {
        move_draft_between_keys(item, &mut saved, &next_recovered, NO_SESSION_DRAFT_ID);
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
