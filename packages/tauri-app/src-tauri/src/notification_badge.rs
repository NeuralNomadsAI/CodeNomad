//! Count-only badges. Images and process-wide aggregation stay in the host.
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Webview};
use url::Url;

#[derive(Default)]
struct Counts {
    generation: u64,
    windows: HashMap<String, (u64, u8)>,
}

impl Counts {
    fn reset(&mut self, label: &str) {
        self.generation += 1;
        self.windows.insert(label.into(), (self.generation, 0));
    }

    fn total(&self) -> u64 {
        self.windows
            .values()
            .map(|(_, count)| u64::from(*count))
            .sum()
    }

    fn set(&mut self, label: &str, generation: u64, count: u8) -> Result<(), String> {
        if count > 50 {
            return Err("Notification badge count must be an integer from 0 to 50".into());
        }
        let entry = self
            .windows
            .get_mut(label)
            .ok_or("Notification badge window was closed")?;
        if entry.0 != generation {
            return Err("Notification badge renderer changed before dispatch".into());
        }
        entry.1 = count;
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct NotificationBadge(Mutex<Counts>);

fn is_main_owner(label: &str, window_label: &str, local: bool, remote: bool) -> bool {
    label == window_label
        && label != crate::preferences_window::LABEL
        && ((local && crate::identity::local_window_id(label).is_ok())
            || (remote && label.starts_with("remote-")))
}

fn require_owner(webview: &Webview, app: &AppHandle) -> Result<Url, String> {
    let state = app.state::<crate::AppState>();
    let local = app
        .state::<crate::local_windows::LocalWindows>()
        .record(webview.label())
        .is_some();
    let origin = state
        .remote_navigation
        .lock()
        .map_err(|e| e.to_string())?
        .get(webview.label())
        .map(|metadata| metadata.origin.clone());
    if !is_main_owner(
        webview.label(),
        webview.window().label(),
        local,
        origin.is_some(),
    ) {
        return Err("Notification badges require an owned primary application webview".into());
    }
    if local {
        return crate::require_local_app_webview(webview, &state);
    }
    let current = webview.url().map_err(|e| e.to_string())?;
    if matches!(current.scheme(), "http" | "https")
        && crate::same_origin(&current, origin.as_deref())
    {
        Ok(current)
    } else {
        Err("Notification badge requires the registered remote renderer origin".into())
    }
}

// Native page-load events rotate even on same-URL reloads. Queued updates cannot
// resurrect a previous document's contribution or overwrite another window.
pub(crate) fn page_started(app: &AppHandle, webview: &Webview) {
    if webview.label() != webview.window().label()
        || webview.label() == crate::preferences_window::LABEL
    {
        return;
    }
    if crate::identity::local_window_id(webview.label()).is_err()
        && !webview.label().starts_with("remote-")
    {
        return;
    }
    app.state::<NotificationBadge>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .reset(webview.label());
    publish(app);
}

pub(crate) fn remove_window(app: &AppHandle, label: &str) {
    app.state::<NotificationBadge>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .windows
        .remove(label);
    publish(app);
}

fn publish(app: &AppHandle) {
    let count = app
        .state::<NotificationBadge>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .total();
    #[cfg(windows)]
    let image = (count > 0).then(|| tauri::image::Image::new_owned(badge_rgba(count), 32, 32));
    for webview in app.webviews().into_values() {
        let state = app.state::<crate::AppState>();
        let local = app
            .state::<crate::local_windows::LocalWindows>()
            .record(webview.label())
            .is_some();
        let remote = state
            .remote_navigation
            .lock()
            .ok()
            .is_some_and(|origins| origins.contains_key(webview.label()));
        if !is_main_owner(webview.label(), webview.window().label(), local, remote) {
            continue;
        }
        #[cfg(windows)]
        let result = webview.window().set_overlay_icon(image.clone());
        #[cfg(not(windows))]
        let result = webview
            .window()
            .set_badge_count((count > 0).then_some(count as i64));
        if let Err(error) = result {
            eprintln!("[notification-badge] native badge unavailable: {error}");
        }
    }
}

#[tauri::command]
pub(crate) async fn notification_badge_set(webview: Webview, count: u8) -> Result<(), String> {
    if count > 50 {
        return Err("Notification badge count must be an integer from 0 to 50".into());
    }
    let app = webview.app_handle().clone();
    let url = require_owner(&webview, &app)?;
    let generation = app
        .state::<NotificationBadge>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .windows
        .get(webview.label())
        .map(|entry| entry.0)
        .ok_or("Notification badge renderer is unavailable")?;
    let target_app = app.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = (|| {
            if require_owner(&webview, &target_app)? != url {
                return Err("Notification badge renderer changed before dispatch".into());
            }
            target_app
                .state::<NotificationBadge>()
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .set(webview.label(), generation, count)?;
            publish(&target_app);
            Ok(())
        })();
        let _ = sender.send(result);
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
}

#[cfg(any(windows, test))]
fn badge_rgba(count: u64) -> Vec<u8> {
    let mut pixels = vec![0; 32 * 32 * 4];
    for y in 0..32 {
        for x in 0..32 {
            let distance = ((x as f64 - 15.5).powi(2) + (y as f64 - 15.5).powi(2)).sqrt();
            let alpha = ((16.0 - distance).clamp(0.0, 1.0) * 255.0).round() as u8;
            pixels[(y * 32 + x) * 4..(y * 32 + x) * 4 + 4].copy_from_slice(&[220, 48, 48, alpha]);
        }
    }
    let font: [u16; 11] = [
        0b111101101101111,
        0b010110010010111,
        0b111001111100111,
        0b111001111001111,
        0b101101111001001,
        0b111100111001111,
        0b111100111101111,
        0b111001001001001,
        0b111101111101111,
        0b111101111001111,
        0b000010111010000,
    ];
    let text = if count > 99 {
        "99+".into()
    } else {
        count.to_string()
    };
    let scale = if text.len() > 2 { 2 } else { 3 };
    let left = (32 - (text.len() * 4 - 1) * scale) / 2;
    let top = (32 - 5 * scale) / 2;
    for (i, byte) in text.bytes().enumerate() {
        let glyph = font[if byte == b'+' {
            10
        } else {
            (byte - b'0') as usize
        }];
        for y in 0..5 {
            for x in 0..3 {
                if glyph & (1 << (14 - y * 3 - x)) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let offset =
                            ((top + y * scale + dy) * 32 + left + i * 4 * scale + x * scale + dx)
                                * 4;
                        pixels[offset..offset + 4].fill(255);
                    }
                }
            }
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_badge_aggregates_and_fences_reload_close_and_replacement() {
        let mut counts = Counts::default();
        counts.reset("one");
        counts.reset("two");
        let first = counts.windows["one"].0;
        let second = counts.windows["two"].0;
        counts.set("one", first, 50).unwrap();
        counts.set("two", second, 12).unwrap();
        assert_eq!(counts.total(), 62);
        assert!(counts.set("one", first, 51).is_err());
        counts.reset("one");
        assert_eq!(counts.total(), 12);
        assert!(counts.set("one", first, 8).is_err());
        counts.windows.remove("two");
        assert!(counts.set("two", second, 8).is_err());
        counts.reset("two");
        assert!(counts.set("two", second, 8).is_err());
        assert_eq!(counts.total(), 0);
    }

    #[test]
    fn notification_badge_rejects_preferences_guests_and_unregistered_windows() {
        let local = "local-11111111-1111-4111-8111-111111111111";
        assert!(is_main_owner(local, local, true, false));
        assert!(is_main_owner("remote-one", "remote-one", false, true));
        assert!(!is_main_owner(local, local, false, false));
        assert!(!is_main_owner("preferences", "preferences", true, true));
        assert!(!is_main_owner("remote-one", local, false, true));
        assert!(!is_main_owner("browser-one", "browser-one", true, true));
        for value in [
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("4"),
            serde_json::Value::Null,
        ] {
            assert!(serde_json::from_value::<u8>(value).is_err());
        }
    }

    #[test]
    fn notification_badge_image_is_host_generated_red_and_bounded() {
        for count in [1, 12, 50, 99, 100, 800] {
            let image = badge_rgba(count);
            assert_eq!(image.len(), 32 * 32 * 4);
            assert_eq!(image[3], 0);
            assert!(image.chunks_exact(4).any(|p| p == [220, 48, 48, 255]));
            assert!(image.chunks_exact(4).any(|p| p == [255, 255, 255, 255]));
        }
        assert_eq!(badge_rgba(100), badge_rgba(800));
    }

    #[test]
    fn notification_badge_acl_is_primary_only_and_remote_capability_stays_narrow() {
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main-window.json")).unwrap();
        let remote: serde_json::Value = serde_json::from_str(include_str!(
            "../capabilities/remote-window-notifications.json"
        ))
        .unwrap();
        let preferences: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/preferences-window.json")).unwrap();
        assert_eq!(main["webviews"], serde_json::json!(["local-*"]));
        assert_eq!(remote["webviews"], serde_json::json!(["remote-*"]));
        assert_eq!(remote["local"], false);
        for allowed in [&main, &remote] {
            assert!(allowed["permissions"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("allow-notification-badge-set")));
        }
        assert!(!preferences["permissions"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("allow-notification-badge-set")));
        assert_eq!(
            remote["permissions"],
            serde_json::json!([
                "notification:allow-is-permission-granted",
                "notification:allow-request-permission",
                "notification:allow-notify",
                "allow-notification-badge-set"
            ])
        );
    }
}
