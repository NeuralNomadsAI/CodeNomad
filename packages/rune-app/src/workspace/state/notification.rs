use super::{Backend, Entry, State, Tab};
use crate::shell::notifications::Target;
use codenomad_client::{Receiver, bounded};
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
    && entry.binding.as_ref().or_else(|| s.screen.launcher()?.connection.as_ref()).is_some_and(|backend| {
        backend.base == target.backend_url
            && backend.client.server_identity().or(saved.server_id.as_deref()) == target.server.as_deref()
    }))
}

fn backend(s: &State, target: &Target) -> Option<Backend> {
    if !owns_notification(s, target) {
        return None;
    }
    let backend = match &target.tab {
        Some(tab) => s
            .workspace
            .as_ref()?
            .entries
            .iter()
            .find(|entry| &entry.key == tab)?
            .binding
            .as_ref()
            .or_else(|| s.screen.launcher()?.connection.as_ref())?
            .clone(),
        None => crate::settings::bound_backend(s)?,
    };
    Some(Backend {
        workspace: target.workspace.clone(),
        session: target.session.clone(),
        ..backend
    })
}

pub(crate) fn workspace_notification(
    s: &State,
    workspace: &str,
    session: &str,
) -> Option<(Target, String, Backend)> {
    let ui = s.workspace.as_ref()?;
    let (entry, saved) = ui.entries.iter().find_map(|entry| match &entry.saved {
        Tab::Workspace(saved) if saved.workspace_id.as_deref() == Some(workspace) => {
            Some((entry, saved))
        }
        _ => None,
    })?;
    let source = entry
        .binding
        .as_ref()
        .or_else(|| s.screen.launcher()?.connection.as_ref())?;
    let target = Target {
        tab: Some(entry.key.clone()),
        backend_url: source.base.clone(),
        server: source
            .client
            .server_identity()
            .map(str::to_owned)
            .or_else(|| saved.server_id.clone()),
        occurrence: saved.occurrence,
        workspace: workspace.into(),
        session: session.into(),
    };
    let backend = backend(s, &target)?;
    let title = saved
        .folder
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(&saved.folder)
        .into();
    Some((target, title, backend))
}

pub(crate) fn check_notification(s: &State, target: &Target) -> Option<Receiver<bool>> {
    let backend = backend(s, target)?;
    let expected = target.server.clone();
    let folder = target.tab.as_ref().and_then(|tab| {
        s.workspace
            .as_ref()?
            .entries
            .iter()
            .find_map(|entry| match &entry.saved {
                Tab::Workspace(saved) if &entry.key == tab => Some(saved.folder.clone()),
                _ => None,
            })
    });
    let (answer, receiver) = bounded(1);
    let wake = s.wake.clone();
    crate::platform::spawn(async move {
        let check = async {
            if let Some(server) = expected
                && backend.server_id().await? != server
            {
                return Ok(false);
            }
            let Some(project) = backend.projects().await?.into_iter().find(|project| {
                project.id == backend.workspace
                    && folder.as_ref().is_none_or(|folder| {
                        codenomad_client::same_server_path(folder, &project.path)
                    })
            }) else {
                return Ok(false);
            };
            Ok(backend.session.is_empty()
                || backend
                    .bind_session(&project, &backend.session, false)
                    .await
                    .is_ok())
        };
        let ok = codenomad_client::runtime::until_closed(&answer, check)
            .await
            .is_some_and(|result: crate::history::Result<bool>| result.unwrap_or(false));
        let _ = answer.try_send(ok);
        wake();
    });
    Some(receiver)
}

