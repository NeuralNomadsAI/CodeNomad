//! Windows profile-scoped second-launch coordination for `focusExistingWindowOnSecondLaunch`.
//!
//! New launches (without `--new-window`) ask the current owner for their scope whether to focus
//! its window (`FOCUS <pid>`) or open independently (`OPEN`). Every live desktop window in the
//! scope—including `--new-window` windows—runs a zero-CPU takeover coordinator after `on_ready`
//! so a surviving window takes over focus ownership if the primary window closes.
use crate::State;
#[cfg(target_os = "windows")]
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
pub(crate) struct Host {
    #[cfg(target_os = "windows")]
    focus_existing: Arc<AtomicBool>,
    #[cfg(target_os = "windows")]
    coordinator: Option<codenomad_host_process::LaunchCoordinator>,
}

#[cfg(any(target_os = "windows", test))]
fn fnv1a_128(fields: &[(&str, &str)]) -> u128 {
    let mut hash = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d_u128;
    const PRIME: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013b;
    let feed = |h: &mut u128, bytes: &[u8]| {
        for &byte in bytes {
            *h ^= u128::from(byte);
            *h = h.wrapping_mul(PRIME);
        }
    };
    for (tag, value) in fields {
        feed(&mut hash, tag.as_bytes());
        feed(&mut hash, b"=");
        feed(&mut hash, &(value.len() as u64).to_le_bytes());
        feed(&mut hash, b":");
        feed(&mut hash, value.as_bytes());
        feed(&mut hash, &[0]);
    }
    hash
}

/// Pure lexical Windows-style path normalization (never depends on filesystem existence).
#[cfg(any(target_os = "windows", test))]
fn normalize_lexical_path(raw: &str) -> String {
    let trimmed = raw.trim().replace('\\', "/");
    let (unc, body) = if trimmed
        .as_bytes()
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"//?/unc/"))
    {
        (true, trimmed[8..].trim_start_matches('/'))
    } else if let Some(stripped) = trimmed.strip_prefix("//?/") {
        (false, stripped)
    } else if trimmed.starts_with("//") {
        (true, trimmed.trim_start_matches('/'))
    } else {
        (false, trimmed.as_str())
    };
    let mut parts: Vec<&str> = Vec::new();
    let rooted = !unc && body.starts_with('/');
    for segment in body.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                let keep_prefix =
                    parts.len() == 1 && parts[0].len() == 2 && parts[0].as_bytes()[1] == b':';
                if !parts.is_empty() && !keep_prefix {
                    parts.pop();
                }
            }
            other => parts.push(other),
        }
    }
    let mut out = String::new();
    if unc {
        out.push_str("//");
    } else if rooted {
        out.push('/');
    }
    out.push_str(&parts.join("/"));
    if out.len() == 2 && out.as_bytes()[1] == b':' {
        out.push('/');
    }
    out.to_ascii_lowercase()
}

#[cfg(any(target_os = "windows", test))]
fn normalize_backend_token(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if let Some((scheme, rest)) = trimmed.split_once("://") {
        let (authority, tail) = rest
            .find(['/', '?', '#'])
            .map_or((rest, ""), |idx| (&rest[..idx], &rest[idx..]));
        format!(
            "{}://{}{}",
            scheme.to_ascii_lowercase(),
            authority.to_ascii_lowercase(),
            tail
        )
    } else {
        trimmed.to_ascii_lowercase()
    }
}

#[cfg(any(target_os = "windows", test))]
fn is_qualification_arg(arg: &str) -> bool {
    arg == "--test-support-info"
        || arg == "--scene"
        || arg.starts_with("--scene=")
        || arg.starts_with("--probe-")
        || arg.starts_with("--gallery-")
}

#[cfg(any(target_os = "windows", test))]
fn is_drive_relative(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && !matches!(bytes.get(2), Some(b'/' | b'\\'))
}

#[cfg(any(target_os = "windows", test))]
fn is_absolute_lexical(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\');
    let unc = raw.starts_with("\\\\") || raw.starts_with("//");
    let posix = !cfg!(windows) && raw.starts_with('/');
    drive || unc || posix
}

