use sha2::{Digest, Sha256};
use std::{ffi::c_void, sync::Weak};
use tauri::AppHandle;
use uuid::Uuid;
use windows::{
    core::{implement, IUnknown, Interface, Ref, BOOL, GUID, HSTRING, PCWSTR},
    Data::Xml::Dom::XmlDocument,
    Win32::{
        Foundation::{CLASS_E_NOAGGREGATION, E_POINTER},
        System::{
            Com::{
                CoRegisterClassObject, CoRevokeClassObject, IClassFactory, IClassFactory_Impl,
                CLSCTX_LOCAL_SERVER, REGCLS_AGILE, REGCLS_MULTIPLEUSE,
            },
            WinRT::{RoInitialize, RoUninitialize, RO_INIT_SINGLETHREADED},
        },
        UI::Notifications::{
            INotificationActivationCallback, INotificationActivationCallback_Impl,
            NOTIFICATION_USER_INPUT_DATA,
        },
    },
    UI::Notifications::{ToastNotification, ToastNotificationManager},
};

pub(crate) const ACTIVATION_ARG: &str = "--codenomad-toast-activation";
pub(super) type Toast = ToastNotification;

fn toast_identity(profile: &str) -> String {
    // CustomActivator has one owner per AUMID. Electron owns the shared shell ID.
    format!("{profile}.tauri")
}

#[implement(IClassFactory)]
struct Factory(Weak<AppHandle>);

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<IUnknown>,
        iid: *const GUID,
        out: *mut *mut c_void,
    ) -> windows::core::Result<()> {
        if iid.is_null() || out.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe { *out = std::ptr::null_mut() };
        if outer.as_ref().is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let activation: INotificationActivationCallback = Activator(self.0.clone()).into();
        unsafe { activation.query(iid, out).ok() }
    }

    fn LockServer(&self, _: BOOL) -> windows::core::Result<()> {
        Ok(())
    }
}

#[implement(INotificationActivationCallback)]
struct Activator(Weak<AppHandle>);

impl INotificationActivationCallback_Impl for Activator_Impl {
    fn Activate(
        &self,
        _: &PCWSTR,
        args: &PCWSTR,
        _: *const NOTIFICATION_USER_INPUT_DATA,
        _: u32,
    ) -> windows::core::Result<()> {
        if let Some(app) = self.0.upgrade() {
            if !args.is_null() {
                if let Ok(value) = unsafe { args.to_string() } {
                    if let Some(id) = super::action_id(&value) {
                        super::clicked(&app, id, None);
                    }
                }
            }
        }
        Ok(())
    }
}

thread_local! {
    static REGISTRATION: std::cell::OnceCell<Registration> = const { std::cell::OnceCell::new() };
}

struct Registration(u32, Weak<AppHandle>);
impl Drop for Registration {
    fn drop(&mut self) {
        unsafe {
            let _ = CoRevokeClassObject(self.0);
            RoUninitialize();
        }
    }
}

pub(super) fn install(profile: &str, host: Weak<AppHandle>) -> Result<(), String> {
    let identifier = toast_identity(profile);
    let digest = Sha256::digest(identifier.as_bytes());
    let uuid = Uuid::from_bytes(digest[..16].try_into().unwrap());
    let clsid = GUID::from_u128(uuid.as_u128());
    crate::windows_notification_identity::register_activation(
        &identifier,
        &format!("{{{uuid}}}"),
        ACTIVATION_ARG,
    )?;
    unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }.map_err(|error| error.to_string())?;
    let factory: IClassFactory = Factory(host.clone()).into();
    match unsafe {
        CoRegisterClassObject(
            &clsid,
            &factory,
            CLSCTX_LOCAL_SERVER,
            REGCLS_MULTIPLEUSE | REGCLS_AGILE,
        )
    } {
        Ok(cookie) => {
            let _ = REGISTRATION.with(|registration| registration.set(Registration(cookie, host)));
            Ok(())
        }
        Err(error) => {
            unsafe { RoUninitialize() };
            Err(error.to_string())
        }
    }
}

pub(super) fn show(
    app: &AppHandle,
    id: Uuid,
    title: &str,
    body: &str,
) -> windows::core::Result<Toast> {
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(toast_xml(id, title, body)))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
    let host = REGISTRATION.with(|r| r.get().map(|registration| registration.1.clone()));
    // WinRT can deliver the banner click directly; the COM activator handles Notification Center.
    toast.Activated(&windows::Foundation::TypedEventHandler::new(move |_, _| {
        if let Some(app) = host.as_ref().and_then(Weak::upgrade) {
            super::clicked(&app, id, None);
        }
        Ok(())
    }))?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(toast_identity(
        &app.config().identifier,
    )))?
    .Show(&toast)?;
    Ok(toast)
}

fn toast_xml(id: Uuid, title: &str, body: &str) -> String {
    let text = |value: &str| {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    format!(
        r#"<toast launch="{id}"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
        text(title),
        text(body),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toast_keeps_content_as_text_and_uses_an_opaque_launch_argument() {
        let id = Uuid::new_v4();
        let xml = toast_xml(id, "<text>x & y</text>", "message");
        assert!(xml.contains(&format!(r#"launch="{id}""#)));
        assert!(xml.contains("<text>&lt;text&gt;x &amp; y&lt;/text&gt;</text>"));
        assert_ne!(
            toast_identity("ai.neuralnomads.codenomad.client"),
            "ai.neuralnomads.codenomad.client"
        );
    }
}
