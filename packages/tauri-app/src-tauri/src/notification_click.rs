use parking_lot::Mutex;
#[cfg(any(windows, target_os = "macos"))]
use std::sync::{OnceLock, Weak};
use std::{collections::VecDeque, sync::Arc};
use tauri::{AppHandle, Manager, Webview};
#[cfg(any(windows, target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;
use uuid::Uuid;

#[cfg(target_os = "linux")]
#[path = "notification_click_linux.rs"]
mod linux;
#[cfg(target_os = "macos")]
#[path = "notification_click_macos.rs"]
mod macos;
#[cfg(windows)]
#[path = "notification_click_windows.rs"]
mod windows;

const MAX_NOTICES: usize = 256;

#[cfg(any(test, target_os = "macos"))]
#[path = "notification_authorization.rs"]
mod authorization;

#[cfg(any(windows, target_os = "linux", test))]
fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(any(target_os = "linux", test))]
fn linux_body<'a>(body: &'a str, capabilities: &[String]) -> std::borrow::Cow<'a, str> {
    if capabilities.iter().any(|item| item == "body-markup") {
        std::borrow::Cow::Owned(escape_text(body))
    } else {
        std::borrow::Cow::Borrowed(body)
    }
}

#[derive(Default)]
pub(crate) struct NotificationClicks {
    pending: Mutex<VecDeque<(Uuid, Target)>>,
    #[cfg(any(windows, target_os = "macos"))]
    native_host: OnceLock<Weak<AppHandle>>,
    #[cfg(target_os = "linux")]
    linux: linux::LinuxNotifications,
    #[cfg(target_os = "macos")]
    macos: macos::Delivery,
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
        let native_focus = linux::focus(&webview, _activation_token.as_deref());
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

pub(crate) fn install(host: &Arc<AppHandle>) {
    let routes = host.state::<NotificationClicks>();
    #[cfg(windows)]
    if crate::set_windows_app_user_model_id(&host.config().identifier) {
        let _ = routes.native_host.set(Arc::downgrade(host));
    }
    #[cfg(target_os = "linux")]
    {
        let _ = routes.linux.host.set(Arc::downgrade(host));
    }
    #[cfg(target_os = "macos")]
    if macos::install(Arc::downgrade(host)) {
        let _ = routes.native_host.set(Arc::downgrade(host));
    }
}

#[tauri::command]
pub(crate) async fn notification_permission(
    webview: Webview,
    request: bool,
) -> Result<Option<&'static str>, String> {
    sender_url(&webview)?;
    #[cfg(target_os = "macos")]
    {
        let routes = webview.app_handle().state::<NotificationClicks>();
        if routes.native_host.get().is_some() {
            return routes.macos.permission(request).await.map(Some);
        }
    }
    let _ = request;
    Ok(None)
}

#[tauri::command(async)]
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
    #[cfg(any(windows, target_os = "macos"))]
    let Some(host) = routes.native_host.get() else {
        return app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string());
    };
    let target = Target {
        label: webview.label().into(),
        url,
        action,
        #[cfg(windows)]
        toast: None,
    };
    // Every notification remembers its window: a click without an action still restores it.
    let id = routes.remember(target);
    #[cfg(target_os = "macos")]
    {
        routes
            .macos
            .show(host, Some(id), title, body)
            .inspect_err(|_| {
                routes.take(id);
            })
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(windows)]
        let result = windows::show(&app.config().identifier, host, id, &title, &body)
            .map(|toast| routes.retain_toast(id, toast))
            .map_err(|error| error.to_string());
        #[cfg(target_os = "linux")]
        let result = linux::show(&routes.linux, id, title, body);
        result.inspect_err(|_| {
            routes.take(id);
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_notification_body_is_escaped_only_for_markup_capable_daemons() {
        let body = "R&D <test>";
        assert_eq!(linux_body(body, &[]), body);
        assert_eq!(linux_body(body, &["body".into()]), body);
        assert_eq!(
            linux_body(body, &["body-markup".into()]),
            "R&amp;D &lt;test&gt;"
        );
    }

    #[test]
    fn pending_clicks_are_bounded() {
        let routes = NotificationClicks::default();
        let oldest = routes.remember(target("local-a", None));
        for _ in 0..MAX_NOTICES {
            routes.remember(target("local-a", Some(Uuid::new_v4())));
        }
        assert_eq!(routes.pending.lock().len(), MAX_NOTICES);
        assert!(routes.take(oldest).is_none());
    }

    fn target(label: &str, action: Option<Uuid>) -> Target {
        Target {
            label: label.into(),
            url: "https://app.test".parse().unwrap(),
            action,
            #[cfg(windows)]
            toast: None,
        }
    }

    #[test]
    fn clicks_route_once_to_the_sending_document_and_expire_on_navigation() {
        let routes = NotificationClicks::default();
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
