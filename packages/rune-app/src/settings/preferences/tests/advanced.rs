use super::*;
use crate::settings::advanced::Toggle;

#[test]
fn advanced_persists_only_supported_options_and_one_server_environment_variable() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        for (toggle, value) in [
            (Toggle::EmptySessions, false),
            (Toggle::UnseenSubagents, false),
            (Toggle::SecondLaunch, true),
            (Toggle::ProviderBalance, true),
            (Toggle::Whitespace, false),
            (Toggle::LongReplies, false),
        ] {
            assert_ne!(prefs.advanced_toggle(toggle), Some(value));
            prefs.set_advanced_toggle(toggle, value);
        }
        assert!(prefs.poll());
        let req = request(&listener).await;
        assert_eq!(req.first, "PATCH /api/storage/config/ui HTTP/1.1");
        let expected = if cfg!(target_os = "windows") {
            json!({"settings":{
                "focusExistingWindowOnSecondLaunch": true,
                "hideDiffWhitespaceChanges": false
            }})
        } else {
            json!({"settings":{
                "hideDiffWhitespaceChanges": false
            }})
        };
        assert_eq!(req.body, expected);
        req.reply(200, expected).await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(prefs.advanced_toggle(Toggle::ProviderBalance), Some(false));
        assert_eq!(
            prefs.advanced_toggle(Toggle::SecondLaunch),
            Some(cfg!(target_os = "windows"))
        );

        prefs.show_environment(true);
        let backend = prefs.backend.clone().unwrap();
        backend.client.observe_atomic_settings_patches(true);
        assert!(prefs.poll());
        let read = request(&listener).await;
        assert!(read.first.starts_with("GET /api/storage/config/server?"));
        read.reply(
            200,
            json!({"environmentVariables":{"OTHER":"keep"},"secureEnvVars":["OTHER"]}),
        )
        .await;
        wait_until(|| prefs.poll()).await;
        assert!(prefs.stage_environment("CN_FIXTURE".into(), Some("value".into()), Some(true)));
        assert!(prefs.poll());
        let req = request(&listener).await;
        assert_eq!(
            req.first,
            "PATCH /api/storage/config/server?conditional=atomic-v1 HTTP/1.1"
        );
        assert_eq!(
            req.body,
            json!({"environmentVariables":{"CN_FIXTURE":"value"},"secureEnvVarsMask":{"CN_FIXTURE":true}})
        );
        req.reply(200, json!({"environmentVariables":{"OTHER":"keep","CN_FIXTURE":"value"},"secureEnvVars":["OTHER","CN_FIXTURE"]})).await;
        wait_until(|| prefs.poll()).await;
        assert!(!prefs.environment_pending() && !prefs.environment_failed());
        assert!(prefs.stage_environment("CN_FIXTURE".into(), None, Some(false)));
        assert!(prefs.poll());
        let remove = request(&listener).await;
        assert_eq!(
            remove.body,
            json!({"environmentVariables":{"CN_FIXTURE":null},"secureEnvVarsMask":{"CN_FIXTURE":false}})
        );
        remove
            .reply(
                200,
                json!({"environmentVariables":{"OTHER":"keep"},"secureEnvVars":["OTHER"]}),
            )
            .await;
        wait_until(|| prefs.poll()).await;
        assert!(!prefs.environment_pending() && !prefs.environment_failed());

        // Start a real PreferencesWatch SSE stream to exercise atomic saves, downgrade
        // capability renegotiation, and foreign-server identity refusal.
        let wake: rune::Waker = std::sync::Arc::new(|| {});
        prefs.watch(&wake);
        let mut sse = None;
        let mut got_ui = false;
        let mut got_state = false;
        let mut got_server = false;
        timeout(Duration::from_secs(5), async {
            while sse.is_none() || !got_ui || !got_state || !got_server {
                let req = poll_next_request(&mut prefs, &listener).await;
                if req.first == "GET /api/meta HTTP/1.1" {
                    req.reply(
                        200,
                        json!({"apiContract":1,"serverId":"env-server","capabilities":["settings-atomic-patches"]}),
                    )
                    .await;
                } else if req.first.starts_with("GET /api/events?") {
                    let mut stream = req;
                    stream
                        .socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                        .await
                        .unwrap();
                    sse = Some(stream);
                } else if req.first.starts_with("GET /api/storage/config/ui") {
                    got_ui = true;
                    req.reply(200, json!({"settings":{"hideDiffWhitespaceChanges":false}}))
                        .await;
                } else if req.first.starts_with("GET /api/storage/state/ui") {
                    got_state = true;
                    req.reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                        .await;
                } else if req.first.starts_with("GET /api/storage/config/server") {
                    got_server = true;
                    req.reply(
                        200,
                        json!({"environmentVariables":{"OTHER":"keep"},"secureEnvVars":["OTHER"]}),
                    )
                    .await;
                } else {
                    panic!("unexpected request during SSE startup: {}", req.first);
                }
            }
        })
        .await
        .expect("timed out starting SSE stream");
        let sse = sse.unwrap();
        wait_until(|| {
            prefs.poll();
            prefs.environment_ready()
                && !prefs.server.refreshing()
                && backend.client.supports_atomic_settings_patches()
        })
        .await;
        assert!(prefs.stage_environment("CN_ATOMIC".into(), Some("secret".into()), Some(true)));
        assert!(prefs.poll());
        let atomic_patch = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            atomic_patch.first,
            "PATCH /api/storage/config/server?conditional=atomic-v1 HTTP/1.1"
        );
        assert_eq!(
            atomic_patch.body,
            json!({
                "environmentVariables":{"CN_ATOMIC":"secret"},
                "secureEnvVarsMask":{"CN_ATOMIC":true}
            })
        );
        atomic_patch
            .reply(
                200,
                json!({
                    "environmentVariables":{"OTHER":"keep","CN_ATOMIC":"secret"},
                    "secureEnvVars":["OTHER","CN_ATOMIC"]
                }),
            )
            .await;
        wait_until(|| {
            prefs.poll();
            !prefs.environment_pending() && !prefs.environment_failed()
        })
        .await;

        // Downgrading the same server (same address & identity) to an older apiContract:1 build
        // without settings-atomic-patches must renegotiate capabilities on reconnect and refuse
        // masked secret writes safely (zero destructive full-array secureEnvVars PATCH) while
        // still allowing unmasked value-only edits.
        drop(sse);
        let mut reconnected_sse = None;
        let mut got_meta = false;
        let mut got_reval_ui = false;
        let mut got_reval_state = false;
        let mut got_reval_server = false;
        timeout(Duration::from_secs(5), async {
            while !(got_meta
                && got_reval_ui
                && got_reval_state
                && got_reval_server
                && reconnected_sse.is_some())
            {
                let req = poll_next_request(&mut prefs, &listener).await;
                if req.first == "GET /api/meta HTTP/1.1" {
                    got_meta = true;
                    // Older apiContract:1 server omits capabilities entirely.
                    req.reply(200, json!({"apiContract":1,"serverId":"env-server"}))
                        .await;
                } else if req.first.starts_with("GET /api/events?") {
                    let mut stream = req;
                    stream
                        .socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                        .await
                        .unwrap();
                    reconnected_sse = Some(stream);
                } else if req.first == "GET /api/storage/config/server?authoritative=1 HTTP/1.1" {
                    got_reval_server = true;
                    req.reply(
                        200,
                        json!({
                            "environmentVariables":{"CN_ATOMIC":"secret","PLAIN":"old"},
                            "secureEnvVars":["CN_ATOMIC"]
                        }),
                    )
                    .await;
                } else if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                    got_reval_ui = true;
                    req.reply(200, json!({"settings":{"locale":"en"}})).await;
                } else if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                    got_reval_state = true;
                    req.reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                        .await;
                } else {
                    panic!(
                        "unexpected request during downgrade reconnect: {}",
                        req.first
                    );
                }
            }
        })
        .await
        .expect("timed out waiting for downgrade capability renegotiation");
        wait_until(|| {
            prefs.poll();
            prefs.environment_ready()
        })
        .await;
        assert!(
            !backend.client.supports_atomic_settings_patches(),
            "downgraded server without settings-atomic-patches must disable atomic mode"
        );
        assert!(prefs.stage_environment(
            "CN_DOWNGRADED".into(),
            Some("topsecret".into()),
            Some(true)
        ));
        assert!(prefs.poll());
        assert!(
            !prefs.environment_pending() && prefs.environment_failed(),
            "downgraded server without settings-atomic-patches must fail masked writes safely"
        );
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err(),
            "refused legacy masked write must not send any PATCH"
        );
        // Plain value-only edits (mask unchanged -> None) still work without touching secureEnvVars.
        assert!(prefs.stage_environment("PLAIN".into(), Some("new".into()), None));
        assert!(prefs.poll());
        let plain_patch = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            plain_patch.first,
            "PATCH /api/storage/config/server HTTP/1.1"
        );
        assert_eq!(
            plain_patch.body,
            json!({"environmentVariables":{"PLAIN":"new"}})
        );
        plain_patch
            .reply(
                200,
                json!({
                    "environmentVariables":{"CN_ATOMIC":"secret","PLAIN":"new"},
                    "secureEnvVars":["CN_ATOMIC"]
                }),
            )
            .await;
        wait_until(|| {
            prefs.poll();
            !prefs.environment_pending() && !prefs.environment_failed()
        })
        .await;
        // Replacing the server with a different server identity at the same address must refuse
        // reconnect and revalidation reads so pending secrets are never sent to a foreign server.
        drop(reconnected_sse);
        wait_until(|| backend.client.needs_capability_recheck()).await;
        prefs.stage_environment("CN_SECRET_A".into(), Some("only-for-a".into()), Some(true));
        let mut saw_mismatch_meta = false;
        timeout(Duration::from_secs(5), async {
            while !saw_mismatch_meta {
                prefs.poll();
                if let Ok(accepted) = timeout(Duration::from_millis(20), listener.accept()).await {
                    let (socket, _) = accepted.unwrap();
                    let req = read_request(socket, Duration::from_secs(3)).await;
                    if req.first == "GET /api/meta HTTP/1.1" {
                        saw_mismatch_meta = true;
                        req.reply(200, json!({"apiContract":1,"serverId":"foreign-server-b"}))
                            .await;
                    } else {
                        panic!(
                            "foreign server must not receive SSE or settings requests before attestation: {}",
                            req.first
                        );
                    }
                }
            }
        })
        .await
        .expect("timed out waiting for foreign-server /api/meta refusal");
        assert!(
            !prefs.environment_ready(),
            "failed identity attestation must keep environment writes blocked"
        );
        // Manually requesting a refresh must also fail attestation and never read/write foreign B.
        prefs.refresh_environment();
        assert!(prefs.poll());
        timeout(Duration::from_secs(5), async {
            let mut saw_manual_meta = false;
            while !saw_manual_meta || !prefs.environment_failed() {
                prefs.poll();
                if saw_manual_meta && prefs.environment_failed() {
                    break;
                }
                if let Ok(accepted) = timeout(Duration::from_millis(20), listener.accept()).await {
                    let (socket, _) = accepted.unwrap();
                    let req = read_request(socket, Duration::from_secs(3)).await;
                    if req.first == "GET /api/meta HTTP/1.1" {
                        saw_manual_meta = true;
                        req.reply(200, json!({"apiContract":1,"serverId":"foreign-server-b"}))
                            .await;
                    } else {
                        panic!(
                            "manual refresh against foreign server must only hit /api/meta: {}",
                            req.first
                        );
                    }
                }
            }
        })
        .await
        .expect("timed out waiting for manual refresh foreign-server refusal");
        assert!(
            !prefs.environment_ready(),
            "failed identity attestation must keep environment writes blocked"
        );
        prefs.unwatch();
    });
}

