fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        let expected = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("vendor/tauri-2.12.1/mobile/ios-api")
            .canonicalize()
            .expect("source-owned Tauri iOS package");
        let actual = std::path::PathBuf::from(
            std::env::var_os("DEP_TAURI_IOS_LIBRARY_PATH")
                .expect("Tauri iOS library metadata missing"),
        )
        .canonicalize()
        .expect("resolved Tauri iOS package");
        assert_eq!(actual, expected, "unpatched Tauri iOS dependency selected");
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["connect_server"])),
    )
    .expect("mobile application manifest");
}
