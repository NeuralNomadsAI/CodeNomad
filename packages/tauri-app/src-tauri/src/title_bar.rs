//! Application window chrome. The UI draws the title bar of local application and
//! Preferences windows. Windows and Linux windows are undecorated; on macOS the
//! native title bar becomes an overlay, so the traffic lights keep their standard
//! place at the left of the UI's title bar, and the menus stay in the global menu bar.

use tauri::{Manager, Runtime, Webview, WebviewWindowBuilder};

pub(crate) fn configure<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    builder
}

/// The traffic lights never zoom, so on macOS the UI title bar undoes the page zoom,
/// which WebKit hides from the page. Publish it as `--host-page-zoom` and its inverse
/// `--host-page-unzoom` on the document; call after every load and zoom change.
pub(crate) fn publish_page_zoom<R: Runtime>(webview: &Webview<R>, zoom: f64) {
    #[cfg(target_os = "macos")]
    {
        let zoom = if zoom.is_finite() && zoom > 0.0 { zoom } else { 1.0 };
        let _ = webview.eval(format!(
            "document.documentElement.style.setProperty('--host-page-zoom','{zoom}');\
             document.documentElement.style.setProperty('--host-page-unzoom','{}')",
            1.0 / zoom
        ));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (webview, zoom);
}
