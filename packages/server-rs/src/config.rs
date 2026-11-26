//! Production settings, all read from the environment here (bench switches live in `bench`).
use std::{env, ffi::OsString};

/// `CNRS_BUILD_VERSION=<release version> cargo build`, else the crate version:
/// published as `serverVersion` and by `--version`.
pub const VERSION: &str = match option_env!("CNRS_BUILD_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// An install environment naming a daemon record instead of the daemon's profile: refused, since
/// discovery through the CLI without that profile would reach the account's own daemon.
pub fn service_record_named() -> bool {
    env::var_os("CNRS_OPENCODE_SERVICE_FILE").is_some()
}

pub fn remote_control() -> String {
    env::var("CODENOMAD_REMOTE_CONTROL").unwrap_or_default()
}

/// Optional self-hosted OpenTunnel API URL; defaults to the hosted relay when unset.
pub fn remote_control_api() -> Option<String> {
    env::var("CODENOMAD_REMOTE_CONTROL_API").ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

/// Launched as `serve`: bundled plugins follow the reference (always its set, payloads beside the
/// binary, any discovery root), never the positional launch's `CNRS_*` switches.
static SERVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn set_serve() {
    SERVE.store(true, std::sync::atomic::Ordering::Relaxed);
}
pub fn serve() -> bool {
    SERVE.load(std::sync::atomic::Ordering::Relaxed)
}

/// Bundled plugins: `1` (the reference set) or a comma list; payload folder and profile root.
pub fn provision_plugins() -> Option<String> {
    if serve() { Some("1".into()) } else { env::var("CNRS_PROVISION_PLUGINS").ok() }
}
pub fn native_parent() -> bool {
    env::var("CODENOMAD_NATIVE_PARENT").as_deref() == Ok("1")
}
/// `CODENOMAD_NATIVE_BROWSER_AUTOMATION=0`: the host has no browser automation.
pub fn native_browser_automation_unavailable() -> bool {
    env::var("CODENOMAD_NATIVE_BROWSER_AUTOMATION").as_deref() == Ok("0")
}
/// `automationBridgeDirectory`: `%LOCALAPPDATA%` on Windows, else `$XDG_RUNTIME_DIR/codenomad`,
/// else `~/.config/codenomad`, each with `automation-bridges`.
pub fn automation_bridges() -> Option<std::path::PathBuf> {
    let var = |name: &str| env::var_os(name).filter(|v| !v.is_empty()).map(std::path::PathBuf::from);
    let base = match var("LOCALAPPDATA").filter(|_| cfg!(windows)) {
        Some(local) => local.join("CodeNomad"),
        None => match var("XDG_RUNTIME_DIR") {
            Some(runtime) => runtime.join("codenomad"),
            None => var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?.join(".config").join("codenomad"),
        },
    };
    Some(base.join("automation-bridges"))
}
pub fn plugin_assets() -> Option<OsString> {
    env::var_os("CNRS_PLUGIN_ASSETS").filter(|_| !serve())
}
pub fn plugin_profile_root() -> Option<OsString> {
    env::var_os("CNRS_PLUGIN_PROFILE_ROOT").filter(|_| !serve())
}
