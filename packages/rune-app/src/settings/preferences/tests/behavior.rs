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
