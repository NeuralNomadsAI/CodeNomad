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

#[test]
fn log_level_is_lazy_and_reconciles_a_lost_receipt_after_the_view_closes() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        assert!(!prefs.poll());
        assert!(prefs.show_opencode());
        assert!(prefs.poll());
        let read = request(&listener).await;
        assert_eq!(
            read.first,
            "GET /api/storage/config/server?authoritative=1 HTTP/1.1"
        );
        read.reply(200, json!({})).await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(prefs.log_level(), Some(0));
        prefs.set_log_level(2);
        prefs.set_log_level(3);
        assert!(prefs.log_level_pending());
        assert_eq!(prefs.log_level(), Some(0));
        prefs.hide_opencode();
        assert!(prefs.poll());
        let write = request(&listener).await;
        assert_eq!(write.first, "PATCH /api/storage/config/server HTTP/1.1");
        assert_eq!(write.body, json!({"logLevel":"WARN"}));
        drop(write);
        let reread = request(&listener).await;
        assert_eq!(
            reread.first,
            "GET /api/storage/config/server?authoritative=1 HTTP/1.1"
        );
        reread.reply(200, json!({"logLevel":"WARN"})).await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(prefs.log_level(), Some(2));
        assert!(!prefs.log_level_pending());
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn opencode_binary_selection_add_remove_and_fresh_list_fencing() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        assert!(prefs.show_opencode());
        assert!(prefs.poll());
        let read_server = request(&listener).await;
        assert_eq!(
            read_server.first,
            "GET /api/storage/config/server?authoritative=1 HTTP/1.1"
        );
        read_server
            .reply(200, json!({"opencodeBinary": "opencode"}))
            .await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(prefs.opencode_binary().as_deref(), Some("opencode2"));

        // Seed Owner::State snapshot so binary selection is ready.
        prefs.state.snapshot = Some(json!({
            "opencodeBinaries": [
                {"path": "/existing/opencode2", "version": "2.3.0", "lastUsed": 100}
            ]
        }));
        assert!(prefs.select_opencode_binary("/custom/opencode2", Some("2.4.1".into()), 200));
        assert!(prefs.poll());

        // Expect PATCH on server AND fresh GET before PATCH on state.
        let mut saw_server_patch = false;
        let mut saw_state_get = false;
        let mut saw_state_patch = false;
        for _ in 0..3 {
            let req = request(&listener).await;
            match req.first.as_str() {
                "PATCH /api/storage/config/server HTTP/1.1" => {
                    assert_eq!(req.body, json!({"opencodeBinary": "/custom/opencode2"}));
                    req.reply(200, json!({"opencodeBinary": "/custom/opencode2"}))
                        .await;
                    saw_server_patch = true;
                }
                "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                    // Simulate another window adding a concurrent binary before our PATCH.
                    req.reply(
                        200,
                        json!({
                            "opencodeBinaries": [
                                {"path": "/other/opencode2", "label": "Team build", "version": "2.4.0", "lastUsed": 150}
                            ]
                        }),
                    )
                    .await;
                    saw_state_get = true;
                }
                "PATCH /api/storage/state/ui HTTP/1.1" => {
                    let list = req.body["opencodeBinaries"].as_array().unwrap().clone();
                    assert_eq!(list.len(), 2);
                    assert_eq!(list[0]["path"], "/custom/opencode2");
                    assert_eq!(list[0]["version"], "2.4.1");
                    assert_eq!(list[1]["path"], "/other/opencode2");
                    assert_eq!(list[1]["label"], "Team build");
                    req.reply(200, json!({"opencodeBinaries": list})).await;
                    saw_state_patch = true;
                }
                other => panic!("unexpected request: {other}"),
            }
            wait_until(|| prefs.poll()).await;
        }
        assert!(saw_server_patch && saw_state_get && saw_state_patch);
        assert_eq!(
            prefs.opencode_binary().as_deref(),
            Some("/custom/opencode2")
        );
        assert_eq!(prefs.opencode_binaries().len(), 2);

        // Removing the active custom binary resets server.opencodeBinary back to opencode2.
        assert!(prefs.remove_opencode_binary("/custom/opencode2"));
        assert!(prefs.poll());
        let mut reset_server = false;
        let mut removed_state = false;
        for _ in 0..3 {
            let req = request(&listener).await;
            match req.first.as_str() {
                "PATCH /api/storage/config/server HTTP/1.1" => {
                    assert_eq!(req.body, json!({"opencodeBinary": "opencode2"}));
                    req.reply(200, json!({"opencodeBinary": "opencode2"})).await;
                    reset_server = true;
                }
                "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                    req.reply(
                        200,
                        json!({
                            "opencodeBinaries": [
                                {"path": "/custom/opencode2", "version": "2.4.1", "lastUsed": 200},
                                {"path": "/other/opencode2", "version": "2.4.0", "lastUsed": 150}
                            ]
                        }),
                    )
                    .await;
                }
                "PATCH /api/storage/state/ui HTTP/1.1" => {
                    let list = req.body["opencodeBinaries"].as_array().unwrap().clone();
                    assert_eq!(list.len(), 1);
                    assert_eq!(list[0]["path"], "/other/opencode2");
                    req.reply(200, json!({"opencodeBinaries": list})).await;
                    removed_state = true;
                }
                other => panic!("unexpected request: {other}"),
            }
            wait_until(|| prefs.poll()).await;
        }
        assert!(reset_server && removed_state);
        assert_eq!(prefs.opencode_binary().as_deref(), Some("opencode2"));
        assert_eq!(prefs.opencode_binaries().len(), 1);
    });
}

