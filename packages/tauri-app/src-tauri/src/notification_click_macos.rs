use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{Bool, ProtocolObject},
    AnyThread, DefinedClass,
};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSettings,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::{cell::OnceCell, ptr::NonNull, sync::Weak};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

define_class!(
    // The delegate's only instance data is a thread-safe weak handle.
    #[unsafe(super(NSObject))]
    #[ivars = Weak<AppHandle>]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn present(
            &self,
            _: &UNUserNotificationCenter,
            _: &UNNotification,
            complete: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let options = UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List;
            complete.call((options,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn respond(
            &self,
            _: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            complete: &DynBlock<dyn Fn()>,
        ) {
            if &*response.actionIdentifier() == unsafe { UNNotificationDefaultActionIdentifier } {
                let id = response.notification().request().identifier().to_string();
                if let (Some(app), Some(id)) = (self.ivars().upgrade(), super::action_id(&id)) {
                    super::clicked(&app, id, None);
                }
            }
            complete.call(());
        }
    }
);

thread_local! {
    // The system keeps the delegate weakly; one delegate serves the whole app without waiters.
    static DELEGATE: OnceCell<Retained<NotificationDelegate>> = const { OnceCell::new() };
}

pub(super) fn install(host: Weak<AppHandle>) -> bool {
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        return false;
    }
    DELEGATE.with(|delegate| {
        let delegate = delegate.get_or_init(|| {
            let delegate = NotificationDelegate::alloc().set_ivars(host);
            unsafe { msg_send![super(delegate), init] }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
    });
    true
}

pub(super) async fn permission(request: bool) -> Result<&'static str, String> {
    if request {
        let (tx, mut rx) = tauri::async_runtime::channel(1);
        {
            let complete = RcBlock::new(move |_: Bool, error: *mut NSError| {
                let _ = tx.try_send(error.is_null());
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .requestAuthorizationWithOptions_completionHandler(
                    UNAuthorizationOptions::Alert,
                    &complete,
                );
        }
        if rx.recv().await != Some(true) {
            return Err("macOS could not request notification authorization".into());
        }
    }
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    {
        let complete = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // Notification Center supplies a live settings object for this callback.
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            let value = match status {
                UNAuthorizationStatus::Authorized
                | UNAuthorizationStatus::Provisional
                | UNAuthorizationStatus::Ephemeral => "granted",
                UNAuthorizationStatus::Denied => "denied",
                _ => "default",
            };
            let _ = tx.try_send(value);
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .getNotificationSettingsWithCompletionHandler(&complete);
    }
    rx.recv()
        .await
        .ok_or_else(|| "macOS did not return notification settings".into())
}

pub(super) fn show(host: Weak<AppHandle>, route: Option<Uuid>, title: String, body: String) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&title));
    content.setBody(&NSString::from_str(&body));
    let id = route.unwrap_or_else(Uuid::new_v4);
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&id.to_string()),
        &content,
        None,
    );
    let delivered = RcBlock::new(move |error: *mut NSError| {
        if !error.is_null() {
            if let (Some(app), Some(id)) = (host.upgrade(), route) {
                app.state::<super::NotificationClicks>().take(id);
            }
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&delivered));
}
