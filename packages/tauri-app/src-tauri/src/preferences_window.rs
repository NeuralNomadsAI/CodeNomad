use crate::{
    cli_manager::{local_session_cookie, LocalCliAccess},
    AppState,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

pub(crate) const LABEL: &str = "preferences";
pub(crate) const SECTION_EVENT: &str = "preferences:section";
const DEFAULT_SECTION: &str = "general";
const CONTEXT_SCRIPT: &str = "window.__CODENOMAD_RUNTIME_HOST__ = 'tauri'; window.__CODENOMAD_WINDOW_CONTEXT__ = 'preferences';";

const SECTIONS: &[&str] = &[
    "general",
    "chat",
    "notifications",
    "speech",
    "remote",
    "opencode",
    "providers",
    "sidecars",
    "config-files",
    "advanced",
    "info",
];

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreferencesLocation {
    pub(crate) directory: String,
    #[serde(rename = "workspaceID", skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreferencesRequest {
    pub(crate) section: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) location: Option<PreferencesLocation>,
}

#[derive(Debug)]
struct PreferencesState {
    request: PreferencesRequest,
    renderer_ready: bool,
    close_approved: bool,
    transition_id: u64,
    pending_transition: Option<(u64, PreferencesTransition)>,
    trusted_origins: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PreferencesTransition {
    Loading,
    Backend,
}

#[derive(Clone, Serialize)]
struct PreferencesTransitionRequest {
    id: u64,
}

pub(crate) struct PreferencesWindow {
    operation: Mutex<()>,
    state: Mutex<PreferencesState>,
}

impl Default for PreferencesWindow {
    fn default() -> Self {
        Self {
            operation: Mutex::new(()),
            state: Mutex::new(PreferencesState {
                request: PreferencesRequest {
                    section: DEFAULT_SECTION.to_string(),
                    instance_id: None,
                    location: None,
                },
                renderer_ready: false,
                close_approved: false,
                transition_id: 0,
                pending_transition: None,
                trusted_origins: Vec::new(),
            }),
        }
    }
}

impl PreferencesWindow {
    fn set_request(&self, request: PreferencesRequest) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.request = request;
        state.close_approved = false;
    }

    fn request(&self) -> PreferencesRequest {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .request
            .clone()
    }
}

fn validate_section(section: &str) -> Result<(), String> {
    SECTIONS
        .contains(&section)
        .then_some(())
        .ok_or_else(|| "Invalid preferences section".to_string())
}

pub(crate) fn validate_request(request: PreferencesRequest) -> Result<PreferencesRequest, String> {
    validate_section(&request.section)?;
    if request
        .instance_id
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > 512)
    {
        return Err("Invalid Preferences instance ID".to_string());
    }
    if let Some(location) = &request.location {
        if location.directory.is_empty() || location.directory.len() > 32768 {
            return Err("Invalid Preferences directory".to_string());
        }
        if location
            .workspace_id
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 512)
        {
            return Err("Invalid Preferences workspace ID".to_string());
        }
    }
    Ok(request)
}

fn target_url(base_url: &str, section: &str) -> Result<Url, String> {
    let mut target = Url::parse(base_url).map_err(|error| error.to_string())?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err("Preferences backend URL must use HTTP or HTTPS".to_string());
    }
    target.query_pairs_mut().append_pair("preferences", section);
    Ok(target)
}

