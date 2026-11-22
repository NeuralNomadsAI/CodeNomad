use crate::platform::reads::{Reads, cancellable};
use codenomad_client::{Receiver, backend::Backend, files::Entry, history::Result};
use std::sync::Arc;

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
    pub async fn fetch(&self, backend: &Backend, reads: &Reads) -> Option<Result<Vec<Entry>>> {
        let _slot = reads.background(&self.cancelled).await?;
        cancellable(&self.cancelled, backend.files(&self.directory, &self.path)).await
    }
    pub fn cancelled(&self) -> bool {
        self.cancelled.is_closed()
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
