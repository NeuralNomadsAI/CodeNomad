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
        let mut body = req.body.clone();
        body["appearancePreferences"]["mode"] = json!("system");
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
            .save_palette_preset("  Midnight Blue  ", true, colors.clone(), None, true)
            .expect("create preset");
        let pre_create_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_create_get.first.starts_with("GET "));
        pre_create_get
            .reply(200, json!({"appearancePreferences": {"mode": "system"}}))
            .await;
        let create_req = poll_next_request(&mut prefs, &listener).await;
        assert!(create_req.first.starts_with("PATCH "));
        assert_eq!(
            create_req.body["colorSchemePresets"][&id]["name"],
            "Midnight Blue"
        );
        assert_eq!(create_req.body["activeColorSchemePresetId"], id);
        assert_eq!(
            create_req.body["appearancePreferences"]["dark"]["presetId"],
            id
        );
        let created_snapshot = json!({
            "colorSchemePresets": create_req.body["colorSchemePresets"],
            "activeColorSchemePresetId": id,
            "appearancePreferences": {
                "mode": "system",
                "dark": create_req.body["appearancePreferences"]["dark"],
            }
        });
        create_req.reply(200, created_snapshot.clone()).await;

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
        assert!(delete_req.first.starts_with("PATCH "));
        assert!(delete_req.body["colorSchemePresets"][&id].is_null());
        assert!(
            delete_req.body["appearancePreferences"].is_null(),
            "delete must only patch colorSchemePresets without clobbering concurrent slot edits: {}",
            delete_req.body
        );
        delete_req
            .reply(
                200,
                json!({
                    "colorSchemePresets": {},
                    "activeColorSchemePresetId": id,
                    "appearancePreferences": {
                        "mode": "system",
                        "dark": {
                            "scheme": { "id": "custom", "appearance": "dark", "colors": colors.to_json() },
                            "presetId": id
                        }
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
        let slot = prefs.palette_slot(true).unwrap();
        assert!(slot.preset_id.is_none());
        assert_eq!(slot.builtin_id, Some("custom"));
        assert_eq!(
            slot.colors.as_ref().unwrap().get(ColorField::SurfaceBase),
            "#101218"
        );

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
                .save_palette_preset("Overflow", true, colors, None, true)
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

        // Retrying a failed palette mutation clears the previous failure immediately and marks saving.
        let colors = ColorSchemeColors::default_custom();
        let retry_id = prefs
            .save_palette_preset(
                "Retry Preset",
                true,
                colors.clone(),
                Some("stable-id".into()),
                true,
            )
            .expect("retry preset with stable id");
        assert_eq!(retry_id, "stable-id");
        assert!(prefs.palette_saving());
        assert!(!prefs.palette_save_failed());
        let pre_retry_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_retry_get.first.starts_with("GET "));
        pre_retry_get
            .reply(200, json!({"appearancePreferences": {"mode": "system"}}))
            .await;
        let retry_patch = poll_next_request(&mut prefs, &listener).await;
        assert!(retry_patch.first.starts_with("PATCH "));
        assert!(retry_patch.body["colorSchemePresets"]["stable-id"].is_object());
        let body = retry_patch.body.clone();
        retry_patch.reply(200, body).await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!prefs.palette_save_failed());
    });
}