fn focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn navigate_authenticated(
    window: &tauri::WebviewWindow,
    access: &LocalCliAccess,
    section: &str,
) -> Result<(), String> {
    let origin = Url::parse(&access.base_url)
        .map_err(|error| error.to_string())?
        .origin()
        .ascii_serialization();
    let preferences = window.app_handle().state::<PreferencesWindow>();
    let mut state = preferences
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    state
        .trusted_origins
        .retain(|candidate| candidate != &origin);
    state.trusted_origins.push(origin);
    if state.trusted_origins.len() > 2 {
        state.trusted_origins.remove(0);
    }
    drop(state);
    window
        .set_cookie(
            local_session_cookie(
                &access.base_url,
                &access.cookie_name,
                &access.session_cookie,
            )
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    window
        .navigate(target_url(&access.base_url, section)?)
        .map_err(|error| error.to_string())
}

pub(crate) fn is_trusted_renderer_origin(window: &tauri::WebviewWindow, url: &Url) -> bool {
    window
        .app_handle()
        .state::<PreferencesWindow>()
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .trusted_origins
        .contains(&url.origin().ascii_serialization())
}

#[tauri::command]
pub(crate) async fn open_preferences_window(
    window: tauri::WebviewWindow,
    app: AppHandle,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
    request: PreferencesRequest,
    toggle: Option<bool>,
) -> Result<(), String> {
    crate::require_local_app_window(&window, &app_state)?;
    open_preferences(
        &app,
        &app_state,
        &preferences,
        request,
        toggle.unwrap_or(false),
    )
}

fn open_preferences(
    app: &AppHandle,
    app_state: &AppState,
    preferences: &PreferencesWindow,
    request: PreferencesRequest,
    toggle: bool,
) -> Result<(), String> {
    let request = validate_request(request)?;
    let _operation = preferences
        .operation
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(existing) = app.get_webview_window(LABEL) {
        if toggle {
            existing.close().map_err(|error| error.to_string())?;
            return Ok(());
        }
        app.state::<crate::client_state::ClientState>()
            .set_preferences(Some(request.clone()))?;
        let renderer_ready = preferences
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .renderer_ready;
        if !renderer_ready {
            preferences.set_request(request.clone());
        }
        if existing.emit(SECTION_EVENT, &request).is_ok() && focus(&existing).is_ok() {
            return Ok(());
        }
        let _ = existing.destroy();
    }

    let access = app_state
        .manager
        .local_cli_access()
        .ok_or("Local CodeNomad server is unavailable")?;
    suspend_guard(app);
    preferences.set_request(request.clone());
    let data_directory = app_state.webview_data_directory.join("local");
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("loading.html".into()))
        .data_directory(data_directory)
        .initialization_script(CONTEXT_SCRIPT);
    #[cfg(windows)]
    let developer_browser_arguments = app_state.developer_browser_arguments.clone();
    #[cfg(windows)]
    let builder = if let Some(arguments) = developer_browser_arguments.as_deref() {
        builder.additional_browser_args(arguments)
    } else {
        builder
    };
    #[cfg(target_os = "macos")]
    let builder = if app_state.scoped_profile {
        builder.data_store_identifier(crate::profile_identifier("local"))
    } else {
        builder
    };
    let preferences_window = builder
        .title("Preferences")
        .inner_size(1100.0, 760.0)
        .min_inner_size(760.0, 560.0)
        .resizable(true)
        .fullscreen(false)
        .decorations(false)
        .background_color(tauri::window::Color(26, 26, 26, 255))
        .zoom_hotkeys_enabled(true)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = preferences_window.hide_menu();

    if let Err(error) = navigate_authenticated(&preferences_window, &access, &request.section) {
        let _ = preferences_window.destroy();
        return Err(error);
    }
    #[cfg(windows)]
    if let Err(error) = crate::shutdown::schedule_windows_session_end_handler(&preferences_window) {
        let _ = preferences_window.destroy();
        return Err(error);
    }
    if let Err(error) = focus(&preferences_window) {
        let _ = preferences_window.destroy();
        return Err(error);
    }
    if let Err(error) = app
        .state::<crate::client_state::ClientState>()
        .set_preferences(Some(request))
    {
        let _ = preferences_window.destroy();
        return Err(error);
    }
    Ok(())
}

pub(crate) fn navigate_backend(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_none() {
        if let Some(request) = app
            .try_state::<crate::client_state::ClientState>()
            .and_then(|state| state.preferences())
        {
            let app_state = app.state::<AppState>();
            let preferences = app.state::<PreferencesWindow>();
            if let Err(error) = open_preferences(app, &app_state, &preferences, request, false) {
                eprintln!("[tauri] failed to restore preferences window: {error}");
            }
        }
        return;
    }
    if request_transition(app, PreferencesTransition::Backend) {
        return;
    }
    navigate_backend_now(app);
}

fn navigate_backend_now(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let Some(access) = app.state::<AppState>().manager.local_cli_access() else {
        return;
    };
    let preferences = app.state::<PreferencesWindow>();
    let _operation = preferences
        .operation
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let request = preferences.request();
    if let Err(error) = navigate_authenticated(&window, &access, &request.section) {
        eprintln!("[tauri] failed to navigate preferences window: {error}");
    }
}

pub(crate) fn emit_section(app: &AppHandle) {
    let request = app.state::<PreferencesWindow>().request();
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.emit(SECTION_EVENT, request);
    }
}

#[tauri::command]
pub(crate) fn preferences_window_ready(
    window: tauri::WebviewWindow,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
) -> Result<(), String> {
    crate::require_preferences_or_local_app_window(&window, &app_state)?;
    if window.label() != LABEL {
        return Err("Preferences readiness requires the Preferences window".to_string());
    }
    preferences
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .renderer_ready = true;
    Ok(())
}

#[tauri::command]
pub(crate) fn preferences_get_request(
    window: tauri::WebviewWindow,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
) -> Result<PreferencesRequest, String> {
    crate::require_preferences_or_local_app_window(&window, &app_state)?;
    if window.label() != LABEL {
        return Err("Preferences request access requires the Preferences window".to_string());
    }
    Ok(preferences.request())
}

#[tauri::command]
pub(crate) fn preferences_accept_request(
    window: tauri::WebviewWindow,
    app: AppHandle,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
    request: PreferencesRequest,
) -> Result<(), String> {
    crate::require_preferences_or_local_app_window(&window, &app_state)?;
    if window.label() != LABEL {
        return Err("Preferences request acceptance requires the Preferences window".to_string());
    }
    let request = validate_request(request)?;
    app.state::<crate::client_state::ClientState>()
        .set_preferences(Some(request.clone()))?;
    preferences.set_request(request);
    Ok(())
}

