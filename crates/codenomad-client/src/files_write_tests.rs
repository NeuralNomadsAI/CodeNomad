use crate::{
    backend::Backend,
    files::{MAX_FILE_BYTES, WriteConflict, WriteResult},
    http::Http,
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
    thread,
    time::Duration,
};

fn backend(base: String) -> Backend {
    Backend {
        client: Http::new().unwrap(),
        base,
        workspace: "workspace".into(),
        session: "session".into(),
        client_id: "write-fixture".into(),
        session_directory: None,
        fresh_mode: false,
    }
}
fn run(test: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test)
}

#[test]
fn conditional_write_preserves_scope_bytes_and_opaque_version_without_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let b = backend(format!("http://{}/", listener.local_addr().unwrap()));
    let (out, received) = mpsc::channel();
    let worker = thread::spawn(move || {
        for status in [204, 409, 403, 302] {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                assert!(header.len() < 32768);
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
            }
            let header = String::from_utf8(header).unwrap();
            let length = header
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(length < 4096);
            let mut body = vec![0; length];
            socket.read_exact(&mut body).unwrap();
            out.send((header, serde_json::from_slice::<Value>(&body).unwrap()))
                .unwrap();
            write!(
                socket,
                "HTTP/1.1 {status} Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        }
    });
    run(async {
        let version = "opaque W/\"été:version\"";
        let text = "日本語 🦀\n\t\"quoted\"\r\n";
        assert_eq!(
            b.write_file(r"D:\Projet 日本", "src é&?/空.txt", text, version)
                .await
                .unwrap(),
            WriteResult::Saved(None)
        );
        assert_eq!(
            b.write_file(r"D:\Projet 日本", "src é&?/空.txt", text, version)
                .await
                .unwrap(),
            WriteResult::Conflict(WriteConflict::Other)
        );
        assert!(
            b.write_file(r"D:\Projet 日本", "src é&?/空.txt", text, version)
                .await
                .is_err()
        );
        assert!(
            b.write_file(r"D:\Projet 日本", "src é&?/空.txt", text, version)
                .await
                .is_err()
        );
        for _ in 0..4 {
            let (header, body) = received.recv_timeout(Duration::from_secs(3)).unwrap();
            assert_eq!(
                header.lines().next().unwrap(),
                "PUT /api/workspaces/workspace/files/content?path=src+%C3%A9%26%3F%2F%E7%A9%BA.txt&directory=D%3A%5CProjet+%E6%97%A5%E6%9C%AC HTTP/1.1"
            );
            assert!(!header.to_ascii_lowercase().contains("if-match:"));
            assert_eq!(body, json!({"contents":text,"expectedVersion":version}));
        }
    });
    worker.join().unwrap();
    assert!(received.try_recv().is_err());
}

#[test]
fn invalid_or_unversioned_writes_fail_before_dispatch() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut b = backend(format!("http://{}/", listener.local_addr().unwrap()));
    run(async {
        for (directory, path) in [
            ("relative", "file"),
            ("/trial", "../file"),
            ("/trial", "."),
            ("/trial", "/file"),
            ("/trial", "a\\b"),
            ("/trial", "a\0b"),
        ] {
            assert!(
                b.write_file(directory, path, "text", "version")
                    .await
                    .is_err()
            );
        }
        assert!(b.write_file("/trial", "file", "text", "").await.is_err());
        assert!(
            b.write_file("/trial", "file", &"x".repeat(MAX_FILE_BYTES + 1), "v")
                .await
                .is_err()
        );
        assert!(
            b.write_file("/trial", "file", &"\0".repeat(MAX_FILE_BYTES), "v")
                .await
                .is_err()
        );
        b.workspace = "../foreign".into();
        assert!(b.write_file("/trial", "file", "text", "v").await.is_err());
    });
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );
}

#[test]
fn write_conflict_reasons_are_classified_into_typed_variants() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let b = backend(format!("http://{}/", listener.local_addr().unwrap()));
    let replies: Vec<&[u8]> = vec![
        br#"{"error":"File changed on disk"}"#,
        br#"{"error":"Worktree deletion is in progress"}"#,
        br#"{"error":"Unexpected conflict"}"#,
        b"",
    ];
    let worker = thread::spawn(move || {
        for body in replies {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                assert!(header.len() < 32768);
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
            }
            let header = String::from_utf8(header).unwrap();
            let length = header
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            let mut req_body = vec![0; length];
            socket.read_exact(&mut req_body).unwrap();
            write!(
                socket,
                "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(body).unwrap();
        }
    });
    run(async {
        for expected in [
            WriteConflict::ChangedOnDisk,
            WriteConflict::WorktreeDeleting,
            WriteConflict::Other,
            WriteConflict::Other,
        ] {
            assert_eq!(
                b.write_file("/trial", "code.bin", "hello", "\"v1\"")
                    .await
                    .unwrap(),
                WriteResult::Conflict(expected)
            );
        }
    });
    worker.join().unwrap();
}
