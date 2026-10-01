// Real AppKit/Tao regression, with no CodeNomad profile, backend or OpenCode.
#[cfg(target_os = "macos")]
fn main() {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };
    use tao::{
        dpi::LogicalSize,
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoop},
        window::WindowBuilder,
    };

    let progress = Arc::new((AtomicUsize::new(0), AtomicUsize::new(0)));
    let watchdog = progress.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        let phase = watchdog.0.load(Ordering::SeqCst);
        let captures = watchdog.1.load(Ordering::SeqCst);
        if phase == 1 && captures >= 100 {
            eprintln!("FAIL: getter event feedback watchdog: phase={phase} captures={captures}");
        } else {
            eprintln!("FAIL: unrelated native window timeout: phase={phase} captures={captures}");
        }
        std::process::exit(2);
    });
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("CodeNomad isolated macOS window regression")
        .with_decorations(false)
        .with_inner_size(LogicalSize::new(600.0, 500.0))
        .build(&event_loop)
        .unwrap();
    let mut phase = 0;
    let mut deadline = Instant::now() + Duration::from_secs(1);
    let mut query_during_events = false;
    let mut events = 0;
    let mut before_reads = 0;
    let mut normal_size = window.inner_size();
    let mut normal_position = window.outer_position().unwrap();
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::WaitUntil(deadline);
        match event {
            Event::WindowEvent {
                event: WindowEvent::Resized(_) | WindowEvent::Moved(_),
                ..
            } => {
                events += 1;
                if query_during_events {
                    progress.1.fetch_add(1, Ordering::SeqCst);
                    // Same feedback boundary as production geometry capture.
                    let _ = window.is_maximized();
                }
            }
            Event::MainEventsCleared if Instant::now() >= deadline => {
                match phase {
                    0 => {
                        println!("BEGIN: borderless getter feedback probe");
                        progress.0.store(1, Ordering::SeqCst);
                        normal_size = window.inner_size();
                        normal_position = window.outer_position().unwrap();
                        assert!(!window.is_maximized());
                        query_during_events = true;
                        before_reads = events;
                        for _ in 0..100 {
                            assert!(!window.is_maximized());
                        }
                    }
                    1 => {
                        progress.0.store(2, Ordering::SeqCst);
                        assert_eq!(events, before_reads, "normal reads generated geometry events");
                        assert_eq!(window.inner_size(), normal_size);
                        assert_eq!(window.outer_position().unwrap(), normal_position);
                        window.set_maximized(true);
                    }
                    2 => {
                        assert!(window.is_maximized(), "maximize must remain functional");
                        before_reads = events;
                        for _ in 0..100 {
                            assert!(window.is_maximized());
                        }
                    }
                    3 => {
                        assert_eq!(events, before_reads, "maximized reads generated geometry events");
                        window.set_maximized(false);
                    }
                    4 => {
                        assert!(!window.is_maximized());
                        assert_eq!(window.inner_size(), normal_size, "restore lost normal bounds");
                        assert_eq!(window.outer_position().unwrap(), normal_position);
                        window.set_resizable(false);
                    }
                    5 => {
                        before_reads = events;
                        for _ in 0..100 {
                            assert!(!window.is_maximized());
                        }
                    }
                    6 => {
                        assert_eq!(events, before_reads, "fixed-size reads generated geometry events");
                        window.set_resizable(true);
                        window.set_decorations(true);
                    }
                    7 => {
                        before_reads = events;
                        for _ in 0..100 {
                            assert!(!window.is_maximized());
                        }
                    }
                    8 => {
                        assert_eq!(events, before_reads, "decorated reads generated geometry events");
                        println!("PASS: read-only zoom checks, native event capture, maximize/restore and fixed-size/decorated windows");
                        *flow = ControlFlow::Exit;
                        return;
                    }
                    _ => unreachable!(),
                }
                phase += 1;
                deadline = Instant::now() + Duration::from_secs(1);
            }
            _ => {}
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Run this native regression on macOS with a graphical session.");
    std::process::exit(1);
}
