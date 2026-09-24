#[cfg(not(windows))]
fn main() {
    eprintln!("This fixture requires Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    windows_fixture::run();
}

#[cfg(windows)]
mod windows_fixture {
    use std::{
        sync::{
            atomic::{AtomicBool, AtomicU32, Ordering},
            Mutex,
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };
    use tao::{event_loop::EventLoop, platform::windows::WindowExtWindows, window::WindowBuilder};
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::*,
        },
    };

    static ARMED: AtomicBool = AtomicBool::new(false);
    static INSIDE_OUTER: AtomicBool = AtomicBool::new(false);
    static REENTRIES: AtomicU32 = AtomicU32::new(0);
    static SENDER: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

    unsafe extern "system" fn intercept(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if INSIDE_OUTER.load(Ordering::SeqCst) && msg == WM_SETFOCUS {
            REENTRIES.fetch_add(1, Ordering::SeqCst);
        }
        if ARMED.swap(false, Ordering::SeqCst) {
            INSIDE_OUTER.store(true, Ordering::SeqCst);
            let address = hwnd as usize;
            *SENDER.lock().unwrap() = Some(thread::spawn(move || {
                let mut result = 0;
                // A cross-thread sent message is dispatched by PeekMessageW,
                // even when its posted-message filter only selects key events.
                let sent = SendMessageTimeoutW(
                    address as HWND,
                    WM_SETFOCUS,
                    0,
                    0,
                    SMTO_BLOCK | SMTO_ABORTIFHUNG,
                    4000,
                    &mut result,
                );
                assert_ne!(sent, 0, "nested focus message did not complete");
            }));
            let deadline = Instant::now() + Duration::from_secs(3);
            while GetQueueStatus(QS_SENDMESSAGE) >> 16 & QS_SENDMESSAGE == 0 {
                if Instant::now() >= deadline {
                    eprintln!("failed to queue the nested sent message");
                    std::process::exit(3);
                }
                thread::sleep(Duration::from_millis(1));
            }
            println!("nested focus queued before Tao input processing");
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            INSIDE_OUTER.store(false, Ordering::SeqCst);
            result
        } else {
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
    }

    pub fn run() {
        // A watchdog makes the known-broken baseline deterministic and bounded.
        thread::spawn(|| {
            thread::sleep(Duration::from_secs(8));
            eprintln!("input callback watchdog: UI thread did not return");
            std::process::exit(2);
        });
        let event_loop = EventLoop::new();
        let window = WindowBuilder::new()
            .with_title("CodeNomad isolated input regression")
            .with_visible(false)
            .build(&event_loop)
            .unwrap();
        let hwnd = window.hwnd() as HWND;
        let case = std::env::args().nth(1).unwrap_or_else(|| "keydown".into());
        let (msg, key, data) = match case.as_str() {
            "keydown" => (WM_KEYDOWN, 0x41, 0x001e0001),
            "keyup" => (WM_KEYUP, 0x41, 0xc01e0001u32 as isize),
            "char" => (WM_CHAR, 0x61, 0x001e0001),
            "syschar" => (WM_SYSCHAR, 0x61, 0x201e0001),
            "ime" => (WM_CHAR, 0x3042, 0x00000001),
            _ => panic!("unknown case"),
        };
        unsafe {
            assert_ne!(SetWindowSubclass(hwnd, Some(intercept), 0x434e, 0), 0);
            if case == "char" || case == "syschar" {
                // Seed the real key -> text state: the keydown sees a queued
                // character, which we remove before delivering it below.
                assert_ne!(PostMessageW(hwnd, msg, key, data), 0);
                SendMessageW(
                    hwnd,
                    if case == "char" {
                        WM_KEYDOWN
                    } else {
                        WM_SYSKEYDOWN
                    },
                    0x41,
                    0x001e0001,
                );
                let mut queued = std::mem::zeroed();
                assert_ne!(PeekMessageW(&mut queued, hwnd, msg, msg, PM_REMOVE), 0);
            }
            if case == "ime" {
                SendMessageW(hwnd, WM_IME_STARTCOMPOSITION, 0, 0);
                SendMessageW(hwnd, WM_IME_ENDCOMPOSITION, 0, 0);
            }
            ARMED.store(true, Ordering::SeqCst);
            SendMessageW(hwnd, msg, key, data);
            SENDER
                .lock()
                .unwrap()
                .take()
                .expect("sender was not created")
                .join()
                .unwrap();
            assert!(
                REENTRIES.load(Ordering::SeqCst) > 0,
                "test must exercise reentrancy"
            );
            assert_ne!(RemoveWindowSubclass(hwnd, Some(intercept), 0x434e), 0);
        }
        println!("PASS: {case}; nested focus completed and outer input callback returned");
    }
}