#[test]
fn legacy_auto_and_sibling_slot_are_preserved_when_saving_palette() {
    platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
            .await
            .unwrap();
        let mut prefs = Preferences {
            backend: Some(backend),
            ..Preferences::default()
        };
        prefs.config.snapshot = Some(json!({"settings": {"locale": "en"}}));
        // Legacy Auto profile with no appearancePreferences.mode and legacy dark Slate.
        let state_snapshot = json!({
            "colorScheme": { "id": "slate", "appearance": "dark" },
            "appearancePreferences": { "mode": "light" }
        });
        prefs.state.snapshot = Some(state_snapshot.clone());
        let colors = ColorSchemeColors::default_custom();
        assert!(
            prefs
                .save_palette_preset("Daylight", false, colors, None, true)
                .is_some()
        );
        let pre_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_get.first.starts_with("GET "));
        pre_get.reply(200, state_snapshot).await;
        let req = poll_next_request(&mut prefs, &listener).await;
        assert!(req.first.starts_with("PATCH "));
        // Sibling dark slot materialized from legacy Slate so replacing colorScheme does not lose it.
        assert_eq!(
            req.body["appearancePreferences"]["dark"]["scheme"]["id"],
            "slate"
        );
        let body = req.body.clone();
        req.reply(200, body).await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        // Legacy Auto profile (no appearancePreferences.mode, colorScheme = "system") reads fresh
        // before synthesizing mode "system", and preserves a newer mode written by another window.
        prefs.state.snapshot = Some(json!({ "colorScheme": "system" }));
        assert!(prefs.save_palette_override("mist", true, ColorSchemeColors::default_custom()));
        let pre_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_get.first.starts_with("GET "));
        pre_get.reply(200, json!({ "colorScheme": "system" })).await;
        let req = poll_next_request(&mut prefs, &listener).await;
        assert!(req.first.starts_with("PATCH "));
        assert_eq!(req.body["appearancePreferences"]["mode"], "system");
        let body = req.body.clone();
        req.reply(200, body).await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        // Legacy profile without mode: another window confirms "light" before SaveOverride sends ->
        // preflight GET sees "light" and PATCH never overwrites mode.
        prefs.state.snapshot = Some(json!({ "colorScheme": "system" }));
        assert!(prefs.save_palette_override("mist", true, ColorSchemeColors::default_custom()));
        let pre_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_get.first.starts_with("GET "));
        pre_get
            .reply(
                200,
                json!({
                    "colorScheme": "system",
                    "appearancePreferences": { "mode": "light" }
                }),
            )
            .await;
        let req = poll_next_request(&mut prefs, &listener).await;
        assert!(req.first.starts_with("PATCH "));
        assert!(
            req.body["appearancePreferences"]["mode"].is_null(),
            "SaveOverride must not overwrite a mode confirmed in another window: {}",
            req.body
        );
        let mut body = req.body.clone();
        body["appearancePreferences"]["mode"] = json!("light");
        req.reply(200, body).await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        // Explicit Choice::Mode in the same batch wins over legacy light colorScheme migration.
        let legacy_light = json!({ "colorScheme": { "id": "porcelain", "appearance": "light" } });
        prefs.state.snapshot = Some(legacy_light.clone());
        assert!(prefs.save_palette_override("mist", true, ColorSchemeColors::default_custom()));
        prefs.set_mode("dark");
        let pre_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_get.first.starts_with("GET "));
        pre_get.reply(200, legacy_light).await;
        let req = poll_next_request(&mut prefs, &listener).await;
        assert!(req.first.starts_with("PATCH "));
        assert_eq!(req.body["appearancePreferences"]["mode"], "dark");
        let body = req.body.clone();
        req.reply(200, body).await;
    });
}

#[test]
fn failed_builtin_selection_does_not_override_rendered_slot() {
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
        prefs.set_palette(mist);
        let patch = poll_next_request(&mut prefs, &listener).await;
        patch.reply(500, json!({"error": "failed"})).await;
        let get = poll_next_request(&mut prefs, &listener).await;
        get.reply(
            200,
            json!({"appearancePreferences": {"mode": "system", "dark": {"scheme": {"id": "classic"}}}}),
        )
        .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !prefs.state.choice_failed(Choice::Palette(true)) {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            prefs.palette_slot(true).unwrap().builtin_id,
            Some("classic")
        );
    });
}

#[test]
fn concurrent_delete_respects_newer_slot_and_concurrent_create_enforces_limit() {
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
        prefs.state.snapshot = Some(json!({
            "appearancePreferences": {
                "mode": "dark",
                "dark": {
                    "scheme": { "id": "custom", "appearance": "dark", "colors": colors.to_json() },
                    "presetId": "p1"
                }
            },
            "activeColorSchemePresetId": "p1",
            "colorSchemePresets": {
                "p1": { "name": "Midnight", "appearance": "dark", "colors": colors.to_json() }
            }
        }));

        // Delete queued while local snapshot shows p1 active -> PATCH only deletes p1 in
        // colorSchemePresets and never overwrites a concurrent slot switch in another window.
        assert!(prefs.delete_palette_preset("p1"));
        let delete_patch = poll_next_request(&mut prefs, &listener).await;
        assert!(delete_patch.first.starts_with("PATCH "));
        assert!(delete_patch.body["colorSchemePresets"]["p1"].is_null());
        assert!(
            delete_patch.body["appearancePreferences"].is_null(),
            "delete must not clobber newer slot selection: {}",
            delete_patch.body
        );
        delete_patch
            .reply(
                200,
                json!({
                    "appearancePreferences": {
                        "mode": "dark",
                        "dark": {
                            "scheme": { "id": "slate", "appearance": "dark", "colors": null },
                            "presetId": null
                        }
                    },
                    "activeColorSchemePresetId": null,
                    "colorSchemePresets": {}
                }),
            )
            .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!prefs.palette_save_failed());

        // Concurrent create at 49 local presets: fresh GET reveals 50 presets on server ->
        // client rejects without sending a 51st preset PATCH.
        let mut full = serde_json::Map::new();
        for i in 0..MAX_PRESETS {
            full.insert(
                format!("preset-{i}"),
                json!({ "name": format!("P{i}"), "appearance": "dark", "colors": colors.to_json() }),
            );
        }
        let mut almost_full = full.clone();
        almost_full.remove("preset-49");
        prefs.state.snapshot = Some(json!({
            "appearancePreferences": { "mode": "dark" },
            "colorSchemePresets": almost_full
        }));
        assert!(
            prefs
                .save_palette_preset("Fifty-First", true, colors, None, true)
                .is_some()
        );
        let pre_create_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_create_get.first.starts_with("GET "));
        pre_create_get
            .reply(
                200,
                json!({
                    "appearancePreferences": { "mode": "dark" },
                    "colorSchemePresets": full
                }),
            )
            .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(prefs.palette_save_failed());
    });
}

