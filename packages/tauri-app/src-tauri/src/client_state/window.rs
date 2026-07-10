use super::ClientState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WindowEvent};

const MIN_WINDOW_WIDTH: i32 = 800;
const MIN_WINDOW_HEIGHT: i32 = 600;
const MIN_ZOOM_LEVEL: f64 = 0.25;
pub(super) const MAX_ZOOM_LEVEL: f64 = 5.0;
const SAVE_DEBOUNCE: Duration = Duration::from_millis(250);

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
}

pub(super) fn normalize_window_state(value: &Value) -> Option<NativeWindowState> {
    let value = value.as_object()?;
    let bounds: WindowBounds = serde_json::from_value(value.get("bounds")?.clone()).ok()?;
    if bounds.width <= 0 || bounds.height <= 0 {
        return None;
    }

    Some(NativeWindowState {
        bounds,
        maximized: value.get("maximized").and_then(Value::as_bool) == Some(true),
        fullscreen: value.get("fullscreen").and_then(Value::as_bool) == Some(true),
        zoom_factor: normalize_zoom_level(value.get("zoomFactor").and_then(Value::as_f64)),
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

pub(super) fn clamp_window_bounds(
    bounds: &WindowBounds,
    displays: &[DisplayArea],
) -> Option<WindowBounds> {
    let mut selected: Option<(DisplayArea, i64, i128)> = None;
    for display in displays
        .iter()
        .copied()
        .filter(|display| display.width > 0 && display.height > 0)
    {
        let intersection = intersection_area(bounds, display);
        let distance = center_distance_squared(bounds, display);
        if selected
            .as_ref()
            .map(|(_, best_intersection, best_distance)| {
                intersection > *best_intersection
                    || (intersection == *best_intersection && distance < *best_distance)
            })
            .unwrap_or(true)
        {
            selected = Some((display, intersection, distance));
        }
    }

    let (display, _, _) = selected?;
    let maximum_width = display.width.min(i32::MAX as u32) as i32;
    let maximum_height = display.height.min(i32::MAX as u32) as i32;
    let width = bounds
        .width
        .clamp(MIN_WINDOW_WIDTH.min(maximum_width), maximum_width);
    let height = bounds
        .height
        .clamp(MIN_WINDOW_HEIGHT.min(maximum_height), maximum_height);
    let minimum_x = i64::from(display.x);
    let minimum_y = i64::from(display.y);
    let maximum_x = (minimum_x + i64::from(maximum_width - width)).min(i64::from(i32::MAX));
    let maximum_y = (minimum_y + i64::from(maximum_height - height)).min(i64::from(i32::MAX));

    Some(WindowBounds {
        x: i64::from(bounds.x).clamp(minimum_x, maximum_x) as i32,
        y: i64::from(bounds.y).clamp(minimum_y, maximum_y) as i32,
        width,
        height,
    })
}

fn intersection_area(bounds: &WindowBounds, display: DisplayArea) -> i64 {
    let left = i64::from(bounds.x).max(i64::from(display.x));
    let top = i64::from(bounds.y).max(i64::from(display.y));
    let right = (i64::from(bounds.x) + i64::from(bounds.width))
        .min(i64::from(display.x) + i64::from(display.width));
    let bottom = (i64::from(bounds.y) + i64::from(bounds.height))
        .min(i64::from(display.y) + i64::from(display.height));
    (right - left).max(0) * (bottom - top).max(0)
}

fn center_distance_squared(bounds: &WindowBounds, display: DisplayArea) -> i128 {
    let bounds_x = i128::from(bounds.x) * 2 + i128::from(bounds.width);
    let bounds_y = i128::from(bounds.y) * 2 + i128::from(bounds.height);
    let display_x = i128::from(display.x) * 2 + i128::from(display.width);
    let display_y = i128::from(display.y) * 2 + i128::from(display.height);
    (bounds_x - display_x).pow(2) + (bounds_y - display_y).pow(2)
}

fn capture_main_window_in_memory(app: &AppHandle) {
    let Some(client_state) = app.try_state::<ClientState>() else {
        return;
    };
    let Ok(_write) = client_state.write_lock.lock() else {
        return;
    };
    if !client_state.is_primary() {
        return;
    }
    if client_state.normal_writes_suppressed().unwrap_or(true) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let current_bounds = if !maximized && !fullscreen && !minimized {
        window
            .outer_position()
            .ok()
            .zip(window.inner_size().ok())
            .and_then(|(position, size)| {
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
        .zoom_level
        .lock()
        .map(|zoom| *zoom)
        .unwrap_or(DEFAULT_ZOOM_LEVEL);
    let Ok(mut state) = client_state.state.lock() else {
        return;
    };
    let bounds =
        current_bounds.or_else(|| state.window.as_ref().map(|window| window.bounds.clone()));
    if let Some(bounds) = bounds {
        state.window = Some(NativeWindowState {
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
    let generation = client_state.save_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_DEBOUNCE);
        let Some(client_state) = app.try_state::<ClientState>() else {
            return;
        };
        if client_state.save_generation.load(Ordering::SeqCst) == generation {
            if let Err(err) = client_state.flush() {
                eprintln!("[client-state] failed to save window state: {err}");
            }
        }
    });
}

pub fn setup_main_window(app: &AppHandle) -> Result<(), String> {
    let client_state = app.state::<ClientState>();
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window was not created".to_string())?;
    let initial_zoom = client_state
        .zoom_level
        .lock()
        .map(|zoom| *zoom)
        .unwrap_or(DEFAULT_ZOOM_LEVEL);
    let _ = window.set_zoom(initial_zoom);
    if !client_state.is_primary() {
        let _ = window.show();
        return Ok(());
    }

    let saved_window = {
        let state = client_state.state.lock().map_err(|err| err.to_string())?;
        state
            .restore_enabled
            .then(|| state.window.clone())
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
                }
            })
            .collect::<Vec<_>>();
        if let Some(bounds) = clamp_window_bounds(&saved_window.bounds, &displays) {
            let _ = window.set_size(PhysicalSize::new(bounds.width as u32, bounds.height as u32));
            let _ = window.set_position(PhysicalPosition::new(bounds.x, bounds.y));
            saved_window.bounds = bounds;
        } else if let Ok(position) = window.outer_position() {
            if let Ok(size) = window.inner_size() {
                saved_window.bounds = WindowBounds {
                    x: position.x,
                    y: position.y,
                    width: size.width.min(i32::MAX as u32) as i32,
                    height: size.height.min(i32::MAX as u32) as i32,
                };
            }
        }
        if let Ok(mut state) = client_state.state.lock() {
            state.window = Some(saved_window.clone());
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

    capture_main_window_in_memory(app);
    let app_handle = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_)
        | WindowEvent::Moved(_)
        | WindowEvent::ScaleFactorChanged { .. } => {
            capture_main_window_in_memory(&app_handle);
            schedule_flush(&app_handle);
        }
        _ => {}
    });
    let _ = window.show();
    Ok(())
}

pub fn set_main_window_zoom(app: &AppHandle, next_zoom: f64) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let normalized = normalize_zoom_level(Some(next_zoom));
    if window.set_zoom(normalized).is_err() {
        return;
    }
    let Some(client_state) = app.try_state::<ClientState>() else {
        return;
    };
    if let Ok(mut zoom_level) = client_state.zoom_level.lock() {
        *zoom_level = normalized;
    }
    capture_main_window_in_memory(app);
    if let Err(err) = client_state.flush() {
        eprintln!("[client-state] failed to save zoom level: {err}");
    }
}

pub fn main_window_zoom(app: &AppHandle) -> f64 {
    app.try_state::<ClientState>()
        .and_then(|state| state.zoom_level.lock().ok().map(|zoom| *zoom))
        .unwrap_or(DEFAULT_ZOOM_LEVEL)
}

pub fn capture_and_flush_main_window(app: &AppHandle) {
    capture_main_window_in_memory(app);
    if let Some(state) = app.try_state::<ClientState>() {
        if let Err(err) = state.flush() {
            eprintln!("[client-state] failed to flush main window state: {err}");
        }
    }
}
