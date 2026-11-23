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

#[test]
fn update_feed_read_failure_settles_before_info_rereads_metadata() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let wake: rune::Waker = std::sync::Arc::new(|| {});
        let mut info = crate::settings::info::Info::default();
        assert!(info.poll(&prefs, &wake));
        for _ in 0..2 {
            let read = request(&listener).await;
            if read.first.starts_with("GET /api/meta ") {
                read.reply(200, json!({"updateFeed":"stable"})).await;
            } else {
                assert!(read.first.starts_with("GET /api/opencode/update "));
                read.reply(200, json!({"state":"ready"})).await;
            }
        }
        wait_until(|| {
            info.poll(&prefs, &wake);
            info.current(&prefs).is_some()
        })
        .await;
        assert!(prefs.show_opencode());
        assert!(prefs.poll());
        let preflight = request(&listener).await;
        assert!(
            preflight
                .first
                .starts_with("GET /api/storage/config/server?")
        );
        info.change_feed(&mut prefs, "preview");
        assert!(prefs.update_feed_pending());
        preflight.reply(503, json!({})).await;
        wait_until(|| prefs.poll()).await;
        assert!(!prefs.update_feed_pending());
        assert!(prefs.update_feed_failed());
        assert!(info.poll(&prefs, &wake));
        let confirmed = request(&listener).await;
        assert!(confirmed.first.starts_with("GET /api/meta "));
        confirmed
            .reply(
                200,
                json!({"updateFeed":"stable","serverVersion":"after-failure"}),
            )
            .await;
        wait_until(|| {
            info.poll(&prefs, &wake);
            info.current(&prefs).is_some_and(|meta| {
                meta["updateFeed"] == "stable" && meta["serverVersion"] == "after-failure"
            })
        })
        .await;
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}
