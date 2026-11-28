use crate::{
    State,
    backend::Backend,
    platform::{self, storage::Store},
};
use codenomad_client::{
    Receiver, bounded,
    timeline::{self, Outline},
};
use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
    rc::{Rc, Weak},
    sync::Arc,
};

type Session = (String, String);
struct Entry {
    version: u64,
    outline: Arc<Outline>,
}

#[derive(Default)]
pub(crate) struct Cache {
    entries: Vec<Entry>,
    version: u64,
    started: bool,
    loading: Option<Receiver<Vec<Arc<Outline>>>>,
    saving: Option<Receiver<()>>,
    dirty: bool,
    pending_write_before_freeze: bool,
    unloaded_before_freeze: bool,
    mutations: HashMap<Session, Weak<Cell<u64>>>,
    invalidated_while_loading: HashSet<Session>,
}

impl Cache {
    pub(super) fn poll(&mut self, store: &Store, wake: rune::Waker) {
        if !std::mem::replace(&mut self.started, true) {
            let store = store.clone();
            let (tx, rx) = bounded(1);
            self.loading = Some(rx);
            let wake = wake.clone();
            platform::spawn(async move {
                let entries = store
                    .load_outlines()
                    .await
                    .ok()
                    .flatten()
                    .map_or_else(Vec::new, |bytes| timeline::decode_saved_outlines(&bytes));
                let _ = tx.send(entries).await;
                wake();
            });
        }
        if let Some(rx) = &self.loading {
            let Ok(entries) = rx.try_recv() else { return };
            self.loading = None;
            for entry in entries {
                if self
                    .invalidated_while_loading
                    .iter()
                    .any(|(server, session)| entry.belongs_to_session(server, session))
                {
                    self.dirty = true;
                    continue;
                }
                if !self
                    .entries
                    .iter()
                    .any(|current| current.outline.same_saved_slot(&entry))
                {
                    self.entries.push(Entry {
                        version: 0,
                        outline: entry,
                    });
                }
            }
            self.invalidated_while_loading.clear();
            self.trim();
        }
        if let Some(rx) = &self.saving {
            if rx.try_recv().is_err() {
                return;
            }
            self.saving = None;
        }
        if std::mem::take(&mut self.dirty) {
            let outlines: Vec<Arc<Outline>> = self
                .entries
                .iter()
                .map(|entry| entry.outline.clone())
                .collect();
            let write =
                store.start_save_outlines_with(move || timeline::encode_saved_outlines(&outlines));
            let (tx, rx) = bounded(1);
            self.saving = Some(rx);
            platform::spawn(async move {
                let _ = write.await;
                let _ = tx.send(()).await;
                wake();
            });
        }
    }

    pub(crate) fn version(&self) -> u64 {
        self.version
    }

    pub(crate) fn begin_freeze(&mut self) -> u64 {
        self.pending_write_before_freeze |= self.dirty || self.saving.is_some();
        self.unloaded_before_freeze |= !self.started || self.loading.is_some();
        self.started = true;
        self.loading = None;
        self.saving = None;
        self.dirty = false;
        self.version
    }

    pub(crate) fn restore_after_failed_mutation(&mut self) {
        if std::mem::take(&mut self.unloaded_before_freeze) {
            self.started = false;
        }
        if std::mem::take(&mut self.pending_write_before_freeze) {
            self.dirty = true;
        }
    }

    pub(crate) fn clear_saved(&mut self) {
        self.entries.clear();
        self.pending_write_before_freeze = false;
        self.unloaded_before_freeze = false;
        self.started = true;
        self.loading = None;
        self.saving = None;
        self.dirty = false;
        self.invalidated_while_loading.clear();
    }

    pub(crate) fn clear_saved_before(&mut self, baseline: u64) {
        self.pending_write_before_freeze = false;
        self.unloaded_before_freeze = false;
        self.entries.retain(|entry| entry.version > baseline);
        self.started = true;
        self.loading = None;
        self.saving = None;
        self.invalidated_while_loading.clear();
        self.dirty = self.version > baseline;
    }

    pub(crate) fn mark_dirty_if_nonempty(&mut self) {
        self.pending_write_before_freeze = false;
        self.unloaded_before_freeze = false;
        self.started = true;
        self.loading = None;
        self.saving = None;
        self.invalidated_while_loading.clear();
        if !self.entries.is_empty() {
            self.dirty = true;
        }
    }

    pub(crate) fn mutation(&mut self, backend: &Backend) -> Option<Rc<Cell<u64>>> {
        let key = session(backend)?;
        if let Some(clock) = self.mutations.get(&key).and_then(Weak::upgrade) {
            return Some(clock);
        }
        self.mutations.retain(|_, clock| clock.strong_count() > 0);
        let clock = Rc::new(Cell::new(0));
        self.mutations.insert(key, Rc::downgrade(&clock));
        Some(clock)
    }

