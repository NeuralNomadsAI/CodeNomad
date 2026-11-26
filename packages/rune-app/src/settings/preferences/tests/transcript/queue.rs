use super::super::*;
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
        let pre = request(&listener).await;
        assert_eq!(
            pre.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        pre.reply(
            200,
            json!({"settings":{"locale":"en","showUsageMetrics":true,"usageMetricsExpansion":"expanded"}}),
        )
        .await;
        let patch = poll_next_request(&mut prefs, &listener).await;
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
        let (listener, mut prefs) = fixture_atomic().await;
        prefs.set_transcript(Some(Row::Tool("bash")), "hidden");
        prefs.poll();
        let first = request(&listener).await;
        assert_eq!(
            first.first,
            "PATCH /api/storage/config/ui?conditional=atomic-v1 HTTP/1.1"
        );
        assert_eq!(
            first.body,
            json!({"settings":{"toolCallExpansionDefaults":{"preset":"custom","tools":{"bash":"hidden"}}}})
        );
        // Queue a preset and two row edits while the first PATCH is in flight: each gesture
        // seals its own batch in FIFO order, matching Solid's transcript-filters queue.
        prefs.set_transcript(None, "everything");
        prefs.set_transcript(Some(Row::Tool("read")), "collapsed");
        prefs.set_transcript(Some(Row::Inputs), "hidden");
        assert_eq!(prefs.transcript_mode(Row::tool("bash"), false), "expanded");
        assert_eq!(prefs.transcript_mode(Row::Inputs, true), "hidden");
        assert_eq!(prefs.transcript_preset(), "balanced");

        let mut saved = transcript_preset::patch("balanced");
        saved["locale"] = json!("en");
        saved["toolCallExpansionDefaults"]["preset"] = json!("custom");
        saved["toolCallExpansionDefaults"]["tools"]["bash"] = json!("hidden");
        first.reply(200, json!({"settings":saved})).await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_mode(Row::tool("bash"), false) == "hidden"
        })
        .await;

        let preset = request(&listener).await;
        saved = transcript_preset::patch("everything");
        assert_eq!(preset.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(preset.body, json!({"settings":saved}));
        saved["locale"] = json!("en");
        preset.reply(200, json!({"settings":saved})).await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_preset() == "everything"
        })
        .await;

        // Trailing row gestures after a queued preset coalesce into one minimal merge patch.
        let rows_req = request(&listener).await;
        assert_eq!(
            rows_req.body,
            json!({"settings":{
                "toolInputsVisibility":"hidden",
                "toolCallExpansionDefaults":{"preset":"custom","tools":{"read":"collapsed"}}
            }})
        );
        saved["toolInputsVisibility"] = json!("hidden");
        saved["toolCallExpansionDefaults"]["preset"] = json!("custom");
        saved["toolCallExpansionDefaults"]["tools"]["read"] = json!("collapsed");
        rows_req.reply(200, json!({"settings":saved})).await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_preset() == "custom"
                && prefs.transcript_mode(Row::Tool("read"), false) == "collapsed"
                && prefs.transcript_mode(Row::Inputs, false) == "hidden"
        })
        .await;
        assert_eq!(prefs.transcript_mode(Row::Thinking, false), "expanded");
        assert_eq!(prefs.transcript_mode(Row::tool("read"), false), "collapsed");
        assert!(prefs.error().is_none());
    });
}

