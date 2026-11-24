//! Helpers shared across domains: JavaScript text semantics, clocks, capped reads and process families.
pub mod data_owner;
pub mod fastify;
pub mod panic_guard;
pub mod process_group;

use tokio::io::{AsyncRead, AsyncReadExt};

/// JS `\s` (and `String.prototype.trim`) whitespace.
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// JS `decodeURIComponent` (and fast-decode-uri-component): `None` on a malformed escape or UTF-8.
pub fn decode_component(text: &str) -> Option<String> {
    let (bytes, mut out, mut i) = (text.as_bytes(), Vec::with_capacity(text.len()), 0);
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = |at: usize| bytes.get(at).and_then(|b| (*b as char).to_digit(16));
            out.push((hex(i + 1)? << 4 | hex(i + 2)?) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// A fresh, canonical scratch folder for one test.
#[cfg(test)]
pub fn test_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("cnrs-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dunce::canonicalize(dir).unwrap()
}

/// A child process stream, refused past `max` bytes.
pub async fn read_capped(mut stream: impl AsyncRead + Unpin, max: usize) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    (&mut stream).take((max + 1) as u64).read_to_end(&mut out).await?;
    if out.len() > max { Err(std::io::Error::other("Git output exceeds limit")) } else { Ok(out) }
}

/// Marker extension instructing the HTTP listener to drop the connection with no response bytes
/// (reference parity with Fastify `reply.hijack(); reply.raw.destroy()`).
#[derive(Clone, Copy)]
pub struct AbortResponse;

pub type AbortFuture = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

/// Extension registering an abort future with the connection's `WriteStallIo` so principal
/// revocation, workspace close, or daemon retirement aborts already-buffered socket writes.
#[derive(Clone)]
pub struct CancelWrite(std::sync::Arc<std::sync::Mutex<Option<AbortFuture>>>);

impl CancelWrite {
    pub fn new(fut: AbortFuture) -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(Some(fut))))
    }

    pub fn token(token: tokio_util::sync::CancellationToken) -> Self {
        Self::new(Box::pin(token.cancelled_owned()))
    }

    fn take(&self) -> Option<AbortFuture> {
        self.0.lock().unwrap().take()
    }
}

#[derive(Default)]
struct WriteCancelState {
    generation: u64,
    fut: Option<AbortFuture>,
}

#[derive(Clone, Default)]
pub struct WriteCancel(std::sync::Arc<std::sync::Mutex<WriteCancelState>>);

impl WriteCancel {
    pub fn new() -> Self {
        Self::default()
    }
    fn set(&self, fut: Option<AbortFuture>) {
        let mut state = self.0.lock().unwrap();
        state.generation = state.generation.wrapping_add(1);
        state.fut = fut;
    }
}

pub fn abort_response() -> axum::response::Response {
    let mut response = axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response();
    response.extensions_mut().insert(AbortResponse);
    response
}

use axum::response::IntoResponse;

pub fn abortable_service(
    router: axum::Router,
    cancel: WriteCancel,
) -> impl hyper::service::Service<
    hyper::Request<hyper::body::Incoming>,
    Response = axum::response::Response,
    Error = std::io::Error,
    Future = impl std::future::Future<Output = Result<axum::response::Response, std::io::Error>>,
> {
    hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
        let svc = hyper_util::service::TowerToHyperService::new(router.clone());
        let cancel = cancel.clone();
        async move {
            cancel.set(None);
            let res = hyper::service::Service::call(&svc, req).await.map_err(std::io::Error::other)?;
            if res.extensions().get::<AbortResponse>().is_some() {
                return Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "response aborted"));
            }
            if let Some(write) = res.extensions().get::<CancelWrite>() {
                cancel.set(write.take());
            }
            Ok(res)
        }
    })
}

pub fn stream_abort(
    app: crate::Shared,
    workspace_key: String,
    workspace: crate::Workspace,
    endpoint: std::sync::Arc<crate::opencode::Endpoint>,
    cancel: tokio_util::sync::CancellationToken,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
        let workspace_closed = async {
            loop {
                let notified = app.workspace_closed.notified();
                if !app
                    .workspace(&workspace_key)
                    .is_ok_and(|current| current.id == workspace.id && current.path == workspace.path)
                {
                    return;
                }
                notified.await;
            }
        };
        tokio::select! {
            _ = cancel.cancelled() => {}
            _ = app.native.wait_retired(&endpoint) => {}
            _ = workspace_closed => {}
        }
    })
}

