use super::{opener_or_recent, PreferencesWindow, LABEL};
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

fn selection_target(
    section: &str,
    action: Option<&str>,
    opener: Option<String>,
    is_live: impl Fn(&str) -> bool,
    recent: impl FnOnce() -> Option<String>,
) -> Result<String, String> {
    let target = match action {
        None if section == "servers" => opener.filter(|label| is_live(label)),
        Some("remove") if matches!(section, "servers" | "remote") => {
            opener_or_recent(opener, is_live, recent)
        }
        _ => return Err("Server selection context changed".into()),
    };
    target.ok_or_else(|| "Server selection opener unavailable".into())
}

#[tauri::command]
pub(crate) async fn preferences_select_server(
    webview: tauri::Webview,
    app: AppHandle,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
    intent: ServerSelection,
    action: Option<String>,
) -> Result<(), String> {
    crate::require_preferences_or_local_app_webview(&webview, &app_state)?;
    if webview.label() != LABEL {
        return Err("Server selection requires Preferences".into());
    }
    intent.validate()?;
    let (section, opener) = {
        let state = preferences.state.lock().unwrap_or_else(|e| e.into_inner());
        (state.request.section.clone(), state.opener.label.clone())
    };
    let label = selection_target(
        &section,
        action.as_deref(),
        opener,
        // A main window hosting an embedded preview still has its primary webview.
        |label| app.get_webview(label).is_some(),
        || {
            app.state::<crate::local_windows::LocalWindows>()
                .mru_label()
        },
    )?;
    let target = app
        .get_webview(&label)
        .ok_or("Server selection opener unavailable")?;
    let url = crate::require_local_app_webview(&target, &app_state)?;
    let origin =
        serde_json::to_string(&url.origin().ascii_serialization()).map_err(|e| e.to_string())?;
    let value = serde_json::to_string(&intent).map_err(|e| e.to_string())?;
    let action = serde_json::to_string(&action).map_err(|e| e.to_string())?;
    let (id, receiver) = preferences.selection.begin(&label)?;
    let request_id = serde_json::to_string(&id).map_err(|e| e.to_string())?;
    let sent = target.eval(&format!(r#"
        Promise.resolve().then(() => {{
            if (window.location.origin !== {origin} || typeof window.__CODENOMAD_SELECT_SERVER__ !== 'function')
                throw new Error("Server selection unavailable");
            return window.__CODENOMAD_SELECT_SERVER__({value}, {action});
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
    let window = target.window();
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
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
    fn removal_targets_the_live_opener_or_the_most_recent_local_window() {
        let target = |section, action, opener: Option<&str>, recent: Option<&str>| {
            selection_target(
                section,
                action,
                opener.map(str::to_owned),
                |label| matches!(label, "opener" | "recent"),
                || recent.map(str::to_owned),
            )
        };
        let remove = Some("remove");
        assert_eq!(
            target("servers", remove, Some("opener"), Some("recent")).unwrap(),
            "opener"
        );
        assert_eq!(
            target("servers", remove, Some("closed"), Some("recent")).unwrap(),
            "recent"
        );
        assert_eq!(
            target("remote", remove, None, Some("recent")).unwrap(),
            "recent"
        );
        assert!(target("servers", remove, None, Some("closed")).is_err());
        assert!(target("servers", None, Some("closed"), Some("recent")).is_err());
        assert!(target("general", remove, Some("opener"), Some("recent")).is_err());
    }

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
        let main = include_str!("../../capabilities/main-window.json");
        let preferences = include_str!("../../capabilities/preferences-window.json");
        assert!(preferences.contains("allow-preferences-select-server"));
        assert!(!main.contains("allow-preferences-select-server"));
        assert!(main.contains("allow-server-selection-result"));
        assert!(!preferences.contains("allow-server-selection-result"));
    }

    #[test]
    fn selection_results_bind_to_the_exact_opener_and_expire() {
        let commands = SelectionCommands::default();
        let (expired, reply) = commands.begin("window-a").unwrap();
        let (b, reply_b) = commands.begin("window-b").unwrap();
        assert_ne!(expired, b);
        assert!(commands.complete(&expired, "window-b", true).is_err());
        assert_eq!(reply.try_recv(), Err(mpsc::TryRecvError::Empty));
        commands.complete(&b, "window-b", false).unwrap();
        assert_eq!(
            accepted(reply_b, Duration::ZERO),
            Err("Server selection refused".into())
        );
        assert_eq!(
            accepted(reply, Duration::ZERO),
            Err("Server selection result unavailable".into())
        );
        commands.forget(&expired);
        let (next, reply_next) = commands.begin("window-a").unwrap();
        commands.complete(&expired, "window-a", true).unwrap();
        assert_eq!(reply_next.try_recv(), Err(mpsc::TryRecvError::Empty));
        commands.complete(&next, "window-a", true).unwrap();
        assert!(accepted(reply_next, Duration::ZERO).is_ok());
        commands.complete(&next, "window-a", false).unwrap();
        assert!(commands.0.lock().unwrap().is_empty());
    }
}
