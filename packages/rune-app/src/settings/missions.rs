use super::Preferences;
use crate::strings::t;
use rune::{El, col};
use rune_theme_codenomad::{Space, layout, layout::Layout, settings as chrome};

pub(super) fn view<S: 'static>(
    prefs: &Preferences,
    toggle: fn(&mut S, bool),
    retry: fn(&mut S),
) -> El {
    let label = t("missions.preferences.deleteSessions");
    let confirmed = prefs.mission_delete_sessions();
    let checked = prefs.mission_delete_sessions_display().unwrap_or(false);
    let disabled =
        !prefs.can_retry() || confirmed.is_none() || prefs.mission_delete_sessions_pending();
    let error = prefs.mission_delete_sessions_error().or_else(|| {
        (prefs.backend.is_none() && prefs.saved(super::preferences::Owner::Config).is_none())
            .then_some("rune.connect_error")
    });
    chrome::card(
        col()
            .full_width()
            .separate(Space::Sm)
            .children(error.map(|error| {
                layout::action_row()
                    .child(rune::text(t(error)).wrap().role("alert"))
                    .child(layout::button(
                        t("sessionList.loadError.retry"),
                        !prefs.can_retry(),
                        retry,
                    ))
            }))
            .child(chrome::setting_row(
                label,
                chrome::setting_switch(label, checked, disabled, move |s| toggle(s, !checked))
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
        for _ in 0..200 {
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
                            |p: &mut Preferences, v| p.set_mission_delete_sessions(v),
                            |p: &mut Preferences| p.retry_mission_delete_sessions(),
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
}
