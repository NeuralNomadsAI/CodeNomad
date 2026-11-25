use super::*;
use crate::settings::notification_routing::{Category, Destination};

#[test]
fn first_route_write_preserves_legacy_defaults_and_later_writes_touch_only_their_cell() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.config.snapshot =
            Some(json!({"settings":{"notifyOnIdle":false,"osNotificationsEnabled":false}}));
        prefs.set_notification_route(Category::NeedsInput, Destination::Screen, true);
        assert!(prefs.notification_route(Category::NeedsInput, Destination::Screen));
        assert!(prefs.poll());
        let seed_get = request(&listener).await;
        assert_eq!(
            seed_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        seed_get
            .reply(
                200,
                json!({"settings":{"notifyOnIdle":false,"osNotificationsEnabled":false}}),
            )
            .await;
        let first = poll_next_request(&mut prefs, &listener).await;
        let mut saved = first.body.clone();
        let first_table = &saved["settings"]["notificationRouting"];
        assert_eq!(first_table.as_object().unwrap().len(), 9);
        assert_eq!(first_table["needsInput"]["screen"], true);
        assert_eq!(first_table["sessionDone"]["system"], false);
        assert_eq!(first_table["updates"]["system"], false);
        prefs.set_notification_route(Category::Copy, Destination::History, true);
        prefs.set_notifications_focused(true);
        first.reply(200, saved.clone()).await;
        wait_until(|| prefs.poll()).await;
        let second = request(&listener).await;
        assert_eq!(
            second.body,
            json!({"settings":{
                "notificationRouting":{"copy":{"history":true}},
                "osNotificationsAllowWhenVisible":true
            }})
        );
        saved["settings"]["notificationRouting"]["copy"]["history"] = json!(true);
        saved["settings"]["osNotificationsAllowWhenVisible"] = json!(true);
        second.reply(200, saved).await;
        wait_until(|| prefs.poll()).await;
        assert!(prefs.notifications_focused());
        assert!(prefs.notification_route(Category::Copy, Destination::History));
        assert!(!prefs.notification_route(Category::Updates, Destination::System));

        // Against a server advertising settings-atomic-patches, even the first notificationRouting
        // edit sends only the toggled cell so the server seeds legacy flags under its write lock.
        let (listener2, mut prefs2) = fixture_atomic().await;
        prefs2.config.snapshot =
            Some(json!({"settings":{"notifyOnIdle":false,"osNotificationsEnabled":false}}));
        prefs2.set_notification_route(Category::Copy, Destination::History, true);
        assert!(prefs2.poll());
        let atomic_first = request(&listener2).await;
        assert_eq!(
            atomic_first.first,
            "PATCH /api/storage/config/ui?conditional=atomic-v1 HTTP/1.1"
        );
        assert_eq!(
            atomic_first.body,
            json!({"settings":{"notificationRouting":{"copy":{"history":true}}}})
        );

        // On a legacy (!atomic) server, a 503 on the pre-PATCH re-read must expose a retryable
        // error in the Notifications section instead of disabling checkboxes with no Retry button.
        let (listener3, mut prefs3) = fixture().await;
        prefs3.config.snapshot =
            Some(json!({"settings":{"notifyOnIdle":false,"osNotificationsEnabled":false}}));
        prefs3.invalidate(Owner::Config);
        prefs3.set_notification_route(Category::Copy, Destination::History, true);
        assert!(prefs3.poll());
        let pre_read = request(&listener3).await;
        assert_eq!(
            pre_read.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        pre_read.reply(503, json!({})).await;
        wait_until(|| {
            prefs3.poll();
            !prefs3.notification_ready()
        })
        .await;
        assert_eq!(prefs3.notifications_error(), Some("rune.connect_error"));
        assert!(prefs3.notifications_failed());
        prefs3.retry_notifications();
        assert!(prefs3.poll());
        let retry_read = request(&listener3).await;
        assert_eq!(
            retry_read.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        retry_read
            .reply(
                200,
                json!({"settings":{"notifyOnIdle":false,"osNotificationsEnabled":false}}),
            )
            .await;
        let retry_patch = poll_next_request(&mut prefs3, &listener3).await;
        assert_eq!(retry_patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        let saved3 = retry_patch.body.clone();
        retry_patch.reply(200, saved3).await;
        wait_until(|| {
            prefs3.poll();
            prefs3.notification_ready() && !prefs3.notifications_failed()
        })
        .await;
        assert!(prefs3.notification_route(Category::Copy, Destination::History));
    });
}