pub const RESPONSE_CHUNK: usize = 64 * 1024;
const MEDIA_MEM_UNITS: usize = 1024;
const HISTORY_MEM_UNITS: usize = 1024;
const LIST_MEM_UNITS: usize = 4096;

#[derive(Clone, Copy)]
pub enum ResponsePool {
    /// 64 MiB isolated pool for `session-media` images (<= 6 MiB each) so slow list streams
    /// cannot starve image fetches across workspaces.
    Media,
    /// 64 MiB isolated pool for `session-history/window` responses so atomic history reservations
    /// can never queue ahead of incremental `message.list` reservations in a shared FIFO semaphore.
    History,
    /// 256 MiB pool exclusively for deferred `message.list` (single builder slot, deadlock-free).
    List,
}

static MEDIA_RESPONSE_MEM: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(MEDIA_MEM_UNITS)));
static HISTORY_RESPONSE_MEM: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(HISTORY_MEM_UNITS)));
static LIST_RESPONSE_MEM: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(LIST_MEM_UNITS)));

pub fn response_memory_units(pool: ResponsePool, bytes: usize) -> u32 {
    let cap = match pool {
        ResponsePool::Media => MEDIA_MEM_UNITS,
        ResponsePool::History => HISTORY_MEM_UNITS,
        ResponsePool::List => LIST_MEM_UNITS,
    };
    bytes.div_ceil(RESPONSE_CHUNK).clamp(1, cap) as u32
}

pub async fn acquire_response_units(
    pool: ResponsePool,
    units: u32,
) -> Result<tokio::sync::OwnedSemaphorePermit, tokio::sync::AcquireError> {
    let sem = match pool {
        ResponsePool::Media => &*MEDIA_RESPONSE_MEM,
        ResponsePool::History => &*HISTORY_RESPONSE_MEM,
        ResponsePool::List => &*LIST_RESPONSE_MEM,
    };
    sem.clone().acquire_many_owned(units).await
}

pub async fn reserve_response_memory(
    pool: ResponsePool,
    bytes: usize,
) -> Result<tokio::sync::OwnedSemaphorePermit, tokio::sync::AcquireError> {
    acquire_response_units(pool, response_memory_units(pool, bytes)).await
}

pub fn permit_body(
    mut bytes: axum::body::Bytes,
    mut mem: Option<tokio::sync::OwnedSemaphorePermit>,
    mut abort: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>,
) -> axum::body::Body {
    let mut done = false;
    axum::body::Body::from_stream(futures_util::stream::poll_fn(move |cx| {
        if done {
            return std::task::Poll::Ready(None);
        }
        if std::future::Future::poll(abort.as_mut(), cx).is_ready() {
            done = true;
            drop(mem.take());
            bytes.clear();
            return std::task::Poll::Ready(Some(Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "response stream aborted",
            ))));
        }
        if bytes.is_empty() {
            done = true;
            drop(mem.take());
            return std::task::Poll::Ready(None);
        }
        let chunk = bytes.split_to(bytes.len().min(RESPONSE_CHUNK));
        std::task::Poll::Ready(Some(Ok::<_, std::io::Error>(chunk)))
    }))
}

/// Bounds continuous write stalls (a peer whose TCP receive window stays full) and immediately
/// aborts buffered writes on principal revocation, workspace close, or daemon retirement without
/// interfering with idle SSE streams.
pub struct WriteStallIo<T> {
    inner: T,
    timeout: std::time::Duration,
    stall: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
    cancel: WriteCancel,
    seen_generation: u64,
    wait_cancel: Option<AbortFuture>,
    aborted: bool,
}

impl<T> WriteStallIo<T> {
    pub fn new(inner: T, timeout: std::time::Duration, cancel: WriteCancel) -> Self {
        Self { inner, timeout, stall: None, cancel, seen_generation: 0, wait_cancel: None, aborted: false }
    }

