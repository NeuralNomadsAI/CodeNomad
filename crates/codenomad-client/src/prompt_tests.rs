use crate::{
    backend::{Backend, read_json},
    content::Part,
    history,
    http::Http,
    prompt::{Agent, Delivery, File, FileSource, Mention, Prompt, Skill},
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
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    stop: mpsc::Sender<()>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(responses: Vec<Value>) -> Self {
        Self::bodies(
            responses
                .into_iter()
                .map(|value| serde_json::to_vec(&value).unwrap())
                .collect(),
        )
    }
    fn bodies(responses: Vec<Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let received = requests.clone();
        let (stop, stopped) = mpsc::channel();
        let worker = thread::spawn(move || {
            for response in responses {
                let end = Instant::now() + Duration::from_secs(10);
                let mut socket = loop {
                    if stopped.try_recv().is_ok() {
                        return;
                    }
                    assert!(Instant::now() < end, "expected prompt HTTP request");
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
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    assert!(header.len() < 32768);
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap();
                let size = header
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                assert!(size <= 32 * 1024 * 1024);
                let mut bytes = vec![0; size];
                socket.read_exact(&mut bytes).unwrap();
                let body = if bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                };
                let content_type =
                    if header.starts_with("GET /api/workspaces/workspace/session-attachment/") {
                        "application/octet-stream"
                    } else {
                        "application/json"
                    };
                received
                    .lock()
                    .unwrap()
                    .push((header.lines().next().unwrap().into(), body));
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                );
                if socket.write_all(header.as_bytes()).is_ok() {
                    let _ = socket.write_all(&response);
                }
            }
        });
        Self {
            backend: Backend {
                client: Http::new().unwrap(),
                base,
                workspace: "workspace".into(),
                session: "session".into(),
                client_id: "prompt-fixture".into(),
                fresh_mode: false,
            },
            requests,
            stop,
            worker: Some(worker),
        }
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
fn window(files: Vec<Value>) -> Value {
    json!({"status":"window","messages":[{"id":"user-file","type":"user","time":{"created":1},
        "text":"attached", "files":files}],"older":null,"newer":null,"latest":true})
}
fn inline(bytes: &[u8], name: &str) -> Value {
    json!({"source":{"type":"inline"},"mime":"application/octet-stream",
        "data":STANDARD.encode(bytes),"name":name})
}

const MIB: usize = 1024 * 1024;

#[test]
fn history_keeps_references_and_loads_only_the_requested_attachment() {
    run(async {
        let first: Vec<_> = (0..5 * MIB).map(|i| (i % 251) as u8).collect();
        let hash = "a".repeat(64);
        let files = (0..3)
            .map(|i| {
                json!({"name":format!("part-{i}.bin"),"mime":"application/octet-stream",
            "source":{"type":"deferred","sha256":hash}})
            })
            .collect();
        let page = serde_json::to_vec(&window(files)).unwrap();
        assert!(page.len() < 1024);
        let server = Server::bodies(vec![page, first.clone(), vec![0; 8 * MIB + 1]]);
        let page = server.backend.page(json!({"kind":"latest"})).await.unwrap();
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "window never fetches a file"
        );
        let row = &page.rows[0];
        assert_eq!(row.body, "attached");
        assert_eq!(row.parts.len(), 3);
        for (index, part) in row.parts.iter().enumerate() {
            let Part::File(file) = part else {
                panic!("missing native file")
            };
            assert_eq!(
                file.name.as_deref(),
                Some(format!("part-{index}.bin").as_str())
            );
            let reference = file.reference.as_ref().unwrap();
            assert_eq!(reference.ordinal, index);
            assert_eq!(reference.sha256, hash);
        }
        let Part::File(file) = &row.parts[1] else {
            panic!("missing native file")
        };
        let reference = file.reference.as_ref().unwrap();
        let bytes = server.backend.attachment_bytes(reference).await.unwrap();
        assert_eq!(bytes.as_slice(), first.as_slice());
        assert!(Arc::ptr_eq(&bytes, &bytes.clone()));
        assert!(server.backend.attachment_bytes(reference).await.is_err());
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests[1].0,
            format!(
                "GET /api/workspaces/workspace/session-attachment/session/user-file/1/{hash} HTTP/1.1"
            )
        );
    });
}

