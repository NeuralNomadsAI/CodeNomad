use super::*;
use crate::settings::memory::action;

#[test]
fn memory_settings_are_demanded_and_failed_writes_only_read_back() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        assert!(!prefs.poll());
        prefs.memory.show(true);
        assert!(prefs.poll());
        let initial = request(&listener).await;
        assert_eq!(initial.first, "GET /api/memory/settings HTTP/1.1");
        prefs.memory.invalidate();
        prefs.memory.invalidate();
        initial.reply(200, json!({"enabled":false})).await;
        wait_until(|| prefs.poll()).await;
        let trailing = request(&listener).await;
        assert_eq!(trailing.first, "GET /api/memory/settings HTTP/1.1");
        trailing.reply(200, json!({"enabled":false})).await;
        wait_until(|| prefs.poll()).await;
        action(&mut prefs, Some(true));
        assert!(prefs.poll());
        let put = request(&listener).await;
        assert_eq!(put.first, "PUT /api/memory/settings HTTP/1.1");
        assert_eq!(put.body, json!({"enabled":true}));
        prefs.memory.show(false);
        put.reply(503, json!({})).await;
        let readback = request(&listener).await;
        assert_eq!(readback.first, "GET /api/memory/settings HTTP/1.1");
        readback.reply(200, json!({"enabled":true})).await;
        wait_until(|| prefs.poll()).await;
        prefs.memory.invalidate();
        assert!(!prefs.poll());
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}
