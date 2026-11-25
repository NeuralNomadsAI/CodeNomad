use super::*;

#[test]
fn settings_config_observation_resumes_after_the_conversation_reports_an_outage() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.take().unwrap();
        let (out, events) = bounded(16);
        let (commands, input) = bounded(1);
        platform::spawn(async move {
            run_backend(backend, out, input, Arc::new(|| {}))
                .await
                .unwrap();
        });
        for _ in 0..7 {
            let sse = request_with_timeout(&listener, Duration::from_secs(6)).await;
            assert!(sse.first.starts_with("GET /api/events?"));
            assert!(!sse.first.contains("-preferences"));
            sse.reply(503, json!({})).await;
        }
        until(&events, |event| matches!(event, Event::Failed)).await;
        let mut restored = request_with_timeout(&listener, Duration::from_secs(6)).await;
        assert!(restored.first.starts_with("GET /api/events?"));
        assert!(!restored.first.contains("-preferences"));
        restored
            .socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n\
            data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\",\"value\":{}}\n\n",
            )
            .await
            .unwrap();
        // Opening itself invalidates both owners; wait for the distinct Git hint from this frame.
        until(&events, |event| {
            matches!(
                event,
                Event::Workspace(WorkspaceEvent::UiPreferencesChanged)
            )
        })
        .await;
        commands.send(Command::Close).await.unwrap();
    });
}

#[test]
fn settings_expired_fallback_requests_authentication_without_reopening_sse() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let wake: rune::Waker = Arc::new(|| {});
        prefs.watch(&wake);
        let reader = request(&listener).await;
        assert!(reader.first.contains("-preferences"));
        reader.reply(401, json!({})).await;
        wait_until(|| prefs.observe_authentication()).await;
        prefs.watch(&wake);
        assert!(!prefs.locale_ready());
        assert!(
            timeout(Duration::from_millis(600), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn settings_conversation_waits_until_the_fallback_sse_reader_is_closed() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.clone().unwrap();
        let wake: rune::Waker = Arc::new(|| {});
        prefs.watch(&wake);
        let mut fallback = request(&listener).await;
        assert!(fallback.first.contains("-preferences"));
        fallback
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let mut root = crate::init();
        *root.settings.shared.borrow_mut() = prefs;
        crate::transport::start_bound(&mut root, backend);
        let closure = timeout(Duration::from_secs(2), fallback.socket.read(&mut [0]))
            .await
            .unwrap();
        assert!(
            matches!(closure, Ok(0))
                || closure.is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset)
        );
        let conversation = request(&listener).await;
        assert!(conversation.first.starts_with("GET /api/events?"));
        assert!(!conversation.first.contains("-preferences"));
    });
}

#[test]
fn settings_bound_start_cannot_open_sse_while_the_close_receipt_is_held() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.clone().unwrap();
        let (receipt, closed) = bounded(1);
        prefs.closing_stream = Some(closed);
        let mut root = crate::init();
        *root.settings.shared.borrow_mut() = prefs;
        crate::transport::start_bound(&mut root, backend);
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        drop(receipt);
        assert!(
            request(&listener)
                .await
                .first
                .starts_with("GET /api/events?")
        );
    });
}
