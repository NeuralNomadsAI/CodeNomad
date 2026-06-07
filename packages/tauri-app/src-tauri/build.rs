fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo");
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is set by Cargo");
    let manifest_path = std::path::Path::new(&manifest_dir);
    let bundled_resources = std::path::Path::new(&out_dir)
        .ancestors()
        .nth(3)
        .expect("OUT_DIR points inside target/<profile>/build/<pkg>/out")
        .join("resources");
    let resources_root = manifest_path.join("resources");
    let resources_node = resources_root.join("node");
    std::fs::create_dir_all(&resources_node).expect("create resources/node placeholder");

    // Tauri copies resources additively, so clear the old output first.
    if bundled_resources.exists() {
        std::fs::remove_dir_all(&bundled_resources).expect("clean bundled resources output");
    }

    println!("cargo:rerun-if-changed={}", manifest_path.join("tauri.conf.json").display());
    println!("cargo:rerun-if-changed={}", resources_root.join("node").display());
    println!("cargo:rerun-if-changed={}", resources_root.join("server").display());
    println!("cargo:rerun-if-changed={}", resources_root.join("ui-loading").display());

    tauri_build::build()
}
