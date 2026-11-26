//! Read-only display contracts for Missions on the workspace's owning backend.
mod activity;
mod attention;
mod briefing;
mod codec;
mod content;
mod control_fields;
mod detail;
mod directory;
mod editor;
mod lifecycle;
mod model;
mod profile_defaults;
pub use activity::{Activity, Actor, ActorState, Coverage};
pub use attention::Attention;
pub use briefing::{
    BriefingAdmissionOutcome, BriefingSendOutcome, BriefingSendState, BriefingTarget,
    accepts_coordinator_message_value, briefing_request_text,
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
    Template,
};
pub use directory::{DirectoryChanged, DirectoryRead, is_auth_expired};
pub use editor::{
    CreateAcknowledgement, CreateMissionOutcome, CreateMissionRequest, CreatedMission,
    CreationReceiptOutcome, DocumentEditCheck, EditReceiptOutcome, EditorBodyOutcome,
    MISSION_TEXT_MAX, MISSION_TITLE_MAX, MutationCode, TaskMode, UpdateMissionOutcome,
    UpdateMissionRequest, derive_mission_title, js_trim, valid_notes_input, valid_objective_input,
    valid_title_input,
};
pub use lifecycle::{
    ControlReceipt, LifecycleAction, LifecycleOutcome, LifecycleRequest, LifecycleTarget,
    request_id,
};
pub use model::{Cleanup, DirectoryPage, DirectoryRows, RunState, Status, Summary, Window};
pub use profile_defaults::{
    MissionCatalog, MissionCatalogAgent, MissionCatalogModel, MissionCatalogOutcome,
    MissionDefaultScope, MissionDefaultsOutcome, MissionExecution, MissionModelRef,
    MissionProfileDefault, MissionProfiles, catalog_profiles_valid, compare_model_error,
    defaults_have_profiles, freeze_compare_profiles, mission_defaults_for, mission_task_mode_for,
    normalize_mission_defaults, template_roles, valid_mission_profiles,
};
