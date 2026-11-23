//! Read-only display contracts for Missions on the workspace's owning backend.
mod detail;
mod directory;
mod model;
pub use detail::{DetailRead, Header, MapHeader, Task, TaskPage, TaskStatus, TaskWindow};
pub use directory::{DirectoryChanged, DirectoryRead};
pub use model::{Cleanup, DirectoryPage, DirectoryRows, RunState, Status, Summary, Window};
