use super::*;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};

#[test]
fn settings_uses_separate_owners_and_reads_back_an_uncertain_write_once() {
    platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
            .await
            .unwrap();
        let mut prefs = Preferences::default();
        let (wake, wakes) = bounded(8);
        prefs.main_wake = Some(std::sync::Arc::new(move || {
            let _ = wake.try_send(());
        }));
        prefs.bind(Some(backend));
        assert!(prefs.poll());
        for _ in 0..2 {
            let request = request(&listener).await;
            let data = match request.first.as_str() {
                "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" => {
                    json!({"settings":{"locale":"en"}})
                }
                "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                    json!({"appearancePreferences":{"mode":"system","light":{"scheme":{"id":"linen"}},"dark":{"scheme":{"id":"slate"}}}})
                }
                other => panic!("unexpected initial request {other}"),
            };
            request.reply(200, data).await;
        }
        for _ in 0..2 {
            timeout(Duration::from_secs(3), wakes.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert!(prefs.poll());
        assert_eq!(prefs.locale(), Some("en"));
        assert_eq!(prefs.palette(false).map(|p| p.id), Some("linen"));
        assert_eq!(prefs.palette(true).map(|p| p.id), Some("slate"));
        prefs.set_mode("dark");
        assert!(prefs.poll());
        let write = request(&listener).await;
        assert_eq!(write.first, "PATCH /api/storage/state/ui HTTP/1.1");
        assert_eq!(
            write.body,
            json!({"appearancePreferences":{"mode":"dark"},"theme":"dark"})
        );
        write.reply(503, json!({})).await;
        let read = request(&listener).await;
        assert_eq!(
            read.first,
            "GET /api/storage/state/ui?authoritative=1 HTTP/1.1"
        );
        read.reply(503, json!({})).await;
        timeout(Duration::from_secs(3), wakes.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(prefs.poll());
        assert_eq!(prefs.error(), Some("settings.preferenceSaveFailed"));
        assert_eq!(prefs.mode(), "system");
        assert_eq!(prefs.palette(true).map(|p| p.id), Some("slate"));
        assert!(!prefs.palette_ready());
        prefs.change(Owner::Config, json!({"settings":{"locale":"he"}}));
        assert!(prefs.poll());
        let write = request(&listener).await;
        assert_eq!(write.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(write.body, json!({"settings":{"locale":"he"}}));
        write.reply(200, json!({"settings":{"locale":"he"}})).await;
        timeout(Duration::from_secs(3), wakes.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(prefs.poll());
        assert_eq!(prefs.locale(), Some("he"));
        assert!(!prefs.poll());
    });
}

#[test]
fn settings_migrates_legacy_slot_before_changing_mode_and_normalizes_regional_locale() {
    platform::block_on(async {
        let mut prefs = Preferences {
            backend: Some(Backend::connect("http://127.0.0.1:9/", "").await.unwrap()),
            ..Preferences::default()
        };
        prefs.state.snapshot = Some(json!({}));
        prefs.set_mode("light");
        assert!(prefs.state.pending.is_none(), "wait for legacy config");
        prefs.config.snapshot = Some(json!({"theme":"dark","settings":{"locale":"de-DE"}}));
        assert_eq!(prefs.locale(), Some("de"));
        assert_eq!(prefs.palette(true).map(|p| p.id), Some("classic"));
        prefs.set_mode("light");
        assert_eq!(
            prefs.state.pending.unwrap(),
            json!({
                "theme":"light","appearancePreferences":{"mode":"light",
                    "dark":{"scheme":{"id":"classic","appearance":"dark"},"presetId":null}}
            })
        );
    });
}

#[test]
fn settings_palette_changes_remain_available_and_coalesce_during_an_in_flight_write() {
    platform::block_on(async {
        let mut prefs = Preferences {
            backend: Some(Backend::connect("http://127.0.0.1:9/", "").await.unwrap()),
            ..Preferences::default()
        };
        prefs.fixture();
        let select = |prefs: &mut Preferences, id| {
            prefs.set_palette(built_in().iter().find(|palette| palette.id == id).unwrap());
        };
        select(&mut prefs, "slate");
        prefs.state.writing = prefs.state.pending.take();
        let (_out, in_flight) = bounded(1);
        prefs.state.flight = Some(in_flight);
        select(&mut prefs, "fjord");
        select(&mut prefs, "basalt");
        assert_eq!(prefs.palette_display(true).map(|p| p.id), Some("basalt"));
        assert_eq!(prefs.palette(true).map(|p| p.id), Some("classic"));
        assert_eq!(
            prefs.state.pending.unwrap()["appearancePreferences"]["dark"]["scheme"]["id"],
            "basalt"
        );
    });
}

#[test]
fn settings_sse_refreshes_only_the_invalidated_owner() {
    platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
            .await
            .unwrap();
        let (sender, receiver) = bounded(8);
        let wake: rune::Waker = std::sync::Arc::new(move || {
            let _ = sender.try_send(());
        });
        let mut prefs = Preferences::default();
        prefs.bind(Some(backend));
        prefs.fixture();
        prefs.config.read = false;
        prefs.state.read = false;
        prefs.watch(&wake);
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
        stream.socket.write_all(b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\",\"value\":{\"settings\":{\"locale\":\"he\"}}}\n\n").await.unwrap();
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
        assert!(prefs.state.flight.is_none());
    });
}

struct Request {
    socket: tokio::net::TcpStream,
    first: String,
    body: Value,
}

async fn request(listener: &TcpListener) -> Request {
    timeout(Duration::from_secs(3), async {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(socket.read_u8().await.unwrap());
            assert!(header.len() < 8192);
        }
        let header = String::from_utf8(header).unwrap();
        let length = header
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or_default();
        assert!(length <= 4096);
        let mut body = vec![0; length];
        socket.read_exact(&mut body).await.unwrap();
        Request {
            socket,
            first: header.lines().next().unwrap().into(),
            body: if length == 0 {
                Value::Null
            } else {
                serde_json::from_slice(&body).unwrap()
            },
        }
    })
    .await
    .unwrap()
}

impl Request {
    async fn reply(mut self, status: u16, data: Value) {
        let body = data.to_string();
        self.socket.write_all(format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ).as_bytes()).await.unwrap();
    }
}
