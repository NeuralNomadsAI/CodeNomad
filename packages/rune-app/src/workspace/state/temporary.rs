use super::{
    Backend, Entry, Project, State, Tab, Tx, Ui, activate, busy, capture, close_blocked,
    drafts::LiveDraft, entry, same_folder, tabs,
};
use crate::platform;

pub(crate) struct TemporaryTabInfo {
    pub tab_key: String,
    pub folder: String,
    pub backend_id: Option<String>,
    pub server_id: Option<String>,
    pub backend: Backend,
    pub project: Project,
    pub untouched: bool,
}

pub(crate) struct StashedTemporary {
    pub tab_key: String,
    pub(super) original_index: usize,
    pub(super) was_active: bool,
    pub(super) created_blank_key: Option<String>,
    pub(super) entry: Entry,
    pub backend: Backend,
    pub project: Project,
    pub folder: String,
    pub backend_id: Option<String>,
    pub server_id: Option<String>,
    pub return_focus: Option<String>,
}

impl StashedTemporary {
    pub(crate) fn is_temporary(&self) -> bool {
        matches!(&self.entry.saved, Tab::Workspace(w) if w.temporary)
    }

    pub(crate) fn clear_temporary(&mut self) {
        if let Tab::Workspace(w) = &mut self.entry.saved {
            w.temporary = false;
        }
        self.entry.unmarked_by_registry = false;
        if let Some(project) = &mut self.entry.project {
            project.temporary = false;
        }
        self.project.temporary = false;
    }
}

pub(crate) fn stashed_has_in_memory_state(s: &State, stashed: &StashedTemporary) -> bool {
    s.documents.has_tab_edits(&stashed.tab_key)
        || stashed.entry.has_in_memory_only_drafts()
        || stashed
            .entry
            .cache
            .as_ref()
            .is_some_and(super::Cache::navigation_blocked)
}

pub(crate) fn has_temporary_tabs(s: &State) -> bool {
    s.temporary.stashed_for_snapshot().is_some()
        || s.workspace.as_ref().is_some_and(|ui| {
            ui.entries
                .iter()
                .any(|item| matches!(&item.saved, Tab::Workspace(w) if w.temporary))
        })
        || s.screen
            .launcher()
            .and_then(|l| l.project.as_ref())
            .is_some_and(|p| p.temporary)
}

fn current_backend_identity(s: &State) -> Option<(Option<String>, Option<String>)> {
    let l = s.screen.launcher()?;
    let backend_id = if l.local_connection() {
        None
    } else {
        Some(
            if cfg!(target_arch = "wasm32") {
                "web"
            } else {
                "external"
            }
            .to_owned(),
        )
    };
    let server_id = backend_id.as_ref().and_then(|_| l.server_id.clone());
    Some((backend_id, server_id))
}

fn matches_backend(
    w: &crate::workspace::Workspace,
    backend_id: Option<&str>,
    server_id: Option<&str>,
) -> bool {
    w.backend_id.as_deref() == backend_id
        && (backend_id.is_none() || w.server_id.as_deref() == server_id)
}

pub(crate) fn temporary_tab_info(s: &State, tab_key: &str) -> Option<TemporaryTabInfo> {
    let ui = s.workspace.as_ref()?;
    let index = ui.entries.iter().position(|e| e.key == tab_key)?;
    let item = &ui.entries[index];
    let Tab::Workspace(saved) = &item.saved else {
        return None;
    };
    if !saved.temporary {
        return None;
    }
    let backend = item.binding.clone()?;
    let project = item.project.clone()?;
    let is_active = ui.active == index;
    let no_conversations = saved.active_session_id.is_none()
        && if is_active {
            s.screen.launcher().is_some_and(|l| {
                l.sessions.is_empty()
                    && l.listed_sessions.is_empty()
                    && l.next.is_none()
                    && !l.is_listing()
                    && !l.creation_uncertain
            })
        } else {
            item.sessions.is_empty()
                && item.listed_sessions.is_empty()
                && item.next.is_none()
                && !item.creation_uncertain
        };
    let no_drafts = saved.drafts.values().all(|text| text.trim().is_empty())
        && saved.attachment_drafts.is_empty()
        && saved.attachment_parts.is_empty()
        && !item.live_drafts.values().any(LiveDraft::has_content)
        && (!is_active
            || (s.draft.text.trim().is_empty() && s.composer.draft.attachments.is_empty()));
    let no_edits = !s.documents.has_tab_edits(&item.key);
    Some(TemporaryTabInfo {
        tab_key: item.key.clone(),
        folder: saved.folder.clone(),
        backend_id: saved.backend_id.clone(),
        server_id: saved.server_id.clone(),
        backend,
        project,
        untouched: no_conversations && no_drafts && no_edits,
    })
}

pub(crate) fn active_temporary_workspace(s: &State) -> Option<TemporaryTabInfo> {
    let key = s.workspace.as_ref()?.active_key().to_owned();
    temporary_tab_info(s, &key)
}

pub(crate) fn next_temporary_name(ui: &Ui, base: &str) -> String {
    let existing: std::collections::HashSet<String> = ui
        .entries
        .iter()
        .filter_map(|item| match &item.saved {
            Tab::Workspace(w) => Some(
                w.project_name
                    .as_deref()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| tabs::path_basename(&w.folder))
                    .to_owned(),
            ),
            Tab::Blank => None,
        })
        .collect();
    if !existing.contains(base) {
        return base.to_owned();
    }
    let mut suffix = 2u32;
    loop {
        let candidate = format!("{base} ({suffix})");
        if !existing.contains(&candidate) {
            return candidate;
        }
        suffix = suffix.saturating_add(1);
    }
}

