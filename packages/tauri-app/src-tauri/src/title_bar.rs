//! Application window chrome. The UI draws the title bar of local application and
//! Preferences windows. Windows and Linux windows are undecorated; on macOS the
//! native title bar becomes an overlay, so the traffic lights keep their standard
//! place at the left of the UI's title bar, and the menus stay in the global menu bar.

use tauri::{Manager, Runtime, WebviewWindowBuilder};

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