#[test]
fn unattested_and_capability_downgrade_refuse_unsafe_secret_writes() {
    platform::block_on(async {
        // 1. A prepared atomic PATCH (secureEnvVarsMask) held before send must abort and rebuild
        // as legacy secureEnvVars if capabilities downgrade before it hits the wire.
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.clone().unwrap();
        backend.client.observe_atomic_settings_patches(true);
        prefs.show_environment(true);
        assert!(prefs.poll());
        let initial = request(&listener).await;
        assert_eq!(
            initial.first,
            "GET /api/storage/config/server?authoritative=1 HTTP/1.1"
        );
        initial
            .reply(
                200,
                json!({"environmentVariables":{"OLD":"1"},"secureEnvVars":["OLD"]}),
            )
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.environment_ready()
        })
        .await;
        let (release_tx, release_rx) = bounded(1);
        prefs.server.set_pre_patch_gate(release_rx);
        assert!(prefs.stage_environment("NEW_SECRET".into(), Some("val".into()), Some(true)));
        assert!(prefs.poll());
        // Simulate capability downgrade before the prepared atomic PATCH reaches the network.
        backend.client.observe_atomic_settings_patches(false);
        let _ = release_tx.send(()).await;
        let meta = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            meta.first, "GET /api/meta HTTP/1.1",
            "capability downgrade abort must re-attest server metadata before revalidation"
        );
        meta.reply(200, json!({"apiContract":1,"serverId":"env-server"}))
            .await;
        let reval = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            reval.first, "GET /api/storage/config/server?authoritative=1 HTTP/1.1",
            "prepared atomic PATCH must be aborted and revalidated after capability downgrade"
        );
        reval
            .reply(
                200,
                json!({"environmentVariables":{"OLD":"1"},"secureEnvVars":["OLD"]}),
            )
            .await;
        wait_until(|| {
            prefs.poll();
            !prefs.environment_pending() && prefs.environment_failed()
        })
        .await;
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err(),
            "downgraded server must not receive a prepared atomic or legacy masked PATCH"
        );

        // 2. A backend marked require_attestation() whose initial /api/meta failed must refuse
        // settings writes until /api/meta succeeds and pins server_identity().
        let (listener2, mut prefs2) = fixture().await;
        let backend2 = prefs2.backend.clone().unwrap();
        backend2.client.require_attestation();
        assert!(backend2.client.needs_capability_recheck());
        prefs2.show_environment(true);
        assert!(prefs2.poll());
        let meta_fail = request(&listener2).await;
        assert_eq!(
            meta_fail.first, "GET /api/meta HTTP/1.1",
            "unattested backend must attest /api/meta before any settings GET"
        );
        meta_fail.reply(503, json!({})).await;
        wait_until(|| {
            prefs2.poll();
            prefs2.environment_failed()
        })
        .await;
        assert!(
            !prefs2.environment_ready(),
            "unattested backend must block environment writes until /api/meta succeeds"
        );

        // 3. Case-insensitive secureEnvVars matching Solid: ["TOKEN"] masks both `TOKEN` and
        // `token`, unmasking `TOKEN` clears legacy ["Token"], and deleting `token` keeps `TOKEN` masked.
        let (listener3, mut prefs3) = fixture().await;
        let backend3 = prefs3.backend.clone().unwrap();
        backend3.client.observe_atomic_settings_patches(true);
        prefs3.show_environment(true);
        assert!(prefs3.poll());
        let solid_doc = json!({
            "environmentVariables":{"TOKEN":"upper","token":"lower","É_TOKEN":"u1"},
            "secureEnvVars":["TOKEN","É_TOKEN"]
        });
        assert!(super::super::env_var_is_masked(&solid_doc, "TOKEN"));
        assert!(
            super::super::env_var_is_masked(&solid_doc, "token"),
            "Solid's case-insensitive secureEnvVars [\"TOKEN\"] must also mask `token` in Rune"
        );
        assert!(super::super::env_var_is_masked(&solid_doc, "É_TOKEN"));
        assert!(super::super::env_var_is_masked(&solid_doc, "é_TOKEN"));
        request(&listener3).await.reply(200, solid_doc).await;
        wait_until(|| {
            prefs3.poll();
            prefs3.environment_ready()
        })
        .await;
        // Unmasking & updating `token` removes case-insensitive mask entries and confirms cleanly.
        assert!(prefs3.stage_environment("token".into(), Some("public".into()), Some(false)));
        assert!(prefs3.poll());
        let unmask_sibling = poll_next_request(&mut prefs3, &listener3).await;
        assert_eq!(
            unmask_sibling.first,
            "PATCH /api/storage/config/server?conditional=atomic-v1 HTTP/1.1"
        );
        assert_eq!(
            unmask_sibling.body,
            json!({"environmentVariables":{"token":"public"},"secureEnvVarsMask":{"token":false}})
        );
        let after_unmask = json!({
            "environmentVariables":{"TOKEN":"upper","token":"public","É_TOKEN":"u1"},
            "secureEnvVars":["É_TOKEN"]
        });
        assert!(!super::super::env_var_is_masked(&after_unmask, "TOKEN"));
        assert!(!super::super::env_var_is_masked(&after_unmask, "token"));
        let orphan_mixed = json!({
            "environmentVariables":{"TOKEN":"upper","token":"lower"},
            "secureEnvVars":["Token"]
        });
        assert!(
            super::super::env_var_is_masked(&orphan_mixed, "TOKEN"),
            "mixed-case secureEnvVars entry must mask TOKEN"
        );
        unmask_sibling.reply(200, after_unmask).await;
        wait_until(|| {
            prefs3.poll();
            !prefs3.environment_pending()
        })
        .await;
        assert!(
            !prefs3.environment_failed(),
            "unmasking `token` must confirm cleanly"
        );
        assert!(prefs3.stage_environment("token".into(), None, Some(false)));
        assert!(prefs3.poll());
        let delete_sibling = poll_next_request(&mut prefs3, &listener3).await;
        assert_eq!(
            delete_sibling.first,
            "PATCH /api/storage/config/server?conditional=atomic-v1 HTTP/1.1"
        );
        assert_eq!(
            delete_sibling.body,
            json!({"environmentVariables":{"token":null},"secureEnvVarsMask":{"token":false}}),
            "atomic delete must send secureEnvVarsMask so the server handles concurrent sibling deletes"
        );
        let after_delete = json!({
            "environmentVariables":{"TOKEN":"upper"},
            "secureEnvVars":["TOKEN"]
        });
        delete_sibling.reply(200, after_delete.clone()).await;
        wait_until(|| {
            prefs3.poll();
            !prefs3.environment_pending()
        })
        .await;
        assert!(
            !prefs3.environment_failed(),
            "deleting POSIX sibling `token` while `TOKEN` remains masked must confirm cleanly"
        );
        assert!(super::super::env_var_is_masked(&after_delete, "TOKEN"));

        // Value-only edit (mask unchanged -> None) omits secureEnvVarsMask and preserves concurrent masking.
        assert!(prefs3.stage_environment("TOKEN".into(), Some("updated".into()), None));
        assert!(prefs3.poll());
        let value_only = poll_next_request(&mut prefs3, &listener3).await;
        assert_eq!(
            value_only.body,
            json!({"environmentVariables":{"TOKEN":"updated"}}),
            "value-only env edit must not send secureEnvVarsMask"
        );
        value_only
            .reply(
                200,
                json!({
                    "environmentVariables":{"TOKEN":"updated"},
                    "secureEnvVars":["TOKEN"]
                }),
            )
            .await;
        wait_until(|| {
            prefs3.poll();
            !prefs3.environment_pending()
        })
        .await;
        assert!(
            !prefs3.environment_failed(),
            "value-only env edit must confirm without overriding concurrent mask"
        );

        // 4. Out-of-order /api/meta: a stale probe advertising settings-atomic-patches arriving
        // after a newer probe without it must never re-enable atomic patches.
        let (listener4, prefs4) = fixture().await;
        let backend4 = prefs4.backend.clone().unwrap();
        let (done_old_tx, done_old_rx) = bounded(1);
        let (done_new_tx, done_new_rx) = bounded(1);
        let b_old = backend4.clone();
        platform::spawn(async move {
            let _ = done_old_tx.send(b_old.attest_server().await).await;
        });
        let req_old = request(&listener4).await;
        assert_eq!(req_old.first, "GET /api/meta HTTP/1.1");
        let b_new = backend4.clone();
        platform::spawn(async move {
            let _ = done_new_tx.send(b_new.attest_server().await).await;
        });
        let req_new = request(&listener4).await;
        assert_eq!(req_new.first, "GET /api/meta HTTP/1.1");
        req_new
            .reply(
                200,
                json!({"apiContract":1,"serverId":"seq-srv","capabilities":[]}),
            )
            .await;
        assert!(done_new_rx.recv().await.unwrap().is_ok());
        assert!(!backend4.client.supports_atomic_settings_patches());
        req_old
            .reply(
                200,
                json!({"apiContract":1,"serverId":"seq-srv","capabilities":["settings-atomic-patches"]}),
            )
            .await;
        assert!(done_old_rx.recv().await.unwrap().is_ok());
        assert!(
            !backend4.client.supports_atomic_settings_patches(),
            "stale /api/meta response must never re-enable settings-atomic-patches"
        );

        // 5. A held /api/meta response from Server A must be rejected once another probe observes
        // a different serverId (Server B) at the same address.
        let (done_a_tx, done_a_rx) = bounded(1);
        let (done_b_tx, done_b_rx) = bounded(1);
        let b_a = backend4.clone();
        platform::spawn(async move {
            let _ = done_a_tx.send(b_a.attest_server().await).await;
        });
        let req_a = request(&listener4).await;
        let b_b = backend4.clone();
        platform::spawn(async move {
            let _ = done_b_tx.send(b_b.attest_server().await).await;
        });
        let req_b = request(&listener4).await;
        req_b
            .reply(200, json!({"apiContract":1,"serverId":"other-server-b"}))
            .await;
        assert!(done_b_rx.recv().await.unwrap().is_err());
        req_a
            .reply(200, json!({"apiContract":1,"serverId":"seq-srv"}))
            .await;
        assert!(
            done_a_rx.recv().await.unwrap().is_err(),
            "held /api/meta from Server A must fail after Server B mismatch revoked attestation"
        );

        // 6. Conversely, a delayed /api/meta response from Server B started before a newer probe
        // confirmed Server A must NOT revoke Server A's newer attestation.
        let (done_stale_b_tx, done_stale_b_rx) = bounded(1);
        let (done_fresh_a_tx, done_fresh_a_rx) = bounded(1);
        let b_stale = backend4.clone();
        platform::spawn(async move {
            let _ = done_stale_b_tx.send(b_stale.attest_server().await).await;
        });
        let req_stale_b = request(&listener4).await;
        let b_fresh = backend4.clone();
        platform::spawn(async move {
            let _ = done_fresh_a_tx.send(b_fresh.attest_server().await).await;
        });
        let req_fresh_a = request(&listener4).await;
        req_fresh_a
            .reply(
                200,
                json!({"apiContract":1,"serverId":"seq-srv","capabilities":["settings-atomic-patches"]}),
            )
            .await;
        assert!(done_fresh_a_rx.recv().await.unwrap().is_ok());
        assert!(!backend4.client.needs_capability_recheck());
        assert!(backend4.client.supports_atomic_settings_patches());
        req_stale_b
            .reply(200, json!({"apiContract":1,"serverId":"other-server-b"}))
            .await;
        assert!(done_stale_b_rx.recv().await.unwrap().is_err());
        assert!(
            !backend4.client.needs_capability_recheck()
                && backend4.client.supports_atomic_settings_patches(),
            "delayed /api/meta mismatch from Server B must not revoke newer confirmed Server A"
        );
    });
}

