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
    reader: Option<crate::chat::reader::Reader>,
    commands: Option<Sender<Command>>,
    phase: Phase,
    revision: u64,
    can_older: bool,
    paging: bool,
    error: bool,
    history_detached: bool,
    stream_offline: bool,
    launcher_visible: bool,
    input_scope: std::rc::Rc<()>,
    status_permissions: crate::shell::status_permissions::Permissions,
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

    pub(super) fn unconfirmed_id(&self) -> Option<&str> {
        self.composer.unconfirmed_id()
    }

    #[cfg(target_arch = "wasm32")]
    pub(super) fn revoke_pairing(&mut self) {
        self.composer.picker.set_attachments_supported(false);
        if let Some(reader) = &self.reader {
            reader.revoke();
        }
        if let Some(commands) = self.commands.take() {
            commands.close();
        }
        self.phase = Phase::Failed;
        self.stream_offline = true;
    }

    pub(super) fn history_weight(&self) -> (usize, usize) {
        (
            self.messages.len(),
            crate::history::retained_bytes(&self.messages),
        )
    }
    pub(super) fn history_protected(&self) -> bool {
        self.phase.running()
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
        self.composer.pending()
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
            reader: s.reader.take(),
            commands: s.commands.take(),
            phase: std::mem::replace(&mut s.phase, Phase::Ready),
            revision: s.revision,
            can_older: std::mem::take(&mut s.can_older),
            paging: std::mem::take(&mut s.paging),
            error: std::mem::take(&mut s.history_error),
            history_detached: std::mem::take(&mut s.history_detached),
            stream_offline: std::mem::take(&mut s.stream_offline),
            launcher_visible: s.screen.is_launcher(),
            input_scope: s.input_scope.clone(),
            status_permissions: std::mem::take(&mut s.status_permissions),
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
        s.reader = self.reader;
        s.commands = self.commands;
        s.phase = self.phase;
        s.revision = self.revision;
        s.can_older = self.can_older;
        s.paging = self.paging;
        s.history_error = self.error;
        s.history_detached = self.history_detached;
        s.stream_offline = self.stream_offline;
        if self.launcher_visible {
            s.screen.show_launcher();
        } else {
            s.screen.show_chat();
        }
        s.input_scope = self.input_scope;
        s.status_permissions = self.status_permissions;
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
    } else if *phase == Phase::Failed || phase.reconnecting() {
        Some(Status::Unavailable)
    } else {
        None
    }
}
