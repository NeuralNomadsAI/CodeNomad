//! Typed commands and authoritative display events, independent of a UI runtime.
use crate::{Message, Wake, history::Page};
use crate::{Receiver, Sender};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectoryChange {
    pub directory: String,
    pub path: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkspaceEvent {
    UiPreferencesChanged,
    NativeFilesystemChanged {
        workspace_id: String,
    },
    FilesChanged {
        workspace_id: String,
        changes: Vec<DirectoryChange>,
    },
    WorktreesChanged {
        workspace_id: String,
    },
    SessionMoved {
        workspace_id: String,
        session_id: String,
    },
    Stopped {
        workspace_id: String,
    },
}
#[derive(Debug)]
pub enum Command {
    Send(String),
    Older,
    Retry,
    Close,
}
#[derive(Debug)]
pub struct Authentication {
    pub backend: crate::backend::Backend,
    pub confirmed: bool,
}

#[derive(Debug)]
pub enum Event {
    Connected(crate::backend::Backend),
    Workspace(WorkspaceEvent),
    Preferences(crate::settings::Owner),
    AgentHint(bool),
    History(Vec<Message>),
    Sync(Page),
    Older(Page),
    Message(Message),
    Text(String, crate::content::TextEvent),
    Done,
    AuthenticationRequired(Authentication),
    PromptSettled { rejected: bool },
    Failed,
    ConnectionLost,
    WorkspaceMissing,
    Reconnecting,
    PagingFailed,
}

impl Event {
    pub fn authentication_required(backend: crate::backend::Backend) -> Self {
        Self::AuthenticationRequired(Authentication {
            backend,
            confirmed: false,
        })
    }
}

pub async fn publish(out: &Sender<Event>, wake: &Wake, event: Event) -> bool {
    if out.send(event).await.is_err() {
        return false;
    }
    wake();
    true
}
/// Bind a scoped connection and run its existing recovery/pagination loop.
pub async fn run_backend(
    backend: crate::backend::Backend,
    out: Sender<Event>,
    input: Receiver<Command>,
    wake: Wake,
) -> crate::history::Result<()> {
    if !publish(&out, &wake, Event::Connected(backend.clone())).await {
        return Ok(());
    }
    crate::recovery::run(backend, out, input, wake).await
}