/// Normalizes `CLI_CONFIG` using the same directory/`config.json` -> `config.yaml` and default-path
/// collapse rules as `host::config::resolve_desktop_config_path`, returning `None` when a relative
/// or tilde path cannot be anchored lexically.
#[cfg(any(target_os = "windows", test))]
fn normalize_cli_config(raw: &str, cwd: Option<&str>, home: Option<&str>) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() {
        return Some(String::new());
    }
    let home = home
        .map(str::trim)
        .filter(|h| !h.is_empty() && is_absolute_lexical(h));
    let expanded = if value == "~" {
        home?.to_owned()
    } else if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        format!("{}/{rest}", home?)
    } else if is_drive_relative(value) {
        return None;
    } else if is_absolute_lexical(value) {
        value.to_owned()
    } else {
        let dir = cwd
            .map(str::trim)
            .filter(|c| !c.is_empty() && is_absolute_lexical(c))?;
        format!("{dir}/{value}")
    };
    let mut normalized = normalize_lexical_path(&expanded);
    let leaf = normalized.rsplit('/').next().unwrap_or("");
    let ext = leaf
        .rsplit_once('.')
        .filter(|(stem, _)| !stem.is_empty())
        .map(|(_, ext)| ext);
    if ext.is_some_and(|e| e.eq_ignore_ascii_case("json")) {
        let prefix_len = normalized.len() - leaf.len();
        normalized = format!("{}config.yaml", &normalized[..prefix_len]);
    } else if !ext.is_some_and(|e| e.eq_ignore_ascii_case("yaml") || e.eq_ignore_ascii_case("yml"))
    {
        if !normalized.ends_with('/') {
            normalized.push('/');
        }
        normalized.push_str("config.yaml");
    }
    if let Some(h) = home {
        let default = normalize_lexical_path(&format!("{h}/.config/codenomad/config.yaml"));
        if normalized == default {
            return Some(String::new());
        }
    }
    Some(normalized)
}

#[cfg(any(target_os = "windows", test))]
#[derive(Default)]
struct ScopeInputs<'a> {
    args: &'a [String],
    allow_new_window: bool,
    headless: bool,
    disabled: bool,
    direct_scoped: bool,
    profile: Option<&'a str>,
    update_channel: Option<&'a str>,
    cli_config: Option<&'a str>,
    home: Option<&'a str>,
    cwd: Option<&'a str>,
    host_root: Option<&'a str>,
    state_dir: Option<&'a str>,
    backend: Option<&'a str>,
}

/// Resolves the collision-free scope identifier for launch coordination.
/// `allow_new_window` is `false` for pre-launch handoff (`--new-window` bypasses focusing an
/// existing window) and `true` for window ownership so surviving `--new-window` windows take over.
#[cfg(any(target_os = "windows", test))]
fn resolve_scope_id(input: ScopeInputs<'_>) -> Option<String> {
    if input.headless || input.disabled || input.direct_scoped {
        return None;
    }
    if input
        .args
        .iter()
        .any(|arg| is_qualification_arg(arg) || (!input.allow_new_window && arg == "--new-window"))
    {
        return None;
    }
    let root_key = input
        .host_root
        .filter(|v| !v.trim().is_empty())
        .map(normalize_lexical_path)
        .unwrap_or_default();
    let raw_profile = input
        .profile
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .or_else(|| {
            if root_key.is_empty() {
                input
                    .update_channel
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
            } else {
                None
            }
        });
    let profile_key = match raw_profile {
        Some(raw) => {
            let valid = crate::host::profile_name(raw).ok()?;
            if matches!(valid.as_str(), "default" | "stable") {
                String::from("default")
            } else {
                valid
            }
        }
        None => String::from("default"),
    };
    let config_key = if root_key.is_empty() {
        match input.cli_config {
            Some(raw) => normalize_cli_config(raw, input.cwd, input.home)?,
            None => String::new(),
        }
    } else {
        String::new()
    };
    let state_key = input
        .state_dir
        .filter(|v| !v.trim().is_empty())
        .map(normalize_lexical_path)
        .unwrap_or_default();
    let backend_key = input
        .backend
        .filter(|v| !v.trim().is_empty())
        .map(normalize_backend_token)
        .unwrap_or_default();
    let digest = fnv1a_128(&[
        ("profile", &profile_key),
        ("config", &config_key),
        ("root", &root_key),
        ("state", &state_key),
        ("backend", &backend_key),
    ]);
    Some(format!("s{digest:032x}"))
}

