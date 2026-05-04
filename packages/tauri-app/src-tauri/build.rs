fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo");
    let resources_node = std::path::Path::new(&manifest_dir).join("resources/node");
    std::fs::create_dir_all(resources_node).expect("create resources/node placeholder");
    tauri_build::build()
}
