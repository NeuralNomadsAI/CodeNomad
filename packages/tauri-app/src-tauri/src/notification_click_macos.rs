use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{Bool, ProtocolObject},
    AnyThread, DefinedClass,
};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use std::{cell::OnceCell, sync::Weak};
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

pub(super) fn show(host: Weak<AppHandle>, route: Option<Uuid>, title: String, body: String) {
    let retire_route = move || {
        if let (Some(app), Some(id)) = (host.upgrade(), route) {
            app.state::<super::NotificationClicks>().take(id);
        }
    };
    let authorized = RcBlock::new(move |allowed: Bool, _: *mut NSError| {
        if !allowed.as_bool() {
            retire_route();
            return;
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        content.setBody(&NSString::from_str(&body));
        let id = route.unwrap_or_else(Uuid::new_v4);
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&id.to_string()),
            &content,
            None,
        );
        let delivered = RcBlock::new({
            let retire_route = retire_route.clone();
            move |error: *mut NSError| {
                if !error.is_null() {
                    retire_route();
                    eprintln!("[notification] macOS refused the notification request");
                }
            }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&delivered));
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert,
            &authorized,
        );
}
