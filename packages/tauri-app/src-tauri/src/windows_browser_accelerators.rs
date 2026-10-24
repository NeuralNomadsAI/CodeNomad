//! F6's browser pane-focus action crashed WebView2 154.0.4258.62 in the
//! captured #875 dump. Disable that browser action, not DOM keyboard delivery.
use webview2_com::{AcceleratorKeyPressedEventHandler, Microsoft::Web::WebView2::Win32::*};
use windows_core::Interface;

fn suppress_browser_action(key: u32, kind: COREWEBVIEW2_KEY_EVENT_KIND) -> bool {
    key == 0x75
        && matches!(
            kind,
            COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN | COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
        )
}

pub(crate) fn install(controller: &ICoreWebView2Controller) -> webview2_com::Result<()> {
    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else { return Ok(()) };
        unsafe {
            let mut key = 0;
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            args.VirtualKey(&mut key)?;
            args.KeyEventKind(&mut kind)?;
            if suppress_browser_action(key, kind) {
                if let Ok(args2) = args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>() {
                    // Unlike Handled, this leaves configured UI shortcuts working.
                    args2.SetIsBrowserAcceleratorKeyEnabled(false)?;
                } else {
                    // Older hosts lack per-key browser policy. Suppress F6 rather
                    // than disable all browser shortcuts or risk the crash path.
                    args.SetHandled(true)?;
                }
            }
        }
        Ok(())
    }));
    let mut token = 0;
    unsafe {
        controller.add_AcceleratorKeyPressed(&handler, &mut token)?;
    }
    Ok(())
}

pub(crate) fn bind(webview: &tauri::Webview) {
    if let Err(error) = webview.with_webview(|platform| {
        if let Err(error) = install(&platform.controller()) {
            eprintln!("[browser-accelerators] failed to protect F6: {error}");
        }
    }) {
        eprintln!("[browser-accelerators] failed to access WebView2: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_f6_key_down_disables_the_browser_action() {
        for key in 0..=255 {
            for kind in [
                COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
                COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
                COREWEBVIEW2_KEY_EVENT_KIND_KEY_UP,
                COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_UP,
            ] {
                assert_eq!(
                    suppress_browser_action(key, kind),
                    key == 0x75
                        && (kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                            || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN)
                );
            }
        }
    }
}
