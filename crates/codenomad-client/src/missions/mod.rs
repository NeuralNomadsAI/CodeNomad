//! Display, lifecycle, and programmed-mission contracts for Missions on the workspace's owning backend.
mod activity;
mod attention;
mod briefing;
mod calendars;
mod codec;
mod content;
mod control_fields;
mod detail;
mod directory;
mod launch;
mod lifecycle;
mod model;
pub use activity::{Activity, Actor, ActorState, Coverage};
pub use attention::Attention;
pub use briefing::{
    BriefingAdmissionOutcome, BriefingSendOutcome, BriefingSendState, BriefingTarget,
    accepts_coordinator_message_value, briefing_request_text,
};
pub use calendars::{
    CalendarAction, CalendarConfiguration, CalendarLast, CalendarLastOutcome, CalendarLaunch,
    CalendarLaunchHistoryEntry, CalendarMission, CalendarOutcome, CalendarRule,
    CalendarSaveRequest, CalendarTrigger, CalendarView, calendar_id_valid,
};
pub use codec::RevisionChanged;
pub use content::{
    BodyDescriptor, BriefingDoc, BriefingItem, ContentOutcome, ContentRefusal, ContentSelector,
    ContentSlice, FullTaskReport, MarkdownPage, READER_PAGE_SIZE, body_covers, body_need,
    content_digest, markdown_page, page_count, utf16_len,
};
pub use control_fields::{ControlPage, ControlPart, ControlRow, ReceiptContent};
pub use detail::{
    DetailRead, Header, MapHeader, Report, ReportOutcome, Task, TaskPage, TaskStatus, TaskWindow,
};
pub use directory::{DirectoryChanged, DirectoryRead, is_auth_expired};
pub use launch::{
    CalendarUnsupportedReason, CriteriaStructure, CriterionConnector, CriterionRole,
    LaunchCriterion, LaunchPolicy, MISSION_CALENDAR_LIMIT, MISSION_FILES_CHANGED_MAX,
    MISSION_LAUNCH_CRITERIA_MAX, RepositoryEvent, RepositoryProvider,
};
pub use lifecycle::{
    ControlReceipt, LifecycleAction, LifecycleOutcome, LifecycleRequest, LifecycleTarget,
    request_id,
};
pub use model::{
    Cleanup, DirectoryPage, DirectoryRows, ExecutionProfile, ModelRef, Profiles, RunState, Status,
    Summary, TaskMode, Template, Window,
};
