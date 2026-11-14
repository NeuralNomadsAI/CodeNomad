use super::{PreferencesWindow, LABEL};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub(super) struct SelectionCommands(Mutex<HashMap<String, (String, mpsc::Sender<bool>)>>);
impl SelectionCommands {
    fn begin(&self, owner: &str) -> Result<(String, mpsc::Receiver<bool>), String> {
        let mut pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if pending.len() >= 32 {
            return Err("Too many pending server selections".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel();
        pending.insert(id.clone(), (owner.into(), sender));
        Ok((id, receiver))
    }
    fn complete(&self, id: &str, owner: &str, ok: bool) -> Result<(), String> {
        let mut pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((target, _)) = pending.get(id) {
            if target != owner {
                return Err("Server selection has another owner".into());
            }
            if let Some((_, sender)) = pending.remove(id) {
                let _ = sender.send(ok);
            }
        }
        Ok(())
    }
    fn forget(&self, id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }
}
fn accepted(receiver: mpsc::Receiver<bool>, timeout: Duration) -> Result<(), String> {
    match receiver.recv_timeout(timeout) {
        Ok(true) => Ok(()),
        Ok(false) => Err("Server selection refused".into()),
        Err(_) => Err("Server selection result unavailable".into()),
    }
}

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
pub(crate) async fn preferences_select_server(
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
    let (id, receiver) = preferences.selection.begin(&label)?;
    let request_id = serde_json::to_string(&id).map_err(|e| e.to_string())?;
    let sent = target.eval(&format!(r#"
        Promise.resolve().then(() => {{
            if (window.location.origin !== {origin} || typeof window.__CODENOMAD_SELECT_SERVER__ !== 'function')
                throw new Error("Server selection unavailable");
            return window.__CODENOMAD_SELECT_SERVER__({value});
        }}).then(() => true, () => false).then(ok =>
            window.__TAURI__.core.invoke("server_selection_result", {{ id: {request_id}, ok }})
        ).catch(() => {{}});
    "#));
    let result = match sent {
        Err(error) => Err(error.to_string()),
        Ok(()) => {
            tauri::async_runtime::spawn_blocking(move || accepted(receiver, Duration::from_secs(5)))
                .await
                .map_err(|e| e.to_string())
                .and_then(|result| result)
        }
    };
    preferences.selection.forget(&id);
    result?;
    target.show().map_err(|e| e.to_string())?;
    target.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn server_selection_result(
    webview: tauri::Webview,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
    id: String,
    ok: bool,
) -> Result<(), String> {
    crate::require_local_app_webview(&webview, &app_state)?;
    if id.len() != 36 {
        return Err("Invalid server selection result".into());
    }
    preferences.selection.complete(&id, webview.label(), ok)
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
    #[test]
    fn results_are_correlated_to_the_exact_opener_and_acceptance() {
        let commands = SelectionCommands::default();
        let (a, reply_a) = commands.begin("window-a").unwrap();
        let (b, reply_b) = commands.begin("window-b").unwrap();
        assert_ne!(a, b);
        assert!(commands.complete(&a, "window-b", true).is_err());
        assert_eq!(reply_a.try_recv(), Err(mpsc::TryRecvError::Empty));
        commands.complete(&b, "window-b", false).unwrap();
        assert_eq!(
            accepted(reply_b, Duration::ZERO),
            Err("Server selection refused".into())
        );
        commands.complete(&a, "window-a", true).unwrap();
        assert!(accepted(reply_a, Duration::ZERO).is_ok());
        commands.complete(&a, "window-a", false).unwrap();
        assert!(commands.0.lock().unwrap().is_empty());
    }
    #[test]
    fn missing_replies_expire_and_late_results_cannot_settle_another_selection() {
        let commands = SelectionCommands::default();
        let (expired, reply) = commands.begin("window-a").unwrap();
        assert_eq!(
            accepted(reply, Duration::from_millis(5)),
            Err("Server selection result unavailable".into())
        );
        commands.forget(&expired);
        let (next, reply) = commands.begin("window-a").unwrap();
        commands.complete(&expired, "window-a", true).unwrap();
        assert_eq!(reply.try_recv(), Err(mpsc::TryRecvError::Empty));
        commands.complete(&next, "window-a", false).unwrap();
        assert_eq!(
            accepted(reply, Duration::ZERO),
            Err("Server selection refused".into())
        );
        let main = include_str!("../../capabilities/main-window.json");
        let preferences = include_str!("../../capabilities/preferences-window.json");
        assert!(main.contains("allow-server-selection-result"));
        assert!(!preferences.contains("allow-server-selection-result"));
    }
}