#[test]
fn legacy_system_light_scheme_infers_light_appearance_from_surface_luminance() {
    let mut prefs = Preferences::default();
    prefs.fixture();
    let light_colors = built_in()
        .iter()
        .find(|p| p.id == "porcelain")
        .unwrap()
        .colors();
    prefs.state.snapshot = Some(json!({
        "colorScheme": {
            "id": "system",
            "colors": light_colors.to_json()
        }
    }));
    assert_eq!(prefs.mode(), "light");
    let light_slot = prefs.palette_slot(false).unwrap();
    assert_eq!(light_slot.builtin_id, Some("custom"));
    assert_eq!(light_slot.colors.as_ref(), Some(&light_colors));
}

#[test]
fn legacy_inline_custom_scheme_is_materialized_and_edit_never_resurrects_deleted_preset() {
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
        let legacy_colors = ColorSchemeColors::default_custom()
            .with(ColorField::AccentPrimary, "#12AB34")
            .unwrap();
        let preset_colors = ColorSchemeColors::default_custom()
            .with(ColorField::AccentPrimary, "#FF6600")
            .unwrap();
        let initial_state = json!({
            "colorScheme": {
                "id": "custom",
                "appearance": "dark",
                "colors": legacy_colors.to_json()
            },
            "appearancePreferences": { "mode": "dark" },
            "colorSchemePresets": {
                "p1": { "name": "Amber", "appearance": "dark", "colors": preset_colors.to_json() }
            }
        });
        prefs.state.snapshot = Some(initial_state.clone());
        let options = prefs.palette_options(true);
        let preset_opt = options
            .iter()
            .find(|opt| opt.preset_id.as_deref() == Some("p1"))
            .unwrap()
            .clone();
        assert!(prefs.select_palette_option(&preset_opt, false));
        let pre_select_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_select_get.first.starts_with("GET "));
        pre_select_get.reply(200, initial_state).await;
        let patch = poll_next_request(&mut prefs, &listener).await;
        assert!(patch.first.starts_with("PATCH "));
        assert_eq!(
            patch.body["customColorScheme"]["colors"]["accentPrimary"], "#12AB34",
            "selecting a preset must materialize legacy inline customColorScheme: {}",
            patch.body
        );
        let custom_scheme = patch.body["customColorScheme"].clone();
        patch
            .reply(
                200,
                json!({
                    "appearancePreferences": {
                        "mode": "dark",
                        "dark": {
                            "scheme": { "id": "custom", "appearance": "dark", "colors": preset_colors.to_json() },
                            "presetId": "p1"
                        }
                    },
                    "activeColorSchemePresetId": "p1",
                    "customColorScheme": custom_scheme,
                    "colorSchemePresets": {
                        "p1": { "name": "Amber", "appearance": "dark", "colors": preset_colors.to_json() }
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
        assert!(!prefs.palette_save_failed());

        // Editing p1 when another window already deleted it must fail cleanly without resurrecting.
        assert!(
            prefs
                .save_palette_preset(
                    "Amber",
                    true,
                    preset_colors.clone(),
                    Some("p1".into()),
                    false
                )
                .is_some()
        );
        let pre_edit_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_edit_get.first.starts_with("GET "));
        pre_edit_get
            .reply(
                200,
                json!({
                    "appearancePreferences": { "mode": "dark" },
                    "colorSchemePresets": {}
                }),
            )
            .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(prefs.palette_save_failed());

        // A failed pre-write GET must settle palette_saving = false instead of wedging navigation.
        assert!(
            prefs
                .save_palette_preset("Fresh", true, preset_colors, None, true)
                .is_some()
        );
        let failed_get = poll_next_request(&mut prefs, &listener).await;
        assert!(failed_get.first.starts_with("GET "));
        failed_get.reply(503, json!({"error": "unavailable"})).await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(prefs.palette_save_failed());
    });
}

