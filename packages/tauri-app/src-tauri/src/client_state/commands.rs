use super::{ClientState, ClientStateLoadResult, CLIENT_STATE_OWNERSHIP_CHANGED_EVENT};
use crate::AppState;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use url::Url;

fn same_origin(url: &Url, expected: &str) -> bool {
    Url::parse(expected)
        .map(|expected| url.origin() == expected.origin())
        .unwrap_or(false)
}

fn is_app_renderer_origin(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => url.host_str() == Some("tauri.localhost") && url.port().is_none(),
        _ => false,
    }
}

fn is_dev_renderer_origin(url: &Url) -> bool {
    cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port() == Some(1420)
}

pub(super) fn is_allowed_client_state_origin(url: &Url, managed_cli_url: Option<&str>) -> bool {
    managed_cli_url
        .map(|expected| same_origin(url, expected))
        .unwrap_or(false)
        || is_app_renderer_origin(url)
        || is_dev_renderer_origin(url)
}

fn main_window_url(window: &WebviewWindow) -> Result<Url, String> {
    if window.label() != "main" {
        return Err(
            "Client state commands are only available to the local main window".to_string(),
        );
    }

    window
        .url()
        .map_err(|err| format!("failed to inspect current renderer URL: {err}"))
}

fn validate_claim_origin(
    current_url: &Url,
    app_state: &AppState,
    state: &ClientState,
) -> Result<(), String> {
    let status = app_state.manager.status();
    if state.renderer_access.allows_claim_origin(current_url)
        || is_allowed_client_state_origin(current_url, status.url.as_deref())
    {
        Ok(())
    } else {
        Err("Client state commands are not available to the current renderer origin".to_string())
    }
}

fn validate_access(
    window: &WebviewWindow,
    state: &ClientState,
    access_token: &str,
) -> Result<u64, String> {
    let current_url = main_window_url(window)?;
    state.renderer_access.validate(access_token, &current_url)
}

fn notify_renderer_of_promotion(window: &WebviewWindow, state: &ClientState) {
    if state.take_renderer_reload() {
        super::window::reconcile_main_window(&window.app_handle());
        let _ = window.emit(CLIENT_STATE_OWNERSHIP_CHANGED_EVENT, ());
    }
}

#[tauri::command]
pub fn client_state_claim_access(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
    state: State<'_, ClientState>,
    access_token: String,
) -> Result<(), String> {
    let current_url = main_window_url(&window)?;
    validate_claim_origin(&current_url, &app_state, &state)?;
    state.claim_renderer_access(&access_token, &current_url)
}

#[tauri::command]
pub fn client_state_load(
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
) -> Result<ClientStateLoadResult, String> {
    validate_access(&window, &state, &access_token)?;
    let result = state.load();
    notify_renderer_of_promotion(&window, &state);
    result
}

#[tauri::command]
pub fn client_state_save(
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
    snapshot: Value,
) -> Result<bool, String> {
    let generation = validate_access(&window, &state, &access_token)?;
    let result = state.save_snapshot_guarded(snapshot, || {
        state.renderer_access.is_generation_current(generation)
    });
    notify_renderer_of_promotion(&window, &state);
    result
}

#[tauri::command]
pub fn client_state_set_restore_enabled(
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
    enabled: bool,
) -> Result<bool, String> {
    let generation = validate_access(&window, &state, &access_token)?;
    let result = state.set_restore_enabled_guarded(enabled, || {
        state.renderer_access.is_generation_current(generation)
    });
    notify_renderer_of_promotion(&window, &state);
    result
}

#[tauri::command]
pub fn client_state_clear(
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
) -> Result<bool, String> {
    let generation = validate_access(&window, &state, &access_token)?;
    let result = state.clear_guarded(|| state.renderer_access.is_generation_current(generation));
    notify_renderer_of_promotion(&window, &state);
    result
}

#[tauri::command]
pub fn client_state_renderer_flushed(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
    generation: u64,
) -> Result<(), String> {
    validate_access(&window, &state, &access_token)?;
    crate::shutdown::renderer_flushed(app, generation);
    Ok(())
}

#[tauri::command]
pub fn client_state_navigation_flushed(
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
    generation: u64,
) -> Result<(), String> {
    validate_access(&window, &state, &access_token)?;
    state.acknowledge_renderer_flush(generation);
    Ok(())
}