#[test]
fn fresh_session_uses_the_same_projected_history_after_admission() {
    run(async {
        let hash = "d".repeat(64);
        let file = json!({"mime":"text/plain","name":"new.txt","source":{"type":"deferred","sha256":hash}});
        let empty =
            json!({"status":"window","messages":[],"older":null,"newer":null,"latest":true});
        let server = Server::new(vec![empty, window(vec![file]), json!({"data":{"time":{}}})]);
        let mut backend = server.backend.clone();
        backend.fresh_mode = true;
        assert!(backend.empty().await.unwrap().rows.is_empty());
        let page = backend.restore(None).await.unwrap();
        assert!(matches!(&page.rows[0].parts[..], [Part::File(file)]
            if file.reference.as_ref().is_some_and(|file| file.sha256 == hash)));
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests[0], requests[1]);
        assert!(
            requests[0]
                .0
                .starts_with("POST /api/workspaces/workspace/session-history/window ")
        );
        assert!(!requests.iter().any(|(line, _)| line.contains("/message?")));
    });
}

#[test]
fn prompt_keeps_native_fields_and_acknowledges_identical_text_by_identity() {
    run(async {
        let server = Server::new(vec![
            json!({"data":{"id":"confirmed-first","sessionID":"session"}}),
            json!({"sessionID":"session"}),
            json!({"id":"foreign","sessionID":"another"}),
            json!({"id":"invalid/id","sessionID":"session"}),
            json!({"sessionID":"session"}),
        ]);
        let text = "🦀 @reviewer";
        let mention = Mention {
            start: 3,
            end: 12,
            text: "@reviewer".into(),
        };
        let src = crate::server_file_uri("/project/a b#%.txt").unwrap();
        let first = Prompt {
            id: Some("first".into()),
            text: text.into(),
            files: vec![
                File {
                    uri: "data:text/plain;base64,w6nwn6aA".into(),
                    source: Some(FileSource::Inline),
                    name: Some("device.txt".into()),
                    ..File::default()
                },
                File {
                    uri: src.clone(),
                    source: Some(FileSource::Uri { uri: src.clone() }),
                    name: Some("project.txt".into()),
                    description: Some("Notes".into()),
                    mention: Some(mention.clone()),
                },
            ],
            agents: vec![Agent {
                name: "reviewer".into(),
                mention: Some(mention),
            }],
            skills: vec![Skill {
                id: "opaque/skill".into(),
                mention: None,
            }],
            metadata: json!({"displayText":"🦀 @reviewer","custom":[true,null]})
                .as_object()
                .cloned(),
            delivery: Some(Delivery::Queue),
            resume: Some(false),
        };
        let second = Prompt {
            id: Some("second".into()),
            text: text.into(),
            delivery: Some(Delivery::Steer),
            ..Prompt::default()
        };
        let backend = &server.backend;
        assert_eq!(backend.prompt(&first).await.unwrap().id, "confirmed-first");
        assert_eq!(backend.prompt(&second).await.unwrap().id, "second");
        assert!(
            backend
                .prompt(&second)
                .await
                .unwrap_err()
                .to_string()
                .contains("another session")
        );
        assert!(
            backend
                .prompt(&second)
                .await
                .unwrap_err()
                .to_string()
                .contains("valid identity")
        );
        assert!(
            backend
                .prompt(&Prompt::default())
                .await
                .unwrap_err()
                .to_string()
                .contains("valid identity")
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 5);
        assert!(requests.iter().all(|(line, body)| {
            line == "POST /workspaces/workspace/instance/api/session/session/prompt HTTP/1.1"
                && body.get("parts").is_none()
        }));
        assert_eq!(
            requests[0].1,
            json!({
                "id":"first","text":text,"files":[
                    {"uri":"data:text/plain;base64,w6nwn6aA","source":{"type":"inline"},"name":"device.txt"},
                    {"uri":"file:///project/a%20b%23%25.txt","source":{"type":"uri","uri":"file:///project/a%20b%23%25.txt"},
                     "name":"project.txt","description":"Notes","mention":{"start":3,"end":12,"text":"@reviewer"}}
                ],
                "agents":[{"name":"reviewer","mention":{"start":3,"end":12,"text":"@reviewer"}}],
                "skills":[{"id":"opaque/skill"}],"metadata":{"displayText":text,"custom":[true,null]},
                "delivery":"queue","resume":false
            })
        );
        assert_eq!(
            requests[1].1,
            json!({"id":"second","text":text,"delivery":"steer"})
        );
    });
}

