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

pub fn permit_body(bytes: axum::body::Bytes, slot: tokio::sync::SemaphorePermit<'static>) -> axum::body::Body {
    axum::body::Body::from_stream(futures_util::stream::unfold((bytes, Some(slot)), |(mut bytes, slot)| async move {
        if bytes.is_empty() {
            drop(slot);
            return None;
        }
        let chunk = bytes.split_to(bytes.len().min(64 * 1024));
        Some((Ok::<_, std::convert::Infallible>(chunk), (bytes, slot)))
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
        mut self: std::pin::Pin<&mut Self>,
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
        mut self: std::pin::Pin<&mut Self>,
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
                            let _ = conn.await;
                        }
                    }
                });
            }
        }
    }
    while tasks.join_next().await.is_some() {}
    Ok(())
}
