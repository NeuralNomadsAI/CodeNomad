//! Read-only Mission views owned by a project occurrence.
mod briefing;
mod briefing_view;
mod control_fields;
mod detail;
mod directory;
mod editor;
mod editor_holds;
mod editor_view;
mod lifecycle;
mod lifecycle_view;
mod observation;
mod reader;
mod task_rows;
mod view;

#[cfg(test)]
pub(crate) use briefing::BriefingPhase;
pub(crate) use briefing::{ActiveBriefing, BriefingGesture, BriefingKey, BriefingRequests};
pub(crate) use briefing_view::{
    confirmation as briefing_confirmation, controls as briefing_controls,
};
pub(crate) use directory::Panel;
pub(crate) use editor::{CloseSurface, EditorGesture, LeaveIntent};
pub(crate) use editor_holds::EditorHolds;
pub(crate) use editor_view::view as editor_view;
pub(crate) use lifecycle::{Gesture, Lifecycle, Source};
pub(crate) use lifecycle_view::{confirmation, controls};
pub(crate) use reader::view::view as reader_view;
#[cfg(test)]
pub(crate) use view::panel;
pub(crate) use view::panel_body;
