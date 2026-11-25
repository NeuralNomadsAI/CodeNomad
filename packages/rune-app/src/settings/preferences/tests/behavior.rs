use super::*;

#[test]
fn new_conversation_permissions_keep_the_confirmed_value_until_the_write_settles() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        assert_eq!(prefs.new_conversation_permissions(), "autonomous");
        prefs.set_new_conversation_permissions("supervised");
        assert!(prefs.new_conversation_permissions_pending());
        assert_eq!(prefs.new_conversation_permissions(), "autonomous");
        prefs.set_new_conversation_permissions("autonomous");
        prefs.poll();
        let patch = request(&listener).await;
        assert_eq!(patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            patch.body,
            json!({"settings":{"newConversationPermissions":"supervised"}})
        );
        patch.reply(503, json!({})).await;
        let read = request(&listener).await;
        assert!(
            read.first
                .starts_with("GET /api/storage/config/ui?authoritative=1 ")
        );
        read.reply(200, json!({"settings":{"locale":"en"}})).await;
        wait_until(|| prefs.poll()).await;
        assert!(prefs.new_conversation_permissions_failed());
        assert!(!prefs.new_conversation_permissions_pending());
        assert_eq!(prefs.new_conversation_permissions(), "autonomous");
        assert!(prefs.error().is_none(), "the selector owns the error");
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );

        prefs.set_new_conversation_permissions("supervised");
        prefs.poll();
        let patch = request(&listener).await;
        assert_eq!(
            patch.body,
            json!({"settings":{"newConversationPermissions":"supervised"}})
        );
        patch
            .reply(
                200,
                json!({"settings":{"newConversationPermissions":"supervised"}}),
            )
            .await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(prefs.new_conversation_permissions(), "supervised");
        assert!(!prefs.new_conversation_permissions_pending());
        assert!(!prefs.new_conversation_permissions_failed());
    });
}

#[test]
fn general_behavior_toggles_read_solid_defaults_and_persist_to_ui_config() {
    use crate::settings::preferences::behavior::GeneralToggle;
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        assert_eq!(
            prefs.general_toggle(GeneralToggle::MessageTimeline),
            Some(true)
        );
        assert_eq!(
            prefs.general_toggle(GeneralToggle::ScrollControlsInTimelineCorner),
            Some(false)
        );
        assert_eq!(
            prefs.general_toggle(GeneralToggle::DiffViewMode),
            Some(true)
        );
        assert_eq!(
            prefs.general_toggle(GeneralToggle::AutoExpandActiveSubsessions),
            Some(true)
        );
        assert_eq!(
            prefs.general_toggle(GeneralToggle::FollowUpBehavior),
            Some(false)
        );
        assert_eq!(
            prefs.general_toggle(GeneralToggle::KeepComputerAwake),
            Some(false)
        );

        prefs.config.snapshot = Some(json!({"settings":{
            "locale":"en",
            "keepComputerAwake":"true",
            "autoExpandActiveSubsessions":"no",
            "followUpBehavior":"invalid",
            "diffViewMode":"invalid"
        }}));
        assert_eq!(
            prefs.general_toggle(GeneralToggle::KeepComputerAwake),
            Some(false)
        );
        assert_eq!(
            prefs.general_toggle(GeneralToggle::AutoExpandActiveSubsessions),
            Some(true)
        );
        assert_eq!(
            prefs.general_toggle(GeneralToggle::FollowUpBehavior),
            Some(false)
        );
        assert_eq!(
            prefs.general_toggle(GeneralToggle::DiffViewMode),
            Some(true)
        );
        prefs.config.snapshot = Some(json!({"settings":{
            "locale":"en",
            "diffViewMode":"unified"
        }}));
        assert_eq!(
            prefs.general_toggle(GeneralToggle::DiffViewMode),
            Some(false)
        );

        prefs.config.snapshot = Some(json!({"settings":{"locale":"en"}}));
        for (toggle, next) in [
            (GeneralToggle::MessageTimeline, false),
            (GeneralToggle::ScrollControlsInTimelineCorner, true),
            (GeneralToggle::DiffViewMode, false),
            (GeneralToggle::AutoExpandActiveSubsessions, false),
            (GeneralToggle::FollowUpBehavior, true),
            (GeneralToggle::KeepComputerAwake, true),
        ] {
            prefs.set_general_toggle(toggle, next);
            assert!(prefs.general_toggle_pending(toggle));
            assert_ne!(prefs.general_toggle(toggle), Some(next));
        }
        prefs.poll();
        let patch = request(&listener).await;
        assert_eq!(patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        let expected = json!({"settings":{
            "showMessageTimeline":false,
            "scrollControlsInTimelineCorner":true,
            "diffViewMode":"unified",
            "autoExpandActiveSubsessions":false,
            "followUpBehavior":"queue",
            "keepComputerAwake":true
        }});
        assert_eq!(patch.body, expected);
        let mut confirmed = expected;
        confirmed["settings"]["locale"] = json!("en");
        patch.reply(200, confirmed).await;
        wait_until(|| prefs.poll()).await;
        for (toggle, next) in [
            (GeneralToggle::MessageTimeline, false),
            (GeneralToggle::ScrollControlsInTimelineCorner, true),
            (GeneralToggle::DiffViewMode, false),
            (GeneralToggle::AutoExpandActiveSubsessions, false),
            (GeneralToggle::FollowUpBehavior, true),
            (GeneralToggle::KeepComputerAwake, true),
        ] {
            assert_eq!(prefs.general_toggle(toggle), Some(next));
            assert!(!prefs.general_toggle_pending(toggle));
        }
        assert!(prefs.general_error().is_none());
    });
}

