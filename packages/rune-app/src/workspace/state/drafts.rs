use super::{Backend, State, Tab, Tx, Ui, same_project};

pub fn capture(s: &mut State) {
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let Some(item) = ui.entries.get_mut(ui.active) else {
        return;
    };
    let mut changed = false;
    if let Tab::Workspace(saved) = &mut item.saved {
        let key = saved
            .active_session_id
            .as_deref()
            .unwrap_or("__no_session_draft__");
        let owns_draft = item.binding.as_ref().is_some_and(|b| {
            b.session == key || b.session.is_empty() && key == "__no_session_draft__"
        });
        if owns_draft {
            if s.draft.text.is_empty() {
                if saved.drafts.remove(key).is_some() {
                    item.cleared.insert(key.into());
                    changed = true;
                }
            } else if saved.drafts.get(key) != Some(&s.draft.text) {
                saved.drafts.insert(key.into(), s.draft.text.clone());
                item.cleared.remove(key);
                changed = true;
            }
        }
    }
    if changed {
        ui.changed();
    }
    ui.stage();
}
pub fn draft_changed(s: &mut State, _: &mut Tx) {
    capture(s);
}

pub fn bound(s: &mut State, backend: &Backend) -> String {
    capture(s);
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
    let draft = saved
        .drafts
        .get(&backend.session)
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
        .find_map(|w| w.drafts.get(id))
        .cloned();
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
        item.cleared.remove(id);
        if index == ui.active {
            match &current {
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
    }
}
