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
    CommandsChanged,
    MentionsChanged,
    ComposerCataloguesChanged,
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
    Prompt(crate::prompt::Prompt),
    Slash {
        attempt: String,
        name: String,
        text: String,
    },
    Older,
    Anchor(crate::timeline::Jump),
    Latest,
    Retry,
    Close,
}
#[derive(Debug)]
pub enum PromptOutcome {
    Confirmed(String),
    Rejected,
    Unconfirmed,
}
#[derive(Debug)]
pub enum Event {
    Connected(crate::backend::Backend),
    Workspace(WorkspaceEvent),
    Preferences(crate::settings::Owner),
    AgentHint(bool),
    ObservedRunning {
        running: bool,
        version: u64,
    },
    History(Vec<crate::history::Row>),
    Sync(Page),
    ReaderSync {
        page: Page,
        version: u64,
    },
    Older(Page),
    Anchor {
        ticket: u64,
        page: Page,
        admit: crate::timeline::Admission,
    },
    AnchorFailed(u64),
    Message(Message),
    PromptAcknowledged {
        attempted: String,
        outcome: PromptOutcome,
    },
    Text(String, crate::content::TextEvent),
    Tool(String, std::sync::Arc<crate::content::Tool>),
    Done,
    AuthenticationRequired(crate::backend::Backend),
    Failed,
    ConnectionLost,
    WorkspaceMissing,
    Reconnecting,
    HistoryInvalidated,
    PagingFailed,
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

pub async fn run_backend_reading(
    backend: crate::backend::Backend,
    out: Sender<Event>,
    input: Receiver<Command>,
    wake: Wake,
    reading: crate::recovery::ReadingLane,
) -> crate::history::Result<()> {
    if !publish(&out, &wake, Event::Connected(backend.clone())).await {
        return Ok(());
    }
    crate::recovery::run_with_reading(backend, out, input, wake, Some(reading)).await
}
