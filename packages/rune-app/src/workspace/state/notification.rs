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
    let server = backend.client.server_identity().map(str::to_owned);
    Some((
        Target {
            tab: None,
            backend_url: backend.base,
            server,
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
    let backend = entry.binding.as_ref()?;
    let target = Target {
        tab: Some(entry.key.clone()),
        backend_url: backend.base.clone(),
        server: backend
            .client
            .server_identity()
            .map(str::to_owned)
            .or_else(|| saved.server_id.clone()),
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
        && entry.binding.as_ref().is_some_and(|backend| {
            backend.base == target.backend_url
                && backend.client.server_identity().or(saved.server_id.as_deref()) == target.server.as_deref()
        })
        && (saved.active_session_id.as_ref() == Some(&target.session)
            || entry.sessions.iter().any(|row| row.id == target.session)
            || (s.workspace.as_ref().is_some_and(|ui| ui.active_key() == tab)
                && s.screen.launcher().is_some_and(|l| l.sessions.iter().any(|r| r.id == target.session)))))
}

pub(crate) enum Activation {
    Opened,
    Wait,
    Gone,
}

pub(crate) fn open_notification(
    s: &mut State,
    target: &Target,
    started: &mut bool,
    tx: &mut Tx,
) -> Activation {
    if !owns_notification(s, target) {
        return Activation::Gone;
    }
    if let Some(tab) = &target.tab {
        super::select(s, tab, tx);
        if !s
            .workspace
            .as_ref()
            .is_some_and(|ui| ui.active_key() == tab)
        {
            return Activation::Wait;
        }
    }
    if target.tab.is_some() && super::active_session(s) != Some(&target.session) {
        let Some(launcher) = s.screen.launcher() else {
            return Activation::Gone;
        };
        if launcher.pending || !crate::launcher::can_change_session(s) {
            return Activation::Wait;
        }
        if launcher.connection.is_none() || launcher.project.is_none() {
            return Activation::Wait;
        }
        if *started && launcher.error.is_some() {
            return Activation::Gone;
        }
        crate::launcher::choose(s, target.session.clone(), tx);
        *started = true;
        return Activation::Wait;
    }
    if s.files
        .as_ref()
        .is_some_and(|files| files.document.confirmation().is_some())
    {
        return Activation::Wait;
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
    Activation::Opened
}
