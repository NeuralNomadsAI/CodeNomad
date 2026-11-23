use super::{Entry, State, Tab};
use crate::shell::notifications::Target;
use rune::Tx;

pub(crate) fn notification_target(s: &State) -> Option<(Target, String)> {
    if let Some(ui) = &s.workspace {
        return entry_target(&ui.entries[ui.active], s);
    }
    if s.screen.is_launcher() {
        return None;
    }
    let backend = crate::settings::bound_backend(s)?;
    Some((
        Target {
            tab: None,
            origin: backend.base,
            server: None,
            occurrence: 0,
            workspace: backend.workspace,
            session: backend.session,
        },
        crate::strings::t("window.title.main").into(),
    ))
}

pub(super) fn entry_target(entry: &Entry, s: &State) -> Option<(Target, String)> {
    if s.screen.is_launcher() {
        return None;
    }
    let Tab::Workspace(saved) = &entry.saved else {
        return None;
    };
    let target = Target {
        tab: Some(entry.key.clone()),
        origin: entry.binding.as_ref()?.base.clone(),
        server: saved.server_id.clone(),
        occurrence: saved.occurrence,
        workspace: saved.workspace_id.clone()?,
        session: saved.active_session_id.clone()?,
    };
    let title = saved
        .folder
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(&saved.folder)
        .to_owned();
    Some((target, title))
}

pub(crate) fn owns_notification(s: &State, target: &Target) -> bool {
    let Some(tab) = &target.tab else {
        return notification_target(s).is_some_and(|(current, _)| current == *target);
    };
    let Some(entry) = s
        .workspace
        .as_ref()
        .and_then(|ui| ui.entries.iter().find(|e| &e.key == tab))
    else {
        return false;
    };
    matches!(&entry.saved, Tab::Workspace(saved)
        if saved.workspace_id.as_ref() == Some(&target.workspace)
        && saved.occurrence == target.occurrence
        && saved.server_id == target.server
        && entry.binding.as_ref().is_some_and(|backend| backend.base == target.origin)
        && (saved.active_session_id.as_ref() == Some(&target.session)
            || entry.sessions.iter().any(|row| row.id == target.session)
            || (s.workspace.as_ref().is_some_and(|ui| ui.active_key() == tab)
                && s.screen.launcher().is_some_and(|l| l.sessions.iter().any(|r| r.id == target.session)))))
}

pub(crate) fn open_notification(s: &mut State, target: &Target, tx: &mut Tx) -> bool {
    if !owns_notification(s, target) {
        return false;
    }
    if let Some(tab) = &target.tab {
        super::select(s, tab, tx);
        if !s
            .workspace
            .as_ref()
            .is_some_and(|ui| ui.active_key() == tab)
        {
            return false;
        }
    }
    if s.files
        .as_ref()
        .is_some_and(|files| files.document.confirmation().is_some())
    {
        return true;
    }
    crate::git::close_preview(s);
    if let Some(files) = &mut s.files {
        files.close_reader();
    }
    crate::chat::reading::restore_position(s, tx);
    if target.tab.is_some() {
        crate::launcher::choose(s, target.session.clone(), tx);
    }
    tx.instant();
    true
}
