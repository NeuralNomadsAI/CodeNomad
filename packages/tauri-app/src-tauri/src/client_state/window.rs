use super::ClientState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WindowEvent};

const MIN_WINDOW_WIDTH: i32 = 800;
const MIN_WINDOW_HEIGHT: i32 = 600;
const MIN_ZOOM_LEVEL: f64 = 0.25;
pub(super) const MAX_ZOOM_LEVEL: f64 = 5.0;
pub const DEFAULT_ZOOM_LEVEL: f64 = 1.0;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowBounds {
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) width: i32,
    pub(super) height: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeWindowState {
    pub(super) bounds: WindowBounds,
    pub(super) maximized: bool,
    pub(super) fullscreen: bool,
    pub(super) zoom_factor: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct DisplayArea {
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) scale_factor: f64,
}

struct ClampedBounds {
    logical: WindowBounds,
    physical: WindowBounds,
}

pub(super) fn normalize_window_state(value: &Value) -> Option<NativeWindowState> {
    let value = value.as_object()?;
    if value.len() != 4
        || !["bounds", "maximized", "fullscreen", "zoomFactor"]
            .iter()
            .all(|key| value.contains_key(*key))
    {
        return None;
    }
    let bounds_value = value.get("bounds")?.as_object()?;
    if bounds_value.len() != 4
        || !["x", "y", "width", "height"]
            .iter()
            .all(|key| bounds_value.contains_key(*key))
    {
        return None;
    }
    let bounds: WindowBounds = serde_json::from_value(value.get("bounds")?.clone()).ok()?;
    if bounds.width <= 0 || bounds.height <= 0 {
        return None;
    }
    let maximized = value.get("maximized")?.as_bool()?;
    let fullscreen = value.get("fullscreen")?.as_bool()?;
    let zoom_factor = value.get("zoomFactor")?.as_f64()?;
    if !zoom_factor.is_finite() || !(MIN_ZOOM_LEVEL..=MAX_ZOOM_LEVEL).contains(&zoom_factor) {
        return None;
    }

    Some(NativeWindowState {
        bounds,
        maximized,
        fullscreen,
        zoom_factor,
    })
}

fn normalize_zoom_level(value: Option<f64>) -> f64 {
    match value {
        Some(value) if value.is_finite() && value > 0.0 => {
            value.clamp(MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL)
        }
        _ => DEFAULT_ZOOM_LEVEL,
    }
}

pub(super) fn normalize_native_zoom_level(value: f64) -> Option<f64> {
    (value.is_finite() && value > 0.0).then(|| normalize_zoom_level(Some(value)))
}

pub(super) fn clamp_window_bounds(
    bounds: &WindowBounds,
    displays: &[DisplayArea],
) -> Option<WindowBounds> {
    clamp_window_bounds_for_restore(bounds, displays).map(|bounds| bounds.logical)
}