#[test]
fn general_behavior_failure_emits_generic_save_error_and_recovers_on_retry_or_retoggle() {
    use crate::settings::preferences::behavior::GeneralToggle;
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.set_general_toggle(GeneralToggle::FollowUpBehavior, true);
        prefs.poll();
        let patch = request(&listener).await;
        assert_eq!(patch.body, json!({"settings":{"followUpBehavior":"queue"}}));
        patch.reply(503, json!({})).await;
        let read = request(&listener).await;
        assert!(
            read.first
                .starts_with("GET /api/storage/config/ui?authoritative=1 ")
        );
        read.reply(
            200,
            json!({"settings":{"locale":"en","followUpBehavior":"steer"}}),
        )
        .await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(
            prefs.general_toggle(GeneralToggle::FollowUpBehavior),
            Some(false)
        );
        assert!(!prefs.general_toggle_pending(GeneralToggle::FollowUpBehavior));
        assert_eq!(prefs.general_error(), Some("settings.preferenceSaveFailed"));
        assert!(prefs.take_notification_failure());

        prefs.retry_general();
        assert!(
            prefs.general_toggle_pending(GeneralToggle::FollowUpBehavior),
            "retry keeps the toggle pending before preflight starts"
        );
        prefs.poll();
        assert!(
            prefs.general_toggle_pending(GeneralToggle::FollowUpBehavior),
            "retry keeps the toggle pending during preflight read"
        );
        prefs.set_general_toggle(GeneralToggle::FollowUpBehavior, true);
        let preflight = request(&listener).await;
        preflight
            .reply(
                200,
                json!({"settings":{"locale":"en","followUpBehavior":"steer"}}),
            )
            .await;
        wait_until(|| prefs.poll()).await;
        assert!(
            prefs.general_toggle_pending(GeneralToggle::FollowUpBehavior),
            "retry keeps the toggle pending while retry PATCH is in flight"
        );
        prefs.set_general_toggle(GeneralToggle::FollowUpBehavior, true);
        let retry = request(&listener).await;
        assert_eq!(retry.body, json!({"settings":{"followUpBehavior":"queue"}}));
        retry
            .reply(
                200,
                json!({"settings":{"locale":"en","followUpBehavior":"queue"}}),
            )
            .await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(
            prefs.general_toggle(GeneralToggle::FollowUpBehavior),
            Some(true)
        );
        assert!(!prefs.general_toggle_pending(GeneralToggle::FollowUpBehavior));
        assert!(prefs.general_error().is_none());
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err(),
            "in-flight retry refuses duplicate PATCHes"
        );

        prefs.set_general_toggle(GeneralToggle::DiffViewMode, false);
        prefs.poll();
        request(&listener).await.reply(503, json!({})).await;
        request(&listener)
            .await
            .reply(200, json!({"settings":{"locale":"en","followUpBehavior":"queue","diffViewMode":"split"}}))
            .await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(prefs.general_error(), Some("settings.preferenceSaveFailed"));
        assert!(prefs.take_notification_failure());

        prefs.set_general_toggle(GeneralToggle::DiffViewMode, false);
        assert!(prefs.general_error().is_none());
        assert!(prefs.general_toggle_pending(GeneralToggle::DiffViewMode));
        prefs.poll();
        let patch = request(&listener).await;
        assert_eq!(patch.body, json!({"settings":{"diffViewMode":"unified"}}));
        patch
            .reply(200, json!({"settings":{"locale":"en","followUpBehavior":"queue","diffViewMode":"unified"}}))
            .await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(
            prefs.general_toggle(GeneralToggle::DiffViewMode),
            Some(false)
        );
        assert!(prefs.general_error().is_none());
    });
}
