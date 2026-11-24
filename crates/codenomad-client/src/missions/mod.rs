//! Read-only display contracts for Missions on the workspace's owning backend.
mod activity;
mod attention;
mod codec;
mod control_fields;
mod detail;
mod directory;
mod lifecycle;
mod model;
pub use activity::{Activity, ActorState, Coverage};
pub use attention::Attention;
pub use codec::RevisionChanged;
pub use control_fields::{ControlPage, ControlPart, ControlRow, ReceiptContent};
pub use detail::{DetailRead, Header, MapHeader, Task, TaskPage, TaskStatus, TaskWindow};
pub use directory::{DirectoryChanged, DirectoryRead};
pub use lifecycle::{
    ControlReceipt, LifecycleAction, LifecycleOutcome, LifecycleRequest, LifecycleTarget,
};
pub use model::{Cleanup, DirectoryPage, DirectoryRows, RunState, Status, Summary, Window};
