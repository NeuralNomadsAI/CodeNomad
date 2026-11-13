//! Native focused-preview zoom. Guests receive no application scripts or commands.
use super::*;

fn action(command: &str) -> Option<i32> {
    match command {
        "zoom_in" => Some(1),
        "zoom_out" => Some(-1),
        "reset_zoom" => Some(0),
        _ => None,
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
extern "C" {
    fn cn_preview_zoom_install(view: *mut std::ffi::c_void);
    fn cn_preview_zoom_focused(view: *mut std::ffi::c_void, action: i32) -> i32;
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn install<R: Runtime>(view: &tauri::Webview<R>) -> Result<(), String> {
    if !view.label().starts_with("browser-") {
        return Ok(());
    }
    super::mobile::native(view, |ptr| {
        unsafe { cn_preview_zoom_install(ptr) };
        Ok(())
    })
}

/// Called on the menu's UI thread, before falling back to primary-window zoom.
pub(crate) fn focused<R: Runtime>(app: &AppHandle<R>, command: &str) -> bool {
    let Some(action) = action(command) else {
        return false;
    };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let Some(policy) = app.try_state::<EmbeddedViews>() else {
            return false;
        };
        let candidates = policy
            .0
            .lock()
            .map(|inner| {
                inner
                    .records
                    .iter()
                    .filter(|(label, record)| label.starts_with("browser-") && !record.preparing)
                    .map(|(label, record)| (label.clone(), record.token))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (label, token) in candidates {
            let Some(view) = app.get_webview(&label) else {
                continue;
            };
            let guard = policy.inner().clone();
            match super::mobile::native(&view, move |ptr| {
                Ok(guard.current(&label, token)
                    && unsafe { cn_preview_zoom_focused(ptr, action) } != 0)
            }) {
                Ok(true) => return true,
                Ok(false) => {}
                Err(error) => {
                    eprintln!("[browser-zoom] {error}");
                    return true;
                }
            }
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = (app, action);
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_zoom_accepts_only_the_three_menu_actions() {
        assert_eq!(action("zoom_in"), Some(1));
        assert_eq!(action("zoom_out"), Some(-1));
        assert_eq!(action("reset_zoom"), Some(0));
        for other in ["zoom", "set_zoom", "reload", "", "100"] {
            assert_eq!(action(other), None);
        }
    }
}
