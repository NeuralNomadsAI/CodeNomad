use std::sync::Weak;
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use windows::{
    core::{Result, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{ToastNotification, ToastNotificationManager},
};

pub(super) struct Toast {
    notification: ToastNotification,
    activated: i64,
    dismissed: i64,
    failed: i64,
}

impl Drop for Toast {
    fn drop(&mut self) {
        let _ = self.notification.RemoveActivated(self.activated);
        let _ = self.notification.RemoveDismissed(self.dismissed);
        let _ = self.notification.RemoveFailed(self.failed);
    }
}

pub(super) fn show(
    profile: &str,
    host: &Weak<AppHandle>,
    id: Uuid,
    title: &str,
    body: &str,
) -> Result<Toast> {
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&toast_identity(profile))?;
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
    let notification = ToastNotification::CreateToastNotification(&xml)?;
    let activated = notification.Activated(&TypedEventHandler::new({
        let host = host.clone();
        move |_, _| {
            if let Some(app) = host.upgrade() {
                super::clicked(&app, id, None);
            }
            Ok(())
        }
    }))?;
    let forget = {
        let host = host.clone();
        move || {
            if let Some(app) = host.upgrade() {
                let _ = app.clone().run_on_main_thread(move || {
                    app.state::<super::NotificationClicks>().take(id);
                });
            }
            Ok(())
        }
    };
    let dismissed = notification.Dismissed(&TypedEventHandler::new({
        let forget = forget.clone();
        move |_, _| forget()
    }))?;
    let failed = notification.Failed(&TypedEventHandler::new(move |_, _| forget()))?;
    let toast = Toast {
        notification,
        activated,
        dismissed,
        failed,
    };
    notifier.Show(&toast.notification)?;
    Ok(toast)
}

fn toast_identity(profile: &str) -> HSTRING {
    HSTRING::from(profile)
}

fn toast_xml(title: &str, body: &str) -> String {
    format!(
        r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
        super::escape_text(title),
        super::escape_text(body),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_uses_the_existing_aumid_for_default_and_scoped_profiles() {
        let stable = crate::identity::STABLE_IDENTIFIER;
        let scoped = format!("{stable}.scope.s0123456789abcdef");
        for profile in [stable, &scoped] {
            assert_eq!(toast_identity(profile), HSTRING::from(profile));
        }
    }

    #[test]
    fn notification_keeps_content_as_text() {
        let xml = toast_xml("<text>x & y</text>", "message");
        assert!(xml.contains("<text>&lt;text&gt;x &amp; y&lt;/text&gt;</text>"));
    }
}
