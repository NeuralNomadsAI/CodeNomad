use super::{
    Cache, State, Tab, TextEdit, Tx, Ui, Workspace, busy, capture, capture_files_mode, entry,
    same_project,
};
use crate::platform;

pub(super) fn stash(s: &mut State) {
    // History browsing is temporary; inactive tabs retain only their fresh draft.
    crate::composer::recall::restore(s);
    s.composer.on_tab_stash();
    capture_files_mode(s);
    capture(s);
    s.attachments.cancel();
    s.composer.picker.reset();
    s.composer.device.cancel();
    crate::chat::suspend(s);
    if let Some(files) = &mut s.files {
        files.activate(false);
    }
    if let Some(git) = &mut s.git.owner {
        git.activate(false);
    }
    s.status_permissions.show(false);
    s.status_services.show(false);
    s.status_usage.invalidate();
    let cache = Cache::take(s);
    if let Some(ui) = &mut s.workspace {
        let stamp = ui
            .entries
            .iter()
            .map(|entry| entry.history_touched)
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        let entry = &mut ui.entries[ui.active];
        entry.history_touched = stamp;
        entry.catalogue.pause(ui.clock);
        entry.cache = Some(cache);
        entry.wanted_panels = s.shell.wanted;
        if let Some(l) = s.screen.launcher_mut() {
            entry.project = l.project.clone();
            entry.sessions = std::mem::take(&mut l.sessions);
            entry.listed_sessions = std::mem::take(&mut l.listed_sessions);
            entry.creation_uncertain = l.creation_uncertain;
            entry.creation_uncertain_linked = l.creation_uncertain_linked.take();
            entry.rebind_after_send = l.rebind_after_send.take();
            l.adopt_recovered_for = None;
            entry.next = l.next.take();
            entry.linked = std::mem::take(&mut l.linked);
            entry.consumed_cursors = std::mem::take(&mut l.consumed_cursors);
            entry.visits = std::mem::take(&mut l.visits);
            entry.sidebar_edits = Some((
                std::mem::replace(&mut l.title, TextEdit::new("")),
                l.show_title,
                std::mem::replace(&mut l.search, TextEdit::new("")),
                l.show_search,
            ));
        }
    }
}
pub(super) fn activate(s: &mut State, tx: &mut Tx) {
    s.shell.leave_project();
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let item = &mut ui.entries[ui.active];
    s.shell.wanted = item.wanted_panels;
    if let Some(l) = s.screen.launcher_mut() {
        crate::launcher::set_project(l, item.project.clone());
        l.sessions = std::mem::take(&mut item.sessions);
        l.listed_sessions = std::mem::take(&mut item.listed_sessions);
        l.next = item.next.take();
        l.linked = std::mem::take(&mut item.linked);
        l.consumed_cursors = std::mem::take(&mut item.consumed_cursors);
        l.visits = std::mem::take(&mut item.visits);
        l.folder = TextEdit::new(match &item.saved {
            Tab::Workspace(w) => w.folder.as_str(),
            _ => "",
        });
        l.creation_uncertain = std::mem::take(&mut item.creation_uncertain);
        l.creation_uncertain_linked = std::mem::take(&mut item.creation_uncertain_linked);
        l.rebind_after_send = item.rebind_after_send.take();
        l.error = l.creation_uncertain.then_some("rune.create_error");
        (l.title, l.show_title, l.search, l.show_search) = item
            .sidebar_edits
            .take()
            .unwrap_or_else(|| (TextEdit::new(""), false, TextEdit::new(""), false));
    }
    let cached_lock = match &ui.entries[ui.active].saved {
        Tab::Workspace(saved) => saved.active_session_id.as_deref().and_then(|session_id| {
            ui.closed_unconfirmed_id(saved, session_id)
                .map(str::to_owned)
        }),
        Tab::Blank => None,
    };
    let item = &mut ui.entries[ui.active];
    if let Some(cache) = item.cache.take() {
        cache.apply(s);
        if let Some(attempt_id) = cached_lock
            && s.composer.unconfirmed_state().is_none()
        {
            s.composer
                .restore_unconfirmed(crate::composer::UnconfirmedPrompt::locked(attempt_id));
        }
        if s.screen.is_launcher() {
            s.tool_diff_preferences.reset_history_size();
        }
        s.renew_scope();
        if s.screen
            .launcher()
            .is_some_and(|l| l.authentication_required)
        {
            s.show_launcher();
        } else if s
            .screen
            .launcher()
            .is_some_and(|l| l.rebind_after_send.is_some())
            && crate::launcher::session_loaded(s)
        {
            s.show_chat();
        }
        if super::active_session(s).is_none()
            && s.screen
                .launcher()
                .and_then(|l| l.connection.as_ref())
                .is_some_and(|backend| {
                    s.files
                        .as_ref()
                        .is_some_and(|files| !files.uses_connection(backend))
                })
        {
            crate::git::project_opened(s);
        }
        if let Some(files) = &mut s.files {
            files.activate(true);
        }
        if let Some(git) = &mut s.git.owner {
            git.activate(true);
        }
    } else {
        let restore = match &item.saved {
            Tab::Workspace(w) => Some(w.clone()),
            _ => None,
        };
        s.show_launcher();
        if let Some(saved) = restore {
            crate::launcher::restore(s, saved);
        }
    }
    crate::settings::tab_activated(s);
    crate::chat::resume(s, tx);
    tx.instant();
}
pub fn select(s: &mut State, id: &str, tx: &mut Tx) {
    let allowed = s.workspace.as_ref().is_some_and(|ui| {
        ui.entries
            .iter()
            .position(|e| e.key == id)
            .is_some_and(|index| ui.active == index || !busy(s))
    });
    if allowed {
        s.notifications.supersede_navigation();
    }
    select_destination(s, id, tx);
}

