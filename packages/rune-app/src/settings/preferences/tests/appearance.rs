use super::*;

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