pub(crate) fn stash_for_discard(
    s: &mut State,
    tab_key: &str,
    return_focus: Option<String>,
    tx: &mut Tx,
) -> Option<StashedTemporary> {
    crate::shell::Panels::dismiss_outside(s, tx);
    if busy(s) {
        return None;
    }
    let index = s
        .workspace
        .as_ref()?
        .entries
        .iter()
        .position(|e| e.key == tab_key)?;
    if close_blocked(s, index) {
        return None;
    }
    let was_active = s.workspace.as_ref().is_some_and(|ui| ui.active == index);
    if was_active {
        s.notifications.supersede_navigation();
        tabs::stash(s);
    } else {
        capture(s);
    }
    let ui = s.workspace.as_mut()?;
    let removed = ui.entries.remove(index);
    let (Some(backend), Some(project), Tab::Workspace(saved)) = (
        removed.binding.clone(),
        removed.project.clone(),
        &removed.saved,
    ) else {
        ui.entries.insert(index, removed);
        return None;
    };
    let folder = saved.folder.clone();
    let backend_id = saved.backend_id.clone();
    let server_id = saved.server_id.clone();
    let mut created_blank_key = None;
    if ui.entries.is_empty() {
        let blank_key = format!("tab-{}", ui.next_key);
        ui.entries.push(entry(blank_key.clone(), Tab::Blank));
        ui.next_key += 1;
        created_blank_key = Some(blank_key);
    }
    ui.active = if index < ui.active {
        ui.active - 1
    } else {
        ui.active.min(ui.entries.len() - 1)
    };
    if was_active {
        activate(s, tx);
    } else {
        tx.instant();
    }
    Some(StashedTemporary {
        tab_key: tab_key.to_owned(),
        original_index: index,
        was_active,
        created_blank_key,
        entry: removed,
        backend,
        project,
        folder,
        backend_id,
        server_id,
        return_focus,
    })
}

pub(crate) fn restore_stashed(
    s: &mut State,
    stashed: StashedTemporary,
    restore_focus: bool,
    tx: &mut Tx,
) {
    if stashed.was_active {
        // Cancel only a neighbour restore triggered when yielding to an unopened neighbour.
        let _ = crate::launcher::cancel_pending_restore(s);
    }
    let active_busy = s.status_permissions.settling()
        || s.transcript_display.messages.pending()
        || s.screen.launcher().is_some_and(|l| l.pending)
        || s.composer.blocks_navigation()
        || crate::agent::navigation_blocked(s);
    let activate_restored = stashed.was_active && !active_busy;
    if activate_restored {
        // Avoid stashing an empty cache onto an unopened neighbour so selecting it later
        // still runs launcher::restore cleanly.
        let active_opened = s
            .workspace
            .as_ref()
            .and_then(|ui| ui.entries.get(ui.active))
            .is_some_and(|entry| entry.project.is_some());
        if active_opened {
            tabs::stash(s);
        }
    }
    let focus_target = (restore_focus && activate_restored).then(|| {
        stashed
            .return_focus
            .clone()
            .unwrap_or_else(|| format!("t-{}", stashed.tab_key))
    });
    let Some(ui) = &mut s.workspace else {
        return;
    };
    if activate_restored
        && let Some(blank_key) = &stashed.created_blank_key
        && let Some(pos) = ui
            .entries
            .iter()
            .position(|e| e.key == *blank_key && matches!(e.saved, Tab::Blank))
    {
        ui.entries.remove(pos);
        if ui.active > pos {
            ui.active -= 1;
        }
    }
    let insert_at = stashed.original_index.min(ui.entries.len());
    ui.entries.insert(insert_at, stashed.entry);
    if let Tab::Workspace(w) = &ui.entries[insert_at].saved
        && !ui.entries[insert_at].pending_drafts.is_empty()
    {
        let scope = super::ProjectScope::from_workspace(w);
        let ids: Vec<String> = ui.entries[insert_at]
            .pending_drafts
            .iter()
            .cloned()
            .collect();
        for id in ids {
            super::drafts::sync_pending_closed_projections(ui, &scope, &id);
        }
    }
    if activate_restored {
        ui.active = insert_at;
        ui.changed();
        activate(s, tx);
    } else {
        if insert_at <= ui.active {
            ui.active += 1;
        }
        ui.changed();
        tx.instant();
    }
    capture(s);
    if let Some(target) = focus_target {
        tx.return_focus(target, tx.focus_visible());
    }
}

