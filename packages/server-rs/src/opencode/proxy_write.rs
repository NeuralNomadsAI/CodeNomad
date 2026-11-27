//! A dispatched session mutation owns its worktree admission through the native response.
use std::{future::Future, pin::Pin, time::Duration};

use axum::{body::Body, response::Response};
use futures_util::StreamExt;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{Error, not_found, opencode::upstream_error, worktrees::fence::Entered};

pub(super) struct ObserverGuards {
    pub principal: CancellationToken,
    pub retired: Pin<Box<dyn Future<Output = ()> + Send>>,
    pub closed: Pin<Box<dyn Future<Output = ()> + Send>>,
}

#[cfg(test)]
impl ObserverGuards {
    fn principal_only(principal: CancellationToken) -> Self {
        Self { principal, retired: Box::pin(std::future::pending()), closed: Box::pin(std::future::pending()) }
    }
}

pub(super) async fn forward<F: Future<Output = Result<Response, Error>> + Send + 'static>(
    permit: Entered,
    rules: Option<tokio::sync::OwnedMutexGuard<()>>,
    mut guards: ObserverGuards,
    request: impl FnOnce(CancellationToken) -> F + Send + 'static,
) -> Result<Response, Error> {
    let detached = CancellationToken::new();
    let observer = detached.clone().drop_guard();
    let (head, response) = oneshot::channel();
    tokio::spawn(async move {
        let (_permit, _rules) = (permit, rules);
        let task = async {
            let (parts, body) = match request(detached.clone()).await {
                Ok(response) => response.into_parts(),
                Err(error) => {
                    let _ = head.send(Err(error));
                    return;
                }
            };
            let (send, receive) = mpsc::channel(2);
            let _ = head.send(Ok((parts, receive)));
            let mut stream = body.into_data_stream();
            while let Some(chunk) = stream.next().await {
                let failed = chunk.is_err();
                // Once the downstream goes away, discard rather than buffer native bytes.
                let _ = send.send(chunk).await;
                if failed {
                    break;
                }
            }
        };
        tokio::pin!(task);
        tokio::select! {
            _ = &mut task => {},
            _ = detached.cancelled() => {
                let _ = tokio::time::timeout(Duration::from_secs(60), task).await;
            }
        }
    });
    let (parts, mut stream) = tokio::select! {
        biased;
        _ = guards.principal.cancelled() => return Err(crate::auth::unauthorized()),
        _ = &mut guards.retired => return Err(upstream_error()),
        _ = &mut guards.closed => return Err(not_found()),
        response = response => response.map_err(|_| upstream_error())??,
    };
    let body = Body::from_stream(async_stream::stream! {
        let _observer = observer;
        let mut guards = guards;
        loop {
            tokio::select! {
                biased;
                _ = guards.principal.cancelled() => {
                    yield Err(axum::Error::new(std::io::Error::new(
                        std::io::ErrorKind::ConnectionAborted,
                        "upstream stream aborted",
                    )));
                    return;
                }
                _ = &mut guards.retired => {
                    yield Err(axum::Error::new(std::io::Error::new(
                        std::io::ErrorKind::ConnectionAborted,
                        "upstream stream aborted",
                    )));
                    return;
                }
                _ = &mut guards.closed => {
                    yield Err(axum::Error::new(std::io::Error::new(
                        std::io::ErrorKind::ConnectionAborted,
                        "workspace closed",
                    )));
                    return;
                }
                chunk = stream.recv() => match chunk {
                    Some(chunk) => yield chunk,
                    None => return,
                }
            }
        }
    });
    Ok(Response::from_parts(parts, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dropping_the_observer_keeps_the_deletion_fence_until_native_finishes() {
        use crate::worktrees::fence;
        let dirs = ["/proxy-write-test/detached".to_string()];
        let (started, waiting) = oneshot::channel();
        let (finish, held) = oneshot::channel();
        let observer = tokio::spawn(forward(
            fence::enter(&dirs).unwrap(),
            None,
            ObserverGuards::principal_only(CancellationToken::new()),
            |_| async move {
                started.send(()).unwrap();
                held.await.unwrap();
                Ok(Response::new(Body::from("acknowledged")))
            },
        ));
        waiting.await.unwrap();
        observer.abort();
        let _ = observer.await;
        let deletion = fence::block(&dirs);
        tokio::pin!(deletion);
        assert!(futures_util::poll!(&mut deletion).is_pending());
        assert!(fence::enter(&dirs).is_none());
        finish.send(()).unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(2), deletion).await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn dropping_the_body_after_a_chunk_still_drains_native_to_eof() {
        use crate::worktrees::fence;
        use axum::body::Bytes;
        let dirs = ["/proxy-write-test/partial-body".to_string()];
        let (finish, held) = oneshot::channel();
        let (eof, drained) = oneshot::channel();
        let response = forward(
            fence::enter(&dirs).unwrap(),
            None,
            ObserverGuards::principal_only(CancellationToken::new()),
            |_| async move {
                Ok(Response::new(Body::from_stream(async_stream::stream! {
                    yield Ok::<_, std::io::Error>(Bytes::from_static(b"first"));
                    held.await.unwrap();
                    yield Ok(Bytes::from_static(b"last"));
                    eof.send(()).unwrap();
                })))
            },
        )
        .await
        .unwrap();
        let mut body = response.into_body().into_data_stream();
        assert_eq!(body.next().await.unwrap().unwrap(), "first");
        drop(body);
        tokio::task::yield_now().await;

        let deletion = fence::block(&dirs);
        tokio::pin!(deletion);
        assert!(futures_util::poll!(&mut deletion).is_pending());
        assert!(fence::enter(&dirs).is_none());
        finish.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), drained).await.unwrap().unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(2), deletion).await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn observer_invalidation_prefers_error_over_ready_headers_and_keeps_fence_until_native_finishes() {
        use crate::worktrees::fence;
        use axum::http::StatusCode as Status;

        // 1. Pre-cancelled principal beats an immediately ready native response (biased select).
        let dirs = ["/proxy-write-test/biased-cancel".to_string()];
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let err = forward(fence::enter(&dirs).unwrap(), None, ObserverGuards::principal_only(cancelled), |_| async {
            Ok(Response::new(Body::from("too-late")))
        })
        .await
        .unwrap_err();
        assert_eq!(err.0, Status::UNAUTHORIZED);

        // 2. Workspace close stops observing with 404 while keeping the deletion fence until native completes.
        let dirs_ws = ["/proxy-write-test/ws-closed".to_string()];
        let (started, waiting) = oneshot::channel();
        let (finish, held) = oneshot::channel();
        let (close_tx, close_rx) = oneshot::channel::<()>();
        let guards = ObserverGuards {
            principal: CancellationToken::new(),
            retired: Box::pin(std::future::pending()),
            closed: Box::pin(async move {
                let _ = close_rx.await;
            }),
        };
        let mut req = tokio::spawn(forward(fence::enter(&dirs_ws).unwrap(), None, guards, |_| async move {
            started.send(()).unwrap();
            held.await.unwrap();
            Ok(Response::new(Body::from("acknowledged")))
        }));
        waiting.await.unwrap();
        close_tx.send(()).unwrap();
        let err = tokio::time::timeout(Duration::from_secs(2), &mut req).await.unwrap().unwrap().unwrap_err();
        assert_eq!(err.0, Status::NOT_FOUND);
        let deletion = fence::block(&dirs_ws);
        tokio::pin!(deletion);
        assert!(futures_util::poll!(&mut deletion).is_pending());
        finish.send(()).unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(2), deletion).await.unwrap().is_ok());

        // 3. Daemon retirement stops observing with 502 while keeping the deletion fence until native completes.
        let dirs_ret = ["/proxy-write-test/daemon-retired".to_string()];
        let (started, waiting) = oneshot::channel();
        let (finish, held) = oneshot::channel();
        let (retire_tx, retire_rx) = oneshot::channel::<()>();
        let guards = ObserverGuards {
            principal: CancellationToken::new(),
            retired: Box::pin(async move {
                let _ = retire_rx.await;
            }),
            closed: Box::pin(std::future::pending()),
        };
        let mut req = tokio::spawn(forward(fence::enter(&dirs_ret).unwrap(), None, guards, |_| async move {
            started.send(()).unwrap();
            held.await.unwrap();
            Ok(Response::new(Body::from("acknowledged")))
        }));
        waiting.await.unwrap();
        retire_tx.send(()).unwrap();
        let err = tokio::time::timeout(Duration::from_secs(2), &mut req).await.unwrap().unwrap().unwrap_err();
        assert_eq!(err.0, Status::BAD_GATEWAY);
        let deletion = fence::block(&dirs_ret);
        tokio::pin!(deletion);
        assert!(futures_util::poll!(&mut deletion).is_pending());
        finish.send(()).unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(2), deletion).await.unwrap().is_ok());
    }
}
