//! Native menu bar visibility. Windows and Linux windows render their menus in the
//! application title bar, so the native menu bar stays attached (it carries the
//! menu accelerators) but hidden; the macOS menu bar is global and stays visible.
//! GTK shows every child widget when a window is shown (`show_all`), which would
//! bring a hidden bar back, so on Linux the bar is also excluded from `show_all`;
//! and GTK only activates the accelerators of on-screen widgets, so the hidden bar
//! keeps allowing them.

use tauri::{Runtime, Window};

pub(crate) fn hide<R: Runtime>(window: &Window<R>) {
    #[cfg(not(target_os = "macos"))]
    let _ = window.hide_menu();
    #[cfg(target_os = "linux")]
    {
        let target = window.clone();
        // GTK widgets are main-thread only; on the main thread this runs immediately.
        let _ = window.run_on_main_thread(move || keep_hidden_when_shown(&target));
    }
}

#[cfg(target_os = "linux")]
fn keep_hidden_when_shown<R: Runtime>(window: &Window<R>) {
    use gtk::prelude::*;
    let Ok(vbox) = window.default_vbox() else {
        return;
    };
    for child in vbox.children() {
        if let Ok(bar) = child.downcast::<gtk::MenuBar>() {
            if !bar.is_no_show_all() {
                bar.set_no_show_all(true);
                // Menu items ask the bar whether their accelerators may fire.
                bar.connect_can_activate_accel(|_, _| true);
            }
            bar.hide();
        }
    }
}