pub fn select_relative(s: &mut State, next: bool, tx: &mut Tx) {
    let Some(key) = s.workspace.as_ref().and_then(|ui| {
        let len = ui.entries.len();
        if len <= 1 {
            return None;
        }
        let target = if next {
            (ui.active + 1) % len
        } else if ui.active == 0 {
            len - 1
        } else {
            ui.active - 1
        };
        ui.entries.get(target).map(|entry| entry.key.clone())
    }) else {
        return;
    };
    select(s, &key, tx);
    if s.workspace
        .as_ref()
        .is_some_and(|ui| ui.entries.get(ui.active).is_some_and(|e| e.key == key))
    {
        tx.scroll_into_view_in("project-tabs-scroll", format!("t-{key}"));
    }
}

pub fn select_index(s: &mut State, index: usize, tx: &mut Tx) {
    let Some(key) = s
        .workspace
        .as_ref()
        .and_then(|ui| ui.entries.get(index))
        .map(|entry| entry.key.clone())
    else {
        return;
    };
    select(s, &key, tx);
    if s.workspace
        .as_ref()
        .is_some_and(|ui| ui.entries.get(ui.active).is_some_and(|e| e.key == key))
    {
        tx.scroll_into_view_in("project-tabs-scroll", format!("t-{key}"));
    }
}

pub(super) fn select_destination(s: &mut State, id: &str, tx: &mut Tx) {
    let Some(index) = s
        .workspace
        .as_ref()
        .and_then(|ui| ui.entries.iter().position(|e| e.key == id))
    else {
        return;
    };
    if s.workspace.as_ref().is_some_and(|ui| ui.active == index) {
        crate::shell::Panels::dismiss_outside(s, tx);
        return;
    }
    if busy(s) {
        return;
    }
    stash(s);
    if let Some(ui) = &mut s.workspace {
        ui.active = index;
        ui.changed();
    }
    activate(s, tx);
    super::history_budget::enforce(s);
    capture(s);
}
pub fn can_new(s: &State) -> bool {
    !busy(s)
        && s.workspace
            .as_ref()
            .is_some_and(|ui| ui.entries.len() < super::super::MAX_TABS)
}
pub fn new_tab(s: &mut State, tx: &mut Tx) {
    if !can_new(s) {
        return;
    }
    s.notifications.supersede_navigation();
    stash(s);
    if let Some(ui) = &mut s.workspace {
        ui.entries
            .push(entry(format!("tab-{}", ui.next_key), Tab::Blank));
        ui.next_key += 1;
        ui.active = ui.entries.len() - 1;
        ui.changed();
    }
    activate(s, tx);
    super::history_budget::enforce(s);
    capture(s);
}
pub fn can_close_active(s: &State) -> bool {
    s.workspace
        .as_ref()
        .is_some_and(|ui| !busy(s) && !close_blocked(s, ui.active))
}