pub(crate) fn finish_discarded(
    s: &mut State,
    mut stashed: StashedTemporary,
    keep_drafts: bool,
    release_on_server: bool,
    tx: &mut Tx,
) {
    s.notifications.forget_tab(&stashed.tab_key);
    let mut propagate_to_active = None;
    if let Some(ui) = &mut s.workspace {
        let entry = std::mem::replace(&mut stashed.entry, super::entry(String::new(), Tab::Blank));
        if let Tab::Workspace(mut saved) = entry.saved.clone() {
            if keep_drafts {
                saved.temporary = false;
            }
            let active_idx = ui.active;
            let (to_active, locks) = tabs::archive_or_purge_closed_workspace(
                ui,
                entry,
                saved,
                keep_drafts,
                false,
                active_idx,
            );
            tabs::propagate_closed_locks_to_entries(ui, &locks);
            propagate_to_active = to_active;
        } else if !keep_drafts {
            let scope = super::ProjectScope {
                backend_id: stashed.backend_id.clone(),
                server_id: if stashed.backend_id.is_some() {
                    stashed.server_id.clone()
                } else {
                    None
                },
                folder: stashed.folder.clone(),
            };
            tabs::purge_closed_scope(ui, &scope, entry.live_drafts.into_keys());
        }
        ui.changed();
    }
    if let Some(attempt_id) = propagate_to_active
        && s.composer.unconfirmed_state().is_none()
    {
        s.composer
            .restore_unconfirmed(crate::composer::UnconfirmedPrompt::locked(attempt_id));
    }
    if release_on_server {
        crate::shell::blank_cleanup::abort_for_project(s, &stashed.project.id);
        let backend = stashed.backend.clone();
        let project_id = stashed.project.id.clone();
        platform::spawn(async move {
            let _ = backend.release_project(&project_id).await;
        });
    }
    stashed.entry.project = None;
    stashed.entry.binding = None;
    capture(s);
    tx.instant();
}

pub(crate) fn clear_temporary_mark(
    s: &mut State,
    folder: &str,
    backend_id: Option<&str>,
    server_id: Option<&str>,
) -> bool {
    let mut changed = false;
    if let Some(ui) = &mut s.workspace {
        for item in &mut ui.entries {
            if let Tab::Workspace(w) = &mut item.saved
                && same_folder(&w.folder, folder)
                && matches_backend(w, backend_id, server_id)
            {
                if w.temporary {
                    w.temporary = false;
                    changed = true;
                }
                item.unmarked_by_registry = false;
                if let Some(project) = &mut item.project
                    && project.temporary
                {
                    project.temporary = false;
                    changed = true;
                }
            }
        }
        for w in &mut ui.closed {
            if same_folder(&w.folder, folder)
                && matches_backend(w, backend_id, server_id)
                && w.temporary
            {
                w.temporary = false;
                changed = true;
            }
        }
        if changed {
            ui.changed();
        }
    }
    if let Some(stashed) = s.temporary.stashed_for_snapshot_mut()
        && let Tab::Workspace(w) = &mut stashed.entry.saved
        && same_folder(&w.folder, folder)
        && matches_backend(w, backend_id, server_id)
    {
        if w.temporary
            || stashed.entry.unmarked_by_registry
            || stashed.project.temporary
            || stashed.entry.project.as_ref().is_some_and(|p| p.temporary)
        {
            stashed.clear_temporary();
            changed = true;
            if let Some(ui) = &mut s.workspace {
                ui.changed();
            }
        }
    }
    if let Some(l) = s.screen.launcher_mut()
        && let Some(project) = &mut l.project
        && same_folder(&project.path, folder)
        && project.temporary
    {
        project.temporary = false;
        changed = true;
    }
    changed
}

pub(crate) fn reconcile_temporary_folders(s: &mut State, folders: &[String]) -> bool {
    let Some((backend_id, server_id)) = current_backend_identity(s) else {
        return false;
    };
    let mut changed = false;
    let mut cleared_tabs = Vec::new();
    if let Some(ui) = &mut s.workspace {
        for item in &mut ui.entries {
            if let Tab::Workspace(w) = &mut item.saved
                && matches_backend(w, backend_id.as_deref(), server_id.as_deref())
            {
                let is_temp = folders.iter().any(|f| same_folder(f, &w.folder));
                if w.temporary != is_temp {
                    w.temporary = is_temp;
                    if !is_temp {
                        item.unmarked_by_registry = true;
                        cleared_tabs.push(item.key.clone());
                    } else {
                        item.unmarked_by_registry = false;
                    }
                    changed = true;
                }
                if let Some(project) = &mut item.project
                    && project.temporary != is_temp
                {
                    project.temporary = is_temp;
                    changed = true;
                }
            }
        }
        for w in &mut ui.closed {
            if matches_backend(w, backend_id.as_deref(), server_id.as_deref()) {
                let is_temp = folders.iter().any(|f| same_folder(f, &w.folder));
                if w.temporary != is_temp {
                    w.temporary = is_temp;
                    changed = true;
                }
            }
        }
        if changed {
            ui.changed();
        }
    }
    if let Some(stashed) = s.temporary.stashed_for_snapshot_mut()
        && let Tab::Workspace(w) = &mut stashed.entry.saved
        && matches_backend(w, backend_id.as_deref(), server_id.as_deref())
    {
        let is_temp = folders.iter().any(|f| same_folder(f, &w.folder));
        let mut stashed_changed = false;
        if w.temporary != is_temp {
            w.temporary = is_temp;
            stashed.entry.unmarked_by_registry = !is_temp;
            stashed_changed = true;
        }
        if let Some(project) = &mut stashed.entry.project
            && project.temporary != is_temp
        {
            project.temporary = is_temp;
            stashed_changed = true;
        }
        if stashed.project.temporary != is_temp {
            stashed.project.temporary = is_temp;
            stashed_changed = true;
        }
        if stashed_changed {
            changed = true;
            if let Some(ui) = &mut s.workspace {
                ui.changed();
            }
        }
    }
    if let Some(l) = s.screen.launcher_mut()
        && let Some(project) = &mut l.project
    {
        let is_temp = folders.iter().any(|f| same_folder(f, &project.path));
        if project.temporary != is_temp {
            project.temporary = is_temp;
            changed = true;
        }
    }
    for tab_key in cleared_tabs {
        crate::shell::temporary::dismiss_for_tab(s, &tab_key);
    }
    changed
}

