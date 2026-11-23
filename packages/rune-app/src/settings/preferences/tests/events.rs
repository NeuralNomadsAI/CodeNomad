use super::*;

#[test]
fn settings_sse_refreshes_only_the_invalidated_owner() {
    let (listener, backend) = platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
            .await
            .unwrap();
        (listener, backend)
    });
    let (sender, receiver) = bounded(8);
    let wake: rune::Waker = std::sync::Arc::new(move || {
        let _ = sender.try_send(());
    });
    let mut prefs = Preferences::default();
    prefs.backend = Some(backend);
    prefs.fixture();
    prefs.watch(&wake);
    platform::block_on(async {
        let mut stream = request(&listener).await;
        assert!(stream.first.starts_with("GET /api/events?"));
        stream
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        timeout(Duration::from_secs(3), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        let watcher = prefs.stream.as_ref().unwrap();
        assert_eq!(
            watcher.take(),
            (true, true),
            "opening revalidates both owners"
        );
        prefs.main_wake = Some(wake);
        stream.socket.write_all(b"data: {\"type\":\"storage.configChanged\",\"owner\":\"*\",\"value\":{\"ui\":{\"settings\":{\"locale\":\"he\"}}}}\n\n").await.unwrap();
        timeout(Duration::from_secs(3), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(prefs.poll());
        let read = request(&listener).await;
        assert_eq!(
            read.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        read.reply(200, json!({"settings":{"locale":"he"}})).await;
        timeout(Duration::from_secs(3), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(prefs.poll());
        assert_eq!(prefs.locale(), Some("he"));
        assert!(
            timeout(Duration::from_millis(60), listener.accept())
                .await
                .is_err()
        );

        stream
            .socket
            .write_all(
                b"data: {\"type\":\"storage.stateChanged\",\"owner\":\"*\",\"value\":{}}\n\n",
            )
            .await
            .unwrap();
        timeout(Duration::from_secs(3), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(prefs.poll());
        let read = request(&listener).await;
        assert_eq!(
            read.first,
            "GET /api/storage/state/ui?authoritative=1 HTTP/1.1"
        );
        read.reply(200, json!({"appearancePreferences":{"mode":"dark"}}))
            .await;
        timeout(Duration::from_secs(3), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(prefs.poll());
        assert_eq!(prefs.mode(), "dark");
        assert!(
            timeout(Duration::from_millis(60), listener.accept())
                .await
                .is_err()
        );
    });
}
