use super::{PreferencesWindow, LABEL};
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServerSelection {
    id: String,
    base_url: String,
    skip_tls_verify: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    ssh: Option<SshTarget>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SshTarget {
    host: String,
}

impl ServerSelection {
    fn validate(&self) -> Result<(), String> {
        let url = url::Url::parse(&self.base_url).map_err(|_| "Invalid server selection")?;
        if self.id.is_empty()
            || self.id.len() > 64
            || self.id == "local"
            || !self
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || self.base_url.len() > 4096
            || !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || self.ssh.as_ref().is_some_and(|ssh| {
                ssh.host.is_empty()
                    || ssh.host.len() > 256
                    || ssh
                        .host
                        .chars()
                        .any(|c| c.is_whitespace() || c.is_control())
            })
        {
            return Err("Invalid server selection".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn preferences_select_server(
    webview: tauri::Webview,
    app: AppHandle,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
    intent: ServerSelection,
) -> Result<(), String> {
    crate::require_preferences_or_local_app_webview(&webview, &app_state)?;
    if webview.label() != LABEL {
        return Err("Server selection requires Preferences".into());
    }
    intent.validate()?;
    let label = {
        let state = preferences.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.request.section != "servers" {
            return Err("Server selection context changed".into());
        }
        state
            .opener
            .label
            .clone()
            .ok_or("Server selection opener unavailable")?
    };
    let target = app
        .get_webview_window(&label)
        .ok_or("Server selection opener unavailable")?;
    crate::require_local_app_webview(
        &app.get_webview(&label)
            .ok_or("Server selection opener unavailable")?,
        &app_state,
    )?;
    let origin = serde_json::to_string(
        &target
            .url()
            .map_err(|e| e.to_string())?
            .origin()
            .ascii_serialization(),
    )
    .map_err(|e| e.to_string())?;
    let value = serde_json::to_string(&intent).map_err(|e| e.to_string())?;
    target.eval(&format!("if(window.location.origin === {origin} && typeof window.__CODENOMAD_SELECT_SERVER__ === 'function') window.__CODENOMAD_SELECT_SERVER__({value});")).map_err(|e| e.to_string())?;
    target.show().map_err(|e| e.to_string())?;
    target.set_focus().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_saved_policy_only() {
        for value in [
            r#"{"id":"a","baseUrl":"https://a.test","skipTlsVerify":false}"#,
            r#"{"id":"a","baseUrl":"http://localhost:3000","skipTlsVerify":true,"ssh":{"host":"my-vm"}}"#,
        ] {
            assert!(serde_json::from_str::<ServerSelection>(value)
                .unwrap()
                .validate()
                .is_ok());
        }
        for value in [
            r#"{"id":"local","baseUrl":"https://a.test","skipTlsVerify":false}"#,
            r#"{"id":"a","baseUrl":"https://user:pass@a.test","skipTlsVerify":false}"#,
            r#"{"id":"a","baseUrl":"https://a.test/?token=x","skipTlsVerify":false}"#,
            r#"{"id":"a","baseUrl":"https://a.test","skipTlsVerify":false,"ssh":{"host":"-o ProxyCommand=x"}}"#,
        ] {
            assert!(serde_json::from_str::<ServerSelection>(value)
                .unwrap()
                .validate()
                .is_err());
        }
        assert!(serde_json::from_str::<ServerSelection>(
            r#"{"id":"a","baseUrl":"https://a.test","skipTlsVerify":false,"password":"secret"}"#
        )
        .is_err());
        let capabilities = include_str!("../../capabilities/preferences-window.json");
        assert!(capabilities.contains("allow-preferences-select-server"));
        assert!(!include_str!("../../capabilities/main-window.json")
            .contains("allow-preferences-select-server"));
    }
}