#[test]
fn user_parts_keep_only_display_data_and_native_order() {
    let row = history::decode_message(&json!({
        "id":"m","type":"user","text":"",
        "agents":[{"name":"secret-owner"}],
        "skills":[{"id":"opaque/skill","name":"Review","text":"secret instructions"}],
        "files":[{"mime":"text/plain","source":{"type":"uri","uri":"file:///project/%23.txt"}}]
    }))
    .unwrap();
    assert!(row.completed);
    assert!(row.body.is_empty());
    assert!(
        matches!(&row.parts[..], [Part::Skill(skill), Part::File(file)]
        if skill.id == "m-skill-0" && skill.skill_id == "opaque/skill"
            && skill.name == "Review" && file.id == "m-file-0" && file.mime == "text/plain"
            && file.name.as_deref() == Some("%23.txt") && file.reference.is_none())
    );
}

#[test]
fn legacy_file_blobs_keep_labels_without_retaining_inline_bytes_or_device_paths() {
    run(async {
        let server = Server::new(vec![window(vec![json!({
            "mime":"image/png", "name":"shot.png", "data":"AAEC/w==",
            "source":{"type":"file","path":"D:/device/shot.png"}
        })])]);
        let page = server.backend.page(json!({"kind":"latest"})).await.unwrap();
        let Part::File(file) = &page.rows[0].parts[0] else {
            panic!("missing historical file")
        };
        assert_eq!(file.name.as_deref(), Some("shot.png"));
        assert!(file.reference.is_none());
        assert!(!format!("{file:?}").contains("AAEC/w=="));
        assert!(!format!("{file:?}").contains("D:/device"));
    });
}

#[test]
fn user_text_is_counted_once_across_multiple_joined_windows() {
    let text = "a".repeat(48 * 1024);
    let groups = (0..4).map(|part| {
        let mut value = window(vec![]);
        value["messages"] = Value::Array(
            (part * 31..=part * 31 + 31)
                .map(|id| json!({"type":"user","id":format!("message-{id}"),"text":text}))
                .collect(),
        );
        history::decode(value).unwrap().rows
    });
    let rows = groups.fold(Vec::new(), |before, after| {
        history::join(&before, &after).unwrap()
    });
    assert_eq!(rows.len(), 125);
    assert!(
        rows.iter()
            .all(|row| row.parts.is_empty() && row.body == text)
    );
}

#[test]
fn storage_boundary_excludes_native_identity_added_to_the_window() {
    let mut value = window(vec![]);
    let message = &mut value["messages"][0];
    let mut stored = message.clone();
    let fields = stored.as_object_mut().unwrap();
    fields.remove("id");
    fields.remove("type");
    let empty_name = "page.txt";
    let mut file = inline(&[], empty_name);
    fields.insert("files".into(), json!([file]));
    let remaining = history::MESSAGE_BYTES - serde_json::to_vec(&stored).unwrap().len();
    file["data"] = Value::String("a".repeat(remaining));
    message["files"] = json!([file]);
    assert!(serde_json::to_vec(message).unwrap().len() > history::MESSAGE_BYTES);
    assert_eq!(history::decode(value).unwrap().rows.len(), 1);
}

