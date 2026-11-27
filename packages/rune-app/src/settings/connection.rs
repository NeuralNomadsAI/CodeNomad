use crate::State;

pub(crate) fn connected(s: &mut State, backend: &crate::backend::Backend) {
    let clients = crate::workspace::conversation_stream_clients(s);
    let mut prefs = s.settings.shared.borrow_mut();
    if s.screen.launcher().is_none() {
        prefs.bind(Some(backend.clone()));
    }
    prefs.observe_conversation_clients(&clients);
}

pub(crate) fn tab_activated(s: &State) {
    let clients = crate::workspace::conversation_stream_clients(s);
    let mut prefs = s.settings.shared.borrow_mut();
    prefs.observe_conversation_clients(&clients);
    prefs.revalidate_transport();
}

pub(crate) fn bound_backend(s: &State) -> Option<crate::backend::Backend> {
    s.settings.shared.borrow().backend.clone()
}

pub(crate) fn stop_before_conversation(s: &State) -> Option<codenomad_client::Receiver<()>> {
    s.settings.shared.borrow_mut().stop_before_conversation()
}

pub(crate) fn conversation_authentication(
    s: &mut State,
    auth: codenomad_client::transport::Authentication,
) -> bool {
    if !authentication_required(s, &auth.backend) {
        return false;
    }
    s.commands = None;
    s.paging = false;
    #[cfg(not(target_arch = "wasm32"))]
    crate::chat::authentication::expired(s, auth);
    true
}

pub(crate) fn authentication_required(s: &mut State, expired: &crate::backend::Backend) -> bool {
    let mut prefs = s.settings.shared.borrow_mut();
    let current = match s.screen.launcher() {
        Some(launcher) => launcher.connection.as_ref(),
        None => prefs.backend.as_ref(),
    };
    if let Some(current) = current {
        if !current.client.same_connection(&expired.client) {
            return false;
        }
        prefs.require_authentication();
        let renewing = s.screen.launcher_mut().is_some_and(|launcher| {
            launcher.authentication_required = true;
            launcher.start_managed_renewal(expired)
        });
        drop(prefs);
        if renewing {
            s.phase = crate::Phase::Reconnecting;
            s.command_palette.dismiss();
            s.tab_rename.dismiss();
            s.temporary.cancel_for_auth();
            s.blank_cleanup.cancel();
            s.workspace_open.cancel();
        } else {
            s.temporary.cancel_for_auth();
            s.blank_cleanup.cancel();
            s.workspace_open.cancel();
            s.show_launcher();
        }
        crate::workspace::suspend_missions(s);
    }
    true
}

pub(crate) fn invalidate(s: &State, owner: codenomad_client::settings::Owner) {
    s.settings.shared.borrow_mut().invalidate_from_sse(owner);
}

pub(super) fn provider_stopped(s: &State, workspace: &str) {
    {
        let mut prefs = s.settings.shared.borrow_mut();
        if prefs
            .provider_target
            .as_ref()
            .is_some_and(|target| target.is_workspace(workspace))
        {
            prefs.provider_target = None;
            if let Some(wake) = &prefs.window_wake {
                wake();
            }
        }
    }
}

pub(super) fn provider_changed(s: &State, workspace: &str) {
    {
        if s.screen
            .launcher()
            .is_some_and(|l| l.catalogue_watch.is_some())
        {
            return;
        }
        let mut prefs = s.settings.shared.borrow_mut();
        if prefs
            .provider_target
            .as_mut()
            .is_some_and(|target| target.hint(workspace))
            && let Some(wake) = &prefs.window_wake
        {
            wake();
        }
    }
}

fn provider_session_moved(s: &State, workspace: &str, session: &str) {
    if s.screen
        .launcher()
        .is_some_and(|l| l.catalogue_watch.is_some())
    {
        return;
    }
    let mut prefs = s.settings.shared.borrow_mut();
    if prefs.provider_target.as_mut().is_some_and(|target| {
        target.session_moved(workspace, session)
            | target.integrations_hint(workspace, Some(session))
    }) && let Some(wake) = &prefs.window_wake
    {
        wake();
    }
}

pub(crate) fn connection_event(
    s: &State,
    event: &crate::transport::Event,
    affects_preferences: bool,
) {
    use codenomad_client::transport::{Event, WorkspaceEvent};
    match event {
        Event::Workspace(WorkspaceEvent::StatsChanged {
            workspace_id,
            urgent,
        }) => {
            if s.screen
                .launcher()
                .is_some_and(|l| l.catalogue_watch.is_some())
            {
                return;
            }
            let mut prefs = s.settings.shared.borrow_mut();
            if let Some(target) = prefs.provider_target.as_mut() {
                target.stats_hint(workspace_id, *urgent);
                if let Some(wake) = &prefs.window_wake {
                    wake();
                }
            }
        }
        Event::Workspace(WorkspaceEvent::MemoryChanged) => {
            s.settings.shared.borrow_mut().memory.invalidate();
        }
        Event::Workspace(WorkspaceEvent::ProvidersChanged { workspace_id }) => {
            provider_changed(s, workspace_id)
        }
        Event::Workspace(WorkspaceEvent::IntegrationsChanged {
            workspace_id,
            session_id,
        }) => {
            if s.screen
                .launcher()
                .is_some_and(|l| l.catalogue_watch.is_some())
            {
                return;
            }
            let mut prefs = s.settings.shared.borrow_mut();
            if prefs
                .provider_target
                .as_mut()
                .is_some_and(|target| target.integrations_hint(workspace_id, session_id.as_deref()))
                && let Some(wake) = &prefs.window_wake
            {
                wake();
            }
        }
        Event::Workspace(WorkspaceEvent::SessionMoved {
            workspace_id,
            session_id,
        }) => provider_session_moved(s, workspace_id, session_id),
        Event::Workspace(WorkspaceEvent::Stopped { workspace_id, .. }) => {
            provider_stopped(s, workspace_id)
        }
        Event::AgentHint(true) => {
            if affects_preferences {
                s.settings.shared.borrow_mut().memory.transport(true);
                provider_transport(s, true);
            }
        }
        Event::Reconnecting if affects_preferences => {
            provider_transport(s, false);
        }
        Event::ConnectionLost => {
            if affects_preferences {
                s.settings.transcript_filters.close_preset_menu();
                let other_healthy =
                    crate::workspace::conversation_stream_clients(s)
                        .iter()
                        .any(|(id, healthy)| {
                            *healthy && s.conversation_client_id.as_deref() != Some(id.as_str())
                        });
                let mut prefs = s.settings.shared.borrow_mut();
                let other_healthy = other_healthy || prefs.has_healthy_watch_stream();
                let repeated_outage = s
                    .conversation_client_id
                    .as_deref()
                    .is_some_and(|id| prefs.is_repeated_outage(id));
                if let Some(id) = s.conversation_client_id.as_deref() {
                    prefs.note_client_outage(id);
                }
                if !repeated_outage && !prefs.is_transport_lost() {
                    prefs.mark_transport_lost();
                }
                if other_healthy && prefs.is_transport_lost() {
                    prefs.revalidate_transport();
                }
                prefs.memory.transport(false);
                drop(prefs);
                provider_transport(s, false);
            }
        }
        _ => {}
    }
}

fn provider_transport(s: &State, online: bool) {
    if s.screen.launcher().is_some() {
        return;
    }
    let mut prefs = s.settings.shared.borrow_mut();
    if let Some(target) = &mut prefs.provider_target {
        target.transport(online);
        if let Some(wake) = &prefs.window_wake {
            wake();
        }
    }
}
