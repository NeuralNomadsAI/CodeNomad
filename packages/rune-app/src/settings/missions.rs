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
    chrome::card(
        col()
            .full_width()
            .separate(Space::Sm)
            .children(prefs.mission_delete_sessions_failed().then(|| {
                layout::action_row()
                    .child(rune::text(t("settings.preferenceSaveFailed")).role("alert"))
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
}
