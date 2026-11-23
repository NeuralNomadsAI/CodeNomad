use super::*;
use codenomad_client::settings::opencode_status;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

fn offer(version: &str) -> Value {
    json!({
        "state":"ready","serviceState":"ready","currentVersion":"2.3.0",
        "latestVersion":version,"canUpgrade":true,"updateAvailable":true,
        "binaryPath":"C:/fixture/opencode.exe"
    })
}

#[test]
fn opencode_install_checks_offer_and_never_retries_an_uncertain_post() {
    platform::block_on(async {
        for (local, latest, success) in [
            (true, "2.3.2", false),
            (true, "2.3.2", true),
            (true, "2.3.3", false),
            (false, "2.3.2", false),
        ] {
            let (listener, mut prefs) = fixture().await;
            let backend = prefs.backend.clone().unwrap();
            let pending = {
                let backend = backend.clone();
                let (out, input) = bounded(1);
                platform::spawn(async move {
                    let _ = out.send(opencode_status(&backend, false).await).await;
                });
                input
            };
            request(&listener).await.reply(200, offer("2.3.2")).await;
            let status = timeout(Duration::from_secs(3), pending.recv())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            prefs.opencode_install.start(&backend, &status, None, None);
            prefs.opencode_install.start(&backend, &status, None, None);
            let meta = request(&listener).await;
            assert_eq!(meta.first, "GET /api/meta HTTP/1.1");
            meta.reply(200, json!({"localRequest":local})).await;
            if local {
                let check = request(&listener).await;
                assert_eq!(check.first, "GET /api/opencode/update HTTP/1.1");
                check.reply(200, offer(latest)).await;
            }
            wait_until(|| prefs.poll()).await;
            if local && latest == "2.3.2" {
                let write = request(&listener).await;
                assert_eq!(write.first, "POST /api/opencode/update HTTP/1.1");
                assert_eq!(write.body, json!({}));
                if success {
                    write
                        .reply(200, json!({"success":true,"version":"2.3.2"}))
                        .await;
                } else {
                    drop(write);
                }
                wait_until(|| prefs.poll()).await;
            }
            assert!(!prefs.opencode_install.busy());
            assert_eq!(prefs.opencode_install.revision(), 1);
            assert_eq!(
                prefs.opencode_install.error(Some(&backend)),
                (!success).then_some("settings.opencode.setup.actionFailed")
            );
            prefs.window_wake = Some(std::sync::Arc::new(|| {}));
            let shared = Rc::new(RefCell::new(prefs));
            let mut window = crate::settings::view::Window::new(shared, Rc::new(Cell::new(false)));
            window.check_opencode(None);
            let reread = request(&listener).await;
            assert_eq!(reread.first, "GET /api/opencode/update HTTP/1.1");
            reread.reply(200, offer(latest)).await;
            assert!(
                timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        }
    });
}
