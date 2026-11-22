//! Native qualification entry points, enabled exclusively by `test-support`.
mod controls;
mod latency;
mod launcher;
mod live_controls;
mod native_transport;
mod owned_startup;
mod real_history;
mod recovery;
mod servo;
mod session_transport;

/// Dispatch qualification CLI without entering the native window event loop.
pub fn dispatch() -> bool {
    if crate::platform::has_flag("--test-support-info") {
        println!("{{\"testSupport\":true,\"nativeProbes\":true}}");
        return true;
    }
    for (flag, run) in [
        ("--probe-latency", latency::run as fn()),
        ("--probe-owned-startup", owned_startup::run as fn()),
        ("--probe-real-controls", live_controls::run),
        ("--probe-controls", controls::run),
        ("--probe-launcher", launcher::run),
        ("--probe-real-history", real_history::run),
        ("--probe-fresh", session_transport::fresh),
        ("--probe-recovery", recovery::run),
        ("--probe-contract", session_transport::contract),
        ("--probe-servo", servo::run),
    ] {
        if crate::platform::has_flag(flag) {
            run();
            return true;
        }
    }
    false
}
