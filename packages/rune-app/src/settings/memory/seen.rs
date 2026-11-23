use codenomad_client::settings::memory::{Entry, List, timestamp};
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Seen {
    scopes: BTreeMap<String, (i64, i64)>,
    remembered: BTreeMap<String, i64>,
    #[cfg(not(target_arch = "wasm32"))]
    store: Option<crate::platform::storage::Store>,
}

impl Seen {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn bind(&mut self, store: Option<crate::platform::storage::Store>) {
        self.store = store;
    }

    pub fn begin_visit(&mut self) {
        self.scopes.clear();
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(marks) = self
            .store
            .as_ref()
            .and_then(|store| store.memory_seen().ok())
        {
            for (key, at) in marks {
                let stored = self.remembered.entry(key).or_default();
                *stored = (*stored).max(at);
            }
        }
    }

    pub fn observe(&mut self, server: &str, list: &List, expanded: bool) {
        let key = format!("{server}~{}", list.scope_key);
        if self.scopes.len() >= 256 && !self.scopes.contains_key(&key) {
            return;
        }
        let (baseline, newest) = self.scopes.entry(key.clone()).or_insert_with(|| {
            let stored = read_browser(&key).max(self.remembered.get(&key).copied().unwrap_or(0));
            (stored, stored)
        });
        if expanded
            && let Some(at) = timestamp(&list.observed_at)
            && at > *newest
        {
            *newest = at;
            let at = at.max(*baseline);
            self.remembered.insert(key.clone(), at);
            #[cfg(target_arch = "wasm32")]
            storage_write(&key, at);
            #[cfg(not(target_arch = "wasm32"))]
            if let Some(store) = self.store.clone() {
                crate::platform::spawn(async move {
                    let _ = store.mark_memory_seen(key, at).await;
                });
            }
        }
    }

    pub fn badge(&self, server: &str, list: &List, entry: &Entry) -> Option<&'static str> {
        let key = format!("{server}~{}", list.scope_key);
        let baseline = self.scopes.get(&key).map_or(0, |(baseline, _)| *baseline);
        if timestamp(&entry.created).is_some_and(|at| at > baseline) {
            Some("settings.memory.new")
        } else if timestamp(&entry.updated).is_some_and(|at| at > baseline) {
            Some("settings.memory.modified")
        } else {
            None
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn read_browser(key: &str) -> i64 {
    storage()
        .and_then(|store| store.get_item(&storage_key(key)).ok().flatten())
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

#[cfg(target_arch = "wasm32")]
fn storage_write(key: &str, at: i64) {
    if let Some(store) = storage() {
        let _ = store.set_item(&storage_key(key), &at.max(read_browser(key)).to_string());
    }
}

#[cfg(target_arch = "wasm32")]
fn storage_key(key: &str) -> String {
    format!("codenomad.memory.seen.{key}")
}

#[cfg(target_arch = "wasm32")]
fn storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok().flatten()
}

#[cfg(not(target_arch = "wasm32"))]
fn read_browser(_: &str) -> i64 {
    0
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn native_consultation_uses_the_saved_frontier_on_each_visit() {
    use crate::platform::{self, storage::Store};
    platform::block_on(async {
        let path = std::env::temp_dir().join(codenomad_client::http::client_id().unwrap());
        let store = Store::open(path.clone()).await.unwrap();
        let key = "fixture~global";
        let date = "2026-06-01T00:00:00Z";
        let mut entry = super::review::Edit::fixture().entry;
        entry.created = "2026-05-01T00:00:00Z".into();
        entry.updated = date.into();
        let list = List {
            entries: vec![entry.clone()],
            scope_key: "global".into(),
            observed_at: date.into(),
            cleanup_writable: false,
            cleanup_directory: None,
        };
        let observed = timestamp(date).unwrap();
        let mut seen = Seen::default();
        seen.bind(Some(store.clone()));
        seen.begin_visit();
        seen.observe("fixture", &list, false);
        assert!(store.memory_seen().unwrap().is_empty());
        assert_eq!(
            seen.badge("fixture", &list, &entry),
            Some("settings.memory.new")
        );
        // Persist a consultation from another window through the same client store.
        store.mark_memory_seen(key.into(), observed).await.unwrap();
        store
            .mark_memory_seen(key.into(), observed - 1000)
            .await
            .unwrap();
        assert_eq!(store.memory_seen().unwrap().get(key), Some(&observed));
        seen.observe("fixture", &list, false);
        assert_eq!(
            seen.badge("fixture", &list, &entry),
            Some("settings.memory.new")
        );
        seen.begin_visit();
        seen.observe("fixture", &list, false);
        assert_eq!(seen.badge("fixture", &list, &entry), None);
        drop((seen, store));
        for file in ["memory-seen.json", "state.lock"] {
            std::fs::remove_file(path.join(file)).unwrap();
        }
        std::fs::remove_dir(path).unwrap();
    });
}
