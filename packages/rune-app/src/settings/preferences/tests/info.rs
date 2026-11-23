use super::*;

#[test]
fn update_feed_uses_the_server_owner_and_reads_back_a_lost_receipt() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.stage_update_feed("preview");
        prefs.stage_update_feed("stable");
        assert!(prefs.update_feed_pending());
        assert!(prefs.poll());
        let write = request(&listener).await;
        assert_eq!(write.first, "PATCH /api/storage/config/server HTTP/1.1");
        assert_eq!(write.body, json!({"updateFeed":"preview"}));
        drop(write);
        let confirm = request(&listener).await;
        assert_eq!(
            confirm.first,
            "GET /api/storage/config/server?authoritative=1 HTTP/1.1"
        );
        confirm.reply(200, json!({"updateFeed":"preview"})).await;
        wait_until(|| prefs.poll()).await;
        assert!(!prefs.update_feed_pending() && !prefs.update_feed_failed());
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}
