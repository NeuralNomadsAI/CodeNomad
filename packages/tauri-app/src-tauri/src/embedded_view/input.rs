//! UI-thread native reads. Ownership/document fences belong to BrowserController.
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::{mpsc, Arc};
use std::time::Instant;
#[path = "input_native.rs"]
mod native;
pub(crate) use native::Held;

type Guard = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
type Completion = unsafe extern "C" fn(*mut c_void, *const u8, usize, *const c_char);
extern "C" {
    fn cn_checkpoint(view: *mut c_void, done: Completion, context: *mut c_void);
    fn cn_capture(view: *mut c_void, done: Completion, context: *mut c_void);
    fn cn_install_page_read(view: *mut c_void) -> i32;
    fn cn_page_read(
        view: *mut c_void,
        request: *const c_char,
        timeout_ms: u32,
        done: Completion,
        context: *mut c_void,
    );
}

pub(crate) enum DocumentDispatch {
    Capture,
    Navigate(Box<dyn FnOnce(*mut c_void) -> Result<Vec<u8>, String> + Send>),
}

pub(crate) const STALE_DOCUMENT: &str = "Browser target is stale; probe again";

pub(crate) enum Read {
    Checkpoint,
    Capture,
    Page(String),
    Guarded {
        document: Option<String>,
        dispatch: DocumentDispatch,
    },
    Input {
        document: String,
        operation: serde_json::Value,
        held: Held,
    },
}

enum AfterRead {
    Input(serde_json::Value, Held),
    Dispatch(DocumentDispatch),
}

enum Program {
    Checkpoint,
    Capture,
    Page(String),
}

struct Pending {
    sender: mpsc::SyncSender<Result<Vec<u8>, String>>,
    guard: Guard,
    limit: usize,
    deadline: Instant,
    after_read: Option<(*mut c_void, String, AfterRead)>,
}

unsafe extern "C" fn completed(
    context: *mut c_void,
    bytes: *const u8,
    length: usize,
    error: *const c_char,
) {
    // Native adapters invoke exactly once and lend their buffers until return.
    let mut pending = unsafe { Box::from_raw(context.cast::<Pending>()) };
    let mut capture = None;
    let result = (|| {
        if Instant::now() >= pending.deadline {
            return Err("Native request expired before execution".into());
        }
        (pending.guard)()?;
        if !error.is_null() {
            return Err(unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned());
        }
        if length > pending.limit || (length != 0 && bytes.is_null()) {
            return Err("Native browser result exceeds its byte budget".into());
        }
        let bytes = if length == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec()
        };
        if let Some((view, document, action)) = pending.after_read.take() {
            let response: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            match action {
                AfterRead::Input(operation, held) => {
                    if response["document"].as_str() != Some(document.as_str()) {
                        return Err("Browser page document changed before input".into());
                    }
                    if operation["op"] == "wheel" && response["result"]["node"].as_u64().is_none() {
                        return Err("Native wheel point is unavailable".into());
                    }
                    unsafe { native::dispatch(view, &operation, &held) }?;
                    (pending.guard)()?;
                    return serde_json::to_vec(&serde_json::json!({"document":document,"result":{}}))
                        .map_err(|error| error.to_string());
                }
                AfterRead::Dispatch(dispatch) => {
                    if response["document"].as_str() != Some(document.as_str()) {
                        return Err(STALE_DOCUMENT.into());
                    }
                    match dispatch {
                        DocumentDispatch::Capture => capture = Some(view),
                        DocumentDispatch::Navigate(navigate) => return navigate(view),
                    }
                    return Ok(Vec::new());
                }
            }
        }
        Ok(bytes)
    })();
    if let Some(view) = capture {
        pending.limit = 16 * 1024 * 1024;
        unsafe { cn_capture(view, completed, Box::into_raw(pending).cast()) };
    } else {
        let _ = pending.sender.send(result);
    }
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
            let (program, limit, after_read) = match operation {
                Read::Guarded { document: Some(document), dispatch } => (
                    Program::Page(r#"{"op":"checkpoint"}"#.into()),
                    1024,
                    Some((view, document, AfterRead::Dispatch(dispatch))),
                ),
                Read::Guarded { document: None, dispatch: DocumentDispatch::Navigate(navigate) } => {
                    let _ = sender.send(navigate(view));
                    return;
                }
                Read::Guarded { document: None, dispatch: DocumentDispatch::Capture } => {
                    let _ = sender.send(Err("A current browser target is required".into()));
                    return;
                }
                Read::Page(request) => (Program::Page(request), 4 * 1024 * 1024, None),
                Read::Input { document, operation, held } => {
                    let preflight = if operation["op"] == "wheel" {
                        serde_json::json!({"op":"hit-test","x":operation["event"]["x"].as_f64().unwrap_or(0.0).floor(),"y":operation["event"]["y"].as_f64().unwrap_or(0.0).floor()})
                    } else {
                        serde_json::json!({"op":"checkpoint"})
                    };
                    (Program::Page(preflight.to_string()), 4 * 1024 * 1024, Some((view, document, AfterRead::Input(operation, held))))
                }
                Read::Checkpoint => (Program::Checkpoint, 1024 * 1024, None),
                Read::Capture => (Program::Capture, 16 * 1024 * 1024, None),
            };
            let context = Box::into_raw(Box::new(Pending {
                sender,
                guard: queued_guard,
                limit,
                deadline,
                after_read,
            }))
            .cast::<c_void>();
            unsafe {
                match program {
                    Program::Checkpoint => cn_checkpoint(view, completed, context),
                    Program::Capture => cn_capture(view, completed, context),
                    Program::Page(request) => {
                        let request = CString::new(request).expect("serialized JSON request");
                        cn_page_read(
                            view,
                            request.as_ptr(),
                            deadline
                                .saturating_duration_since(Instant::now())
                                .as_millis()
                                .clamp(1, u32::MAX as u128) as u32,
                            completed,
                            context,
                        );
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
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |native| {
            #[cfg(target_os = "linux")]
            let view = {
                use gtk::glib::object::ObjectType;
                native.inner().as_ptr().cast::<c_void>()
            };
            #[cfg(target_os = "macos")]
            let view = native.inner();
            let installed = unsafe { cn_install_page_read(view) };
            let _ = sender.send(installed != 0);
        })
        .map_err(|error| error.to_string())?;
    if receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "Timed out installing native read hooks".to_string())?
    {
        Ok(())
    } else {
        Err("Native read hooks are unavailable".into())
    }
}