fn has_unsaved_temporary_state(s: &State, index: usize) -> bool {
    let Some(ui) = &s.workspace else {
        return false;
    };
    let Some(item) = ui.entries.get(index) else {
        return false;
    };
    let active = ui.active == index;
    let active_device_state = active
        && (s.composer.device.busy() || crate::composer::recall::fresh(s).1.inline_usage().0 != 0);
    let form_drafts = if active {
        s.agent
            .as_ref()
            .is_some_and(crate::agent::Ui::has_unsaved_form_drafts)
    } else {
        item.cache
            .as_ref()
            .is_some_and(super::Cache::has_unsaved_form_drafts)
    };
    active_device_state
        || form_drafts
        || close_blocked(s, index)
        || item.has_in_memory_only_drafts()
}

pub(crate) fn close_after_keep(s: &mut State, tab_key: &str, tx: &mut Tx) -> bool {
    capture(s);
    if busy(s) {
        return false;
    }
    let blocked = s
        .workspace
        .as_ref()
        .and_then(|ui| ui.entries.iter().position(|item| item.key == tab_key))
        .is_none_or(|index| has_unsaved_temporary_state(s, index));
    if blocked {
        return false;
    }
    tabs::close_ordinary(s, tab_key, tx);
    true
}

pub(crate) fn detach_dead_temporary(s: &mut State, tab_key: &str, tx: &mut Tx) -> bool {
    capture(s);
    let blocked = s
        .workspace
        .as_ref()
        .and_then(|ui| ui.entries.iter().position(|item| item.key == tab_key))
        .is_none_or(|index| has_unsaved_temporary_state(s, index));
    if blocked {
        return false;
    }
    if let Some(project_id) = s.workspace.as_ref().and_then(|ui| {
        let index = ui.entries.iter().position(|item| item.key == tab_key)?;
        if ui.active == index {
            s.screen
                .launcher()
                .and_then(|l| l.project.as_ref())
                .map(|p| p.id.clone())
        } else {
            ui.entries[index].project.as_ref().map(|p| p.id.clone())
        }
    }) {
        crate::shell::blank_cleanup::abort_for_project(s, &project_id);
    }
    crate::shell::temporary::dismiss_for_tab(s, tab_key);
    tabs::detach_local_without_release(s, tab_key, true, tx);
    true
}