#[test]
fn opencode_cards_validate_binary_toggle_login_start_and_view_logs() {
    platform::block_on(async {
        use crate::settings::view::{self, Window};
        use std::{
            cell::{Cell, RefCell},
            rc::Rc,
        };

        let (listener, mut prefs) = fixture().await;
        let (wake_tx, wake_rx) = bounded::<()>(16);
        let wake: rune::Waker = std::sync::Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        prefs.window_wake = Some(wake.clone());
        prefs.main_wake = Some(wake);
        prefs.state.snapshot = Some(json!({ "opencodeBinaries": [] }));

        let shared = Rc::new(RefCell::new(prefs));
        let state = Window::new(shared.clone(), Rc::new(Cell::new(false)));
        let mut rt = rune::Runtime::new(
            state,
            view::view,
            (1000.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);

        let poll_frame = |rt: &mut rune::Runtime<Window>| {
            rt.update(|state, tx| {
                view::spec().poll.unwrap()(state, 0.0, tx);
            });
            rt.frame(0.02);
        };
        let click = |rt: &mut rune::Runtime<Window>, key: &str| {
            let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing key {key}"));
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            rt.frame(0.02);
        };

        // Open the OpenCode tab.
        click(&mut rt, "settings-opencode");
        poll_frame(&mut rt);

        let mut login_state = "off".to_owned();
        let mut server_binary = "opencode2".to_owned();
        let mut binaries_json = json!([]);
        let mut update_reads = 0usize;
        let mut log_reads = 0usize;
        let mut fail_next_login = true;

        async fn serve_pending(
            listener: &TcpListener,
            login_state: &mut String,
            server_binary: &mut String,
            binaries_json: &mut Value,
            update_reads: &mut usize,
            log_reads: &mut usize,
            fail_next_login: &mut bool,
        ) -> usize {
            let mut handled = 0usize;
            while let Ok(Ok(req)) = timeout(Duration::from_millis(60), async {
                Ok::<_, ()>(request(listener).await)
            })
            .await
            {
                handled += 1;
                match req.first.as_str() {
                    "GET /api/meta HTTP/1.1" => {
                        req.reply(200, json!({"version": "1.0.0"})).await;
                    }
                    "GET /api/storage/config/server?authoritative=1 HTTP/1.1" => {
                        req.reply(
                            200,
                            json!({"logLevel": "DEBUG", "opencodeBinary": *server_binary}),
                        )
                        .await;
                    }
                    "PATCH /api/storage/config/server HTTP/1.1" => {
                        if let Some(bin) = req.body["opencodeBinary"].as_str() {
                            *server_binary = bin.to_owned();
                        }
                        req.reply(
                            200,
                            json!({"logLevel": "DEBUG", "opencodeBinary": *server_binary}),
                        )
                        .await;
                    }
                    "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                        req.reply(200, json!({"opencodeBinaries": binaries_json.clone()}))
                            .await;
                    }
                    "PATCH /api/storage/state/ui HTTP/1.1" => {
                        *binaries_json = req.body["opencodeBinaries"].clone();
                        req.reply(200, json!({"opencodeBinaries": binaries_json.clone()}))
                            .await;
                    }
                    "GET /api/opencode/update HTTP/1.1" => {
                        *update_reads += 1;
                        req.reply(
                            200,
                            json!({
                                "state": "ready",
                                "serviceState": "ready",
                                "currentVersion": "2.3.2",
                                "installationSource": "managed",
                                "binaryPath": "/managed/opencode2"
                            }),
                        )
                        .await;
                    }
                    "GET /api/opencode/login-start HTTP/1.1" => {
                        req.reply(200, json!({"state": *login_state})).await;
                    }
                    "POST /api/opencode/login-start HTTP/1.1" => {
                        if *fail_next_login {
                            *fail_next_login = false;
                            req.reply(422, json!({"error": "login-start-unsupported-binary"}))
                                .await;
                        } else {
                            let enabled = req.body["enabled"] == true;
                            *login_state = if enabled { "on" } else { "off" }.to_owned();
                            req.reply(200, json!({"state": *login_state})).await;
                        }
                    }
                    "POST /api/storage/binaries/validate HTTP/1.1" => {
                        let path = req.body["path"].as_str().unwrap_or("");
                        if path == "/legacy/opencode1" {
                            req.reply(
                                200,
                                json!({
                                    "valid": false,
                                    "errorCode": "opencode_v2_required",
                                    "error": "Requires V2"
                                }),
                            )
                            .await;
                        } else {
                            req.reply(200, json!({"valid": true, "version": "2.4.1"}))
                                .await;
                        }
                    }
                    "GET /api/opencode/logs HTTP/1.1" => {
                        *log_reads += 1;
                        req.reply(
                            200,
                            json!({
                                "path": "/var/log/opencode.log",
                                "text": format!("log snapshot #{log_reads}\n"),
                                "truncated": *log_reads == 1
                            }),
                        )
                        .await;
                    }
                    other => panic!("unexpected request in opencode cards test: {other}"),
                }
            }
            handled
        }

        // Drain initial load (update status, server config, login-start, default binary validation).
        for _ in 0..8 {
            let n = serve_pending(
                &listener,
                &mut login_state,
                &mut server_binary,
                &mut binaries_json,
                &mut update_reads,
                &mut log_reads,
                &mut fail_next_login,
            )
            .await;
            while wake_rx.try_recv().is_ok() {}
            poll_frame(&mut rt);
            if n == 0 && update_reads >= 1 {
                break;
            }
        }
        assert!(update_reads >= 1);

        // 1. Login-start toggle failure surfaces unsupported-binary error after reloading host state,
        //    then second click succeeds.
        click(&mut rt, "opencode-login-start-switch");
        for _ in 0..8 {
            let n = serve_pending(
                &listener,
                &mut login_state,
                &mut server_binary,
                &mut binaries_json,
                &mut update_reads,
                &mut log_reads,
                &mut fail_next_login,
            )
            .await;
            poll_frame(&mut rt);
            if n == 0 && rt.find("opencode-login-start-error").is_some() {
                break;
            }
        }
        assert!(
            rt.find("opencode-login-start-error").is_some(),
            "refused login-start change must surface unsupported-binary error"
        );
        click(&mut rt, "opencode-login-start-switch");
        for _ in 0..8 {
            let n = serve_pending(
                &listener,
                &mut login_state,
                &mut server_binary,
                &mut binaries_json,
                &mut update_reads,
                &mut log_reads,
                &mut fail_next_login,
            )
            .await;
            poll_frame(&mut rt);
            if n == 0 && login_state == "on" {
                break;
            }
        }
        assert_eq!(login_state, "on");
        assert!(rt.find("opencode-login-start-error").is_none());

        // 2. Open Logs window, verify truncated notice & content, refresh, then open custom binary
        //    and switch binary -> Logs window auto-closes and update status refreshes.
        click(&mut rt, "opencode-logs-open");
        for _ in 0..6 {
            let n = serve_pending(
                &listener,
                &mut login_state,
                &mut server_binary,
                &mut binaries_json,
                &mut update_reads,
                &mut log_reads,
                &mut fail_next_login,
            )
            .await;
            poll_frame(&mut rt);
            if n == 0 && rt.find("opencode-logs-content").is_some() {
                break;
            }
        }
        assert_eq!(log_reads, 1);
        assert!(rt.find("opencode-logs-truncated").is_some());
        click(&mut rt, "opencode-logs-refresh");
        for _ in 0..6 {
            let n = serve_pending(
                &listener,
                &mut login_state,
                &mut server_binary,
                &mut binaries_json,
                &mut update_reads,
                &mut log_reads,
                &mut fail_next_login,
            )
            .await;
            poll_frame(&mut rt);
            if n == 0 && log_reads == 2 {
                break;
            }
        }
        assert_eq!(log_reads, 2);
        assert!(rt.find("opencode-logs-truncated").is_none());

        // Changing the active executable auto-closes the logs overlay.
        let updates_before = update_reads;
        assert!(shared.borrow_mut().select_opencode_binary(
            "/opt/opencode2",
            Some("2.4.1".into()),
            999
        ));
        for _ in 0..8 {
            let n = serve_pending(
                &listener,
                &mut login_state,
                &mut server_binary,
                &mut binaries_json,
                &mut update_reads,
                &mut log_reads,
                &mut fail_next_login,
            )
            .await;
            poll_frame(&mut rt);
            if n == 0 && server_binary == "/opt/opencode2" && update_reads > updates_before {
                break;
            }
        }
        assert_eq!(server_binary, "/opt/opencode2");
        assert!(
            rt.find("opencode-logs-window").is_none(),
            "switching OpenCode binary must close open logs window"
        );
        assert!(
            update_reads > updates_before,
            "switching OpenCode binary must refresh diagnostic status"
        );
    });
}