#[test]
fn switching_from_slot_only_custom_builtin_migrates_override_and_deleted_preset_select_rejects() {
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
        let slate = built_in().iter().find(|p| p.id == "slate").unwrap();
        let custom_mist = mist
            .colors()
            .with(ColorField::AccentPrimary, "#AA22CC")
            .unwrap();
        // Slot-only custom Mist without colorSchemeOverrides["mist"].
        let slot_only_snapshot = json!({
            "appearancePreferences": {
                "mode": "dark",
                "dark": {
                    "scheme": {
                        "id": "mist",
                        "appearance": "dark",
                        "colors": custom_mist.to_json()
                    },
                    "presetId": null
                }
            },
            "colorSchemePresets": {
                "p1": { "name": "Temp", "appearance": "dark", "colors": custom_mist.to_json() }
            }
        });
        prefs.state.snapshot = Some(slot_only_snapshot.clone());
        prefs.set_palette(slate);
        let pre_migrate_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_migrate_get.first.starts_with("GET "));
        pre_migrate_get.reply(200, slot_only_snapshot).await;
        let patch = poll_next_request(&mut prefs, &listener).await;
        assert!(patch.first.starts_with("PATCH "));
        assert_eq!(
            patch.body["colorSchemeOverrides"]["mist"]["accentPrimary"], "#AA22CC",
            "switching away from slot-only custom built-in must migrate override: {}",
            patch.body
        );
        let migrated_override = patch.body["colorSchemeOverrides"].clone();
        patch
            .reply(
                200,
                json!({
                    "appearancePreferences": {
                        "mode": "dark",
                        "dark": { "scheme": { "id": "slate", "appearance": "dark", "colors": null }, "presetId": null }
                    },
                    "colorSchemeOverrides": migrated_override,
                    "colorSchemePresets": {
                        "p1": { "name": "Temp", "appearance": "dark", "colors": custom_mist.to_json() }
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
        assert!(prefs.has_saved_override("mist"));

        // Selecting a preset deleted on server rejects cleanly after fresh GET without PATCHing.
        let p1 = prefs
            .palette_options(true)
            .into_iter()
            .find(|o| o.preset_id.as_deref() == Some("p1"))
            .unwrap();
        assert!(prefs.select_palette_option(&p1, false));
        let pre_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_get.first.starts_with("GET "));
        pre_get
            .reply(
                200,
                json!({
                    "appearancePreferences": {
                        "mode": "dark",
                        "dark": { "scheme": { "id": "slate", "appearance": "dark", "colors": null }, "presetId": null }
                    },
                    "colorSchemeOverrides": migrated_override,
                    "colorSchemePresets": {}
                }),
            )
            .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(prefs.palette_save_failed());
    });
}

