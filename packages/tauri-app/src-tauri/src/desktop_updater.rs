//! Native update authority: renderers never supply a URL, public key or installer.
//! Download and verification precede the existing all-window shutdown fence.
use serde::Serialize;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

static BUSY: AtomicBool = AtomicBool::new(false);

struct UpdateLease;
impl UpdateLease {
    fn acquire() -> Result<Self, String> {
        BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self).map_err(|_| "An update operation is already running".into())
    }
}
impl Drop for UpdateLease {
    fn drop(&mut self) { BUSY.store(false, Ordering::Release); }
}

pub(crate) struct PreparedUpdate {
    install: Option<Box<dyn FnOnce() -> Result<(), String> + Send>>,
    on_cancel: Box<dyn Fn() + Send>,
    notify_on_drop: bool,
}

impl PreparedUpdate {
    pub(crate) fn new(
        install: impl FnOnce() -> Result<(), String> + Send + 'static,
        on_cancel: impl Fn() + Send + 'static,
    ) -> Self {
        Self { install: Some(Box::new(install)), on_cancel: Box::new(on_cancel), notify_on_drop: false }
    }

    pub(crate) fn arm(&mut self) { self.notify_on_drop = true; }

    pub(crate) fn install(mut self) -> Result<(), String> {
        self.notify_on_drop = false;
        self.install.take().expect("prepared update is consumed once")()
    }
}

impl Drop for PreparedUpdate {
    fn drop(&mut self) {
        if self.notify_on_drop { (self.on_cancel)(); }
    }
}

#[derive(Default)]
pub(crate) struct UpdateState {
    checked: Mutex<Option<Update>>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum CheckResult {
    Unsupported,
    Current,
    Available { version: String },
}

pub(crate) fn register<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    config: &tauri::Config,
) -> tauri::Builder<R> {
    // The plugin requires a config object at initialization, even if callers
    // never check for updates. Unsigned builds deliberately omit that object.
    if config.plugins.0.contains_key("updater") {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    }
}

fn configured(app: &AppHandle) -> bool {
    crate::updater_support::current_platform_support()
        && app.config().plugins.0.get("updater").is_some_and(|config| {
            config.get("pubkey").and_then(|v| v.as_str()).is_some_and(|key| !key.trim().is_empty())
                && config.get("endpoints").and_then(|v| v.as_array()).is_some_and(|urls| !urls.is_empty())
        })
}

#[tauri::command]
pub(crate) async fn check_stable_update(
    webview: tauri::Webview,
    state: tauri::State<'_, crate::AppState>,
) -> Result<CheckResult, String> {
    crate::require_preferences_or_local_app_webview(&webview, &state)?;
    let _lease = UpdateLease::acquire()?;
    let app = webview.app_handle();
    let updates = app.state::<UpdateState>();
    updates.checked.lock().map_err(|e| e.to_string())?.take();
    if !configured(app) { return Ok(CheckResult::Unsupported); }
    let exit_app = app.clone();
    let update = app.updater_builder()
        .timeout(Duration::from_secs(30))
        // Windows installers terminate the process directly. The backend and
        // renderer flush already completed before PreparedUpdate::install.
        .on_before_exit(move || crate::client_state::release(&exit_app))
        .build().map_err(|e| e.to_string())?
        .check().await.map_err(|e| e.to_string())?;
    match update {
        Some(mut update) => {
            update.timeout = Some(Duration::from_secs(600));
            let version = update.version.clone();
            *updates.checked.lock().map_err(|e| e.to_string())? = Some(update);
            Ok(CheckResult::Available { version })
        }
        None => Ok(CheckResult::Current),
    }
}

#[tauri::command]
pub(crate) async fn install_stable_update(
    webview: tauri::Webview,
    state: tauri::State<'_, crate::AppState>,
    version: String,
) -> Result<(), String> {
    crate::require_preferences_or_local_app_webview(&webview, &state)?;
    let lease = UpdateLease::acquire()?;
    let app = webview.app_handle().clone();
    if !configured(&app) { return Err("This installation does not support in-place updates".into()); }
    let updates = app.state::<UpdateState>();
    let update = updates.checked.lock().map_err(|e| e.to_string())?.take()
        .filter(|update| update.version == version)
        .ok_or("The checked update has changed; check again before installing")?;
    // No install or shutdown occurs unless the plugin verifies the full download.
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let failed_app = app.clone();
    crate::shutdown::request_update(app, PreparedUpdate::new(
        move || {
            let _lease = lease;
            update.install(&bytes).map_err(|e| e.to_string())
        },
        move || report_failure(&failed_app),
    ))
}

pub(crate) fn report_failure(app: &AppHandle) {
    let _ = app.emit("desktop-update:failed", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simultaneous_windows_cannot_install_or_check_during_an_update() {
        let first = UpdateLease::acquire().unwrap();
        assert!(UpdateLease::acquire().is_err());
        drop(first);
        assert!(UpdateLease::acquire().is_ok());
    }
}
