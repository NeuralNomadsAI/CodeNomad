use super::*;
use tokio::net::{TcpListener, TcpStream};

pub struct Http {
    listener: TcpListener,
    pub backend: Backend,
}
pub struct Body {
    socket: TcpStream,
    last: u8,
}
pub async fn wait<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(3), future)
        .await
        .unwrap()
}
async fn write(socket: &TcpStream, mut bytes: &[u8]) {
    while !bytes.is_empty() {
        wait(socket.writable()).await.unwrap();
        match socket.try_write(bytes) {
            Ok(0) => panic!("fixture socket closed"),
            Ok(n) => bytes = &bytes[n..],
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => panic!("fixture write: {e}"),
        }
    }
}
impl Http {
    pub async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut backend =
            Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                .await
                .unwrap();
        backend.workspace = "owned".into();
        backend.session = "session".into();
        Self { listener, backend }
    }
    pub fn reader(&self, reads: Reads) -> Reader {
        let mut reader = Reader::new(self.backend.clone(), reads, std::sync::Arc::new(|| {}));
        reader.online(true);
        reader
    }
    pub async fn body(&self, path: &str, contents: &str) -> Body {
        let (socket, _) = wait(self.listener.accept()).await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            wait(socket.readable()).await.unwrap();
            let mut bytes = [0; 1024];
            match socket.try_read(&mut bytes) {
                Ok(0) => panic!("fixture request closed"),
                Ok(n) => request.extend_from_slice(&bytes[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(e) => panic!("fixture read: {e}"),
            }
            assert!(request.len() <= 8192);
        }
        let request = String::from_utf8(request).unwrap();
        assert!(request.starts_with("GET /api/workspaces/owned/files/preview?"));
        assert!(request.contains(&format!("path={path}")));
        assert!(request.contains("directory=%2Fprivate"));
        let body = serde_json::to_vec(
            &serde_json::json!({"workspaceId":"owned","relativePath":path,
            "encoding":"base64","contents":contents,"version":"v1"}),
        )
        .unwrap();
        write(
            &socket,
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        )
        .await;
        write(&socket, &body[..body.len() - 1]).await;
        Body {
            socket,
            last: *body.last().unwrap(),
        }
    }
    pub async fn quiet(&self) {
        assert!(
            tokio::time::timeout(Duration::from_millis(80), self.listener.accept())
                .await
                .is_err()
        );
    }
}
impl Body {
    pub async fn finish(self) {
        write(&self.socket, &[self.last]).await;
    }
}
pub async fn poll(reader: &mut Reader, condition: impl Fn(&Reader) -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while !condition(reader) {
        assert!(
            std::time::Instant::now() < deadline,
            "reader completion timeout"
        );
        reader.poll(reader.clock + 0.05);
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}
