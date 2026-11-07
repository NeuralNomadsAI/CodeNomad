pub(super) fn install<R: tauri::Runtime>(_: &tauri::Webview<R>) -> Result<(), String> {
    // The builder installs per-instance native permission denial at construction.
    // Qualify WebKit's other permission defaults before enabling the renderer path.
    Ok(())
}
