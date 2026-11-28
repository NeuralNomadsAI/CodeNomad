use crate::history::Result;
use crate::workspace::MAX_BYTES;
use codenomad_client::timeline::SAVED_BYTES as OUTLINE_BYTES;

#[cfg(target_arch = "wasm32")]
pub(crate) fn browser_file_wrap() -> Option<bool> {
    let storage = web_sys::window()?.local_storage().ok()??;
    match storage
        .get_item(crate::workspace::FILE_WRAP_KEY)
        .ok()??
        .as_str()
    {
        "on" => Some(true),
        "off" => Some(false),
        _ => None,
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn set_browser_file_wrap(wrap: bool) {
    if let Some(storage) =
        web_sys::window().and_then(|window| window.local_storage().ok().flatten())
    {
        let _ = storage.set_item(
            crate::workspace::FILE_WRAP_KEY,
            if wrap { "on" } else { "off" },
        );
    }
}

const FILE_DRAFT_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestoreMode {
    Enabled,
    Disabled,
    Unknown,
}

#[cfg(any(target_arch = "wasm32", test))]
pub(crate) trait WebDepartStorage {
    fn set_item(&mut self, key: &str, value: &str) -> std::result::Result<(), ()>;
}

#[cfg(any(target_arch = "wasm32", test))]
pub(crate) struct WebDepartKeys<'a> {
    pub state: &'a str,
    pub file_drafts: &'a str,
    pub released: &'a str,
}

#[cfg(any(target_arch = "wasm32", test))]
pub(crate) struct WebDepartInput<'a> {
    pub frozen: bool,
    pub restore: RestoreMode,
    pub snapshot_suppressed: bool,
    pub snapshot: Option<&'a [u8]>,
    pub pending_file_drafts: Option<Option<&'a [u8]>>,
    pub max_file_draft_bytes: usize,
    pub keys: WebDepartKeys<'a>,
}

/// Persists staged Web startup state on `pagehide` and returns whether server workspace records
/// may safely be released. Any failure persisting pending file drafts (including `sessionStorage`
/// quota errors after Clear) keeps records intact.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn depart_web_state(
    storage: &mut impl WebDepartStorage,
    input: WebDepartInput<'_>,
) -> bool {
    if input.frozen || input.restore == RestoreMode::Unknown {
        // An unconfirmed startup-state mutation or unreadable preference must keep records.
        return false;
    }
    if input.restore == RestoreMode::Disabled {
        return true;
    }
    let drafts_ok = match input.pending_file_drafts {
        Some(None) => true,
        None => false,
        Some(Some(bytes)) => {
            bytes.len() <= input.max_file_draft_bytes
                && std::str::from_utf8(bytes)
                    .is_ok_and(|text| storage.set_item(input.keys.file_drafts, text).is_ok())
        }
    };
    if input.snapshot_suppressed {
        return drafts_ok;
    }
    let snapshot_ok = input.snapshot.is_some_and(|bytes| {
        !bytes.is_empty()
            && std::str::from_utf8(bytes)
                .is_ok_and(|text| storage.set_item(input.keys.state, text).is_ok())
    });
    drafts_ok && snapshot_ok && storage.set_item(input.keys.released, "1").is_ok()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClearOutcome {
    pub state_ok: bool,
    pub outlines_ok: bool,
    pub drafts_ok: bool,
}

impl ClearOutcome {
    pub fn all_ok(self) -> bool {
        self.state_ok && self.outlines_ok && self.drafts_ok
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn configured_directory() -> Option<std::path::PathBuf> {
    crate::platform::setting("CODENOMAD_PROFILE")
        .filter(|profile| profile.starts_with("trial-"))?;
    crate::platform::setting("RUNE_STATE_DIR").map(std::path::PathBuf::from)
}

#[cfg(not(target_arch = "wasm32"))]
mod native;
#[cfg(not(target_arch = "wasm32"))]
pub use native::Store;

#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_arch = "wasm32")]
pub use web::{Store, cancel_openings};

pub fn unix_millis() -> u64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis().min(9_007_199_254_740_991) as u64)
    }
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now().clamp(0.0, 9_007_199_254_740_991.0) as u64
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
