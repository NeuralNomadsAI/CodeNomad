// CodeNomad: an agent's page actions cancel the file panels a page opens (see the vendor README).
use std::{
  collections::HashSet,
  ffi::c_void,
  sync::{Mutex, OnceLock},
};

fn refused() -> &'static Mutex<HashSet<usize>> {
  static REFUSED: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();
  REFUSED.get_or_init(Default::default)
}

/// While set for a WKWebView, a file panel its page opens is cancelled without being shown.
pub fn set_file_panels_refused(webview: *mut c_void, refused_now: bool) {
  if let Ok(mut set) = refused().lock() {
    if refused_now {
      set.insert(webview as usize);
    } else {
      set.remove(&(webview as usize));
    }
  }
}

pub(crate) fn file_panels_refused(webview: *const c_void) -> bool {
  refused()
    .lock()
    .is_ok_and(|set| set.contains(&(webview as usize)))
}