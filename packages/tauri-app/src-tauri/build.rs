fn main() {
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo");
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

    println!(
        "cargo:rerun-if-changed={}",
        manifest_path.join("tauri.conf.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        resources_root.join("node").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        resources_root.join("server").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        resources_root.join("ui-loading").display()
    );

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "cli_get_status",
            "cli_restart",
            "wake_lock_start",
            "wake_lock_stop",
            "needs_local_certificate_install",
            "open_remote_window",
            "client_state_claim_access",
            "client_state_load",
            "client_state_save",
            "client_state_commit_partitions",
            "client_state_load_partition",
            "client_state_set_restore_enabled",
            "client_state_clear",
            "client_state_renderer_flushed",
            "client_state_navigation_flushed",
            "desktop_launch_ready",
            "desktop_launch_next_folder",
            "desktop_launch_acknowledge_folder",
            "install_stable_update",
            "open_workspace_target",
            "set_workspace_menu_enabled",
        ]),
    ))
    .expect("build Tauri application and command ACL")
}