#[test]
fn opencode_binary_preflight_503_recovers_and_remove_clears_failed_selection() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.state.snapshot = Some(json!({
            "opencodeBinaries": [
                {"path": "/a/opencode2", "label": "Alpha", "version": "2.4.0", "lastUsed": 100}
            ]
        }));
        assert!(prefs.show_opencode());
        assert!(prefs.poll());
        let initial = request(&listener).await;
        assert_eq!(
            initial.first,
            "GET /api/storage/config/server?authoritative=1 HTTP/1.1"
        );
        initial
            .reply(200, json!({"opencodeBinary": "opencode2"}))
            .await;
        wait_until(|| prefs.poll()).await;

        // 1. Selecting /a/opencode2 fails on server config PATCH (503 -> readback confirms
        //    unchanged opencode2 -> failed) while UI state succeeds and preserves `label`.
        assert!(prefs.select_opencode_binary("/a/opencode2", Some("2.4.0".into()), 200));
        assert!(prefs.poll());
        let mut server_readback = false;
        let mut state_patched = false;
        for _ in 0..8 {
            while let Ok(Ok(req)) = timeout(Duration::from_millis(60), async {
                Ok::<_, ()>(request(&listener).await)
            })
            .await
            {
                match req.first.as_str() {
                    "PATCH /api/storage/config/server HTTP/1.1" => {
                        req.reply(503, json!({"error": "unavailable"})).await;
                    }
                    "GET /api/storage/config/server?authoritative=1 HTTP/1.1" => {
                        server_readback = true;
                        req.reply(200, json!({"opencodeBinary": "opencode2"})).await;
                    }
                    "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                        req.reply(
                            200,
                            json!({
                                "opencodeBinaries": [
                                    {"path": "/a/opencode2", "label": "Alpha", "version": "2.4.0", "lastUsed": 100}
                                ]
                            }),
                        )
                        .await;
                    }
                    "PATCH /api/storage/state/ui HTTP/1.1" => {
                        let list = req.body["opencodeBinaries"].as_array().unwrap().clone();
                        assert_eq!(list[0]["label"], "Alpha");
                        req.reply(200, json!({"opencodeBinaries": list})).await;
                        state_patched = true;
                    }
                    other => panic!("unexpected request: {other}"),
                }
            }
            prefs.poll();
            if server_readback && state_patched && !prefs.opencode_binary_pending() {
                break;
            }
        }
        assert!(server_readback && state_patched);
        assert!(prefs.opencode_binary_failed().is_some());
        assert!(!prefs.opencode_binary_pending());

        // 2. Removing /a/opencode2 clears the failed selection for /a/opencode2; a 503 on
        //    the pre-PATCH GET settles out of pending so Retry remains actionable.
        assert!(prefs.remove_opencode_binary("/a/opencode2"));
        assert!(prefs.poll());
        let preflight = request(&listener).await;
        assert_eq!(
            preflight.first,
            "GET /api/storage/state/ui?authoritative=1 HTTP/1.1"
        );
        preflight.reply(503, json!({"error": "busy"})).await;
        wait_until(|| prefs.poll()).await;
        assert!(
            !prefs.opencode_binary_pending(),
            "failed pre-PATCH GET must not leave Retry disabled"
        );
        assert!(prefs.opencode_binary_failed().is_some());

        // 3. Retry completes removal and NEVER replays the cleared failed selection of /a/opencode2.
        prefs.retry_opencode_binary();
        assert!(prefs.poll());
        let retry_get = request(&listener).await;
        assert_eq!(
            retry_get.first,
            "GET /api/storage/state/ui?authoritative=1 HTTP/1.1"
        );
        retry_get
            .reply(
                200,
                json!({
                    "opencodeBinaries": [
                        {"path": "/a/opencode2", "label": "Alpha", "version": "2.4.0", "lastUsed": 200}
                    ]
                }),
            )
            .await;
        wait_until(|| prefs.poll()).await;
        let retry_patch = request(&listener).await;
        assert_eq!(retry_patch.first, "PATCH /api/storage/state/ui HTTP/1.1");
        assert_eq!(retry_patch.body, json!({"opencodeBinaries": []}));
        retry_patch
            .reply(200, json!({"opencodeBinaries": []}))
            .await;
        wait_until(|| prefs.poll()).await;

        assert_eq!(prefs.opencode_binary().as_deref(), Some("opencode2"));
        assert!(prefs.opencode_binaries().is_empty());
        assert!(prefs.opencode_binary_failed().is_none());
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err(),
            "cleared failed selection must not replay on Retry"
        );
    });
}

