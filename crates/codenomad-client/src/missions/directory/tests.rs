use super::*;

const ROW: &str = r#"{"id":"msn_one","objective":"😀","status":"active","coordinatorSessionId":"ses_one","actorCount":1,"updatedAt":2,"revision":3}"#;
// Independently generated with Node's createHash("sha256").update(`[${ROW}]`, "utf16le").
const DIGEST: &str = "xKpfN59etQ9KWRwnhQ4QLihcHpbnpqYoO2tpttprxkA";
const ORDER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn reader() -> DirectoryRead {
    let mut b = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    b.workspace = "workspace".into();
    b.mission_summaries(Some("project"), 0, None, true).unwrap()
}

fn envelope(first: bool) -> Value {
    let split = ROW.find('😀').unwrap() + '😀'.len_utf8();
    let offset = ROW[..split].encode_utf16().count();
    let characters = ROW.encode_utf16().count();
    let mut value = json!({
        "available": true, "version": 1, "projectID": "project", "source": "summaries",
        "discardedEvents": 0, "controlUnavailable": false,
        "notificationUnavailable": false, "cleanupUnavailable": false,
        "window": {"order": ORDER, "offset": 0, "end": 1, "total": 1},
        "page": {"digest": DIGEST, "total": 1, "pieces": [{
            "index": 0, "characters": characters,
            "offset": if first { 0 } else { offset },
            "text": if first { &ROW[..split] } else { &ROW[split..] },
        }]},
    });
    if first {
        value["finishHighWater"] = json!(7);
        value["page"]["next"] = json!({"digest": DIGEST, "index": 0, "offset": offset});
    }
    value
}

#[test]
fn publishes_a_verified_complete_row_with_utf16_offsets() {
    let mut read = reader();
    assert_eq!(
        read.url.path(),
        "/api/workspaces/workspace/missions/panel-page"
    );
    assert!(read.accept(envelope(true)).unwrap().is_none());
    let answer = read.accept(envelope(false)).unwrap().unwrap();
    assert_eq!(answer.project_id, "project");
    assert_eq!(answer.finish_high_water, Some(7));
    let DirectoryRows::Summaries(rows) = answer.rows else {
        panic!("summary directory");
    };
    assert_eq!(rows[0].objective, "😀");
}

#[test]
fn never_publishes_mixed_invalid_or_tampered_pages() {
    for (pointer, changed) in [
        ("/projectID", json!("other")),
        ("/source", json!("cleanups")),
        ("/window/order", json!(DIGEST)),
        ("/page/pieces/0/offset", json!(1)),
        ("/page/pieces/0/characters", json!(999_999)),
        ("/discardedEvents", json!(1)),
    ] {
        let mut read = reader();
        assert!(read.accept(envelope(true)).unwrap().is_none());
        let mut next = envelope(false);
        *next.pointer_mut(pointer).unwrap() = changed;
        assert!(read.accept(next).is_err(), "{pointer}");
    }
    let mut read = reader();
    assert!(read.accept(envelope(true)).unwrap().is_none());
    let mut tampered = envelope(false);
    tampered["page"]["pieces"][0]["text"] = json!(
        tampered["page"]["pieces"][0]["text"]
            .as_str()
            .unwrap()
            .replace("active", "failed")
    );
    assert!(read.accept(tampered).is_err());
}

#[test]
fn refuses_a_cursor_without_forward_progress() {
    let mut read = reader();
    let first = envelope(true);
    assert!(read.accept(first.clone()).unwrap().is_none());
    let mut next = envelope(false);
    next["page"]["pieces"] = json!([]);
    next["page"]["next"] = first["page"]["next"].clone();
    assert!(read.accept(next).is_err());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn http_follows_the_exact_cursor_and_keeps_the_window_order() {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
    };

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut backend =
        Backend::unauthenticated(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    backend.workspace = "workspace".into();
    let worker = std::thread::spawn(move || {
        for first in [true, false] {
            let start = Instant::now();
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            start.elapsed() < Duration::from_secs(5),
                            "missing directory request"
                        );
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = BufReader::new(&mut socket);
            let mut line = String::new();
            request.read_line(&mut line).unwrap();
            assert_eq!(
                line.trim_end(),
                "POST /api/workspaces/workspace/missions/panel-page HTTP/1.1"
            );
            let mut length = None;
            loop {
                line.clear();
                assert!(request.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("Content-Length")
                {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
            }
            let mut body = vec![0; length.unwrap()];
            request.read_exact(&mut body).unwrap();
            let request: Value = serde_json::from_slice(&body).unwrap();
            let mut expected = json!({"source":"summaries", "initial":true, "window":{"offset":0}});
            if !first {
                expected["window"]["order"] = json!(ORDER);
                expected["cursor"] = envelope(true)["page"]["next"].clone();
            }
            assert_eq!(request, expected);
            let answer = envelope(first).to_string();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                answer.len()
            )
            .unwrap();
        }
    });
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut read = backend
                .mission_summaries(Some("project"), 0, None, true)
                .unwrap();
            assert!(read.read_next().await.unwrap().is_none());
            assert_eq!(read.read_next().await.unwrap().unwrap().window.total, 1);
            assert!(
                read.read_next().await.is_err(),
                "finished reads do not make another request"
            );
        });
    worker.join().unwrap();
}
