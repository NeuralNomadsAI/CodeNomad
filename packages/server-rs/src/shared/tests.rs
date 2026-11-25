use super::*;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct ObservedIo<T> {
    inner: T,
    written: usize,
    flushed: tokio::sync::watch::Sender<usize>,
}

impl<T: AsyncRead + Unpin> AsyncRead for ObservedIo<T> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<T: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for ObservedIo<T> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let poll = std::pin::Pin::new(&mut self.inner).poll_write(cx, buf);
        if let std::task::Poll::Ready(Ok(n)) = poll {
            self.written += n;
        }
        poll
    }
    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
    fn poll_write_vectored(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let poll = std::pin::Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        if let std::task::Poll::Ready(Ok(n)) = poll {
            self.written += n;
        }
        poll
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let poll = std::pin::Pin::new(&mut self.inner).poll_flush(cx);
        if matches!(poll, std::task::Poll::Ready(Ok(()))) {
            let _ = self.flushed.send(self.written);
        }
        poll
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[tokio::test]
async fn completed_cancel_write_does_not_abort_idle_keep_alive_connection() {
    fn tracked_abort(
        token: tokio_util::sync::CancellationToken,
        dropped: tokio::sync::oneshot::Sender<()>,
    ) -> AbortFuture {
        struct OnDrop(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for OnDrop {
            fn drop(&mut self) {
                if let Some(tx) = self.0.take() {
                    let _ = tx.send(());
                }
            }
        }
        Box::pin(async move {
            let _guard = OnDrop(Some(dropped));
            token.cancelled().await;
        })
    }

    for (path, sentinel, expect_len) in
        [("/ws1-fixed", b"\r\n\r\nok".as_slice(), true), ("/ws1-stream", b"0\r\n\r\n".as_slice(), false)]
    {
        let closed = tokio_util::sync::CancellationToken::new();
        let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel();
        let dropped_slot = Arc::new(Mutex::new(Some(dropped_tx)));
        let closed_fixed = closed.clone();
        let dropped_fixed = dropped_slot.clone();
        let closed_stream = closed.clone();
        let dropped_stream = dropped_slot.clone();
        let router = axum::Router::new()
            .route(
                "/ws1-fixed",
                axum::routing::get(move || {
                    let token = closed_fixed.clone();
                    let dropped = dropped_fixed.lock().unwrap().take().unwrap();
                    async move {
                        // Omit explicit Content-Length so FinishBody must preserve size_hint().
                        let mut response = axum::response::Response::builder()
                            .status(axum::http::StatusCode::OK)
                            .body(axum::body::Body::from("ok"))
                            .unwrap();
                        response.extensions_mut().insert(CancelWrite::new(tracked_abort(token, dropped)));
                        response
                    }
                }),
            )
            .route(
                "/ws1-stream",
                axum::routing::get(move || {
                    let token = closed_stream.clone();
                    let dropped = dropped_stream.lock().unwrap().take().unwrap();
                    async move {
                        let stream = futures_util::stream::iter([Ok::<_, std::io::Error>(
                            axum::body::Bytes::from_static(b"hi"),
                        )]);
                        let mut response = axum::response::Response::builder()
                            .status(axum::http::StatusCode::OK)
                            .body(axum::body::Body::from_stream(stream))
                            .unwrap();
                        response.extensions_mut().insert(CancelWrite::new(tracked_abort(token, dropped)));
                        response
                    }
                }),
            )
            .route("/ws2", axum::routing::delete(|| async { axum::http::StatusCode::NO_CONTENT }));

        let (mut client, server_io) = tokio::io::duplex(4096);
        let (flushed_tx, mut flushed_rx) = tokio::sync::watch::channel(0usize);
        let (conn_done_tx, conn_done_rx) = tokio::sync::oneshot::channel();
        let cancel = WriteCancel::new();
        let io = WriteStallIo::new(
            ObservedIo { inner: server_io, written: 0, flushed: flushed_tx },
            std::time::Duration::from_secs(30),
            cancel.clone(),
        );
        let conn = tokio::spawn(async move {
            let res = hyper::server::conn::http1::Builder::new()
                .serve_connection(hyper_util::rt::TokioIo::new(io), abortable_service(router, cancel))
                .await;
            let _ = conn_done_tx.send(res.is_ok());
        });

        let req = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n");
        client.write_all(req.as_bytes()).await.unwrap();
        let mut first = Vec::new();
        let mut buf = [0u8; 512];
        while !first.ends_with(sentinel) {
            let n =
                tokio::time::timeout(std::time::Duration::from_secs(5), client.read(&mut buf)).await.unwrap().unwrap();
            assert!(n > 0, "first response must complete for {path}");
            first.extend_from_slice(&buf[..n]);
        }
        let first_text = String::from_utf8_lossy(&first);
        assert!(first_text.starts_with("HTTP/1.1 200 OK"), "{first_text}");
        if expect_len {
            assert!(first_text.to_ascii_lowercase().contains("content-length: 2\r\n"), "{first_text}");
        }

        // Wait deterministically until Hyper has flushed all bytes of the first response.
        tokio::time::timeout(std::time::Duration::from_secs(5), flushed_rx.wait_for(|&n| n >= first.len()))
            .await
            .unwrap()
            .unwrap();

        // Cancel the finished response's token: on patched code the abort future was already
        // dropped on final flush; on unpatched code the idle connection wakes and aborts.
        closed.cancel();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::select! {
                biased;
                res = conn_done_rx => Err(res),
                res = dropped_rx => Ok(res),
            }
        })
        .await
        .unwrap();
        assert!(outcome.is_ok(), "idle keep-alive connection aborted after {path}: {outcome:?}");

        client.write_all(b"DELETE /ws2 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut second = Vec::new();
        tokio::time::timeout(std::time::Duration::from_secs(5), client.read_to_end(&mut second))
            .await
            .unwrap()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&second).starts_with("HTTP/1.1 204 No Content"),
            "keep-alive follow-up failed after {path}: {:?}",
            String::from_utf8_lossy(&second)
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), conn).await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn active_cancel_write_still_aborts_pending_flush_and_disarms_only_after_final_flush() {
    struct ControlledFlush {
        allow: Arc<AtomicBool>,
        pending_seen: Arc<tokio::sync::Notify>,
        waker: Arc<Mutex<Option<std::task::Waker>>>,
    }
    impl tokio::io::AsyncWrite for ControlledFlush {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            std::task::Poll::Ready(Ok(buf.len()))
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            if self.allow.load(Ordering::Acquire) {
                return std::task::Poll::Ready(Ok(()));
            }
            *self.waker.lock().unwrap() = Some(cx.waker().clone());
            self.pending_seen.notify_one();
            std::task::Poll::Pending
        }
        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    // 1. A pending final flush still aborts immediately when cancelled after observing Pending.
    let token = tokio_util::sync::CancellationToken::new();
    let cancel = WriteCancel::new();
    let generation = cancel.set(Some(Box::pin(token.clone().cancelled_owned())));
    cancel.mark_finished(generation);
    let pending_seen = Arc::new(tokio::sync::Notify::new());
    let mut io = WriteStallIo::new(
        ControlledFlush {
            allow: Arc::new(AtomicBool::new(false)),
            pending_seen: pending_seen.clone(),
            waker: Arc::new(Mutex::new(None)),
        },
        std::time::Duration::from_secs(30),
        cancel,
    );
    assert_eq!(io.write(b"abc").await.unwrap(), 3);
    let cancel_later = token.clone();
    let trigger = tokio::spawn(async move {
        pending_seen.notified().await;
        cancel_later.cancel();
    });
    let err = tokio::time::timeout(std::time::Duration::from_secs(5), io.flush()).await.unwrap().unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::ConnectionAborted);
    trigger.await.unwrap();

    // 2. Pending -> Ready(Ok(())) stays armed on an intermediate flush (body not finished),
    //    then disarms on the final flush once body_finished is marked.
    let token2 = tokio_util::sync::CancellationToken::new();
    let cancel2 = WriteCancel::new();
    let gen2 = cancel2.set(Some(Box::pin(token2.clone().cancelled_owned())));
    let allow2 = Arc::new(AtomicBool::new(false));
    let pending2 = Arc::new(tokio::sync::Notify::new());
    let waker2: Arc<Mutex<Option<std::task::Waker>>> = Arc::new(Mutex::new(None));
    let mut io2 = WriteStallIo::new(
        ControlledFlush { allow: allow2.clone(), pending_seen: pending2.clone(), waker: waker2.clone() },
        std::time::Duration::from_secs(30),
        cancel2.clone(),
    );
    assert_eq!(io2.write(b"chunk1").await.unwrap(), 6);
    let release_mid = {
        let (allow2, pending2, waker2) = (allow2.clone(), pending2.clone(), waker2.clone());
        tokio::spawn(async move {
            pending2.notified().await;
            allow2.store(true, Ordering::Release);
            if let Some(w) = waker2.lock().unwrap().take() {
                w.wake();
            }
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), io2.flush()).await.unwrap().unwrap();
    release_mid.await.unwrap();
    assert!(io2.wait_cancel.is_some(), "intermediate flush before body end must stay armed");

    // Now finish the body and complete a Pending -> Ready(Ok(())) final flush.
    allow2.store(false, Ordering::Release);
    cancel2.mark_finished(gen2);
    let release_end = {
        let (allow2, pending2, waker2) = (allow2.clone(), pending2.clone(), waker2.clone());
        tokio::spawn(async move {
            pending2.notified().await;
            allow2.store(true, Ordering::Release);
            if let Some(w) = waker2.lock().unwrap().take() {
                w.wake();
            }
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), io2.flush()).await.unwrap().unwrap();
    release_end.await.unwrap();
    assert!(io2.wait_cancel.is_none(), "final flush after body end must disarm wait_cancel");

    // Cancelling after final flush must not abort subsequent flushes.
    token2.cancel();
    io2.flush().await.unwrap();
}
