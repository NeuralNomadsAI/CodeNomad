//! Read-only display contracts for Missions on the workspace's owning backend.
mod activity;
mod attention;
mod briefing;
mod codec;
mod control_fields;
mod detail;
mod directory;
mod lifecycle;
mod model;
pub use activity::{Activity, Actor, ActorState, Coverage};
pub use attention::Attention;
pub use briefing::{
    BriefingAdmissionOutcome, BriefingSendOutcome, BriefingSendState, BriefingTarget,
    accepts_coordinator_message_value, briefing_request_text,
};
pub use codec::RevisionChanged;
pub use control_fields::{ControlPage, ControlPart, ControlRow, ReceiptContent};
pub use detail::{DetailRead, Header, MapHeader, Task, TaskPage, TaskStatus, TaskWindow};
pub use directory::{DirectoryChanged, DirectoryRead};
pub use lifecycle::{
    ControlReceipt, LifecycleAction, LifecycleOutcome, LifecycleRequest, LifecycleTarget,
    request_id,
};
pub use model::{Cleanup, DirectoryPage, DirectoryRows, RunState, Status, Summary, Window};
