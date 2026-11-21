use parking_lot::Mutex;
use std::{collections::VecDeque, sync::Arc};
use tauri::{AppHandle, Manager, Webview};
#[cfg(target_os = "macos")]
use tauri_plugin_notification::NotificationExt;
use uuid::Uuid;

#[cfg(target_os = "linux")]
#[path = "notification_click_linux.rs"]
mod linux;
#[cfg(windows)]
#[path = "notification_click_windows.rs"]
pub(crate) mod windows;

const MAX_NOTICES: usize = 256;

#[derive(Default)]
pub(crate) struct NotificationClicks {
    pending: Mutex<VecDeque<(Uuid, Target)>>,
    #[cfg(target_os = "linux")]
    linux: linux::LinuxNotifications,
}

struct Target {
    label: String,
    url: url::Url,
    action: Option<Uuid>,
    #[cfg(windows)]
    toast: Option<windows::Toast>,
}

impl NotificationClicks {
    fn remember(&self, target: Target) -> Uuid {
        let mut pending = self.pending.lock();
        if pending.len() >= MAX_NOTICES {
            pending.pop_front();
        }
        let id = Uuid::new_v4();
        pending.push_back((id, target));
        id
    }

    fn take(&self, id: Uuid) -> Option<Target> {
        let mut pending = self.pending.lock();
        let index = pending.iter().position(|(key, _)| *key == id)?;
        pending.remove(index).map(|(_, target)| target)
    }

    pub(crate) fn forget_window(&self, label: &str) {
        self.pending
            .lock()
            .retain(|(_, target)| target.label != label);
    }

    #[cfg(windows)]
    fn retain_toast(&self, id: Uuid, toast: windows::Toast) {
        if let Some((_, target)) = self.pending.lock().iter_mut().find(|(key, _)| *key == id) {
            target.toast = Some(toast);
        }
    }
}

fn sender_url(webview: &Webview) -> Result<url::Url, String> {
    let app = webview.app_handle();
    if webview.label() == crate::preferences_window::LABEL
        && webview.window().label() == webview.label()
    {
        crate::require_preferences_or_local_app_webview(webview, &app.state::<crate::AppState>())
    } else {
        crate::notification_badge::require_owner(webview, app)
    }
}

fn action_id(value: &str) -> Option<Uuid> {
    let id = Uuid::parse_str(value).ok()?;
    (id.hyphenated().to_string() == value).then_some(id)
}

fn clicked(app: &AppHandle, id: Uuid, _activation_token: Option<String>) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(target) = app.state::<NotificationClicks>().take(id) else {
            return;
        };
        let Some(webview) = app.get_webview(&target.label) else {
            return;
        };
        if sender_url(&webview).ok().as_ref() != Some(&target.url) {
            return;
        }
        #[cfg(target_os = "linux")]
        let native_focus = linux::focus_with_token(&webview, _activation_token.as_deref());
        #[cfg(not(target_os = "linux"))]
        let native_focus = false;
        if !native_focus {
            crate::local_windows::focus(&app, &target.label);
        }
        if let Some(action) = target.action {
            // Only the sending webview receives the event. The UUID is data, never a URL or script.
            let _ = webview.eval(format!(
                r#"window.dispatchEvent(new CustomEvent("codenomad:notification-click", {{detail:"{action}"}}))"#
            ));
        }
    });
}

pub(crate) fn install(host: &Arc<AppHandle>) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::install(&host.config().identifier, Arc::downgrade(host))
    }
    #[cfg(target_os = "linux")]
    {
        *host.state::<NotificationClicks>().linux.host.lock() = Arc::downgrade(host);
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        // Notification Center knows the bundle ID, not the scoped Tauri configuration ID.
        if std::env::current_exe().ok().is_some_and(|path| {
            path.ancestors().any(|parent| parent.extension().is_some_and(|ext| ext == "app"))
        }) {
            let _ = notify_rust::set_application(crate::identity::STABLE_IDENTIFIER);
        }
        let weak_host = Arc::downgrade(host);
        host.notification()
            .on_action(move |event| {
                if event.action_id() != "tap" {
                    return;
                }
                let id = event
                    .notification()
                    .and_then(|notice| notice.extra().get("codenomadClick"))
                    .and_then(serde_json::Value::as_str)
                    .and_then(action_id);
                if let (Some(app), Some(id)) = (weak_host.upgrade(), id) {
                    clicked(&app, id, None);
                }
            })
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub(crate) fn notification_show(
    webview: Webview,
    title: String,
    body: String,
    action_id: Option<String>,
) -> Result<(), String> {
    let app = webview.app_handle();
    let url = sender_url(&webview)?;
    let action = action_id
        .as_deref()
        .map(|value| self::action_id(value).ok_or("Invalid notification action"))
        .transpose()?;
    let routes = app.state::<NotificationClicks>();
    let id = routes.remember(Target {
        label: webview.label().into(),
        url,
        action,
        #[cfg(windows)]
        toast: None,
    });
    #[cfg(windows)]
    let result = windows::show(app, id, &title, &body).map(|toast| routes.retain_toast(id, toast));
    #[cfg(target_os = "macos")]
    let result = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .extra("codenomadClick", id.to_string())
        .show();
    #[cfg(target_os = "linux")]
    let result = linux::show(&routes.linux, id, title, body);
    result.map_err(|error| {
        routes.take(id);
        error.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicks_route_once_to_the_sending_document_and_expire_on_navigation() {
        let routes = NotificationClicks::default();
        let target = |label: &str, action| Target {
            label: label.into(),
            url: "https://app.test".parse().unwrap(),
            action,
            #[cfg(windows)]
            toast: None,
        };
        let action = Uuid::new_v4();
        let first = routes.remember(target("local-a", None));
        let second = routes.remember(target("remote-b", Some(action)));
        assert!(routes.take(Uuid::new_v4()).is_none());
        routes.forget_window("local-a");
        assert!(routes.take(first).is_none());
        let received = routes.take(second).unwrap();
        assert_eq!(received.label, "remote-b");
        assert_eq!(received.action, Some(action));
        assert!(routes.take(second).is_none());
    }

    #[test]
    fn accepts_only_canonical_uuid_actions() {
        let id = Uuid::new_v4();
        assert_eq!(action_id(&id.to_string()), Some(id));
        assert_eq!(action_id(&id.simple().to_string()), None);
        assert_eq!(action_id("https://app.test/session"), None);
    }
}
