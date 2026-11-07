//! UI-thread native reads. Ownership/document fences belong to BrowserController.
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::{mpsc, Arc};
use std::time::Instant;

type Guard = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
type Completion = unsafe extern "C" fn(*mut c_void, *const u8, usize, *const c_char);
extern "C" {
    fn cn_checkpoint(view: *mut c_void, done: Completion, context: *mut c_void);
    fn cn_capture(view: *mut c_void, done: Completion, context: *mut c_void);
    fn cn_install_page_read(view: *mut c_void) -> i32;
    fn cn_page_read(view: *mut c_void, request: *const c_char, timeout_ms: u32, done: Completion, context: *mut c_void);
}

#[derive(Clone)]
pub(crate) enum Read {
    Checkpoint,
    Capture,
    Page(String),
}

struct Pending {
    sender: mpsc::SyncSender<Result<Vec<u8>, String>>,
    guard: Guard,
    limit: usize,
}

unsafe extern "C" fn completed(
    context: *mut c_void,
    bytes: *const u8,
    length: usize,
    error: *const c_char,
) {
    // Native adapters invoke exactly once and lend their buffers until return.
    let pending = unsafe { Box::from_raw(context.cast::<Pending>()) };
    let result = (|| {
        (pending.guard)()?;
        if !error.is_null() {
            return Err(unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned());
        }
        if length > pending.limit || (length != 0 && bytes.is_null()) {
            return Err("Native browser result exceeds its byte budget".into());
        }
        Ok(if length == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec()
        })
    })();
    let _ = pending.sender.send(result);
}

pub(crate) fn read(
    webview: &tauri::Webview,
    operation: Read,
    deadline: Instant,
    guard: impl Fn() -> Result<(), String> + Send + Sync + 'static,
) -> Result<Vec<u8>, String> {
    let guard: Guard = Arc::new(guard);
    guard()?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let queued_guard = guard.clone();
    webview
        .with_webview(move |native| {
            if Instant::now() >= deadline {
                let _ = sender.send(Err("Native request expired before execution".into()));
                return;
            }
            if let Err(error) = queued_guard() {
                let _ = sender.send(Err(error));
                return;
            }
            #[cfg(target_os = "linux")]
            let view = {
                use gtk::glib::object::ObjectType;
                native.inner().as_ptr().cast::<c_void>()
            };
            #[cfg(target_os = "macos")]
            let view = native.inner();
            let context = Box::into_raw(Box::new(Pending {
                sender,
                guard: queued_guard,
                limit: match &operation {
                    Read::Checkpoint => 1024 * 1024,
                    Read::Capture => 16 * 1024 * 1024,
                    Read::Page(_) => 4 * 1024 * 1024,
                },
            }))
            .cast::<c_void>();
            unsafe {
                match operation {
                    Read::Checkpoint => cn_checkpoint(view, completed, context),
                    Read::Capture => cn_capture(view, completed, context),
                    Read::Page(request) => {
                        let request = CString::new(request).expect("serialized JSON request");
                        cn_page_read(view,request.as_ptr(),deadline.saturating_duration_since(Instant::now()).as_millis().clamp(1,u32::MAX as u128) as u32,completed,context);
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;
    let result = receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| "Timed out reading the native browser".to_string())??;
    guard()?;
    Ok(result)
}

pub(crate) fn install_read(webview: &tauri::Webview) -> Result<(), String> {
    let (sender,receiver)=mpsc::sync_channel(1);
    webview.with_webview(move |native| {
        #[cfg(target_os="linux")]
        let view = { use gtk::glib::object::ObjectType; native.inner().as_ptr().cast::<c_void>() };
        #[cfg(target_os="macos")]
        let view=native.inner();
        let installed=unsafe {cn_install_page_read(view)};
        let _=sender.send(installed != 0);
    }).map_err(|error|error.to_string())?;
    if receiver.recv_timeout(std::time::Duration::from_secs(5)).map_err(|_|"Timed out installing native read hooks".to_string())? { Ok(()) } else {Err("Native read hooks are unavailable".into())}
}
