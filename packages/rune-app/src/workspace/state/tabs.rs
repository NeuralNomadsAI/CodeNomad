use super::{
    Cache, State, Tab, TextEdit, Tx, Ui, Workspace, busy, capture, capture_files_mode, entry,
    same_project,
};
use crate::platform;

pub(super) fn stash(s: &mut State) {
    // History browsing is temporary; inactive tabs retain only their fresh draft.
    crate::composer::recall::restore(s);
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
    let next_name = sanitize_project_name(raw_name);
    let mut changed = false;
    for entry in &mut ui.entries {
        if let Tab::Workspace(w) = &mut entry.saved
            && super::same_folder(&w.folder, &folder)
            && w.backend_id == backend_id
            && (backend_id.is_none() || w.server_id == server_id)
            && w.project_name != next_name
        {
            w.project_name = next_name.clone();
            changed = true;
        }
    }
    for w in &mut ui.closed {
        if super::same_folder(&w.folder, &folder)
            && w.backend_id == backend_id
            && (backend_id.is_none() || w.server_id == server_id)
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

pub fn close(s: &mut State, id: &str, tx: &mut Tx) {
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
    close_ordinary(s, id, tx);
}

pub fn close_ordinary(s: &mut State, id: &str, tx: &mut Tx) {
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
    detach_entry(s, id, true, true, tx);
}

pub(super) fn detach_local_without_release(
    s: &mut State,
    id: &str,
    keep_drafts: bool,
    tx: &mut Tx,
) {
    detach_entry(s, id, keep_drafts, false, tx);
}

fn detach_entry(s: &mut State, id: &str, keep_drafts: bool, release_on_server: bool, tx: &mut Tx) {
    let Some(index) = s
        .workspace
        .as_ref()
        .and_then(|ui| ui.entries.iter().position(|e| e.key == id))
    else {
        return;
    };
    let active = s.workspace.as_ref().is_some_and(|ui| ui.active == index);
    if active {
        s.notifications.supersede_navigation();
        stash(s);
    } else {
        capture(s);
    }
    crate::composer::recall::forget_tab(s, id);
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let removed = ui.entries.remove(index);
    let next_active = if index < ui.active {
        ui.active - 1
    } else {
        ui.active.min(ui.entries.len().saturating_sub(1))
    };
    s.notifications.forget_tab(id);
    let mut propagate_to_active: Option<String> = None;
    let mut propagate_locks: Vec<(Workspace, String, String)> = Vec::new();
    let active_matches = |ui: &Ui, saved: &Workspace, session_id: &str| {
        !active
            && ui.entries.get(next_active).is_some_and(|entry| {
                matches!(&entry.saved, Tab::Workspace(current) if same_project(current, saved)
                    && current.active_session_id.as_deref() == Some(session_id))
            })
    };
    if let Tab::Workspace(mut saved) = removed.saved {
        if keep_drafts {
            // Preserve unconfirmed attempt locks across tab closure without retaining inline attachment bytes.
            for (session_id, live) in &removed.live_drafts {
                if !removed.pending_drafts.contains(session_id)
                    && let Some(unconfirmed) = live.unconfirmed_state()
                {
                    let attempt_id = unconfirmed.id().to_owned();
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
            // Clear authority belongs to this occurrence's live lifetime, outside text budgets.
            saved.drafts.extend(
                removed
                    .cleared
                    .into_iter()
                    .filter(|id| !removed.pending_drafts.contains(id))
                    .map(|id| (id, String::new())),
            );
            ui.closed.push(saved);
            if ui.closed.len() > 16 {
                ui.closed.remove(0);
            }
        } else {
            let folder = &saved.folder;
            let backend_id = saved.backend_id.as_deref();
            let server_id = saved.server_id.as_deref();
            let other_open = ui.entries.iter().any(|entry| {
                matches!(&entry.saved, Tab::Workspace(other)
                    if super::same_folder(&other.folder, folder)
                        && other.backend_id.as_deref() == backend_id
                        && (backend_id.is_none() || other.server_id.as_deref() == server_id))
            });
            if !other_open {
                ui.closed.retain(|w| {
                    !(super::same_folder(&w.folder, folder)
                        && w.backend_id.as_deref() == backend_id
                        && (backend_id.is_none() || w.server_id.as_deref() == server_id))
                });
            }
        }
    }
    let release_target = if release_on_server {
        removed.binding.zip(removed.project)
    } else {
        None
    };
    for (saved, session_id, attempt_id) in propagate_locks {
        for entry in &mut ui.entries {
            if matches!(&entry.saved, Tab::Workspace(current) if same_project(current, &saved)
                && current.active_session_id.as_deref() == Some(session_id.as_str()))
                && let Some(cache) = &mut entry.cache
            {
                cache.restore_unconfirmed(crate::composer::UnconfirmedPrompt::locked(
                    attempt_id.clone(),
                ));
            }
        }
    }
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
