use crate::{backend::Backend, http::Http};
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
                    if stopped.try_recv().is_ok() { return; }
                    assert!(Instant::now() < end, "expected prompt HTTP request");
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(2)),
                        Err(e) => panic!("fixture accept: {e}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                socket.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    assert!(header.len() < 32768);
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap();
                let size = header.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                }).unwrap_or(0);
                assert!(size <= 32 * 1024 * 1024);
                let mut bytes = vec![0; size];
                socket.read_exact(&mut bytes).unwrap();
                let body = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap() };
                received.lock().unwrap().push((header.lines().next().unwrap().into(), body));
                let response = serde_json::to_vec(&response).unwrap();
                let header = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len());
                if socket.write_all(header.as_bytes()).is_ok() { let _ = socket.write_all(&response); }
            }
        });
        Self {
            backend: Backend { client: Http::new().unwrap(), base, workspace: "workspace".into(),
                session: "session".into(), client_id: "prompt-fixture".into(), fresh_mode: false },
            requests, stop, worker: Some(worker),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() { worker.join().unwrap(); }
    }
}
fn run(test: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(test)
}
fn window(files: Vec<Value>) -> Value {
    json!({"status":"window","messages":[{"id":"user-file","type":"user","time":{"created":1},
        "text":"attached", "files":files}],"older":null,"newer":null,"latest":true})
}
fn inline(size: usize) -> Value {
    json!({"source":{"type":"inline"},"mime":"application/octet-stream",
        "data":STANDARD.encode(vec![97;size]),"name":"device.bin"})
}

#[test]
fn inline_file_at_input_limit_reloads_from_native_window() {
    run(async {
        let server = Server::new(vec![window(vec![inline(5 * 1024 * 1024)])]);
        let page = server.backend.page(json!({"kind":"latest"})).await.unwrap();
        assert_eq!(page.rows.len(), 1);
    });
}