pub fn can_switch_tabs(s: &State) -> bool {
    s.workspace
        .as_ref()
        .is_some_and(|ui| ui.entries.len() > 1 && !busy(s))
}

pub(super) fn path_basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(path)
}

fn sanitize_project_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out = String::new();
    let mut units = 0usize;
    for ch in trimmed.chars() {
        let next = ch.len_utf16();
        if units + next > 256 {
            break;
        }
        out.push(ch);
        units += next;
    }
    let final_name = out.trim();
    (!final_name.is_empty()).then(|| final_name.to_owned())
}

pub fn active_project_title(s: &State) -> Option<&str> {
    let (_, saved) = super::active_workspace(s)?;
    Some(
        saved
            .project_name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(saved.folder.as_str()),
    )
}

pub fn tab_rename_seed(s: &State, tab_key: &str) -> Option<String> {
    let ui = s.workspace.as_ref()?;
    let entry = ui.entries.iter().find(|entry| entry.key == tab_key)?;
    let Tab::Workspace(saved) = &entry.saved else {
        return None;
    };
    Some(
        saved
            .project_name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| path_basename(&saved.folder))
            .to_owned(),
    )
}

pub fn tab_folder(s: &State, tab_key: &str) -> Option<String> {
    let ui = s.workspace.as_ref()?;
    ui.entries
        .iter()
        .find(|entry| entry.key == tab_key)
        .and_then(|entry| match &entry.saved {
            Tab::Workspace(w) => Some(w.folder.clone()),
            Tab::Blank => None,
        })
}

fn apply_folder_name(
    ui: &mut super::Ui,
    folder: &str,
    backend_id: &Option<String>,
    server_id: &Option<String>,
    raw_name: &str,
) -> bool {
    let next_name = sanitize_project_name(raw_name);
    let mut changed = false;
    for entry in &mut ui.entries {
        if let Tab::Workspace(w) = &mut entry.saved
            && super::same_folder(&w.folder, folder)
            && &w.backend_id == backend_id
            && (backend_id.is_none() || &w.server_id == server_id)
            && w.project_name != next_name
        {
            w.project_name = next_name.clone();
            changed = true;
        }
    }
    for w in &mut ui.closed {
        if super::same_folder(&w.folder, folder)
            && &w.backend_id == backend_id
            && (backend_id.is_none() || &w.server_id == server_id)
            && w.project_name != next_name
        {
            w.project_name = next_name.clone();
            changed = true;
        }
    }
    if changed {
        ui.changed();
    }
    changed
}

pub fn rename_tab(s: &mut State, tab_key: &str, raw_name: &str) -> bool {
    let Some(ui) = &mut s.workspace else {
        return false;
    };
    let Some((folder, backend_id, server_id)) = ui
        .entries
        .iter()
        .find(|entry| entry.key == tab_key)
        .and_then(|entry| match &entry.saved {
            Tab::Workspace(w) => {
                Some((w.folder.clone(), w.backend_id.clone(), w.server_id.clone()))
            }
            Tab::Blank => None,
        })
    else {
        return false;
    };
    apply_folder_name(ui, &folder, &backend_id, &server_id, raw_name)
}

fn current_backend_scope(s: &State) -> (Option<String>, Option<String>) {
    s.screen
        .launcher()
        .map_or((None, None), super::backend_scope)
}

pub fn open_tab_for_folder(s: &State, folder: &str) -> Option<String> {
    let ui = s.workspace.as_ref()?;
    let (backend_id, server_id) = current_backend_scope(s);
    ui.entries.iter().find_map(|entry| match &entry.saved {
        Tab::Workspace(w)
            if super::same_folder(&w.folder, folder)
                && w.backend_id == backend_id
                && (backend_id.is_none() || w.server_id == server_id) =>
        {
            Some(entry.key.clone())
        }
        _ => None,
    })
}