#[test]
fn opencode_login_start_single_initial_read_and_reconnect_reload() {
    platform::block_on(async {
        use crate::settings::view::{self, Window};
        use std::{
            cell::{Cell, RefCell},
            rc::Rc,
        };

        let (listener, mut prefs) = fixture().await;
        let wake: rune::Waker = std::sync::Arc::new(|| {});
        prefs.window_wake = Some(wake.clone());
        prefs.main_wake = Some(wake);
        prefs.state.snapshot = Some(json!({ "opencodeBinaries": [] }));

        let shared = Rc::new(RefCell::new(prefs));
        let state = Window::new(shared.clone(), Rc::new(Cell::new(false)));
        let mut rt = rune::Runtime::new(
            state,
            view::view,
            (1000.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);

        let poll_frame = |rt: &mut rune::Runtime<Window>| {
            rt.update(|state, tx| {
                view::spec().poll.unwrap()(state, 0.0, tx);
            });
            rt.frame(0.02);
        };

        // No login-start GET before opening OpenCode tab (only /api/meta capability probe).
        poll_frame(&mut rt);
        while let Ok(Ok(req)) = timeout(Duration::from_millis(60), async {
            Ok::<_, ()>(request(&listener).await)
        })
        .await
        {
            assert_eq!(
                req.first, "GET /api/meta HTTP/1.1",
                "no OpenCode request may fire before opening the OpenCode tab"
            );
            req.reply(200, json!({"version": "1.0.0"})).await;
        }
        poll_frame(&mut rt);

        let (x, y) = rt.find("settings-opencode").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        poll_frame(&mut rt);

        let mut login_reads = 0usize;
        let mut login_value = "off";
        for _ in 0..8 {
            let mut handled = 0usize;
            while let Ok(Ok(req)) = timeout(Duration::from_millis(60), async {
                Ok::<_, ()>(request(&listener).await)
            })
            .await
            {
                handled += 1;
                match req.first.as_str() {
                    "GET /api/meta HTTP/1.1" => req.reply(200, json!({"version": "1.0.0"})).await,
                    "GET /api/storage/config/server?authoritative=1 HTTP/1.1" => {
                        req.reply(
                            200,
                            json!({"logLevel": "INFO", "opencodeBinary": "opencode2"}),
                        )
                        .await;
                    }
                    "GET /api/opencode/update HTTP/1.1" => {
                        req.reply(
                            200,
                            json!({
                                "state": "ready",
                                "serviceState": "ready",
                                "currentVersion": "2.3.2",
                                "installationSource": "managed"
                            }),
                        )
                        .await;
                    }
                    "GET /api/opencode/login-start HTTP/1.1" => {
                        login_reads += 1;
                        req.reply(200, json!({"state": login_value})).await;
                    }
                    other => panic!("unexpected request: {other}"),
                }
            }
            poll_frame(&mut rt);
            if handled == 0 && login_reads >= 1 {
                break;
            }
        }
        assert_eq!(
            login_reads, 1,
            "first OpenCode open must issue exactly one login-start GET"
        );

        // Simulate transport drop and reconnect on the SAME client_id.
        login_value = "on";
        shared.borrow_mut().mark_transport_lost();
        poll_frame(&mut rt);
        shared.borrow_mut().revalidate_transport();
        shared.borrow_mut().poll();
        for _ in 0..10 {
            let mut handled = 0usize;
            while let Ok(Ok(req)) = timeout(Duration::from_millis(60), async {
                Ok::<_, ()>(request(&listener).await)
            })
            .await
            {
                handled += 1;
                match req.first.as_str() {
                    "GET /api/meta HTTP/1.1" => req.reply(200, json!({"version": "1.0.0"})).await,
                    "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" => {
                        req.reply(200, json!({"settings": {}})).await;
                    }
                    "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                        req.reply(200, json!({"opencodeBinaries": []})).await;
                    }
                    "GET /api/storage/config/server?authoritative=1 HTTP/1.1" => {
                        req.reply(
                            200,
                            json!({"logLevel": "INFO", "opencodeBinary": "opencode2"}),
                        )
                        .await;
                    }
                    "GET /api/opencode/login-start HTTP/1.1" => {
                        login_reads += 1;
                        req.reply(200, json!({"state": login_value})).await;
                    }
                    other => panic!("unexpected reconnect request: {other}"),
                }
            }
            shared.borrow_mut().poll();
            poll_frame(&mut rt);
            if handled == 0 && login_reads >= 2 {
                break;
            }
        }
        assert_eq!(
            login_reads, 2,
            "transport reconnect on the same client_id must reload login-start once"
        );
    });
}