#[cfg(target_os = "windows")]
fn current_scope_id(allow_new_window: bool) -> Option<String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let direct_scoped = ["RUNE_BACKEND", "RUNE_WORKSPACE", "RUNE_SESSION"]
        .iter()
        .all(|key| super::setting(key).is_some());
    let disabled = super::setting("RUNE_DISABLE_SINGLE_INSTANCE").as_deref() == Some("1");
    let profile = super::setting("CODENOMAD_PROFILE");
    let update_channel = super::setting("CODENOMAD_UPDATE_CHANNEL");
    let cli_config = super::setting("CLI_CONFIG");
    let host_root = super::setting("RUNE_HOST_ROOT");
    let state_dir = super::setting("RUNE_STATE_DIR");
    let backend = super::setting("RUNE_BACKEND");
    let home = super::setting("USERPROFILE")
        .or_else(|| {
            let drive = super::setting("HOMEDRIVE")?;
            let path = super::setting("HOMEPATH")?;
            Some(format!("{drive}{path}"))
        })
        .or_else(|| super::setting("HOME"));
    let cwd = std::env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    resolve_scope_id(ScopeInputs {
        args: &args,
        allow_new_window,
        headless: rune_theme_codenomad::shell::is_headless(),
        disabled,
        direct_scoped,
        profile: profile.as_deref(),
        update_channel: update_channel.as_deref(),
        cli_config: cli_config.as_deref(),
        home: home.as_deref(),
        cwd: cwd.as_deref(),
        host_root: host_root.as_deref(),
        state_dir: state_dir.as_deref(),
        backend: backend.as_deref(),
    })
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn should_focus_existing(s: &State) -> bool {
    crate::platform::wake_lock::is_local_window(s)
        && crate::settings::focus_existing_window_on_second_launch(s)
}

/// Checks whether a running instance for this scope wants to take focus for this launch.
/// Returns `false` when an existing window accepted focus and this process should exit.
pub(crate) fn enter() -> bool {
    #[cfg(target_os = "windows")]
    {
        if cfg!(any(test, feature = "test-support")) {
            return true;
        }
        let Some(scope_id) = current_scope_id(false) else {
            return true;
        };
        !codenomad_host_process::LaunchCoordinator::try_focus_existing(&scope_id)
    }
    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}

/// Registers this live window as an owner/takeover candidate once its native window is ready.
#[cfg(target_os = "windows")]
pub(crate) fn attach(s: &mut State, window: rune::WindowHandle) {
    if cfg!(any(test, feature = "test-support")) {
        return;
    }
    let Some(scope_id) = current_scope_id(true) else {
        return;
    };
    s.launch
        .focus_existing
        .store(should_focus_existing(s), Ordering::Release);
    s.launch.coordinator = codenomad_host_process::LaunchCoordinator::start(
        &scope_id,
        Arc::clone(&s.launch.focus_existing),
        move || {
            window.open();
            window.focus();
        },
    );
}

pub(crate) fn sync(s: &mut State) {
    #[cfg(target_os = "windows")]
    {
        let focus = should_focus_existing(s);
        s.launch.focus_existing.store(focus, Ordering::Release);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &s.launch;
    }
}