#[test]
fn ordered_queue_keeps_prior_edits_preserves_preset_failures_and_refreshes_on_invalidation() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture_atomic().await;
        // 1. Diagnostic in flight before Everything, followed by read; Everything fails once.
        prefs.set_transcript(Some(Row::Diagnostics), "hidden");
        prefs.poll();
        let diag = request(&listener).await;
        prefs.set_transcript(None, "everything");
        prefs.set_transcript(Some(Row::Tool("read")), "collapsed");
        assert_eq!(
            diag.body,
            json!({"settings":{"diagnosticsExpansion":"hidden"}})
        );
        let mut saved = json!({"locale":"en","diagnosticsExpansion":"hidden"});
        diag.reply(200, json!({"settings":saved})).await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_mode(Row::Diagnostics, false) == "hidden"
        })
        .await;

        let preset = request(&listener).await;
        assert_eq!(
            preset.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "everything"
        );
        preset.reply(503, json!({})).await;
        let readback = request(&listener).await;
        assert_eq!(
            readback.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        readback.reply(200, json!({"settings":saved})).await;

        // Queued row edits continue immediately after a failed preset (matching Solid) while the
        // failed preset error stays visible until Retry.
        let read_patch = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            read_patch.first,
            "PATCH /api/storage/config/ui?conditional=atomic-v1 HTTP/1.1"
        );
        assert_eq!(
            read_patch.body,
            json!({"settings":{"toolCallExpansionDefaults":{"preset":"custom","tools":{"read":"collapsed"}}}}),
            "manual read edit must send only read so concurrent skill changes survive"
        );
        saved["toolCallExpansionDefaults"] =
            json!({"preset":"custom","tools":{"read":"collapsed","skill":"hidden"}});
        read_patch.reply(200, json!({"settings":saved})).await;
        wait_until(|| {
            prefs.poll();
            !prefs.config.refreshing()
                && prefs.transcript_preset() == "custom"
                && prefs.transcript_mode(Row::Tool("read"), false) == "collapsed"
        })
        .await;
        assert_eq!(prefs.transcript_mode(Row::Diagnostics, false), "hidden");
        assert_eq!(prefs.transcript_mode(Row::Tool("skill"), false), "hidden");
        assert!(
            prefs.transcript_error().is_some(),
            "failed preset error must remain visible until Retry"
        );

        // Retrying reconciles, replays failed Everything, then preserves the newer Read -> collapsed override.
        prefs.retry_transcript();
        prefs.poll();
        let retry_read = request(&listener).await;
        assert_eq!(
            retry_read.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        retry_read.reply(200, json!({"settings":saved})).await;
        let retry_preset = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            retry_preset.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "everything"
        );
        saved = transcript_preset::patch("everything");
        saved["locale"] = json!("en");
        retry_preset
            .reply(200, json!({"settings":saved.clone()}))
            .await;
        let retry_override = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            retry_override.body,
            json!({"settings":{"toolCallExpansionDefaults":{"preset":"custom","tools":{"read":"collapsed"}}}})
        );
        saved["toolCallExpansionDefaults"]["preset"] = json!("custom");
        saved["toolCallExpansionDefaults"]["tools"]["read"] = json!("collapsed");
        retry_override.reply(200, json!({"settings":saved})).await;
        wait_until(|| {
            prefs.poll();
            !prefs.config.refreshing()
                && prefs.transcript_preset() == "custom"
                && prefs.transcript_error().is_none()
        })
        .await;
        assert_eq!(prefs.transcript_mode(Row::Tool("read"), false), "collapsed");
        assert_eq!(prefs.transcript_mode(Row::Tool("write"), false), "expanded");
    });
}