fn clamp_window_bounds_for_restore(
    bounds: &WindowBounds,
    displays: &[DisplayArea],
) -> Option<ClampedBounds> {
    let display = displays
        .iter()
        .copied()
        .filter(|display| {
            display.width > 0
                && display.height > 0
                && display.scale_factor.is_finite()
                && display.scale_factor > 0.0
        })
        .reduce(|best, candidate| {
            let best_intersection = intersection_area(bounds, best);
            let candidate_intersection = intersection_area(bounds, candidate);
            if candidate_intersection > best_intersection
                || (candidate_intersection == best_intersection
                    && center_distance_squared(bounds, candidate)
                        < center_distance_squared(bounds, best))
            {
                candidate
            } else {
                best
            }
        })?;
    let scale = display.scale_factor;
    let maximum_width = display.width.min(i32::MAX as u32) as i32;
    let maximum_height = display.height.min(i32::MAX as u32) as i32;
    let requested_width = (f64::from(bounds.width) * scale).round() as i32;
    let requested_height = (f64::from(bounds.height) * scale).round() as i32;
    let minimum_width = (f64::from(MIN_WINDOW_WIDTH) * scale).round() as i32;
    let minimum_height = (f64::from(MIN_WINDOW_HEIGHT) * scale).round() as i32;
    let width = requested_width.clamp(minimum_width.min(maximum_width), maximum_width);
    let height = requested_height.clamp(minimum_height.min(maximum_height), maximum_height);
    let minimum_x = i64::from(display.x);
    let minimum_y = i64::from(display.y);
    let maximum_x = (minimum_x + i64::from(maximum_width - width)).min(i64::from(i32::MAX));
    let maximum_y = (minimum_y + i64::from(maximum_height - height)).min(i64::from(i32::MAX));

    let physical = WindowBounds {
        x: ((f64::from(bounds.x) * scale).round() as i64).clamp(minimum_x, maximum_x) as i32,
        y: ((f64::from(bounds.y) * scale).round() as i64).clamp(minimum_y, maximum_y) as i32,
        width,
        height,
    };
    Some(ClampedBounds {
        logical: WindowBounds {
            x: (f64::from(physical.x) / scale).round() as i32,
            y: (f64::from(physical.y) / scale).round() as i32,
            width: (f64::from(physical.width) / scale).round() as i32,
            height: (f64::from(physical.height) / scale).round() as i32,
        },
        physical,
    })
}

fn intersection_area(bounds: &WindowBounds, display: DisplayArea) -> i64 {
    let scale = display.scale_factor;
    let x = (f64::from(bounds.x) * scale).round() as i64;
    let y = (f64::from(bounds.y) * scale).round() as i64;
    let width = (f64::from(bounds.width) * scale).round() as i64;
    let height = (f64::from(bounds.height) * scale).round() as i64;
    let left = x.max(i64::from(display.x));
    let top = y.max(i64::from(display.y));
    let right = (x + width).min(i64::from(display.x) + i64::from(display.width));
    let bottom = (y + height).min(i64::from(display.y) + i64::from(display.height));
    (right - left).max(0) * (bottom - top).max(0)
}

fn center_distance_squared(bounds: &WindowBounds, display: DisplayArea) -> i128 {
    let scale = display.scale_factor;
    let bounds_x = ((f64::from(bounds.x) * 2.0 + f64::from(bounds.width)) * scale).round() as i128;
    let bounds_y = ((f64::from(bounds.y) * 2.0 + f64::from(bounds.height)) * scale).round() as i128;
    let display_x = i128::from(display.x) * 2 + i128::from(display.width);
    let display_y = i128::from(display.y) * 2 + i128::from(display.height);
    (bounds_x - display_x).pow(2) + (bounds_y - display_y).pow(2)
}

fn capture_window_in_memory(app: &AppHandle, window_label: &str, window_id: &str, persisted: bool) {
    if !persisted {
        return;
    }
    let Some(client_state) = app.try_state::<ClientState>() else {
        return;
    };
    let Ok(_write) = client_state.write_lock.lock() else {
        return;
    };
    if !client_state.is_primary() {
        return;
    }
    if client_state
        .normal_writes_suppressed(window_id)
        .unwrap_or(true)
    {
        return;
    }
    let Some(window) = app.get_webview_window(window_label) else {
        return;
    };

    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let current_bounds = if !maximized && !fullscreen && !minimized {
        window
            .outer_position()
            .ok()
            .zip(window.inner_size().ok())
            .and_then(|(position, size)| {
                let position = position.to_logical::<i32>(scale_factor);
                let size = size.to_logical::<u32>(scale_factor);
                let bounds = WindowBounds {
                    x: position.x,
                    y: position.y,
                    width: size.width.min(i32::MAX as u32) as i32,
                    height: size.height.min(i32::MAX as u32) as i32,
                };
                (bounds.width > 0 && bounds.height > 0).then_some(bounds)
            })
    } else {
        None
    };
    let zoom_factor = client_state
        .zoom_levels
        .lock()
        .ok()
        .and_then(|zoom| zoom.get(window_id).copied())
        .unwrap_or(DEFAULT_ZOOM_LEVEL);
    let Ok(mut state) = client_state.state.lock() else {
        return;
    };
    let Ok(record) = state.record_mut(window_id) else {
        return;
    };
    let bounds =
        current_bounds.or_else(|| record.window.as_ref().map(|window| window.bounds.clone()));
    if let Some(bounds) = bounds {
        record.window = Some(NativeWindowState {
            bounds,
            maximized,
            fullscreen,
            zoom_factor,
        });
    }
}

