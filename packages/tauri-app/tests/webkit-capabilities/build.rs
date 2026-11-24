#[path = "../../src-tauri/build_webkit.rs"]
mod build_webkit;
fn main() {
    build_webkit::build(std::path::Path::new("../../src-tauri/src/embedded_view"));
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("../../src-tauri/examples/window_constraints_windows.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