#[test]
fn builtin_selection_skips_stale_override_colors_and_migrates_legacy_config_override() {
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
        let edited_mist = mist
            .colors()
            .with(ColorField::AccentPrimary, "#FF3366")
            .unwrap();

        // Local snapshot still lists an override on Mist while another window resets it.
        // Selecting Mist must send colors: null so the reset override is never resurrected.
        prefs.state.snapshot = Some(json!({
            "appearancePreferences": {
                "mode": "dark",
                "dark": { "scheme": { "id": "slate", "appearance": "dark", "colors": null }, "presetId": null }
            },
            "colorSchemeOverrides": { "mist": edited_mist.to_json() }
        }));
        let mist_option = prefs
            .palette_options(true)
            .into_iter()
            .find(|o| o.key == "builtin:mist")
            .unwrap();
        assert!(prefs.select_palette_option(&mist_option, false));
        let patch = poll_next_request(&mut prefs, &listener).await;
        assert!(patch.first.starts_with("PATCH "));
        assert_eq!(
            patch.body["appearancePreferences"]["dark"]["scheme"]["id"],
            "mist"
        );
        assert!(
            patch.body["appearancePreferences"]["dark"]["scheme"]["colors"].is_null(),
            "selecting a built-in must not embed stale override colors: {}",
            patch.body
        );
        patch
            .reply(
                200,
                json!({
                    "appearancePreferences": {
                        "mode": "dark",
                        "dark": { "scheme": { "id": "mist", "appearance": "dark", "colors": null }, "presetId": null }
                    },
                    "colorSchemeOverrides": {}
                }),
            )
            .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.state.requested(Choice::Palette(true)).is_some() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(prefs.palette_slot(true).unwrap().colors.is_none());

        // Legacy override stored only in config/ui migrates into colorSchemeOverrides even on
        // a clean built-in switch.
        prefs.config.snapshot = Some(json!({
            "settings": { "locale": "en", "highContrast": "system" },
            "colorScheme": {
                "id": "mist",
                "appearance": "dark",
                "colors": edited_mist.to_json()
            }
        }));
        let legacy_state = json!({ "appearancePreferences": { "mode": "dark" } });
        prefs.state.snapshot = Some(legacy_state.clone());
        let slate_option = prefs
            .palette_options(true)
            .into_iter()
            .find(|o| o.key == "builtin:slate")
            .unwrap();
        assert!(prefs.select_palette_option(&slate_option, false));
        let pre_migrate_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_migrate_get.first.starts_with("GET "));
        pre_migrate_get.reply(200, legacy_state).await;
        let migrate_patch = poll_next_request(&mut prefs, &listener).await;
        assert!(migrate_patch.first.starts_with("PATCH "));
        assert_eq!(
            migrate_patch.body["colorSchemeOverrides"]["mist"]["accentPrimary"], "#FF3366",
            "legacy config/ui built-in override must migrate on switch: {}",
            migrate_patch.body
        );
        assert_eq!(
            migrate_patch.body["appearancePreferences"]["dark"]["scheme"]["id"],
            "slate"
        );
        migrate_patch
            .reply(
                200,
                json!({
                    "appearancePreferences": {
                        "mode": "dark",
                        "dark": { "scheme": { "id": "slate", "appearance": "dark", "colors": null }, "presetId": null }
                    },
                    "colorSchemeOverrides": { "mist": edited_mist.to_json() }
                }),
            )
            .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(prefs.has_saved_override("mist"));

        // Switching away from a slot-only non-default custom scheme (no customColorScheme)
        // reads fresh and preserves its colors into customColorScheme so "Saved custom" does not vanish.
        let saved_custom = ColorSchemeColors::default_custom()
            .with(ColorField::AccentPrimary, "#22CCAA")
            .unwrap();
        prefs.config.snapshot = Some(json!({
            "settings": { "locale": "en", "highContrast": "system" }
        }));
        let slot_custom_state = json!({
            "appearancePreferences": {
                "mode": "dark",
                "dark": {
                    "scheme": {
                        "id": "custom",
                        "appearance": "dark",
                        "colors": saved_custom.to_json()
                    },
                    "presetId": null
                }
            }
        });
        prefs.state.snapshot = Some(slot_custom_state.clone());
        let mist_option = prefs
            .palette_options(true)
            .into_iter()
            .find(|o| o.key == "builtin:mist")
            .unwrap();
        assert!(prefs.select_palette_option(&mist_option, false));
        let pre_custom_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_custom_get.first.starts_with("GET "));
        pre_custom_get.reply(200, slot_custom_state).await;
        let custom_migrate_patch = poll_next_request(&mut prefs, &listener).await;
        assert!(custom_migrate_patch.first.starts_with("PATCH "));
        assert_eq!(
            custom_migrate_patch.body["customColorScheme"]["colors"]["accentPrimary"], "#22CCAA",
            "switching away from slot-only custom must preserve colors into customColorScheme: {}",
            custom_migrate_patch.body
        );
        let migrated_custom = custom_migrate_patch.body["customColorScheme"].clone();
        custom_migrate_patch
            .reply(
                200,
                json!({
                    "appearancePreferences": {
                        "mode": "dark",
                        "dark": { "scheme": { "id": "mist", "appearance": "dark", "colors": null }, "presetId": null }
                    },
                    "customColorScheme": migrated_custom
                }),
            )
            .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let custom_opt = prefs
            .palette_options(true)
            .into_iter()
            .find(|o| o.key == "builtin:custom")
            .expect("Saved custom must remain in options after switching to a built-in");
        assert_eq!(custom_opt.colors.get(ColorField::AccentPrimary), "#22CCAA");

        // Slot-only built-in switch reads fresh and skips migrating stale slot colors when
        // another window already saved a newer colorSchemeOverrides["mist"].
        let newer_mist = mist
            .colors()
            .with(ColorField::AccentPrimary, "#00EE77")
            .unwrap();
        prefs.state.snapshot = Some(json!({
            "appearancePreferences": {
                "mode": "dark",
                "dark": {
                    "scheme": {
                        "id": "mist",
                        "appearance": "dark",
                        "colors": edited_mist.to_json()
                    },
                    "presetId": null
                }
            }
        }));
        assert!(prefs.select_palette_option(&slate_option, false));
        let pre_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_get.first.starts_with("GET "));
        pre_get
            .reply(
                200,
                json!({
                    "appearancePreferences": {
                        "mode": "dark",
                        "dark": {
                            "scheme": {
                                "id": "mist",
                                "appearance": "dark",
                                "colors": edited_mist.to_json()
                            },
                            "presetId": null
                        }
                    },
                    "colorSchemeOverrides": { "mist": newer_mist.to_json() }
                }),
            )
            .await;
        let switch_patch = poll_next_request(&mut prefs, &listener).await;
        assert!(switch_patch.first.starts_with("PATCH "));
        assert!(
            switch_patch.body["colorSchemeOverrides"].is_null(),
            "slot-only switch must not overwrite a newer override seen in preflight GET: {}",
            switch_patch.body
        );
        switch_patch
            .reply(
                200,
                json!({
                    "appearancePreferences": {
                        "mode": "dark",
                        "dark": { "scheme": { "id": "slate", "appearance": "dark", "colors": null }, "presetId": null }
                    },
                    "colorSchemeOverrides": { "mist": newer_mist.to_json() }
                }),
            )
            .await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!prefs.palette_save_failed());
    });
}

