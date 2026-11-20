//! Production settings, all read from the environment here (bench switches live in `bench`).
use std::{env, ffi::OsString};

/// `CNRS_BUILD_VERSION=<release version> cargo build`, else the crate version:
/// published as `serverVersion` and by `--version`.
pub const VERSION: &str = match option_env!("CNRS_BUILD_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// `codenomad-rs --version` prints the build version and exits.
pub fn print_version() -> bool {
    let asked = env::args().nth(1).as_deref() == Some("--version") && env::args().len() == 2;
    if asked {
        println!("{VERSION}");
    }
    asked
}

pub fn server_password() -> Result<String, env::VarError> {
    env::var("CNRS_SERVER_PASSWORD")
}
/// An install environment naming a daemon record instead of the daemon's profile: refused, since
/// discovery through the CLI without that profile would reach the account's own daemon.
pub fn service_record_named() -> bool {
    env::var_os("CNRS_OPENCODE_SERVICE_FILE").is_some()
}

/// HTTPS listener: interface, public name, extra certificate names and supplied PEM files.
pub fn https_bind() -> Option<String> {
    env::var("CNRS_HTTPS_BIND").ok()
}
pub fn https_name() -> Result<String, env::VarError> {
    env::var("CNRS_HTTPS_NAME")
}
pub fn tls_sans() -> String {
    env::var("CNRS_TLS_SANS").unwrap_or_default()
}
pub fn tls_files() -> [Option<OsString>; 3] {
    ["CNRS_TLS_KEY", "CNRS_TLS_CERT", "CNRS_TLS_CA"].map(env::var_os)
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
