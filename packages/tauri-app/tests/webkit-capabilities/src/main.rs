//! Isolated real-engine harness: no backend, daemon or application commands.
//! Start fixture.py, then cargo run -p codenomad-webkit-capabilities-fixture.
#![allow(dead_code)]
#[path = "../../../src-tauri/src/embedded_view.rs"]
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod embedded_view;

// The harness has one fixed local owner; production uses identity.rs.
mod identity {
    pub fn local_window_id(label: &str) -> Result<String, String> {
        (label == super::OWNER)
            .then(|| label.into())
            .ok_or_else(|| "Invalid fixture owner".into())
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
use tauri::Manager;
const OWNER: &str = "local-11111111-1111-4111-8111-111111111111";

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn main() {}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn main() {
    let root =
        std::env::var_os("CODENOMAD_PROFILE").expect("set an isolated CODENOMAD_PROFILE directory");
    let root = std::path::PathBuf::from(root);
    std::fs::create_dir_all(&root).unwrap();
    tauri::Builder::default()
        .manage(embedded_view::StorageIdentity::new(
            root.to_string_lossy().into(),
            "capabilities-fixture".into(),
        ))
        .manage(embedded_view::EmbeddedViews::default())
        .setup(move |app| {
            let window = tauri::WebviewWindowBuilder::new(
                app,
                OWNER,
                tauri::WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .title("WebKit capabilities fixture")
            .inner_size(900.0, 740.0)
            .build()?;
            let views = app.state::<embedded_view::EmbeddedViews>();
            let guest = views.create(
                &window.as_ref().window(),
                "browser-fixture",
                root.join("browser"),
                embedded_view::Bounds {
                    x: 0,
                    y: 0,
                    width: 880,
                    height: 700,
                },
                |_, _| {},
                |_| true,
            )?;
            guest.navigate("http://127.0.0.1:18741/".parse().unwrap())?;
            guest.show()?;
            if let Ok(seconds) = std::env::var("CODENOMAD_FIXTURE_CLOSE_AFTER")
                .unwrap_or_default()
                .parse::<u64>()
            {
                assert!((1..=60).contains(&seconds));
                let policy = views.inner().clone();
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(seconds));
                    policy.close(&handle, OWNER, "browser-fixture").unwrap();
                    for _ in 0..100 {
                        if handle.get_webview("browser-fixture").is_none()
                            && handle
                                .windows()
                                .keys()
                                .all(|label| !label.starts_with("browser-popup-"))
                        {
                            eprintln!("opener and popup tree disposed");
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    panic!("opener or popup tree survived closure");
                });
            }
            let policy = views.inner().clone();
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    policy.remove_owner(&handle, OWNER);
                }
            });
            Ok(())
        })
        .run(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
}