#[test]
fn general_retry_leaves_an_advanced_refusal_in_its_section() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.set_contrast("on");
        prefs.set_advanced_toggle(Toggle::Whitespace, false);
        assert!(prefs.poll());
        let write = request(&listener).await;
        assert_eq!(
            write.body,
            json!({"settings":{"highContrast":"on","hideDiffWhitespaceChanges":false}})
        );
        write.reply(503, json!({})).await;
        let saved = json!({"settings":{"locale":"en","highContrast":"auto","hideDiffWhitespaceChanges":true}});
        request(&listener).await.reply(200, saved.clone()).await;
        wait_until(|| prefs.poll()).await;
        assert!(prefs.general_error().is_some() && prefs.advanced_failed());

        prefs.retry_general();
        assert!(prefs.poll());
        request(&listener).await.reply(200, saved.clone()).await;
        wait_until(|| prefs.poll()).await;
        let retry = request(&listener).await;
        assert_eq!(retry.body, json!({"settings":{"highContrast":"on"}}));
        let mut saved = saved;
        saved["settings"]["highContrast"] = "on".into();
        retry.reply(200, saved.clone()).await;
        wait_until(|| prefs.poll()).await;
        assert!(prefs.general_error().is_none() && prefs.advanced_failed());

        prefs.retry_advanced();
        assert!(prefs.poll());
        request(&listener).await.reply(200, saved.clone()).await;
        wait_until(|| prefs.poll()).await;
        let retry = request(&listener).await;
        assert_eq!(
            retry.body,
            json!({"settings":{"hideDiffWhitespaceChanges":false}})
        );
        saved["settings"]["hideDiffWhitespaceChanges"] = false.into();
        retry.reply(200, saved).await;
        wait_until(|| prefs.poll()).await;
        assert!(prefs.general_error().is_none() && !prefs.advanced_failed());
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}
