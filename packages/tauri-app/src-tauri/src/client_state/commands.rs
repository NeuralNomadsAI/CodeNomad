use super::{partitions::PartitionCommit, ClientState, ClientStateLoadResult, IpcQueue};
use crate::AppState;
use serde_json::Value;
use std::cell::RefCell;
use tauri::{AppHandle, Manager, State};
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
    move |invoke| {
        if !invoke.message.command().starts_with("client_state_") {
            return fallback(invoke);
        }
        let webview = invoke.message.webview_ref();
        let app = webview.app_handle().clone();
        let resolver = invoke.resolver.clone();
        let renderer = (|| {
            let label = webview.label().to_owned();
            if label.starts_with("remote-") && invoke.message.command() == "client_state_renderer_flushed" {
                return Ok(Renderer { label, local: None });
            }
            let window_id = crate::identity::local_window_id(&label)?;
            let state = app.try_state::<ClientState>().ok_or("Client state is unavailable")?;
            let document = state.renderer_access.document_for(&window_id);
            let url = webview.url().map_err(|err| format!("failed to inspect current renderer URL: {err}"))?;
            Ok::<_, String>(Renderer { label, local: Some(LocalDocument { window_id, document, url }) })
        })();
        let renderer = match renderer {
            Ok(renderer) => renderer,
            Err(error) => {
                resolver.reject(error);
                return true;
            }
        };
        let queue = app.state::<IpcQueue>();
        // Capture native getters before admission; the worker can drain even
        // while the event thread waits for WM_ENDSESSION.
        let reply = resolver.clone();
        if let Err(error) = queue.enqueue(Box::new(move || {
            RENDERER.with(|slot| {
                slot.replace(Some(renderer));
                let handled = dispatch(invoke);
                slot.replace(None);
                if !handled {
                    reply.reject("Unknown client state command");
                }
            });
        })) {
            resolver.reject(error);
        }
        true
    }
}

type Invoke = tauri::ipc::Invoke<tauri::Wry>;

#[derive(Clone)]
pub(super) struct Renderer {
    label: String,
    local: Option<LocalDocument>,
}

#[derive(Clone)]
pub(super) struct LocalDocument {
    pub(super) window_id: String,
    pub(super) document: u64,
    pub(super) url: Url,
}

// Tauri's synchronous generated commands resolve arguments on the calling
// thread. Supply native-only context without putting it in the renderer payload.
thread_local! {
    static RENDERER: RefCell<Option<Renderer>> = const { RefCell::new(None) };
}

impl<'a> tauri::ipc::CommandArg<'a, tauri::Wry> for Renderer {
    fn from_command(_: tauri::ipc::CommandItem<'a, tauri::Wry>) -> Result<Self, tauri::ipc::InvokeError> {
        RENDERER.with(|slot| slot.borrow().clone()).ok_or_else(|| "Missing client state IPC context".into())
    }
}

impl Renderer {
    fn local(&self) -> Result<&LocalDocument, String> {
        self.local.as_ref().ok_or_else(|| "Client state requires a local renderer".into())
    }
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
    renderer: &Renderer,
    state: &ClientState,
    access_token: &str,
) -> Result<(String, u64), String> {
    let local = renderer.local()?;
    local.validate(state, access_token).map(|generation| (local.window_id.clone(), generation))
}

impl LocalDocument {
    pub(super) fn validate(&self, state: &ClientState, token: &str) -> Result<u64, String> {
        state.renderer_access.validate_in_document(&self.window_id, self.document, token, &self.url)
    }
}

#[tauri::command]
pub fn client_state_claim_access(
    renderer: Renderer,
    app_state: State<'_, AppState>,
    state: State<'_, ClientState>,
    access_token: String,
) -> Result<(), String> {
    let local = renderer.local()?;
    validate_claim_origin(&local.url, &local.window_id, &app_state, &state)?;
    state.claim_renderer_access(&local.window_id, local.document, &access_token, &local.url)
}

#[tauri::command]
pub fn client_state_load(
    renderer: Renderer,
    state: State<'_, ClientState>,
    access_token: String,
) -> Result<ClientStateLoadResult, String> {
    let (window_id, generation) = validate_access(&renderer, &state, &access_token)?;
    let result = state.load_window(&window_id)?;
    if validate_access(&renderer, &state, &access_token)?.1 != generation {
        return Err("Client state renderer authority changed during load".into());
    }
    Ok(result)
}

