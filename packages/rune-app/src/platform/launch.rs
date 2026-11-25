//! Windows single-instance launch coordination for `focusExistingWindowOnSecondLaunch`.
//!
//! Reuses Rune's profile-scoped `single_instance` / `on_reopen` handoff so a second launch
//! either brings the existing window forward (when confirmed `focusExistingWindowOnSecondLaunch`
//! is enabled on a local desktop window) or opens a new window (`--new-window`), matching Tauri.
#[cfg(any(target_os = "windows", test))]
use crate::State;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "windows")]
static CLAIMED: AtomicBool = AtomicBool::new(false);

#[cfg(any(target_os = "windows", test))]
const APP_ID_BASE: &str = "ai.neuralnomads.codenomad.rune";

#[cfg(any(target_os = "windows", test))]
fn fnv1a_64(parts: &[&str]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for part in parts {
        for &byte in part.as_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(any(target_os = "windows", test))]
fn normalized_path_token(raw: &str) -> String {
    let trimmed = raw.trim();
    let canonical = std::fs::canonicalize(trimmed).ok();
    let text = canonical
        .as_deref()
        .and_then(|p| p.to_str())
        .unwrap_or(trimmed);
    text.replace('\\', "/").to_ascii_lowercase()
}

/// Computes the profile-scoped single-instance identifier, or `None` when coordination must be skipped.
#[cfg(any(target_os = "windows", test))]
fn resolve_instance_id(
    args: &[String],
    headless: bool,
    disabled: bool,
    direct_scoped: bool,
    profile: Option<&str>,
    host_root: Option<&str>,
    state_dir: Option<&str>,
) -> Option<String> {
    if headless || disabled || direct_scoped {
        return None;
    }
    if args.iter().any(|arg| {
        arg == "--new-window"
            || arg == "--test-support-info"
            || arg == "--scene"
            || arg.starts_with("--scene=")
            || arg.starts_with("--probe-")
            || arg.starts_with("--gallery-")
    }) {
        return None;
    }
    let normalized_profile = match profile.map(str::trim).filter(|p| !p.is_empty()) {
        Some(raw) => {
            let valid = crate::host::profile_name(raw).ok()?;
            (!matches!(valid.as_str(), "default" | "stable")).then_some(valid)
        }
        None => None,
    };
    let mut id = match normalized_profile {
        Some(profile) => format!("{APP_ID_BASE}.scope.{profile}"),
        None => APP_ID_BASE.to_string(),
    };
    let root_token = host_root
        .filter(|v| !v.trim().is_empty())
        .map(normalized_path_token);
    let state_token = state_dir
        .filter(|v| !v.trim().is_empty())
        .map(normalized_path_token);
    if root_token.is_some() || state_token.is_some() {
        let digest = fnv1a_64(&[
            root_token.as_deref().unwrap_or(""),
            state_token.as_deref().unwrap_or(""),
        ]);
        id.push_str(&format!(".{digest:016x}"));
    }
    Some(id)
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn should_focus_existing(s: &State) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        crate::platform::wake_lock::is_local_window(s)
            && crate::settings::focus_existing_window_on_second_launch(s)
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = s;
        false
    }
}

/// Claims the profile-scoped single-instance pipe before opening the window.
/// Returns `false` when an already running instance took ownership of this launch.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn enter() -> bool {
    #[cfg(target_os = "windows")]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let direct_scoped = ["RUNE_BACKEND", "RUNE_WORKSPACE", "RUNE_SESSION"]
            .iter()
            .all(|key| super::setting(key).is_some());
        let disabled = super::setting("RUNE_DISABLE_SINGLE_INSTANCE").as_deref() == Some("1");
        let profile = super::setting("CODENOMAD_PROFILE");
        let host_root = super::setting("RUNE_HOST_ROOT");
        let state_dir = super::setting("RUNE_STATE_DIR");
        let Some(id) = resolve_instance_id(
            &args,
            rune_theme_codenomad::shell::is_headless(),
            disabled,
            direct_scoped,
            profile.as_deref(),
            host_root.as_deref(),
            state_dir.as_deref(),
        ) else {
            return true;
        };
        if rune_theme_codenomad::shell::claim_single_instance(&id) {
            CLAIMED.store(true, Ordering::Release);
            true
        } else {
            false
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn release() {
    #[cfg(target_os = "windows")]
    if CLAIMED.swap(false, Ordering::AcqRel) {
        rune_theme_codenomad::shell::release_single_instance();
    }
}

#[cfg(any(target_os = "windows", test))]
fn decide_reopen(s: &State, spawn_new_window: impl FnOnce() -> bool) -> bool {
    if should_focus_existing(s) {
        // Returning false runs Rune's default reopen: restore if minimized and bring forward.
        return false;
    }
    // Open a new independent window; if spawning fails, fall back to focusing this window.
    spawn_new_window()
}

#[cfg(target_os = "windows")]
fn spawn_new_window() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    std::process::Command::new(exe)
        .arg("--new-window")
        .spawn()
        .is_ok()
}

