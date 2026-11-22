//! Native qualification entry points, enabled exclusively by `test-support`.
mod controls;
mod files_document;
mod files_reader;
mod files_state;
pub(crate) mod git_scene;
mod latency;
mod launcher;
mod live_controls;
mod native_store;
mod native_transport;
mod owned_startup;
mod pending_live;
mod pending_open;
mod real_history;
mod recovery;
mod session_transport;
pub mod transcript_scene;
mod window_restore;
mod workspaces;

fn fragment_path(message: &str, ordinal: usize) -> String {
    format!("/history/rows/{message}/fragment-{message}:{ordinal}/")
}

fn rendered_text(text: &str) -> String {
    // Markdown puts directional isolates around recognized inline code in a live tail.
    text.replace(['\u{2066}', '\u{2069}'], "")
}

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
        ("--probe-native-store", native_store::run),
        ("--probe-pending-open", pending_open::run),
        ("--probe-controls", controls::run),
        ("--probe-files-state", files_state::run),
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