#[tauri::command]
pub(crate) fn preferences_resolve_transition(
    window: tauri::WebviewWindow,
    app: AppHandle,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
    id: u64,
    approved: bool,
) -> Result<(), String> {
    crate::require_preferences_or_local_app_window(&window, &app_state)?;
    if window.label() != LABEL {
        return Err("Preferences transition response requires the Preferences window".to_string());
    }
    let transition = {
        let mut state = preferences
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.pending_transition.as_ref().map(|pending| pending.0) != Some(id) {
            return Ok(());
        }
        state.pending_transition.take().map(|pending| pending.1)
    };
    if !approved {
        return Ok(());
    }
    match transition {
        Some(PreferencesTransition::Loading) => show_loading_now(&app),
        Some(PreferencesTransition::Backend) => {
            suspend_guard(&app);
            navigate_backend_now(&app);
        }
        None => {}
    }
    Ok(())
}

fn request_transition(app: &AppHandle, transition: PreferencesTransition) -> bool {
    let preferences = app.state::<PreferencesWindow>();
    let id = {
        let mut state = preferences
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !state.renderer_ready {
            return false;
        }
        if state
            .pending_transition
            .as_ref()
            .is_some_and(|pending| pending.1 == transition)
        {
            return true;
        }
        state.transition_id = state.transition_id.wrapping_add(1);
        let id = state.transition_id;
        state.pending_transition = Some((id, transition));
        id
    };
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.emit(
            "preferences:transition-requested",
            PreferencesTransitionRequest { id },
        );
    }
    true
}

pub(crate) fn suspend_guard(app: &AppHandle) {
    let preferences = app.state::<PreferencesWindow>();
    let mut state = preferences
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    state.renderer_ready = false;
    state.close_approved = false;
    state.pending_transition = None;
}

pub(crate) fn approve_close(app: &AppHandle) -> Result<(), String> {
    app.state::<crate::client_state::ClientState>()
        .set_preferences(None)?;
    app.state::<PreferencesWindow>()
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .close_approved = true;
    Ok(())
}

pub(crate) fn intercept_close(app: &AppHandle) -> bool {
    let preferences = app.state::<PreferencesWindow>();
    let mut state = preferences
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if std::mem::take(&mut state.close_approved) || !state.renderer_ready {
        return false;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.emit("preferences:close-requested", ());
    }
    true
}

pub(crate) fn show_loading(app: &AppHandle) {
    if request_transition(app, PreferencesTransition::Loading) {
        return;
    }
    show_loading_now(app);
}

fn show_loading_now(app: &AppHandle) {
    suspend_guard(app);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window
            .navigate(Url::parse("tauri://localhost/loading.html").expect("loading URL is valid"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_sections_and_builds_an_explicit_preferences_target() {
        assert!(validate_section("general").is_ok());
        assert!(validate_section("speech").is_ok());
        assert!(validate_section("workspace").is_err());

        let target = target_url("http://127.0.0.1:3000/", "chat").unwrap();
        assert_eq!(target.host_str(), Some("127.0.0.1"));
        assert!(target
            .query_pairs()
            .any(|(key, value)| key == "preferences" && value == "chat"));
        assert!(target_url("file:///tmp/preferences", "chat").is_err());
        let request = validate_request(PreferencesRequest {
            section: "providers".into(),
            instance_id: Some("workspace-1".into()),
            location: Some(PreferencesLocation {
                directory: "C:\\repo".into(),
                workspace_id: Some("worktree-1".into()),
            }),
        })
        .unwrap();
        assert_eq!(
            serde_json::to_value(request).unwrap()["location"]["workspaceID"],
            "worktree-1"
        );
    }

    #[test]
    fn shared_local_session_cookie_remains_http_only() {
        let cookie =
            local_session_cookie("http://127.0.0.1:3000", "codenomad_session_test", "secret")
                .unwrap();
        assert_eq!(cookie.domain(), Some("127.0.0.1"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(
            cookie.same_site(),
            Some(tauri::webview::cookie::SameSite::Lax)
        );
    }

    #[test]
    fn preferences_capability_is_exact_and_excludes_workspace_state_authority() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/preferences-window.json")).unwrap();
        assert_eq!(capability["windows"], json!([LABEL]));
        let permissions = capability["permissions"].as_array().unwrap();
        for excluded in [
            "client-state",
            "desktop-launch",
            "open-workspace-target",
            "set-workspace-menu-enabled",
            "wake-lock",
            "developer-",
        ] {
            assert!(!permissions.iter().any(|permission| permission
                .as_str()
                .is_some_and(|value| value.contains(excluded))));
        }
        for required in [
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "allow-preferences-window-ready",
            "allow-window-control",
        ] {
            assert!(permissions.contains(&json!(required)));
        }

        let local: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main-window.json")).unwrap();
        assert!(local["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("allow-open-preferences-window")));
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(config["app"]["security"]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("preferences-window")));
    }

    #[test]
    fn preferences_context_is_not_a_local_window_context() {
        assert_eq!(LABEL, "preferences");
        assert!(!LABEL.starts_with("local-"));
        assert!(CONTEXT_SCRIPT.contains("__CODENOMAD_WINDOW_CONTEXT__ = 'preferences'"));
    }
}
