use super::*;
use rune::{Env, Runtime};
use serde_json::json;

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn hidden_tab_parks_receipt_reads_and_reconnect_replays_the_open_pages() {
    use codenomad_client::transport::{Event, WorkspaceEvent};
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        time::timeout,
    };

    crate::platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut backend =
            Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                .await
                .unwrap();
        backend.workspace = "workspace".into();
        backend.session = "ses_fixture".into();
        let mut s = crate::init();
        s.phase = crate::Phase::Ready;
        let (out, incoming) = bounded(8);
        s.incoming = Some(incoming);
        s.transcript_display.receipts.bind(backend);

        async fn serve(listener: &TcpListener, cursor: Option<&str>, next: Option<&str>) {
            let (mut socket, _) = timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                assert!(request.len() < 4096);
                request.push(socket.read_u8().await.unwrap());
            }
            let request = String::from_utf8(request).unwrap();
            let line = request.lines().next().unwrap();
            assert!(line.starts_with(
                "GET /api/workspaces/workspace/sessions/ses_fixture/permission-receipts?"
            ));
            assert!(line.contains("unanchored=true"));
            assert_eq!(line.contains("cursor="), cursor.is_some());
            if let Some(cursor) = cursor {
                assert!(line.contains(&format!("cursor={cursor}")));
            }
            let body = json!({"receipts":[{
                "requestId":if cursor.is_some() {"two"} else {"one"}, "sessionId":"ses_fixture",
                "decision":"once","origin":"native","resources":[]
            }],"next":next})
            .to_string();
            socket.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ).as_bytes()).await.unwrap();
        }

        async fn settle(s: &mut State, count: usize) {
            timeout(Duration::from_secs(5), async {
                while s.transcript_display.receipts.entries[&None].job.is_some() {
                    crate::chat::events::poll_chat(s, 8);
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            let entry = &s.transcript_display.receipts.entries[&None];
            assert_eq!(entry.receipt.len(), count);
            assert_eq!(entry.pages, count);
        }

        crate::chat::events::poll_chat(&mut s, 8);
        serve(&listener, None, Some("page-b")).await;
        settle(&mut s, 1).await;
        s.transcript_display
            .receipts
            .start(&None, true, &s.reads, &s.wake);
        serve(&listener, Some("page-b"), None).await;
        settle(&mut s, 2).await;

        crate::chat::suspend(&mut s);
        out.try_send(Event::AgentHint(true)).unwrap();
        out.try_send(Event::Workspace(
            WorkspaceEvent::PermissionReceiptsChanged { message: None },
        ))
        .unwrap();
        crate::chat::events::poll_hidden_chat(&mut s, 8, true);
        assert!(s.incoming.as_ref().unwrap().is_empty());
        let entry = &s.transcript_display.receipts.entries[&None];
        assert!(entry.dirty && entry.job.is_none());
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );

        crate::chat::events::poll_chat(&mut s, 8);
        // The new first page supplies a new cursor; the old snapshot stays visible.
        serve(&listener, None, Some("page-c")).await;
        assert_eq!(
            s.transcript_display.receipts.entries[&None].receipt.len(),
            2
        );
        serve(&listener, Some("page-c"), Some("page-d")).await;
        settle(&mut s, 2).await;
        assert_eq!(
            s.transcript_display.receipts.entries[&None].next.as_deref(),
            Some("page-d")
        );
    });
}

