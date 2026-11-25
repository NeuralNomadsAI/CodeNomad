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
pub(super) enum RestoreMode {
    Enabled,
    Disabled,
    Unknown,
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
