use tauri::{LogicalSize, Window};

pub(crate) fn zoomed_minimum(zoom: f64) -> (i32, i32) {
    let zoom = if zoom.is_finite() && zoom > 0.0 {
        zoom.clamp(0.25, 5.0)
    } else {
        1.0
    };
    (
        (f64::from(crate::client_state::MIN_WINDOW_WIDTH) * zoom).ceil() as i32,
        (600.0 * zoom).ceil() as i32,
    )
}

pub(crate) fn apply(window: &Window, zoom: f64) {
    // Preferences keep their separate layout contract; preview children must
    // never change their parent's constraints.
    if window.label() == crate::preferences_window::LABEL {
        return;
    }
    let (width, height) = zoomed_minimum(zoom);
    let mut minimum = LogicalSize::new(f64::from(width), f64::from(height));
    let scale = window.scale_factor().unwrap_or(1.0);
    if let Ok(Some(monitor)) = window.current_monitor() {
        let area = monitor.work_area().size.to_logical::<f64>(scale);
        let chrome = window
            .outer_size()
            .ok()
            .zip(window.inner_size().ok())
            .map(|(outer, inner)| {
                (
                    f64::from(outer.width.saturating_sub(inner.width)) / scale,
                    f64::from(outer.height.saturating_sub(inner.height)) / scale,
                )
            })
            .unwrap_or((0.0, 0.0));
        minimum.width = minimum.width.min((area.width - chrome.0).max(1.0));
        minimum.height = minimum.height.min((area.height - chrome.1).max(1.0));
    }
    if let Err(error) = window.set_min_size(Some(minimum)) {
        eprintln!("[window] failed to update zoom-dependent minimum: {error}");
        return;
    }
    if !window.is_maximized().unwrap_or(false) && !window.is_fullscreen().unwrap_or(false) {
        if let Ok(size) = window.inner_size() {
            let size = size.to_logical::<f64>(scale);
            if size.width < minimum.width || size.height < minimum.height {
                let _ = window.set_size(LogicalSize::new(
                    size.width.max(minimum.width),
                    size.height.max(minimum.height),
                ));
            }
        }
    }
}

#[cfg(windows)]
pub(crate) fn register_remote_zoom(window: &tauri::WebviewWindow, app: &tauri::AppHandle) {
    use tauri::Manager;
    use webview2_com::ZoomFactorChangedEventHandler;

    let app = app.clone();
    let label = window.label().to_string();
    if let Err(error) = window.with_webview(move |webview| {
        let callback_app = app.clone();
        let handler = ZoomFactorChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(controller) = sender else {
                return Ok(());
            };
            let mut zoom = 1.0;
            unsafe { controller.ZoomFactor(&mut zoom)? };
            if !zoom.is_finite() || zoom <= 0.0 {
                return Ok(());
            }
            if let Ok(mut levels) = callback_app
                .state::<crate::AppState>()
                .remote_zoom_levels
                .lock()
            {
                levels.insert(label.clone(), zoom.clamp(0.25, 5.0));
            }
            if let Some(window) = callback_app.get_window(&label) {
                // Defer native resizing until after the WebView2 callback returns.
                let target = window.clone();
                let _ = window.run_on_main_thread(move || apply(&target, zoom));
            }
            Ok(())
        }));
        let mut token = 0;
        if let Err(error) = unsafe {
            webview
                .controller()
                .add_ZoomFactorChanged(&handler, &mut token)
        } {
            eprintln!("[window] failed to register remote zoom handler: {error}");
        }
    }) {
        eprintln!("[window] failed to access remote zoom controller: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::zoomed_minimum;

    #[test]
    fn minimum_tracks_zoom_not_monitor_dpi() {
        for (zoom, expected) in [
            (0.5, (195, 300)),
            (1.0, (390, 600)),
            (1.25, (488, 750)),
            (1.5, (585, 900)),
        ] {
            assert_eq!(zoomed_minimum(zoom), expected);
        }
        assert_eq!(zoomed_minimum(f64::NAN), (390, 600));
        assert_eq!(zoomed_minimum(0.01), (98, 150));
        assert_eq!(zoomed_minimum(10.0), (1950, 3000));
    }
}