#[test]
fn receipts_are_anchored_without_becoming_native_message_parts() {
    let mut state = crate::init();
    state.phase = crate::Phase::Ready;
    for (id, body) in [("first", "First native text"), ("last", "Last native text")] {
        state.messages.push(
            crate::history::decode_message(&json!({
                "id":id,"type":"user","text":body,
            }))
            .unwrap()
            .into(),
        );
    }
    for (message, reason) in [
        (Some("first"), "Anchored reason"),
        (None, "Unanchored reason"),
    ] {
        let receipt = serde_json::from_value(json!({
            "requestId": "confirmed", "sessionId":"ses_fixture", "decision":"once",
            "origin":"codenomad", "resources":["fixtures/**"], "reason":reason,
            "source":message.map(|id| json!({"messageId":id,"callId":"call"}))
        }))
        .unwrap();
        state.transcript_display.receipts.entries.insert(
            message.map(str::to_owned),
            Entry {
                receipt: vec![receipt],
                ..Entry::default()
            },
        );
    }
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    let reason = tree.find("Anchored reason").unwrap();
    assert!(
        tree.find("First native text").unwrap() < reason
            && reason < tree.find("Last native text").unwrap()
    );
    assert!(!tree.contains("Unanchored reason"));
    for row in &rt.state.messages {
        assert!(row.parts.is_empty() && !row.body.contains("reason"));
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn launcher_chat_and_inactive_transcript_do_not_spin_receipt_wakes() {
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        time::timeout,
    };

    crate::platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut backend =
            Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                .await
                .unwrap();
        backend.workspace = "workspace".into();
        backend.session = "ses_fixture".into();
        let mut s = crate::init();
        s.screen = crate::screen::Screen::Chat {
            launcher: Some(Box::new(crate::launcher::Launcher::new(
                std::sync::Arc::new(|| {}),
            ))),
        };
        s.phase = crate::Phase::Ready;
        s.messages.push(
            crate::history::decode_message(&json!({
                "id": "msg_1", "type": "user", "text": "Hello from launcher chat"
            }))
            .unwrap()
            .into(),
        );
        s.transcript_display.receipts.bind(backend);

        let server = tokio::spawn(async move {
            let mut served = 0usize;
            while let Ok(Ok((mut socket, _))) =
                timeout(Duration::from_secs(3), listener.accept()).await
            {
                let mut req = Vec::new();
                while !req.ends_with(b"\r\n\r\n") && req.len() < 4096 {
                    let Ok(byte) = socket.read_u8().await else {
                        break;
                    };
                    req.push(byte);
                }
                let body = r#"{"receipts":[],"next":null}"#;
                let _ = socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await;
                served += 1;
                if served >= 2 {
                    break;
                }
            }
            served
        });

        let mut rt = Runtime::new(
            s,
            |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
            (960.0, 900.0),
            Env::new(false, 1.0),
        );
        rt.poll = Some(crate::poll);
        rt.frame(0.0);
        for _ in 0..40 {
            rt.frame(1.0 / 60.0);
            tokio::time::sleep(Duration::from_millis(5)).await;
            if rt
                .state
                .transcript_display
                .receipts
                .entries
                .get(&Some("msg_1".into()))
                .is_some_and(|entry| !entry.dirty && entry.job.is_none())
            {
                break;
            }
        }
        assert!(
            rt.state
                .transcript_display
                .receipts
                .entries
                .get(&Some("msg_1".into()))
                .is_some_and(|entry| !entry.dirty && entry.job.is_none()),
            "launcher-opened chat must fetch and settle visible message receipts"
        );
        for _ in 0..10 {
            rt.frame(1.0 / 60.0);
        }
        assert!(
            rt.wake_deadline().is_none(),
            "settled launcher chat must not keep scheduling receipt wakes: {:?}",
            rt.wake_deadline()
        );

        // When the transcript is inactive (Reconnecting/Failed), dirty visible rows must not
        // spin wake_after(Duration::ZERO) on every frame.
        rt.update(|s, _| {
            s.phase = crate::Phase::Reconnecting;
            s.transcript_display
                .receipts
                .invalidate(Some("msg_1".into()));
        });
        for _ in 0..10 {
            rt.frame(1.0 / 60.0);
        }
        assert!(
            rt.wake_deadline().is_none(),
            "inactive reconnecting transcript must not spin receipt wakes: {:?}",
            rt.wake_deadline()
        );

        let served = server.await.unwrap();
        assert!(
            served >= 2,
            "expected unanchored + anchored receipt fetches, got {served}"
        );
    });
}
