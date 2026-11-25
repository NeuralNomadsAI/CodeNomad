//! Read-only Mission views owned by a project occurrence.
mod briefing;
mod briefing_view;
mod control_fields;
mod detail;
mod directory;
mod lifecycle;
mod lifecycle_view;
mod observation;
mod task_rows;
mod view;

#[cfg(test)]
pub(crate) use briefing::BriefingPhase;
pub(crate) use briefing::{ActiveBriefing, BriefingGesture, BriefingKey, BriefingRequests};
pub(crate) use briefing_view::{
    confirmation as briefing_confirmation, controls as briefing_controls,
};
pub(crate) use directory::Panel;
pub(crate) use lifecycle::{Gesture, Lifecycle, Source};
pub(crate) use lifecycle_view::{confirmation, controls};
#[cfg(test)]
pub(crate) use view::panel;
pub(crate) use view::panel_body;
