//! Native qualification entry points, enabled exclusively by `test-support`.
mod controls;
mod latency;
mod launcher;
mod live_controls;
mod native_transport;
mod owned_startup;
mod pending_live;
mod pending_open;
mod real_history;
mod recovery;
mod session_transport;
mod window_restore;
mod workspaces;

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
        ("--probe-real-pending", pending_live::run),
        ("--probe-pending-open", pending_open::run),
        ("--probe-controls", controls::run),
        ("--probe-launcher", launcher::run),
        ("--probe-workspace-claims", workspaces::run),
        ("--probe-window-restore", window_restore::run),
        ("--probe-real-history", real_history::run),
        ("--probe-fresh", session_transport::fresh),
        ("--probe-recovery", recovery::run),
        ("--probe-contract", session_transport::contract),
    ] {
        if crate::platform::has_flag(flag) {
            run();
            return true;
        }
    }
    false
}
