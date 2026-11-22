use codenomad_client::{Receiver, backend::Backend, files::Entry, history::Result};
use std::{
    future::{Future, poll_fn},
    sync::Arc,
    task::Poll,
};

pub struct Read {
    pub directory: String,
    pub path: String,
    pub(super) owner: Arc<()>,
    pub(super) id: u64,
    pub(super) version: u64,
    pub(super) cancelled: Receiver<()>,
}

impl Read {
    /// Dropping the HTTP future cancels its body/transport on either platform.
    pub async fn fetch(&self, backend: &Backend) -> Option<Result<Vec<Entry>>> {
        let response = backend.files(&self.directory, &self.path);
        let cancellation = self.cancelled.recv();
        let mut response = std::pin::pin!(response);
        let mut cancellation = std::pin::pin!(cancellation);
        poll_fn(|cx| {
            if cancellation.as_mut().poll(cx).is_ready() {
                return Poll::Ready(None);
            }
            response.as_mut().poll(cx).map(Some)
        })
        .await
    }
    pub fn cancelled(&self) -> bool {
        self.cancelled.is_closed()
    }
}
