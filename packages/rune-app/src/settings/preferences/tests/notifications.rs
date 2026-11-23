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
        let first = request(&listener).await;
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
    });
}
