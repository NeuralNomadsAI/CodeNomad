use crate::{
    Phase, State, agent,
    transport::{Command, Event},
};
use codenomad_client::{Receiver, Sender};
use rune::edit::TextEdit;

pub(super) struct Cache {
    agent: Option<agent::Ui>,
    files: Option<crate::files::Ui>,
    attachments: crate::chat::attachments::Reader,
    git: crate::git::Binding,
    transcript_display: crate::transcript_state::Display,
    title: String,
    messages: Vec<crate::history::Row>,
    draft: TextEdit,
    composer: crate::composer::Owner,
    incoming: Option<Receiver<Event>>,
    conversation_client_id: Option<String>,
    conversation_stream_connected: bool,
    reader: Option<crate::chat::reader::Reader>,
    commands: Option<Sender<Command>>,
    phase: Phase,
    revision: u64,
    can_older: bool,
    paging: bool,
    error: bool,
    history_detached: bool,
    launcher_visible: bool,
    input_scope: std::rc::Rc<()>,
    status_permissions: crate::shell::status_permissions::Permissions,
    status_services: crate::shell::status_services::Services,
    status_usage: crate::shell::status_usage::Panel,
}
impl Cache {
    pub(super) fn observes_notifications(&self, allow_running: bool) -> bool {
        self.agent
            .as_ref()
            .is_some_and(|agent| agent.online && (allow_running || !agent.running))
    }

    pub(super) fn has_conversation_stream(&self) -> bool {
        self.incoming
            .as_ref()
            .is_some_and(|incoming| !incoming.is_closed())
    }

    pub(super) fn has_healthy_conversation_stream(&self) -> bool {
        self.has_conversation_stream() && self.conversation_stream_connected
    }

    pub(super) fn conversation_client_id(&self) -> Option<&str> {
        self.conversation_client_id.as_deref()
    }

    fn is_detached(&self) -> bool {
        self.launcher_visible && self.incoming.is_none()
    }

    pub(super) fn deliver_detached_event(
        &mut self,
        event: &codenomad_client::transport::WorkspaceEvent,
    ) -> bool {
        if !self.is_detached()
            && !matches!(
                event,
                codenomad_client::transport::WorkspaceEvent::Stopped { .. }
            )
        {
            return false;
        }
        if matches!(
            event,
            codenomad_client::transport::WorkspaceEvent::UiPreferencesChanged
        ) {
            if let Some(git) = &mut self.git.owner {
                git.event(event);
                return true;
            }
            return false;
        }
        let Some(target) = super::state::event_workspace_id(event) else {
            return false;
        };
        let mut delivered = false;
        if let Some(git) = &mut self.git.owner
            && git.workspace_id() == target
        {
            git.event(event);
            delivered = true;
        }
        if let Some(files) = &mut self.files
            && files.workspace_id() == target
        {
            files.event(event.clone());
            delivered = true;
        }
        delivered
    }

    pub(super) fn has_detached_panels(&self) -> bool {
        self.is_detached() && (self.git.owner.is_some() || self.files.is_some())
    }

    pub(super) fn collect_detached_workspace_ids(
        &self,
        out: &mut std::collections::HashSet<String>,
    ) {
        if !self.is_detached() {
            return;
        }
        if let Some(git) = &self.git.owner {
            out.insert(git.workspace_id().to_owned());
        }
        if let Some(files) = &self.files {
            out.insert(files.workspace_id().to_owned());
        }
    }

    pub(super) fn stop_unlisted_detached(
        &mut self,
        live: &std::collections::HashSet<&str>,
    ) -> bool {
        if !self.is_detached() {
            return false;
        }
        let mut changed = false;
        if let Some(git) = &mut self.git.owner {
            let id = git.workspace_id();
            if !live.contains(id) {
                let workspace_id = id.to_owned();
                git.event(&codenomad_client::transport::WorkspaceEvent::Stopped { workspace_id });
                changed = true;
            }
        }
        if let Some(files) = &mut self.files {
            let id = files.workspace_id();
            if !live.contains(id) {
                let workspace_id = id.to_owned();
                files.event(codenomad_client::transport::WorkspaceEvent::Stopped { workspace_id });
                changed = true;
            }
        }
        changed
    }

    pub(super) fn reconcile_detached_online(
        &mut self,
        opened_after: &std::collections::HashSet<String>,
        live: Option<&std::collections::HashSet<&str>>,
    ) -> bool {
        if !self.is_detached() {
            return false;
        }
        let mut changed = false;
        if let Some(git) = &mut self.git.owner {
            let id = git.workspace_id();
            match live {
                Some(live) if !opened_after.contains(id) && !live.contains(id) => {
                    let workspace_id = id.to_owned();
                    git.event(&codenomad_client::transport::WorkspaceEvent::Stopped {
                        workspace_id,
                    });
                    changed = true;
                }
                Some(_) => {
                    git.online(true);
                    changed = true;
                }
                None if opened_after.contains(id) => {
                    git.online(true);
                    changed = true;
                }
                None => {}
            }
        }
        if let Some(files) = &mut self.files {
            let id = files.workspace_id();
            match live {
                Some(live) if !opened_after.contains(id) && !live.contains(id) => {
                    let workspace_id = id.to_owned();
                    files.event(codenomad_client::transport::WorkspaceEvent::Stopped {
                        workspace_id,
                    });
                    changed = true;
                }
                Some(_) => {
                    files.online(true);
                    changed = true;
                }
                None if opened_after.contains(id) => {
                    files.online(true);
                    changed = true;
                }
                None => {}
            }
        }
        changed
    }

