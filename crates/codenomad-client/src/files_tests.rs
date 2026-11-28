use crate::{
    backend::{Backend, read_json},
    files::{EntryKind, FileError, ListingTooLarge, MAX_ENTRIES, MAX_FILE_BYTES},
    http::{Http, is_unauthorized},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

struct Server {
    backend: Backend,
    requests: Arc<Mutex<Vec<String>>>,
    stop: mpsc::Sender<()>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(responses: Vec<(u16, Vec<u8>)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let received = requests.clone();
        let (stop, stopped) = mpsc::channel();
        let worker = thread::spawn(move || {
            for (status, body) in responses {
                let end = Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    if stopped.try_recv().is_ok() {
                        return;
                    }
                    assert!(Instant::now() < end, "expected Files HTTP request");
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(e) => panic!("fixture accept: {e}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    assert!(header.len() < 32768);
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap();
                let line = header.lines().next().unwrap().to_string();
                assert!(line.starts_with("GET "), "Files reads never mutate");
                received.lock().unwrap().push(line);
                let header = format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                if socket.write_all(header.as_bytes()).is_ok() {
                    let _ = socket.write_all(&body);
                }
            }
        });
        Self {
            backend: Backend {
                client: Http::new().unwrap(),
                base,
                workspace: "workspace".into(),
                session: String::new(),
                client_id: "files-fixture".into(),
                session_directory: None,
                fresh_mode: false,
            },
            requests,
            stop,
            worker: Some(worker),
        }
    }
    fn json(responses: Vec<Value>) -> Self {
        Self::new(
            responses
                .into_iter()
                .map(|v| (200, serde_json::to_vec(&v).unwrap()))
                .collect(),
        )
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
fn run(test: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test)
}
fn preview(bytes: &[u8]) -> Value {
    json!({"workspaceId":"workspace","relativePath":"code.bin","encoding":"base64","contents":STANDARD.encode(bytes),"version":"opaque W/\"v:été\""})
}

#[test]
fn listing_limit_is_distinct_from_an_unrelated_bad_request() {
    run(async {
        let server = Server::new(vec![
            (400, br#"{"error":"Directory listing too large"}"#.to_vec()),
            (400, br#"{"error":"Invalid file path"}"#.to_vec()),
            (
                200,
                serde_json::to_vec(&vec![Value::Null; MAX_ENTRIES + 1]).unwrap(),
            ),
        ]);
        for too_large in [true, false, true] {
            let error = server.backend.files("/trial", "src").await.unwrap_err();
            assert_eq!(error.is::<ListingTooLarge>(), too_large);
        }
    });
}

#[test]
fn files_wire_encodes_server_paths_and_retains_metadata() {
    run(async {
        let server = Server::json(vec![json!([
            {"name":"空 &?.rs","path":"src é&?/空 &?.rs","type":"file","size":12,"modifiedAt":"opaque timestamp","absolutePath":"D:/Projet 日本/src é&?/空 &?.rs"},
            {"name":"dossier","path":"src é&?/dossier","type":"directory","directoryIdentity":"opaque-id"}
        ])]);
        let rows = server
            .backend
            .files(r"D:\Projet 日本", "src é&?")
            .await
            .unwrap();
        assert_eq!(rows[0].kind, EntryKind::File);
        assert_eq!(rows[0].size, Some(12));
        assert_eq!(rows[0].modified_at.as_deref(), Some("opaque timestamp"));
        assert_eq!(rows[1].directory_identity.as_deref(), Some("opaque-id"));
        assert_eq!(
            server.requests.lock().unwrap().as_slice(),
            [
                "GET /api/workspaces/workspace/files?path=src+%C3%A9%26%3F&directory=D%3A%5CProjet+%E6%97%A5%E6%9C%AC HTTP/1.1"
            ]
        );
    })
}

#[test]
fn posix_drive_like_names_remain_relative_through_listing_and_preview() {
    run(async {
        let mut body = preview(b"POSIX bytes");
        body["relativePath"] = json!("a:/file");
        let server = Server::json(vec![
            json!([{"name":"a:","path":"a:","type":"directory"}]),
            json!([{"name":"file","path":"a:/file","type":"file"}]),
            body,
        ]);
        assert_eq!(
            server.backend.files("/trial", ".").await.unwrap()[0].path,
            "a:"
        );
        assert_eq!(
            server.backend.files("/trial", "a:").await.unwrap()[0].path,
            "a:/file"
        );
        assert_eq!(
            server
                .backend
                .preview_file("/trial", "a:/file")
                .await
                .unwrap()
                .bytes,
            b"POSIX bytes"
        );
        assert_eq!(server.requests.lock().unwrap().len(), 3);
    });
}

#[test]
fn previews_preserve_unicode_binary_and_the_full_server_file_bound() {
    run(async {
        let unicode = "été\n日本語🦀".as_bytes();
        let binary: Vec<u8> = (0..=255).collect();
        let full = vec![0x93; MAX_FILE_BYTES];
        let server = Server::json(vec![preview(unicode), preview(&binary), preview(&full)]);
        for bytes in [unicode, binary.as_slice(), full.as_slice()] {
            let result = server
                .backend
                .preview_file("/trial", "code.bin")
                .await
                .unwrap();
            assert_eq!(result.bytes, bytes);
            assert_eq!(result.path, "code.bin");
            assert_eq!(result.workspace_id, "workspace");
            assert_eq!(result.version.as_deref(), Some("opaque W/\"v:été\""));
        }
        assert!(server.requests.lock().unwrap().iter().all(|line| line ==
            "GET /api/workspaces/workspace/files/preview?path=code.bin&directory=%2Ftrial HTTP/1.1"));
    })
}

#[test]
fn foreign_corrupt_and_oversized_previews_fail_without_fallback() {
    run(async {
        let mut cases = Vec::new();
        for (key, value) in [
            ("workspaceId", json!("another")),
            ("relativePath", json!("other.bin")),
            ("encoding", json!("utf-8")),
            ("contents", json!("!!!!")),
            ("contents", json!("Zh==")),
            ("version", json!(17)),
        ] {
            let mut data = preview(b"hello");
            data[key] = value;
            cases.push(data);
        }
        // +1 fits the base64 length ceiling, so the decoded-byte ceiling must also hold.
        cases.push(preview(&vec![0; MAX_FILE_BYTES + 1]));
        cases.push(preview(&vec![0; MAX_FILE_BYTES + 3]));
        let count = cases.len();
        let server = Server::json(cases);
        for _ in 0..count {
            assert!(
                server
                    .backend
                    .preview_file("/trial", "code.bin")
                    .await
                    .is_err()
            );
        }
        assert_eq!(server.requests.lock().unwrap().len(), count);
    })
}

#[test]
fn listing_rejects_foreign_duplicates_shapes_and_count_overflow() {
    run(async {
        let entry = json!({"name":"file","path":"file","type":"file"});
        let mut cases = vec![json!({}), json!([entry.clone(), entry.clone()])];
        for change in [
            json!({"path":"other/file"}),
            json!({"path":"../file"}),
            json!({"name":"different"}),
            json!({"type":"symlink"}),
            json!({"size":-1}),
            json!({"directoryIdentity":false}),
            json!({"absolutePath":"relative"}),
        ] {
            let mut row = entry.clone();
            row.as_object_mut()
                .unwrap()
                .extend(change.as_object().unwrap().clone());
            cases.push(json!([row]));
        }
        cases.push(json!(vec![entry; MAX_ENTRIES + 1]));
        let count = cases.len();
        let server = Server::json(cases);
        for _ in 0..count {
            assert!(server.backend.files("/trial", ".").await.is_err());
        }
        assert_eq!(server.requests.lock().unwrap().len(), count);
    })
}

#[test]
fn invalid_scopes_do_not_dispatch_any_http_request() {
    run(async {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut b = Backend {
            client: Http::new().unwrap(),
            base: format!("http://{}/", listener.local_addr().unwrap()),
            workspace: "workspace".into(),
            session: String::new(),
            client_id: "fixture".into(),
            session_directory: None,
            fresh_mode: false,
        };
        for directory in ["", "relative", "C:relative", "/bad\0dir"] {
            assert!(b.files(directory, ".").await.is_err());
            assert!(b.preview_file(directory, "file").await.is_err());
        }
        for path in [
            "",
            "/absolute",
            "../file",
            "a/../file",
            "a//file",
            r"a\file",
            "a\0file",
        ] {
            assert!(b.files("/trial", path).await.is_err());
            assert!(b.preview_file("/trial", path).await.is_err());
        }
        assert!(b.preview_file("/trial", ".").await.is_err());
        for directory in ["D:/trial", r"\\server\share\trial"] {
            for path in ["D:/absolute", "a:/file"] {
                assert!(b.files(directory, path).await.is_err());
                assert!(b.preview_file(directory, path).await.is_err());
            }
        }
        b.workspace = "foreign/route".into();
        assert!(b.files("/trial", ".").await.is_err());
        assert!(b.preview_file("/trial", "file").await.is_err());
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    })
}

#[test]
fn malformed_http_errors_and_json_byte_bounds_are_preserved() {
    run(async {
        let huge = format!("\"{}\"", "x".repeat(2 * 1024 * 1024));
        let preview_huge = vec![b' '; MAX_FILE_BYTES.div_ceil(3) * 4 + 64 * 1024 + 1];
        let server = Server::new(vec![
            (200, b"{".to_vec()),
            (403, b"{}".to_vec()),
            (200, huge.clone().into_bytes()),
            (200, preview_huge),
            (200, huge.into_bytes()),
        ]);
        assert!(server.backend.files("/trial", ".").await.is_err());
        assert!(
            server
                .backend
                .preview_file("/trial", "code.bin")
                .await
                .is_err()
        );
        assert!(server.backend.files("/trial", ".").await.is_err());
        assert!(
            server
                .backend
                .preview_file("/trial", "code.bin")
                .await
                .is_err()
        );
        let response = server
            .backend
            .client
            .get(format!("{}default-budget", server.backend.base))
            .send()
            .await
            .unwrap();
        assert!(
            read_json(response).await.is_err(),
            "ordinary client JSON stays at 2 MiB"
        );
    })
}

#[test]
fn typed_file_errors_cover_http_transport_and_validation_without_raw_details() {
    let assert_typed = |error: crate::history::Error, expected: FileError| {
        assert_eq!(
            error.downcast_ref::<FileError>().copied(),
            Some(expected),
            "unexpected error: {error}"
        );
        let text = error.to_string().to_ascii_lowercase();
        for forbidden in [
            "reqwest",
            "error sending request",
            "status code",
            "http status",
            "127.0.0.1",
            "http://",
        ] {
            assert!(
                !text.contains(forbidden),
                "raw detail `{forbidden}` leaked into `{text}`"
            );
        }
    };
    run(async {
        let server = Server::new(vec![
            (401, br#"{"error":"Unauthorized"}"#.to_vec()),
            (403, br#"{"error":"Forbidden"}"#.to_vec()),
            (404, br#"{"error":"Workspace not found"}"#.to_vec()),
            (404, br#"{"error":"Missing"}"#.to_vec()),
            (409, br#"{"error":"Conflict"}"#.to_vec()),
            (413, br#"{"error":"Too large"}"#.to_vec()),
            (
                400,
                br#"{"error":"Selected file is too large to attach"}"#.to_vec(),
            ),
            (
                400,
                br#"{"error":"Access outside of root is not allowed"}"#.to_vec(),
            ),
            (
                400,
                br#"{"error":"Directory is not owned by this workspace"}"#.to_vec(),
            ),
            (400, br#"{"error":"Selected path is unavailable"}"#.to_vec()),
            (400, br#"{"error":"Bad request"}"#.to_vec()),
            (500, br#"{"error":"Internal boom"}"#.to_vec()),
            (200, b"{not-json".to_vec()),
            (
                200,
                serde_json::to_vec(&json!({
                    "workspaceId": "workspace",
                    "relativePath": "code.bin",
                    "encoding": "utf-8",
                    "contents": "YQ=="
                }))
                .unwrap(),
            ),
            (
                200,
                serde_json::to_vec(&json!({
                    "workspaceId": "workspace",
                    "relativePath": "code.bin",
                    "encoding": "base64",
                    "contents": "not-valid-base64!!!"
                }))
                .unwrap(),
            ),
            (
                200,
                serde_json::to_vec(&preview(&vec![0; MAX_FILE_BYTES + 1])).unwrap(),
            ),
        ]);
        let unauthorized = server
            .backend
            .preview_file("/trial", "code.bin")
            .await
            .unwrap_err();
        assert!(is_unauthorized(&unauthorized));
        assert_typed(unauthorized, FileError::Unauthorized);

        for expected in [
            FileError::AccessDenied,
            FileError::WorkspaceUnavailable,
            FileError::NotFound,
            FileError::Conflict,
            FileError::TooLarge,
            FileError::TooLarge,
            FileError::AccessDenied,
            FileError::AccessDenied,
            FileError::Unavailable,
            FileError::InvalidRequest,
            FileError::Server,
            FileError::UnexpectedResponse,
            FileError::InvalidEncoding,
            FileError::InvalidEncoding,
            FileError::TooLarge,
        ] {
            let err = server
                .backend
                .preview_file("/trial", "code.bin")
                .await
                .unwrap_err();
            assert_typed(err, expected);
        }

        // Closed port -> Transport error with no raw reqwest URL or text.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_base = format!("http://{}/", closed.local_addr().unwrap());
        drop(closed);
        let offline = Backend {
            client: Http::new().unwrap(),
            base: closed_base,
            workspace: "workspace".into(),
            session: String::new(),
            client_id: "files-offline".into(),
            session_directory: None,
            fresh_mode: false,
        };
        assert_typed(
            offline.files("/trial", ".").await.unwrap_err(),
            FileError::Transport,
        );
        assert_typed(
            offline
                .preview_file("/trial", "code.bin")
                .await
                .unwrap_err(),
            FileError::Transport,
        );
        assert_typed(
            offline
                .write_file("/trial", "code.bin", "hello", "\"v1\"")
                .await
                .unwrap_err(),
            FileError::Transport,
        );
        assert_typed(
            offline.files("/trial", "../escape").await.unwrap_err(),
            FileError::InvalidRequest,
        );
        assert_typed(
            offline
                .write_file("/trial", "code.bin", "hello", "")
                .await
                .unwrap_err(),
            FileError::InvalidRequest,
        );
    });
}

#[test]
#[ignore = "requires the explicit private files-fixture manifest and real Rust server"]
fn real_rust_files_read_contract() {
    use std::{fs, path::PathBuf};
    let manifest = PathBuf::from(
        std::env::var_os("RUNE_FILES_TEST_MANIFEST").expect("explicit Files manifest"),
    );
    let package = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let base = package
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("target/rune-files-tests");
    assert!(manifest.is_absolute() && manifest.starts_with(&base));
    assert_eq!(manifest.file_name().unwrap(), "manifest.json");
    let root = fs::canonicalize(manifest.parent().unwrap()).unwrap();
    let base = fs::canonicalize(base).unwrap();
    assert!(
        root.starts_with(base)
            && root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("trial-")
    );
    assert_eq!(
        fs::canonicalize(&manifest).unwrap(),
        root.join("manifest.json")
    );
    let data: Value = serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
    let project = data["directory"].as_str().unwrap();
    assert_eq!(fs::canonicalize(project).unwrap(), root.join("project"));
    let foreign = data["foreign"].as_str().unwrap();
    assert_eq!(fs::canonicalize(foreign).unwrap(), root.join("foreign"));
    let origin = data["origin"].as_str().unwrap();
    let url = reqwest::Url::parse(origin).unwrap();
    assert_eq!(url.scheme(), "http");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert!(url.port().is_some() && url.username().is_empty() && url.password().is_none());
    let password = std::env::var("RUNE_FILES_TEST_PASSWORD").expect("ephemeral fixture password");
    run(async {
        let mut backend = Backend::connect(origin, &password).await.unwrap();
        backend.workspace = data["workspaceId"].as_str().unwrap().into();
        let rows = backend.files(project, ".").await.unwrap();
        let folder = rows.iter().find(|r| r.path == "nested").unwrap();
        assert_eq!(folder.kind, EntryKind::Directory);
        assert!(
            folder
                .directory_identity
                .as_ref()
                .is_some_and(|v| !v.is_empty())
        );
        let again = backend.files(project, ".").await.unwrap();
        assert_eq!(
            again
                .iter()
                .find(|r| r.path == "nested")
                .unwrap()
                .directory_identity,
            folder.directory_identity
        );
        assert!(backend.files(project, "empty").await.unwrap().is_empty());
        let nested = backend.files(project, "nested").await.unwrap();
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0].path, "nested/日本語.txt");
        let unicode = backend
            .preview_file(project, "été 日本語.txt")
            .await
            .unwrap();
        assert_eq!(unicode.bytes, "été\n日本語🦀\r\n".as_bytes());
        let stable = backend
            .preview_file(project, "été 日本語.txt")
            .await
            .unwrap();
        assert!(unicode.version.as_ref().is_some_and(|v| !v.is_empty()));
        assert_eq!(stable.version, unicode.version);
        let changed = "modifié 🦀\nseconde lecture";
        // The only write is an external filesystem edit of the validated private project.
        fs::write(root.join("project/été 日本語.txt"), changed).unwrap();
        let updated = backend
            .preview_file(project, "été 日本語.txt")
            .await
            .unwrap();
        assert_eq!(updated.bytes, changed.as_bytes());
        assert_ne!(updated.version, unicode.version);
        assert!(
            backend
                .preview_file(project, "empty.txt")
                .await
                .unwrap()
                .bytes
                .is_empty()
        );
        assert_eq!(
            backend
                .preview_file(project, "binary.bin")
                .await
                .unwrap()
                .bytes,
            [0, 1, 255, 128, 0, 42]
        );
        assert_eq!(
            backend
                .preview_file(project, "full.bin")
                .await
                .unwrap()
                .bytes,
            vec![0x93; MAX_FILE_BYTES]
        );
        assert!(
            backend
                .preview_file(project, "oversized.bin")
                .await
                .is_err()
        );
        assert!(backend.preview_file(project, "absent.txt").await.is_err());
        assert!(backend.preview_file(project, "empty").await.is_err());
        assert!(backend.files(foreign, ".").await.is_err());
        assert!(backend.preview_file(foreign, "foreign.txt").await.is_err());
        let outward = data["outwardLink"].as_bool().unwrap();
        if outward {
            assert_eq!(
                backend
                    .preview_file(project, "outward/foreign.txt")
                    .await
                    .unwrap()
                    .bytes,
                b"private sibling bytes"
            );
        }
        let protected = data["protectedLink"].as_bool().unwrap();
        if protected {
            assert!(
                backend
                    .preview_file(project, "protected/private.txt")
                    .await
                    .is_err()
            );
        }
        println!(
            "{}",
            json!({"type":"files-native-proof","result":"ok","entries":rows.len(),
            "fileByteLimit":MAX_FILE_BYTES,"stableThenChangedVersion":true,"directoryIdentity":true,
            "foreignDirectoryRefused":true,"outwardLinkReadable":outward,"protectedGitLinkRefused":protected,
            "mutations":"external private file edit only"})
        );
    });
}