fn schedule_flush(app: &AppHandle) {
    let Some(client_state) = app.try_state::<ClientState>() else {
        return;
    };
    client_state.schedule_window_flush(app);
}

#[cfg(windows)]
fn register_native_zoom_handler(
    window: &tauri::WebviewWindow,
    app: &AppHandle,
    window_id: String,
    persisted: bool,
) {
    use webview2_com::ZoomFactorChangedEventHandler;

    let app = app.clone();
    let window_label = window.label().to_string();
    if let Err(err) = window.with_webview(move |webview| {
        let controller = webview.controller();
        let callback_app = app.clone();
        let handler = ZoomFactorChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(controller) = sender else {
                return Ok(());
            };
            let mut native_zoom = 0.0;
            if let Err(err) = unsafe { controller.ZoomFactor(&mut native_zoom) } {
                eprintln!("[client-state] failed to read native zoom level: {err}");
                return Ok(());
            }
            let Some(normalized) = normalize_native_zoom_level(native_zoom) else {
                eprintln!("[client-state] ignored invalid native zoom level: {native_zoom}");
                return Ok(());
            };
            let Some(client_state) = callback_app.try_state::<ClientState>() else {
                return Ok(());
            };
            let Ok(mut zoom_levels) = client_state.zoom_levels.lock() else {
                return Ok(());
            };
            zoom_levels.insert(window_id.clone(), normalized);
            drop(zoom_levels);

            if client_state.is_primary()
                && client_state.normal_writes_suppressed(&window_id).ok() == Some(false)
            {
                capture_window_in_memory(&callback_app, &window_label, &window_id, persisted);
                schedule_flush(&callback_app);
            }
            Ok(())
        }));
        let mut token = 0;
        if let Err(err) = unsafe { controller.add_ZoomFactorChanged(&handler, &mut token) } {
            eprintln!("[client-state] failed to register native zoom handler: {err}");
        }
    }) {
        eprintln!("[client-state] failed to access native webview for zoom tracking: {err}");
    }
}

pub fn setup_local_window(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    window_id: &str,
    persisted: bool,
) -> Result<(), String> {
    let client_state = app.state::<ClientState>();
    if !persisted {
        client_state.register_ephemeral_window(window_id.to_string());
    }
    let initial_zoom = client_state
        .zoom_levels
        .lock()
        .ok()
        .and_then(|zoom| zoom.get(window_id).copied())
        .unwrap_or(DEFAULT_ZOOM_LEVEL);
    let _ = window.set_zoom(initial_zoom);
    #[cfg(windows)]
    register_native_zoom_handler(window, app, window_id.to_string(), persisted);
    if !client_state.is_primary() || !persisted {
        let _ = window.show();
        return Ok(());
    }

    let saved_window = {
        let state = client_state.state.lock().map_err(|err| err.to_string())?;
        let record = state.record(window_id)?;
        record
            .restore_enabled
            .then(|| record.window.clone())
            .flatten()
    };
    if let Some(mut saved_window) = saved_window {
        let displays = window
            .available_monitors()
            .unwrap_or_default()
            .into_iter()
            .map(|monitor| {
                let work_area = monitor.work_area();
                DisplayArea {
                    x: work_area.position.x,
                    y: work_area.position.y,
                    width: work_area.size.width,
                    height: work_area.size.height,
                    scale_factor: monitor.scale_factor(),
                }
            })
            .collect::<Vec<_>>();
        if let Some(bounds) = clamp_window_bounds_for_restore(&saved_window.bounds, &displays) {
            let _ = window.set_size(PhysicalSize::new(
                bounds.physical.width as u32,
                bounds.physical.height as u32,
            ));
            let _ =
                window.set_position(PhysicalPosition::new(bounds.physical.x, bounds.physical.y));
            saved_window.bounds = bounds.logical;
        } else if let Ok(position) = window.outer_position() {
            if let Ok(size) = window.inner_size() {
                let scale_factor = window.scale_factor().unwrap_or(1.0);
                let position = position.to_logical::<i32>(scale_factor);
                let size = size.to_logical::<u32>(scale_factor);
                saved_window.bounds = WindowBounds {
                    x: position.x,
                    y: position.y,
                    width: size.width.min(i32::MAX as u32) as i32,
                    height: size.height.min(i32::MAX as u32) as i32,
                };
            }
        }
        if let Ok(mut state) = client_state.state.lock() {
            if let Ok(record) = state.record_mut(window_id) {
                record.window = Some(saved_window.clone());
            }
        }
        let _ = window.set_zoom(saved_window.zoom_factor);
        if saved_window.maximized {
            let _ = window.maximize();
        }
        if saved_window.fullscreen {
            let _ = window.set_fullscreen(true);
            if cfg!(not(target_os = "macos")) {
                let _ = window.hide_menu();
            }
        }
    }

    capture_window_in_memory(app, window.label(), window_id, persisted);
    let app_handle = app.clone();
    let window_label = window.label().to_string();
    let window_id = window_id.to_string();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_)
        | WindowEvent::Moved(_)
        | WindowEvent::ScaleFactorChanged { .. } => {
            capture_window_in_memory(&app_handle, &window_label, &window_id, persisted);
            schedule_flush(&app_handle);
        }
        _ => {}
    });
    let _ = window.show();
    Ok(())
}

