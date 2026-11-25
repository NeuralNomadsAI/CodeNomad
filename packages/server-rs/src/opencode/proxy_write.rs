//! A dispatched session mutation owns its worktree admission through the native response.
use std::{future::Future, time::Duration};

use axum::{body::Body, response::Response};
use futures_util::StreamExt;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{Error, opencode::upstream_error, worktrees::fence::Entered};

pub(super) async fn forward<F: Future<Output = Result<Response, Error>> + Send + 'static>(
    permit: Entered,
    rules: Option<tokio::sync::OwnedMutexGuard<()>>,
    cleanup: Option<crate::sessions::cleanup::MutationGuard>,
    principal: CancellationToken,
    request: impl FnOnce(CancellationToken) -> F + Send + 'static,
) -> Result<Response, Error> {
    let detached = CancellationToken::new();
    let observer = detached.clone().drop_guard();
    let (head, response) = oneshot::channel();
    tokio::spawn(async move {
        let (_permit, _rules, _cleanup) = (permit, rules, cleanup);
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
        _ = principal.cancelled() => return Err(crate::auth::unauthorized()),
        response = response => response.map_err(|_| upstream_error())??,
    };
    let body = Body::from_stream(async_stream::stream! {
        let _observer = observer;
        loop {
            tokio::select! {
                _ = principal.cancelled() => return,
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
        use crate::{sessions::cleanup::Fence, worktrees::fence};
        let dirs = ["/proxy-write-test/detached".to_string()];
        let cleanup_fence = Fence::default();
        let cleanup_guard = cleanup_fence.enter_mutation("ses_proxy_write").unwrap();
        let (started, waiting) = oneshot::channel();
        let (finish, held) = oneshot::channel();
        let observer = tokio::spawn(forward(
            fence::enter(&dirs).unwrap(),
            None,
            Some(cleanup_guard),
            CancellationToken::new(),
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
        assert!(cleanup_fence.enter_cleanup("ses_proxy_write").is_none());
        finish.send(()).unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(2), deletion).await.unwrap().is_ok());
        assert!(cleanup_fence.enter_cleanup("ses_proxy_write").is_some());
    }

    #[tokio::test]
    async fn dropping_the_body_after_a_chunk_still_drains_native_to_eof() {
        use crate::worktrees::fence;
        use axum::body::Bytes;
        let dirs = ["/proxy-write-test/partial-body".to_string()];
        let (finish, held) = oneshot::channel();
        let (eof, drained) = oneshot::channel();
        let response = forward(fence::enter(&dirs).unwrap(), None, None, CancellationToken::new(), |_| async move {
            Ok(Response::new(Body::from_stream(async_stream::stream! {
                yield Ok::<_, std::io::Error>(Bytes::from_static(b"first"));
                held.await.unwrap();
                yield Ok(Bytes::from_static(b"last"));
                eof.send(()).unwrap();
            })))
        })
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
}
