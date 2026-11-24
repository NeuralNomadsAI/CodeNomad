use super::Preferences;
use crate::strings::t;
use rune::{El, col};
use rune_theme_codenomad::{Space, layout, layout::Layout, settings as chrome};

pub(super) fn view<S: 'static>(
    prefs: &Preferences,
    toggle: fn(&mut S, Option<&str>, bool),
    retry: fn(&mut S, Option<&str>),
) -> El {
    let label = t("missions.preferences.deleteSessions");
    let checked = prefs.mission_delete_sessions_display().unwrap_or(false);
    let disabled = !prefs.mission_delete_sessions_editable();
    let owner = prefs.backend.as_ref().map(|b| b.client_id.clone());
    let retry_owner = owner.clone();
    let error = prefs.mission_delete_sessions_error().or_else(|| {
        (prefs.backend.is_none() && prefs.saved(super::preferences::Owner::Config).is_none())
            .then_some("rune.connect_error")
    });
    chrome::card(
        col()
            .full_width()
            .separate(Space::Sm)
            .children(error.map(|error| {
                let retry_owner = retry_owner.clone();
                layout::action_row()
                    .child(rune::text(t(error)).wrap().role("alert"))
                    .child(layout::button(
                        t("sessionList.loadError.retry"),
                        !prefs.can_retry(),
                        move |s: &mut S| retry(s, retry_owner.as_deref()),
                    ))
            }))
            .child(chrome::setting_row(
                label,
                chrome::setting_switch(label, checked, disabled, move |s| {
                    toggle(s, owner.as_deref(), !checked)
                })
                .key("missions-delete-sessions"),
            )),
    )
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::files::test_http::Http;
    use crate::platform;
    use codenomad_client::settings::Owner;
    use serde_json::json;
    use std::time::Duration;

    async fn wait_until(mut ready: impl FnMut() -> bool) {
        for _ in 0..500 {
            if ready() {
                return;
            }
            platform::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for preference state");
    }

    #[test]
    fn mission_delete_sessions_requires_confirmed_config_and_persists_toggle() {
        platform::block_on(async {
            let http = Http::new().await;
            let mut prefs = Preferences::default();
            prefs.bind(Some(http.backend.clone()));

            // Initial config & state reads (and optional watch stream).
            let mut got_config = false;
            let mut got_state = false;
            while !(got_config && got_state) {
                prefs.poll();
                let req = http.accept().await;
                if req.header.contains("/api/storage/config/ui") {
                    req.reply(200, json!({"settings": {"missionDeleteSessions": true}}))
                        .await;
                    got_config = true;
                } else if req.header.contains("/api/storage/state") {
                    req.reply(200, json!({})).await;
                    got_state = true;
                } else {
                    req.reply(404, json!({})).await;
                }
            }
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions() == Some(true)
            })
            .await;

            // Invalidating config must immediately withhold the stale true value.
            prefs.invalidate(Owner::Config);
            assert_eq!(prefs.mission_delete_sessions(), None);
            prefs.poll();
            let refresh = http.accept().await;
            assert!(refresh.header.contains("/api/storage/config/ui"));
            assert_eq!(prefs.mission_delete_sessions(), None);
            refresh
                .reply(200, json!({"settings": {"missionDeleteSessions": false}}))
                .await;
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions() == Some(false)
            })
            .await;

            // Toggling from Settings patches config/ui and confirms the new value.
            prefs.set_mission_delete_sessions(true);
            prefs.poll();
            let patch = http.accept().await;
            assert!(patch.header.starts_with("PATCH /api/storage/config/ui"));
            assert_eq!(
                patch.body,
                json!({"settings": {"missionDeleteSessions": true}})
            );
            patch
                .reply(200, json!({"settings": {"missionDeleteSessions": true}}))
                .await;
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions() == Some(true)
            })
            .await;
        });
    }

    #[test]
    fn missions_preferences_shows_error_and_retry_when_initial_config_read_fails() {
        use rune::{Env, Runtime};
        platform::block_on(async {
            let http = Http::new().await;
            let mut prefs = Preferences::default();
            prefs.bind(Some(http.backend.clone()));

            // Fail initial config read with 503 while state succeeds.
            let (mut got_config, mut got_state) = (false, false);
            while !(got_config && got_state) {
                prefs.poll();
                let req = http.accept().await;
                if req.header.contains("/api/storage/config/ui") {
                    req.reply(503, json!({})).await;
                    got_config = true;
                } else {
                    req.reply(200, json!({})).await;
                    got_state = true;
                }
            }
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions_error() == Some("rune.connect_error")
            })
            .await;

            // Render Missions Preferences: switch must be disabled and alert + Retry visible.
            let mut rt = Runtime::new(
                prefs,
                |prefs, _| {
                    crate::strings::with_locale("en", || {
                        view(
                            prefs,
                            |p: &mut Preferences, owner, v| {
                                if owner.is_some()
                                    && p.backend.as_ref().map(|b| b.client_id.as_str()) == owner
                                {
                                    p.set_mission_delete_sessions(v);
                                }
                            },
                            |p: &mut Preferences, owner| {
                                if p.backend.as_ref().map(|b| b.client_id.as_str()) == owner {
                                    p.retry_mission_delete_sessions();
                                }
                            },
                        )
                    })
                },
                (500.0, 300.0),
                Env::new(false, 1.0),
            );
            rt.frame(1.0 / 60.0);
            let tree = rt.accessibility_json();
            let text = tree.to_string();
            assert!(text.contains("alert"));
            assert!(text.contains("Retry"));
            assert_eq!(rt.state.mission_delete_sessions(), None);

            // Retry recovers the preference and clears the error.
            rt.state.retry_mission_delete_sessions();
            rt.state.poll();
            let retry_req = http.accept().await;
            assert!(retry_req.header.contains("/api/storage/config/ui"));
            retry_req
                .reply(200, json!({"settings": {"missionDeleteSessions": true}}))
                .await;
            wait_until(|| {
                rt.state.poll();
                rt.state.mission_delete_sessions() == Some(true)
            })
            .await;
            assert_eq!(rt.state.mission_delete_sessions_error(), None);
        });
    }

    #[test]
    fn mission_delete_sessions_change_wakes_main_panel_display() {
        let mut root = crate::init();
        root.settings.shared.borrow_mut().fixture();
        // Establish baseline display snapshot.
        let _ = crate::settings::poll(&mut root);
        let rev_before = root.revision;
        assert!(
            !crate::settings::poll(&mut root),
            "idle poll without preference changes returns false"
        );
        // Simulate a confirmed preference save toggling only missionDeleteSessions.
        {
            let mut prefs = root.settings.shared.borrow_mut();
            prefs.fixture_mission_delete_sessions(true);
        }
        assert!(
            crate::settings::poll(&mut root),
            "changing only missionDeleteSessions must wake the main window display"
        );
        assert!(root.revision > rev_before);
    }

    #[test]
    fn sse_disconnect_revokes_cached_mission_delete_sessions_until_revalidated() {
        platform::block_on(async {
            let http = Http::new().await;
            let mut prefs = Preferences::default();
            prefs.bind(Some(http.backend.clone()));

            let (mut got_config, mut got_state) = (false, false);
            while !(got_config && got_state) {
                prefs.poll();
                let req = http.accept().await;
                if req.header.contains("/api/storage/config/ui") {
                    req.reply(200, json!({"settings": {"missionDeleteSessions": true}}))
                        .await;
                    got_config = true;
                } else {
                    req.reply(200, json!({})).await;
                    got_state = true;
                }
            }
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions() == Some(true)
            })
            .await;

            // SSE disconnects: stale `true` must be withheld immediately.
            prefs.set_stream_online(false);
            assert_eq!(prefs.mission_delete_sessions(), None);

            // SSE reconnects: preference stays withheld until fresh GET settles with `false`.
            prefs.set_stream_online(true);
            assert_eq!(prefs.mission_delete_sessions(), None);
            prefs.poll();
            let refresh = http.accept().await;
            assert!(refresh.header.contains("/api/storage/config/ui"));
            refresh
                .reply(200, json!({"settings": {"missionDeleteSessions": false}}))
                .await;
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions() == Some(false)
            })
            .await;
        });
    }

    #[test]
    fn staging_mission_delete_sessions_immediately_withholds_stale_value_before_poll() {
        let mut prefs = Preferences::default();
        prefs.fixture();
        prefs.fixture_mission_delete_sessions(true);
        prefs.backend =
            Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:1/").unwrap());
        assert_eq!(prefs.mission_delete_sessions(), Some(true));
        prefs.set_mission_delete_sessions(false);
        assert_eq!(
            prefs.mission_delete_sessions(),
            None,
            "staging a toggle must immediately withhold the stale confirmed value before poll()"
        );
    }

    #[test]
    fn watch_project_handoff_revokes_cached_delete_preference_until_replacement_opens() {
        platform::block_on(async {
            let http = Http::new().await;
            let mut prefs = Preferences::default();
            prefs.bind(Some(http.backend.clone()));

            let (mut got_config, mut got_state) = (false, false);
            while !(got_config && got_state) {
                prefs.poll();
                let req = http.accept().await;
                if req.header.contains("/api/storage/config/ui") {
                    req.reply(200, json!({"settings": {"missionDeleteSessions": true}}))
                        .await;
                    got_config = true;
                } else if req.header.contains("/api/storage/state") {
                    req.reply(200, json!({})).await;
                    got_state = true;
                } else {
                    req.reply(404, json!({})).await;
                }
            }
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions() == Some(true)
            })
            .await;

            // Start a project watch handoff without letting the replacement SSE open yet.
            let wake: rune::Waker = std::sync::Arc::new(|| {});
            prefs.watch_project(Some("ws-1"), &wake);
            assert_eq!(
                prefs.mission_delete_sessions(),
                None,
                "handoff to an unopened replacement watch must immediately revoke the stale true cache"
            );
            // Even if the replacement watch is still waiting to open, poll() must not re-arm the old cache.
            prefs.poll();
            assert_eq!(prefs.mission_delete_sessions(), None);
            prefs.unwatch();
        });
    }

    #[test]
    fn stop_before_conversation_revokes_mission_delete_sessions_even_if_get_returns_true() {
        platform::block_on(async {
            let http = Http::new().await;
            let mut prefs = Preferences::default();
            prefs.bind(Some(http.backend.clone()));

            let (mut got_config, mut got_state) = (false, false);
            while !(got_config && got_state) {
                prefs.poll();
                let req = http.accept().await;
                if req.header.contains("/api/storage/config/ui") {
                    req.reply(200, json!({"settings": {"missionDeleteSessions": true}}))
                        .await;
                    got_config = true;
                } else if req.header.contains("/api/storage/state") {
                    req.reply(200, json!({})).await;
                    got_state = true;
                } else {
                    req.reply(404, json!({})).await;
                }
            }
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions() == Some(true)
            })
            .await;

            // Handoff to a conversation SSE marks the preference stream offline immediately.
            let _ = prefs.stop_before_conversation();
            prefs.invalidate(Owner::Config);
            assert!(prefs.stream_offline());
            assert_eq!(prefs.mission_delete_sessions(), None);
            // Even if a queued config GET completes with `true` during the observation gap,
            // `mission_delete_sessions()` must stay withheld until the replacement SSE opens.
            prefs.poll();
            let req = http.accept().await;
            assert!(req.header.contains("/api/storage/config/ui"));
            req.reply(200, json!({"settings": {"missionDeleteSessions": true}}))
                .await;
            wait_until(|| {
                prefs.poll();
                prefs
                    .saved(Owner::Config)
                    .and_then(|doc| doc["settings"]["missionDeleteSessions"].as_bool())
                    == Some(true)
            })
            .await;
            assert_eq!(
                prefs.mission_delete_sessions(),
                None,
                "config GET during SSE handoff gap must not re-enable missionDeleteSessions"
            );
        });
    }

    #[test]
    fn opencode_outage_keeps_delete_sessions_preference_editable_while_blocking_delete() {
        use rune::{Env, Runtime};

        platform::block_on(async {
            let http = Http::new().await;
            let mut prefs = Preferences::default();
            prefs.bind(Some(http.backend.clone()));

            let (mut got_config, mut got_state) = (false, false);
            while !(got_config && got_state) {
                prefs.poll();
                let req = http.accept().await;
                if req.header.contains("/api/storage/config/ui") {
                    req.reply(200, json!({"settings": {"missionDeleteSessions": true}}))
                        .await;
                    got_config = true;
                } else {
                    req.reply(200, json!({})).await;
                    got_state = true;
                }
            }
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions() == Some(true)
            })
            .await;

            // Upstream OpenCode disconnects while CodeNomad remains authenticated and config loaded.
            prefs.set_stream_online(false);
            // Destructive mission deletion stays blocked:
            assert_eq!(prefs.mission_delete_sessions(), None);
            // Preferences -> Missions switch stays editable!
            assert!(prefs.mission_delete_sessions_editable());

            let mut rt = Runtime::new(
                prefs,
                |prefs, _| {
                    crate::strings::with_locale("en", || {
                        view(
                            prefs,
                            |p: &mut Preferences, owner, v| {
                                if owner.is_some()
                                    && p.backend.as_ref().map(|b| b.client_id.as_str()) == owner
                                {
                                    p.set_mission_delete_sessions(v);
                                }
                            },
                            |p: &mut Preferences, owner| {
                                if p.backend.as_ref().map(|b| b.client_id.as_str()) == owner {
                                    p.retry_mission_delete_sessions();
                                }
                            },
                        )
                    })
                },
                (500.0, 300.0),
                Env::new(false, 1.0),
            );
            rt.frame(1.0 / 60.0);
            let tree = rt.accessibility_json();
            fn switch_disabled(node: &serde_json::Value) -> Option<bool> {
                if node["key"].as_str() == Some("missions-delete-sessions") {
                    return Some(
                        node["states"]
                            .as_array()
                            .is_some_and(|s| s.contains(&serde_json::Value::from("disabled"))),
                    );
                }
                node["children"]
                    .as_array()
                    .and_then(|c| c.iter().find_map(switch_disabled))
            }
            assert_eq!(
                switch_disabled(&tree),
                Some(false),
                "Preferences -> Missions switch must stay editable during an OpenCode outage"
            );

            // Actually toggling the switch during the OpenCode outage must stage and PATCH
            // the host config, keep mission_delete_sessions() withheld while offline, and
            // persist the new value after reconnect.
            rt.state.set_mission_delete_sessions(false);
            rt.state.poll();
            let req = http.accept().await;
            assert!(
                req.header.starts_with("PATCH /api/storage/config/ui "),
                "unexpected request during outage toggle: {}",
                req.header
            );
            assert_eq!(req.body["settings"]["missionDeleteSessions"], json!(false));
            req.reply(200, json!({"settings": {"missionDeleteSessions": false}}))
                .await;
            wait_until(|| {
                rt.state.poll();
                !rt.state.mission_delete_sessions_pending()
                    && rt.state.mission_delete_sessions_display() == Some(false)
            })
            .await;
            assert_eq!(
                rt.state.mission_delete_sessions(),
                None,
                "destructive deletion authority must stay withheld while OpenCode is offline"
            );

            // Reconnect OpenCode: revalidation GET confirms the persisted false value.
            rt.state.set_stream_online(true);
            rt.state.poll();
            loop {
                let req = http.accept().await;
                if req.header.starts_with("GET /api/storage/config/ui") {
                    req.reply(200, json!({"settings": {"missionDeleteSessions": false}}))
                        .await;
                    break;
                }
                req.reply(200, json!({})).await;
            }
            wait_until(|| {
                rt.state.poll();
                rt.state.mission_delete_sessions() == Some(false)
            })
            .await;
        });
    }

    #[test]
    fn refused_mission_delete_sessions_patch_retains_confirmed_saved_value_for_delete() {
        platform::block_on(async {
            let http = Http::new().await;
            let mut prefs = Preferences::default();
            prefs.bind(Some(http.backend.clone()));

            let (mut got_config, mut got_state) = (false, false);
            while !(got_config && got_state) {
                prefs.poll();
                let req = http.accept().await;
                if req.header.contains("/api/storage/config/ui") {
                    req.reply(200, json!({"settings": {"missionDeleteSessions": false}}))
                        .await;
                    got_config = true;
                } else {
                    req.reply(200, json!({})).await;
                    got_state = true;
                }
            }
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions() == Some(false)
            })
            .await;

            // User toggles to true; PATCH is refused (500) and automatic readback confirms false.
            prefs.set_mission_delete_sessions(true);
            assert_eq!(
                prefs.mission_delete_sessions(),
                None,
                "preference must be withheld while PATCH/readback is in flight"
            );
            prefs.poll();
            let patch = http.accept().await;
            assert!(patch.header.starts_with("PATCH /api/storage/config/ui "));
            patch.reply(500, json!({"error": "refused"})).await;
            let readback = http.accept().await;
            assert!(
                readback.header.starts_with("GET /api/storage/config/ui"),
                "unexpected readback header: {}",
                readback.header
            );
            readback
                .reply(200, json!({"settings": {"missionDeleteSessions": false}}))
                .await;

            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions_failed()
            })
            .await;
            assert_eq!(
                prefs.mission_delete_sessions(),
                Some(false),
                "once readback confirms saved false after a refused PATCH, Delete must remain available with false"
            );
            assert_eq!(prefs.mission_delete_sessions_display(), Some(false));
            assert_eq!(
                prefs.mission_delete_sessions_error(),
                Some("settings.preferenceSaveFailed")
            );
            // No automatic PATCH replay may occur.
            http.quiet().await;
        });
    }

    #[test]
    fn mission_delete_sessions_401_triggers_auth_recovery_without_readback() {
        platform::block_on(async {
            let http = Http::new().await;
            let mut prefs = Preferences::default();
            prefs.bind(Some(http.backend.clone()));

            let (mut got_config, mut got_state) = (false, false);
            while !(got_config && got_state) {
                prefs.poll();
                let req = http.accept().await;
                if req.header.contains("/api/storage/config/ui") {
                    req.reply(200, json!({"settings": {"missionDeleteSessions": false}}))
                        .await;
                    got_config = true;
                } else {
                    req.reply(200, json!({})).await;
                    got_state = true;
                }
            }
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions() == Some(false)
            })
            .await;

            prefs.set_mission_delete_sessions(true);
            prefs.poll();
            let patch = http.accept().await;
            assert!(patch.header.starts_with("PATCH /api/storage/config/ui "));
            patch.reply(401, json!({"error": "unauthorized"})).await;
            let probe = http.accept().await;
            assert!(
                probe.header.starts_with("GET /api/auth/status"),
                "expected auth status probe after 401, got: {}",
                probe.header
            );
            probe.reply(200, json!({"authenticated": false})).await;

            wait_until(|| {
                prefs.poll();
                prefs.take_document_auth_expired().is_some()
            })
            .await;
            assert!(!prefs.can_retry());
            // Must NOT issue a readback GET after confirmed 401.
            http.quiet().await;
        });
    }

    #[test]
    fn stale_barrier_401_does_not_expire_new_connection_and_dual_401_drains_both() {
        platform::block_on(async {
            let http = Http::new().await;
            let mut prefs = Preferences::default();
            prefs.bind(Some(http.backend.clone()));

            // Both config and state return 401 in the same poll; both flags must drain without
            // surviving into a fresh rebind.
            prefs.poll();
            let r1 = http.accept().await;
            let r2 = http.accept().await;
            r1.reply(401, json!({"error": "unauthorized"})).await;
            r2.reply(401, json!({"error": "unauthorized"})).await;
            // Two auth status probes follow.
            let p1 = http.accept().await;
            let p2 = http.accept().await;
            p1.reply(200, json!({"authenticated": false})).await;
            p2.reply(200, json!({"authenticated": false})).await;
            // Give both background tasks a moment to deliver AuthExpired into their channels so
            // both land before a single poll.
            platform::sleep(Duration::from_millis(50)).await;
            prefs.poll();
            assert!(prefs.take_document_auth_expired().is_some());
            assert!(!prefs.can_retry());

            // Rebind to a fresh backend on the same address: no stale auth_expired
            // may survive from the second document.
            let fresh =
                codenomad_client::backend::Backend::unauthenticated(&http.backend.base).unwrap();
            prefs.bind(Some(fresh.clone()));
            assert!(prefs.can_retry());
            let (mut got_config, mut got_state) = (false, false);
            while !(got_config && got_state) {
                prefs.poll();
                let req = http.accept().await;
                if req.header.contains("/api/storage/config/ui") {
                    req.reply(200, json!({"settings": {"missionDeleteSessions": false}}))
                        .await;
                    got_config = true;
                } else {
                    req.reply(200, json!({})).await;
                    got_state = true;
                }
            }
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions() == Some(false)
            })
            .await;

            // Start a write on `fresh`, then rebind to `newer` while the write is in flight so
            // it becomes a `barrier` flight. A 401 from that old-connection barrier must NOT
            // expire `newer`.
            prefs.set_mission_delete_sessions(true);
            prefs.poll();
            let old_patch = http.accept().await;
            assert!(
                old_patch
                    .header
                    .starts_with("PATCH /api/storage/config/ui ")
            );

            let newer =
                codenomad_client::backend::Backend::unauthenticated(&http.backend.base).unwrap();
            prefs.bind(Some(newer));
            assert!(prefs.can_retry());

            // Now fail the old barrier write with 401 + auth probe unauthenticated.
            old_patch
                .reply(401, json!({"error": "old-cookie-expired"}))
                .await;
            let old_probe = http.accept().await;
            assert!(old_probe.header.starts_with("GET /api/auth/status"));
            old_probe.reply(200, json!({"authenticated": false})).await;

            // Poll through barrier settlement + new connection reattach reads; auth must stay live!
            let (mut new_config, mut new_state) = (false, false);
            while !(new_config && new_state) {
                prefs.poll();
                assert!(
                    prefs.take_document_auth_expired().is_none(),
                    "401 from an old barrier connection must never expire the new connection"
                );
                assert!(prefs.can_retry());
                if let Ok(req) =
                    tokio::time::timeout(Duration::from_millis(20), http.accept()).await
                {
                    if req.header.contains("/api/storage/config/ui") {
                        req.reply(200, json!({"settings": {"missionDeleteSessions": false}}))
                            .await;
                        new_config = true;
                    } else if req.header.contains("/api/storage/state") {
                        req.reply(200, json!({})).await;
                        new_state = true;
                    }
                }
            }
            wait_until(|| {
                prefs.poll();
                prefs.mission_delete_sessions() == Some(false)
            })
            .await;
            assert!(prefs.take_document_auth_expired().is_none());
            assert!(prefs.can_retry());
        });
    }
}
