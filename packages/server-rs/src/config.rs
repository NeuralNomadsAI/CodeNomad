//! Production settings, all read from the environment here (bench switches live in `bench`).
use std::{env, ffi::OsString};

/// `CNRS_BUILD_VERSION=<release version> cargo build`, else the crate version:
/// published as `serverVersion` and by `--version`.
pub const VERSION: &str = match option_env!("CNRS_BUILD_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// The `service.json` that `opencode serve --service` writes under its own `XDG_STATE_HOME`.
pub fn opencode_service_file() -> Option<OsString> {
    env::var_os("CNRS_OPENCODE_SERVICE_FILE")
}

pub fn remote_control() -> String {
    env::var("CODENOMAD_REMOTE_CONTROL").unwrap_or_default()
}

/// Bundled plugins: `1` (the reference set) or a comma list; payload folder and profile root.
pub fn provision_plugins() -> Option<String> {
    env::var("CNRS_PROVISION_PLUGINS").ok()
}
pub fn native_parent() -> bool {
    env::var("CODENOMAD_NATIVE_PARENT").as_deref() == Ok("1")
}
pub fn plugin_assets() -> Option<OsString> {
    env::var_os("CNRS_PLUGIN_ASSETS")
}
pub fn plugin_profile_root() -> Option<OsString> {
    env::var_os("CNRS_PLUGIN_PROFILE_ROOT")
}
