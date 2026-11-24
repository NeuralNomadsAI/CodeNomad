use super::*;
use crate::settings::transcript_preset;

#[test]
fn sweeping_filter_rows_shows_preview_then_sends_one_patch_on_release() {
    use rune::{Env, Runtime};
    platform::block_on(async {
        let (listener, prefs) = fixture().await;
        let mut s = crate::init();
        s.phase = crate::Phase::Ready;
        *s.settings.shared.borrow_mut() = prefs;
        let mut rt = Runtime::new(
            s,
            |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
            (1000.0, 800.0),
            Env::new(false, 1.0),
        );
        let settle = |rt: &mut Runtime<crate::State>| {
            for _ in 0..12 {
                rt.frame(0.02);
            }
        };
        settle(&mut rt);
        let (x, y) = rt.find("transcript-filters-trigger").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        settle(&mut rt);
        let button = |rt: &Runtime<crate::State>, parent: &str| {
            rt.elements()
                .into_iter()
                .find(|node| node.path.ends_with(&format!("{parent}/visibility")))
                .unwrap()
        };
        let point = |[x, y, w, h]: [f32; 4]| (x + w / 2.0, y + h / 2.0);
        let (x, y) = point(button(&rt, "filters-diagnosticsExpansion").rect);
        let (end_x, end_y) = point(button(&rt, "filters-toolInputsVisibility").rect);
        rt.pointer_down(x, y);
        rt.frame(0.02);
        rt.pointer_move(end_x, end_y);
        rt.frame(0.02);
        assert_eq!(
            button(&rt, "filters-diagnosticsExpansion").label.as_deref(),
            Some("Show Diagnostic")
        );
        assert!(
            !rt.state.settings.shared.borrow_mut().poll(),
            "no preference write during a drag"
        );
        rt.pointer_up(end_x, end_y);
        rt.frame(0.02);
        assert!(rt.state.settings.shared.borrow_mut().poll());
        let write = request(&listener).await;
        let expected =
            json!({"settings":{"diagnosticsExpansion":"hidden","toolInputsVisibility":"hidden"}});
        assert_eq!(write.body, expected);
        write.reply(200, expected).await;
    });
}

#[test]
fn fresh_profile_can_enable_usage_from_conversation_preferences() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        assert_eq!(prefs.usage_visibility(false), "hidden");
        prefs.set_usage_visibility("expanded");
        assert_eq!(prefs.usage_visibility(true), "expanded");
        assert_eq!(prefs.usage_visibility(false), "hidden");
        prefs.poll();
        let patch = request(&listener).await;
        assert_eq!(patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            patch.body,
            json!({"settings":{"showUsageMetrics":true,"usageMetricsExpansion":"expanded"}})
        );
        patch.reply(200, json!({"settings":{"locale":"en","showUsageMetrics":true,"usageMetricsExpansion":"expanded"}})).await;
        wait_until(|| {
            prefs.poll();
            prefs.usage_visibility(false) == "expanded"
        })
        .await;
        prefs.set_usage_visibility("hidden");
        prefs.poll();
        let patch = request(&listener).await;
        assert_eq!(patch.body, json!({"settings":{"showUsageMetrics":false}}));
        patch
            .reply(
                200,
                json!({"settings":{"showUsageMetrics":false,"usageMetricsExpansion":"expanded"}}),
            )
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.usage_visibility(false) == "hidden"
        })
        .await;
    });
}

#[test]
fn preset_and_manual_rows_share_the_authoritative_ui_queue() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.set_transcript(Some(Row::Tool("bash")), "hidden");
        prefs.set_transcript(None, "everything");
        prefs.set_transcript(Some(Row::Tool("read")), "collapsed");
        prefs.set_transcript(Some(Row::Inputs), "hidden");
        assert_eq!(prefs.transcript_mode(Row::tool("bash"), false), "expanded");
        assert_eq!(prefs.transcript_mode(Row::Inputs, true), "hidden");
        assert_eq!(prefs.transcript_preset(), "balanced");

        prefs.poll();
        let preset = request(&listener).await;
        let mut saved = transcript_preset::patch("everything");
        assert_eq!(preset.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(preset.body, json!({"settings":saved}));
        saved["locale"] = json!("en");
        preset.reply(200, json!({"settings":saved})).await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_preset() == "everything"
        })
        .await;

        let manual = request(&listener).await;
        let patch = manual.body["settings"].as_object().unwrap();
        assert_eq!(patch["toolInputsVisibility"], "hidden");
        let tools = &patch["toolCallExpansionDefaults"]["tools"];
        assert_eq!(tools["read"], "collapsed");
        assert_eq!(tools["bash"], "expanded");
        assert_eq!(tools["task"], "expanded");
        for (key, value) in patch {
            saved[key] = value.clone();
        }
        manual.reply(200, json!({"settings":saved})).await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_preset() == "custom"
        })
        .await;
        assert_eq!(prefs.transcript_mode(Row::Thinking, false), "expanded");
        assert_eq!(prefs.transcript_mode(Row::tool("read"), false), "collapsed");
        assert!(prefs.error().is_none());
    });
}
