use async_lock::{Semaphore, SemaphoreGuardArc};
use codenomad_client::Receiver;
use std::{
    future::{Future, poll_fn},
    sync::Arc,
    task::Poll,
};

#[derive(Clone)]
pub struct Reads {
    background: Arc<Semaphore>,
    preview: Arc<Semaphore>,
}
impl Default for Reads {
    fn default() -> Self {
        Self {
            background: Arc::new(Semaphore::new(2)),
            preview: Arc::new(Semaphore::new(1)),
        }
    }
}
impl Reads {
    pub async fn background(&self, cancelled: &Receiver<()>) -> Option<SemaphoreGuardArc> {
        cancellable(cancelled, self.background.acquire_arc()).await
    }
    pub async fn preview(&self, cancelled: &Receiver<()>) -> Option<SemaphoreGuardArc> {
        cancellable(cancelled, self.preview.acquire_arc()).await
    }
}
pub async fn cancellable<T>(cancelled: &Receiver<()>, task: impl Future<Output = T>) -> Option<T> {
    let mut task = std::pin::pin!(task);
    let mut cancellation = std::pin::pin!(cancelled.recv());
    poll_fn(|cx| {
        if cancellation.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        task.as_mut().poll(cx).map(Some)
    })
    .await
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use codenomad_client::bounded;

    #[test]
    fn preview_is_independent_bounded_and_cancellable() {
        crate::platform::block_on(async {
            let reads = Reads::default();
            let clone = reads.clone();
            let (_cancel, alive) = bounded(1);
            let _first = reads.background(&alive).await.unwrap();
            let _second = clone.background(&alive).await.unwrap();
            let preview = reads.preview(&alive).await.unwrap();
            let (cancel, cancelled) = bounded(1);
            let mut waiting = std::pin::pin!(clone.preview(&cancelled));
            poll_fn(|cx| {
                assert!(waiting.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            cancel.close();
            assert!(waiting.await.is_none());
            drop(preview);
            assert!(clone.preview(&alive).await.is_some());
        });
    }
}