pub fn workspace_recent_folders(s: &State) -> Vec<(String, Option<String>, bool, Option<String>)> {
    let Some(ui) = s.workspace.as_ref() else {
        return Vec::new();
    };
    let (backend_id, server_id) = current_backend_scope(s);
    let matches_scope = |w: &Workspace| {
        w.backend_id == backend_id && (backend_id.is_none() || w.server_id == server_id)
    };
    let mut rows = Vec::new();
    for entry in &ui.entries {
        if let Tab::Workspace(w) = &entry.saved
            && matches_scope(w)
        {
            rows.push((
                w.folder.clone(),
                w.project_name.clone(),
                w.temporary,
                Some(entry.key.clone()),
            ));
        }
    }
    for w in ui.closed.iter().rev() {
        if matches_scope(w) {
            rows.push((w.folder.clone(), w.project_name.clone(), w.temporary, None));
        }
    }
    rows
}

pub fn rename_folder(s: &mut State, folder: &str, raw_name: &str) -> bool {
    let (backend_id, server_id) = current_backend_scope(s);
    let Some(ui) = &mut s.workspace else {
        return false;
    };
    apply_folder_name(ui, folder, &backend_id, &server_id, raw_name)
}

pub fn remove_closed_recent(s: &mut State, folder: &str) -> bool {
    let (backend_id, server_id) = current_backend_scope(s);
    let Some(ui) = &mut s.workspace else {
        return false;
    };
    let before = ui.closed.len();
    ui.closed.retain(|w| {
        !(super::same_folder(&w.folder, folder)
            && w.backend_id == backend_id
            && (backend_id.is_none() || w.server_id == server_id))
    });
    let changed = ui.closed.len() != before;
    if changed {
        ui.changed();
    }
    changed
}

pub fn close(s: &mut State, id: &str, tx: &mut Tx) {
    close_with_uuid(s, id, tx, || codenomad_client::http::random_uuid_v4().ok());
}

pub(super) fn close_with_uuid(
    s: &mut State,
    id: &str,
    tx: &mut Tx,
    next_uuid: impl FnMut() -> Option<String>,
) {
    crate::shell::Panels::dismiss_outside(s, tx);
    capture(s);
    if busy(s) {
        return;
    }
    let Some(index) = s
        .workspace
        .as_ref()
        .and_then(|ui| ui.entries.iter().position(|e| e.key == id))
    else {
        return;
    };
    if close_blocked(s, index) {
        return;
    }
    if super::temporary::temporary_tab_info(s, id).is_some() {
        crate::shell::temporary::request_close(s, id, tx);
        return;
    }
    close_ordinary_with_uuid(s, id, tx, next_uuid);
}

pub fn close_ordinary(s: &mut State, id: &str, tx: &mut Tx) {
    close_ordinary_with_uuid(s, id, tx, || codenomad_client::http::random_uuid_v4().ok());
}

fn close_ordinary_with_uuid(
    s: &mut State,
    id: &str,
    tx: &mut Tx,
    next_uuid: impl FnMut() -> Option<String>,
) {
    capture(s);
    if busy(s) {
        return;
    }
    let Some(index) = s
        .workspace
        .as_ref()
        .and_then(|ui| ui.entries.iter().position(|e| e.key == id))
    else {
        return;
    };
    if close_blocked(s, index) {
        return;
    }
    detach_entry(s, id, true, true, tx, next_uuid);
}

pub(super) fn detach_local_without_release(
    s: &mut State,
    id: &str,
    keep_drafts: bool,
    tx: &mut Tx,
) {
    detach_entry(s, id, keep_drafts, false, tx, || {
        codenomad_client::http::random_uuid_v4().ok()
    });
}

