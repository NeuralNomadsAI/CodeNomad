use super::history_ids::{bounded, HistoryIds};
use super::{allowed_url, BrowserController, Registration};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::Manager;

#[cfg(target_os = "linux")]
#[path = "browser_history_linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "browser_history_macos.rs"]
mod platform;

#[derive(Default)]
struct History {
    ids: HistoryIds,
    retained: Vec<platform::Entry>,
    handles: Vec<i64>,
}

thread_local! {
    // Native objects are retained and released only on the UI thread.
    static HISTORIES: RefCell<HashMap<String, History>> = RefCell::new(HashMap::new());
}

pub(super) fn remove<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: String) {
    let _ = app.run_on_main_thread(move || {
        HISTORIES.with(|histories| histories.borrow_mut().remove(&label));
    });
}

#[cfg(target_os = "linux")]
pub(super) fn install(
    webview: &tauri::Webview,
    controller: BrowserController,
    registration: Registration,
) -> Result<(), String> {
    let app = webview.app_handle().clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |native| {
            let changed = move |url: String| {
                controller.emit_webkit_navigation(&app, &registration, &url);
            };
            #[cfg(target_os = "linux")]
            platform::observe(&native.inner(), changed);
            let _ = sender.send(());
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out configuring native browser history".to_string())
}

#[cfg(target_os = "macos")]
pub(super) fn install(
    _: &tauri::Webview,
    _: BrowserController,
    _: Registration,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn observe(
    app: tauri::AppHandle,
    controller: BrowserController,
    registration: Registration,
) {
    // WKBackForwardList has no public change notification for repeated same-URL
    // pushState. Hidden previews also publish navigations for saved restoration.
    // ponytail: one sleeping worker per preview; share a sampler if tab counts
    // make worker stacks significant. Native objects stay on the UI thread.
    std::thread::spawn(move || {
        let mut previous = Value::Null;
        loop {
            let Ok(current) = controller
                .owned_registration(&registration.window_label, &registration.registration_id)
            else {
                break;
            };
            if current.generation != registration.generation {
                break;
            }
            let Some(webview) = app.get_webview(&current.webview_label) else {
                break;
            };
            if let Ok(history) = action(&controller, &webview, &current, None) {
                if previous != history {
                    if let Some(index) = history["index"].as_u64() {
                        if let Some(url) = history["entries"][index as usize]["url"].as_str() {
                            controller.emit_webkit_navigation(&app, &registration, url);
                        }
                    }
                    previous = history;
                }
            }
            std::thread::sleep(Duration::from_millis(if current.visible {
                250
            } else {
                1000
            }));
        }
    });
}

pub(super) fn action(
    controller: &BrowserController,
    webview: &tauri::Webview,
    registration: &Registration,
    entry_id: Option<i64>,
) -> Result<Value, String> {
    let expected = registration.clone();
    let current = controller.clone();
    let deadline = Instant::now() + Duration::from_secs(5);
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |native| {
            let result: Result<Value, String> = (|| {
                if Instant::now() >= deadline {
                    return Err("Native browser history request expired".into());
                }
                current.check_history_registration(&expected)?;
                let view = native.inner();
                #[cfg(target_os = "linux")]
                let view = &view;
                let (entries, current_token) = platform::snapshot(view);
                let entries = bounded(entries, current_token, platform::Entry::token)
                    .into_iter()
                    .filter(|entry| {
                        let url = entry.url();
                        url.len() <= 2048 && allowed_url(&url).is_ok()
                    })
                    .collect::<Vec<_>>();
                HISTORIES.with(|histories| {
                    let mut histories = histories.borrow_mut();
                    let history = histories.entry(expected.webview_label.clone()).or_default();
                    let handles = history
                        .ids
                        .reconcile(entries.iter().map(|entry| entry.token()));
                    // Reconcile before dropping the old native references.
                    history.retained = entries;
                    history.handles = handles;
                    if let Some(id) = entry_id {
                        let index = history
                            .handles
                            .iter()
                            .position(|handle| *handle == id)
                            .ok_or("Invalid browser history entry")?;
                        // Release the RefCell borrow before native navigation, whose
                        // signals can reenter the observer synchronously.
                        let entry = history.retained[index].clone();
                        drop(histories);
                        current.check_history_registration(&expected)?;
                        if Instant::now() >= deadline {
                            return Err("Native browser history request expired".into());
                        }
                        platform::go(view, &entry)?;
                        return Ok(Value::Null);
                    }
                    let index = history
                        .retained
                        .iter()
                        .position(|entry| Some(entry.token()) == current_token)
                        .map(|index| index as i64)
                        .unwrap_or(-1);
                    let entries = history
                        .retained
                        .iter()
                        .zip(&history.handles)
                        .map(|(entry, id)| json!({ "id": id, "url": entry.url() }))
                        .collect::<Vec<_>>();
                    Ok(json!({ "entries": entries, "index": index }))
                })
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    let result = receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| "Timed out reading native browser history".to_string())??;
    controller.check_history_registration(registration)?;
    Ok(result)
}
