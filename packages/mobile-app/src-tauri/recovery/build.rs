fn main() {
    // No frontend commands and no frontend permissions, local or remote.
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .ios_path("ios")
        .build();
}