    fn poll_cancelled(&mut self, cx: &mut std::task::Context<'_>) -> bool {
        {
            let mut state = self.cancel.0.lock().unwrap();
            if state.generation != self.seen_generation {
                self.seen_generation = state.generation;
                self.wait_cancel = state.fut.take();
                self.aborted = false;
            }
        }
        if self.aborted {
            return true;
        }
        if let Some(fut) = &mut self.wait_cancel
            && std::future::Future::poll(fut.as_mut(), cx).is_ready()
        {
            self.wait_cancel = None;
            self.aborted = true;
            return true;
        }
        false
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for WriteStallIo<T> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<T: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for WriteStallIo<T> {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        if this.poll_cancelled(cx) {
            this.stall = None;
            return std::task::Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "response write cancelled",
            )));
        }
        match std::pin::Pin::new(&mut this.inner).poll_write(cx, buf) {
            std::task::Poll::Ready(result) => {
                this.stall = None;
                std::task::Poll::Ready(result)
            }
            std::task::Poll::Pending => {
                if this.poll_cancelled(cx) {
                    this.stall = None;
                    return std::task::Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionAborted,
                        "response write cancelled",
                    )));
                }
                let timer = this.stall.get_or_insert_with(|| Box::pin(tokio::time::sleep(this.timeout)));
                if std::future::Future::poll(timer.as_mut(), cx).is_ready() {
                    this.stall = None;
                    std::task::Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "response write stalled",
                    )))
                } else {
                    std::task::Poll::Pending
                }
            }
        }
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_write_vectored(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        if this.poll_cancelled(cx) {
            this.stall = None;
            return std::task::Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "response write cancelled",
            )));
        }
        match std::pin::Pin::new(&mut this.inner).poll_write_vectored(cx, bufs) {
            std::task::Poll::Ready(result) => {
                this.stall = None;
                std::task::Poll::Ready(result)
            }
            std::task::Poll::Pending => {
                if this.poll_cancelled(cx) {
                    this.stall = None;
                    return std::task::Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionAborted,
                        "response write cancelled",
                    )));
                }
                let timer = this.stall.get_or_insert_with(|| Box::pin(tokio::time::sleep(this.timeout)));
                if std::future::Future::poll(timer.as_mut(), cx).is_ready() {
                    this.stall = None;
                    std::task::Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "response write stalled",
                    )))
                } else {
                    std::task::Poll::Pending
                }
            }
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if this.poll_cancelled(cx) {
            this.stall = None;
            return std::task::Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "response flush cancelled",
            )));
        }
        match std::pin::Pin::new(&mut this.inner).poll_flush(cx) {
            std::task::Poll::Ready(result) => {
                this.stall = None;
                std::task::Poll::Ready(result)
            }
            std::task::Poll::Pending => {
                if this.poll_cancelled(cx) {
                    this.stall = None;
                    return std::task::Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionAborted,
                        "response flush cancelled",
                    )));
                }
                let timer = this.stall.get_or_insert_with(|| Box::pin(tokio::time::sleep(this.timeout)));
                if std::future::Future::poll(timer.as_mut(), cx).is_ready() {
                    this.stall = None;
                    std::task::Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "response flush stalled",
                    )))
                } else {
                    std::task::Poll::Pending
                }
            }
        }
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

pub async fn serve_local(
    listener: tokio::net::TcpListener,
    router: axum::Router,
    shutdown: tokio_util::sync::CancellationToken,
    on_shutdown: impl FnOnce(),
) -> std::io::Result<()> {
    // Keep graceful drain below the desktop host's 30 s hard stop (`tests/serve.rs:113`) while
    // allowing admitted 15 s history and media requests to finish before plugin leases tear down.
    const DRAIN: std::time::Duration = std::time::Duration::from_secs(25);
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        while tasks.try_join_next().is_some() {}
        tokio::select! {
            _ = shutdown.cancelled() => {
                on_shutdown();
                break;
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
            accepted = listener.accept() => {
                let (stream, _) = match accepted {
                    Ok(pair) => pair,
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let _ = stream.set_nodelay(true);
                let router = router.clone();
                let stop = shutdown.clone();
                tasks.spawn(async move {
                    let cancel = WriteCancel::new();
                    let io = WriteStallIo::new(stream, std::time::Duration::from_secs(30), cancel.clone());
                    let conn = hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(io), abortable_service(router, cancel))
                        .with_upgrades();
                    tokio::pin!(conn);
                    tokio::select! {
                        _ = &mut conn => {}
                        _ = stop.cancelled() => {
                            conn.as_mut().graceful_shutdown();
                            let _ = tokio::time::timeout(DRAIN, conn).await;
                        }
                    }
                });
            }
        }
    }
    let drained = tokio::time::timeout(DRAIN, async { while tasks.join_next().await.is_some() {} }).await;
    tasks.abort_all();
    match drained {
        Ok(()) => Ok(()),
        Err(_) => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "local server shutdown drain timed out")),
    }
}
