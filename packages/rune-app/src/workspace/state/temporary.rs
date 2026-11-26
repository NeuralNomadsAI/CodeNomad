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

pub(crate) fn has_temporary_tabs(s: &State) -> bool {
    s.workspace.as_ref().is_some_and(|ui| {
        ui.entries
            .iter()
            .any(|item| matches!(&item.saved, Tab::Workspace(w) if w.temporary))
    }) || s
        .screen
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
        // Cancel any async neighbour restore/open triggered when yielding to the neighbour tab,
        // so a late Reply::Opened cannot overwrite the restored temporary tab.
        crate::launcher::cancel_pending_open(s);
        tabs::stash(s);
    }
    let focus_target = restore_focus.then(|| {
        stashed
            .return_focus
            .clone()
            .unwrap_or_else(|| format!("t-{}", stashed.tab_key))
    });
    let Some(ui) = &mut s.workspace else {
        return;
    };
    if let Some(blank_key) = &stashed.created_blank_key
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
    if stashed.was_active {
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
    if let Some(ui) = &mut s.workspace {
        if keep_drafts {
            if let Tab::Workspace(mut saved) = stashed.entry.saved {
                saved.temporary = false;
                saved
                    .drafts
                    .retain(|id, _| !stashed.entry.pending_drafts.contains(id));
                saved
                    .attachment_drafts
                    .retain(|id| !stashed.entry.pending_drafts.contains(id));
                saved
                    .attachment_parts
                    .retain(|id, _| !stashed.entry.pending_drafts.contains(id));
                saved.drafts.extend(
                    stashed
                        .entry
                        .cleared
                        .into_iter()
                        .filter(|id| !stashed.entry.pending_drafts.contains(id))
                        .map(|id| (id, String::new())),
                );
                ui.closed.push(saved);
                if ui.closed.len() > 16 {
                    ui.closed.remove(0);
                }
            }
        } else {
            let folder = &stashed.folder;
            let backend_id = stashed.backend_id.as_deref();
            let server_id = stashed.server_id.as_deref();
            ui.closed.retain(|w| {
                !(same_folder(&w.folder, folder) && matches_backend(w, backend_id, server_id))
            });
        }
        ui.changed();
    }
    if release_on_server {
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
                        cleared_tabs.push(item.key.clone());
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

pub(crate) fn detach_stopped_temporary(
    s: &mut State,
    workspace_id: &str,
    deleted: bool,
    temporary_retained: bool,
    tx: &mut Tx,
) -> bool {
    let keys: Vec<String> = s
        .workspace
        .as_ref()
        .map(|ui| {
            ui.entries
                .iter()
                .filter(|item| {
                    item.project.as_ref().is_some_and(|p| p.id == workspace_id)
                        && matches!(&item.saved, Tab::Workspace(w) if w.temporary)
                })
                .map(|item| item.key.clone())
                .collect()
        })
        .unwrap_or_default();
    if keys.is_empty() {
        return false;
    }
    let keep_drafts = !(deleted && !temporary_retained);
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
        s.screen = Screen::Launcher(Launcher::fixture());
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
}
