use super::diagnostics::preview_error;
use std::sync::mpsc;
use std::time::Duration;

pub(super) fn request_close<R: tauri::Runtime>(view: &tauri::Webview<R>) -> Result<(), String> {
    use tauri::Manager;
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};
    let policy = view
        .app_handle()
        .try_state::<super::EmbeddedViews>()
        .ok_or("Missing browser registry")?
        .inner()
        .clone();
    let label = view.label().to_string();
    let token = policy.token(&label).ok_or("Expired browser view")?;
    view.with_webview(move |native| {
        if !policy.current(&label, token) {
            return;
        }
        // Page.close runs beforeunload and requests native window closure without
        // evaluating the site's replaceable window.close. Never wait on the UI thread.
        let result = (|| unsafe {
            let core = native.controller().CoreWebView2()?;
            let method = CoTaskMemPWSTR::from("Page.close");
            let params = CoTaskMemPWSTR::from("{}");
            let callback =
                CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|result, _| {
                    report_close_result("complete popup Page.close", result);
                    Ok(())
                }));
            core.CallDevToolsProtocolMethod(
                *method.as_ref().as_pcwstr(),
                *params.as_ref().as_pcwstr(),
                &callback,
            )
        })();
        report_close_result("dispatch popup Page.close", result);
    })
    .map_err(|error| error.to_string())
}

fn report_close_result(step: &'static str, result: windows_core::Result<()>) {
    if let Err(error) = result {
        eprintln!("[browser-close] {}", preview_error(step, error));
    }
}

pub(super) fn install<R: tauri::Runtime>(webview: &tauri::Webview<R>) -> Result<(), String> {
    use tauri::Manager;
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler};
    crate::windows_browser_accelerators::bind(webview);
    let (sender, receiver) = mpsc::sync_channel(1);
    let view = webview.clone();
    let policy = webview
        .app_handle()
        .try_state::<super::EmbeddedViews>()
        .ok_or("Missing browser registry")?
        .inner()
        .clone();
    let token = policy
        .token(webview.label())
        .ok_or("Expired browser view")?;
    webview
        .with_webview(move |platform| {
            let result = (|| {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|error| preview_error("get WebView2 for protections", error))?;
                let fullscreen_view = view.clone();
                let fullscreen_policy = policy.clone();
                let permission =
                    PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            unsafe {
                                if !policy.current(view.label(), token)
                                    || policy.restricted_browser(view.label())
                                {
                                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                                    return Ok(());
                                }
                                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                                args.PermissionKind(&mut kind)?;
                                let state = permission_state(kind);
                                if state == COREWEBVIEW2_PERMISSION_STATE_DENY
                                    && !matches!(kind.0, 1..=4)
                                {
                                    super::browser::unknown_permission(
                                        &view,
                                        &format!("WebView2:{}", kind.0),
                                    );
                                }
                                args.SetState(state)?;
                            }
                        }
                        Ok(())
                    }));
                let mut event_token = 0;
                unsafe { core.add_PermissionRequested(&permission, &mut event_token) }
                    .map_err(|error| preview_error("install permission handler", error))?;
                unsafe {
                    core.Settings()
                        .map_err(|error| preview_error("get WebView2 settings", error))?
                        .SetIsStatusBarEnabled(true)
                        .map_err(|error| preview_error("enable status bar", error))?;
                }
                unsafe {
                    core.add_ContainsFullScreenElementChanged(
                        &webview2_com::ContainsFullScreenElementChangedEventHandler::create(
                            Box::new(move |sender, _| {
                                if !fullscreen_policy.current(fullscreen_view.label(), token) {
                                    return Ok(());
                                }
                                if let Some(core) = sender {
                                    use tauri::Manager;
                                    let mut active = Default::default();
                                    core.ContainsFullScreenElement(&mut active)?;
                                    if let Some(views) = fullscreen_view
                                        .app_handle()
                                        .try_state::<super::EmbeddedViews>()
                                    {
                                        if let Err(error) = views.set_fullscreen(
                                            fullscreen_view.app_handle(),
                                            fullscreen_view.label(),
                                            active.as_bool(),
                                        ) {
                                            eprintln!("[browser-fullscreen] {error}");
                                        }
                                    }
                                }
                                Ok(())
                            }),
                        ),
                        &mut 0,
                    )
                    .map_err(|error| preview_error("install fullscreen handler", error))?;
                }
                Ok::<(), String>(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| preview_error("dispatch WebView2 protections", error))?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|error| preview_error("wait for WebView2 protections", error))?
}

pub(super) fn privacy<R: tauri::Runtime>(
    view: &tauri::Webview<R>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings3, ICoreWebView2Settings4,
    };
    use windows_core::Interface;
    let (sender, receiver) = mpsc::sync_channel(1);
    view.with_webview(move |native| {
        let result = (|| unsafe {
            let settings = native.controller().CoreWebView2()?.Settings()?;
            settings.SetIsStatusBarEnabled(false)?;
            settings.SetAreDefaultContextMenusEnabled(false)?;
            settings.SetAreDefaultScriptDialogsEnabled(false)?;
            settings.SetIsBuiltInErrorPageEnabled(false)?;
            let autofill = settings.cast::<ICoreWebView2Settings4>()?;
            autofill.SetIsPasswordAutosaveEnabled(false)?;
            autofill.SetIsGeneralAutofillEnabled(false)?;
            settings
                .cast::<ICoreWebView2Settings3>()?
                .SetAreBrowserAcceleratorKeysEnabled(false)?;
            Ok::<(), webview2_com::Error>(())
        })();
        let _ = sender.send(result.map_err(|error| error.to_string()));
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out configuring preview privacy")?
}

fn permission_state(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_KIND,
) -> webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    // Current documented values: sensors through PersistentStorage (13).
    // https://learn.microsoft.com/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2permissionkind
    if matches!(kind.0, 5..=13) {
        COREWEBVIEW2_PERMISSION_STATE_DEFAULT
    } else {
        COREWEBVIEW2_PERMISSION_STATE_DENY
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;

    #[test]
    fn popup_close_failures_retain_both_steps_and_native_hresult() {
        for step in ["complete popup Page.close", "dispatch popup Page.close"] {
            let error =
                windows_core::Error::from_hresult(windows_core::HRESULT(0x80070057u32 as i32));
            let expected = format!("browser preview: {step}: {error}");
            report_close_result(step, Err(error));
            assert!(expected.contains("0x80070057"));
            assert!(super::super::diagnostics::logs()
                .iter()
                .any(|log| log["level"] == "error" && log["text"] == expected));
        }
        report_close_result("successful popup Page.close", Ok(()));
        assert!(!super::super::diagnostics::logs()
            .iter()
            .any(|log| log["text"]
                .as_str()
                .unwrap()
                .contains("successful popup Page.close")));
    }

    #[test]
    fn only_classified_non_forbidden_permissions_reach_browser_consent() {
        for kind in -1..=30 {
            assert_eq!(
                permission_state(COREWEBVIEW2_PERMISSION_KIND(kind)),
                if (5..=13).contains(&kind) {
                    COREWEBVIEW2_PERMISSION_STATE_DEFAULT
                } else {
                    COREWEBVIEW2_PERMISSION_STATE_DENY
                }
            );
        }
    }
}