#[test]
fn preset_edit_merges_only_locally_edited_fields_onto_live_preset() {
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
        let base = ColorSchemeColors::default_custom();
        let local_edit = base.with(ColorField::AccentPrimary, "#FF2266").unwrap();
        let remote_edit = base.with(ColorField::BorderBase, "#33AA99").unwrap();
        prefs.state.snapshot = Some(json!({
            "appearancePreferences": {
                "mode": "dark",
                "dark": {
                    "scheme": { "id": "custom", "appearance": "dark", "colors": base.to_json() },
                    "presetId": "p1"
                }
            },
            "activeColorSchemePresetId": "p1",
            "colorSchemePresets": {
                "p1": { "name": "Midnight", "appearance": "dark", "colors": base.to_json() }
            }
        }));
        assert!(
            prefs
                .save_palette_preset_fields(
                    "Midnight",
                    true,
                    local_edit,
                    Some("p1".to_owned()),
                    false,
                    Some(vec![ColorField::AccentPrimary]),
                )
                .is_some()
        );
        let pre_get = poll_next_request(&mut prefs, &listener).await;
        assert!(pre_get.first.starts_with("GET "));
        pre_get
            .reply(
                200,
                json!({
                    "appearancePreferences": {
                        "mode": "dark",
                        "dark": {
                            "scheme": { "id": "custom", "appearance": "dark", "colors": remote_edit.to_json() },
                            "presetId": "p1"
                        }
                    },
                    "activeColorSchemePresetId": "p1",
                    "colorSchemePresets": {
                        "p1": { "name": "Midnight Renamed", "appearance": "dark", "colors": remote_edit.to_json() }
                    }
                }),
            )
            .await;
        let patch = poll_next_request(&mut prefs, &listener).await;
        assert!(patch.first.starts_with("PATCH "));
        assert_eq!(
            patch.body["colorSchemePresets"]["p1"]["name"],
            "Midnight Renamed"
        );
        assert_eq!(
            patch.body["colorSchemePresets"]["p1"]["colors"]["accentPrimary"],
            "#FF2266"
        );
        assert_eq!(
            patch.body["colorSchemePresets"]["p1"]["colors"]["borderBase"], "#33AA99",
            "preset edit must keep concurrent field updates visible in preflight GET: {}",
            patch.body
        );
        let mut reply = patch.body.clone();
        reply["appearancePreferences"]["mode"] = json!("dark");
        patch.reply(200, reply).await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while prefs.palette_saving() {
            prefs.poll();
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!prefs.palette_save_failed());
    });
}
