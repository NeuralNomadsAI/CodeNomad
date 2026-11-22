use crate::{
    Message, Phase, State, agent,
    transport::{Command, Event},
};
use codenomad_client::{Receiver, Sender};
use rune::edit::TextEdit;
use std::collections::HashSet;

pub(super) struct Cache {
    agent: Option<agent::Ui>,
    files: Option<crate::files::Ui>,
    tools: HashSet<String>,
    attachments: crate::chat::attachments::Reader,
    title: String,
    messages: Vec<Message>,
    draft: TextEdit,
    incoming: Option<Receiver<Event>>,
    commands: Option<Sender<Command>>,
    phase: Phase,
    revision: u64,
    can_older: bool,
    paging: bool,
    error: bool,
    history_detached: bool,
    launcher_visible: bool,
    input_scope: std::rc::Rc<()>,
}
impl Cache {
    pub fn navigation_blocked(&self) -> bool {
        self.agent
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
            tools: std::mem::take(&mut s.expanded_tools),
            attachments: std::mem::take(&mut s.attachments),
            title: std::mem::take(&mut s.chat_title),
            messages: std::mem::take(&mut s.messages),
            draft: std::mem::replace(&mut s.draft, TextEdit::new("")),
            incoming: s.incoming.take(),
            commands: s.commands.take(),
            phase: std::mem::replace(&mut s.phase, Phase::Ready),
            revision: s.revision,
            can_older: std::mem::take(&mut s.can_older),
            paging: std::mem::take(&mut s.paging),
            error: std::mem::take(&mut s.history_error),
            history_detached: std::mem::take(&mut s.history_detached),
            launcher_visible: s.screen.is_launcher(),
            input_scope: s.input_scope.clone(),
        }
    }
    pub fn apply(self, s: &mut State) {
        s.agent = self.agent;
        s.files = self.files;
        s.expanded_tools = self.tools;
        s.attachments = self.attachments;
        s.chat_title = self.title;
        s.messages = self.messages;
        s.draft = self.draft;
        s.incoming = self.incoming;
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
    }
}
pub(super) fn status(
    phase: &Phase,
    agent: Option<&agent::Ui>,
) -> Option<rune_theme_codenomad::tabs::Status> {
    use rune_theme_codenomad::tabs::Status;
    if agent.is_some_and(|a| !a.ids().is_empty()) {
        Some(Status::Permission)
    } else if *phase == Phase::Streaming {
        Some(Status::Working)
    } else if matches!(phase, Phase::Failed | Phase::Reconnecting) {
        Some(Status::Unavailable)
    } else {
        None
    }
}
