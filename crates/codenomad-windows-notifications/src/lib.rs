//! Safe, thread-owned Windows notification delivery for the native Rune host.
#![cfg(windows)]
#![deny(unsafe_op_in_unsafe_fn)]

use std::{rc::Rc, sync::Mutex};
use windows::{
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{
        NotificationSetting, ToastNotification, ToastNotificationManager, ToastNotifier,
    },
    Win32::{
        Foundation::E_INVALIDARG,
        System::{
            Registry::{HKEY_CURRENT_USER, REG_SZ, RegSetKeyValueW},
            WinRT::{RO_INIT_SINGLETHREADED, RoInitialize, RoUninitialize},
        },
        UI::Shell::SetCurrentProcessExplicitAppUserModelID,
    },
    core::{HSTRING, PCWSTR, Result, w},
};

pub struct Delivery {
    notifier: ToastNotifier,
    apartment: Rc<Apartment>,
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        // This adapter lives and is dropped on the owning UI thread.
        unsafe { RoUninitialize() }
    }
}

impl Delivery {
    /// Use an identity already registered by the desktop host.
    fn new(identity: &str) -> Result<Self> {
        unsafe { RoInitialize(RO_INIT_SINGLETHREADED)? };
        let apartment = Rc::new(Apartment);
        let notifier =
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(identity))?;
        Ok(Self {
            notifier,
            apartment,
        })
    }

    pub fn for_rune_profile(profile: Option<&str>) -> Result<Self> {
        if profile.is_some_and(|p| {
            p.is_empty()
                || p.len() > 64
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
        }) {
            return Err(windows::core::Error::from_hresult(E_INVALIDARG));
        }
        let identity = profile_identity(profile);
        let key = HSTRING::from(format!(r"Software\Classes\AppUserModelId\{identity}"));
        let name = HSTRING::from("CodeNomad");
        let wide = HSTRING::from(&identity);
        // Both HSTRINGs are terminated and the registry copies the UTF-16 bytes.
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                w!("DisplayName"),
                REG_SZ.0,
                Some(name.as_ptr().cast()),
                ((name.len() + 1) * size_of::<u16>()) as u32,
            )
            .ok()?;
            SetCurrentProcessExplicitAppUserModelID(PCWSTR(wide.as_ptr()))?;
        }
        Self::new(&identity)
    }

    /// Current Windows notification setting for this registered delivery identity.
    pub fn enabled(&self) -> Result<bool> {
        Ok(self.notifier.Setting()? == NotificationSetting::Enabled)
    }

    /// The sender owns the returned action lifetime; dropping it removes the click handler.
    pub fn show(
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
            notifier: self.notifier.clone(),
            _apartment: self.apartment.clone(),
        };
        self.notifier.Show(&presented.notification)?;
        Ok(Some(presented))
    }
}

fn profile_identity(profile: Option<&str>) -> String {
    let id = "ai.neuralnomads.codenomad.rune";
    match profile {
        Some(profile) => format!("{id}.scope.{profile}"),
        None => id.into(),
    }
}

pub struct Presented {
    notification: ToastNotification,
    activated: i64,
    notifier: ToastNotifier,
    _apartment: Rc<Apartment>,
}

impl Drop for Presented {
    fn drop(&mut self) {
        let _ = self.notification.RemoveActivated(self.activated);
        let _ = self.notifier.Hide(&self.notification);
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