#[test]
fn dense_user_attachments_keep_the_message_and_native_tail() {
    let mut value = window(vec![]);
    value["messages"][0]["skills"] = Value::Array(
        (0..1001)
            .map(|i| json!({"id":format!("s-{i}"),"name":format!("Skill {i}")}))
            .collect(),
    );
    let page = history::decode(value).unwrap();
    let row = &page.rows[0];
    assert_eq!(row.body, "attached");
    assert_eq!(row.parts.len(), 1001);
    assert!(matches!(&row.parts[500], Part::Skill(skill) if skill.name == "Skill 500"));
    assert!(matches!(&row.parts[501], Part::Skill(skill) if skill.name == "Skill 501"));
    assert!(matches!(row.parts.last(), Some(Part::Skill(skill)) if skill.name == "Skill 1000"));
}

#[test]
fn native_large_payload_does_not_obscure_the_receipt() {
    run(async {
        let server = Server::new(vec![json!({
            "data":{"id":"queued","sessionID":"session","payload":{"files":[{"data":"x".repeat(34_952_540)}]}}
        })]);
        let prompt = Prompt {
            id: Some("queued".into()),
            delivery: Some(Delivery::Queue),
            ..Prompt::default()
        };
        assert_eq!(server.backend.prompt(&prompt).await.unwrap().id, "queued");
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    });
}

#[test]
fn prompt_and_history_limits_do_not_expand_catalogues() {
    run(async {
        let server = Server::new(vec![]);
        let refusal = server
            .backend
            .prompt(&Prompt {
                text: "x".repeat(crate::prompt::MAX_BODY_BYTES),
                ..Prompt::default()
            })
            .await
            .unwrap_err();
        assert!(refusal.to_string().contains("request body"));
        assert!(server.requests.lock().unwrap().is_empty());

        let file = inline(&vec![3; 5 * MIB], "device.bin");
        let too_large = window(vec![file.clone(); 3]);
        let mut too_many = window(vec![file.clone(); 2]);
        let mut adjacent = too_many["messages"][0].clone();
        adjacent["id"] = json!("another");
        too_many["messages"].as_array_mut().unwrap().push(adjacent);
        let server = Server::new(vec![
            too_large,
            too_many,
            json!({"data":"x".repeat(2 * MIB)}),
        ]);
        let oversized_row = server
            .backend
            .page(json!({"kind":"latest"}))
            .await
            .unwrap_err();
        assert!(
            oversized_row
                .to_string()
                .contains("window exceeds its bound")
        );
        let oversized_envelope = server
            .backend
            .page(json!({"kind":"latest"}))
            .await
            .unwrap_err();
        assert!(
            oversized_envelope
                .to_string()
                .contains("oversized response")
        );
        let response = server
            .backend
            .client
            .get(format!("{}catalogue", server.backend.base))
            .send()
            .await
            .unwrap();
        assert!(
            read_json(response)
                .await
                .unwrap_err()
                .to_string()
                .contains("oversized response")
        );

        let mut before = window(vec![file.clone(); 2]);
        before["messages"][0]["id"] = json!("before");
        before["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"overlap","type":"user","text":""}));
        let mut after = window(vec![file; 2]);
        after["messages"][0]["id"] = json!("after");
        after["messages"]
            .as_array_mut()
            .unwrap()
            .insert(0, json!({"id":"overlap","type":"user","text":""}));
        let left = history::decode(before).unwrap();
        let right = history::decode(after).unwrap();
        assert!(history::previous_page(&left, &right.rows).is_ok());
        assert!(history::previous_page(&left, &right.rows[1..]).is_err());
    });
}
