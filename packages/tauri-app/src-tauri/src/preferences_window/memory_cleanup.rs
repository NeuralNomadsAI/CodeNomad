use super::{PreferencesRequest, PreferencesWindow, LABEL};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CleanupRequest {
    id: String,
    scope: String,
    workspace_id: String,
    directory: String,
}
impl CleanupRequest {
    fn validate(&self, context: &PreferencesRequest) -> Result<(), String> {
        let bounded = |value: &str, limit| {
            !value.is_empty()
                && value.chars().count() <= limit
                && !value.chars().any(|c| c <= '\u{1f}')
        };
        if !bounded(&self.id, 128)
            || !bounded(&self.workspace_id, 128)
            || !bounded(&self.directory, 32768)
            || !matches!(self.scope.as_str(), "global" | "project")
            || context.section != "general"
            || context.instance_id.as_deref() != Some(&self.workspace_id)
            || context
                .location
                .as_ref()
                .map(|location| location.directory.as_str())
                != Some(&self.directory)
        {
            return Err("Memory cleanup context changed".into());
        }
        Ok(())
    }
}
struct PendingCleanup {
    owner: String,
    request: CleanupRequest,
    reply: mpsc::Sender<bool>,
    claimed: bool,
}
type Pending = HashMap<String, PendingCleanup>;
#[derive(Default)]
pub(super) struct CleanupCommands(Mutex<Pending>);
impl CleanupCommands {
    fn claim(&self, id: &str, window_id: &str) -> Result<Option<CleanupRequest>, String> {
        let mut pending = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let Some(entry) = pending.get_mut(id) else {
            return Ok(None);
        };
        if entry.owner != window_id {
            return Err("Cleanup intent has another owner".into());
        }
        if entry.claimed {
            return Ok(None);
        }
        entry.claimed = true;
        Ok(Some(entry.request.clone()))
    }
    fn complete(&self, id: &str, window_id: &str, ok: bool) -> Result<(), String> {
        let mut pending = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(entry) = pending.get(id) {
            if entry.owner != window_id {
                return Err("Cleanup reply has another owner".into());
            }
            if let Some(entry) = pending.remove(id) {
                let _ = entry.reply.send(ok);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupEvent {
    window_id: String,
    request: CleanupRequest,
}

#[tauri::command]
pub(crate) async fn preferences_memory_cleanup(
    webview: tauri::Webview,
    app: AppHandle,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
    request: CleanupRequest,
) -> Result<(), String> {
    crate::require_preferences_or_local_app_webview(&webview, &app_state)?;
    if webview.label() != LABEL {
        return Err("Cleanup requires Preferences".into());
    }
    let label = {
        let state = preferences
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        request.validate(&state.request)?;
        state
            .opener
            .label
            .clone()
            .ok_or("Cleanup opener unavailable")?
    };
    let window_id = crate::identity::local_window_id(&label)?;
    let target = app
        .get_webview_window(&label)
        .ok_or("Cleanup opener unavailable")?;
    crate::require_local_app_webview(
        &app.get_webview(&label)
            .ok_or("Cleanup opener unavailable")?,
        &app_state,
    )?;
    let (sender, receiver) = mpsc::channel();
    {
        let mut pending = preferences
            .cleanup
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending.contains_key(&request.id) {
            return Err("Cleanup already pending".into());
        }
        pending.insert(
            request.id.clone(),
            PendingCleanup {
                owner: window_id.clone(),
                request: request.clone(),
                reply: sender,
                claimed: false,
            },
        );
    }
    let id = request.id.clone();
    let sent = app.emit_to(
        &label,
        "memory:cleanup",
        CleanupEvent { window_id, request },
    );
    let result = if let Err(error) = sent {
        Err(error.to_string())
    } else {
        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(30)))
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result.map_err(|_| "Cleanup result uncertain".to_string()))
    };
    preferences
        .cleanup
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&id);
    match result {
        Ok(true) => {
            let _ = target.show();
            let _ = target.set_focus();
            Ok(())
        }
        _ => Err(
            "Cleanup result uncertain; inspect the project sessions before another attempt".into(),
        ),
    }
}

#[tauri::command]
pub(crate) fn memory_cleanup_claim(
    webview: tauri::Webview,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
    id: String,
) -> Result<Option<CleanupRequest>, String> {
    crate::require_local_app_webview(&webview, &app_state)?;
    let window_id = crate::identity::local_window_id(webview.label())?;
    preferences.cleanup.claim(&id, &window_id)
}

#[tauri::command]
pub(crate) fn memory_cleanup_result(
    webview: tauri::Webview,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
    id: String,
    ok: bool,
) -> Result<(), String> {
    crate::require_local_app_webview(&webview, &app_state)?;
    let window_id = crate::identity::local_window_id(webview.label())?;
    preferences.cleanup.complete(&id, &window_id, ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_intent_requires_exact_preferences_context() {
        let request: CleanupRequest = serde_json::from_str(
            r#"{"id":"one","scope":"global","workspaceId":"a","directory":"/repo"}"#,
        )
        .unwrap();
        let mut context = PreferencesRequest {
            section: "general".into(),
            scroll_top: None,
            instance_id: Some("a".into()),
            workspace_path: None,
            location: Some(super::super::PreferencesLocation {
                directory: "/repo".into(),
                workspace_id: None,
            }),
        };
        assert!(request.validate(&context).is_ok());
        context.instance_id = Some("b".into());
        assert!(request.validate(&context).is_err());
        assert!(serde_json::from_str::<CleanupRequest>(
            r#"{"id":"one","scope":"global","workspaceId":"a","directory":"/repo","prompt":"run"}"#
        )
        .is_err());
    }
    #[test]
    fn only_the_targeted_local_window_can_settle_cleanup_once() {
        let commands = CleanupCommands::default();
        let (sender, receiver) = mpsc::channel();
        commands.0.lock().unwrap().insert(
            "one".into(),
            PendingCleanup {
                owner: "window-a".into(),
                request: CleanupRequest {
                    id: "one".into(),
                    scope: "global".into(),
                    workspace_id: "a".into(),
                    directory: "/repo".into(),
                },
                reply: sender,
                claimed: false,
            },
        );
        assert!(commands.claim("one", "window-b").is_err());
        assert!(commands.claim("forged", "window-a").unwrap().is_none());
        let claimed = commands.claim("one", "window-a").unwrap().unwrap();
        assert_eq!(claimed.directory, "/repo");
        assert!(commands.claim("one", "window-a").unwrap().is_none());
        assert!(commands.complete("one", "window-b", true).is_err());
        assert!(receiver.try_recv().is_err());
        commands.complete("one", "window-a", true).unwrap();
        assert_eq!(receiver.try_recv().unwrap(), true);
        commands.complete("one", "window-a", false).unwrap();
    }
    #[test]
    fn capabilities_separate_preferences_admission_from_local_reply() {
        let preferences = include_str!("../../capabilities/preferences-window.json");
        let local = include_str!("../../capabilities/main-window.json");
        assert!(preferences.contains("allow-preferences-memory-cleanup"));
        assert!(!preferences.contains("allow-memory-cleanup-result"));
        assert!(!local.contains("allow-preferences-memory-cleanup"));
        assert!(local.contains("allow-memory-cleanup-result"));
        assert!(local.contains("allow-memory-cleanup-claim"));
        assert!(!preferences.contains("allow-memory-cleanup-claim"));
    }
}
