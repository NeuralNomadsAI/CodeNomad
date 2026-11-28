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
use tokio::sync::{Notify, Semaphore};
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
    pub releases: crate::meta::releases::Monitor,
    pub native: Native,
    pub binary: PathBuf,
    pub inner: Lock<Inventory>,
    pub events: events::Hub,
    pub extension_jobs: Arc<Semaphore>,
    pub devices: Option<Lock<auth::devices::Devices>>,
    pub remote_control: crate::remote_control::Manager,
    pub opened: Notify,
    pub workspace_closed: Notify,
    pub favorite_source: Uuid,
    pub favorite_revision: AtomicU64,
    pub favorite_scan: Arc<Semaphore>,
    pub session_cleanup: crate::sessions::cleanup::Fence,
    pub file_watches: Mutex<watch::Watches>,
    pub file_reader: Semaphore,
    pub mission_reads: bool,
    pub mission_read_slot: Semaphore,
    pub linked_events: crate::worktrees::linked::EventCache,
    pub mission_bridge: Option<String>,
    /// The published automation bridge token: the Missions fixture's when it runs, else fresh.
    pub bridge_token: Option<String>,
    pub human_answer: missions::human_answer::InFlight,
    pub automation_pins: crate::automation::Pins,
    pub mission_control_slot: Semaphore,
    pub mission_creations: missions::creation_admission::Creations,
    pub calendar_profile: Option<PathBuf>,
    pub calendar_slot: tokio::sync::Mutex<()>,
    pub calendar_claims: missions::calendar::Claims,
    pub calendar_holds: missions::calendar::Holds,
    pub sidecars: Lock<Vec<crate::sidecars::SideCar>>,
    pub usage: crate::usage::Usage,
    pub provider_usage: Arc<crate::provider_usage::State>,
    pub previews: crate::previews::Previews,
    pub integration_catalog: crate::plugin_controls::catalog::CatalogSource,
    pub integration_attachments: crate::integrations::attachments::SessionQueue,
    pub temporary_workspaces: Option<crate::temporary_workspaces::TemporaryFolderRegistry>,
    pub service_activation: crate::opencode::service_action::Activation,
}

#[derive(Default)]
pub struct Inventory {
    pub workspaces: Vec<Workspace>,
    pub connections: HashMap<(String, String), events::Client>,
    pub generation: u64,
    pub status: &'static str,
    pub pending: HashMap<String, CancellationToken>,
    pub released: HashMap<Uuid, String>,
    pub early_cancellations: crate::workspaces::EarlyCancellations,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temporary: Option<bool>,
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
        let mission_bridge = missions::run::new_token();
        let remote_control = crate::remote_control::Manager::new(&data);
        let integration_catalog =
            crate::plugin_controls::catalog::CatalogSource::new(Some(data.join("integrations-catalog.json")));
        let scope = if unrestricted { PathBuf::new() } else { root.clone() };
        native.attach_settings(settings.location.config.clone());
        let temporary_workspaces = crate::temporary_workspaces::TemporaryFolderRegistry::open(
            settings.location.base.join("temporary-workspaces"),
            settings.location.base.join("temporary-workspaces.json"),
            &scope,
        )
        .map_err(|err| eprintln!("Temporary workspaces are unavailable: {err}"))
        .ok();
        Self {
            releases: crate::meta::releases::Monitor::new(&settings),
            sidecars: Lock::new(crate::sidecars::load(&settings.owner(crate::settings::Kind::Config, "server"))),
            usage: Default::default(),
            provider_usage: Default::default(),
            previews: Default::default(),
            integration_catalog,
            integration_attachments: Default::default(),
            temporary_workspaces,
            service_activation: Default::default(),
            bridge_token: mission_bridge.clone().or_else(crate::automation::new_token),
            human_answer: Default::default(),
            automation_pins: Default::default(),
            auth,
            port,
            data,
            scope,
            root,
            unrestricted,
            settings,
            meta,
            native,
            binary,
            inner: Default::default(),
            events: Default::default(),
            extension_jobs: Arc::new(Semaphore::new(2)),
            devices,
            remote_control,
            opened: Notify::new(),
            workspace_closed: Notify::new(),
            favorite_source: Uuid::new_v4(),
            favorite_revision: 1.into(),
            favorite_scan: Arc::new(Semaphore::new(1)),
            session_cleanup: Default::default(),
            file_watches: Mutex::new(watches),
            file_reader: Semaphore::new(1),
            mission_reads: crate::config::serve() || crate::bench::missions_read(),
            mission_read_slot: Semaphore::new(1),
            linked_events: Default::default(),
            mission_bridge,
            mission_control_slot: Semaphore::new(1),
            mission_creations: Default::default(),
            calendar_profile,
            calendar_slot: Default::default(),
            calendar_claims: Default::default(),
            calendar_holds: Default::default(),
        }
    }
    pub fn workspace(&self, id: &str) -> Result<Workspace, Error> {
        self.inner.lock().unwrap().workspaces.iter().find(|w| w.id.to_string() == id).cloned().ok_or_else(not_found)
    }
    pub fn current_binary(&self) -> PathBuf {
        self.native.binary().map(PathBuf::from).unwrap_or_else(|| self.binary.clone())
    }
}

/// Internal failures are also kept, with their call site, for `codenomad.inspect`.
#[track_caller]
pub fn error(code: Status, message: &str) -> Error {
    crate::automation::diagnostics::error(code.as_u16(), message, std::panic::Location::caller());
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
