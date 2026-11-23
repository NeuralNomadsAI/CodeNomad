use super::*;
use crate::settings::transcript_preset;

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
