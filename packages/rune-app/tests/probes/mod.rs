//! Native qualification entry points, enabled exclusively by `test-support`.
mod composer_attachments;
mod controls;
mod e2e_journey;
mod files_document;
mod files_reader;
mod files_state;
mod git_panel;
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
mod slash;
#[cfg(all(test, target_os = "windows"))]
mod titlebar_locale;
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
    let probes = [
        ("--probe-latency", latency::run as fn()),
        ("--probe-owned-startup", owned_startup::run as fn()),
        ("--probe-real-controls", live_controls::run),
        ("--probe-real-pending", pending_live::run),
        ("--probe-native-store", native_store::run),
        ("--probe-pending-open", pending_open::run),
        ("--probe-controls", controls::run),
        ("--probe-e2e-journey", e2e_journey::run),
        ("--probe-files-state", files_state::run),
        ("--probe-git-panel", git_panel::run),
        ("--probe-launcher", launcher::run),
        ("--probe-workspace-claims", workspaces::run),
        ("--probe-window-restore", window_restore::run),
        ("--probe-real-history", real_history::run),
        ("--probe-fresh", session_transport::fresh),
        ("--probe-recovery", recovery::run),
        ("--probe-suspend", recovery::suspend),
        ("--probe-contract", session_transport::contract),
        ("--probe-slash", slash::run),
        ("--probe-attachments", composer_attachments::run),
    ];
    let mut requested = std::env::args().filter(|arg| arg.starts_with("--probe-"));
    let probe = requested.next();
    let run = probe
        .as_deref()
        .and_then(|name| probes.iter().find(|(flag, _)| *flag == name));
    if requested.next().is_some() || (probe.is_some() && run.is_none()) {
        eprintln!("Expected one known qualification probe");
        std::process::exit(2);
    }
    if crate::platform::has_flag("--test-support-info") {
        let mut info = serde_json::json!({"testSupport":true,"nativeProbes":true});
        if let Some(name) = probe {
            info["probe"] = name.into();
        }
        println!("{info}");
        return true;
    }
    if let Some((_, run)) = run {
        run();
        return true;
    }
    false
}