    pub(super) fn set_detached_online(&mut self, online: bool) -> bool {
        if !self.is_detached() {
            return false;
        }
        let mut changed = false;
        if let Some(git) = &mut self.git.owner {
            git.online(online);
            changed = true;
        }
        if let Some(files) = &mut self.files {
            files.online(online);
            changed = true;
        }
        changed
    }

    pub(super) fn history_weight(&self) -> (usize, usize) {
        (
            self.messages.len(),
            crate::history::retained_bytes(&self.messages),
        )
    }
    pub(super) fn history_protected(&self) -> bool {
        self.phase == Phase::Streaming
            || self.agent.as_ref().is_some_and(|agent| agent.running)
            || self
                .reader
                .as_ref()
                .and_then(crate::chat::reader::Reader::running)
                == Some(true)
            || self.navigation_blocked()
    }
    pub(super) fn evict_history(&mut self) {
        self.messages = Vec::new();
        self.can_older = false;
        self.paging = false;
        self.transcript_display.evict_rendered();
    }
    pub fn navigation_blocked(&self) -> bool {
        self.composer.blocks_navigation()
            || self
                .agent
                .as_ref()
                .is_some_and(agent::Ui::navigation_blocked)
    }
    pub fn status(&self) -> Option<rune_theme_codenomad::tabs::Status> {
        status(&self.phase, self.agent.as_ref())
    }
    pub fn take(s: &mut State) -> Self {
        Self {
            agent: s.agent.take(),
            files: s.files.take(),
            attachments: std::mem::take(&mut s.attachments),
            git: crate::git::Binding::take(&mut s.git),
            transcript_display: std::mem::take(&mut s.transcript_display),
            title: std::mem::take(&mut s.chat_title),
            messages: std::mem::take(&mut s.messages),
            draft: std::mem::replace(&mut s.draft, TextEdit::new("")),
            composer: std::mem::take(&mut s.composer),
            incoming: s.incoming.take(),
            conversation_client_id: s.conversation_client_id.take(),
            conversation_stream_connected: std::mem::take(&mut s.conversation_stream_connected),
            reader: s.reader.take(),
            commands: s.commands.take(),
            phase: std::mem::replace(&mut s.phase, Phase::Ready),
            revision: s.revision,
            can_older: std::mem::take(&mut s.can_older),
            paging: std::mem::take(&mut s.paging),
            error: std::mem::take(&mut s.history_error),
            history_detached: std::mem::take(&mut s.history_detached),
            launcher_visible: s.screen.is_launcher(),
            input_scope: s.input_scope.clone(),
            status_permissions: std::mem::take(&mut s.status_permissions),
            status_services: std::mem::take(&mut s.status_services),
            status_usage: std::mem::take(&mut s.status_usage),
        }
    }
    pub fn apply(self, s: &mut State) {
        s.agent = self.agent;
        s.files = self.files;
        s.attachments = self.attachments;
        s.git = self.git;
        s.transcript_display = self.transcript_display;
        crate::chat::ToolDiffPreferences::sync(s);
        s.chat_title = self.title;
        s.messages = self.messages;
        s.draft = self.draft;
        s.composer = self.composer;
        s.incoming = self.incoming;
        s.conversation_client_id = self.conversation_client_id;
        s.conversation_stream_connected = self.conversation_stream_connected;
        s.reader = self.reader;
        s.commands = self.commands;
        s.phase = self.phase;
        s.revision = self.revision;
        s.can_older = self.can_older;
        s.paging = self.paging;
        s.history_error = self.error;
        s.history_detached = self.history_detached;
        if self.launcher_visible {
            s.screen.show_launcher();
        } else {
            s.screen.show_chat();
        }
        s.input_scope = self.input_scope;
        s.status_permissions = self.status_permissions;
        s.status_services = self.status_services;
        s.status_usage = self.status_usage;
    }
}
pub(super) fn status(
    phase: &Phase,
    agent: Option<&agent::Ui>,
) -> Option<rune_theme_codenomad::tabs::Status> {
    use rune_theme_codenomad::tabs::Status;
    if agent.is_some_and(|a| !a.ids().is_empty()) {
        Some(Status::Permission)
    } else if *phase == Phase::Streaming || agent.is_some_and(|a| a.online && a.running) {
        Some(Status::Working)
    } else if matches!(phase, Phase::Failed | Phase::Reconnecting) {
        Some(Status::Unavailable)
    } else {
        None
    }
}
