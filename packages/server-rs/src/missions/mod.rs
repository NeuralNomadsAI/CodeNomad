//! Missions: one-time runs, reads, the daily recurrence and the calendar, each a thin
//! admission in front of the native Missions plugin.
pub mod activity;
mod agent_control;
mod agent_read;
mod agent_settings;
mod bridge;
#[cfg(test)]
mod bridge_m8_tests;
pub mod calendar;
mod cleanup;
pub mod configuration;
pub mod creation_admission;
pub mod family;
pub mod human_answer;
mod inputs;
mod prepare;
pub mod reads;
mod recovery;
pub mod recurrence;
pub mod recurrence_contract;
pub mod recurrence_control;
pub mod recurrence_create;
pub mod recurrence_holds;
pub mod recurrence_selector;
pub mod run;
pub mod schedule_contract;
mod task_sessions;
pub mod time_zone;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};

use crate::Shared;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/workspaces/{id}/missions", get(reads::list).post(run::create))
        .route("/api/missions/playbooks", get(run::playbooks))
        .route("/api/workspaces/{id}/missions/recurrence", get(recurrence::snapshot).post(recurrence_create::create))
        .route("/api/workspaces/{id}/missions/recurrence/{schedule}/passages/{passage}", get(recurrence::passage))
        .route("/api/workspaces/{id}/missions/recurrence/{schedule}/current", get(recurrence::current_identity_route))
        .route(
            "/api/workspaces/{id}/missions/recurrence/{schedule}/current/{passage}/page",
            post(recurrence::current_page).layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .route(
            "/api/workspaces/{id}/missions/recurrence/{schedule}/current/{passage}/content",
            get(recurrence::current_content),
        )
        .route("/api/workspaces/{id}/missions/recurrence/{schedule}/control", post(recurrence_control::control))
        .route(
            "/api/workspaces/{id}/missions/recurrence/{schedule}/control/status",
            post(recurrence_control::control_status_route),
        )
        .route("/api/workspaces/{id}/missions/recurrence/{schedule}/run-now", post(recurrence_control::run_now))
        .route(
            "/api/workspaces/{id}/missions/recurrence/{schedule}/run-now/status",
            get(recurrence_control::run_now_status),
        )
        .route("/api/workspaces/{id}/missions/scheduled", get(calendar::list).post(calendar::create))
        .route("/api/workspaces/{id}/missions/scheduled/capabilities", get(calendar::capabilities))
        .route("/api/workspaces/{id}/missions/scheduled/requests/{request}", get(calendar::request_read))
        .route("/api/workspaces/{id}/missions/{mission}/schedule", get(calendar::read).post(calendar::control))
        .route(
            "/api/workspaces/{id}/missions/{mission}/schedule-settings",
            get(calendar::activation_read).post(calendar::activate),
        )
        .route("/api/workspaces/{id}/missions/creation/{request}", get(run::creation_receipt))
        .route("/api/workspaces/{id}/missions/{mission}/control", post(run::control))
        .route("/api/workspaces/{id}/missions/{mission}/recover", post(run::recover))
        .route("/api/workspaces/{id}/missions/{mission}", get(reads::mission).patch(run::update).delete(run::delete))
        .route("/api/workspaces/{id}/missions/{mission}/admission", get(reads::admission))
        .route("/api/workspaces/{id}/missions/{mission}/content", get(reads::content))
        .route("/api/workspaces/{id}/missions/{mission}/tasks", get(reads::tasks))
        .route("/api/workspaces/{id}/missions/panel-page", post(reads::panel).layer(DefaultBodyLimit::max(16 * 1024)))
}
