use super::{State, Tab, Ui};
use crate::Phase;

/// Shared local protection check across workspace tabs and closed tabs used by both
/// manual and automatic blank-session cleanup sweeps.
pub(super) fn session_protected_in_workspace(s: &State, ui: &Ui, session_id: &str) -> bool {
    if !codenomad_client::history::valid_id(session_id)
        || session_id.starts_with("ses_cn_schedule_")
        || s.command_receipts.has_for_session(session_id)
    {
        return true;
    }
    if let Some(l) = s.screen.launcher()
        && (l.rebind_after_send.as_deref() == Some(session_id)
            || (!s.screen.is_launcher() && l.visits.current() == Some(session_id)))
    {
        return true;
    }
    for entry in &ui.entries {
        if entry.idle_markers.is_working(session_id) {
            return true;
        }
        if entry.rebind_after_send.as_deref() == Some(session_id) {
            return true;
        }
        if let Tab::Workspace(saved) = &entry.saved {
            if saved.active_session_id.as_deref() == Some(session_id) {
                return true;
            }
            if ui.has_closed_unconfirmed_for(saved, session_id) {
                return true;
            }
            if saved
                .drafts
                .get(session_id)
                .is_some_and(|text| !text.is_empty())
                || saved.attachment_drafts.contains(session_id)
                || saved.attachment_parts.contains_key(session_id)
            {
                return true;
            }
        }
        if entry
            .live_drafts
            .get(session_id)
            .is_some_and(super::drafts::LiveDraft::has_content)
            || entry.pending_drafts.contains(session_id)
        {
            return true;
        }
    }
    for closed in &ui.closed {
        if closed
            .drafts
            .get(session_id)
            .is_some_and(|text| !text.is_empty())
            || closed.attachment_drafts.contains(session_id)
            || closed.attachment_parts.contains_key(session_id)
        {
            return true;
        }
    }
    false
}

/// Local safety check for manual blank-session cleanup.
/// Returns `true` when `session_id` is absent, reserved, currently open/active,
/// has unsent drafts/attachments/unconfirmed prompts, or is mid-rebind.
pub(crate) fn session_cleanup_protected(s: &State, project_id: &str, session_id: &str) -> bool {
    if !codenomad_client::history::valid_id(session_id)
        || session_id.starts_with("ses_cn_schedule_")
        || s.command_receipts.has_for_session(session_id)
    {
        return true;
    }
    if let Some(l) = s.screen.launcher()
        && l.project.as_ref().is_some_and(|p| p.id == project_id)
        && l.rebind_after_send.as_deref() == Some(session_id)
    {
        return true;
    }
    let Some(ui) = &s.workspace else {
        let Some(l) = s.screen.launcher() else {
            return true;
        };
        if l.project.as_ref().is_none_or(|p| p.id != project_id) {
            return true;
        }
        let known = l.sessions.iter().any(|row| row.id == session_id)
            || l.linked.rows.iter().any(|row| row.id == session_id);
        if !known {
            return true;
        }
        if !s.screen.is_launcher()
            && (l.visits.current() == Some(session_id)
                || s.phase != Phase::Ready
                || s.composer.device.busy()
                || !s.draft.text.is_empty()
                || !s.composer.draft.attachments.is_empty()
                || s.composer.attachments_missing
                || s.composer.unconfirmed_id().is_some()
                || s.command_receipts.has_for_state(s))
        {
            return true;
        }
        return false;
    };

    let mut known_in_project = false;
    for (index, entry) in ui.entries.iter().enumerate() {
        let is_active = index == ui.active;
        let matches_project = if is_active {
            s.screen
                .launcher()
                .and_then(|l| l.project.as_ref())
                .is_some_and(|p| p.id == project_id)
        } else {
            entry.project.as_ref().is_some_and(|p| p.id == project_id)
        };
        if matches_project {
            let has_row = if is_active {
                s.screen.launcher().is_some_and(|l| {
                    l.sessions.iter().any(|row| row.id == session_id)
                        || l.linked.rows.iter().any(|row| row.id == session_id)
                })
            } else {
                entry.sessions.iter().any(|row| row.id == session_id)
                    || entry.linked.rows.iter().any(|row| row.id == session_id)
            };
            known_in_project |= has_row;
        }
    }
    if !known_in_project {
        return true;
    }
    session_protected_in_workspace(s, ui, session_id)
}

/// Removes a confirmed-deleted blank session from local session lists and visit history
/// for every tab bound to `project_id`.
pub(crate) fn remove_cleaned_session(s: &mut State, project_id: &str, session_id: &str) -> bool {
    let mut removed = false;
    let active_matches = s
        .screen
        .launcher()
        .and_then(|l| l.project.as_ref())
        .is_some_and(|p| p.id == project_id);
    if active_matches && let Some(l) = s.screen.launcher_mut() {
        let before = l.sessions.len() + l.linked.rows.len() + l.search_results.rows.len();
        l.sessions.retain(|row| row.id != session_id);
        l.linked.rows.retain(|row| row.id != session_id);
        l.listed_sessions.remove(session_id);
        l.search_results.rows.retain(|row| row.id != session_id);
        l.visits.forget(&[session_id.to_owned()]);
        if l.sessions.len() + l.linked.rows.len() + l.search_results.rows.len() != before {
            removed = true;
        }
    }
    if let Some(ui) = &mut s.workspace {
        let active = ui.active;
        for (index, entry) in ui.entries.iter_mut().enumerate() {
            if index == active {
                if active_matches {
                    entry.idle_markers.remove(session_id);
                }
                continue;
            }
            if entry.project.as_ref().is_some_and(|p| p.id == project_id) {
                entry.idle_markers.remove(session_id);
                let before = entry.sessions.len() + entry.linked.rows.len();
                entry.sessions.retain(|row| row.id != session_id);
                entry.linked.rows.retain(|row| row.id != session_id);
                entry.listed_sessions.remove(session_id);
                entry.visits.forget(&[session_id.to_owned()]);
                if entry.sessions.len() + entry.linked.rows.len() != before {
                    removed = true;
                }
            }
        }
    }
    removed
}
