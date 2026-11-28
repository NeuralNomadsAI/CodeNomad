use crate::{
    backend::Backend,
    http::Http,
    workspaces_clone::{CloneWorkspaceError, CloneWorkspaceRequest, ClonedWorkspace},
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
};

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

struct MockReply {
    status: &'static str,
    body: String,
}

type RecordedRequests = Arc<Mutex<Vec<(String, String)>>>;

fn spawn_server(replies: Vec<MockReply>) -> (Backend, RecordedRequests, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_clone = seen.clone();
    let handle = thread::spawn(move || {
        for reply in replies {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            let header_end;
            loop {
                let n = stream.read(&mut tmp).unwrap();
                if n == 0 {
                    header_end = buf.len();
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    header_end = pos + 4;
                    break;
                }
            }
            let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
            let content_len = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            while buf.len() < header_end + content_len {
                let n = stream.read(&mut tmp).unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
            }
            let req_line = head.lines().next().unwrap_or("").to_owned();
            let req_body =
                String::from_utf8_lossy(&buf[header_end..header_end + content_len]).into_owned();
            seen_clone.lock().unwrap().push((req_line, req_body));
            let response = format!(
                "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                reply.status,
                reply.body.len(),
                reply.body,
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
        }
    });
    let backend = Backend {
        client: Http::new().unwrap(),
        base: format!("http://{addr}/"),
        workspace: String::new(),
        session: String::new(),
        session_directory: None,
        client_id: "test-client".into(),
        fresh_mode: false,
    };
    (backend, seen, handle)
}

fn sample_request(cleanup: bool) -> CloneWorkspaceRequest {
    CloneWorkspaceRequest {
        repository_url: "https://github.com/NeuralNomadsAI/CodeNomad.git".into(),
        destination_path: "/home/alice/repos/CodeNomad".into(),
        cleanup,
    }
}

#[test]
fn clone_sends_strict_post_body_without_query_and_parses_201() {
    let (backend, seen, handle) = spawn_server(vec![
        MockReply {
            status: "201 Created",
            body: json!({ "path": "/home/alice/repos/CodeNomad" }).to_string(),
        },
        MockReply {
            status: "201 Created",
            body: json!({ "path": "D:\\repos\\CodeNomad" }).to_string(),
        },
    ]);

    let cloned = block_on(backend.clone_workspace_repository(&sample_request(false))).unwrap();
    assert_eq!(
        cloned,
        ClonedWorkspace {
            path: "/home/alice/repos/CodeNomad".into(),
        }
    );

    let win_req = CloneWorkspaceRequest {
        repository_url: "git@github.com:NeuralNomadsAI/CodeNomad.git".into(),
        destination_path: "D:\\repos\\CodeNomad".into(),
        cleanup: true,
    };
    let cloned_win = block_on(backend.clone_workspace_repository(&win_req)).unwrap();
    assert_eq!(
        cloned_win,
        ClonedWorkspace {
            path: "D:\\repos\\CodeNomad".into(),
        }
    );

    handle.join().unwrap();
    let recorded = seen.lock().unwrap();
    assert_eq!(recorded.len(), 2);
    assert_eq!(recorded[0].0, "POST /api/workspaces/clone HTTP/1.1");
    assert!(!recorded[0].0.contains('?'));
    let body0: Value = serde_json::from_str(&recorded[0].1).unwrap();
    assert_eq!(
        body0,
        json!({
            "repositoryUrl": "https://github.com/NeuralNomadsAI/CodeNomad.git",
            "destinationPath": "/home/alice/repos/CodeNomad",
            "cleanup": false,
        })
    );
    assert_eq!(body0.as_object().unwrap().len(), 3);

    assert_eq!(recorded[1].0, "POST /api/workspaces/clone HTTP/1.1");
    let body1: Value = serde_json::from_str(&recorded[1].1).unwrap();
    assert_eq!(
        body1,
        json!({
            "repositoryUrl": "git@github.com:NeuralNomadsAI/CodeNomad.git",
            "destinationPath": "D:\\repos\\CodeNomad",
            "cleanup": true,
        })
    );
}

#[test]
fn clone_maps_http_error_statuses_and_messages() {
    let oversized_err = format!(r#"{{"error":"{}"}}"#, "x".repeat(70 * 1024));
    let (backend, _seen, handle) = spawn_server(vec![
        MockReply {
            status: "400 Bad Request",
            body: json!({ "error": "Destination path must be absolute" }).to_string(),
        },
        MockReply {
            status: "400 Bad Request",
            body: json!({
                "statusCode": 400,
                "error": "Bad Request",
                "message": "Repository URL is required"
            })
            .to_string(),
        },
        MockReply {
            status: "400 Bad Request",
            body: "not json".into(),
        },
        MockReply {
            status: "401 Unauthorized",
            body: json!({ "error": "Unauthorized" }).to_string(),
        },
        MockReply {
            status: "404 Not Found",
            body: json!({ "error": "Not Found" }).to_string(),
        },
        MockReply {
            status: "501 Not Implemented",
            body: json!({ "error": "Not Implemented" }).to_string(),
        },
        MockReply {
            status: "503 Service Unavailable",
            body: json!({ "error": "Unavailable" }).to_string(),
        },
        MockReply {
            status: "409 Conflict",
            body: json!({ "error": "Destination folder already exists" }).to_string(),
        },
        MockReply {
            status: "409 Conflict",
            body: oversized_err,
        },
        MockReply {
            status: "500 Internal Server Error",
            body: json!({ "error": "git clone failed" }).to_string(),
        },
        MockReply {
            status: "500 Internal Server Error",
            body: String::new(),
        },
    ]);

    let req = sample_request(false);
    assert_eq!(
        block_on(backend.clone_workspace_repository(&req)),
        Err(CloneWorkspaceError::BadRequest(Some(
            "Destination path must be absolute".into()
        )))
    );
    assert_eq!(
        block_on(backend.clone_workspace_repository(&req)),
        Err(CloneWorkspaceError::BadRequest(Some(
            "Repository URL is required".into()
        )))
    );
    assert_eq!(
        block_on(backend.clone_workspace_repository(&req)),
        Err(CloneWorkspaceError::BadRequest(None))
    );
    assert_eq!(
        block_on(backend.clone_workspace_repository(&req)),
        Err(CloneWorkspaceError::Unauthorized)
    );
    assert_eq!(
        block_on(backend.clone_workspace_repository(&req)),
        Err(CloneWorkspaceError::Unavailable)
    );
    assert_eq!(
        block_on(backend.clone_workspace_repository(&req)),
        Err(CloneWorkspaceError::Unavailable)
    );
    assert_eq!(
        block_on(backend.clone_workspace_repository(&req)),
        Err(CloneWorkspaceError::Unavailable)
    );
    assert_eq!(
        block_on(backend.clone_workspace_repository(&req)),
        Err(CloneWorkspaceError::Conflict(Some(
            "Destination folder already exists".into()
        )))
    );
    assert_eq!(
        block_on(backend.clone_workspace_repository(&req)),
        Err(CloneWorkspaceError::Conflict(None))
    );
    assert_eq!(
        block_on(backend.clone_workspace_repository(&req)),
        Err(CloneWorkspaceError::Other("git clone failed".into()))
    );
    assert_eq!(
        block_on(backend.clone_workspace_repository(&req)),
        Err(CloneWorkspaceError::Other("HTTP 500".into()))
    );

    handle.join().unwrap();
}

#[test]
fn clone_rejects_invalid_and_oversized_success_payloads() {
    let overlong_path = format!("/{}", "a".repeat(4096));
    let oversized_body = format!(r#"{{"path":"/ok","pad":"{}"}}"#, "x".repeat(260 * 1024));
    let (backend, _seen, handle) = spawn_server(vec![
        MockReply {
            status: "201 Created",
            body: json!({}).to_string(),
        },
        MockReply {
            status: "201 Created",
            body: json!({ "path": "" }).to_string(),
        },
        MockReply {
            status: "201 Created",
            body: json!({ "path": "relative/path" }).to_string(),
        },
        MockReply {
            status: "201 Created",
            body: json!({ "path": overlong_path }).to_string(),
        },
        MockReply {
            status: "201 Created",
            body: "not-json".into(),
        },
        MockReply {
            status: "201 Created",
            body: oversized_body,
        },
    ]);

    let req = sample_request(false);
    for case in [
        "missing path",
        "empty path",
        "relative path",
        "path exceeding MAX_PATH_UTF16",
        "invalid json",
        "oversized response",
    ] {
        let result = block_on(backend.clone_workspace_repository(&req));
        assert!(
            matches!(result, Err(CloneWorkspaceError::Other(_))),
            "expected Other error for {case}, got {result:?}"
        );
    }

    handle.join().unwrap();
}
