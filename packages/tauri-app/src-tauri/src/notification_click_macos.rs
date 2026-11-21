use super::authorization::{Authorization, Center, Permission};
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
use std::{
    cell::OnceCell,
    ptr::NonNull,
    sync::{Arc, OnceLock, Weak},
};
use tauri::async_runtime::{self, Sender};
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

#[derive(Default)]
pub(super) struct Delivery {
    auth: Arc<Authorization>,
    queue: OnceLock<Sender<(Option<Uuid>, String, String)>>,
}

impl Delivery {
    pub(super) async fn permission(&self, request: bool) -> Result<&'static str, String> {
        Ok(
            match self.auth.permission(&NotificationCenter, request).await? {
                Permission::Granted => "granted",
                Permission::Denied => "denied",
                Permission::Undetermined => "default",
            },
        )
    }

    pub(super) fn show(
        &self,
        host: &Weak<AppHandle>,
        route: Option<Uuid>,
        title: String,
        body: String,
    ) -> Result<(), String> {
        let queue = self.queue.get_or_init(|| {
            let (tx, mut rx) = async_runtime::channel(super::MAX_NOTICES);
            let host = host.clone();
            let auth = self.auth.clone();
            async_runtime::spawn(async move {
                while let Some((route, title, body)) = rx.recv().await {
                    let result = auth
                        .deliver(&NotificationCenter, || {
                            show(host.clone(), route, title, body);
                        })
                        .await;
                    if !matches!(result, Ok(true)) {
                        retire_route(&host, route);
                        if let Err(error) = result {
                            eprintln!("[notification] {error}");
                        }
                    }
                }
            });
            tx
        });
        queue
            .try_send((route, title, body))
            .map_err(|_| "macOS notification queue unavailable".into())
    }
}

struct NotificationCenter;

impl Center for NotificationCenter {
    async fn request(&self) -> Result<Permission, String> {
        let (tx, mut rx) = async_runtime::channel(1);
        {
            let complete = RcBlock::new(move |allowed: Bool, error: *mut NSError| {
                let _ = tx.try_send(error.is_null().then_some(allowed.as_bool()));
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .requestAuthorizationWithOptions_completionHandler(
                    UNAuthorizationOptions::Alert,
                    &complete,
                );
        }
        match rx.recv().await.flatten() {
            Some(true) => Ok(Permission::Granted),
            Some(false) => Ok(Permission::Denied),
            None => Err("macOS could not request notification authorization".into()),
        }
    }

    async fn status(&self) -> Result<Permission, String> {
        let (tx, mut rx) = async_runtime::channel(1);
        {
            let complete = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                // Notification Center supplies a live settings object for this callback.
                let status = unsafe { settings.as_ref() }.authorizationStatus();
                let permission = match status {
                    UNAuthorizationStatus::Authorized
                    | UNAuthorizationStatus::Provisional
                    | UNAuthorizationStatus::Ephemeral => Permission::Granted,
                    UNAuthorizationStatus::NotDetermined => Permission::Undetermined,
                    // Fail closed for a status this host doesn't recognise.
                    _ => Permission::Denied,
                };
                let _ = tx.try_send(permission);
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .getNotificationSettingsWithCompletionHandler(&complete);
        }
        rx.recv()
            .await
            .ok_or_else(|| "macOS did not return notification settings".into())
    }
}

fn retire_route(host: &Weak<AppHandle>, route: Option<Uuid>) {
    if let (Some(app), Some(id)) = (host.upgrade(), route) {
        app.state::<super::NotificationClicks>().take(id);
    }
}

fn show(host: Weak<AppHandle>, route: Option<Uuid>, title: String, body: String) {
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
            retire_route(&host, route);
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&delivered));
}
