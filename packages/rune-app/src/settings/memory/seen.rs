use codenomad_client::settings::memory::{Entry, List, timestamp};
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Seen {
    scopes: BTreeMap<String, (i64, i64)>,
}

impl Seen {
    pub fn observe(&mut self, server: &str, list: &List, expanded: bool) {
        let key = format!("{server}~{}", list.scope_key);
        if self.scopes.len() >= 256 && !self.scopes.contains_key(&key) {
            return;
        }
        let (baseline, newest) = self.scopes.entry(key.clone()).or_insert_with(|| {
            let stored = storage_read(&key);
            (stored, stored)
        });
        if expanded
            && let Some(at) = timestamp(&list.observed_at)
            && at > *newest
        {
            *newest = at;
            storage_write(&key, at.max(*baseline));
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
fn storage_read(key: &str) -> i64 {
    storage()
        .and_then(|store| store.get_item(&storage_key(key)).ok().flatten())
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

#[cfg(target_arch = "wasm32")]
fn storage_write(key: &str, at: i64) {
    if let Some(store) = storage() {
        let _ = store.set_item(&storage_key(key), &at.max(storage_read(key)).to_string());
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
fn storage_read(_: &str) -> i64 {
    0
}

#[cfg(not(target_arch = "wasm32"))]
fn storage_write(_: &str, _: i64) {}
