use super::{Ui, document::store::Store};
use crate::{backend::Backend, platform::reads::Reads};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

pub struct Http {
    listener: TcpListener,
    pub backend: Backend,
}
pub struct Request {
    socket: TcpStream,
    pub header: String,
    pub body: serde_json::Value,
}
pub async fn wait<T>(task: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(15), task)
        .await
        .expect("fixture deadline")
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
    pub fn ui(&self, store: Store, instance: &str) -> Ui {
        let mut ui = Ui::new(
            self.backend.clone(),
            "/private".into(),
            Reads::default(),
            Arc::new(|| {}),
        )
        .with_documents(store, instance.into());
        ui.online(true);
        ui
    }
    pub async fn request(&self, method: &str, path: &str) -> Request {
        let request = self.accept().await;
        let header = &request.header;
        assert!(
            ['/', '?'].into_iter().any(|suffix| {
                header.starts_with(&format!("{method} /api/workspaces/owned/files{suffix}"))
            }),
            "{header}"
        );
        assert!(
            header.contains(&format!("path={path}")) && header.contains("directory=%2Fprivate"),
            "{header}"
        );
        request
    }
    pub async fn accept(&self) -> Request {
        let (mut socket, _) = wait(self.listener.accept()).await.unwrap();
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            bytes.push(wait(socket.read_u8()).await.unwrap());
            assert!(bytes.len() <= 32768);
        }
        let header = String::from_utf8(bytes).unwrap();
        let length = header
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        assert!(length <= 4096);
        let mut body = vec![0; length];
        wait(socket.read_exact(&mut body)).await.unwrap();
        let body = if body.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&body).unwrap()
        };
        Request {
            socket,
            header,
            body,
        }
    }
    pub async fn quiet(&self) {
        assert!(
            tokio::time::timeout(Duration::from_millis(80), self.listener.accept())
                .await
                .is_err(),
            "unexpected request"
        );
    }
}
impl Request {
    pub async fn disconnected(mut self) {
        let mut byte = [0];
        assert_eq!(wait(self.socket.read(&mut byte)).await.unwrap(), 0);
    }

    pub async fn send(mut self, header: &str, body: &[u8]) {
        wait(self.socket.write_all(header.as_bytes()))
            .await
            .unwrap();
        wait(self.socket.write_all(body)).await.unwrap();
    }
    pub async fn reply(self, status: u16, body: serde_json::Value) {
        self.try_reply(status, body).await.unwrap();
    }
    pub async fn try_reply(mut self, status: u16, body: serde_json::Value) -> std::io::Result<()> {
        let body = if status == 204 {
            Vec::new()
        } else {
            serde_json::to_vec(&body).unwrap()
        };
        let header = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        wait(self.socket.write_all(header.as_bytes())).await?;
        wait(self.socket.write_all(&body)).await
    }
    pub async fn preview(self, path: &str, base64: &str, version: Option<&str>) {
        let mut data = serde_json::json!({"workspaceId":"owned", "relativePath":path,
            "encoding":"base64", "contents":base64});
        if let Some(version) = version {
            data["version"] = version.into();
        }
        self.reply(200, data).await;
    }
}
