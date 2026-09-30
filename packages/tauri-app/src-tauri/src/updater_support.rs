//! Installation policy, independent of network availability or renderer claims.
use tauri::utils::{config::BundleType, platform::bundle_type};

pub fn updater_supported(os: &str, bundle: Option<BundleType>, appimage: Option<&str>) -> bool {
    match (os, bundle) {
        ("windows", Some(BundleType::Nsis)) | ("macos", Some(BundleType::App)) => true,
        ("linux", Some(BundleType::AppImage)) => appimage.is_some_and(|path| !path.is_empty()),
        _ => false,
    }
}

pub fn current_platform_support() -> bool {
    updater_supported(
        std::env::consts::OS,
        bundle_type(),
        std::env::var("APPIMAGE").ok().as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_supported_installer_formats_can_update() {
        assert!(updater_supported("windows", Some(BundleType::Nsis), None));
        assert!(updater_supported("macos", Some(BundleType::App), None));
        assert!(updater_supported("linux", Some(BundleType::AppImage), Some("/home/test/app.AppImage")));
        for bundle in [None, Some(BundleType::Deb), Some(BundleType::Rpm)] {
            assert!(!updater_supported("linux", bundle, Some("/fake.AppImage")));
        }
        assert!(!updater_supported("linux", Some(BundleType::AppImage), None));
        assert!(!updater_supported("linux", Some(BundleType::AppImage), Some("")));
        assert!(!updater_supported("windows", None, None));
        assert!(!updater_supported("ios", Some(BundleType::App), None));
    }
}
