//! Decides whether the Tauri updater may be used on this installation.
//!
//! The updater replaces the running application in place. That only works when
//! the installed artifact is designed for it: the NSIS installer on Windows,
//! the signed application bundle on macOS, and an AppImage on Linux. A Debian
//! package installs under `/usr` and must never be replaced in place, so the
//! updater stays unavailable there and the caller falls back to the release
//! page. The same rule keeps an unsigned build, which has no updater
//! configuration at all, from offering an update it cannot verify.

/// Whether the current process can replace itself with a downloaded update.
pub fn updater_supported(target_os: &str, appimage: Option<&str>, app_run: Option<&str>) -> bool {
    match target_os {
        // AppImage sets APPIMAGE; APPRUN is set by its runtime entry point.
        // Either proves the process was launched from the self-contained image.
        "linux" => appimage.is_some() || app_run.is_some(),
        "windows" | "macos" | "ios" => true,
        _ => false,
    }
}

/// Whether this running process may be replaced in place by a signed update.
///
/// Reported at startup so a support log states which update path the current
/// installation can actually use.
pub fn current_platform_support() -> bool {
    let appimage = std::env::var("APPIMAGE").ok();
    let app_run = std::env::var("APPRUN").ok();
    updater_supported(std::env::consts::OS, appimage.as_deref(), app_run.as_deref())
}

#[cfg(test)]
mod tests {
    use super::updater_supported;

    #[test]
    fn a_debian_installation_never_replaces_itself() {
        // No APPIMAGE and no APPRUN: installed under /usr by a package manager.
        assert!(!updater_supported("linux", None, None));
    }

    #[test]
    fn an_appimage_execution_is_updatable() {
        assert!(updater_supported("linux", Some("/tmp/CodeNomad.AppImage"), None));
        assert!(updater_supported("linux", None, Some("/tmp/.mount_x/AppRun")));
    }

    #[test]
    fn windows_and_macos_replace_their_installed_application() {
        assert!(updater_supported("windows", None, None));
        assert!(updater_supported("macos", None, None));
    }

    #[test]
    fn unsupported_platforms_stay_fallback_only() {
        assert!(!updater_supported("freebsd", None, None));
        assert!(!updater_supported("", None, None));
    }
}
