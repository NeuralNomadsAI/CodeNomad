use super::{partitions::PartitionCommit, ClientState, ClientStateLoadResult};
use crate::AppState;
use serde_json::Value;
use tauri::{AppHandle, State, WebviewWindow};
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

fn local_window_url(window: &WebviewWindow) -> Result<Url, String> {
    crate::identity::local_window_id(window.label())?;
    window
        .url()
        .map_err(|err| format!("failed to inspect current renderer URL: {err}"))
}

fn trusted_window_id(window: &WebviewWindow) -> Result<String, String> {
    crate::identity::local_window_id(window.label())
}

fn validate_claim_origin(
    current_url: &Url,
    window_id: &str,
    app_state: &AppState,
    state: &ClientState,
) -> Result<(), String> {
    let status = app_state.manager.status();
    if state
        .renderer_access
        .allows_claim_origin_for(window_id, current_url)
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
) -> Result<(String, u64), String> {
    let current_url = local_window_url(window)?;
    let window_id = trusted_window_id(window)?;
    state
        .renderer_access
        .validate_for(&window_id, access_token, &current_url)
        .map(|generation| (window_id, generation))
}

#[tauri::command]
pub fn client_state_claim_access(
    window: WebviewWindow,
    app_state: State<'_, AppState>,
    state: State<'_, ClientState>,
    access_token: String,
) -> Result<(), String> {
    let current_url = local_window_url(&window)?;
    let window_id = trusted_window_id(&window)?;
    validate_claim_origin(&current_url, &window_id, &app_state, &state)?;
    state.claim_renderer_access(&window_id, &access_token, &current_url)
}

#[tauri::command]
pub fn client_state_load(
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
) -> Result<ClientStateLoadResult, String> {
    let (window_id, _) = validate_access(&window, &state, &access_token)?;
    state.load_window(&window_id)
}

#[tauri::command]
pub fn client_state_load_partition(
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
    key: String,
) -> Result<Option<String>, String> {
    let (window_id, generation) = validate_access(&window, &state, &access_token)?;
    state.load_partition_guarded_for(&window_id, &key, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_save(
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
    snapshot: Value,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&window, &state, &access_token)?;
    state.save_snapshot_guarded_for(&window_id, snapshot, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_commit_partitions(
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
    payload: PartitionCommit,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&window, &state, &access_token)?;
    state.commit_partitions_guarded_for(&window_id, payload, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_set_restore_enabled(
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
    enabled: bool,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&window, &state, &access_token)?;
    state.set_restore_enabled_guarded(&window_id, enabled, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_clear(
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&window, &state, &access_token)?;
    state.clear_guarded(&window_id, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_renderer_flushed(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
    generation: u64,
) -> Result<(), String> {
    let (window_id, _) = validate_access(&window, &state, &access_token)?;
    crate::shutdown::renderer_flushed(app, window.label().to_string(), window_id, generation);
    Ok(())
}

#[tauri::command]
pub fn client_state_navigation_flushed(
    window: WebviewWindow,
    state: State<'_, ClientState>,
    access_token: String,
    generation: u64,
) -> Result<(), String> {
    let (window_id, _) = validate_access(&window, &state, &access_token)?;
    state.acknowledge_renderer_flush(&window_id, generation);
    Ok(())
}
