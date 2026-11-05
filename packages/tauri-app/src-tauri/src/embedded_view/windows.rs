use std::sync::mpsc;
use std::time::Duration;

pub(super) fn install(webview: &tauri::Webview) -> Result<(), String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY,
        PermissionRequestedEventHandler,
    };
    crate::windows_browser_accelerators::bind(webview);
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let result = (|| {
                let core = unsafe { platform.controller().CoreWebView2() }?;
                let permission = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)? };
                    }
                    Ok(())
                }));
                let mut token = 0;
                unsafe { core.add_PermissionRequested(&permission, &mut token)? };
                Ok::<(), webview2_com::Error>(())
            })();
            let _ = sender.send(result.map_err(|error| error.to_string()));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out configuring WebView2 browser security".to_string())?
}