#[test]
fn native_flush_waits_for_inflight_transcript_patch_and_reports_failure() {
    let (listener, mut prefs) = platform::block_on(fixture());
    prefs.set_transcript(None, "everything");
    prefs.poll();
    let req = platform::block_on(request(&listener));
    assert_eq!(req.first, "PATCH /api/storage/config/ui HTTP/1.1");
    // Queue is empty while the PATCH is in flight; flush must wait and report failure on 503.
    let (done_tx, done_rx) = codenomad_client::bounded(1);
    platform::spawn(async move {
        platform::sleep(Duration::from_millis(30)).await;
        req.reply(503, json!({})).await;
        let readback = request(&listener).await;
        assert_eq!(
            readback.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        readback
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;
        let _ = done_tx.send(listener).await;
    });
    assert!(
        !prefs.flush(),
        "flush must return false when the in-flight transcript PATCH fails"
    );
    let listener = platform::block_on(done_rx.recv()).unwrap();
    assert!(prefs.transcript_error().is_some());

    // Retrying and flushing while the PATCH is in flight must wait for 200 and return true.
    prefs.retry_transcript();
    prefs.poll();
    let retry_patch = platform::block_on(async {
        let retry_read = request(&listener).await;
        retry_read
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;
        poll_next_request(&mut prefs, &listener).await
    });
    let mut saved = transcript_preset::patch("everything");
    saved["locale"] = json!("en");
    let (ok_tx, ok_rx) = codenomad_client::bounded(1);
    platform::spawn(async move {
        platform::sleep(Duration::from_millis(30)).await;
        retry_patch.reply(200, json!({"settings":saved})).await;
        let _ = ok_tx.send(()).await;
    });
    assert!(
        prefs.flush(),
        "flush must wait for the in-flight transcript PATCH to confirm"
    );
    platform::block_on(ok_rx.recv()).unwrap();
    assert_eq!(prefs.transcript_preset(), "everything");
}

#[test]
fn failed_preset_and_queued_edits_survive_new_row_edit_and_sealed_batches_stay_ordered() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.set_transcript(None, "everything");
        prefs.poll();
        let preset_req = request(&listener).await;
        // Queue Tool groups while Everything is in flight, then fail Everything.
        prefs.set_transcript(Some(Row::Groups), "hidden");
        preset_req.reply(503, json!({})).await;
        let readback = request(&listener).await;
        readback
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;

        // Queued Tool groups sends immediately after Everything fails (matching Solid),
        // and editing Diagnostics while Tool groups is in flight preserves failed Everything.
        let groups_req = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            groups_req.body,
            json!({"settings":{"toolGroupVisibility":"hidden"}})
        );
        prefs.set_transcript(Some(Row::Diagnostics), "hidden");
        prefs.set_transcript(Some(Row::Diagnostics), "expanded");
        assert!(
            prefs.transcript_error().is_some(),
            "failed preset Retry state must remain visible"
        );
        groups_req
            .reply(
                200,
                json!({"settings":{"locale":"en","toolGroupVisibility":"hidden"}}),
            )
            .await;
        let diag_req = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            diag_req.body,
            json!({"settings":{"diagnosticsExpansion":"expanded"}})
        );
        let mut saved = json!({
            "locale":"en",
            "toolGroupVisibility":"hidden",
            "diagnosticsExpansion":"expanded"
        });
        diag_req.reply(200, json!({"settings":saved.clone()})).await;
        wait_until(|| {
            prefs.poll();
            !prefs.config.refreshing()
                && prefs.transcript_mode(Row::Groups, false) == "hidden"
                && prefs.transcript_mode(Row::Diagnostics, false) == "expanded"
        })
        .await;
        assert!(prefs.transcript_error().is_some());

        // Retry reconciles, replays failed Everything, then preserves confirmed post-preset row edits.
        prefs.retry_transcript();
        let retry_read = poll_next_request(&mut prefs, &listener).await;
        retry_read.reply(200, json!({"settings":saved})).await;
        saved = transcript_preset::patch("everything");
        saved["locale"] = json!("en");

        let preset_retry = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(preset_retry.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            preset_retry.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "everything"
        );
        preset_retry
            .reply(200, json!({"settings":saved.clone()}))
            .await;
        let post_rows = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            post_rows.body,
            json!({"settings":{"toolGroupVisibility":"hidden","diagnosticsExpansion":"expanded"}})
        );
        saved["toolGroupVisibility"] = json!("hidden");
        saved["diagnosticsExpansion"] = json!("expanded");
        post_rows.reply(200, json!({"settings":saved})).await;
        wait_until(|| {
            prefs.poll();
            !prefs.config.refreshing() && prefs.transcript_error().is_none()
        })
        .await;
        assert_eq!(prefs.transcript_mode(Row::Groups, false), "hidden");
        assert_eq!(prefs.transcript_mode(Row::Diagnostics, false), "expanded");
        assert_eq!(prefs.transcript_mode(Row::Tool("write"), false), "expanded");
    });
}

#[test]
fn retry_reconciliation_ignores_invalidated_read_and_rechecks_authoritative_state() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.set_transcript(None, "everything");
        prefs.poll();
        let failed = request(&listener).await;
        failed.reply(503, json!({})).await;
        let readback = request(&listener).await;
        readback
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_error().is_some()
        })
        .await;

        prefs.retry_transcript();
        prefs.poll();
        let stale_get = request(&listener).await;
        assert_eq!(
            stale_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        // Another client switches to Minimal and emits SSE invalidation before stale_get returns.
        prefs.invalidate(Owner::Config);
        let mut everything = transcript_preset::patch("everything");
        everything["locale"] = json!("en");
        stale_get
            .reply(200, json!({"settings":everything.clone()}))
            .await;

        // Because the read was invalidated in flight, Retry must NOT confirm from it;
        // it must issue a fresh authoritative GET and then replay Everything over Minimal.
        let fresh_get = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            fresh_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        fresh_get.reply(200, json!({"settings":minimal})).await;

        let replayed = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(replayed.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            replayed.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "everything"
        );
        replayed.reply(200, json!({"settings":everything})).await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_preset() == "everything" && prefs.transcript_error().is_none()
        })
        .await;
    });
}

