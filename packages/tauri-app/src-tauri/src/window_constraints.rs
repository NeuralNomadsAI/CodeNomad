use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{LogicalSize, Manager, PhysicalSize, Window, WindowEvent};

// The pinned runtime has resize/move/DPI events, but no work-area or window-state
// event. A bounded fallback also detects taskbar/display changes and transitions
// that do not change the client size. No native setters run in event callbacks.
const ENVIRONMENT_CHECK: Duration = Duration::from_millis(500);
const COALESCE: Duration = Duration::from_millis(16);

#[derive(Default)]
pub(crate) struct WindowConstraints(Mutex<HashMap<String, Arc<Registration>>>);

struct Registration {
    updates: Mutex<Updates>,
    wake: Condvar,
}

struct Updates {
    zoom: f64,
    applied: Option<Minimum>,
    dirty: bool,
    queued: bool,
    closed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Minimum {
    width: f64,
    height: f64,
    scale: f64,
}

fn normalize_zoom(zoom: f64) -> f64 {
    if zoom.is_finite() && zoom > 0.0 {
        zoom.clamp(0.25, 5.0)
    } else {
        1.0
    }
}

pub(crate) fn zoomed_minimum(zoom: f64) -> (i32, i32) {
    let zoom = normalize_zoom(zoom);
    (
        (f64::from(crate::client_state::MIN_WINDOW_WIDTH) * zoom).ceil() as i32,
        (600.0 * zoom).ceil() as i32,
    )
}

fn minimum(zoom: f64, scale: f64, area: Option<(f64, f64)>, chrome: (f64, f64)) -> Minimum {
    let (width, height) = zoomed_minimum(zoom);
    let mut result = Minimum {
        width: f64::from(width),
        height: f64::from(height),
        scale,
    };
    if let Some((width, height)) = area {
        result.width = result.width.min((width - chrome.0).floor().max(1.0));
        result.height = result.height.min((height - chrome.1).floor().max(1.0));
    }
    result
}

fn growth(size: PhysicalSize<u32>, minimum: Minimum) -> Option<PhysicalSize<u32>> {
    let required =
        LogicalSize::new(minimum.width, minimum.height).to_physical::<u32>(minimum.scale);
    // Compare in native pixels, just as Tao does. A rounded 851px at 125% DPI
    // is 680.8 logical pixels; repeatedly requesting 681 would never change it.
    (size.width < required.width || size.height < required.height).then(|| {
        PhysicalSize::new(
            size.width.max(required.width),
            size.height.max(required.height),
        )
    })
}

pub(crate) fn register(window: &Window, zoom: f64) {
    // Only primary local/remote windows are registered. Preferences and preview
    // children retain their own sizing contracts.
    if window.label() == crate::preferences_window::LABEL {
        return;
    }
    let registration = Arc::new(Registration {
        updates: Mutex::new(Updates {
            zoom: normalize_zoom(zoom),
            applied: None,
            dirty: true,
            queued: false,
            closed: false,
        }),
        wake: Condvar::new(),
    });
    {
        let registry = window.state::<WindowConstraints>();
        let mut entries = registry.0.lock().unwrap_or_else(|e| e.into_inner());
        if entries.contains_key(window.label()) {
            return;
        }
        entries.insert(window.label().to_string(), registration.clone());
    }
    let events = registration.clone();
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        match event {
            WindowEvent::Destroyed => {
                events
                    .updates
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .closed = true;
                // Fence queued tasks and label reuse without retaining a native
                // window in the event listener or touching native APIs under locks.
                let registry = app.state::<WindowConstraints>();
                let mut entries = registry.0.lock().unwrap_or_else(|e| e.into_inner());
                if entries
                    .get(&label)
                    .is_some_and(|entry| Arc::ptr_eq(entry, &events))
                {
                    entries.remove(&label);
                }
            }
            WindowEvent::Resized(_)
            | WindowEvent::Moved(_)
            | WindowEvent::ScaleFactorChanged { .. }
            | WindowEvent::Focused(_) => {
                events
                    .updates
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .dirty = true;
            }
            _ => return,
        }
        events.wake.notify_one();
    });
    let window = window.clone();
    std::thread::spawn(move || {
        loop {
            let mut updates = registration
                .updates
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if !updates.dirty || updates.queued {
                let (next, timeout) = registration
                    .wake
                    .wait_timeout(updates, ENVIRONMENT_CHECK)
                    .unwrap_or_else(|e| e.into_inner());
                updates = next;
                if timeout.timed_out() {
                    updates.dirty = true;
                }
            }
            if updates.closed {
                return;
            }
            if !updates.dirty || updates.queued {
                continue;
            }
            drop(updates);
            // Always post from this worker: run_on_main_thread executes inline
            // on the UI thread in Wry, so calling it from WebView2/native callbacks
            // does not defer anything and can pump/reenter their locks.
            std::thread::sleep(COALESCE);
            let mut updates = registration
                .updates
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if updates.closed {
                return;
            }
            updates.dirty = false;
            updates.queued = true;
            drop(updates);
            let target = window.clone();
            let pending = registration.clone();
            if window
                .run_on_main_thread(move || {
                    refresh(&target, &pending);
                    pending
                        .updates
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .queued = false;
                    pending.wake.notify_one();
                })
                .is_err()
            {
                return;
            }
        }
    });
}