pub(crate) fn observes_notification(s: &State, target: &Target, allow_running: bool) -> bool {
    if !owns_notification(s, target) {
        return false;
    }
    let observes = || {
        s.agent
            .as_ref()
            .is_some_and(|agent| agent.online && (allow_running || !agent.running))
    };
    let Some(tab) = &target.tab else {
        return observes();
    };
    let Some(ui) = &s.workspace else { return false };
    let Some(entry) = ui.entries.iter().find(|entry| &entry.key == tab) else {
        return false;
    };
    if !matches!(&entry.saved, Tab::Workspace(saved)
        if saved.active_session_id.as_ref() == Some(&target.session))
    {
        return false;
    }
    if ui.active_key() == tab {
        return !s.screen.is_launcher() && observes();
    }
    entry
        .cache
        .as_ref()
        .is_some_and(|cache| cache.observes_notifications(allow_running))
}

pub(crate) enum Activation {
    Opened,
    Wait,
    Gone,
}

pub(crate) fn can_switch_for_notification(s: &State, target: &Target) -> bool {
    target.tab.as_deref().is_none_or(|tab| {
        s.workspace
            .as_ref()
            .is_some_and(|ui| ui.active_key() == tab)
            || !super::busy(s)
    })
}

pub(crate) fn open_session_tab_target(
    s: &State,
    current: &Backend,
    session: &str,
) -> Option<(String, Backend)> {
    let ui = s.workspace.as_ref()?;
    let current_server = current.client.server_identity();
    for (index, entry) in ui.entries.iter().enumerate() {
        if index == ui.active {
            continue;
        }
        let Tab::Workspace(saved) = &entry.saved else {
            continue;
        };
        let Some(workspace_id) = saved.workspace_id.as_deref() else {
            continue;
        };
        let known = saved.active_session_id.as_deref() == Some(session)
            || entry.listed_sessions.contains(session)
            || entry.sessions.iter().any(|row| row.id == session);
        if !known {
            continue;
        }
        let source = entry
            .binding
            .as_ref()
            .or_else(|| s.screen.launcher()?.connection.as_ref())?;
        if source.base != current.base {
            continue;
        }
        let entry_server = source
            .client
            .server_identity()
            .or(saved.server_id.as_deref());
        if current_server.is_some() && entry_server.is_some() && current_server != entry_server {
            continue;
        }
        return Some((
            entry.key.clone(),
            Backend {
                workspace: workspace_id.into(),
                session: session.into(),
                ..source.clone()
            },
        ));
    }
    None
}

pub(crate) fn switch_tab_for_child(
    s: &mut State,
    tab: &str,
    child_id: String,
    ticket: u64,
    tx: &mut Tx,
) -> bool {
    super::tabs::select_destination(s, tab, tx);
    if !s
        .workspace
        .as_ref()
        .is_some_and(|ui| ui.active_key() == tab)
    {
        return false;
    }
    if s.screen.is_launcher() || super::active_session(s) != Some(child_id.as_str()) {
        crate::launcher::choose_child_ticket(s, child_id, Some(ticket), tx);
    }
    true
}

pub(crate) fn open_notification(
    s: &mut State,
    target: &Target,
    ticket: u64,
    started: &mut bool,
    tx: &mut Tx,
) -> Activation {
    if !owns_notification(s, target) {
        return Activation::Gone;
    }
    if let Some(tab) = &target.tab {
        super::tabs::select_destination(s, tab, tx);
        if !s
            .workspace
            .as_ref()
            .is_some_and(|ui| ui.active_key() == tab)
        {
            return Activation::Wait;
        }
    }
    if target.session.is_empty() {
        return Activation::Opened;
    }
    if target.tab.is_some()
        && (s.screen.is_launcher() || super::active_session(s) != Some(&target.session))
    {
        let Some(launcher) = s.screen.launcher() else {
            return Activation::Gone;
        };
        if launcher.pending || !crate::launcher::can_change_session(s) {
            return Activation::Wait;
        }
        if launcher.connection.is_none() || launcher.project.is_none() {
            return Activation::Wait;
        }
        if launcher.error.is_some() && (*started || s.screen.is_launcher()) {
            return Activation::Gone;
        }
        crate::launcher::choose_destination(s, target.session.clone(), Some(ticket), tx);
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
        crate::launcher::choose_destination(s, target.session.clone(), Some(ticket), tx);
    }
    tx.instant();
    Activation::Opened
}