#[test]
fn minimal_read_patch_malformed_json_rejection_and_invalidated_readback_guards() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture_atomic().await;
        // 1. Even on a fresh profile, read sends only read; concurrent skill & thinking survive.
        prefs.set_transcript(Some(Row::Tool("read")), "expanded");
        prefs.poll();
        let patch = request(&listener).await;
        assert_eq!(
            patch.body,
            json!({"settings":{"toolCallExpansionDefaults":{"preset":"custom","tools":{"read":"expanded"}}}})
        );
        let mut concurrent = transcript_preset::patch("balanced");
        concurrent["locale"] = json!("en");
        concurrent["showThinkingBlocks"] = json!(true);
        concurrent["toolCallExpansionDefaults"]["preset"] = json!("custom");
        concurrent["toolCallExpansionDefaults"]["tools"]["skill"] = json!("hidden");
        concurrent["toolCallExpansionDefaults"]["tools"]["read"] = json!("expanded");
        patch.reply(200, json!({"settings":concurrent})).await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_mode(Row::Tool("read"), false) == "expanded"
        })
        .await;
        assert_eq!(prefs.transcript_mode(Row::Tool("skill"), false), "hidden");
        assert_eq!(prefs.transcript_mode(Row::Thinking, false), "collapsed");

        // 2. Malformed 200 {"settings": false} is rejected by Owner::validate, keeping the last
        // good snapshot, leaving controls disabled, and never confirming Diagnostic -> expanded.
        prefs.set_transcript(Some(Row::Diagnostics), "hidden");
        prefs.poll();
        let hide_diag = request(&listener).await;
        hide_diag
            .reply(200, json!({"settings":{"diagnosticsExpansion":"hidden"}}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_mode(Row::Diagnostics, false) == "hidden"
        })
        .await;
        prefs.set_transcript(Some(Row::Diagnostics), "expanded");
        prefs.poll();
        let malformed = request(&listener).await;
        malformed.reply(200, json!({"settings":false})).await;
        let malformed_readback = request(&listener).await;
        assert_eq!(
            malformed_readback.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        malformed_readback
            .reply(200, json!({"settings":false}))
            .await;
        wait_until(|| {
            prefs.poll();
            !prefs.transcript_ready()
        })
        .await;
        assert_eq!(
            prefs.transcript_mode(Row::Diagnostics, false),
            "hidden",
            "malformed 200 must preserve the last good snapshot"
        );
        assert_eq!(prefs.transcript_error(), Some("rune.connect_error"));
        prefs.retry_transcript();
        prefs.poll();
        let recover_get = request(&listener).await;
        assert_eq!(
            recover_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        recover_get
            .reply(200, json!({"settings":{"diagnosticsExpansion":"hidden"}}))
            .await;
        let recover_patch = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(recover_patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        recover_patch
            .reply(200, json!({"settings":{"diagnosticsExpansion":"expanded"}}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_ready() && prefs.transcript_mode(Row::Diagnostics, false) == "expanded"
        })
        .await;

        // 3. Fallback readback after 503 PATCH invalidated by SSE must NOT confirm Everything.
        prefs.set_transcript(None, "everything");
        prefs.poll();
        let failed_preset = request(&listener).await;
        failed_preset.reply(503, json!({})).await;
        let readback = request(&listener).await;
        assert_eq!(
            readback.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        prefs.invalidate(Owner::Config);
        let mut everything = transcript_preset::patch("everything");
        everything["locale"] = json!("en");
        readback
            .reply(200, json!({"settings":everything.clone()}))
            .await;
        let fresh = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            fresh.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        fresh.reply(200, json!({"settings":minimal.clone()})).await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_preset() == "minimal"
        })
        .await;
        assert!(
            prefs.transcript_error().is_some(),
            "stale fallback readback must leave Everything failed"
        );

        // 4. A passive read invalidated in flight must also NOT clear failed Everything.
        prefs.invalidate(Owner::Config);
        prefs.poll();
        let passive = request(&listener).await;
        assert_eq!(
            passive.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        prefs.invalidate(Owner::Config);
        passive.reply(200, json!({"settings":everything})).await;
        let after_passive = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            prefs.transcript_preset(),
            "minimal",
            "invalidated passive read must not publish stale Everything snapshot"
        );
        assert_eq!(
            after_passive.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        after_passive
            .reply(200, json!({"settings":minimal.clone()}))
            .await;
        wait_until(|| {
            prefs.poll();
            !prefs.config.refreshing() && prefs.transcript_preset() == "minimal"
        })
        .await;
        assert!(
            prefs.transcript_error().is_some(),
            "invalidated passive read must leave Everything failed"
        );

        // 5. An invalidated Retry GET returning 503 preserves Retry intent for the next GET.
        prefs.retry_transcript();
        let failed_retry_get = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            failed_retry_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        prefs.invalidate(Owner::Config);
        failed_retry_get.reply(503, json!({})).await;
        let next_retry_get = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            next_retry_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        next_retry_get.reply(200, json!({"settings":minimal})).await;
        let replayed = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(replayed.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            replayed.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "everything"
        );
    });
}