pub fn set_local_window_zoom(app: &AppHandle, window_label: &str, next_zoom: f64) {
    let Some(window) = app.get_webview_window(window_label) else {
        return;
    };
    let normalized = normalize_zoom_level(Some(next_zoom));
    if window.set_zoom(normalized).is_err() {
        return;
    }
    let Some(client_state) = app.try_state::<ClientState>() else {
        return;
    };
    let Ok(window_id) = crate::identity::local_window_id(window_label) else {
        return;
    };
    if let Ok(mut zoom_levels) = client_state.zoom_levels.lock() {
        zoom_levels.insert(window_id.clone(), normalized);
    }
    let persisted = app
        .try_state::<crate::local_windows::LocalWindows>()
        .and_then(|windows| windows.record(window_label))
        .is_some_and(|record| record.persisted);
    capture_window_in_memory(app, window_label, &window_id, persisted);
    if let Err(err) = client_state.flush() {
        eprintln!("[client-state] failed to save zoom level: {err}");
    }
}

pub fn local_window_zoom(app: &AppHandle, window_label: &str) -> f64 {
    app.try_state::<ClientState>()
        .and_then(|state| {
            let window_id = crate::identity::local_window_id(window_label).ok()?;
            state
                .zoom_levels
                .lock()
                .ok()
                .and_then(|zoom| zoom.get(&window_id).copied())
        })
        .unwrap_or(DEFAULT_ZOOM_LEVEL)
}

pub fn capture_and_flush_window(app: &AppHandle, window_label: &str) {
    let Some(record) = app
        .try_state::<crate::local_windows::LocalWindows>()
        .and_then(|windows| windows.record(window_label))
    else {
        return;
    };
    capture_window_in_memory(app, window_label, &record.id, record.persisted);
    if let Some(state) = app.try_state::<ClientState>() {
        if let Err(err) = state.flush() {
            eprintln!("[client-state] failed to flush local window state: {err}");
        }
    }
}

pub fn capture_and_flush_all_windows(app: &AppHandle) {
    if let Some(windows) = app.try_state::<crate::local_windows::LocalWindows>() {
        for record in windows.records() {
            capture_window_in_memory(app, &record.label, &record.id, record.persisted);
        }
    }
    if let Some(state) = app.try_state::<ClientState>() {
        if let Err(err) = state.flush() {
            eprintln!("[client-state] failed to flush local window state: {err}");
        }
    }
}
