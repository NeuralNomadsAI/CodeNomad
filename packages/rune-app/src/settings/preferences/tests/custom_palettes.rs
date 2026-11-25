use super::*;
use crate::settings::palettes::MAX_PRESETS;
use rune_theme_codenomad::palettes::{ColorField, ColorSchemeColors};

#[test]
fn builtin_override_save_resolves_custom_tokens_and_reset_restores_default() {
    platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
            .await
            .unwrap();
        let mut prefs = Preferences {
            backend: Some(backend),
            ..Preferences::default()
        };
        prefs.fixture();
        let mist = built_in().iter().find(|p| p.id == "mist").unwrap();
        let edited = mist
            .colors()
            .with(ColorField::AccentPrimary, "#FF3366")
            .unwrap();

        assert!(prefs.save_palette_override("mist", true, edited.clone()));
        assert!(prefs.palette_saving());
        let req = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            req.body["colorSchemeOverrides"]["mist"]["accentPrimary"],
            "#FF3366"
        );
        assert_eq!(
            req.body["appearancePreferences"]["dark"]["scheme"]["id"],
            "mist"
        );
        assert_eq!(
            req.body["appearancePreferences"]["dark"]["scheme"]["colors"]["accentPrimary"],
            "#FF3366"
        );
        assert!(req.body["activeColorSchemePresetId"].is_null());
        let body = req.body.clone();
        req.reply(200, body).await;

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!prefs.palette_save_failed());
        assert!(prefs.has_saved_override("mist"));
        let resolved = prefs.resolved_palette(true, false, false).unwrap();
        rune_theme_codenomad::palettes::with_resolved(Some(resolved), || {
            let accent = rune_theme_codenomad::kit(true).c.text_accent;
            assert!(accent.r > 0.9 && accent.g < 0.1);
        });

        assert!(prefs.reset_palette_override("mist", true));
        let reset_req = poll_next_request(&mut prefs, &listener).await;
        assert!(reset_req.body["colorSchemeOverrides"]["mist"].is_null());
        assert!(reset_req.body["appearancePreferences"]["dark"]["scheme"]["colors"].is_null());
        reset_req
            .reply(
                200,
                json!({
                    "colorSchemeOverrides": {},
                    "appearancePreferences": {
                        "mode": "system",
                        "dark": { "scheme": { "id": "mist", "appearance": "dark", "colors": null }, "presetId": null }
                    }
                }),
            )
            .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!prefs.has_saved_override("mist"));
        assert!(!prefs.palette_save_failed());
    });
}

#[test]
fn named_preset_create_delete_and_limit_follow_solid_contract() {
    platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
            .await
            .unwrap();
        let mut prefs = Preferences {
            backend: Some(backend),
            ..Preferences::default()
        };
        prefs.fixture();
        let colors = ColorSchemeColors::default_custom()
            .with(ColorField::SurfaceBase, "#101218")
            .unwrap();

        let id = prefs
            .save_palette_preset("  Midnight Blue  ", true, colors.clone(), None)
            .expect("create preset");
        let create_req = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            create_req.body["colorSchemePresets"][&id]["name"],
            "Midnight Blue"
        );
        assert_eq!(create_req.body["activeColorSchemePresetId"], id);
        assert_eq!(
            create_req.body["appearancePreferences"]["dark"]["presetId"],
            id
        );
        let body = create_req.body.clone();
        create_req.reply(200, body).await;

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(prefs.preset_count(), 1);
        assert_eq!(
            prefs.palette_slot(true).unwrap().preset_id.as_deref(),
            Some(id.as_str())
        );

        assert!(prefs.delete_palette_preset(&id));
        let delete_req = poll_next_request(&mut prefs, &listener).await;
        assert!(delete_req.body["colorSchemePresets"][&id].is_null());
        assert!(delete_req.body["activeColorSchemePresetId"].is_null());
        assert!(delete_req.body["appearancePreferences"]["dark"]["presetId"].is_null());
        delete_req
            .reply(
                200,
                json!({
                    "colorSchemePresets": {},
                    "activeColorSchemePresetId": null,
                    "appearancePreferences": {
                        "mode": "system",
                        "dark": { "scheme": { "id": "mist", "appearance": "dark", "colors": null }, "presetId": null }
                    }
                }),
            )
            .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(prefs.preset_count(), 0);
        assert!(prefs.palette_slot(true).unwrap().preset_id.is_none());

        // Reaching MAX_PRESETS refuses creating another preset.
        let mut full = serde_json::Map::new();
        for i in 0..MAX_PRESETS {
            full.insert(
                format!("preset-{i}"),
                json!({ "name": format!("P{i}"), "appearance": "dark", "colors": colors.to_json() }),
            );
        }
        prefs.state.snapshot = Some(json!({
            "appearancePreferences": { "mode": "dark" },
            "colorSchemePresets": full
        }));
        assert!(
            prefs
                .save_palette_preset("Overflow", true, colors, None)
                .is_none()
        );
    });
}

#[test]
fn palette_mutation_failure_surfaces_dedicated_error_without_generic_toast() {
    platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
            .await
            .unwrap();
        let mut prefs = Preferences {
            backend: Some(backend),
            ..Preferences::default()
        };
        prefs.fixture();
        let colors = ColorSchemeColors::default_custom();
        assert!(prefs.save_palette_override("classic", true, colors));
        let patch = poll_next_request(&mut prefs, &listener).await;
        patch.reply(500, json!({"error": "disk full"})).await;
        // Fallback reconciliation GET also reflects unchanged snapshot.
        let get = poll_next_request(&mut prefs, &listener).await;
        get.reply(
            200,
            json!({"appearancePreferences": {"mode": "system", "dark": {"scheme": {"id": "classic"}}}}),
        )
        .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(prefs.palette_save_failed());
        assert!(!prefs.take_notification_failure());
    });
}
