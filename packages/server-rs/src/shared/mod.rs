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

pub fn abort_response() -> axum::response::Response {
    let mut response = axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response();
    response.extensions_mut().insert(AbortResponse);
    response
}

use axum::response::IntoResponse;

pub fn abortable_service(
    router: axum::Router,
) -> impl hyper::service::Service<
    hyper::Request<hyper::body::Incoming>,
    Response = axum::response::Response,
    Error = std::io::Error,
    Future = impl std::future::Future<Output = Result<axum::response::Response, std::io::Error>>,
> {
    hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
        let svc = hyper_util::service::TowerToHyperService::new(router.clone());
        async move {
            let res = hyper::service::Service::call(&svc, req).await.map_err(std::io::Error::other)?;
            if res.extensions().get::<AbortResponse>().is_some() {
                return Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "response aborted"));
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

const RESPONSE_CHUNK: usize = 64 * 1024;
const MEDIA_MEM_UNITS: usize = 1024;
const LIST_MEM_UNITS: usize = 4096;

#[derive(Clone, Copy)]
pub enum ResponsePool {
    /// 64 MiB isolated pool for `session-media` images (<= 6 MiB each) so slow list streams
    /// cannot starve image fetches across workspaces.
    Media,
    /// 256 MiB pool for deferred `message.list` and `session-history/window` responses.
    List,
}

static MEDIA_RESPONSE_MEM: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(MEDIA_MEM_UNITS)));
static LIST_RESPONSE_MEM: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(LIST_MEM_UNITS)));

pub async fn reserve_response_memory(
    pool: ResponsePool,
    bytes: usize,
) -> Result<tokio::sync::OwnedSemaphorePermit, tokio::sync::AcquireError> {
    let (sem, cap) = match pool {
        ResponsePool::Media => (&*MEDIA_RESPONSE_MEM, MEDIA_MEM_UNITS),
        ResponsePool::List => (&*LIST_RESPONSE_MEM, LIST_MEM_UNITS),
    };
    let units = bytes.div_ceil(RESPONSE_CHUNK).clamp(1, cap) as u32;
    sem.clone().acquire_many_owned(units).await
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
        if let Some(permit) = mem.as_mut() {
            drop(permit.split(1));
        }
        std::task::Poll::Ready(Some(Ok::<_, std::io::Error>(chunk)))
    }))
}

/// Bounds continuous write stalls (a peer whose TCP receive window stays full) without
/// interfering with idle SSE or slow-streaming native responses that are not actively writing.
pub struct WriteStallIo<T> {
    inner: T,
    timeout: std::time::Duration,
    stall: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
}

impl<T> WriteStallIo<T> {
    pub fn new(inner: T, timeout: std::time::Duration) -> Self {
        Self { inner, timeout, stall: None }
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
        match std::pin::Pin::new(&mut this.inner).poll_write(cx, buf) {
            std::task::Poll::Ready(result) => {
                this.stall = None;
                std::task::Poll::Ready(result)
            }
            std::task::Poll::Pending => {
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
        match std::pin::Pin::new(&mut this.inner).poll_flush(cx) {
            std::task::Poll::Ready(result) => {
                this.stall = None;
                std::task::Poll::Ready(result)
            }
            std::task::Poll::Pending => {
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
                    let io = WriteStallIo::new(stream, std::time::Duration::from_secs(30));
                    let conn = hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(io), abortable_service(router))
                        .with_upgrades();
                    tokio::pin!(conn);
                    tokio::select! {
                        _ = &mut conn => {}
                        _ = stop.cancelled() => {
                            conn.as_mut().graceful_shutdown();
                            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), conn).await;
                        }
                    }
                });
            }
        }
    }
    let _ =
        tokio::time::timeout(std::time::Duration::from_secs(5), async { while tasks.join_next().await.is_some() {} })
            .await;
    tasks.abort_all();
    Ok(())
}
