use super::*;

#[test]
fn contrast_applies_immediately_and_reconciles_an_unconfirmed_write() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        assert_eq!(prefs.contrast(), "auto");
        prefs.set_contrast("on");
        assert_eq!(prefs.contrast(), "on");
        prefs.poll();
        let write = request(&listener).await;
        assert_eq!(write.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(write.body, json!({"settings":{"highContrast":"on"}}));
        write.reply(503, json!({})).await;
        let read = request(&listener).await;
        assert!(
            read.first
                .starts_with("GET /api/storage/config/ui?authoritative=1 ")
        );
        read.reply(
            200,
            json!({"settings":{"locale":"en","highContrast":"off"}}),
        )
        .await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(prefs.contrast(), "off");
        assert_eq!(
            prefs.error(),
            Some("settings.appearance.contrast.saveError")
        );
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn settings_mode_patch_leaves_defaults_and_legacy_slots_alone() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.config = Document::default();
        prefs.state = Document::default();
        prefs.state.snapshot = Some(json!({}));
        assert!(!prefs.palette_ready());
        prefs.set_mode("light");
        assert_eq!(
            prefs.state.requested(Choice::Mode),
            Some("light"),
            "state-only mode can save"
        );
        prefs.state = Document::default();
        prefs.state.snapshot = Some(json!({}));
        prefs.config.invalidate();
        prefs.poll();
        request(&listener).await.reply(503, json!({})).await;
        wait_until(|| {
            prefs.poll();
            prefs.config.read_failed()
        })
        .await;
        assert!(
            prefs.palette_ready(),
            "unreadable configuration does not disable appearance"
        );
        assert!(!prefs.locale_ready());
        prefs.config.snapshot = Some(json!({"theme":"dark","settings":{"locale":"de-DE"}}));
        assert_eq!(prefs.locale(), Some("de"));
        assert_eq!(prefs.palette(true).map(|p| p.id), Some("classic"));
        prefs.set_mode("light");
        assert_eq!(prefs.state.requested(Choice::Mode), Some("light"));
        prefs.state.snapshot = Some(
            json!({"appearancePreferences":{"mode":"light","dark":{"scheme":{"id":"basalt"}}}}),
        );
        assert_eq!(prefs.mode(), "light");
        assert_eq!(
            prefs.palette(true).map(|p| p.id),
            Some("basalt"),
            "concurrent explicit palette takes precedence"
        );
        prefs.config.snapshot = Some(json!({}));
        prefs.state.snapshot = Some(json!({"appearancePreferences":{"mode":"dark"}}));
        assert_eq!(prefs.palette(true).map(|p| p.id), Some("mist"));
    });
}

#[test]
fn settings_palette_changes_remain_available_and_coalesce_during_an_in_flight_write() {
    platform::block_on(async {
        let mut prefs = Preferences {
            backend: Some(Backend::connect("http://127.0.0.1:9/", "").await.unwrap()),
            ..Preferences::default()
        };
        prefs.fixture();
        let select = |prefs: &mut Preferences, id| {
            prefs.set_palette(built_in().iter().find(|palette| palette.id == id).unwrap());
        };
        select(&mut prefs, "slate");
        assert!(prefs.poll());
        select(&mut prefs, "fjord");
        select(&mut prefs, "basalt");
        assert_eq!(prefs.palette_display(true).map(|p| p.id), Some("basalt"));
        assert_eq!(prefs.palette(true).map(|p| p.id), Some("classic"));
        assert_eq!(prefs.state.requested(Choice::Palette(true)), Some("basalt"));
    });
}

#[test]
fn settings_mode_write_fences_palette_until_the_new_color_slot_is_known() {
    platform::block_on(async {
        let mut prefs = Preferences {
            backend: Some(Backend::connect("http://127.0.0.1:9/", "").await.unwrap()),
            ..Preferences::default()
        };
        prefs.fixture();
        let linen = built_in()
            .iter()
            .find(|palette| palette.id == "linen")
            .unwrap();
        prefs.set_mode("dark");
        assert!(!prefs.palette_ready());
        prefs.set_palette(linen);
        assert_eq!(prefs.state.requested(Choice::Mode), Some("dark"));
        assert_eq!(prefs.state.requested(Choice::Palette(false)), None);
        assert!(prefs.poll());
        prefs.set_palette(linen);
        assert_eq!(prefs.state.requested(Choice::Palette(false)), None);
    });
}

#[test]
fn first_paint_waits_for_both_appearance_owners() {
    platform::block_on(async {
        let (listener, mut fixture) = fixture().await;
        let mut root = crate::init();
        let (_events, incoming) = bounded(4);
        root.incoming = Some(incoming);
        let mut rt = rune::Runtime::new(
            root,
            crate::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        assert!(
            rt.find("open-preferences").is_none(),
            "no themed shell before direct startup connects"
        );
        rt.update(|s, _| {
            super::super::super::connected(s, &fixture.backend.take().unwrap());
            super::super::super::poll(s);
        });
        let first = request(&listener).await;
        let second = request(&listener).await;
        let (config, state) = if first.first.contains("/config/") {
            (first, second)
        } else {
            (second, first)
        };
        config
            .reply(200, json!({"settings":{"locale":"en","highContrast":"on"}}))
            .await;
        wait_until(|| {
            rt.update(|s, _| {
                super::super::super::poll(s);
            });
            rt.state
                .settings
                .shared
                .borrow()
                .saved(Owner::Config)
                .is_some()
        })
        .await;
        rt.frame(0.02);
        assert!(
            rt.find("open-preferences").is_none(),
            "config alone cannot choose the initial palette"
        );
        state
            .reply(
                200,
                json!({"appearancePreferences":{"mode":"dark","dark":{"scheme":{"id":"classic"}}}}),
            )
            .await;
        wait_until(|| {
            rt.update(|s, _| {
                super::super::super::poll(s);
            });
            rt.frame(0.02);
            rt.find("open-preferences").is_some()
        })
        .await;
        let prefs = rt.state.settings.shared.borrow();
        assert_eq!(prefs.contrast(), "on");
        assert_eq!(prefs.mode(), "dark");
        assert_eq!(prefs.palette(true).unwrap().id, "classic");
    });
}

#[test]
fn failed_contrast_write_cannot_mask_the_next_gesture_even_after_reselecting() {
    platform::block_on(async {
        for reselect in [false, true] {
            let (listener, mut prefs) = fixture().await;
            prefs.set_contrast("on");
            prefs.poll();
            let old = request(&listener).await;
            assert_eq!(old.body["settings"]["highContrast"], "on");
            prefs.set_contrast("off");
            if reselect {
                prefs.set_contrast("on");
            }
            let newest = if reselect { "on" } else { "off" };
            old.reply(503, json!({})).await;
            let readback = request(&listener).await;
            assert!(
                readback
                    .first
                    .starts_with("GET /api/storage/config/ui?authoritative=1 ")
            );
            readback
                .reply(
                    200,
                    json!({"settings":{"locale":"en","highContrast":"auto"}}),
                )
                .await;
            wait_until(|| prefs.poll()).await;
            assert_eq!(prefs.contrast(), newest);
            assert!(!prefs.contrast_failed());
            let new = request(&listener).await;
            assert_eq!(new.body["settings"]["highContrast"], newest);
            new.reply(
                200,
                json!({"settings":{"locale":"en","highContrast":newest}}),
            )
            .await;
            wait_until(|| prefs.poll()).await;
            assert_eq!(prefs.contrast(), newest);
            assert!(!prefs.contrast_failed());
        }
    });
}