pub(crate) fn detach_stopped_temporary(
    s: &mut State,
    workspace_id: &str,
    deleted: bool,
    temporary_retained: bool,
    tx: &mut Tx,
) -> bool {
    capture(s);
    let keep_drafts = !(deleted && !temporary_retained);
    let keys: Vec<String> = s
        .workspace
        .as_ref()
        .map(|ui| {
            ui.entries
                .iter()
                .enumerate()
                .filter(|(index, item)| {
                    let matches_workspace =
                        item.project.as_ref().is_some_and(|p| p.id == workspace_id);
                    let matches_temp = matches!(
                        &item.saved,
                        Tab::Workspace(w)
                            if w.temporary || (!keep_drafts && item.unmarked_by_registry)
                    );
                    if !matches_workspace || !matches_temp {
                        return false;
                    }
                    // When the server retained the folder on disk, never forcefully drop a tab
                    // carrying in-memory-only drafts/attachments, unsaved file edits, or pending forms.
                    if keep_drafts && has_unsaved_temporary_state(s, *index) {
                        return false;
                    }
                    true
                })
                .map(|(_, item)| item.key.clone())
                .collect()
        })
        .unwrap_or_default();
    if keys.is_empty() {
        return false;
    }
    crate::shell::blank_cleanup::abort_for_project(s, workspace_id);
    for tab_key in keys {
        crate::shell::temporary::dismiss_for_tab(s, &tab_key);
        tabs::detach_local_without_release(s, &tab_key, keep_drafts, tx);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Screen, init, launcher::Launcher};
    use rune::{Env, Runtime};

    #[test]
    fn detach_stopped_temporary_keeps_drafts_when_retained_and_purges_when_deleted() {
        let mut s = init();
        s.screen = Screen::Launcher(Box::new(Launcher::fixture()));
        let mut ui = Ui::new();
        ui.fixture_ready();
        let project_retained = Project {
            id: "ws-retained".into(),
            path: "/tmp/cn-ret".into(),
            temporary: true,
        };
        let project_deleted = Project {
            id: "ws-deleted".into(),
            path: "/tmp/cn-del".into(),
            temporary: true,
        };
        let mut w_ret = crate::workspace::Workspace {
            backend_id: None,
            server_id: None,
            folder: "/tmp/cn-ret".into(),
            project_name: None,
            temporary: true,
            occurrence: 1,
            workspace_id: Some("ws-retained".into()),
            active_session_id: None,
            drafts: Default::default(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        };
        w_ret.drafts.insert("s-1".into(), "keep me".into());
        let mut e_ret = entry("tab-0".into(), Tab::Workspace(w_ret));
        e_ret.project = Some(project_retained);

        let mut w_del = crate::workspace::Workspace {
            backend_id: None,
            server_id: None,
            folder: "/tmp/cn-del".into(),
            project_name: None,
            temporary: true,
            occurrence: 1,
            workspace_id: Some("ws-deleted".into()),
            active_session_id: None,
            drafts: Default::default(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        };
        w_del.drafts.insert("s-2".into(), "drop me".into());
        let mut e_del = entry("tab-1".into(), Tab::Workspace(w_del));
        e_del.project = Some(project_deleted);

        ui.entries = vec![e_ret, e_del];
        ui.active = 0;
        s.workspace = Some(ui);
        let mut rt = Runtime::new(s, |_, _| rune::el(), (800.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| {
            assert!(detach_stopped_temporary(s, "ws-retained", true, true, tx));
            assert!(detach_stopped_temporary(s, "ws-deleted", true, false, tx));
        });
        let closed = &rt.state.workspace.as_ref().unwrap().closed;
        assert!(
            closed.iter().any(|w| w.folder == "/tmp/cn-ret"
                && w.drafts.get("s-1").map(String::as_str) == Some("keep me")),
            "retained workspace.stopped must preserve drafts in ui.closed"
        );
        assert!(
            closed.iter().all(|w| w.folder != "/tmp/cn-del"),
            "deleted non-retained workspace.stopped must purge drafts"
        );
    }

    #[test]
    fn retained_stopped_preserves_oversized_live_draft_and_late_deleted_stop_detaches_after_registry()
     {
        let mut s = init();
        let mut l = Launcher::fixture();
        l.server_id = Some("srv-test".into());
        s.screen = Screen::Launcher(Box::new(l));
        let mut ui = Ui::new();
        ui.fixture_ready();

        // Tab 0: oversized in-memory live_draft -> retained stop must keep tab open!
        let w_big = crate::workspace::Workspace {
            backend_id: Some("external".into()),
            server_id: Some("srv-test".into()),
            folder: "/tmp/cn-big".into(),
            project_name: None,
            temporary: true,
            occurrence: 1,
            workspace_id: Some("ws-big".into()),
            active_session_id: Some("s-big".into()),
            drafts: Default::default(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        };
        let mut e_big = entry("tab-0".into(), Tab::Workspace(w_big));
        e_big.project = Some(Project {
            id: "ws-big".into(),
            path: "/tmp/cn-big".into(),
            temporary: true,
        });
        e_big.live_drafts.insert(
            "s-big".into(),
            LiveDraft::fixture_oversized("x".repeat(70_000)),
        );

        // Tab 1: unmarked by an earlier temporaryChanged poll, then receives late deleted stop!
        let w_late = crate::workspace::Workspace {
            backend_id: Some("external".into()),
            server_id: Some("srv-test".into()),
            folder: "/tmp/cn-late".into(),
            project_name: None,
            temporary: true,
            occurrence: 1,
            workspace_id: Some("ws-late".into()),
            active_session_id: None,
            drafts: Default::default(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        };
        let mut e_late = entry("tab-1".into(), Tab::Workspace(w_late));
        e_late.project = Some(Project {
            id: "ws-late".into(),
            path: "/tmp/cn-late".into(),
            temporary: true,
        });

        // Tab 2: device attachment in live_drafts -> retained stop must also keep tab open!
        let w_dev = crate::workspace::Workspace {
            backend_id: Some("external".into()),
            server_id: Some("srv-test".into()),
            folder: "/tmp/cn-dev".into(),
            project_name: None,
            temporary: true,
            occurrence: 1,
            workspace_id: Some("ws-dev".into()),
            active_session_id: Some("s-dev".into()),
            drafts: Default::default(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        };
        let mut e_dev = entry("tab-2".into(), Tab::Workspace(w_dev));
        e_dev.project = Some(Project {
            id: "ws-dev".into(),
            path: "/tmp/cn-dev".into(),
            temporary: true,
        });
        e_dev.live_drafts.insert(
            "s-dev".into(),
            LiveDraft::fixture_device_attachment("photo.png", b"png-bytes"),
        );

        ui.entries = vec![e_big, e_late, e_dev];
        ui.active = 0;
        s.workspace = Some(ui);
        let mut rt = Runtime::new(s, |_, _| rune::el(), (800.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| {
            // 1. Retained stop on tabs with oversized live_draft or device attachments keeps them open
            assert!(!detach_stopped_temporary(s, "ws-big", true, true, tx));
            assert!(!detach_stopped_temporary(s, "ws-dev", true, true, tx));
            assert_eq!(s.workspace.as_ref().unwrap().entries.len(), 3);

            // 2. Registry update arrives BEFORE workspace.stopped in an earlier poll
            assert!(reconcile_temporary_folders(
                s,
                &["/tmp/cn-big".into(), "/tmp/cn-dev".into()]
            ));
            // Late deleted non-retained stop still detaches tab-1 cleanly!
            assert!(detach_stopped_temporary(s, "ws-late", true, false, tx));
        });
        assert_eq!(rt.state.workspace.as_ref().unwrap().entries.len(), 2);
        assert_eq!(rt.state.workspace.as_ref().unwrap().entries[0].key, "tab-0");
        assert_eq!(rt.state.workspace.as_ref().unwrap().entries[1].key, "tab-2");
    }

    #[test]
    fn restore_stashed_leaves_unopened_neighbour_uncached_and_preserves_unrelated_pending_job() {
        let mut s = init();
        let mut l = Launcher::fixture();
        let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        let temp_project = Project {
            id: "ws-yield".into(),
            path: "/tmp/cn-yield".into(),
            temporary: true,
        };
        l.connection = Some(backend.clone());
        l.server_id = Some("srv-neigh".into());
        l.project = Some(temp_project.clone());
        s.screen = Screen::Launcher(Box::new(l));
        let mut ui = Ui::new();
        ui.fixture_ready();

        // tab-0: restored-but-unopened neighbour (project: None, binding: None, cache: None)
        let w_neigh = crate::workspace::Workspace {
            backend_id: Some("external".into()),
            server_id: Some("srv-neigh".into()),
            folder: "/repo/unopened".into(),
            project_name: None,
            temporary: false,
            occurrence: 1,
            workspace_id: None,
            active_session_id: None,
            drafts: Default::default(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        };
        let e_neigh = entry("tab-0".into(), Tab::Workspace(w_neigh));

        // tab-1: active opened temporary workspace
        let w_temp = crate::workspace::Workspace {
            backend_id: Some("external".into()),
            server_id: Some("srv-neigh".into()),
            folder: "/tmp/cn-yield".into(),
            project_name: None,
            temporary: true,
            occurrence: 1,
            workspace_id: Some("ws-yield".into()),
            active_session_id: None,
            drafts: Default::default(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        };
        let mut e_temp = entry("tab-1".into(), Tab::Workspace(w_temp));
        e_temp.binding = Some(backend);
        e_temp.project = Some(Project {
            id: "ws-yield".into(),
            path: "/tmp/cn-yield".into(),
            temporary: true,
        });

        ui.entries = vec![e_neigh, e_temp];
        ui.active = 1;
        s.workspace = Some(ui);
        let mut rt = Runtime::new(s, |_, _| rune::el(), (800.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| {
            let stashed = stash_for_discard(s, "tab-1", Some("t-tab-1".into()), tx)
                .expect("stash active temporary tab");
            // Yielding to unopened neighbour tab-0 started launcher::restore tagged with "tab-0"
            assert_eq!(
                s.screen
                    .launcher()
                    .and_then(|l| l.pending_restore_intent.as_deref()),
                Some("tab-0")
            );
            assert!(s.screen.launcher().is_some_and(|l| l.pending));
            restore_stashed(s, stashed, true, tx);
            assert!(
                s.screen.launcher().is_some_and(|l| !l.pending),
                "restore_stashed must cancel neighbour restore"
            );
            assert!(
                s.workspace.as_ref().unwrap().entries[0].cache.is_none(),
                "unopened neighbour must not receive an empty cache so later clicks still restore it"
            );

            // Now verify an unrelated pending job on an opened neighbour (e.g. CreateSession,
            // pending_restore_intent == None) keeps the neighbour active so its Reply::Created
            // binds to the neighbour rather than the restored temporary tab!
            let neigh_project = Project {
                id: "ws-neigh-open".into(),
                path: "/repo/unopened".into(),
                temporary: false,
            };
            s.workspace.as_mut().unwrap().entries[0].project = Some(neigh_project.clone());
            let stashed2 = stash_for_discard(s, "tab-1", Some("t-tab-1".into()), tx)
                .expect("stash active temporary tab again");
            if let Some(l) = s.screen.launcher_mut() {
                l.project = Some(neigh_project.clone());
                l.pending = true;
                l.pending_restore_intent = None;
            }
            restore_stashed(s, stashed2, true, tx);
            assert!(
                s.screen.launcher().is_some_and(|l| l.pending),
                "unrelated non-restore pending job must not be cancelled by restore_stashed"
            );
            assert_eq!(
                s.workspace.as_ref().unwrap().active_key(),
                "tab-0",
                "neighbour tab with in-flight job must remain active until its job settles"
            );
            assert_eq!(
                s.screen
                    .launcher()
                    .and_then(|l| l.project.as_ref())
                    .map(|p| p.id.as_str()),
                Some("ws-neigh-open"),
                "active launcher project must remain the neighbour owning the pending job"
            );
            assert_eq!(
                s.workspace.as_ref().unwrap().entries.len(),
                2,
                "stashed temporary tab must still be restored into the tab strip"
            );
        });
    }

    #[test]
    fn finish_discarded_keeps_parallel_provenance_aligned_respects_clear_authority_and_purges_locks()
     {
        let mut s = init();
        let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        let temp_project = Project {
            id: "ws-temp".into(),
            path: "/tmp/cn-temp".into(),
            temporary: true,
        };
        let mut l = Launcher::fixture();
        l.connection = Some(backend.clone());
        l.server_id = Some("srv-test".into());
        l.project = Some(temp_project.clone());
        s.screen = Screen::Launcher(Box::new(l));
        let mut ui = Ui::new();
        ui.fixture_ready();
        let mut temp_ws = crate::workspace::Workspace {
            backend_id: None,
            server_id: None,
            folder: "/tmp/cn-temp".into(),
            project_name: None,
            temporary: true,
            occurrence: 1,
            workspace_id: Some("ws-temp".into()),
            active_session_id: Some("ses-temp".into()),
            drafts: std::collections::BTreeMap::from([("ses-temp".into(), "temp draft".into())]),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        };
        let mut temp_entry = entry("tab-temp".into(), Tab::Workspace(temp_ws.clone()));
        temp_entry.project = Some(temp_project.clone());
        temp_entry.binding = Some(backend.clone());

        // Seed ui.closed with [temp_ws, other_a (unconfirmed "same"), other_b (independent "same")].
        let other_a = crate::workspace::Workspace {
            backend_id: None,
            server_id: None,
            folder: "/repo/other".into(),
            project_name: None,
            temporary: false,
            occurrence: 1,
            workspace_id: Some("ws-other".into()),
            active_session_id: Some("ses-other".into()),
            drafts: std::collections::BTreeMap::from([("ses-other".into(), "same".into())]),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        };
        let mut other_b = other_a.clone();
        other_b.occurrence = 2;

        let derived_a = super::super::drafts::DraftCopy::from_workspace(&other_a, "ses-other")
            .expect("derived copy a");
        let mut derived_b_ws = other_b.clone();
        derived_b_ws
            .drafts
            .insert("ses-other".into(), "origin-b".into());
        let derived_b = super::super::drafts::DraftCopy::from_workspace(&derived_b_ws, "ses-other")
            .expect("derived copy b");
        ui.closed = vec![temp_ws.clone(), other_a.clone(), other_b.clone()];
        ui.closed_restored = vec![
            std::collections::HashSet::from(["ses-temp".into()]),
            std::collections::HashSet::from(["ses-restored-a".into()]),
            std::collections::HashSet::from(["ses-restored-b".into()]),
        ];
        ui.closed_derived_from = vec![
            Default::default(),
            std::collections::BTreeMap::from([("ses-other".into(), derived_a.clone())]),
            std::collections::BTreeMap::from([("ses-other".into(), derived_b.clone())]),
        ];
        ui.closed_unconfirmed_attempts = vec![
            Default::default(),
            std::collections::BTreeMap::from([("ses-other".into(), "att-a".into())]),
            Default::default(),
        ];
        ui.remember_closed_unconfirmed(
            &temp_ws,
            "ses-temp".into(),
            crate::composer::UnconfirmedPrompt::locked("att-temp".into()),
        );
        // Also seed an edited/cleared unconfirmed lock from an earlier session on the same
        // temporary workspace (absent from closed_unconfirmed_attempts and active_session_id).
        ui.remember_closed_unconfirmed(
            &temp_ws,
            "ses-temp-edited".into(),
            crate::composer::UnconfirmedPrompt::locked("att-temp-edited".into()),
        );
        ui.remember_closed_unconfirmed(
            &other_a,
            "ses-other".into(),
            crate::composer::UnconfirmedPrompt::fixture_unedited_text("att-a".into(), "same"),
        );
        ui.entries = vec![entry("tab-0".into(), Tab::Blank), temp_entry];
        ui.active = 1;
        s.workspace = Some(ui);

        let mut rt = Runtime::new(s, crate::view, (800.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| {
            let stashed = stash_for_discard(s, "tab-temp", None, tx).expect("stash temp");
            finish_discarded(s, stashed, false, false, tx);
        });

        let ui = rt.state.workspace.as_ref().unwrap();
        assert_eq!(ui.closed.len(), 2);
        assert_eq!(ui.closed_restored.len(), 2);
        assert_eq!(ui.closed_derived_from.len(), 2);
        assert_eq!(ui.closed_unconfirmed_attempts.len(), 2);
        assert!(ui.closed_restored[0].contains("ses-restored-a"));
        assert!(ui.closed_restored[1].contains("ses-restored-b"));
        assert_eq!(ui.closed_derived_from[0].get("ses-other"), Some(&derived_a));
        assert_eq!(ui.closed_derived_from[1].get("ses-other"), Some(&derived_b));
        assert_eq!(
            ui.closed_unconfirmed_attempts[0]
                .get("ses-other")
                .map(String::as_str),
            Some("att-a"),
            "removing leading temporary archive must shift parallel provenance vectors in lockstep"
        );
        assert!(ui.closed_unconfirmed_attempts[1].is_empty());
        assert!(
            ui.closed_unconfirmed_id(&temp_ws, "ses-temp").is_none(),
            "successful temporary discard must release closed_unconfirmed locks for deleted project"
        );
        assert!(
            ui.closed_unconfirmed_id(&temp_ws, "ses-temp-edited")
                .is_none(),
            "successful temporary discard must release edited/cleared closed_unconfirmed locks for deleted project"
        );
        assert_eq!(
            ui.closed_unconfirmed_id(&other_a, "ses-other"),
            Some("att-a")
        );

        // Confirming att-a must erase only other_a and preserve independent other_b.
        let mut ui = rt.state.workspace.take().unwrap();
        super::super::drafts::confirm_unconfirmed_for(
            &mut rt.state,
            &mut ui,
            &other_a,
            "ses-other",
            "att-a",
        );
        rt.state.workspace = Some(ui);
        let ui = rt.state.workspace.as_ref().unwrap();
        assert!(!ui.closed[0].drafts.contains_key("ses-other"));
        assert_eq!(
            ui.closed[1].drafts.get("ses-other").map(String::as_str),
            Some("same"),
            "independent closed draft must remain untouched after late confirmation"
        );

        // Now verify finish_discarded(..., keep_drafts = true) (e.g. 404 fallback) respects
        // clear_authority: erases the matching restored copy while preserving an independent draft
        // and never writing a blanket empty tombstone.
        temp_ws.drafts.clear();
        temp_ws.drafts.insert("ses-indep".into(), "keep me".into());
        let mut old_restored_ws = temp_ws.clone();
        old_restored_ws.occurrence = 3;
        old_restored_ws.drafts.clear();
        old_restored_ws
            .drafts
            .insert("ses-indep".into(), "older restored text".into());
        let mut stashed_404_ws = temp_ws.clone();
        stashed_404_ws.occurrence = 2;
        stashed_404_ws.drafts.clear();
        let mut stashed_404_entry = entry("tab-temp-404".into(), Tab::Workspace(stashed_404_ws));
        stashed_404_entry.project = Some(temp_project);
        stashed_404_entry.binding = Some(backend);
        stashed_404_entry.cleared.insert("ses-indep".into());
        stashed_404_entry.clear_authority.insert(
            "ses-indep".into(),
            super::super::drafts::ClearAuthority::Copy(
                super::super::drafts::DraftCopy::from_workspace(&old_restored_ws, "ses-indep")
                    .expect("draft copy"),
            ),
        );
        rt.update(|s, tx| {
            let ui = s.workspace.as_mut().unwrap();
            ui.closed.push(temp_ws.clone());
            ui.closed_restored.push(Default::default());
            ui.closed_derived_from.push(Default::default());
            ui.closed_unconfirmed_attempts.push(Default::default());
            ui.closed.push(old_restored_ws.clone());
            ui.closed_restored
                .push(std::collections::HashSet::from(["ses-indep".into()]));
            ui.closed_derived_from.push(Default::default());
            ui.closed_unconfirmed_attempts.push(Default::default());
            ui.entries.push(stashed_404_entry);
            let stashed = stash_for_discard(s, "tab-temp-404", None, tx).expect("stash 404");
            finish_discarded(s, stashed, true, false, tx);
        });
        let ui = rt.state.workspace.as_ref().unwrap();
        assert_eq!(ui.closed.len(), ui.closed_restored.len());
        assert_eq!(ui.closed.len(), ui.closed_derived_from.len());
        assert_eq!(ui.closed.len(), ui.closed_unconfirmed_attempts.len());
        assert!(
            !ui.closed[ui.closed.len() - 2]
                .drafts
                .contains_key("ses-indep"),
            "matching older restored copy must be erased by clear_authority during keep_drafts discard"
        );
        let last = ui.closed.last().unwrap();
        assert!(
            !last.drafts.contains_key("ses-indep"),
            "keep_drafts discard must not write a blanket empty tombstone"
        );
        let scope = super::super::ProjectScope::from_workspace(&temp_ws);
        let peek = super::super::drafts::peek_closed_state_for_scope(ui, &scope, "ses-indep", &[]);
        assert_eq!(
            peek.bundle.and_then(|b| b.text).as_deref(),
            Some("keep me"),
            "independent closed draft must remain visible after keep_drafts discard with non-matching clear_authority"
        );
    }

    #[test]
    fn stashed_temporary_tab_protects_its_local_draft_from_blank_session_cleanup() {
        let mut rt = Runtime::new(
            crate::init(),
            crate::view,
            (800.0, 600.0),
            rune::Env::new(false, 1.0),
        );
        let mut ui = Ui::new();
        ui.fixture_ready();
        let temp_project = crate::catalog::Project {
            id: "ws-temp".into(),
            path: "/tmp/cleanup-guard".into(),
            temporary: true,
        };
        let mut open_ws = super::super::Workspace {
            backend_id: None,
            server_id: None,
            folder: "/tmp/cleanup-guard".into(),
            project_name: None,
            temporary: true,
            occurrence: 1,
            workspace_id: None,
            active_session_id: Some("ses_other".into()),
            drafts: Default::default(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        };
        let mut open_entry =
            super::super::entry("tab-open".into(), Tab::Workspace(open_ws.clone()));
        open_entry.project = Some(temp_project.clone());
        open_entry.sessions = vec![codenomad_client::catalog::Session {
            id: "ses_blank".into(),
            title: "Blank".into(),
        }];
        ui.entries = vec![open_entry];
        ui.active = 0;

        let mut launcher = crate::launcher::Launcher::fixture();
        launcher.project = Some(temp_project.clone());
        launcher.sessions = vec![codenomad_client::catalog::Session {
            id: "ses_blank".into(),
            title: "Blank".into(),
        }];
        rt.state.screen = crate::Screen::Launcher(Box::new(launcher));
        rt.state.workspace = Some(ui);

        assert!(
            !crate::workspace::session_cleanup_protected(&rt.state, "ws-temp", "ses_blank"),
            "without a stashed draft, ses_blank should be eligible for cleanup"
        );

        open_ws
            .drafts
            .insert("ses_blank".into(), "unsent draft on stashed tab".into());
        let stashed_entry = super::super::entry("tab-stashed".into(), Tab::Workspace(open_ws));
        let stashed = StashedTemporary {
            tab_key: "tab-stashed".into(),
            original_index: 0,
            was_active: false,
            created_blank_key: None,
            project: temp_project,
            backend: Backend::unauthenticated("http://127.0.0.1:9/").unwrap(),
            folder: "/tmp/cleanup-guard".into(),
            backend_id: None,
            server_id: None,
            entry: stashed_entry,
            return_focus: None,
        };
        rt.state.temporary.fixture_stash(stashed);

        assert!(
            crate::workspace::session_cleanup_protected(&rt.state, "ws-temp", "ses_blank"),
            "stashed temporary tab holding a local draft must protect its session from blank cleanup"
        );
    }
}
