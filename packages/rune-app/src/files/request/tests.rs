use super::*;
use crate::files::state::Tree;
use std::{future::Future, time::Duration};
use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

type Flight = JoinHandle<Option<Result<Vec<Entry>>>>;

struct Fixture {
    listener: TcpListener,
    backend: Backend,
    reads: Reads,
}
async fn wait<T>(task: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
}
async fn write(socket: &TcpStream, mut bytes: &[u8]) {
    while !bytes.is_empty() {
        wait(socket.writable()).await.unwrap();
        match socket.try_write(bytes) {
            Ok(0) => panic!("closed fixture socket"),
            Ok(count) => bytes = &bytes[count..],
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => panic!("fixture write: {error}"),
        }
    }
}
impl Fixture {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut backend =
            Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                .await
                .unwrap();
        backend.workspace = "fixture".into();
        Self {
            listener,
            backend,
            reads: Reads::default(),
        }
    }
    fn start(&self) -> (Tree, Flight) {
        let mut tree = Tree::new("/fixture".into());
        tree.activate(true);
        let read = tree.take_refresh().pop().unwrap();
        let backend = self.backend.clone();
        let reads = self.reads.clone();
        let flight = tokio::spawn(async move { read.fetch(&backend, &reads).await });
        (tree, flight)
    }
    async fn open_body(&self) -> TcpStream {
        let (socket, _) = wait(self.listener.accept()).await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            wait(socket.readable()).await.unwrap();
            let mut bytes = [0; 1024];
            match socket.try_read(&mut bytes) {
                Ok(0) => panic!("closed fixture request"),
                Ok(count) => request.extend_from_slice(&bytes[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(error) => panic!("fixture read: {error}"),
            }
            assert!(request.len() <= 8192);
        }
        assert!(request.starts_with(b"GET /api/workspaces/fixture/files?"));
        write(&socket, b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[").await;
        socket
    }
    async fn no_dispatch(&self) {
        assert!(
            tokio::time::timeout(Duration::from_millis(80), self.listener.accept())
                .await
                .is_err()
        );
    }
}
async fn success(flight: Flight) {
    assert!(wait(flight).await.unwrap().unwrap().unwrap().is_empty());
}

#[test]
fn third_listing_waits_for_body_decode_and_preview_keeps_its_own_lane() {
    crate::platform::block_on(async {
        let fixture = Fixture::new().await;
        let (_first, first) = fixture.start();
        let first_body = fixture.open_body().await;
        let (_second, second) = fixture.start();
        let second_body = fixture.open_body().await;
        let (_third, third) = fixture.start();
        fixture.no_dispatch().await;
        let (_cancel, alive) = codenomad_client::bounded(1);
        let _preview = wait(fixture.reads.preview(&alive)).await.unwrap();
        write(&first_body, b"]").await;
        success(first).await;
        let third_body = fixture.open_body().await;
        write(&second_body, b"]").await;
        write(&third_body, b"]").await;
        success(second).await;
        success(third).await;
    });
}

#[test]
fn queued_cancellation_never_dispatches_after_slots_are_released() {
    crate::platform::block_on(async {
        let fixture = Fixture::new().await;
        let (_first, first) = fixture.start();
        let first_body = fixture.open_body().await;
        let (_second, second) = fixture.start();
        let second_body = fixture.open_body().await;
        let (mut queued, third) = fixture.start();
        fixture.no_dispatch().await;
        queued.close();
        assert!(wait(third).await.unwrap().is_none());
        write(&first_body, b"]").await;
        write(&second_body, b"]").await;
        success(first).await;
        success(second).await;
        fixture.no_dispatch().await;
        let (_replacement, replacement) = fixture.start();
        let replacement_body = fixture.open_body().await;
        write(&replacement_body, b"]").await;
        success(replacement).await;
    });
}

#[test]
fn body_cancellation_and_decode_error_each_return_the_slot() {
    crate::platform::block_on(async {
        for cancel in [true, false] {
            let fixture = Fixture::new().await;
            let (mut owner, first) = fixture.start();
            let first_body = fixture.open_body().await;
            let (_second, second) = fixture.start();
            let second_body = fixture.open_body().await;
            let (_third, third) = fixture.start();
            fixture.no_dispatch().await;
            if cancel {
                owner.close();
                assert!(wait(first).await.unwrap().is_none());
            } else {
                write(&first_body, b"!").await;
                assert!(wait(first).await.unwrap().unwrap().is_err());
            }
            let third_body = fixture.open_body().await;
            write(&second_body, b"]").await;
            write(&third_body, b"]").await;
            success(second).await;
            success(third).await;
        }
    });
}
