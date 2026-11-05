pub(super) fn install(_: &tauri::Webview) -> Result<(), String> {
    // The vendored Wry delegate installs per-instance media denial at construction.
    // Qualify WebKit's other permission defaults before enabling the renderer path.
    Ok(())
}
