fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH");
    if arch.as_deref() == Ok("wasm32") {
        println!("cargo::rustc-link-arg=-zstack-size=2097152");
    }
    // The executable's icon (Explorer, the Start menu shortcut, Apps & features, and each window
    // through `rune::set_app_icon_resource(1)`) and its version, which Tauri's bundle used to embed.
    #[cfg(windows)]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo::rerun-if-env-changed=CODENOMAD_RUNE_VERSION");
        let icon = "../tauri-app/src-tauri/icon.ico";
        println!("cargo::rerun-if-changed={icon}");
        let version = std::env::var("CODENOMAD_RUNE_VERSION")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into());
        let mut resources = winresource::WindowsResource::new();
        resources
            .set_icon(icon)
            .set("FileDescription", "CodeNomad")
            .set("ProductName", "CodeNomad")
            .set("CompanyName", "neuralnomads")
            .set("FileVersion", &version)
            .set("ProductVersion", &version);
        resources.compile().expect("Windows resources");
    }
}