// This is the authoritative constraint zoom. Native WebView2 changes and menu
// changes publish here synchronously; queued work reads the latest value rather
// than capturing a stale zoom at scheduling time.
pub(crate) fn apply(window: &Window, zoom: f64) {
    let entry = window
        .state::<WindowConstraints>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(window.label())
        .cloned();
    if let Some(entry) = entry {
        let mut updates = entry.updates.lock().unwrap_or_else(|e| e.into_inner());
        updates.zoom = normalize_zoom(zoom);
        updates.dirty = true;
        drop(updates);
        entry.wake.notify_one();
    }
}

fn refresh(window: &Window, entry: &Registration) {
    let (zoom, applied) = {
        let updates = entry.updates.lock().unwrap_or_else(|e| e.into_inner());
        if updates.closed {
            return;
        }
        (updates.zoom, updates.applied)
    };
    // Tao's Windows set_min_inner_size calls set_inner_size, which unmaximizes.
    // Do not even set the minimum while non-normal (or state is unreadable).
    // The latest desired zoom remains registered and is applied after restore.
    if !matches!(window.is_maximized(), Ok(false))
        || !matches!(window.is_fullscreen(), Ok(false))
        || !matches!(window.is_minimized(), Ok(false))
    {
        return;
    }
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Ok(inner) = window.inner_size() else {
        return;
    };
    let chrome = window
        .outer_size()
        .ok()
        .map(|outer| {
            (
                f64::from(outer.width.saturating_sub(inner.width)) / scale,
                f64::from(outer.height.saturating_sub(inner.height)) / scale,
            )
        })
        .unwrap_or((0.0, 0.0));
    let area = window.current_monitor().ok().flatten().map(|monitor| {
        let size = monitor.work_area().size.to_logical::<f64>(scale);
        (size.width, size.height)
    });
    let next = minimum(zoom, scale, area, chrome);
    if applied != Some(next) {
        if let Err(error) = window.set_min_size(Some(LogicalSize::new(next.width, next.height))) {
            eprintln!("[window] failed to update zoom-dependent minimum: {error}");
            return;
        }
        entry
            .updates
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .applied = Some(next);
    }
    // On Windows the minimum setter already grows the native client area.
    // Re-read after a changed minimum to avoid a redundant resize in that case.
    let inner = if applied != Some(next) {
        window.inner_size().unwrap_or(inner)
    } else {
        inner
    };
    if let Some(size) = growth(inner, next) {
        let _ = window.set_size(size);
    }
}

#[cfg(windows)]
pub(crate) fn register_remote_zoom(window: &tauri::WebviewWindow, app: &tauri::AppHandle) {
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
                levels.insert(label.clone(), normalize_zoom(zoom));
            }
            if let Some(window) = callback_app.get_window(&label) {
                apply(&window, zoom);
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
    use super::{growth, minimum, zoomed_minimum};
    use tauri::PhysicalSize;

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

    #[test]
    fn cap_recomputes_for_monitor_dpi_work_area_and_normal_frame() {
        let large = minimum(5.0, 1.0, Some((2560.0, 1400.0)), (16.0, 39.0));
        let small = minimum(5.0, 1.0, Some((1280.0, 720.0)), (16.0, 39.0));
        assert_eq!((large.width, large.height), (1950.0, 1361.0));
        assert_eq!((small.width, small.height), (1264.0, 681.0));
        let dpi = minimum(5.0, 2.0, Some((1280.0, 700.0)), (8.0, 20.0));
        assert_eq!((dpi.width, dpi.height), (1272.0, 680.0));
        assert_ne!(large, dpi);
        assert_eq!(minimum(1.0, 2.0, None, (8.0, 20.0)).width, 390.0);
        assert_eq!(
            minimum(5.0, 1.5, Some((800.5, 600.5)), (8.0, 20.0)).height,
            580.0
        );
    }

    #[test]
    fn fractional_dpi_does_not_repeat_a_native_no_op_resize() {
        let minimum = minimum(5.0, 1.25, Some((1280.0, 720.0)), (16.0, 39.0));
        let target = PhysicalSize::new(1580, 851);
        assert_eq!(growth(target, minimum), None);
        assert_eq!(growth(PhysicalSize::new(1580, 850), minimum), Some(target));
        assert_eq!(growth(PhysicalSize::new(1800, 1000), minimum), None);
    }
}
