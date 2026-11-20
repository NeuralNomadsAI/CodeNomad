//! State shared by every route: the open workspaces, the native client, the event
//! fan-out and the per-domain slots, plus the JSON error shape of the reference.
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicU64},
};

use axum::{
    Json,
    http::StatusCode as Status,
    response::{IntoResponse, Response},
};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Notify, Semaphore, broadcast};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{auth, events, files::watch, missions, opencode::Native, shared::panic_guard::Lock};

pub type Shared = Arc<App>;
pub type Error = (Status, Json<Value>);

pub struct App {
    pub auth: auth::Auth,
    pub port: u16,
    pub data: PathBuf,
    pub root: PathBuf,
    /// `--unrestricted-root`: the folder browser and new workspaces are not limited to `root`.
    pub unrestricted: bool,
    /// The authorized filesystem root: `root`, or empty (any local absolute path) when unrestricted.
    pub scope: PathBuf,
    pub settings: crate::settings::Settings,
    pub meta: Value,
    pub native: Native,
    pub binary: PathBuf,
    pub inner: Lock<Inventory>,
    pub events: broadcast::Sender<Option<Arc<events::Frame>>>,
    pub event_budget: Arc<Semaphore>,
    pub extension_jobs: Arc<Semaphore>,
    pub devices: Option<Lock<auth::devices::Devices>>,
    pub opened: Notify,
    pub favorite_source: Uuid,
    pub favorite_revision: AtomicU64,
    pub favorite_scan: Arc<Semaphore>,
    pub file_watches: Mutex<watch::Watches>,
    pub file_reader: Semaphore,
    pub project_mutation: tokio::sync::Mutex<()>,
    pub mission_reads: bool,
    pub mission_read_slot: Semaphore,
    pub linked_events: crate::worktrees::linked::EventCache,
    pub mission_bridge: Option<String>,
    pub mission_control_slot: Semaphore,
    pub calendar_profile: Option<PathBuf>,
    pub calendar_slot: tokio::sync::Mutex<()>,
    pub calendar_claims: missions::calendar::Claims,
    pub calendar_holds: missions::calendar::Holds,
    pub sidecars: Lock<Vec<crate::sidecars::SideCar>>,
    pub usage: crate::usage::Usage,
}

#[derive(Default)]
pub struct Inventory {
    pub workspaces: Vec<Workspace>,
    pub connections: HashMap<(String, String), events::Client>,
    pub generation: u64,
    pub status: &'static str,
    pub pending: HashMap<String, CancellationToken>,
    pub released: HashMap<Uuid, String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub status: &'static str,
    pub proxy_path: String,
    pub binary_id: PathBuf,
    pub binary_label: String,
    pub created_at: String,
    pub updated_at: String,
    pub location: Value,
}

impl App {
    pub fn new(
        auth: auth::Auth,
        port: u16,
        data: PathBuf,
        root: PathBuf,
        unrestricted: bool,
        settings: crate::settings::Settings,
        meta: Value,
        native: Native,
        binary: PathBuf,
        devices: Option<Lock<auth::devices::Devices>>,
        watches: watch::Watches,
        calendar_profile: Option<PathBuf>,
    ) -> Self {
        Self {
            sidecars: Lock::new(crate::sidecars::load(&settings.owner(crate::settings::Kind::Config, "server"))),
            usage: Default::default(),
            auth,
            port,
            data,
            scope: if unrestricted { PathBuf::new() } else { root.clone() },
            root,
            unrestricted,
            settings,
            meta,
            native,
            binary,
            inner: Default::default(),
            events: broadcast::channel(128).0,
            event_budget: Arc::new(Semaphore::new(32 * 1024 * 1024)),
            extension_jobs: Arc::new(Semaphore::new(2)),
            devices,
            opened: Notify::new(),
            favorite_source: Uuid::new_v4(),
            favorite_revision: 1.into(),
            favorite_scan: Arc::new(Semaphore::new(1)),
            file_watches: Mutex::new(watches),
            file_reader: Semaphore::new(1),
            project_mutation: tokio::sync::Mutex::new(()),
            mission_reads: crate::bench::missions_read(),
            mission_read_slot: Semaphore::new(1),
            linked_events: Default::default(),
            mission_bridge: missions::run::new_token(),
            mission_control_slot: Semaphore::new(1),
            calendar_profile,
            calendar_slot: Default::default(),
            calendar_claims: Default::default(),
            calendar_holds: Default::default(),
        }
    }
    pub fn workspace(&self, id: &str) -> Result<Workspace, Error> {
        self.inner.lock().unwrap().workspaces.iter().find(|w| w.id.to_string() == id).cloned().ok_or_else(not_found)
    }
}

pub fn error(code: Status, message: &str) -> Error {
    (code, Json(json!({"error": message})))
}
pub fn unavailable() -> Response {
    error(Status::NOT_IMPLEMENTED, "Route not implemented in this prototype").into_response()
}
pub fn not_found() -> Error {
    error(Status::NOT_FOUND, "Workspace not found")
}
pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