#[tauri::command]
pub fn client_state_load_file_drafts(
    renderer: Renderer,
    state: State<'_, ClientState>,
    access_token: String,
    key: Option<String>,
) -> Result<Vec<super::file_drafts::Draft>, String> {
    let (window_id, generation) = validate_access(&renderer, &state, &access_token)?;
    let result = state.load_file_drafts_for(&window_id, key.as_deref(), generation)?;
    if validate_access(&renderer, &state, &access_token)?.1 != generation {
        return Err("Client state renderer authority changed during load".into());
    }
    Ok(result)
}

#[tauri::command]
pub fn client_state_save_file_draft(
    renderer: Renderer,
    state: State<'_, ClientState>,
    access_token: String,
    change: super::file_drafts::Change,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&renderer, &state, &access_token)?;
    state.save_file_draft_for(&window_id, change, Some(generation), || {
        state.renderer_access.is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_load_partition(
    renderer: Renderer,
    state: State<'_, ClientState>,
    access_token: String,
    key: String,
) -> Result<Option<String>, String> {
    let (window_id, generation) = validate_access(&renderer, &state, &access_token)?;
    state.load_partition_guarded_for(&window_id, &key, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_save(
    renderer: Renderer,
    state: State<'_, ClientState>,
    access_token: String,
    snapshot: Value,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&renderer, &state, &access_token)?;
    state.save_snapshot_guarded_for(&window_id, snapshot, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_commit_partitions(
    renderer: Renderer,
    state: State<'_, ClientState>,
    access_token: String,
    payload: PartitionCommit,
) -> Result<bool, String> {
    let local = renderer.local()?;
    commit_partitions(local, &state, &access_token, payload)
}

pub(super) fn commit_partitions(
    local: &LocalDocument,
    state: &ClientState,
    access_token: &str,
    payload: PartitionCommit,
) -> Result<bool, String> {
    let generation = local.validate(state, access_token)?;
    state.commit_partitions_guarded_for(&local.window_id, payload, || {
        state
            .renderer_access
            .is_generation_current_for(&local.window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_set_restore_enabled(
    renderer: Renderer,
    state: State<'_, ClientState>,
    access_token: String,
    enabled: bool,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&renderer, &state, &access_token)?;
    state.set_restore_enabled_guarded(&window_id, enabled, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_clear(
    renderer: Renderer,
    state: State<'_, ClientState>,
    access_token: String,
) -> Result<bool, String> {
    let (window_id, generation) = validate_access(&renderer, &state, &access_token)?;
    state.clear_guarded(&window_id, || {
        state
            .renderer_access
            .is_generation_current_for(&window_id, generation)
    })
}

#[tauri::command]
pub fn client_state_renderer_flushed(
    app: AppHandle,
    renderer: Renderer,
    app_state: State<'_, AppState>,
    state: State<'_, ClientState>,
    access_token: String,
    generation: u64,
) -> Result<(), String> {
    if renderer.local.is_none() {
        crate::shutdown::renderer_flushed(app, renderer.label.clone(), renderer.label, generation);
        return Ok(());
    }
    // Forgetting a window revokes snapshot writes before the release ACK.
    // A trusted renderer can still finish its own approved release generation.
    let local = renderer.local()?;
    if state.renderer_access.document_is_current(&local.window_id, local.document)
        && validate_claim_origin(&local.url, &local.window_id, &app_state, &state).is_ok()
        && crate::shutdown::finish_local_release(&app, &renderer.label, generation)
    {
        return Ok(());
    }
    let (window_id, _) = validate_access(&renderer, &state, &access_token)?;
    crate::shutdown::renderer_flushed(app, renderer.label, window_id, generation);
    Ok(())
}

/// Reply from the opener renderer to a forwarded Preferences startup command.
/// Only the targeted window's claimed renderer can settle its own request.
#[tauri::command]
pub fn client_state_startup_command_result(
    renderer: Renderer,
    state: State<'_, ClientState>,
    access_token: String,
    id: u64,
    state_result: Option<super::StartupStateSnapshot>,
) -> Result<(), String> {
    let (window_id, _) = validate_access(&renderer, &state, &access_token)?;
    state
        .startup_commands
        .complete(id, &window_id, state_result)
}

#[tauri::command]
pub fn client_state_navigation_flushed(
    renderer: Renderer,
    state: State<'_, ClientState>,
    access_token: String,
    generation: u64,
) -> Result<(), String> {
    let (window_id, _) = validate_access(&renderer, &state, &access_token)?;
    state.acknowledge_renderer_flush(&window_id, generation);
    Ok(())
}
