use super::*;
use crate::transport::{Command, Event, run_backend};
use codenomad_client::{Receiver, Sender, transport::WorkspaceEvent};
use std::sync::Arc;

async fn start(
    listener: &TcpListener,
    mut backend: Backend,
) -> (Request, Sender<Command>, Receiver<Event>) {
    backend.workspace = "project".into();
    backend.session = "session".into();
    let (out, events) = bounded(16);
    let (commands, input) = bounded(4);
    platform::spawn(async move {
        run_backend(backend, out, input, Arc::new(|| {}))
            .await
            .unwrap();
    });
    let mut sse = request(listener).await;
    assert!(sse.first.starts_with("GET /api/events?"));
    sse.socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
        .await
        .unwrap();
    let page = request(listener).await;
    assert_eq!(
        page.body,
        json!({"sessionID":"session","target":{"kind":"latest"}})
    );
    page.reply(200, window(&["recent"], true)).await;
    let status = request(listener).await;
    assert_eq!(
        status.first,
        "GET /workspaces/project/instance/api/session/session HTTP/1.1"
    );
    status.reply(200, json!({"data":{}})).await;
    until(&events, |event| matches!(event, Event::Sync(_))).await;
    (sse, commands, events)
}

fn window(ids: &[&str], older: bool) -> Value {
    json!({
        "status":"window",
        "messages":ids.iter().map(|id| json!({"id":id,"type":"user","text":id})).collect::<Vec<_>>(),
        "older":older.then(|| json!({"kind":"before","messageID":"recent"})),
        "newer":null,"latest":true,
    })
}

async fn until(events: &Receiver<Event>, accept: impl Fn(&Event) -> bool) -> Event {
    timeout(Duration::from_secs(4), async {
        loop {
            let event = events.recv().await.unwrap();
            if accept(&event) {
                return event;
            }
        }
    })
    .await
    .unwrap()
}

#[test]
fn settings_config_invalidation_during_pagination_keeps_the_valid_history_page() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let (mut sse, commands, events) = start(&listener, prefs.backend.take().unwrap()).await;
        commands.send(Command::Older).await.unwrap();
        let page = request(&listener).await;
        assert_eq!(
            page.body["target"],
            json!({"kind":"before","messageID":"recent"})
        );

        // The pong is a barrier: dispatch has handled the config frame before the page answers.
        sse.socket
            .write_all(
                b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\",\"value\":{}}\n\n\
            event: codenomad.client.ping\ndata: {}\n\n",
            )
            .await
            .unwrap();
        let pong = request(&listener).await;
        assert_eq!(pong.first, "POST /api/client-connections/pong HTTP/1.1");
        pong.reply(200, json!({})).await;
        page.reply(200, window(&["earlier", "recent"], false)).await;

        let mut seen = (false, false, false);
        while seen != (true, true, true) {
            match until(&events, |_| true).await {
                Event::Preferences(Owner::Config) => seen.0 = true,
                Event::Workspace(WorkspaceEvent::UiPreferencesChanged) => seen.1 = true,
                Event::Older(page) => {
                    assert_eq!(page.rows[0].id, "earlier");
                    seen.2 = true;
                }
                other => panic!("unexpected event during pagination: {other:?}"),
            }
        }
        commands.send(Command::Close).await.unwrap();
    });
}

#[test]
fn settings_failed_prompt_keeps_one_sse_subscription_and_one_config_read() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.take().unwrap();
        let (mut sse, commands, events) = start(&listener, backend.clone()).await;
        commands
            .send(Command::Send("fixture".into()))
            .await
            .unwrap();
        let prompt = request(&listener).await;
        assert_eq!(
            prompt.first,
            "POST /workspaces/project/instance/api/session/session/prompt HTTP/1.1"
        );
        prompt.reply(503, json!({})).await;
        until(&events, |event| matches!(event, Event::Failed)).await;

        let mut root = crate::init();
        prefs.backend = Some(backend);
        *root.settings.shared.borrow_mut() = prefs;
        root.phase = crate::Phase::Failed;
        root.incoming = Some(events);
        super::super::super::poll(&mut root);
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "prompt failure must not open a fallback stream"
        );

        sse.socket
            .write_all(
                b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\",\"value\":{}}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| {
            let changed = crate::poll_chat(&mut root, 8);
            super::super::super::poll(&mut root);
            changed
        })
        .await;
        let read = request(&listener).await;
        assert_eq!(
            read.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        read.reply(200, json!({"settings":{"locale":"fr"}})).await;
        wait_until(|| {
            super::super::super::poll(&mut root);
            root.settings.shared.borrow().locale() == Some("fr")
        })
        .await;
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        commands.send(Command::Close).await.unwrap();
    });
}

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
fn settings_direct_retry_replaces_a_closed_transport() {
    let (out, incoming) = bounded::<Event>(1);
    let mut root = crate::init();
    root.phase = crate::Phase::Failed;
    root.incoming = Some(incoming.clone());
    drop(out);

    let mut runtime = rune::Runtime::new(
        root,
        crate::view,
        (1100.0, 760.0),
        rune::Env::new(false, 1.0),
    );
    runtime.update(crate::retry_connection);
    assert!(runtime.state.phase == crate::Phase::Reconnecting);
    assert!(
        !runtime
            .state
            .incoming
            .as_ref()
            .unwrap()
            .same_channel(&incoming)
    );
}

#[test]
fn settings_sse_401_releases_the_transport_for_explicit_authentication() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let (out, events) = bounded(16);
        let (_commands, input) = bounded(1);
        platform::spawn(async move {
            run_backend(prefs.backend.take().unwrap(), out, input, Arc::new(|| {}))
                .await
                .unwrap();
        });
        let sse = request(&listener).await;
        assert!(sse.first.starts_with("GET /api/events?"));
        sse.reply(401, json!({})).await;
        until(&events, |event| {
            matches!(event, Event::AuthenticationRequired)
        })
        .await;
        assert!(
            timeout(Duration::from_secs(2), events.recv())
                .await
                .unwrap()
                .is_err()
        );
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
        let closed = prefs.stop_before_conversation().unwrap();
        let (out, events) = bounded(8);
        let (_commands, input) = bounded(1);
        platform::spawn(async move {
            let _ = closed.recv().await;
            let _ = run_backend(backend, out, input, Arc::new(|| {})).await;
        });
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
        drop(events);
    });
}