#[cfg(target_os = "windows")]
pub(crate) fn handle_reopen(s: &mut State, _has_visible_windows: bool, _tx: &mut rune::Tx) -> bool {
    decide_reopen(s, spawn_new_window)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    #[test]
    fn scope_id_normalizes_default_profiles_and_isolates_roots() {
        let base = resolve_instance_id(&[], false, false, false, None, None, None).unwrap();
        assert_eq!(base, APP_ID_BASE);
        assert_eq!(
            resolve_instance_id(&[], false, false, false, Some("default"), None, None).as_deref(),
            Some(APP_ID_BASE)
        );
        assert_eq!(
            resolve_instance_id(&[], false, false, false, Some("STABLE"), None, None).as_deref(),
            Some(APP_ID_BASE)
        );
        let named =
            resolve_instance_id(&[], false, false, false, Some("Work"), None, None).unwrap();
        assert_eq!(named, format!("{APP_ID_BASE}.scope.work"));

        let root_a = resolve_instance_id(
            &[],
            false,
            false,
            false,
            Some("trial-alpha"),
            Some(r"D:\tmp\root-a"),
            None,
        )
        .unwrap();
        let root_b = resolve_instance_id(
            &[],
            false,
            false,
            false,
            Some("trial-alpha"),
            Some(r"D:\tmp\root-b"),
            None,
        )
        .unwrap();
        assert_ne!(root_a, root_b);
        assert!(root_a.starts_with(&format!("{APP_ID_BASE}.scope.trial-alpha.")));
    }

    #[test]
    fn coordination_bypasses_new_window_probes_headless_and_invalid_profiles() {
        assert!(
            resolve_instance_id(
                &["--new-window".into()],
                false,
                false,
                false,
                None,
                None,
                None
            )
            .is_none()
        );
        assert!(
            resolve_instance_id(
                &["--probe-window".into()],
                false,
                false,
                false,
                None,
                None,
                None
            )
            .is_none()
        );
        assert!(
            resolve_instance_id(
                &["--gallery-shell".into()],
                false,
                false,
                false,
                None,
                None,
                None
            )
            .is_none()
        );
        assert!(
            resolve_instance_id(
                &["--scene=synthetic".into()],
                false,
                false,
                false,
                None,
                None,
                None
            )
            .is_none()
        );
        assert!(resolve_instance_id(&[], true, false, false, None, None, None).is_none());
        assert!(resolve_instance_id(&[], false, true, false, None, None, None).is_none());
        assert!(resolve_instance_id(&[], false, false, true, None, None, None).is_none());
        assert!(
            resolve_instance_id(&[], false, false, false, Some("../bad"), None, None).is_none()
        );
    }

    #[test]
    fn reopen_focuses_existing_only_when_confirmed_on_local_window() {
        let mut s = crate::init();
        let spawned = Cell::new(0usize);

        // Default (unset / false) spawns a new window and skips focusing the existing one.
        assert!(decide_reopen(&s, || {
            spawned.set(spawned.get() + 1);
            true
        }));
        assert_eq!(spawned.get(), 1);

        // Confirmed true on a local loopback backend focuses the existing window without spawning.
        crate::settings::fixture_config(
            &mut s,
            "http://127.0.0.1:9898/",
            json!({"focusExistingWindowOnSecondLaunch": true}),
        );
        assert!(!decide_reopen(&s, || {
            spawned.set(spawned.get() + 1);
            true
        }));
        assert_eq!(spawned.get(), 1);

        // Remote backend config must not hijack local launch behavior.
        crate::settings::fixture_config(
            &mut s,
            "https://remote.example.com:9898/",
            json!({"focusExistingWindowOnSecondLaunch": true}),
        );
        assert!(decide_reopen(&s, || {
            spawned.set(spawned.get() + 1);
            true
        }));
        assert_eq!(spawned.get(), 2);

        // Failed new-window spawn falls back to focusing the existing window.
        assert!(!decide_reopen(&s, || false));
    }
}
