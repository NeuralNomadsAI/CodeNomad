//! Isolated F6 diagnostic: cargo run --example f6_windows -- [--handled] [--decorated].
//! Static HTML, fresh profile, no backend or OpenCode. Input is sent externally.
#[cfg(not(windows))]
fn main() {}
#[cfg(windows)]
#[path = "../src/windows_browser_accelerators.rs"]
mod windows_browser_accelerators;

#[cfg(windows)]
fn main() {
    use std::io::{Read, Write};
    use std::sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    };
    use std::{thread, time::Duration};
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    use webview2_com::{
        AcceleratorKeyPressedEventHandler, CoTaskMemPWSTR, Microsoft::Web::WebView2::Win32::*,
        ProcessFailedEventHandler, WebMessageReceivedEventHandler,
    };
    use windows_core::Interface;

    let handled = std::env::args().any(|arg| arg == "--handled");
    let decorated = std::env::args().any(|arg| arg == "--decorated");
    let profile = tempfile::Builder::new()
        .prefix("issue875-f6-")
        .tempdir_in(std::env::temp_dir().join("opencode"))
        .unwrap()
        .keep();
    let keys = Arc::new(AtomicU32::new(0));
    let failures = Arc::new(AtomicU32::new(0));
    let heartbeats = Arc::new(AtomicU32::new(0));
    let dom_keys = Arc::new(AtomicU32::new(0));
    let protected = Arc::new(AtomicU32::new(0));
    let untouched = Arc::new(AtomicU32::new(0));
    let dom_other = Arc::new(AtomicU32::new(0));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    thread::spawn(move || {
        let html = "<!doctype html><title>F6 fixture</title><body style='background:white;color:black'><h1>Isolated F6 test</h1><input autofocus value='keyboard remains here'><button>Button</button><p id='heartbeat'>0</p><script>addEventListener('keydown',e=>{if(['F6','F8'].includes(e.key))window.chrome.webview.postMessage(e.key)});setInterval(()=>{document.querySelector('#heartbeat').textContent=Date.now();window.chrome.webview.postMessage('heartbeat')},100)</script></body>";
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let _ = stream.read(&mut [0; 4096]);
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", html.len(), html);
        }
    });
    println!(
        "PROFILE={} HANDLED={handled} DECORATED={decorated}",
        profile.display()
    );
    tauri::Builder::default().setup(move |app| {
        let window = WebviewWindowBuilder::new(app, "f6-fixture", WebviewUrl::External(url.parse().unwrap()))
            .title("Isolated F6 fixture — no CodeNomad session")
            .additional_browser_args("--remote-debugging-address=127.0.0.1 --remote-debugging-port=0")
            .data_directory(profile)
            .decorations(decorated).inner_size(700.0, 500.0).build()?;
        if handled { windows_browser_accelerators::bind(window.as_ref()); }
        let key_count = keys.clone();
        let failed_count = failures.clone();
        let heartbeat_count = heartbeats.clone();
        let dom_count = dom_keys.clone();
        let protected_count = protected.clone();
        let untouched_count = untouched.clone();
        let other_dom_count = dom_other.clone();
        window.with_webview(move |platform| unsafe {
            let controller = platform.controller();
            let mut version = Default::default();
            platform.environment().BrowserVersionString(&mut version).unwrap();
            println!("RUNTIME={}", CoTaskMemPWSTR::from(version));
            let core = controller.CoreWebView2().unwrap();
            let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut key = 0;
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                args.VirtualKey(&mut key)?;
                args.KeyEventKind(&mut kind)?;
                if key == 0x75 && (kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) {
                    key_count.fetch_add(1, Ordering::SeqCst);
                    let args2 = args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>()?;
                    let mut enabled = Default::default();
                    args2.IsBrowserAcceleratorKeyEnabled(&mut enabled)?;
                    if !enabled.as_bool() { protected_count.fetch_add(1, Ordering::SeqCst); }
                }
                if key == 0x77 && kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN {
                    let args2 = args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>()?;
                    let mut enabled = Default::default();
                    args2.IsBrowserAcceleratorKeyEnabled(&mut enabled)?;
                    if enabled.as_bool() { untouched_count.fetch_add(1, Ordering::SeqCst); }
                }
                Ok(())
            }));
            let mut token = 0;
            if handled {
                controller.add_AcceleratorKeyPressed(&handler, &mut token).unwrap();
            }
            let failure = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                args.ProcessFailedKind(&mut kind)?;
                failed_count.store(kind.0 as u32 + 1, Ordering::SeqCst);
                Ok(())
            }));
            core.add_ProcessFailed(&failure, &mut token).unwrap();
            let heartbeat = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut text = Default::default();
                args.TryGetWebMessageAsString(&mut text)?;
                match CoTaskMemPWSTR::from(text).to_string().as_str() {
                    "heartbeat" => { heartbeat_count.fetch_add(1, Ordering::SeqCst); },
                    "F6" => { dom_count.fetch_add(1, Ordering::SeqCst); },
                    "F8" => { other_dom_count.fetch_add(1, Ordering::SeqCst); },
                    _ => (),
                }
                Ok(())
            }));
            core.add_WebMessageReceived(&heartbeat, &mut token).unwrap();
            controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC).unwrap();
        })?;
        window.show()?;
        window.set_focus()?;
        println!("READY PID={} HWND={}", std::process::id(), window.hwnd()?.0 as usize);
        let handle = app.handle().clone();
        thread::spawn(move || {
            for _ in 0..12 {
                thread::sleep(Duration::from_secs(1));
                println!("STATE f6={} protected={} dom_f6={} other_enabled={} dom_other={} process_failed={} heartbeats={}", keys.load(Ordering::SeqCst), protected.load(Ordering::SeqCst), dom_keys.load(Ordering::SeqCst), untouched.load(Ordering::SeqCst), dom_other.load(Ordering::SeqCst), failures.load(Ordering::SeqCst), heartbeats.load(Ordering::SeqCst));
            }
            let passed = !handled || (protected.load(Ordering::SeqCst) >= 3 && dom_keys.load(Ordering::SeqCst) >= 3 && untouched.load(Ordering::SeqCst) > 0 && dom_other.load(Ordering::SeqCst) > 0 && failures.load(Ordering::SeqCst) == 0);
            println!("RESULT passed={passed}");
            handle.exit(if passed { 0 } else { 1 });
        });
        Ok(())
    }).run(tauri::generate_context!()).unwrap();
}
