//! Loopback HTTP ingress for decrypted Remote Control tunnel connections.
//!
//! Every accepted socket is tagged with `auth::tls::Channel { ingress: true, ... }`
//! before any request is parsed, so the tunnel's loopback peer address never grants
//! local privileges.
use std::{
    io,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicU16, Ordering},
    },
    time::Duration,
};

use axum::Router;
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::auth::tls::Channel;

/// Matches `INGRESS_TIMEOUTS.headersTimeout` (60 s); no request timeout so long
/// uploads and SSE streams work identically to the local listener. Hyper 1.x applies
/// `header_read_timeout` to both initial headers and idle keep-alive waits (conservative
/// relative to TS `keepAliveTimeout: 72_000` since Hyper has no separate keep-alive knob).
const HEADER_TIMEOUT: Duration = Duration::from_secs(60);
const WRITE_STALL_TIMEOUT: Duration = Duration::from_secs(30);

struct Running {
    generation: u64,
    port: u16,
    stop: CancellationToken,
    task: JoinHandle<()>,
}

struct OriginState {
    generation: u64,
    origin: Option<String>,
}

struct Lifecycle {
    stopped_up_to: Option<u64>,
    running: Option<Running>,
}

pub struct RemoteIngress {
    router: RwLock<Option<Router>>,
    origin: Arc<RwLock<OriginState>>,
    port: AtomicU16,
    lifecycle: tokio::sync::Mutex<Lifecycle>,
}

impl Default for RemoteIngress {
    fn default() -> Self {
        Self {
            router: RwLock::new(None),
            origin: Arc::new(RwLock::new(OriginState { generation: 0, origin: None })),
            port: AtomicU16::new(0),
            lifecycle: tokio::sync::Mutex::new(Lifecycle { stopped_up_to: None, running: None }),
        }
    }
}

impl RemoteIngress {
    pub fn attach_router(&self, router: Router) {
        *self.router.write().unwrap() = Some(router);
    }

    pub fn port(&self) -> Option<u16> {
        let port = self.port.load(Ordering::Acquire);
        (port != 0).then_some(port)
    }

    pub fn set_origin(&self, generation: u64, origin: Option<String>) {
        let mut guard = self.origin.write().unwrap();
        if generation >= guard.generation {
            guard.generation = generation;
            guard.origin = origin;
        }
    }

    /// Starts the loopback listener on `127.0.0.1:0` for `generation` and returns `127.0.0.1:<port>`.
    pub async fn start(&self, generation: u64) -> io::Result<String> {
        let mut guard = self.lifecycle.lock().await;
        if guard.stopped_up_to.is_some_and(|stopped| generation <= stopped) {
            return Err(io::Error::other("Remote Control was stopped"));
        }
        if let Some(running) = guard.running.as_ref() {
            if running.generation == generation {
                return Ok(format!("127.0.0.1:{}", running.port));
            }
            if running.generation > generation {
                return Err(io::Error::other("Remote Control was stopped"));
            }
        }
        if let Some(old) = guard.running.take() {
            self.port.store(0, Ordering::Release);
            old.stop.cancel();
            let _ = old.task.await;
        }
        let router = self
            .router
            .read()
            .unwrap()
            .clone()
            .ok_or_else(|| io::Error::other("Remote Control router is not attached"))?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let stop = CancellationToken::new();
        self.set_origin(generation, None);
        let origin = self.origin.clone();
        self.port.store(port, Ordering::Release);
        let task = tokio::spawn(serve_ingress(listener, router, origin, generation, stop.clone()));
        guard.running = Some(Running { generation, port, stop, task });
        Ok(format!("127.0.0.1:{port}"))
    }

    /// Stops any ingress started at or before `max_generation` and destroys its active sockets immediately.
    pub async fn stop_up_to(&self, max_generation: u64) {
        let running = {
            let mut guard = self.lifecycle.lock().await;
            guard.stopped_up_to = Some(guard.stopped_up_to.map_or(max_generation, |prev| prev.max(max_generation)));
            if guard.running.as_ref().is_some_and(|r| r.generation <= max_generation) {
                self.set_origin(max_generation, None);
                self.port.store(0, Ordering::Release);
                guard.running.take()
            } else {
                None
            }
        };
        if let Some(running) = running {
            running.stop.cancel();
            let _ = running.task.await;
        }
    }
}

async fn serve_ingress(
    listener: TcpListener,
    router: Router,
    origin_slot: Arc<RwLock<OriginState>>,
    generation: u64,
    stop: CancellationToken,
) {
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        while tasks.try_join_next().is_some() {}
        let (stream, _) = tokio::select! {
            _ = stop.cancelled() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => continue,
            result = listener.accept() => match result {
                Ok(accepted) => accepted,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            },
        };
        let _ = stream.set_nodelay(true);
        let current = {
            let guard = origin_slot.read().unwrap();
            (guard.generation == generation).then(|| guard.origin.clone()).flatten()
        };
        let (origin, origins): (String, Arc<[String]>) = match current {
            Some(url) => (url.clone(), Arc::from([url])),
            None => (String::new(), Arc::from([])),
        };
        let socket_token = stop.child_token();
        let channel = Channel {
            origin,
            origins,
            ingress: true,
            socket: socket_token.clone(),
            principal: Arc::new(Mutex::new(None)),
        };
        let router = router.clone();
        tasks.spawn(async move {
            let cancel = crate::shared::WriteCancel::new();
            let io = crate::shared::WriteStallIo::new(stream, WRITE_STALL_TIMEOUT, cancel.clone());
            let service = router.layer(axum::Extension(channel));
            let connection = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_TIMEOUT)
                .keep_alive(true)
                .serve_connection(TokioIo::new(io), crate::shared::abortable_service(service, cancel))
                .with_upgrades();
            tokio::pin!(connection);
            tokio::select! {
                _ = socket_token.cancelled() => {}
                _ = &mut connection => {}
            }
            // Do NOT cancel `socket_token` when `connection` completes normally: on HTTP 101
            // WebSocket upgrades, Hyper hands off the stream and returns `Ok(())`, while the
            // upgraded relay still observes `socket_token` for ingress shutdown or revocation.
        });
    }
    drop(listener);
    while tasks.join_next().await.is_some() {}
}
