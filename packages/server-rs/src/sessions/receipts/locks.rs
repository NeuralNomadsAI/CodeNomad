//! Serialize updates to one receipt; a deletion excludes writes to its session.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, Weak},
};

use crate::{Error, opencode::upstream_error};

type Sessions = HashMap<PathBuf, Weak<tokio::sync::RwLock<()>>>;
type Receipts = HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>;
static SESSIONS: LazyLock<Mutex<Sessions>> = LazyLock::new(Mutex::default);
static RECEIPTS: LazyLock<Mutex<Receipts>> = LazyLock::new(Mutex::default);

fn lock<T: Default>(locks: &Mutex<HashMap<PathBuf, Weak<T>>>, path: &Path) -> Arc<T> {
    let mut locks = locks.lock().unwrap();
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
        return lock;
    }
    locks.retain(|_, lock| lock.strong_count() != 0);
    let lock = Arc::new(T::default());
    locks.insert(path.to_owned(), Arc::downgrade(&lock));
    lock
}

pub(super) async fn receipt<T: Send + 'static>(
    file: PathBuf,
    apply: impl FnOnce(&Path) -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    let session = lock(&SESSIONS, file.parent().expect("receipt has a session directory")).read_owned().await;
    let receipt = lock(&RECEIPTS, &file).lock_owned().await;
    tokio::task::spawn_blocking(move || {
        let (_session, _receipt) = (session, receipt);
        apply(&file)
    })
    .await
    .map_err(|_| upstream_error())?
}

pub(super) async fn session(
    folder: PathBuf,
    apply: impl FnOnce(&Path) -> Result<(), Error> + Send + 'static,
) -> Result<(), Error> {
    let exclusive = lock(&SESSIONS, &folder).write_owned().await;
    tokio::task::spawn_blocking(move || {
        let _exclusive = exclusive;
        apply(&folder)
    })
    .await
    .map_err(|_| upstream_error())?
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn a_retained_write_cannot_block_another_receipt() {
        use std::{path::PathBuf, time::Duration};
        let (ready, started) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let a = tokio::spawn(super::receipt(PathBuf::from("receipt-test/a"), move |_| {
            ready.send(()).unwrap();
            held.recv_timeout(Duration::from_secs(3)).unwrap();
            Ok(())
        }));
        started.await.unwrap();
        let b =
            tokio::time::timeout(Duration::from_secs(1), super::receipt(PathBuf::from("receipt-test/b"), |_| Ok(42)))
                .await;
        release.send(()).unwrap();
        a.await.unwrap().unwrap();
        assert_eq!(b.unwrap().unwrap(), 42);
    }
}
