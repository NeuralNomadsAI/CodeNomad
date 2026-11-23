use super::*;
use codenomad_client::settings::opencode_status;

fn offer(version: &str) -> Value {
    json!({
        "state":"ready","serviceState":"ready","currentVersion":"2.3.0",
        "latestVersion":version,"canUpgrade":true,"updateAvailable":true,
        "binaryPath":"C:/fixture/opencode.exe"
    })
}

async fn read_offer(
    listener: &TcpListener,
    backend: &Backend,
) -> codenomad_client::settings::OpenCodeStatus {
    let backend = backend.clone();
    let (out, input) = bounded(1);
    platform::spawn(async move {
        let _ = out.send(opencode_status(&backend, false).await).await;
    });
    request(listener).await.reply(200, offer("2.3.2")).await;
    timeout(Duration::from_secs(3), input.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
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
            let status = read_offer(&listener, &backend).await;
            let wake: rune::Waker = std::sync::Arc::new(|| {});
            prefs
                .opencode_install
                .start(&backend, &status, wake.clone());
            prefs
                .opencode_install
                .start(&backend, &status, wake.clone());
            let meta = request(&listener).await;
            assert_eq!(meta.first, "GET /api/meta HTTP/1.1");
            meta.reply(200, json!({"localRequest":local})).await;
            if local {
                let check = request(&listener).await;
                assert_eq!(check.first, "GET /api/opencode/update HTTP/1.1");
                check.reply(200, offer(latest)).await;
            }
            wait_until(|| {
                prefs
                    .opencode_install
                    .admit(Some(&backend), None, wake.clone())
            })
            .await;
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
                // No Preferences view exists, and nobody polls the store to start the read.
                let reread = request(&listener).await;
                assert_eq!(reread.first, "GET /api/opencode/update?recheck=1 HTTP/1.1");
                let mut updated = offer(latest);
                updated["currentVersion"] = json!("2.3.2");
                reread.reply(200, updated).await;
                wait_until(|| prefs.poll()).await;
                let diagnostic = prefs
                    .opencode_install
                    .take_status(Some(&backend))
                    .unwrap()
                    .0;
                assert_eq!(diagnostic.unwrap().current.as_deref(), Some("2.3.2"));
            } else if local {
                let diagnostic = prefs
                    .opencode_install
                    .take_status(Some(&backend))
                    .unwrap()
                    .0;
                assert_eq!(diagnostic.unwrap().latest.as_deref(), Some(latest));
            }
            assert!(!prefs.opencode_install.busy());
            assert_eq!(
                prefs.opencode_install.error(Some(&backend)),
                (!success).then_some("settings.opencode.setup.actionFailed")
            );
            assert!(
                timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        }
    });
}

#[test]
fn closing_cancels_the_in_flight_offer_http_read() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.clone().unwrap();
        let status = read_offer(&listener, &backend).await;
        let wake: rune::Waker = std::sync::Arc::new(|| {});
        prefs
            .opencode_install
            .start(&backend, &status, wake.clone());
        let meta = request(&listener).await;
        meta.reply(200, json!({"localRequest":true})).await;
        let mut check = request(&listener).await;
        assert_eq!(check.first, "GET /api/opencode/update HTTP/1.1");
        prefs.opencode_install.cancel_check();
        let mut byte = [0];
        assert_eq!(
            timeout(Duration::from_secs(3), check.socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(!prefs.opencode_install.admit(Some(&backend), None, wake));
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn a_close_request_wins_over_the_checked_offer_in_the_same_frame() {
    platform::block_on(async {
        use crate::settings::view::{self, CloseRequest, Window};
        use std::{
            cell::{Cell, RefCell},
            rc::Rc,
        };

        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.clone().unwrap();
        let status = read_offer(&listener, &backend).await;
        let (wake, notified) = bounded(1);
        let wake: rune::Waker = std::sync::Arc::new(move || {
            let _ = wake.try_send(());
        });
        prefs.window_wake = Some(wake.clone());
        prefs.opencode_install.start(&backend, &status, wake);
        request(&listener)
            .await
            .reply(200, json!({"localRequest":true}))
            .await;
        request(&listener).await.reply(200, offer("2.3.2")).await;
        timeout(Duration::from_secs(3), notified.recv())
            .await
            .unwrap()
            .unwrap();

        let shared = Rc::new(RefCell::new(prefs));
        let close = Rc::new(CloseRequest::default());
        let state = Window::new(shared.clone(), Rc::new(Cell::new(false)))
            .with_close_request(close.clone(), None);
        let mut rt = rune::Runtime::new(
            state,
            view::view,
            (1000.0, 700.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let (x, y) = rt.find("settings-opencode").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        close.requested.set(true);
        rt.update(|state, tx| {
            view::spec().poll.unwrap()(state, 0.0, tx);
        });
        assert!(!shared.borrow().opencode_install.busy());
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}
