//! Exercises the real Tauri runtime's safe Send + Clone handle across workers.
//! No CodeNomad profile, backend, shared daemon, web page or visible window.
#[cfg(not(windows))]
fn main() {
    eprintln!("This regression requires Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    use std::{
        hint::black_box,
        sync::{Arc, Barrier},
        thread,
        time::Duration,
    };
    use tauri_runtime::Runtime;
    use tauri_runtime_wry::Wry;
    use windows_sys::Win32::System::Diagnostics::Debug::{SetErrorMode, SEM_NOGPFAULTERRORBOX};

    // A negative control must exit without opening a Windows error dialog.
    unsafe {
        SetErrorMode(SEM_NOGPFAULTERRORBOX);
    }
    thread::spawn(|| {
        thread::sleep(Duration::from_secs(30));
        eprintln!("FAIL: runtime handle regression watchdog");
        std::process::exit(2);
    });
    let runtime = Wry::<()>::new(Default::default()).expect("create isolated Wry runtime");
    let gate = Arc::new(Barrier::new(9));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let handle = runtime.handle();
            let gate = gate.clone();
            thread::spawn(move || {
                gate.wait();
                for _ in 0..100_000 {
                    // IPC performs this same safe runtime-handle clone/drop traffic.
                    drop(black_box(handle.clone()));
                }
            })
        })
        .collect();
    println!("START: concurrent Tauri runtime handle cloning");
    gate.wait();
    for worker in workers {
        worker.join().expect("runtime worker failed");
    }
    drop(runtime);
    println!("PASS: 800000 runtime handle clones and clean teardown");
}
