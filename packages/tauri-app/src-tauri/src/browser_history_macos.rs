//! WKWebView history, called exclusively from Tauri's UI-thread callback.
//!
//! Keep the previous snapshot alive while taking its replacement. Retention
//! prevents pointer reuse while the common registry assigns monotonic public IDs.
//! Store entries in the UI-thread registry and drop them there during cleanup.

use std::ffi::c_void;

use objc2::{rc::Retained, MainThreadMarker};
use objc2_web_kit::{WKBackForwardListItem, WKWebView};

const LIMIT: usize = 32;

#[derive(Clone)]
pub(super) struct Entry(Retained<WKBackForwardListItem>);

impl Entry {
    pub(super) fn token(&self) -> usize {
        Retained::as_ptr(&self.0) as usize
    }

    pub(super) fn url(&self) -> String {
        // SAFETY: Entry is main-thread-only, as is its retained WebKit item.
        unsafe { self.0.URL() }
            .absoluteString()
            .map(|url| url.to_string())
            .unwrap_or_default()
    }
}

// Select a contiguous chronological window, filling spare capacity at either end.
fn window(back: usize, forward: usize) -> (isize, isize) {
    let before = back
        .min(LIMIT / 2)
        .max(LIMIT.saturating_sub(1 + forward).min(back));
    let after = forward.min(LIMIT - 1 - before);
    (-(before as isize), after as isize)
}

/// `webview` must be a live WKWebView supplied by Tauri's UI-thread callback.
/// A null pointer yields an empty snapshot.
pub(super) fn snapshot(webview: *mut c_void) -> (Vec<Entry>, Option<usize>) {
    assert!(
        MainThreadMarker::new().is_some(),
        "WebKit history requires the UI thread"
    );
    // SAFETY: The caller supplies the live native view for the duration of this call.
    let Some(webview) = (unsafe { webview.cast::<WKWebView>().as_ref() }) else {
        return (Vec::new(), None);
    };
    // SAFETY: All WebKit accesses occur on the main thread with a live view.
    unsafe {
        let list = webview.backForwardList();
        let Some(current) = list.currentItem() else {
            return (Vec::new(), None);
        };
        let current_token = Retained::as_ptr(&current) as usize;
        // Probe only the bounded neighbourhood; avoid materializing the full list.
        let back = (1..LIMIT)
            .take_while(|offset| list.itemAtIndex(-(*offset as isize)).is_some())
            .count();
        let forward = (1..LIMIT)
            .take_while(|offset| list.itemAtIndex(*offset as isize).is_some())
            .count();
        let (start, end) = window(back, forward);
        let entries = (start..=end)
            .filter_map(|offset| list.itemAtIndex(offset).map(Entry))
            .collect();
        (entries, Some(current_token))
    }
}

/// `webview` must be a live WKWebView supplied by Tauri's UI-thread callback.
pub(super) fn go(webview: *mut c_void, entry: &Entry) -> Result<(), String> {
    let (entries, current) = snapshot(webview);
    if !entries
        .iter()
        .any(|candidate| candidate.token() == entry.token())
    {
        return Err("Native history entry is stale".into());
    }
    if current == Some(entry.token()) {
        return Ok(());
    }
    // SAFETY: snapshot validated the live view and membership on this UI thread.
    let navigation = unsafe { (&*webview.cast::<WKWebView>()).goToBackForwardListItem(&entry.0) };
    navigation
        .map(|_| ())
        .ok_or_else(|| "Native history navigation was rejected".into())
}

#[cfg(test)]
mod tests {
    use super::{window, LIMIT};

    #[test]
    fn bounded_window_keeps_current_and_fills_edges() {
        for back in 0..=64 {
            for forward in 0..=64 {
                let (start, end) = window(back, forward);
                assert!(start <= 0 && end >= 0);
                assert!(-start <= back as isize && end <= forward as isize);
                assert_eq!((end - start + 1) as usize, LIMIT.min(back + 1 + forward));
            }
        }
        assert_eq!(window(64, 64), (-16, 15));
    }
}
