//! Windows delivery for the host's registered application identity.
use std::sync::Mutex;
use windows::{
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{
        NotificationSetting, ToastNotification, ToastNotificationManager, ToastNotifier,
    },
    core::{HSTRING, Result},
};

pub(crate) struct Delivery {
    notifier: ToastNotifier,
}

impl Delivery {
    /// Use an identity already registered by the desktop host.
    pub(crate) fn new(identity: &str) -> Result<Self> {
        let notifier =
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(identity))?;
        Ok(Self { notifier })
    }

    pub(crate) fn enabled(&self) -> Result<bool> {
        Ok(self.notifier.Setting()? == NotificationSetting::Enabled)
    }

    /// The sender owns the returned action lifetime; dropping it removes the click handler.
    pub(crate) fn show(
        &self,
        title: &str,
        body: &str,
        click: impl FnOnce() + Send + 'static,
    ) -> Result<Option<Presented>> {
        if !self.enabled()? {
            return Ok(None);
        }
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
        let notification = ToastNotification::CreateToastNotification(&xml)?;
        let click = Mutex::new(Some(click));
        let activated = notification.Activated(&TypedEventHandler::new(move |_, _| {
            let callback = click.lock().ok().and_then(|mut pending| pending.take());
            if let Some(callback) = callback {
                callback();
            }
            Ok(())
        }))?;
        let presented = Presented {
            notification,
            activated,
        };
        self.notifier.Show(&presented.notification)?;
        Ok(Some(presented))
    }
}

pub(crate) struct Presented {
    notification: ToastNotification,
    activated: i64,
}

impl Drop for Presented {
    fn drop(&mut self) {
        let _ = self.notification.RemoveActivated(self.activated);
    }
}

fn toast_xml(title: &str, body: &str) -> String {
    fn text(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }
    format!(
        r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual><audio silent="true"/></toast>"#,
        text(title),
        text(body)
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn system_notification_keeps_session_content_as_silent_text() {
        let xml = super::toast_xml("Projet & <branche>", "</text><actions>🦀");
        assert!(xml.contains("<text>Projet &amp; &lt;branche&gt;</text>"));
        assert!(xml.contains("<text>&lt;/text&gt;&lt;actions&gt;🦀</text>"));
        assert!(xml.contains(r#"<audio silent="true"/>"#));
    }
}
