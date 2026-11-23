use super::{Cache, State, Tab, TextEdit, Tx, busy, capture, capture_files_mode, entry};
use crate::platform;

fn stash(s: &mut State, tx: &mut Tx) {
    capture_files_mode(s);
    capture(s);
    crate::chat::suspend(s, tx);
    if let Some(files) = &mut s.files {
        files.activate(false);
    }
    if let Some(git) = &mut s.git.owner {
        git.activate(false);
    }
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
            entry.next = l.next.take();
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
        l.project = item.project.clone();
        l.sessions = std::mem::take(&mut item.sessions);
        l.listed_sessions = std::mem::take(&mut item.listed_sessions);
        l.next = item.next.take();
        l.consumed_cursors = std::mem::take(&mut item.consumed_cursors);
        l.visits = std::mem::take(&mut item.visits);
        l.folder = TextEdit::new(match &item.saved {
            Tab::Workspace(w) => w.folder.as_str(),
            _ => "",
        });
        l.creation_uncertain = std::mem::take(&mut item.creation_uncertain);
        l.error = l.creation_uncertain.then_some("rune.create_error");
        (l.title, l.show_title, l.search, l.show_search) = item
            .sidebar_edits
            .take()
            .unwrap_or_else(|| (TextEdit::new(""), false, TextEdit::new(""), false));
    }
    if let Some(cache) = item.cache.take() {
        cache.apply(s);
        s.renew_scope();
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
    crate::chat::resume(s, tx);
    tx.instant();
}
pub fn select(s: &mut State, id: &str, tx: &mut Tx) {
    let Some(index) = s
        .workspace
        .as_ref()
        .and_then(|ui| ui.entries.iter().position(|e| e.key == id))
    else {
        return;
    };
    if s.workspace.as_ref().is_some_and(|ui| ui.active == index) {
        s.shell.leave_project();
        return;
    }
    if busy(s) {
        return;
    }
    stash(s, tx);
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
    stash(s, tx);
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
pub fn close(s: &mut State, id: &str, tx: &mut Tx) {
    crate::shell::Panels::dismiss_outside(s, tx);
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
    let active = s.workspace.as_ref().is_some_and(|ui| ui.active == index);
    if active {
        stash(s, tx);
    } else {
        capture(s);
    }
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let removed = ui.entries.remove(index);
    if let Tab::Workspace(mut saved) = removed.saved {
        // Undelivered copies still belong to their closed source.
        saved
            .drafts
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
    }
    if let (Some(backend), Some(project)) = (removed.binding, removed.project) {
        platform::spawn(async move {
            let _ = backend.release_project(&project.id).await;
        });
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
    if active {
        activate(s, tx);
    } else {
        tx.instant();
    }
    capture(s);
}
pub(super) fn close_blocked(s: &State, index: usize) -> bool {
    let Some(ui) = &s.workspace else {
        return false;
    };
    if s.documents.has_tab_edits(&ui.entries[index].key) {
        return true;
    }
    if ui.active == index {
        crate::agent::navigation_blocked(s)
    } else {
        ui.entries[index]
            .cache
            .as_ref()
            .is_some_and(Cache::navigation_blocked)
    }
}