fn detach_entry(
    s: &mut State,
    id: &str,
    keep_drafts: bool,
    release_on_server: bool,
    tx: &mut Tx,
    mut next_uuid: impl FnMut() -> Option<String>,
) {
    let Some(index) = s
        .workspace
        .as_ref()
        .and_then(|ui| ui.entries.iter().position(|e| e.key == id))
    else {
        return;
    };
    let active = s.workspace.as_ref().is_some_and(|ui| ui.active == index);
    if keep_drafts {
        // Drain queued confirmations on the closing tab (active or cached inactive) before capturing
        // or recovering drafts from an ingress session.deleted hook so an already-confirmed prompt is
        // never resurrected.
        let closing_incoming_deleted = if active {
            crate::chat::events::drain_active_incoming_deleted(s)
        } else {
            super::observation::drain_inactive_for_close(s, index)
        };
        capture(s);
        let _ = super::drafts::drain_window_deleted_sessions_closing_with_uuid(
            s,
            Some(index),
            &mut next_uuid,
        );
        let active_visit_deleted: Vec<String> = if active {
            s.screen
                .launcher_mut()
                .map(|l| l.visits.poll_checks().deleted)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let pending_deleted: std::collections::BTreeSet<String> = s
            .workspace
            .as_mut()
            .map(|ui| {
                let mut ids: std::collections::BTreeSet<String> =
                    active_visit_deleted.into_iter().collect();
                let scope = ui.entries.get(index).and_then(|entry| match &entry.saved {
                    Tab::Workspace(saved) => Some(super::ProjectScope::from_workspace(saved)),
                    Tab::Blank => None,
                });
                if let Some(scope) = scope.as_ref() {
                    for (c_scope, c_id) in &ui.closed_pending_deleted {
                        if c_scope.same_scope(scope) {
                            ids.insert(c_id.clone());
                        }
                    }
                }
                if let Some(entry) = ui.entries.get_mut(index) {
                    ids.extend(entry.visits.poll_checks().deleted);
                    if closing_incoming_deleted
                        && let Tab::Workspace(saved) = &entry.saved
                        && let Some(active_id) = saved.active_session_id.as_deref()
                    {
                        ids.insert(active_id.to_owned());
                    }
                    ids.extend(std::mem::take(&mut entry.pending_deleted));
                }
                ids
            })
            .unwrap_or_default();
        let mut deferred = false;
        for deleted_id in pending_deleted {
            let outcome = super::drafts::recover_missing_session_draft_closing_with_uuid(
                s,
                index,
                &deleted_id,
                &mut next_uuid,
            );
            if outcome.deferred {
                if let Some(ui) = &mut s.workspace
                    && let Some(entry) = ui.entries.get_mut(index)
                {
                    entry.pending_deleted.insert(deleted_id);
                }
                deferred = true;
            }
        }
        if deferred {
            if let Some(ui) = &mut s.workspace
                && let Some(entry) = ui.entries.get_mut(index)
                && !entry.closing_deferred
            {
                entry.closing_deferred = true;
                ui.changed();
                ui.stage_with_stashed(s.temporary.stashed_for_snapshot());
            }
            return;
        }
        if let Some(ui) = &mut s.workspace
            && let Some(entry) = ui.entries.get_mut(index)
        {
            entry.closing_deferred = false;
        }
    }
    if active {
        s.notifications.supersede_navigation();
        stash(s);
    }
    crate::composer::recall::forget_tab(s, id);
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let mut removed = ui.entries.remove(index);
    let removed_binding = removed.binding.take();
    let removed_project = removed.project.take();
    let next_active = if index < ui.active {
        ui.active - 1
    } else {
        ui.active.min(ui.entries.len().saturating_sub(1))
    };
    s.notifications.forget_tab(id);
    let (propagate_to_active, propagate_locks) =
        if let Tab::Workspace(saved) = std::mem::replace(&mut removed.saved, Tab::Blank) {
            archive_or_purge_closed_workspace(ui, removed, saved, keep_drafts, active, next_active)
        } else {
            (None, Vec::new())
        };
    let release_target = if release_on_server {
        removed_binding.zip(removed_project)
    } else {
        None
    };
    propagate_closed_locks_to_entries(ui, &propagate_locks);
    if ui.entries.is_empty() {
        ui.entries
            .push(entry(format!("tab-{}", ui.next_key), Tab::Blank));
        ui.next_key += 1;
    }
    ui.active = if index < ui.active {
        ui.active - 1
    } else {
        ui.active.min(ui.entries.len() - 1)
    };
    ui.changed();
    if let Some((backend, project)) = release_target {
        crate::shell::blank_cleanup::abort_for_project(s, &project.id);
        platform::spawn(async move {
            let _ = backend.release_project(&project.id).await;
        });
    }
    if let Some(attempt_id) = propagate_to_active
        && s.composer.unconfirmed_state().is_none()
    {
        s.composer
            .restore_unconfirmed(crate::composer::UnconfirmedPrompt::locked(attempt_id));
    }
    if active {
        activate(s, tx);
    } else {
        tx.instant();
    }
    super::history_budget::enforce(s);
    capture(s);
}

fn normalize_closed_parallel_vecs(ui: &mut Ui) {
    while ui.closed_restored.len() < ui.closed.len() {
        let idx = ui.closed_restored.len();
        let w = &ui.closed[idx];
        let keys: std::collections::HashSet<String> = w
            .drafts
            .iter()
            .filter_map(|(id, text)| (!text.is_empty()).then_some(id.clone()))
            .chain(w.attachment_drafts.iter().cloned())
            .chain(w.attachment_parts.keys().cloned())
            .collect();
        ui.closed_restored.push(keys);
    }
    while ui.closed_restored.len() > ui.closed.len() {
        ui.closed_restored.pop();
    }
    while ui.closed_derived_from.len() < ui.closed.len() {
        ui.closed_derived_from.push(Default::default());
    }
    while ui.closed_derived_from.len() > ui.closed.len() {
        ui.closed_derived_from.pop();
    }
    while ui.closed_unconfirmed_attempts.len() < ui.closed.len() {
        ui.closed_unconfirmed_attempts.push(Default::default());
    }
    while ui.closed_unconfirmed_attempts.len() > ui.closed.len() {
        ui.closed_unconfirmed_attempts.pop();
    }
}

pub(super) fn purge_closed_scope(
    ui: &mut Ui,
    scope: &super::ProjectScope,
    extra_sessions: impl IntoIterator<Item = String>,
) {
    let other_open = ui
        .entries
        .iter()
        .any(|entry| matches!(&entry.saved, Tab::Workspace(other) if scope.matches(other)));
    if other_open {
        return;
    }
    normalize_closed_parallel_vecs(ui);
    let mut purge_sessions: std::collections::BTreeSet<String> =
        extra_sessions.into_iter().collect();
    let mut i = 0;
    while i < ui.closed.len() {
        if scope.matches(&ui.closed[i]) {
            let dropped = ui.closed.remove(i);
            purge_sessions.extend(dropped.drafts.into_keys());
            purge_sessions.extend(dropped.active_session_id);
            ui.closed_restored.remove(i);
            ui.closed_derived_from.remove(i);
            purge_sessions.extend(ui.closed_unconfirmed_attempts.remove(i).into_keys());
        } else {
            i += 1;
        }
    }
    ui.closed_pending_deleted
        .retain(|(s, _)| !s.same_scope(scope));
    ui.forget_closed_unconfirmed_for_project_scope(scope);
    for session_id in purge_sessions {
        ui.forget_closed_unconfirmed_for_scope(scope, &session_id);
    }
}

pub(super) fn propagate_closed_locks_to_entries(
    ui: &mut Ui,
    propagate_locks: &[(Workspace, String, String)],
) {
    for (saved, session_id, attempt_id) in propagate_locks {
        for entry in &mut ui.entries {
            if matches!(&entry.saved, Tab::Workspace(current) if same_project(current, saved)
                && current.active_session_id.as_deref() == Some(session_id.as_str()))
                && let Some(cache) = &mut entry.cache
            {
                cache.restore_unconfirmed(crate::composer::UnconfirmedPrompt::locked(
                    attempt_id.clone(),
                ));
            }
        }
    }
}

pub(super) fn archive_or_purge_closed_workspace(
    ui: &mut Ui,
    removed: super::Entry,
    mut saved: Workspace,
    keep_drafts: bool,
    active: bool,
    next_active: usize,
) -> (Option<String>, Vec<(Workspace, String, String)>) {
    let mut propagate_to_active: Option<String> = None;
    let mut propagate_locks: Vec<(Workspace, String, String)> = Vec::new();
    let active_matches = |ui: &Ui, saved: &Workspace, session_id: &str| {
        !active
            && ui.entries.get(next_active).is_some_and(|entry| {
                matches!(&entry.saved, Tab::Workspace(current) if same_project(current, saved)
                    && current.active_session_id.as_deref() == Some(session_id))
            })
    };
    if keep_drafts {
        let mut closed_unconfirmed_attempts: std::collections::BTreeMap<String, String> =
            Default::default();
        // Preserve unconfirmed attempt locks across tab closure without retaining inline attachment bytes.
        for (session_id, live) in &removed.live_drafts {
            if !removed.pending_drafts.contains(session_id)
                && let Some(unconfirmed) = live.unconfirmed_state()
            {
                let attempt_id = unconfirmed.id().to_owned();
                if !unconfirmed.is_edited() {
                    closed_unconfirmed_attempts.insert(session_id.clone(), attempt_id.clone());
                }
                ui.remember_closed_unconfirmed(&saved, session_id.clone(), unconfirmed.clone());
                propagate_locks.push((saved.clone(), session_id.clone(), attempt_id.clone()));
                if active_matches(ui, &saved, session_id) {
                    propagate_to_active = Some(attempt_id);
                }
            }
        }
        if let Some(session_id) = &saved.active_session_id
            && !removed.pending_drafts.contains(session_id)
            && let Some(unconfirmed) = removed.cache.as_ref().and_then(Cache::unconfirmed_state)
        {
            let attempt_id = unconfirmed.id().to_owned();
            if !unconfirmed.is_edited() {
                closed_unconfirmed_attempts.insert(session_id.clone(), attempt_id.clone());
            }
            ui.remember_closed_unconfirmed(&saved, session_id.clone(), unconfirmed.clone());
            propagate_locks.push((saved.clone(), session_id.clone(), attempt_id.clone()));
            if active_matches(ui, &saved, session_id) {
                propagate_to_active = Some(attempt_id);
            }
        }
        // Undelivered copies still belong to their closed source.
        saved
            .drafts
            .retain(|id, _| !removed.pending_drafts.contains(id));
        saved
            .attachment_drafts
            .retain(|id| !removed.pending_drafts.contains(id));
        saved
            .attachment_parts
            .retain(|id, _| !removed.pending_drafts.contains(id));
        // Exclude untouched restored copies already superseded by a previously closed sibling.
        for id in &removed.superseded_on_delete {
            if removed.restored_drafts.contains_key(id) {
                saved.drafts.remove(id);
                saved.attachment_drafts.remove(id);
                saved.attachment_parts.remove(id);
            }
        }
        // Apply clear authority against matching restored copies in ui.closed and open siblings
        // directly instead of writing blanket "" tombstones that could overwrite independent drafts.
        normalize_closed_parallel_vecs(ui);
        let scope = super::ProjectScope::from_workspace(&saved);
        for id in removed.pending_deleted {
            if !ui
                .closed_pending_deleted
                .iter()
                .any(|(existing_scope, existing_id)| {
                    existing_scope.same_scope(&scope) && existing_id == &id
                })
            {
                ui.closed_pending_deleted.push((scope.clone(), id));
            }
        }
        for (id, auth) in &removed.clear_authority {
            if !removed.cleared.contains(id) || removed.pending_drafts.contains(id) {
                continue;
            }
            for (idx, closed_w) in ui.closed.iter_mut().enumerate() {
                if !super::same_project(&saved, closed_w) {
                    continue;
                }
                if !ui.closed_restored[idx].contains(id) {
                    continue;
                }
                let copy = super::drafts::DraftCopy::from_workspace(closed_w, id);
                if auth.matches_restored(copy.as_ref()) {
                    closed_w.drafts.remove(id);
                    closed_w.attachment_drafts.remove(id);
                    closed_w.attachment_parts.remove(id);
                    ui.closed_restored[idx].remove(id);
                    ui.closed_derived_from[idx].remove(id);
                    ui.closed_unconfirmed_attempts[idx].remove(id);
                }
            }
            for other in &mut ui.entries {
                if !matches!(&other.saved, Tab::Workspace(w) if super::same_project(&saved, w)) {
                    continue;
                }
                if auth.matches_restored(other.restored_drafts.get(id)) {
                    other.superseded_on_delete.insert(id.clone());
                }
            }
        }
        let mut sync_keys: std::collections::BTreeSet<String> =
            removed.pending_drafts.iter().cloned().collect();
        sync_keys.extend(saved.drafts.keys().cloned());
        sync_keys.extend(saved.attachment_drafts.iter().cloned());
        sync_keys.extend(saved.attachment_parts.keys().cloned());
        sync_keys.extend(removed.clear_authority.keys().cloned());
        let restored_keys: std::collections::HashSet<String> = removed
            .restored_drafts
            .keys()
            .filter(|id| !removed.pending_drafts.contains(*id))
            .cloned()
            .collect();
        let derived_from: std::collections::BTreeMap<String, super::drafts::DraftCopy> = removed
            .derived_from
            .into_iter()
            .filter(|(id, _)| !removed.pending_drafts.contains(id))
            .collect();
        ui.closed.push(saved);
        ui.closed_restored.push(restored_keys);
        ui.closed_derived_from.push(derived_from);
        ui.closed_unconfirmed_attempts
            .push(closed_unconfirmed_attempts);
        let evicted = if ui.closed.len() > 16 {
            let old = ui.closed.remove(0);
            ui.closed_restored.remove(0);
            ui.closed_derived_from.remove(0);
            ui.closed_unconfirmed_attempts.remove(0);
            let old_scope = super::ProjectScope::from_workspace(&old);
            let old_keys: std::collections::BTreeSet<String> = old
                .drafts
                .keys()
                .chain(old.attachment_drafts.iter())
                .chain(old.attachment_parts.keys())
                .cloned()
                .collect();
            Some((old_scope, old_keys))
        } else {
            None
        };
        let entries = &ui.entries;
        let closed = &ui.closed;
        ui.closed_pending_deleted.retain(|(s, id)| {
            closed.iter().any(|w| {
                s.matches(w)
                    && (w.drafts.get(id).is_some_and(|t| !t.is_empty())
                        || w.attachment_drafts.contains(id)
                        || w.attachment_parts.contains_key(id))
            }) || entries
                .iter()
                .any(|e| matches!(&e.saved, Tab::Workspace(w) if s.matches(w)))
        });
        for id in &sync_keys {
            super::drafts::sync_pending_closed_projections(ui, &scope, id);
        }
        if let Some((old_scope, old_keys)) = evicted {
            for id in &old_keys {
                super::drafts::sync_pending_closed_projections(ui, &old_scope, id);
            }
        }
    } else {
        let scope = super::ProjectScope::from_workspace(&saved);
        purge_closed_scope(
            ui,
            &scope,
            removed
                .live_drafts
                .into_keys()
                .chain(saved.active_session_id),
        );
    }
    (propagate_to_active, propagate_locks)
}
pub(super) fn close_blocked(s: &State, index: usize) -> bool {
    let Some(ui) = &s.workspace else {
        return false;
    };
    if s.documents.has_tab_edits(&ui.entries[index].key) {
        return true;
    }
    if ui.entries[index].has_unsaved_large_drafts() {
        return true;
    }
    if let Tab::Workspace(saved) = &ui.entries[index].saved {
        let mut added = std::collections::BTreeSet::new();
        for (session_id, live) in &ui.entries[index].live_drafts {
            if !ui.entries[index].pending_drafts.contains(session_id)
                && live.unconfirmed_id().is_some()
                && !ui.has_closed_unconfirmed_for(saved, session_id)
            {
                added.insert(session_id.as_str());
            }
        }
        if let Some(session_id) = saved.active_session_id.as_deref()
            && !ui.entries[index].pending_drafts.contains(session_id)
            && !ui.has_closed_unconfirmed_for(saved, session_id)
        {
            let active_unconfirmed = if ui.active == index {
                s.composer.unconfirmed_id().is_some()
            } else {
                ui.entries[index]
                    .cache
                    .as_ref()
                    .and_then(Cache::unconfirmed_id)
                    .is_some()
            };
            if active_unconfirmed {
                added.insert(session_id);
            }
        }
        if !added.is_empty()
            && ui.closed_unconfirmed_count() + added.len() > super::MAX_UNCONFIRMED_LOCKS
        {
            return true;
        }
    }
    if ui.active == index {
        s.composer.blocks_navigation() || crate::agent::navigation_blocked(s)
    } else {
        ui.entries[index]
            .cache
            .as_ref()
            .is_some_and(Cache::navigation_blocked)
    }
}