pub(crate) fn release(s: &mut State) {
    #[cfg(target_os = "windows")]
    {
        s.launch.focus_existing.store(false, Ordering::Release);
        s.launch.coordinator = None;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &s.launch;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scope_id_normalizes_paths_lexically_and_prevents_field_collisions() {
        let base = resolve_scope_id(ScopeInputs::default()).unwrap();
        assert_eq!(
            resolve_scope_id(ScopeInputs {
                profile: Some("default"),
                ..Default::default()
            })
            .as_deref(),
            Some(base.as_str())
        );
        assert_eq!(
            resolve_scope_id(ScopeInputs {
                profile: Some("STABLE"),
                ..Default::default()
            })
            .as_deref(),
            Some(base.as_str())
        );

        // Non-existent path spellings and extended \\?\ prefixes resolve identically.
        let root_a = resolve_scope_id(ScopeInputs {
            profile: Some("trial-alpha"),
            host_root: Some(r"D:\Tmp\NonExistent\Root\"),
            ..Default::default()
        })
        .unwrap();
        let root_a_extended = resolve_scope_id(ScopeInputs {
            profile: Some("trial-alpha"),
            host_root: Some(r"\\?\d:/tmp/sub/../nonexistent/root"),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(root_a, root_a_extended);

        // Extended UNC prefix \\?\UNC\server\share matches \\server\share.
        let unc_plain = resolve_scope_id(ScopeInputs {
            host_root: Some(r"\\Server\Share\Profile"),
            ..Default::default()
        })
        .unwrap();
        let unc_extended = resolve_scope_id(ScopeInputs {
            host_root: Some(r"\\?\UNC\server\share\sub\..\profile\"),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(unc_plain, unc_extended);

        // Non-ASCII paths whose byte 8 falls inside a multi-byte UTF-8 character never panic.
        let accented = resolve_scope_id(ScopeInputs {
            state_dir: Some(r"D:\Tempé\state"),
            ..Default::default()
        })
        .unwrap();
        let cjk = resolve_scope_id(ScopeInputs {
            state_dir: Some(r"C:\日本語\root"),
            ..Default::default()
        })
        .unwrap();
        assert_ne!(accented, cjk);

        // Distinct roots and distinct RUNE_BACKEND targets produce distinct scopes.
        let root_b = resolve_scope_id(ScopeInputs {
            profile: Some("trial-alpha"),
            host_root: Some(r"D:\Tmp\NonExistent\Other"),
            ..Default::default()
        })
        .unwrap();
        assert_ne!(root_a, root_b);

        let backend_a = resolve_scope_id(ScopeInputs {
            backend: Some("http://127.0.0.1:3001/"),
            ..Default::default()
        })
        .unwrap();
        let backend_b = resolve_scope_id(ScopeInputs {
            backend: Some("http://127.0.0.1:3002"),
            ..Default::default()
        })
        .unwrap();
        assert_ne!(backend_a, backend_b);
        assert_ne!(backend_a, base);

        // A crafted profile name mimicking a digest suffix never collides with a rooted profile.
        let crafted = format!("trial-alpha.{}", &root_a[1..17]);
        let forged = resolve_scope_id(ScopeInputs {
            profile: Some(&crafted),
            ..Default::default()
        })
        .unwrap();
        assert_ne!(forged, root_a);
    }

    #[test]
    fn new_window_skips_handoff_but_retains_owner_scope_for_takeover() {
        let args = vec!["--new-window".into()];
        assert!(
            resolve_scope_id(ScopeInputs {
                args: &args,
                ..Default::default()
            })
            .is_none(),
            "--new-window must bypass pre-launch focus handoff"
        );
        assert!(
            resolve_scope_id(ScopeInputs {
                args: &args,
                allow_new_window: true,
                ..Default::default()
            })
            .is_some(),
            "--new-window must still register as a takeover owner"
        );
    }

    #[test]
    fn coordination_bypasses_probes_headless_disabled_and_invalid_profiles() {
        for flag in [
            "--probe-window",
            "--gallery-shell",
            "--scene=synthetic",
            "--test-support-info",
        ] {
            let args = vec![flag.into()];
            assert!(
                resolve_scope_id(ScopeInputs {
                    args: &args,
                    allow_new_window: true,
                    ..Default::default()
                })
                .is_none()
            );
        }
        assert!(
            resolve_scope_id(ScopeInputs {
                allow_new_window: true,
                headless: true,
                ..Default::default()
            })
            .is_none()
        );
        assert!(
            resolve_scope_id(ScopeInputs {
                allow_new_window: true,
                disabled: true,
                ..Default::default()
            })
            .is_none()
        );
        assert!(
            resolve_scope_id(ScopeInputs {
                allow_new_window: true,
                direct_scoped: true,
                ..Default::default()
            })
            .is_none()
        );
        assert!(
            resolve_scope_id(ScopeInputs {
                allow_new_window: true,
                profile: Some("../bad"),
                ..Default::default()
            })
            .is_none()
        );
    }

    #[test]
    fn focus_existing_requires_confirmed_true_on_local_window() {
        let mut s = crate::init();
        assert!(!should_focus_existing(&s));

        crate::settings::fixture_config(
            &mut s,
            "http://127.0.0.1:9898/",
            json!({"focusExistingWindowOnSecondLaunch": true}),
        );
        assert!(should_focus_existing(&s));

        crate::settings::fixture_config(
            &mut s,
            "https://remote.example.com:9898/",
            json!({"focusExistingWindowOnSecondLaunch": true}),
        );
        assert!(!should_focus_existing(&s));

        crate::settings::fixture_config(
            &mut s,
            "http://127.0.0.1:9898/",
            json!({"focusExistingWindowOnSecondLaunch": false}),
        );
        assert!(!should_focus_existing(&s));
    }

    #[test]
    fn scope_id_aligns_with_update_channel_and_cli_config() {
        let home = Some(r"C:\Users\Alice");
        let base = resolve_scope_id(ScopeInputs {
            home,
            ..Default::default()
        })
        .unwrap();

        // CODENOMAD_UPDATE_CHANNEL acts as desktop profile fallback and matches CODENOMAD_PROFILE.
        let dev_profile = resolve_scope_id(ScopeInputs {
            profile: Some("dev"),
            home,
            ..Default::default()
        })
        .unwrap();
        let dev_channel = resolve_scope_id(ScopeInputs {
            update_channel: Some("DEV"),
            home,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(dev_profile, dev_channel);
        assert_ne!(dev_channel, base);
        assert_eq!(
            resolve_scope_id(ScopeInputs {
                update_channel: Some("stable"),
                home,
                ..Default::default()
            })
            .as_deref(),
            Some(base.as_str())
        );
        assert_eq!(
            resolve_scope_id(ScopeInputs {
                profile: Some("   "),
                update_channel: Some("dev"),
                home,
                ..Default::default()
            })
            .as_deref(),
            Some(dev_profile.as_str())
        );
        let beta_override = resolve_scope_id(ScopeInputs {
            profile: Some("beta"),
            update_channel: Some("dev"),
            home,
            ..Default::default()
        })
        .unwrap();
        assert_ne!(beta_override, dev_profile);
        assert!(
            resolve_scope_id(ScopeInputs {
                update_channel: Some("../bad"),
                home,
                ..Default::default()
            })
            .is_none()
        );

        // Explicit CLI_CONFIG pointing at the default config collapses to the default scope.
        for default_spelling in [
            "~/.config/codenomad",
            r"~\.config\codenomad\config.yaml",
            r"C:\Users\Alice\.config\codenomad\config.json",
            r"\\?\c:/users/alice/.config/codenomad/sub/../config.yaml",
        ] {
            assert_eq!(
                resolve_scope_id(ScopeInputs {
                    cli_config: Some(default_spelling),
                    home,
                    ..Default::default()
                })
                .as_deref(),
                Some(base.as_str()),
                "{default_spelling}"
            );
        }

        // Distinct CLI_CONFIG directories isolate scopes while equivalent spellings share one scope.
        let work_dir = resolve_scope_id(ScopeInputs {
            cli_config: Some(r"D:\Work"),
            home,
            ..Default::default()
        })
        .unwrap();
        assert_ne!(work_dir, base);
        for equivalent in [
            r"D:\Work\",
            r"d:/work/config.yaml",
            r"D:\Work\config.json",
            r"\\?\D:\Work\nested\..\config.yaml",
        ] {
            assert_eq!(
                resolve_scope_id(ScopeInputs {
                    cli_config: Some(equivalent),
                    home,
                    ..Default::default()
                })
                .as_deref(),
                Some(work_dir.as_str()),
                "{equivalent}"
            );
        }
        assert_eq!(
            resolve_scope_id(ScopeInputs {
                cli_config: Some(r".\Work"),
                cwd: Some(r"D:\"),
                home,
                ..Default::default()
            })
            .as_deref(),
            Some(work_dir.as_str())
        );
        let custom_yml = resolve_scope_id(ScopeInputs {
            cli_config: Some(r"D:\Work\custom.yml"),
            home,
            ..Default::default()
        })
        .unwrap();
        assert_ne!(custom_yml, work_dir);

        // Unanchored relative/tilde or drive-relative CLI_CONFIG fails closed.
        for bad in ["relative/config.yaml", "~/custom", "C:work"] {
            assert!(
                resolve_scope_id(ScopeInputs {
                    cli_config: Some(bad),
                    ..Default::default()
                })
                .is_none(),
                "{bad}"
            );
        }

        // Isolated trial roots ignore desktop-only CODENOMAD_UPDATE_CHANNEL and CLI_CONFIG.
        let trial_plain = resolve_scope_id(ScopeInputs {
            profile: Some("trial-a"),
            host_root: Some(r"D:\Tmp\TrialA"),
            home,
            ..Default::default()
        })
        .unwrap();
        let trial_with_desktop_env = resolve_scope_id(ScopeInputs {
            profile: Some("trial-a"),
            update_channel: Some("../ignored"),
            cli_config: Some(r"D:\Other"),
            host_root: Some(r"D:\Tmp\TrialA"),
            home,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(trial_plain, trial_with_desktop_env);
    }
}
