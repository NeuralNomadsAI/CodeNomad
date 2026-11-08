use std::{
    ffi::{c_char, c_void, CString},
    sync::mpsc,
    time::Duration,
};
extern "C" {
    fn cn_preview_scale(view: *mut c_void, device: *mut f64) -> f64;
    fn cn_preview_profile(view: *mut c_void, ua: *const c_char, zoom: f64, density: f64) -> i32;
}
pub(crate) fn scale<R: tauri::Runtime>(view: &tauri::Webview<R>) -> Result<(f64, f64), String> {
    native(view, |ptr| {
        let mut device = 1.0;
        let scale = unsafe { cn_preview_scale(ptr, &mut device) };
        if !scale.is_finite() || scale <= 0.0 || !device.is_finite() || device <= 0.0 {
            return Err("Native preview scale is unavailable".into());
        }
        Ok((scale, device))
    })
}
pub(crate) fn profile<R: tauri::Runtime>(
    view: &tauri::Webview<R>,
    ua: &str,
    zoom: f64,
    density: f64,
) -> Result<bool, String> {
    let ua = CString::new(ua).map_err(|_| "Invalid preview identity")?;
    native(view, move |ptr| {
        Ok(unsafe { cn_preview_profile(ptr, ua.as_ptr(), zoom, density) } != 0)
    })
}
fn native<R: tauri::Runtime, T: Send + 'static>(
    view: &tauri::Webview<R>,
    run: impl FnOnce(*mut c_void) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    view.with_webview(move |native| {
        #[cfg(target_os = "macos")]
        let ptr = native.inner();
        #[cfg(target_os = "linux")]
        let ptr = {
            use gtk::glib::object::ObjectType;
            native.inner().as_ptr().cast::<c_void>()
        };
        let _ = sender.send(run(ptr));
    })
    .map_err(|e| e.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Native preview profile timed out".to_string())?
}
