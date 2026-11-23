use super::{partitions::PartitionCommit, ClientState, ClientStateLoadResult};
use crate::AppState;
use serde_json::Value;
use tauri::{AppHandle, State, Webview};
use url::Url;

pub(crate) fn with_ordered_ipc(
    fallback: impl Fn(Invoke) -> bool,
) -> impl Fn(Invoke) -> bool {
    let dispatch: fn(Invoke) -> bool = tauri::generate_handler![
        client_state_claim_access,
        client_state_load,
        client_state_load_file_drafts,
        client_state_save_file_draft,
        client_state_save,
        client_state_commit_partitions,
        client_state_load_partition,
        client_state_set_restore_enabled,
        client_state_clear,
        client_state_renderer_flushed,
        client_state_navigation_flushed,
        client_state_startup_command_result,
    ];
    let send = ordered_worker(move |invoke: Invoke| {
        // The prefix is reserved for this handler; unknown names still
        // get a response, including if Tauri prunes a command at build time.
        if !dispatch(Invoke {
            resolver: invoke.resolver.clone(),
            ..invoke
        }) {
            invoke.resolver.reject("Unknown client state command");
        }
    });
    move |invoke| {
        if !invoke.message.command().starts_with("client_state_") {
            return fallback(invoke);
        }
        // Enqueue in native delivery order before yielding to any executor.
        // In particular, a flush acknowledgement cannot overtake a commit.
        if let Err(error) = send.send(invoke) {
            error.0.resolver.reject("Client state IPC worker stopped");
        }
        true
    }
}

type Invoke = tauri::ipc::Invoke<tauri::Wry>;

pub(super) fn ordered_worker<T: Send + 'static>(
    dispatch: impl Fn(T) + Send + 'static,
) -> std::sync::mpsc::Sender<T> {
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("client-state-ipc".into())
        .spawn(move || receive.into_iter().for_each(dispatch))
        .expect("start client state IPC worker");
    send
}

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

fn local_window_url(webview: &Webview) -> Result<Url, String> {
    crate::identity::local_window_id(webview.label())?;
    webview
        .url()
        .map_err(|err| format!("failed to inspect current renderer URL: {err}"))
}

fn trusted_window_id(webview: &Webview) -> Result<String, String> {
    crate::identity::local_window_id(webview.label())
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
    webview: &Webview,
    state: &ClientState,
    access_token: &str,
) -> Result<(String, u64), String> {
    let current_url = local_window_url(webview)?;
    let window_id = trusted_window_id(webview)?;
    state
        .renderer_access
        .validate_for(&window_id, access_token, &current_url)
        .map(|generation| (window_id, generation))
}

#[tauri::command]
pub fn client_state_claim_access(
    webview: Webview,
    app_state: State<'_, AppState>,
    state: State<'_, ClientState>,
    access_token: String,
) -> Result<(), String> {
    let current_url = local_window_url(&webview)?;
    let window_id = trusted_window_id(&webview)?;
    validate_claim_origin(&current_url, &window_id, &app_state, &state)?;
    state.claim_renderer_access(&window_id, &access_token, &current_url)
}

#[tauri::command]
pub fn client_state_load(
    webview: Webview,
    state: State<'_, ClientState>,
    access_token: String,
) -> Result<ClientStateLoadResult, String> {
    let (window_id, generation) = validate_access(&webview, &state, &access_token)?;
    let result = state.load_window(&window_id)?;
    if validate_access(&webview, &state, &access_token)?.1 != generation {
        return Err("Client state renderer authority changed during load".into());
    }
    Ok(result)
}

#[tauri::command]
pub fn client_state_load_file_drafts(
    webview: Webview,
    state: State<'_, ClientState>,
    access_token: String,
    key: Option<String>,
) -> Result<Vec<super::file_drafts::Draft>, String> {
    let (window_id, generation) = validate_access(&webview, &state, &access_token)?;
    let result = state.load_file_drafts_for(&window_id, key.as_deref(), generation)?;
    if validate_access(&webview, &state, &access_token)?.1 != generation {
        return Err("Client state renderer authority changed during load".into());
    }
    Ok(result)
}

#[tauri::command]
pub fn client_state_save_file_draft(
    webview: Webview,
    state: State<'_, ClientState>,
    access_token: String,
    change: super::file_drafts::Change,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&webview, &state, &access_token)?;
    state.save_file_draft_for(&window_id, change, Some(generation), || {
        state.renderer_access.is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_load_partition(
    webview: Webview,
    state: State<'_, ClientState>,
    access_token: String,
    key: String,
) -> Result<Option<String>, String> {
    let (window_id, generation) = validate_access(&webview, &state, &access_token)?;
    state.load_partition_guarded_for(&window_id, &key, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_save(
    webview: Webview,
    state: State<'_, ClientState>,
    access_token: String,
    snapshot: Value,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&webview, &state, &access_token)?;
    state.save_snapshot_guarded_for(&window_id, snapshot, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_commit_partitions(
    webview: Webview,
    state: State<'_, ClientState>,
    access_token: String,
    payload: PartitionCommit,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&webview, &state, &access_token)?;
    state.commit_partitions_guarded_for(&window_id, payload, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_set_restore_enabled(
    webview: Webview,
    state: State<'_, ClientState>,
    access_token: String,
    enabled: bool,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&webview, &state, &access_token)?;
    state.set_restore_enabled_guarded(&window_id, enabled, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_clear(
    webview: Webview,
    state: State<'_, ClientState>,
    access_token: String,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&webview, &state, &access_token)?;
    state.clear_guarded(&window_id, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_renderer_flushed(
    app: AppHandle,
    webview: Webview,
    app_state: State<'_, AppState>,
    state: State<'_, ClientState>,
    access_token: String,
    generation: u64,
) -> Result<(), String> {
    if webview.label().starts_with("remote-") {
        let label = webview.label().to_string();
        crate::shutdown::renderer_flushed(app, label.clone(), label, generation);
        return Ok(());
    }
    // Forgetting a window revokes snapshot writes before the release ACK.
    // A trusted renderer can still finish its own approved release generation.
    let window_id = trusted_window_id(&webview)?;
    if validate_claim_origin(&local_window_url(&webview)?, &window_id, &app_state, &state).is_ok()
        && crate::shutdown::finish_local_release(&app, webview.label(), generation)
    {
        return Ok(());
    }
    let (window_id, _) = validate_access(&webview, &state, &access_token)?;
    crate::shutdown::renderer_flushed(app, webview.label().to_string(), window_id, generation);
    Ok(())
}

/// Reply from the opener renderer to a forwarded Preferences startup command.
/// Only the targeted window's claimed renderer can settle its own request.
#[tauri::command]
pub fn client_state_startup_command_result(
    webview: Webview,
    state: State<'_, ClientState>,
    access_token: String,
    id: u64,
    state_result: Option<super::StartupStateSnapshot>,
) -> Result<(), String> {
    let (window_id, _) = validate_access(&webview, &state, &access_token)?;
    state
        .startup_commands
        .complete(id, &window_id, state_result)
}

#[tauri::command]
pub fn client_state_navigation_flushed(
    webview: Webview,
    state: State<'_, ClientState>,
    access_token: String,
    generation: u64,
) -> Result<(), String> {
    let (window_id, _) = validate_access(&webview, &state, &access_token)?;
    state.acknowledge_renderer_flush(&window_id, generation);
    Ok(())
}
