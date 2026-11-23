use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Active,
    Completed,
    Failed,
    Stopped,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunState {
    Prepared,
    Running,
    Paused,
    Stopped,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Summary {
    pub id: String,
    pub title: Option<String>,
    pub objective: String,
    pub status: Status,
    pub run_state: Option<RunState>,
    pub coordinator_session_id: String,
    pub actor_count: u64,
    pub updated_at: f64,
    pub revision: u64,
    pub finish_sequence: Option<u64>,
    pub task_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cleanup {
    #[serde(rename = "missionID")]
    pub mission_id: String,
    #[serde(rename = "deletionID")]
    pub deletion_id: String,
    #[serde(rename = "requestID")]
    pub request_id: String,
    pub expected_revision: u64,
    pub delete_managed_sessions: bool,
    pub objective: String,
    pub created_at: f64,
    pub removed: u64,
    pub retained: u64,
    pub pending: u64,
    pub reasons: Vec<String>,
    pub document_pending: Option<bool>,
}

#[derive(Debug)]
pub enum DirectoryRows {
    Summaries(Vec<Summary>),
    Cleanups(Vec<Cleanup>),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub order: String,
    pub offset: u64,
    pub end: u64,
    pub total: u64,
}

#[derive(Debug)]
pub struct DirectoryPage {
    pub project_id: String,
    pub finish_high_water: Option<u64>,
    pub window: Window,
    pub rows: DirectoryRows,
}
