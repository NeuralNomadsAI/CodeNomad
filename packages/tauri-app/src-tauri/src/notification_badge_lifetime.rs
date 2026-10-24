//! Native renderer lifetime signals, installed once on owned primary webviews.
//! Native subscriptions capture only a weak host, never their COM/GObject or a
//! strong AppHandle, so there is no runtime/handler ownership cycle.
use std::sync::Weak;
use tauri::{AppHandle, Webview};

#[cfg(windows)]
fn clears_badge(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
) -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    matches!(
        kind,
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
    )
}

pub(crate) fn bind(webview: &Webview, host: Weak<AppHandle>, binding: u64) {
    #[cfg(any(windows, target_os = "linux"))]
    {
        let label = webview.label().to_string();
        if let Err(error) = webview.with_webview(move |platform| {
            #[cfg(windows)]
            {
                use webview2_com::{ProcessFailedEventHandler, Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND};
                let result = (|| -> webview2_com::Result<()> {
                    let core = unsafe { platform.controller().CoreWebView2()? };
                    let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                        unsafe { args.ProcessFailedKind(&mut kind)? };
                        if clears_badge(kind) {
                            if let Some(app) = host.upgrade() {
                                crate::notification_badge::renderer_terminated(&app, &label, binding);
                            }
                        }
                        Ok(())
                    }));
                    let mut token = 0;
                    unsafe { core.add_ProcessFailed(&handler, &mut token)? };
                    Ok(())
                })();
                if let Err(error) = result {
                    eprintln!("[notification-badge] failed to register renderer termination handler: {error}");
                }
            }
            #[cfg(target_os = "linux")]
            {
                use webkit2gtk::WebViewExt;
                platform.inner().connect_web_process_terminated(move |_view, _reason| {
                    // All WebKit reasons terminate this view's web process:
                    // crash, memory limit, or explicit native termination.
                    if let Some(app) = host.upgrade() {
                        crate::notification_badge::renderer_terminated(&app, &label, binding);
                    }
                });
            }
        }) {
            eprintln!("[notification-badge] failed to access renderer termination hook: {error}");
        }
    }
    // Tauri 2.10.3 does not forward Wry's Darwin builder-only termination hook.
    // Do not replace WKWebView's runtime-owned navigation delegate or poll it.
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = (webview, host, binding);
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;

    #[test]
    fn renderer_termination_policy_ignores_frames_hangs_and_auxiliary_processes() {
        assert!(clears_badge(
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
        ));
        assert!(clears_badge(
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
        ));
        for kind in [
            COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
            COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND(-1),
        ] {
            assert!(!clears_badge(kind));
        }
    }
}
