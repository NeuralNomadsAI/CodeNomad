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
    StatsChanged {
        workspace_id: String,
        urgent: bool,
    },
    SessionCompacted {
        id: String,
    },
    OpenCodeNotice {
        id: String,
        title: Option<String>,
        body: String,
        error: bool,
        duration_ms: Option<u32>,
    },
    SessionRequest {
        form: bool,
        id: String,
    },
    SessionRequestResolved {
        form: bool,
        id: String,
    },
    SessionExecution {
        notice: Option<String>,
    },
    PermissionModeChanged {
        root: Option<String>,
    },
    CommandsChanged,
    MentionsChanged,
    ComposerCataloguesChanged,
    PluginsChanged {
        workspace_id: Option<String>,
        directory: Option<String>,
    },
    McpStatusChanged {
        workspace_id: Option<String>,
    },
    ServicesConfigChanged {
        workspace_id: String,
    },
    NativeStreamStatus {
        workspace_id: String,
        connected: bool,
    },
    MemoryChanged,
    IntegrationsChanged {
        workspace_id: String,
        session_id: Option<String>,
    },
    ProvidersChanged {
        workspace_id: String,
    },
    ProviderUsageRefresh(Option<String>),
    UiPreferencesChanged,
    MissionChanged {
        workspace_id: String,
        mission_id: String,
        revision: u64,
    },
    MissionsReconnected {
        workspace_id: String,
    },
    MissionActivityChanged {
        workspace_id: String,
    },
    PermissionReceiptsChanged {
        message: Option<String>,
    },
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
    TemporaryChanged {
        folders: Vec<String>,
    },
    Stopped {
        workspace_id: String,
        deleted: bool,
        temporary_retained: bool,
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
    Shell {
        attempt: String,
        command: String,
    },
    Older,
    Page(HistoryEdge, Receiver<()>),
    Anchor(crate::timeline::Jump),
    SyncInbox(u64),
    Latest,
    Retry,
    Close,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoryEdge {
    Before,
    After,
    Oldest,
}
#[derive(Debug)]
pub enum PromptOutcome {
    Confirmed(String),
    Rejected,
    Unconfirmed,
}
#[derive(Debug)]
pub struct Authentication {
    pub backend: crate::backend::Backend,
    pub confirmed: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentLane {
    Session,
    Permissions,
    Forms,
}
#[derive(Debug)]
pub enum Event {
    Connected(crate::backend::Backend),
    ProviderUsageWatch(crate::provider_usage::Watch),
    Workspace(WorkspaceEvent),
    Preferences(crate::settings::Owner),
    AgentHint(bool),
    UpstreamReady,
    AgentControl(AgentLane),
    SessionUsage(crate::content::Usage),
    FamilyUsage(crate::content::FamilyChange),
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
    PageOffered {
        page: Page,
        admit: crate::timeline::Admission,
        cancelled: Receiver<()>,
    },
    PageFailed(Receiver<()>),
    Anchor {
        ticket: u64,
        page: Page,
        admit: crate::timeline::Admission,
    },
    AnchorFailed(u64),
    Message(Message),
    Inbox {
        items: Vec<crate::inbox::QueuedPrompt>,
        authoritative: bool,
        fence: Option<crate::inbox::InboxFence>,
    },
    InboxDelta(crate::inbox::InboxDelta),
    InboxFailed,
    PromptAcknowledged {
        attempted: String,
        outcome: PromptOutcome,
    },
    Text(String, crate::content::TextEvent),
    Reasoning(String, crate::content::ReasoningEvent),
    StepUsage(String, crate::content::Usage),
    Tool(String, std::sync::Arc<crate::content::Tool>),
    Done,
    AuthenticationRequired(Authentication),
    Failed,
    ConnectionLost,
    WorkspaceMissing,
    Reconnecting,
    HistoryInvalidated,
    SessionDeleted,
    RevertChanged,
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