    fn invalidate(&mut self, backend: &Backend) {
        let Some(key) = session(backend) else { return };
        if let Some(clock) = self.mutation(backend) {
            clock.set(clock.get().wrapping_add(1));
        }
        let before = self.entries.len();
        self.entries
            .retain(|entry| !entry.outline.belongs_to_session(&key.0, &key.1));
        if before != self.entries.len() {
            self.version = self.version.wrapping_add(1);
            self.dirty = true;
        }
        if !self.started || self.loading.is_some() || self.unloaded_before_freeze {
            self.invalidated_while_loading.insert(key);
        }
    }

    pub(crate) fn retained_bytes(&self, seen_outlines: &mut HashSet<usize>) -> usize {
        self.entries.iter().fold(0usize, |total, entry| {
            if seen_outlines.insert(Arc::as_ptr(&entry.outline) as usize) {
                total.saturating_add(crate::timeline::outline_weight(&entry.outline))
            } else {
                total
            }
        })
    }

    #[cfg(test)]
    pub(crate) fn fixture_insert(&mut self, outline: Arc<Outline>) {
        self.entries.push(Entry {
            version: 0,
            outline,
        });
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn evict_under_pressure(
        &mut self,
        bytes_to_free: usize,
        active_backend: Option<&Backend>,
        active_project: Option<&str>,
    ) -> usize {
        if bytes_to_free == 0
            || self.dirty
            || self.saving.is_some()
            || self.pending_write_before_freeze
            || self.entries.is_empty()
        {
            return 0;
        }
        let mut freed = 0usize;
        let mut index = self.entries.len();
        while index > 0 && freed < bytes_to_free {
            index -= 1;
            let is_active = active_backend
                .zip(active_project)
                .is_some_and(|(backend, project)| {
                    self.entries[index].outline.saved_for(backend, project)
                });
            if !is_active {
                let removed = self.entries.remove(index).outline;
                // Count freed bytes only when no inactive Timeline still holds a strong Arc clone.
                if Arc::strong_count(&removed) == 1 {
                    freed = freed.saturating_add(crate::timeline::outline_weight(&removed));
                }
            }
        }
        freed
    }

    fn trim(&mut self) {
        let mut bytes = 0;
        #[cfg(target_arch = "wasm32")]
        const MAX_OUTLINE_BYTES: usize = 4 * 1024 * 1024;
        #[cfg(not(target_arch = "wasm32"))]
        const MAX_OUTLINE_BYTES: usize = 16 * 1024 * 1024;
        let keep = self
            .entries
            .iter()
            .take(16)
            .take_while(|entry| {
                bytes += entry.outline.saved_weight().unwrap_or_default();
                bytes <= MAX_OUTLINE_BYTES
            })
            .count();
        self.entries.drain(keep..);
    }
}

fn session(backend: &Backend) -> Option<Session> {
    Some((
        backend.client.server_identity()?.to_owned(),
        backend.session.clone(),
    ))
}

pub(crate) fn seed(s: &State, backend: &Backend, project: &str) -> Option<Arc<Outline>> {
    s.saved_outlines
        .entries
        .iter()
        .find(|entry| entry.outline.saved_for(backend, project))
        .map(|entry| entry.outline.clone())
}

pub(crate) fn remember(s: &mut State, outline: Arc<Outline>) {
    let cache = &mut s.saved_outlines;
    if outline.saved_weight().is_none()
        || cache
            .entries
            .iter()
            .any(|o| o.outline.same_saved_outline(&outline))
    {
        return;
    }
    cache
        .entries
        .retain(|old| !old.outline.same_saved_slot(&outline));
    cache.version = cache.version.wrapping_add(1);
    let version = cache.version;
    cache.entries.insert(0, Entry { version, outline });
    cache.trim();
    cache.dirty = true;
    (s.wake)();
}

pub(crate) fn invalidate(s: &mut State, backend: &Backend) {
    s.saved_outlines.invalidate(backend);
    (s.wake)();
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use codenomad_client::timeline::{Entry as TimelineEntry, Kind};
    use std::{fs, path::PathBuf, time::Duration};

    const ROOT: &str = "/workspace/outlines-test";

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let parent =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/rune-outlines-tests");
            fs::create_dir_all(&parent).unwrap();
            let dir = parent.join(format!(
                "trial-outlines-{}",
                codenomad_client::http::client_id().unwrap()
            ));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn saved_outline(server: &str, session: &str, msg_id: &str) -> Arc<Outline> {
        let saved = serde_json::from_value(serde_json::json!({
            "identity": {
                "server": server,
                "project": "project-1",
                "root": ROOT,
                "directory": ROOT,
                "session": session,
                "undo": null,
            },
            "checkpoints": [
                {
                    "after": -1,
                    "through": 0,
                    "digest": "a".repeat(64),
                }
            ]
        }))
        .unwrap();
        Arc::new(Outline {
            entries: vec![TimelineEntry {
                id: msg_id.into(),
                seq: 0,
                kind: Kind::Assistant,
                tools: 0,
                reasoning: 0,
                text: Some(16),
                tool_name: None,
                layout: Some("T".into()),
                omitted: None,
            }],
            total: 1,
            cacheable: true,
            saved: Some(saved),
        })
    }

    fn attested_backend(server: &str, session: &str) -> Backend {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let server_id = server.to_owned();
        let mut backend = platform::block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf).await;
                let reply = serde_json::json!({
                    "apiContract": 1,
                    "serverId": server_id,
                })
                .to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
            let backend = Backend::connect(&base, "").await.unwrap();
            backend.attest_server().await.unwrap();
            let _ = task.await;
            backend
        });
        assert_eq!(backend.client.server_identity(), Some(server));
        backend.session = session.into();
        backend.session_directory = Some(ROOT.into());
        backend
    }

    fn drain_cache(cache: &mut Cache, store: &Store) {
        let wake: rune::Waker = Arc::new(|| {});
        platform::block_on(async {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                cache.poll(store, wake.clone());
                if cache.started
                    && cache.loading.is_none()
                    && cache.saving.is_none()
                    && !cache.dirty
                {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "outline cache did not settle"
                );
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        });
    }

    #[test]
    fn outline_invalidated_before_freeze_is_not_reimported_after_failed_clear() {
        let dir = TestDir::new();
        let store = platform::block_on(Store::open(dir.0.join("rune"))).unwrap();
        let outline_a = saved_outline("srv-1", "ses-a", "msg-a");
        let outline_b = saved_outline("srv-1", "ses-b", "msg-b");
        let encoded = timeline::encode_saved_outlines(&[outline_a, outline_b]);
        platform::block_on(store.save_outlines(encoded)).unwrap();

        let backend_a = attested_backend("srv-1", "ses-a");
        let backend_b = attested_backend("srv-1", "ses-b");

        let mut cache = Cache::default();
        // Simulate an in-flight startup load interrupted by an invalidation and a failed Clear.
        let (_pending_tx, pending_rx) = bounded(1);
        cache.started = true;
        cache.loading = Some(pending_rx);

        cache.invalidate(&backend_a);
        let _ = cache.begin_freeze();
        cache.restore_after_failed_mutation();

        drain_cache(&mut cache, &store);

        assert!(
            !cache
                .entries
                .iter()
                .any(|entry| entry.outline.saved_for(&backend_a, ROOT)),
            "invalidated outline must not be re-imported after a failed Clear"
        );
        assert!(
            cache
                .entries
                .iter()
                .any(|entry| entry.outline.saved_for(&backend_b, ROOT)),
            "non-invalidated outline must still be restored"
        );

        let persisted = platform::block_on(store.load_outlines())
            .unwrap()
            .expect("rewritten outlines file");
        let decoded = timeline::decode_saved_outlines(&persisted);
        assert_eq!(decoded.len(), 1);
        assert!(decoded[0].saved_for(&backend_b, ROOT));
    }

    #[test]
    fn outline_invalidated_during_freeze_is_not_reimported_after_failed_clear() {
        let dir = TestDir::new();
        let store = platform::block_on(Store::open(dir.0.join("rune"))).unwrap();
        let outline_a = saved_outline("srv-1", "ses-a", "msg-a");
        let outline_b = saved_outline("srv-1", "ses-b", "msg-b");
        let encoded = timeline::encode_saved_outlines(&[outline_a, outline_b]);
        platform::block_on(store.save_outlines(encoded)).unwrap();

        let backend_a = attested_backend("srv-1", "ses-a");
        let backend_b = attested_backend("srv-1", "ses-b");

        let mut cache = Cache::default();
        // Freeze before the initial disk load ever started, then invalidate while frozen.
        let _ = cache.begin_freeze();
        cache.invalidate(&backend_a);
        cache.restore_after_failed_mutation();

        drain_cache(&mut cache, &store);

        assert!(
            !cache
                .entries
                .iter()
                .any(|entry| entry.outline.saved_for(&backend_a, ROOT)),
            "outline invalidated while frozen before initial load must not be imported"
        );
        assert!(
            cache
                .entries
                .iter()
                .any(|entry| entry.outline.saved_for(&backend_b, ROOT))
        );

        let persisted = platform::block_on(store.load_outlines())
            .unwrap()
            .expect("rewritten outlines file");
        let decoded = timeline::decode_saved_outlines(&persisted);
        assert_eq!(decoded.len(), 1);
        assert!(decoded[0].saved_for(&backend_b, ROOT));
    }
}
