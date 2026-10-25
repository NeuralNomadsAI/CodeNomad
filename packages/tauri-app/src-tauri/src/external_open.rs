//! Opens external links in the user's default handler: help, release notes,
//! intercepted navigations and the links the renderer hands over. On Linux the
//! handler, often a browser that outlives an AppImage's mount, starts with the
//! host's environment (`appimage_environment`); elsewhere the opener plugin
//! launches it.

use tauri::{AppHandle, Runtime};

pub(crate) fn open_url<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        open_with_host_environment(url)
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|error| error.to_string())
    }
}

/// Tries the opener plugin's launchers (`xdg-open`, `gio open`, ...) in order, each
/// detached in its own session like the plugin's, so closing CodeNomad never
/// signals the handler.
#[cfg(target_os = "linux")]
fn open_with_host_environment(url: &str) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let mut last_error = None;
    for mut command in open::commands(url) {
        crate::appimage_environment::use_host_environment(&mut command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        match command.spawn() {
            Ok(mut child) => {
                // The launcher exits once it has handed the link over; reap it.
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.map_or_else(|| "no URL launcher".to_string(), |error| error.to_string()))
}
