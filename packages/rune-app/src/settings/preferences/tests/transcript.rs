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

#[test]
fn superseded_failed_preset_does_not_block_queued_replacement_and_watch_clears_transport_lost() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        // 1. Click Everything, then Minimal before Everything responds; Everything fails (503).
        prefs.set_transcript(None, "everything");
        prefs.poll();
        let failed_everything = request(&listener).await;
        prefs.set_transcript(None, "minimal");
        failed_everything.reply(503, json!({})).await;
        let readback = request(&listener).await;
        assert_eq!(
            readback.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        readback
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;

        // Minimal supersedes Everything, so it must send immediately without blocking behind Retry.
        let minimal_req = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(minimal_req.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            minimal_req.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "minimal"
        );
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        minimal_req
            .reply(200, json!({"settings":minimal.clone()}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_preset() == "minimal" && prefs.transcript_error().is_none()
        })
        .await;

        // 2. Losing transport disables Chat; a pre-outage fallback readback GET must NOT confirm a
        // write or clear read_failed/transport_lost, and PreferencesWatch disconnects also disable
        // controls until a post-outage non-stale GET succeeds.
        prefs.set_transcript(None, "everything");
        prefs.poll();
        let outage_patch = request(&listener).await;
        outage_patch.reply(503, json!({})).await;
        let pre_outage_readback = request(&listener).await;
        assert_eq!(
            pre_outage_readback.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        prefs.mark_transport_lost();
        assert!(!prefs.transcript_ready());
        assert_eq!(
            prefs.transcript_error(),
            Some("rune.connect_error"),
            "transport_lost must surface an actionable connection error"
        );
        let mut everything = transcript_preset::patch("everything");
        everything["locale"] = json!("en");
        pre_outage_readback
            .reply(200, json!({"settings":everything}))
            .await;
        wait_until(|| {
            prefs.poll();
            !prefs.config.refreshing()
        })
        .await;
        assert!(
            !prefs.transcript_ready(),
            "pre-outage readback GET must not clear transport_lost"
        );
        assert_eq!(
            prefs.transcript_preset(),
            "minimal",
            "pre-outage readback GET must not confirm Everything or publish a stale snapshot"
        );
        // Handing back to PreferencesWatch keeps controls disabled until the watch's fresh GET settles.
        let wake: rune::Waker = std::sync::Arc::new(|| {});
        prefs.watch(&wake);
        assert!(
            !prefs.transcript_ready(),
            "watch() must not clear transport_lost before revalidation"
        );
        let mut watch_sse = request(&listener).await;
        assert!(watch_sse.first.starts_with("GET /api/events?"));
        use tokio::io::AsyncWriteExt;
        watch_sse
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let mut revalidated_get = None;
        for _ in 0..2 {
            let req = poll_next_request(&mut prefs, &listener).await;
            if req.first.contains("/api/storage/config/ui") {
                assert!(
                    !prefs.transcript_ready(),
                    "launching a fresh GET must not clear transport_lost"
                );
                revalidated_get = Some(req);
            } else {
                req.reply(200, json!({"settings":{}})).await;
            }
        }
        revalidated_get
            .expect("watch SSE open must trigger a fresh config GET")
            .reply(200, json!({"settings":minimal.clone()}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_ready()
        })
        .await;

        // Dropping PreferencesWatch SSE must also disable Chat (returning true from poll() for
        // redraw) and keep queued writes parked until the reconnected watch completes its GET.
        drop(watch_sse);
        let mut disconnect_reported = false;
        wait_until(|| {
            if prefs.poll() {
                disconnect_reported = true;
            }
            !prefs.transcript_ready()
        })
        .await;
        assert!(
            disconnect_reported,
            "Preferences::poll must return true when PreferencesWatch disconnects"
        );
        let mut watch_sse_2 = request(&listener).await;
        assert!(watch_sse_2.first.starts_with("GET /api/events?"));
        watch_sse_2
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let mut revalidated_2 = None;
        for _ in 0..2 {
            let req = poll_next_request(&mut prefs, &listener).await;
            if req.first.contains("/api/storage/config/ui") {
                revalidated_2 = Some(req);
            } else {
                req.reply(200, json!({"settings":{}})).await;
            }
        }
        revalidated_2
            .expect("reconnected watch SSE must trigger a fresh config GET")
            .reply(200, json!({"settings":minimal.clone()}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_ready()
        })
        .await;

        // Same-address reattach keeps Chat disabled until the reattach GET completes.
        let mut current = prefs.backend.take().unwrap();
        attest(&listener, &mut current, "same-server").await;
        let mut reattach_backend = Backend::unauthenticated(&current.base).unwrap();
        reattach_backend.client_id.push_str("-reattach");
        attest(&listener, &mut reattach_backend, "same-server").await;
        prefs.backend = Some(current);
        assert!(prefs.bind(Some(reattach_backend)));
        assert!(
            !prefs.transcript_ready(),
            "same-address reattach must disable Chat until reattach GET settles"
        );
        let mut reattach_get = None;
        for _ in 0..2 {
            let req = poll_next_request(&mut prefs, &listener).await;
            if req.first.contains("/api/storage/config/ui") {
                reattach_get = Some(req);
            } else {
                req.reply(200, json!({"settings":{}})).await;
            }
        }
        reattach_get
            .expect("reattach must perform a config GET")
            .reply(200, json!({"settings":minimal}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_ready()
        })
        .await;
        prefs.unwatch();
    });
}

#[test]
fn native_flush_and_poll_observe_conversation_stream_invalidation_during_readback() {
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    let (listener, mut prefs) = platform::block_on(fixture());
    let backend_ref = prefs.backend.clone().unwrap();
    let mut conv_backend = backend_ref.clone();
    conv_backend.workspace = "project".into();
    conv_backend.session = "session".into();
    let (out, events) = bounded(16);
    let (commands, input) = bounded(4);
    let (mut sse, patch) = platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(conv_backend, out, input, Arc::new(|| {})).await;
        });
        let mut sse = request(&listener).await;
        assert!(sse.first.starts_with("GET /api/events?"));
        sse.socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let page = request(&listener).await;
        page.reply(
            200,
            json!({
                "status":"window",
                "messages":[{"id":"recent","type":"user","text":"recent"}],
                "older":null,"newer":null,"latest":true
            }),
        )
        .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        // Drain initial Event::Sync + Event::Preferences just like chat/events.rs does.
        timeout(Duration::from_secs(5), async {
            loop {
                match events.recv().await.unwrap() {
                    Event::Preferences(owner) => prefs.invalidate(owner),
                    Event::Sync(_) => break,
                    _ => {}
                }
            }
        })
        .await
        .expect("timed out waiting for initial Event::Sync");
        while let Ok(event) = events.try_recv() {
            if let Event::Preferences(owner) = event {
                prefs.invalidate(owner);
            }
        }
        prefs.poll();
        timeout(Duration::from_secs(5), async {
            let mut settled = 0;
            while settled < 2 {
                let req = poll_next_request(&mut prefs, &listener).await;
                if req.first.contains("/api/storage/config/ui") {
                    req.reply(200, json!({"settings":{"locale":"en"}})).await;
                    settled += 1;
                } else if req.first.contains("/api/storage/state") {
                    req.reply(200, json!({"settings":{}})).await;
                    settled += 1;
                }
            }
        })
        .await
        .expect("timed out draining initial config/state reads");
        wait_until(|| {
            prefs.poll();
            prefs.notification_config().is_some()
        })
        .await;

        // 1. Outside flush(): Preferences::poll() alone (before chat/events.rs pumps Event::Preferences)
        // must still reject a stale fallback readback invalidated on the conversation stream.
        prefs.set_transcript(None, "everything");
        prefs.poll();
        let poll_patch = request(&listener).await;
        assert_eq!(poll_patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        poll_patch.reply(503, json!({})).await;
        let poll_readback = request(&listener).await;
        let rev_before = backend_ref.client.preferences_revision(Owner::Config);
        sse.socket
            .write_all(
                b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\",\"value\":{}}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| backend_ref.client.preferences_revision(Owner::Config) > rev_before).await;
        let mut everything = transcript_preset::patch("everything");
        everything["locale"] = json!("en");
        poll_readback
            .reply(200, json!({"settings":everything.clone()}))
            .await;
        let poll_fresh = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            poll_fresh.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        poll_fresh
            .reply(200, json!({"settings":minimal.clone()}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_preset() == "minimal"
        })
        .await;
        assert!(
            prefs.transcript_error().is_some(),
            "poll() must not confirm Everything from a readback invalidated on the conversation stream"
        );

        // 2. Inside flush(): same guard holds while blocking on native close.
        prefs.set_transcript(None, "nothing");
        prefs.poll();
        let patch = request(&listener).await;
        assert_eq!(patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        (sse, patch)
    });

    let rev_client = backend_ref.client.clone();
    let (done_tx, done_rx) = bounded(1);
    platform::spawn(async move {
        platform::sleep(Duration::from_millis(20)).await;
        patch.reply(503, json!({})).await;
        let stale_readback = request(&listener).await;
        assert_eq!(
            stale_readback.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        let rev_before = rev_client.preferences_revision(Owner::Config);
        sse.socket
            .write_all(
                b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\",\"value\":{}}\n\n",
            )
            .await
            .unwrap();
        timeout(Duration::from_secs(4), async {
            while rev_client.preferences_revision(Owner::Config) <= rev_before {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("conversation stream must observe storage.configChanged");
        let mut nothing = transcript_preset::patch("nothing");
        nothing["locale"] = json!("en");
        stale_readback.reply(200, json!({"settings":nothing})).await;

        let fresh_get = request(&listener).await;
        assert_eq!(
            fresh_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        fresh_get.reply(200, json!({"settings":minimal})).await;
        let _ = commands.send(Command::Close).await;
        let _ = done_tx.send(()).await;
    });

    assert!(
        !prefs.flush(),
        "flush must not confirm Nothing from a fallback readback invalidated on the conversation stream"
    );
    platform::block_on(done_rx.recv()).unwrap();
    assert_eq!(prefs.transcript_preset(), "minimal");
    assert!(prefs.transcript_error().is_some());
}

#[test]
fn flush_after_disconnect_revalidates_or_fails_promptly_and_hidden_tab_disconnect_is_ignored() {
    // 1. poll_hidden_chat with a closed hidden channel containing ConnectionLost does NOT disable
    // a healthy active conversation tab (active_has_stream = true), while an empty active tab
    // (active_has_stream = false) DOES disable Chat when its hidden fallback stream disconnects.
    let (listener, prefs) = platform::block_on(fixture());
    let mut root = crate::init();
    *root.settings.shared.borrow_mut() = prefs;
    let (hidden_tx, hidden_rx) = bounded(2);
    platform::block_on(hidden_tx.send(crate::transport::Event::ConnectionLost)).unwrap();
    drop(hidden_tx); // Closed hidden channel with buffered ConnectionLost!
    root.incoming = Some(hidden_rx);
    crate::chat::events::poll_hidden_chat(&mut root, 8, true);
    assert!(
        root.settings.shared.borrow().transcript_ready(),
        "hidden closed channel ConnectionLost must not disable a healthy active conversation tab"
    );
    let (hidden_tx2, hidden_rx2) = bounded(2);
    platform::block_on(hidden_tx2.send(crate::transport::Event::ConnectionLost)).unwrap();
    drop(hidden_tx2);
    root.incoming = Some(hidden_rx2);
    crate::chat::events::poll_hidden_chat(&mut root, 8, false);
    assert!(
        !root.settings.shared.borrow().transcript_ready(),
        "hidden tab ConnectionLost must disable Chat when active tab has no open stream"
    );
    assert_eq!(
        root.settings.shared.borrow().transcript_error(),
        Some("rune.connect_error")
    );
    drop(listener);
    let (listener, mut prefs) = platform::block_on(fixture());

    // 2. Disconnecting with a queued write and calling flush() must run one revalidation GET and
    // return false promptly on failure instead of hanging until the drain timeout.
    prefs.set_transcript(None, "minimal");
    prefs.mark_transport_lost();
    let (done_tx, done_rx) = bounded(1);
    platform::spawn(async move {
        let reval = request(&listener).await;
        assert_eq!(
            reval.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        reval.reply(503, json!({})).await;
        let _ = done_tx.send(()).await;
    });
    let started = std::time::Instant::now();
    assert!(
        !prefs.flush(),
        "flush after disconnect with failing revalidation GET must return false"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "flush after disconnect must not hang waiting for a blocked write"
    );
    platform::block_on(done_rx.recv()).unwrap();

    // 3. Disconnecting while PATCH #1 is in flight and PATCH #2 is queued: flush() must finish
    // PATCH #1, run one revalidation GET, and then save & confirm PATCH #2.
    let (listener2, mut prefs2) = platform::block_on(fixture());
    prefs2.set_transcript(None, "minimal");
    prefs2.poll();
    let patch1 = platform::block_on(request(&listener2));
    assert_eq!(patch1.first, "PATCH /api/storage/config/ui HTTP/1.1");
    prefs2.set_transcript(Some(Row::Groups), "hidden");
    prefs2.mark_transport_lost();
    let (done2_tx, done2_rx) = bounded(1);
    platform::spawn(async move {
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        patch1.reply(200, json!({"settings":minimal.clone()})).await;
        let reval = request(&listener2).await;
        assert_eq!(
            reval.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        reval.reply(200, json!({"settings":minimal.clone()})).await;
        let patch2 = request(&listener2).await;
        assert_eq!(patch2.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            patch2.body,
            json!({"settings":{"toolGroupVisibility":"hidden"}})
        );
        minimal["toolGroupVisibility"] = json!("hidden");
        patch2.reply(200, json!({"settings":minimal})).await;
        let _ = done2_tx.send(()).await;
    });
    assert!(
        prefs2.flush(),
        "flush with in-flight PATCH + disconnect + queued PATCH must revalidate and confirm PATCH #2"
    );
    platform::block_on(done2_rx.recv()).unwrap();
    assert_eq!(prefs2.transcript_mode(Row::Groups, false), "hidden");

    // 4. Real conversation stream with a distinct client_id (as produced by catalog/binding.rs)
    // dropping while PATCH #1 is in flight and PATCH #2 is queued: flush() must observe the
    // distinct conversation client_id's drop and run a revalidation GET before PATCH #2.
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    let (listener3, mut prefs3) = platform::block_on(fixture());
    let mut conv_backend = prefs3.backend.clone().unwrap();
    conv_backend.client_id.push_str("-conversation");
    conv_backend.workspace = "project".into();
    conv_backend.session = "session".into();
    let conv_client_id = conv_backend.client_id.clone();
    prefs3.observe_conversation_clients(&[(conv_client_id.clone(), true)]);
    let (out3, events3) = bounded(16);
    let (commands3, input3) = bounded(4);
    let (sse3, patch3_1) = platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(conv_backend, out3, input3, Arc::new(|| {})).await;
        });
        let mut sse = request(&listener3).await;
        assert!(sse.first.starts_with("GET /api/events?"));
        sse.socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let page = request(&listener3).await;
        page.reply(
            200,
            json!({
                "status":"window",
                "messages":[{"id":"recent","type":"user","text":"recent"}],
                "older":null,"newer":null,"latest":true
            }),
        )
        .await;
        request(&listener3)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events3.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        prefs3.set_transcript(None, "minimal");
        prefs3.poll();
        let p1 = request(&listener3).await;
        assert_eq!(p1.first, "PATCH /api/storage/config/ui HTTP/1.1");
        prefs3.set_transcript(Some(Row::Groups), "hidden");
        (sse, p1)
    });
    let drop_client = prefs3.backend.as_ref().unwrap().client.clone();
    let (done3_tx, done3_rx) = bounded(1);
    platform::spawn(async move {
        // Drop the conversation SSE stream without delivering ConnectionLost to the UI loop.
        drop(sse3);
        timeout(Duration::from_secs(4), async {
            while drop_client.transport_drops(&conv_client_id) == 0 {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("conversation client_id drop must be recorded");
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        patch3_1
            .reply(200, json!({"settings":minimal.clone()}))
            .await;
        // Revalidation GET MUST arrive before PATCH #2 (hold any background SSE reconnects open).
        let mut _reconnects = Vec::new();
        loop {
            let req = request(&listener3).await;
            if req.first.starts_with("GET /api/events?") {
                _reconnects.push(req);
                continue;
            }
            assert_eq!(
                req.first, "GET /api/storage/config/ui?authoritative=1 HTTP/1.1",
                "flush must revalidate before sending PATCH #2 after active conversation SSE drop"
            );
            req.reply(200, json!({"settings":minimal.clone()})).await;
            break;
        }
        loop {
            let req = request(&listener3).await;
            if req.first.starts_with("GET /api/events?") {
                _reconnects.push(req);
                continue;
            }
            assert_eq!(req.first, "PATCH /api/storage/config/ui HTTP/1.1");
            assert_eq!(
                req.body,
                json!({"settings":{"toolGroupVisibility":"hidden"}})
            );
            minimal["toolGroupVisibility"] = json!("hidden");
            req.reply(200, json!({"settings":minimal})).await;
            break;
        }
        let _ = commands3.send(Command::Close).await;
        let _ = done3_tx.send(()).await;
    });
    assert!(
        prefs3.flush(),
        "flush must detect distinct conversation client_id SSE drop, revalidate, and confirm PATCH #2"
    );
    platform::block_on(done3_rx.recv()).unwrap();
    assert_eq!(prefs3.transcript_mode(Row::Groups, false), "hidden");
}

#[test]
fn tab_switch_revalidates_hidden_drop_and_state_and_bounds_queue_and_notification_seed() {
    use crate::settings::notification_routing::{Category, Destination};
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    // 1. Tab B drops while hidden (Tab A is active). Switching to Tab B detects Tab B's unseen
    // drop instead of erasing it, AND revalidates both Config and State (so a queued Mode write
    // on State is not left stranded after Config revalidates).
    let (listener, mut prefs) = platform::block_on(fixture());
    let mut tab_b_backend = prefs.backend.clone().unwrap();
    tab_b_backend.client_id.push_str("-tab-b");
    tab_b_backend.workspace = "project".into();
    tab_b_backend.session = "session".into();
    let tab_a_id = "conv-tab-a".to_owned();
    let tab_b_id = tab_b_backend.client_id.clone();
    prefs.observe_conversation_clients(&[(tab_a_id.clone(), true)]);

    let (out_b, events_b) = bounded(16);
    let (commands_b, input_b) = bounded(4);
    let drop_client = prefs.backend.as_ref().unwrap().client.clone();
    platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(tab_b_backend, out_b, input_b, Arc::new(|| {})).await;
        });
        let mut sse_b = request(&listener).await;
        assert!(sse_b.first.starts_with("GET /api/events?"));
        sse_b
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let page = request(&listener).await;
        page.reply(
            200,
            json!({
                "status":"window",
                "messages":[{"id":"recent","type":"user","text":"recent"}],
                "older":null,"newer":null,"latest":true
            }),
        )
        .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        // Drop Tab B while Tab A is still active: Tab A stays ready.
        drop(sse_b);
        timeout(Duration::from_secs(4), async {
            while drop_client.transport_drops(&tab_b_id) == 0 {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("tab B drop must be recorded");
        prefs.poll();
        assert!(
            prefs.transcript_ready(),
            "hidden Tab B drop must not disturb healthy Tab A"
        );

        // Now activate Tab B (with a pending State write): observe_conversation_clients detects
        // Tab B's unseen drop, disables Chat, and revalidate_transport() revalidates BOTH Config
        // and State so the pending State write proceeds after State GET.
        prefs.set_mode("dark");
        prefs.observe_conversation_clients(&[(tab_b_id.clone(), false)]);
        assert!(
            !prefs.transcript_ready(),
            "switching to dropped Tab B must detect its unseen drop"
        );
        prefs.revalidate_transport();
        prefs.poll();

        let mut got_config_get = false;
        let mut got_state_get = false;
        let mut got_state_patch = false;
        let mut _reconnects = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while !(got_config_get && got_state_get && got_state_patch) {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for Config GET + State GET + State PATCH"
            );
            let req = poll_next_request(&mut prefs, &listener).await;
            if req.first.starts_with("GET /api/events?") {
                _reconnects.push(req);
                continue;
            }
            if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                got_config_get = true;
                req.reply(200, json!({"settings":{"locale":"en"}})).await;
            } else if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                got_state_get = true;
                req.reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                    .await;
            } else if req.first == "PATCH /api/storage/state/ui HTTP/1.1" {
                assert!(
                    got_state_get,
                    "State PATCH must wait for State revalidation GET after Tab B drop"
                );
                got_state_patch = true;
                req.reply(200, json!({"appearancePreferences":{"mode":"dark"}}))
                    .await;
            } else {
                panic!("unexpected request: {}", req.first);
            }
        }
        wait_until(|| {
            prefs.poll();
            prefs.transcript_ready() && prefs.mode() == "dark"
        })
        .await;
        let _ = commands_b.send(Command::Close).await;
    });

    // 2. NotificationRoute PATCH without existing notificationRouting object must run a queued
    // GET first when Config was invalidated, avoiding clobbering a concurrent client's routes.
    let (listener2, mut prefs2) = platform::block_on(fixture());
    prefs2.config.snapshot = Some(json!({"settings":{"osNotificationsEnabled":true}}));
    prefs2.invalidate(Owner::Config);
    prefs2.set_notification_route(Category::SessionDone, Destination::System, false);
    prefs2.poll();
    platform::block_on(async {
        let get = request(&listener2).await;
        assert_eq!(
            get.first, "GET /api/storage/config/ui?authoritative=1 HTTP/1.1",
            "invalidated NotificationRoute seed must GET before PATCH"
        );
        get.reply(
            200,
            json!({"settings":{"notificationRouting":{"needsInput":{"system":false},"sessionDone":{"system":true}}}}),
        )
        .await;
        let patch = poll_next_request(&mut prefs2, &listener2).await;
        assert_eq!(patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            patch.body,
            json!({"settings":{"notificationRouting":{"sessionDone":{"system":false}}}}),
            "fresh snapshot with existing notificationRouting must send minimal single-leaf PATCH"
        );
        patch
            .reply(
                200,
                json!({"settings":{"notificationRouting":{"needsInput":{"system":false},"sessionDone":{"system":false}}}}),
            )
            .await;
        wait_until(|| {
            prefs2.poll();
            !prefs2.config.refreshing()
        })
        .await;
    });

    // 3. Coalesced FIFO ordering: earlier unsent row edits still send ahead of a later preset so a
    // 503 on the preset never drops them, while repeated/alternating preset clicks deduplicate.
    let (listener3, mut prefs3) = platform::block_on(fixture());
    prefs3.set_transcript(None, "minimal");
    prefs3.poll();
    platform::block_on(async {
        let first = request(&listener3).await;
        // Stage row edits followed by repeated Everything clicks while minimal is in flight:
        // the queued row batch sends first (surviving an Everything 503), and repeated Everything
        // clicks deduplicate to one preset batch.
        prefs3.set_transcript(Some(Row::Groups), "hidden");
        prefs3.set_transcript(Some(Row::Diagnostics), "hidden");
        for _ in 0..5 {
            prefs3.set_transcript(None, "everything");
        }
        let mut saved = transcript_preset::patch("minimal");
        saved["locale"] = json!("en");
        first.reply(200, json!({"settings":saved.clone()})).await;

        let queued_rows = poll_next_request(&mut prefs3, &listener3).await;
        assert_eq!(
            queued_rows.body,
            json!({"settings":{"diagnosticsExpansion":"hidden","toolGroupVisibility":"hidden"}})
        );
        saved["diagnosticsExpansion"] = json!("hidden");
        saved["toolGroupVisibility"] = json!("hidden");
        queued_rows
            .reply(200, json!({"settings":saved.clone()}))
            .await;

        let everything_fail = poll_next_request(&mut prefs3, &listener3).await;
        assert_eq!(
            everything_fail.body["settings"]["toolCallExpansionDefaults"]["preset"],
            json!("everything")
        );
        everything_fail.reply(503, json!({})).await;
        let readback = poll_next_request(&mut prefs3, &listener3).await;
        assert_eq!(
            readback.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        readback.reply(200, json!({"settings":saved.clone()})).await;
        wait_until(|| {
            prefs3.poll();
            prefs3.transcript_error().is_some()
        })
        .await;
        assert_eq!(
            prefs3.transcript_mode(Row::Groups, false),
            "hidden",
            "queued row edit before a 503 preset must be persisted, not dropped"
        );
        assert_eq!(prefs3.transcript_mode(Row::Diagnostics, false), "hidden");

        prefs3.retry_transcript();
        let retry_get = poll_next_request(&mut prefs3, &listener3).await;
        retry_get.reply(200, json!({"settings":saved})).await;
        let retry_patch = poll_next_request(&mut prefs3, &listener3).await;
        assert_eq!(
            retry_patch.body["settings"]["toolCallExpansionDefaults"]["preset"],
            json!("everything")
        );
        let mut everything = transcript_preset::patch("everything");
        everything["locale"] = json!("en");
        retry_patch.reply(200, json!({"settings":everything})).await;
        wait_until(|| {
            prefs3.poll();
            prefs3.transcript_preset() == "everything" && prefs3.transcript_error().is_none()
        })
        .await;
        assert!(
            timeout(Duration::from_millis(60), listener3.accept())
                .await
                .is_err(),
            "duplicate consecutive preset clicks must not leave extra batches in transcript_queue"
        );
    });

    // 4. Retry in Chat after disconnect also revalidates State so a pending appearance Mode write
    // is never stranded after transport_lost clears.
    let (listener4, mut prefs4) = platform::block_on(fixture());
    prefs4.mark_transport_lost();
    prefs4.set_mode("dark");
    prefs4.retry_transcript();
    prefs4.poll();
    platform::block_on(async {
        timeout(Duration::from_secs(5), async {
            let mut got_config = false;
            let mut got_state_get = false;
            let mut got_state_patch = false;
            while !(got_config && got_state_get && got_state_patch) {
                let req = poll_next_request(&mut prefs4, &listener4).await;
                if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                    got_config = true;
                    req.reply(200, json!({"settings":{"locale":"en"}})).await;
                } else if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                    got_state_get = true;
                    req.reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                        .await;
                } else if req.first == "PATCH /api/storage/state/ui HTTP/1.1" {
                    assert!(got_state_get);
                    got_state_patch = true;
                    req.reply(200, json!({"appearancePreferences":{"mode":"dark"}}))
                        .await;
                } else {
                    panic!("unexpected request: {}", req.first);
                }
            }
        })
        .await
        .expect("timed out waiting for Config GET + State GET + State PATCH");
        wait_until(|| {
            prefs4.poll();
            prefs4.transcript_ready() && prefs4.mode() == "dark"
        })
        .await;
    });

    // 5. flush() reconciles an already-failed Chat write when an SSE storage.configChanged bumped
    // preferences_revision on the conversation stream without UI polling yet.
    let (listener5, mut prefs5) = platform::block_on(fixture());
    let mut conv5 = prefs5.backend.clone().unwrap();
    conv5.workspace = "project".into();
    conv5.session = "session".into();
    let (out5, events5) = bounded(16);
    let (commands5, input5) = bounded(4);
    let sse5 = platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(conv5, out5, input5, Arc::new(|| {})).await;
        });
        let mut sse = request(&listener5).await;
        assert!(sse.first.starts_with("GET /api/events?"));
        sse.socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let page = request(&listener5).await;
        page.reply(
            200,
            json!({
                "status":"window",
                "messages":[{"id":"recent","type":"user","text":"recent"}],
                "older":null,"newer":null,"latest":true
            }),
        )
        .await;
        request(&listener5)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events5.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        // Fail a Groups -> hidden write with 503 + fallback GET returning old value.
        prefs5.set_transcript(Some(Row::Groups), "hidden");
        prefs5.poll();
        request(&listener5).await.reply(503, json!({})).await;
        request(&listener5)
            .await
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;
        wait_until(|| {
            prefs5.poll();
            prefs5.transcript_error() == Some("settings.preferenceSaveFailed")
        })
        .await;
        sse
    });
    let rev_before = prefs5
        .backend
        .as_ref()
        .unwrap()
        .client
        .preferences_revision(Owner::Config);
    let rev_client = prefs5.backend.as_ref().unwrap().client.clone();
    let (done5_tx, done5_rx) = bounded(1);
    platform::block_on(async {
        let mut sse5 = sse5;
        sse5.socket
            .write_all(b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\"}\n\n")
            .await
            .unwrap();
        timeout(Duration::from_secs(4), async {
            while rev_client.preferences_revision(Owner::Config) == rev_before {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("SSE storage.configChanged must bump preferences_revision");
        // Spawn reply to the reconciliation GET that flush() must run (keep sse5 open until
        // flush returns so closing sse5 does not simulate a mid-GET transport drop).
        platform::spawn(async move {
            let get = request(&listener5).await;
            assert_eq!(
                get.first,
                "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
            );
            get.reply(
                200,
                json!({"settings":{"locale":"en","toolGroupVisibility":"hidden"}}),
            )
            .await;
            let _ = done5_tx.send(sse5).await;
        });
    });
    assert!(
        prefs5.flush(),
        "flush must reconcile a failed write after unseen conversation SSE invalidation"
    );
    let sse5 = platform::block_on(done5_rx.recv()).unwrap();
    platform::block_on(async {
        let _ = commands5.send(Command::Close).await;
        drop(sse5);
    });
    assert_eq!(prefs5.transcript_mode(Row::Groups, false), "hidden");
}

#[test]
fn tab_switch_revokes_prepared_patch_stale_ack_waits_for_get_and_sibling_hidden_streams_survive() {
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    // 1. Switching from healthy Tab A to dropped Tab B after poll() prepared a PATCH must revoke
    // the unsent PATCH via epoch_guard before it hits the wire.
    let (listener1, mut prefs1) = platform::block_on(fixture());
    let mut tab_b = prefs1.backend.clone().unwrap();
    tab_b.client_id.push_str("-dropped-b");
    tab_b.workspace = "project".into();
    tab_b.session = "session".into();
    let tab_a_id = "healthy-a".to_owned();
    let tab_b_id = tab_b.client_id.clone();
    prefs1.observe_conversation_clients(&[(tab_a_id.clone(), true)]);
    let (out_b, events_b) = bounded(16);
    let (commands_b, input_b) = bounded(4);
    let drop_client = prefs1.backend.as_ref().unwrap().client.clone();
    platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(tab_b, out_b, input_b, Arc::new(|| {})).await;
        });
        let mut sse_b = request(&listener1).await;
        sse_b
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener1)
            .await
            .reply(
                200,
                json!({
                    "status":"window",
                    "messages":[{"id":"recent","type":"user","text":"recent"}],
                    "older":null,"newer":null,"latest":true
                }),
            )
            .await;
        request(&listener1)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        drop(sse_b);
        timeout(Duration::from_secs(4), async {
            while drop_client.transport_drops(&tab_b_id) == 0 {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("tab B drop must be recorded");
        // Empty active tab with TWO hidden streams (dropped B + healthy C): sibling C keeps
        // Preferences healthy and ready without advancing B's seen drop counter.
        let tab_c_id = "healthy-c".to_owned();
        prefs1.observe_conversation_clients(&[(tab_b_id.clone(), false), (tab_c_id.clone(), true)]);
        assert!(
            prefs1.transcript_ready(),
            "healthy sibling hidden stream must keep Preferences ready when another hidden tab drops"
        );

        // Now prepare a PATCH while Tab C is healthy, hold it before the pre-send guard, activate
        // dropped Tab B, then release: epoch_guard must revoke the unsent PATCH so no PATCH hits
        // the wire before revalidation GET.
        let (release_tx, release_rx) = bounded(1);
        prefs1.config.set_pre_patch_gate(release_rx);
        prefs1.set_transcript(None, "everything");
        assert!(prefs1.poll());
        prefs1.observe_conversation_clients(&[(tab_b_id.clone(), false)]);
        assert!(!prefs1.transcript_ready());
        let _ = release_tx.send(()).await;
        prefs1.revalidate_transport();
        let mut got_config_get = false;
        let mut got_patch = false;
        let mut _reconnects = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while !(got_config_get && got_patch) {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for revalidation GET followed by PATCH"
            );
            let req = poll_next_request(&mut prefs1, &listener1).await;
            if req.first.starts_with("GET /api/events?") {
                _reconnects.push(req);
            } else if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                let hold_until = std::time::Instant::now() + Duration::from_millis(30);
                while std::time::Instant::now() < hold_until {
                    prefs1.poll();
                    if let Ok(accepted) =
                        timeout(Duration::from_millis(5), listener1.accept()).await
                    {
                        let (socket, _) = accepted.unwrap();
                        let concurrent = read_request(socket, Duration::from_secs(3)).await;
                        assert_ne!(
                            concurrent.first, "PATCH /api/storage/config/ui HTTP/1.1",
                            "PATCH must not be dispatched while revalidation GET is still open"
                        );
                        if concurrent.first.starts_with("GET /api/events?") {
                            _reconnects.push(concurrent);
                        } else if concurrent.first
                            == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1"
                        {
                            concurrent
                                .reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                                .await;
                        }
                    }
                }
                got_config_get = true;
                req.reply(200, json!({"settings":{"locale":"en"}})).await;
            } else if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                req.reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                    .await;
            } else if req.first == "PATCH /api/storage/config/ui HTTP/1.1" {
                assert!(
                    got_config_get,
                    "revoked PATCH must NOT hit the wire before revalidation GET completes"
                );
                got_patch = true;
                let mut everything = transcript_preset::patch("everything");
                everything["locale"] = json!("en");
                req.reply(200, json!({"settings":everything})).await;
            }
        }
        wait_until(|| {
            prefs1.poll();
            prefs1.transcript_preset() == "everything" && prefs1.transcript_ready()
        })
        .await;
        let _ = commands_b.send(Command::Close).await;
    });

    // 2. A PATCH ACK arriving after an SSE invalidation publishes the confirmed write immediately
    // (no flicker back to the pre-write preset, and choosing an old value is not dropped) while
    // keeping the trailing authoritative GET queued to reconcile any concurrent remote change.
    let (listener2, mut prefs2) = platform::block_on(fixture());
    platform::block_on(async {
        prefs2.set_transcript(None, "everything");
        assert!(prefs2.poll());
        let patch = request(&listener2).await;
        assert_eq!(patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        // Simulate SSE invalidation arriving before our PATCH 200 ACK.
        prefs2.invalidate(Owner::Config);
        let mut stale_everything = transcript_preset::patch("everything");
        stale_everything["locale"] = json!("en");
        patch.reply(200, json!({"settings":stale_everything})).await;
        let authoritative = poll_next_request(&mut prefs2, &listener2).await;
        assert_eq!(
            authoritative.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        // While the trailing GET is in flight, snapshot reflects the confirmed Everything write
        // rather than reverting to the pre-write Balanced preset.
        assert_eq!(
            prefs2.transcript_preset(),
            "everything",
            "confirmed PATCH ACK must publish immediately instead of reverting to pre-write state"
        );
        assert!(
            prefs2.transcript_error().is_none(),
            "accepted PATCH must still be confirmed without error"
        );
        let mut concurrent_nothing = transcript_preset::patch("nothing");
        concurrent_nothing["locale"] = json!("en");
        authoritative
            .reply(200, json!({"settings":concurrent_nothing}))
            .await;
        wait_until(|| {
            prefs2.poll();
            prefs2.transcript_preset() == "nothing"
        })
        .await;
    });

    // 3. Skip::Transport after switching from Tab A to healthy Tab B must automatically trigger
    // a revalidation GET (never stranding the write with writes_allowed == false while healthy).
    let (listener3, mut prefs3) = platform::block_on(fixture_atomic());
    let mut tab_a3 = prefs3.backend.clone().unwrap();
    tab_a3.client_id.push_str("-departing-a");
    tab_a3.workspace = "project".into();
    tab_a3.session = "session".into();
    let tab_a3_id = tab_a3.client_id.clone();
    let tab_b3_id = "healthy-b".to_owned();
    prefs3.observe_conversation_clients(&[(tab_a3_id.clone(), true)]);
    let (out_a3, events_a3) = bounded(16);
    let (commands_a3, input_a3) = bounded(4);
    let drop_client3 = prefs3.backend.as_ref().unwrap().client.clone();
    platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(tab_a3, out_a3, input_a3, Arc::new(|| {})).await;
        });
        let meta_a3 = request(&listener3).await;
        assert_eq!(meta_a3.first, "GET /api/meta HTTP/1.1");
        meta_a3
            .reply(
                200,
                json!({"apiContract":1,"serverId":"fixture-3","capabilities":["settings-atomic-patches"]}),
            )
            .await;
        let mut sse_a3 = request(&listener3).await;
        sse_a3
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener3)
            .await
            .reply(
                200,
                json!({
                    "status":"window",
                    "messages":[{"id":"recent","type":"user","text":"recent"}],
                    "older":null,"newer":null,"latest":true
                }),
            )
            .await;
        request(&listener3)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        timeout(Duration::from_secs(5), async {
            loop {
                if matches!(events_a3.recv().await.unwrap(), Event::Sync(_)) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        // Prepare a PATCH while Tab A is active, pause before send, switch to healthy Tab B,
        // drop Tab A, then release: worker sees Tab A's drop -> Skip::Transport -> automatic
        // revalidation GET + PATCH succeeds while Preferences stays healthy on Tab B.
        let (release_tx, release_rx) = bounded(1);
        prefs3.config.set_pre_patch_gate(release_rx);
        prefs3.set_transcript(None, "everything");
        assert!(prefs3.poll());
        prefs3.observe_conversation_clients(&[(tab_b3_id.clone(), true)]);
        assert!(prefs3.transcript_ready());
        drop(sse_a3);
        timeout(Duration::from_secs(4), async {
            while drop_client3.transport_drops(&tab_a3_id) == 0 {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("departing Tab A drop must be recorded");
        let _ = release_tx.send(()).await;
        let mut got_get = false;
        let mut got_patch = false;
        let mut _reconnects = Vec::new();
        timeout(Duration::from_secs(5), async {
            while !(got_get && got_patch) {
                let req = poll_next_request(&mut prefs3, &listener3).await;
                if req.first == "GET /api/meta HTTP/1.1" {
                    req.reply(
                        200,
                        json!({"apiContract":1,"serverId":"fixture-3","capabilities":["settings-atomic-patches"]}),
                    )
                    .await;
                } else if req.first.starts_with("GET /api/events?") {
                    _reconnects.push(req);
                } else if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                    got_get = true;
                    req.reply(200, json!({"settings":{"locale":"en"}})).await;
                } else if req.first == "PATCH /api/storage/config/ui HTTP/1.1" {
                    assert!(got_get, "revalidation GET must precede requeued PATCH");
                    got_patch = true;
                    let mut everything = transcript_preset::patch("everything");
                    everything["locale"] = json!("en");
                    req.reply(200, json!({"settings":everything})).await;
                }
            }
        })
        .await
        .expect("Skip::Transport after healthy tab switch must auto-revalidate and send");
        wait_until(|| {
            prefs3.poll();
            prefs3.transcript_preset() == "everything" && prefs3.transcript_ready()
        })
        .await;
        let _ = commands_a3.send(Command::Close).await;
    });

    // 4. Rapid preset changes and dozens of row toggles coalesce to at most 2 unsent batches
    // ([Preset, Rows]), keeping controls responsive and flushing cleanly without overflow.
    let (listener4, mut prefs4) = platform::block_on(fixture_atomic());
    platform::block_on(async {
        prefs4.set_transcript(None, "minimal");
        assert!(prefs4.poll());
        let in_flight = request(&listener4).await;
        // Identical preset while in flight and queue empty must deduplicate.
        let rev_before = prefs4.revision;
        prefs4.set_transcript(None, "minimal");
        assert_eq!(
            prefs4.revision, rev_before,
            "duplicate in-flight preset must not enqueue a second PATCH"
        );
        // Alternating presets supersede each other; trailing row edits coalesce into one batch.
        prefs4.set_transcript(None, "balanced");
        prefs4.set_transcript(None, "nothing");
        prefs4.set_transcript(None, "everything");
        for i in 0..80 {
            assert!(prefs4.transcript_ready());
            prefs4.set_transcript(
                Some(Row::Diagnostics),
                if i % 2 == 0 { "hidden" } else { "collapsed" },
            );
        }
        prefs4.set_transcript(Some(Row::Groups), "hidden");
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        in_flight.reply(200, json!({"settings":minimal})).await;

        let coalesced_preset = poll_next_request(&mut prefs4, &listener4).await;
        assert_eq!(
            coalesced_preset.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "everything"
        );
        let mut everything = transcript_preset::patch("everything");
        everything["locale"] = json!("en");
        coalesced_preset
            .reply(200, json!({"settings":everything.clone()}))
            .await;

        let coalesced_rows = poll_next_request(&mut prefs4, &listener4).await;
        assert_eq!(
            coalesced_rows.body,
            json!({"settings":{"diagnosticsExpansion":"collapsed","toolGroupVisibility":"hidden"}})
        );
        everything["diagnosticsExpansion"] = json!("collapsed");
        everything["toolGroupVisibility"] = json!("hidden");
        coalesced_rows
            .reply(200, json!({"settings":everything}))
            .await;
        wait_until(|| {
            prefs4.poll();
            prefs4.transcript_mode(Row::Diagnostics, false) == "collapsed"
                && prefs4.transcript_mode(Row::Groups, false) == "hidden"
        })
        .await;
    });

    // 5. HistoryInvalidated (turn cancel/history reload while SSE stays open) must NOT simulate
    // an SSE outage or leave Chat disabled when history finishes reloading.
    let mut root = crate::init();
    let (events_tx, incoming_rx) = bounded(8);
    root.incoming = Some(incoming_rx);
    let backend5 = Backend::unauthenticated("http://127.0.0.1:1").unwrap();
    events_tx.try_send(Event::Connected(backend5)).unwrap();
    assert!(crate::poll_chat(&mut root, 4));
    {
        let mut prefs = root.settings.shared.borrow_mut();
        prefs.fixture();
        prefs.observe_conversation_clients(&crate::workspace::conversation_stream_clients(&root));
        assert!(prefs.transcript_ready());
    }
    events_tx.try_send(Event::HistoryInvalidated).unwrap();
    assert!(crate::poll_chat(&mut root, 4));
    assert!(root.phase == crate::Phase::Reconnecting);
    {
        let mut prefs = root.settings.shared.borrow_mut();
        prefs.observe_conversation_clients(&crate::workspace::conversation_stream_clients(&root));
        assert!(
            prefs.transcript_ready(),
            "HistoryInvalidated over an open SSE stream must not mark transport lost"
        );
    }

    // 6. On a legacy server without settings-atomic-patches, starting from a stale `custom`
    // snapshot with a pending SSE invalidation (another client switched to `detailed`) must run
    // an authoritative GET before editing `read` so `skill`/`invalid` stay collapsed.
    let (listener6, mut prefs6) = platform::block_on(fixture());
    prefs6.config.snapshot = Some(json!({
        "settings": {
            "locale": "en",
            "toolOutputExpansion": "collapsed",
            "toolCallExpansionDefaults": { "preset": "custom", "tools": { "read": "collapsed" } }
        }
    }));
    platform::block_on(async {
        prefs6.invalidate(Owner::Config);
        prefs6.set_transcript(Some(Row::Tool("read")), "expanded");
        assert!(prefs6.poll());
        let preflight = request(&listener6).await;
        assert_eq!(
            preflight.first, "GET /api/storage/config/ui?authoritative=1 HTTP/1.1",
            "legacy client must re-read before editing read when SSE invalidated a custom snapshot"
        );
        preflight
            .reply(
                200,
                json!({"settings":{"locale":"en","toolCallExpansionDefaults":{"preset":"detailed"}}}),
            )
            .await;
        let legacy_patch = poll_next_request(&mut prefs6, &listener6).await;
        assert_eq!(legacy_patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            legacy_patch.body["settings"]["toolCallExpansionDefaults"]["tools"]["read"],
            "expanded"
        );
        assert_eq!(
            legacy_patch.body["settings"]["toolCallExpansionDefaults"]["tools"]["skill"],
            "collapsed"
        );
        assert_eq!(
            legacy_patch.body["settings"]["toolCallExpansionDefaults"]["tools"]["invalid"],
            "collapsed"
        );
        assert_eq!(
            legacy_patch.body["settings"]["toolCallExpansionDefaults"]["tools"]["bash"],
            "expanded"
        );
        let body = legacy_patch.body.clone();
        legacy_patch.reply(200, body).await;
        wait_until(|| {
            prefs6.poll();
            prefs6.transcript_mode(Row::Tool("read"), false) == "expanded"
        })
        .await;
    });
}

#[test]
fn independent_row_sends_after_row_failure_flush_revalidates_held_patch_and_hidden_drop_allows_active_save()
 {
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    // 1. Failing one transcript row must NOT block editing and saving another independent row.
    let (listener1, mut prefs1) = platform::block_on(fixture());
    platform::block_on(async {
        prefs1.set_transcript(Some(Row::Groups), "hidden");
        assert!(prefs1.poll());
        let failed = request(&listener1).await;
        assert_eq!(
            failed.body,
            json!({"settings":{"toolGroupVisibility":"hidden"}})
        );
        failed.reply(503, json!({})).await;
        let readback = request(&listener1).await;
        readback
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;
        wait_until(|| {
            prefs1.poll();
            prefs1.transcript_error().is_some()
        })
        .await;
        prefs1.set_transcript(Some(Row::Diagnostics), "hidden");
        assert!(prefs1.poll());
        let other_row = poll_next_request(&mut prefs1, &listener1).await;
        assert_eq!(other_row.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            other_row.body,
            json!({"settings":{"diagnosticsExpansion":"hidden"}})
        );
        other_row
            .reply(
                200,
                json!({"settings":{"locale":"en","diagnosticsExpansion":"hidden"}}),
            )
            .await;
        wait_until(|| {
            prefs1.poll();
            prefs1.transcript_mode(Row::Diagnostics, false) == "hidden"
        })
        .await;
        assert!(
            prefs1.transcript_error().is_some(),
            "earlier failed row must stay visible for Retry"
        );
    });

    // 2. flush() with the ONLY pending choice held in flight before send, when active SSE drops,
    // must revalidate and persist the choice rather than abandoning it.
    let (listener2, mut prefs2) = platform::block_on(fixture());
    let mut tab2 = prefs2.backend.clone().unwrap();
    tab2.client_id.push_str("-flush-held");
    tab2.workspace = "project".into();
    tab2.session = "session".into();
    let tab2_id = tab2.client_id.clone();
    prefs2.observe_conversation_clients(&[(tab2_id.clone(), true)]);
    let (out2, events2) = bounded(16);
    let (commands2, input2) = bounded(4);
    let drop_client2 = prefs2.backend.as_ref().unwrap().client.clone();
    let (release_tx, release_rx) = bounded(1);
    platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(tab2, out2, input2, Arc::new(|| {})).await;
        });
        let mut sse2 = request(&listener2).await;
        sse2.socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener2)
            .await
            .reply(
                200,
                json!({
                    "status":"window",
                    "messages":[{"id":"recent","type":"user","text":"recent"}],
                    "older":null,"newer":null,"latest":true
                }),
            )
            .await;
        request(&listener2)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events2.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        prefs2.config.set_pre_patch_gate(release_rx);
        prefs2.set_transcript(Some(Row::Groups), "hidden");
        assert!(prefs2.poll());
        drop(sse2);
        timeout(Duration::from_secs(4), async {
            while drop_client2.transport_drops(&tab2_id) == 0 {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    });
    let server_thread = std::thread::spawn(move || {
        platform::block_on(async move {
            let _ = release_tx.send(()).await;
            let mut got_get = false;
            let mut got_patch = false;
            let mut _reconnects = Vec::new();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !(got_get && got_patch) {
                assert!(
                    std::time::Instant::now() < deadline,
                    "flush must revalidate and send the skipped in-flight write"
                );
                let req = request(&listener2).await;
                if req.first.starts_with("GET /api/events?") {
                    _reconnects.push(req);
                } else if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                    let hold_until = std::time::Instant::now() + Duration::from_millis(30);
                    while std::time::Instant::now() < hold_until {
                        if let Ok(accepted) =
                            timeout(Duration::from_millis(5), listener2.accept()).await
                        {
                            let (socket, _) = accepted.unwrap();
                            let concurrent = read_request(socket, Duration::from_secs(3)).await;
                            assert_ne!(
                                concurrent.first, "PATCH /api/storage/config/ui HTTP/1.1",
                                "flush() must not dispatch PATCH while revalidation GET is open"
                            );
                            if concurrent.first.starts_with("GET /api/events?") {
                                _reconnects.push(concurrent);
                            } else if concurrent.first
                                == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1"
                            {
                                concurrent
                                    .reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                                    .await;
                            }
                        }
                    }
                    got_get = true;
                    req.reply(200, json!({"settings":{"locale":"en"}})).await;
                } else if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                    req.reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                        .await;
                } else if req.first == "PATCH /api/storage/config/ui HTTP/1.1" {
                    assert!(got_get, "revalidation GET must precede skipped write");
                    assert_eq!(
                        req.body,
                        json!({"settings":{"toolGroupVisibility":"hidden"}})
                    );
                    got_patch = true;
                    req.reply(
                        200,
                        json!({"settings":{"locale":"en","toolGroupVisibility":"hidden"}}),
                    )
                    .await;
                }
            }
            let _ = commands2.send(Command::Close).await;
        });
    });
    assert!(
        prefs2.flush(),
        "flush() must revalidate and persist a held in-flight write after active SSE drop"
    );
    server_thread.join().unwrap();

    // 3. With a live active Tab A SSE stream, Tab B shares that single /api/events stream;
    // closing hidden Tab B voluntarily keeps Tab A's shared SSE open without bumping global
    // drop_gen, and Tab A saves cleanly.
    let (listener3, mut prefs3) = platform::block_on(fixture_atomic());
    let mut tab_a = prefs3.backend.clone().unwrap();
    tab_a.client_id.push_str("-active-a");
    tab_a.workspace = "project".into();
    tab_a.session = "session-a".into();
    let mut tab_b = prefs3.backend.clone().unwrap();
    tab_b.client_id.push_str("-hidden-b");
    tab_b.workspace = "project".into();
    tab_b.session = "session-b".into();
    let tab_a_id = tab_a.client_id.clone();
    prefs3.observe_conversation_clients(&[(tab_a_id.clone(), true)]);
    let (out_a, events_a) = bounded(16);
    let (commands_a, input_a) = bounded(4);
    let (out_b, events_b) = bounded(16);
    let (commands_b, input_b) = bounded(4);
    let client3 = prefs3.backend.as_ref().unwrap().client.clone();
    platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(tab_a, out_a, input_a, Arc::new(|| {})).await;
        });
        let meta_a = request(&listener3).await;
        assert_eq!(meta_a.first, "GET /api/meta HTTP/1.1");
        meta_a
            .reply(
                200,
                json!({"apiContract":1,"serverId":"fixture-b3","capabilities":["settings-atomic-patches"]}),
            )
            .await;
        let mut sse_a = request(&listener3).await;
        assert!(
            sse_a.first.starts_with("GET /api/events?"),
            "expected initial shared SSE open, got {}",
            sse_a.first
        );
        sse_a
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener3)
            .await
            .reply(
                200,
                json!({"status":"window","messages":[{"id":"a","type":"user","text":"a"}],"older":null,"newer":null,"latest":true}),
            )
            .await;
        request(&listener3)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_a.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        platform::spawn(async move {
            let _ = run_backend(tab_b, out_b, input_b, Arc::new(|| {})).await;
        });
        let meta_b = request(&listener3).await;
        assert_eq!(meta_b.first, "GET /api/meta HTTP/1.1");
        meta_b
            .reply(
                200,
                json!({"apiContract":1,"serverId":"fixture-b3","capabilities":["settings-atomic-patches"]}),
            )
            .await;
        // Tab B reuses Tab A's physical /api/events stream and proceeds directly to HTTP sync.
        let history_b = request(&listener3).await;
        assert!(
            !history_b.first.starts_with("GET /api/events?"),
            "second tab must share existing /api/events stream, got {}",
            history_b.first
        );
        history_b
            .reply(
                200,
                json!({"status":"window","messages":[{"id":"b","type":"user","text":"b"}],"older":null,"newer":null,"latest":true}),
            )
            .await;
        request(&listener3)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        let _ = commands_b.send(Command::Close).await;
        timeout(Duration::from_secs(4), async {
            while events_b.recv().await.is_ok() {}
        })
        .await
        .unwrap();
        assert!(
            !client3.needs_capability_recheck(),
            "closing hidden Tab B while active Tab A SSE is open must not trigger global capability recheck"
        );
        prefs3.set_transcript(Some(Row::Groups), "hidden");
        assert!(prefs3.poll());
        let mut saved = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while !saved {
            assert!(
                std::time::Instant::now() < deadline,
                "active Tab A must save cleanly while shared SSE remains open"
            );
            let req = poll_next_request(&mut prefs3, &listener3).await;
            if req.first == "GET /api/meta HTTP/1.1" {
                req.reply(
                    200,
                    json!({"apiContract":1,"serverId":"fixture-b3","capabilities":["settings-atomic-patches"]}),
                )
                .await;
            } else if req.first == "PATCH /api/storage/config/ui HTTP/1.1" {
                assert_eq!(
                    req.body,
                    json!({"settings":{"toolGroupVisibility":"hidden"}})
                );
                req.reply(
                    200,
                    json!({"settings":{"locale":"en","toolGroupVisibility":"hidden"}}),
                )
                .await;
                saved = true;
            } else {
                panic!(
                    "unexpected request while shared SSE stays open: {}",
                    req.first
                );
            }
        }
        wait_until(|| {
            prefs3.poll();
            prefs3.transcript_mode(Row::Groups, false) == "hidden"
        })
        .await;
        let _ = commands_a.send(Command::Close).await;
        drop(sse_a);
    });
}

#[test]
fn tab_switch_after_active_sse_drop_still_reattests_server_before_revalidation() {
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    let (listener, mut prefs) = platform::block_on(fixture());
    let base = prefs.backend.clone().unwrap();
    let mut tab_a = base.clone();
    tab_a.client_id.push_str("-active-a");
    tab_a.workspace = "project".into();
    tab_a.session = "session-a".into();
    let mut tab_b = base.clone();
    tab_b.client_id.push_str("-sibling-b");
    tab_b.workspace = "project".into();
    tab_b.session = "session-b".into();
    let tab_a_id = tab_a.client_id.clone();
    let tab_b_id = tab_b.client_id.clone();
    let client = base.client.clone();
    platform::block_on(async {
        attest(&listener, &base, "server-a").await;
        prefs.observe_conversation_clients(&[(tab_a_id.clone(), true)]);
        let (out_a, events_a) = bounded(16);
        let (commands_a, input_a) = bounded(4);
        let (out_b, events_b) = bounded(16);
        let (commands_b, input_b) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(tab_a, out_a, input_a, Arc::new(|| {})).await;
        });
        let meta_a = request(&listener).await;
        assert_eq!(meta_a.first, "GET /api/meta HTTP/1.1");
        meta_a
            .reply(200, json!({"apiContract":1,"serverId":"server-a"}))
            .await;
        let mut sse_a = request(&listener).await;
        sse_a
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener)
            .await
            .reply(
                200,
                json!({"status":"window","messages":[{"id":"a","type":"user","text":"a"}],"older":null,"newer":null,"latest":true}),
            )
            .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_a.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        platform::spawn(async move {
            let _ = run_backend(tab_b, out_b, input_b, Arc::new(|| {})).await;
        });
        let meta_b = request(&listener).await;
        assert_eq!(meta_b.first, "GET /api/meta HTTP/1.1");
        meta_b
            .reply(200, json!({"apiContract":1,"serverId":"server-a"}))
            .await;
        let history_b = request(&listener).await;
        assert!(
            !history_b.first.starts_with("GET /api/events?"),
            "sibling tab must share existing /api/events stream, got {}",
            history_b.first
        );
        history_b
            .reply(
                200,
                json!({"status":"window","messages":[{"id":"b","type":"user","text":"b"}],"older":null,"newer":null,"latest":true}),
            )
            .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }

        // Drop the shared SSE stream, then switch directly to sibling tab B BEFORE calling
        // prefs.poll(): it must still observe the drop, disable Chat, and force /api/meta
        // re-attestation before any GET or PATCH.
        drop(sse_a);
        timeout(Duration::from_secs(4), async {
            while client.transport_drops(&tab_a_id) == 0 {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();

        prefs.observe_conversation_clients(&[(tab_b_id.clone(), true)]);
        assert!(
            !prefs.transcript_ready(),
            "switching away from a dropped tab before poll must still disable Chat"
        );
        prefs.revalidate_transport();
        let mut _reconnects = Vec::new();
        let mut saw_meta = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while !saw_meta {
            assert!(
                std::time::Instant::now() < deadline,
                "revalidation after switching to sibling tab must call /api/meta"
            );
            let req = poll_next_request(&mut prefs, &listener).await;
            if req.first.starts_with("GET /api/events?") {
                _reconnects.push(req);
            } else if req.first == "GET /api/meta HTTP/1.1" {
                saw_meta = true;
                req.reply(200, json!({"apiContract":1,"serverId":"server-b"}))
                    .await;
            } else {
                panic!(
                    "must not read or write preferences before /api/meta re-attestation, got: {}",
                    req.first
                );
            }
        }
        // Mismatched serverId ("server-b" != "server-a") must keep preferences unconfirmed and
        // never issue GET /api/storage/config/ui.
        let check_until = std::time::Instant::now() + Duration::from_millis(80);
        while std::time::Instant::now() < check_until {
            prefs.poll();
            if let Ok(req) = timeout(Duration::from_millis(10), request(&listener)).await {
                if req.first.starts_with("GET /api/events?") {
                    _reconnects.push(req);
                } else if req.first == "GET /api/meta HTTP/1.1" {
                    req.reply(200, json!({"apiContract":1,"serverId":"server-b"}))
                        .await;
                } else {
                    panic!(
                        "mismatched serverId must block config readback, got: {}",
                        req.first
                    );
                }
            }
        }
        assert!(
            !prefs.transcript_ready(),
            "mismatched serverId after tab switch must not re-enable Chat"
        );
        let _ = commands_a.send(Command::Close).await;
        let _ = commands_b.send(Command::Close).await;
    });
}

#[test]
fn hidden_connected_event_does_not_overwrite_healthy_active_tab_or_custom_preset_display() {
    // 1. Custom saved preset matching Balanced except Diagnostics stays "custom" while
    // Diagnostics is edited back to "expanded" (matching Solid's selectedPreset).
    let mut custom_prefs = Preferences::default();
    custom_prefs.fixture_transcript(json!({
        "toolGroupVisibility": "collapsed",
        "systemMessagesVisibility": "hidden",
        "showThinkingBlocks": false,
        "diagnosticsExpansion": "collapsed",
        "toolInputsVisibility": "collapsed",
        "showUsageMetrics": false,
        "usageMetricsExpansion": "collapsed",
        "toolCallExpansionDefaults": {
            "preset": "custom",
            "thinking": "collapsed",
            "tools": {
                "bash": "expanded", "read": "collapsed", "write": "expanded",
                "edit": "expanded", "patch": "expanded", "webfetch": "collapsed",
                "websearch": "collapsed", "glob": "collapsed", "grep": "collapsed",
                "task": "expanded", "execute": "expanded", "skill": "collapsed",
                "question": "expanded", "invalid": "collapsed", "other": "collapsed"
            }
        }
    }));
    assert_eq!(custom_prefs.transcript_preset(), "custom");
    custom_prefs
        .config
        .stage(Choice::TranscriptRow(Row::Diagnostics), "expanded");
    assert_eq!(
        custom_prefs.transcript_preset_display(),
        "custom",
        "editing Diagnostics on a saved custom preset must stay custom while in flight"
    );

    // 2. Hidden tab processing Event::Connected when active tab already has a healthy stream
    // must NOT rebind or replace observed_clients with the hidden tab.
    let mut root = crate::init();
    let backend_a = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    let mut backend_b = backend_a.clone();
    backend_b.client_id = "tab-b".into();
    let active_id = backend_a.client_id.clone();
    {
        let mut prefs = root.settings.shared.borrow_mut();
        prefs.bind(Some(backend_a));
        prefs.fixture_transcript(json!({"diagnosticsExpansion":"expanded"}));
        prefs.transport_lost = false;
        prefs.observe_conversation_clients(&[(active_id.clone(), true)]);
        assert!(prefs.transcript_ready());
    }
    let (tx, rx) = bounded(4);
    tx.try_send(crate::transport::Event::Connected(backend_b))
        .unwrap();
    root.incoming = Some(rx);
    crate::chat::events::poll_hidden_chat(&mut root, 8, true);
    let prefs = root.settings.shared.borrow();
    assert_eq!(
        prefs.backend.as_ref().map(|b| b.client_id.as_str()),
        Some(active_id.as_str()),
        "hidden Event::Connected must not rebind preferences away from healthy active tab"
    );
    assert!(
        prefs.transcript_ready(),
        "hidden Event::Connected must not disrupt healthy active tab"
    );

    // 3. With two open tabs on Server A, dropping ONLY hidden tab B while active tab A's SSE
    // stays open must attest /api/meta when tab B reconnects; if the endpoint switched to Server B,
    // tab B's mismatch revokes shared attestation immediately so no Preferences PATCH reaches B.
    platform::block_on(async {
        use crate::transport::{Command, Event, run_backend};
        use std::sync::Arc;
        let (listener, mut prefs) = fixture().await;
        let base = prefs.backend.clone().unwrap();
        let client = base.client.clone();
        let mut tab_a = base.clone();
        tab_a.client_id = "reconnect-tab-a".into();
        let mut tab_b = base.clone();
        tab_b.client_id = "reconnect-tab-b".into();
        attest(&listener, &base, "server-a").await;
        prefs.observe_conversation_clients(&[(tab_a.client_id.clone(), true)]);
        let (out_a, events_a) = bounded(16);
        let (commands_a, input_a) = bounded(4);
        let (out_b, events_b) = bounded(16);
        let (commands_b, input_b) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(tab_a, out_a, input_a, Arc::new(|| {})).await;
        });
        let meta_a = request(&listener).await;
        assert_eq!(meta_a.first, "GET /api/meta HTTP/1.1");
        meta_a
            .reply(200, json!({"apiContract":1,"serverId":"server-a"}))
            .await;
        let mut sse_a = request(&listener).await;
        sse_a
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener)
            .await
            .reply(
                200,
                json!({"status":"window","messages":[{"id":"a","type":"user","text":"a"}],"older":null,"newer":null,"latest":true}),
            )
            .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_a.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        platform::spawn(async move {
            let _ = run_backend(tab_b, out_b, input_b, Arc::new(|| {})).await;
        });
        let meta_b = request(&listener).await;
        assert_eq!(meta_b.first, "GET /api/meta HTTP/1.1");
        meta_b
            .reply(200, json!({"apiContract":1,"serverId":"server-a"}))
            .await;
        let history_b = request(&listener).await;
        assert!(
            !history_b.first.starts_with("GET /api/events?"),
            "second tab must share existing /api/events stream, got {}",
            history_b.first
        );
        history_b
            .reply(
                200,
                json!({"status":"window","messages":[{"id":"b","type":"user","text":"b"}],"older":null,"newer":null,"latest":true}),
            )
            .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        // 3a. While the shared SSE socket is STILL OPEN (no global transport drop), a foreign
        // /api/meta mismatch ("server-b") must revoke shared attestation immediately so no
        // Preferences PATCH reaches Server B.
        let probe_backend = base.clone();
        platform::spawn(async move {
            let _ = probe_backend.attest_server().await;
        });
        let mismatch_meta = timeout(Duration::from_secs(4), request(&listener))
            .await
            .expect("probe must request /api/meta");
        assert_eq!(mismatch_meta.first, "GET /api/meta HTTP/1.1");
        mismatch_meta
            .reply(200, json!({"apiContract":1,"serverId":"server-b"}))
            .await;
        wait_until(|| client.needs_capability_recheck()).await;
        // Now attempt a Preferences write while the old SSE socket is still open:
        // it must NOT send SSE or PATCH to Server B, only /api/meta.
        prefs.set_transcript(None, "minimal");
        assert!(prefs.poll());
        let deadline = std::time::Instant::now() + Duration::from_millis(120);
        while std::time::Instant::now() < deadline {
            prefs.poll();
            if let Ok(req) = timeout(Duration::from_millis(15), request(&listener)).await {
                if req.first == "GET /api/meta HTTP/1.1" {
                    req.reply(200, json!({"apiContract":1,"serverId":"server-b"}))
                        .await;
                } else {
                    panic!(
                        "foreign server must not receive SSE or settings PATCH after foreign attestation while SSE is open, got: {}",
                        req.first
                    );
                }
            }
        }
        // 3b. Dropping the shared SSE stream must also attest /api/meta before reopening SSE.
        drop(sse_a);
        let reconnect_meta = timeout(Duration::from_secs(4), request(&listener))
            .await
            .expect("reconnect must attest /api/meta before reopening SSE");
        assert_eq!(reconnect_meta.first, "GET /api/meta HTTP/1.1");
        reconnect_meta
            .reply(200, json!({"apiContract":1,"serverId":"server-b"}))
            .await;
        let _ = commands_a.send(Command::Close).await;
        let _ = commands_b.send(Command::Close).await;
    });

    // 4. An in-flight GET whose server attestation is revoked mid-flight must be discarded and
    // never overwrite the confirmed snapshot with foreign-server data.
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let base = prefs.backend.clone().unwrap();
        let client = base.client.clone();
        attest(&listener, &base, "server-a").await;
        prefs.fixture_transcript(json!({"diagnosticsExpansion":"expanded"}));
        prefs.invalidate(Owner::Config);
        assert!(prefs.poll());
        let held_get = request(&listener).await;
        assert_eq!(
            held_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        // Revoke shared attestation while the GET is still in flight.
        let probe_backend = base.clone();
        platform::spawn(async move {
            let _ = probe_backend.attest_server().await;
        });
        let mismatch_meta = request(&listener).await;
        assert_eq!(mismatch_meta.first, "GET /api/meta HTTP/1.1");
        mismatch_meta
            .reply(200, json!({"apiContract":1,"serverId":"server-b"}))
            .await;
        wait_until(|| client.needs_capability_recheck()).await;
        // Now return foreign Server B data on the already-dispatched GET.
        held_get
            .reply(
                200,
                json!({"settings":{"locale":"fr","diagnosticsExpansion":"hidden"}}),
            )
            .await;
        let deadline = std::time::Instant::now() + Duration::from_millis(120);
        while std::time::Instant::now() < deadline {
            prefs.poll();
            if let Ok(req) = timeout(Duration::from_millis(15), request(&listener)).await {
                if req.first == "GET /api/meta HTTP/1.1" {
                    req.reply(200, json!({"apiContract":1,"serverId":"server-b"}))
                        .await;
                } else {
                    panic!(
                        "revoked server must not receive another config read, got: {}",
                        req.first
                    );
                }
            }
        }
        assert_eq!(
            prefs.transcript_mode(Row::Diagnostics, false),
            "expanded",
            "in-flight GET completed after attestation revocation must not overwrite snapshot"
        );
        assert!(
            !prefs.transcript_ready(),
            "revoked attestation must disable preferences writes"
        );
    });

    // 5. Incompatible apiContract on a second probe revokes shared Server A attestation so no
    // PATCH from an open tab reaches the foreign server; voluntary SSE close + same-server
    // re-attestation fences a pre-close held PATCH via prepared_gen; recovered hidden tab
    // baselines its drop count; and flush() after voluntary SSE close revalidates and persists.
    platform::block_on(async {
        let (listener, prefs) = fixture().await;
        let base = prefs.backend.clone().unwrap();
        let client = base.client.clone();
        attest(&listener, &base, "server-a").await;
        assert!(!client.needs_capability_recheck());
        let probe = base.clone();
        let (err_tx, err_rx) = bounded(1);
        platform::spawn(async move {
            let _ = err_tx.send(probe.attest_server().await.is_err()).await;
        });
        let incompat = request(&listener).await;
        assert_eq!(incompat.first, "GET /api/meta HTTP/1.1");
        incompat
            .reply(200, json!({"apiContract":2,"serverId":"server-b"}))
            .await;
        assert!(err_rx.recv().await.unwrap());
        assert!(
            client.needs_capability_recheck(),
            "incompatible apiContract from foreign server must revoke shared attestation"
        );
        // A 404 /api/meta on a re-probe after attestation also revokes shared attestation.
        attest(&listener, &base, "server-a").await;
        assert!(!client.needs_capability_recheck());
        let probe_404 = base.clone();
        let (err404_tx, err404_rx) = bounded(1);
        platform::spawn(async move {
            let _ = err404_tx
                .send(probe_404.attest_server().await.is_err())
                .await;
        });
        let not_found = request(&listener).await;
        assert_eq!(not_found.first, "GET /api/meta HTTP/1.1");
        not_found.reply(404, json!({})).await;
        assert!(err404_rx.recv().await.unwrap());
        assert!(
            client.needs_capability_recheck(),
            "404 /api/meta must revoke shared attestation"
        );
        // Recovered hidden tab baselines its drop count so closing the original active tab later
        // does not leave Preferences stuck in transport_lost.
        let (listener2, mut prefs2) = fixture().await;
        let tab_a_id = "rec-tab-a".to_owned();
        let tab_b_id = "rec-tab-b".to_owned();
        prefs2.observe_conversation_clients(&[(tab_a_id.clone(), true), (tab_b_id.clone(), true)]);
        let mut tab_b_backend = prefs2.backend.clone().unwrap();
        tab_b_backend.client_id = tab_b_id.clone();
        let (out_b, events_b) = bounded(16);
        let (cmd_b, in_b) = bounded(4);
        platform::spawn(async move {
            let _ = crate::transport::run_backend(
                tab_b_backend,
                out_b,
                in_b,
                std::sync::Arc::new(|| {}),
            )
            .await;
        });
        let mut sse_b = request(&listener2).await;
        sse_b
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener2)
            .await
            .reply(200, json!({"status":"window","messages":[{"id":"b","type":"user","text":"b"}],"older":null,"newer":null,"latest":true}))
            .await;
        request(&listener2)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                crate::transport::Event::Sync(_)
            ) {
                break;
            }
        }
        drop(sse_b);
        let client2 = prefs2.backend.as_ref().unwrap().client.clone();
        wait_until(|| client2.transport_drops(&tab_b_id) == 1).await;
        prefs2.observe_conversation_clients(&[(tab_a_id.clone(), true), (tab_b_id.clone(), false)]);
        prefs2.observe_conversation_clients(&[(tab_a_id.clone(), true), (tab_b_id.clone(), true)]);
        prefs2.observe_conversation_clients(&[(tab_b_id.clone(), true)]);
        assert!(
            prefs2.transcript_ready(),
            "closing original active tab after hidden tab recovered must keep Chat ready"
        );
        let _ = cmd_b.send(crate::transport::Command::Close).await;
    });
}

#[test]
fn hidden_tab_reconnect_attestation_and_repeated_outage_and_voluntary_close_and_readback_sse() {
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    platform::block_on(async {
        // 1. Held hidden-tab reconnect /api/meta: saving a masked env var must attest /api/meta
        // (with Cache-Control: no-store) before sending PATCH and never leak the secret to server B.
        let (listener, mut prefs) = fixture_atomic().await;
        let base = prefs.backend.clone().unwrap();
        let mut tab_a = base.clone();
        tab_a.client_id.push_str("-active-a");
        tab_a.workspace = "project".into();
        tab_a.session = "session-a".into();
        let mut tab_b = base.clone();
        tab_b.client_id.push_str("-hidden-b");
        tab_b.workspace = "project".into();
        tab_b.session = "session-b".into();
        let tab_a_id = tab_a.client_id.clone();
        let tab_b_id = tab_b.client_id.clone();
        prefs.observe_conversation_clients(&[(tab_a_id.clone(), true), (tab_b_id.clone(), true)]);
        prefs.show_environment(true);
        assert!(prefs.poll());
        let env_init = request(&listener).await;
        assert_eq!(
            env_init.first,
            "GET /api/storage/config/server?authoritative=1 HTTP/1.1"
        );
        env_init
            .reply(200, json!({"environmentVariables":{},"secureEnvVars":[]}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.environment_ready()
        })
        .await;
        let (out_a, events_a) = bounded(16);
        let (cmd_a, in_a) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(tab_a, out_a, in_a, Arc::new(|| {})).await;
        });
        let (mut meta_a_sock, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 2048];
        let n = meta_a_sock.read(&mut buf).await.unwrap();
        let raw_meta_a = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
        assert!(raw_meta_a.starts_with("get /api/meta http/1.1\r\n"));
        assert!(
            raw_meta_a.contains("cache-control: no-store"),
            "expected Cache-Control: no-store on /api/meta, got:\n{raw_meta_a}"
        );
        let body_a = json!({"apiContract":1,"serverId":"server-a","capabilities":["settings-atomic-patches"]}).to_string();
        meta_a_sock
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body_a.len(),
                    body_a
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        drop(meta_a_sock);
        let mut sse_a = request(&listener).await;
        sse_a
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener)
            .await
            .reply(200, json!({"status":"window","messages":[{"id":"a","type":"user","text":"a"}],"older":null,"newer":null,"latest":true}))
            .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_a.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        let (out_b, events_b) = bounded(16);
        let (cmd_b, in_b) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(tab_b, out_b, in_b, Arc::new(|| {})).await;
        });
        let meta_b = request(&listener).await;
        assert_eq!(meta_b.first, "GET /api/meta HTTP/1.1");
        meta_b
            .reply(200, json!({"apiContract":1,"serverId":"server-a","capabilities":["settings-atomic-patches"]}))
            .await;
        let history_b = request(&listener).await;
        assert!(
            !history_b.first.starts_with("GET /api/events?"),
            "second tab must share existing /api/events stream, got {}",
            history_b.first
        );
        history_b
            .reply(200, json!({"status":"window","messages":[{"id":"b","type":"user","text":"b"}],"older":null,"newer":null,"latest":true}))
            .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        // While the shared SSE is STILL OPEN (attestation valid, no global drop), revoke
        // attestation via foreign /api/meta ("server-b"), then stage a masked secret and verify
        // Preferences itself rejects the write and never leaks "top-secret" in any PATCH.
        let client = prefs.backend.as_ref().unwrap().client.clone();
        assert!(!client.needs_capability_recheck());
        let probe_backend = base.clone();
        platform::spawn(async move {
            let _ = probe_backend.attest_server().await;
        });
        let foreign_probe = request(&listener).await;
        assert_eq!(foreign_probe.first, "GET /api/meta HTTP/1.1");
        foreign_probe
            .reply(200, json!({"apiContract":1,"serverId":"server-b","capabilities":["settings-atomic-patches"]}))
            .await;
        wait_until(|| client.needs_capability_recheck()).await;
        assert!(prefs.stage_environment("API_KEY".into(), Some("top-secret".into()), Some(true),));
        assert!(prefs.poll());
        let pre_patch_meta = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            pre_patch_meta.first, "GET /api/meta HTTP/1.1",
            "Preferences must attest /api/meta before sending a masked secret after foreign revocation"
        );
        pre_patch_meta
            .reply(200, json!({"apiContract":1,"serverId":"server-b","capabilities":["settings-atomic-patches"]}))
            .await;
        wait_until(|| {
            prefs.poll();
            !prefs.environment_ready()
        })
        .await;
        // Now also drop the shared SSE stream and confirm reconnect probes /api/meta without any
        // PATCH ever carrying the masked secret to foreign server-b.
        drop(sse_a);
        wait_until(|| client.transport_drops(&tab_b_id) == 1).await;
        let mut saw_patch = false;
        for _ in 0..4 {
            prefs.poll();
            if let Ok(accepted) = timeout(Duration::from_millis(80), listener.accept()).await {
                let (socket, _) = accepted.unwrap();
                let req = read_request(socket, Duration::from_secs(2)).await;
                if req.first.starts_with("PATCH ") {
                    saw_patch = true;
                }
                req.reply(200, json!({"apiContract":1,"serverId":"server-b","capabilities":["settings-atomic-patches"]})).await;
            }
        }
        assert!(
            !saw_patch,
            "masked secret PATCH must never be sent to foreign server-b"
        );
        assert!(
            !prefs.environment_ready(),
            "Preferences must stay blocked after foreign server-b rejection"
        );
        let _ = cmd_a.send(Command::Close).await;
        let _ = cmd_b.send(Command::Close).await;

        // 2. Active Tab A drops while hidden Tab B is healthy: repeated outage must be detected.
        let (listener2, mut prefs2) = fixture().await;
        let mut ta = prefs2.backend.clone().unwrap();
        ta.client_id.push_str("-rep-a");
        ta.workspace = "project".into();
        ta.session = "session-rep-a".into();
        let ta_id = ta.client_id.clone();
        let tb_id = "rep-tab-b".to_owned();
        prefs2.observe_conversation_clients(&[(ta_id.clone(), true), (tb_id.clone(), true)]);
        let (oa, ea) = bounded(16);
        let (ca, ia) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(ta, oa, ia, Arc::new(|| {})).await;
        });
        let mut sse_rep = request(&listener2).await;
        sse_rep
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener2)
            .await
            .reply(200, json!({"status":"window","messages":[{"id":"a","type":"user","text":"a"}],"older":null,"newer":null,"latest":true}))
            .await;
        request(&listener2)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), ea.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        drop(sse_rep);
        let client2 = prefs2.backend.as_ref().unwrap().client.clone();
        wait_until(|| client2.transport_drops(&ta_id) == 1).await;
        assert!(!prefs2.is_repeated_outage(&ta_id));
        prefs2.note_client_outage(&ta_id);
        prefs2.mark_transport_lost();
        assert!(
            prefs2.is_repeated_outage(&ta_id),
            "subsequent 503 retries for active Tab A must be recognized as repeated outage even while Tab B is healthy"
        );
        let _ = ca.send(Command::Close).await;

        // 3. Voluntary close of last conversation tab on !atomic server + pre-poll catalog
        // re-attestation must still mark Preferences transport_lost before any legacy PATCH.
        let (listener3, mut prefs3) = fixture().await;
        let base3 = prefs3.backend.clone().unwrap();
        attest(&listener3, &base3, "legacy-a").await;
        let mut only_tab = base3.clone();
        only_tab.client_id.push_str("-only");
        only_tab.workspace = "project".into();
        only_tab.session = "session-only".into();
        let (o3, e3) = bounded(16);
        let (c3, i3) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(only_tab, o3, i3, Arc::new(|| {})).await;
        });
        let m3 = request(&listener3).await;
        assert_eq!(m3.first, "GET /api/meta HTTP/1.1");
        m3.reply(
            200,
            json!({"apiContract":1,"serverId":"legacy-a","capabilities":[]}),
        )
        .await;
        let mut sse3 = request(&listener3).await;
        sse3.socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener3)
            .await
            .reply(200, json!({"status":"window","messages":[{"id":"o","type":"user","text":"o"}],"older":null,"newer":null,"latest":true}))
            .await;
        request(&listener3)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), e3.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        let gen_before = base3.client.drop_generation();
        let _ = c3.send(Command::Close).await;
        drop(sse3);
        wait_until(|| base3.client.drop_generation() > gen_before).await;
        // Re-attest before Preferences polls (clearing attestation_revoked()).
        attest(&listener3, &base3, "legacy-a").await;
        assert!(!base3.client.attestation_revoked());
        assert!(prefs3.poll());
        assert!(
            prefs3.is_transport_lost(),
            "voluntary close of last SSE followed by catalog re-attestation must still require revalidation"
        );

        // 4. Lost-receipt PATCH readback started AFTER SSE storage.configChanged confirms cleanly
        // without firing a false failure alert.
        let (listener4, mut prefs4) = fixture().await;
        let mut sse_tab = prefs4.backend.clone().unwrap();
        sse_tab.client_id.push_str("-sse-rb");
        sse_tab.workspace = "project".into();
        sse_tab.session = "session-rb".into();
        let (o4, e4) = bounded(16);
        let (c4, i4) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(sse_tab, o4, i4, Arc::new(|| {})).await;
        });
        let mut sse4 = request(&listener4).await;
        sse4.socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener4)
            .await
            .reply(200, json!({"status":"window","messages":[{"id":"r","type":"user","text":"r"}],"older":null,"newer":null,"latest":true}))
            .await;
        request(&listener4)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), e4.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        prefs4.set_locale("fr");
        assert!(prefs4.poll());
        let patch4 = request(&listener4).await;
        assert_eq!(patch4.first, "PATCH /api/storage/config/ui HTTP/1.1");
        // Server applies PATCH, emits SSE configChanged first, then drops the PATCH socket.
        sse4.socket
            .write_all(b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\"}\n\n")
            .await
            .unwrap();
        loop {
            if matches!(
                timeout(Duration::from_secs(4), e4.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Preferences(Owner::Config)
            ) {
                prefs4.invalidate_from_sse(Owner::Config);
                break;
            }
        }
        drop(patch4);
        let readback4 = request(&listener4).await;
        assert_eq!(
            readback4.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        readback4
            .reply(200, json!({"settings":{"locale":"fr"}}))
            .await;
        wait_until(|| {
            prefs4.poll();
            prefs4.locale() == Some("fr") && !prefs4.config.refreshing()
        })
        .await;
        assert!(
            prefs4.error().is_none(),
            "lost-receipt readback started after SSE invalidation must not report an error"
        );
        assert!(
            !prefs4.take_notification_failure(),
            "lost-receipt readback started after SSE invalidation must not fire a failure toast"
        );

        // 5. Lost-receipt PATCH readback invalidated MID-GET by its own SSE storage.configChanged
        // defers settlement to the follow-up fresh GET and confirms without a false failure toast.
        prefs4.set_transcript(Some(Row::Diagnostics), "hidden");
        assert!(prefs4.poll());
        let diag_patch = request(&listener4).await;
        assert_eq!(diag_patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        drop(diag_patch);
        let first_rb = request(&listener4).await;
        assert_eq!(
            first_rb.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        sse4.socket
            .write_all(b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\"}\n\n")
            .await
            .unwrap();
        loop {
            if matches!(
                timeout(Duration::from_secs(4), e4.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Preferences(Owner::Config)
            ) {
                prefs4.invalidate_from_sse(Owner::Config);
                break;
            }
        }
        first_rb
            .reply(
                200,
                json!({"settings":{"locale":"fr","diagnosticsExpansion":"hidden"}}),
            )
            .await;
        let second_rb = poll_next_request(&mut prefs4, &listener4).await;
        assert_eq!(
            second_rb.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        assert!(
            !prefs4.take_notification_failure(),
            "invalidated readback must not fire a premature failure toast before the follow-up GET"
        );
        second_rb
            .reply(
                200,
                json!({"settings":{"locale":"fr","diagnosticsExpansion":"hidden"}}),
            )
            .await;
        wait_until(|| {
            prefs4.poll();
            prefs4.transcript_mode(Row::Diagnostics, false) == "hidden"
                && !prefs4.config.refreshing()
        })
        .await;
        assert!(prefs4.transcript_error().is_none());
        assert!(!prefs4.take_notification_failure());
        let _ = c4.send(Command::Close).await;
        drop(sse4);

        // 6. When both a preset (Everything) and a following row edit (read -> hidden) fail,
        // Retry must send them as two separate ordered PATCHes (preset first, then row) rather
        // than merging them into one conflicting PATCH.
        let (listener5, mut prefs5) = fixture_atomic().await;
        prefs5.set_transcript(None, "everything");
        assert!(prefs5.poll());
        let p5 = request(&listener5).await;
        prefs5.set_transcript(Some(Row::Tool("read")), "hidden");
        p5.reply(503, json!({})).await;
        let rb5a = request(&listener5).await;
        rb5a.reply(200, json!({"settings":{"locale":"en"}})).await;
        let r5 = poll_next_request(&mut prefs5, &listener5).await;
        assert_eq!(
            r5.first,
            "PATCH /api/storage/config/ui?conditional=atomic-v1 HTTP/1.1"
        );
        r5.reply(503, json!({})).await;
        let rb5b = request(&listener5).await;
        rb5b.reply(200, json!({"settings":{"locale":"en"}})).await;
        wait_until(|| {
            prefs5.poll();
            !prefs5.config.refreshing() && prefs5.transcript_error().is_some()
        })
        .await;
        prefs5.retry_transcript();
        let retry_get5 = poll_next_request(&mut prefs5, &listener5).await;
        assert_eq!(
            retry_get5.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        retry_get5
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;
        let retry_preset5 = poll_next_request(&mut prefs5, &listener5).await;
        assert_eq!(retry_preset5.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            retry_preset5.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "everything"
        );
        let mut saved5 = transcript_preset::patch("everything");
        saved5["locale"] = json!("en");
        retry_preset5
            .reply(200, json!({"settings":saved5.clone()}))
            .await;
        let retry_row5 = poll_next_request(&mut prefs5, &listener5).await;
        assert_eq!(
            retry_row5.first,
            "PATCH /api/storage/config/ui?conditional=atomic-v1 HTTP/1.1"
        );
        assert_eq!(
            retry_row5.body,
            json!({"settings":{"toolCallExpansionDefaults":{"preset":"custom","tools":{"read":"hidden"}}}})
        );
        saved5["toolCallExpansionDefaults"]["preset"] = json!("custom");
        saved5["toolCallExpansionDefaults"]["tools"]["read"] = json!("hidden");
        retry_row5.reply(200, json!({"settings":saved5})).await;
        wait_until(|| {
            prefs5.poll();
            !prefs5.config.refreshing() && prefs5.transcript_error().is_none()
        })
        .await;
        assert_eq!(prefs5.transcript_mode(Row::Tool("read"), false), "hidden");
        assert_eq!(
            prefs5.transcript_mode(Row::Tool("write"), false),
            "expanded"
        );

        // 7. Server downgraded mid-session (SSE stays open) returns 400 on `?conditional=atomic-v1`:
        // Retry must re-attest `/api/meta`, discover `capabilities: []`, and succeed with legacy PATCH.
        let (listener6, mut prefs6) = fixture_atomic().await;
        prefs6.set_transcript(Some(Row::Tool("read")), "expanded");
        assert!(prefs6.poll());
        let bad_atomic = request(&listener6).await;
        assert_eq!(
            bad_atomic.first,
            "PATCH /api/storage/config/ui?conditional=atomic-v1 HTTP/1.1"
        );
        bad_atomic
            .reply(400, json!({"error":"Unknown conditional patch mode"}))
            .await;
        wait_until(|| {
            prefs6.poll();
            !prefs6.config.refreshing() && prefs6.transcript_error().is_some()
        })
        .await;
        assert!(
            prefs6
                .backend
                .as_ref()
                .unwrap()
                .client
                .needs_capability_recheck(),
            "400 on atomic-v1 PATCH must force capability recheck on Retry"
        );
        prefs6.retry_transcript();
        let mut saw_meta6 = false;
        let legacy6 = loop {
            let req = poll_next_request(&mut prefs6, &listener6).await;
            if req.first == "GET /api/meta HTTP/1.1" {
                saw_meta6 = true;
                req.reply(
                    200,
                    json!({"apiContract":1,"serverId":"fixture-atomic","capabilities":[]}),
                )
                .await;
            } else if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                req.reply(200, json!({"settings":{"locale":"en"}})).await;
            } else if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                req.reply(200, json!({})).await;
            } else {
                break req;
            }
        };
        assert!(
            saw_meta6,
            "Retry must re-attest /api/meta after atomic-v1 400"
        );
        assert_eq!(
            legacy6.first, "PATCH /api/storage/config/ui HTTP/1.1",
            "Retry after downgrade must fall back to non-atomic PATCH"
        );
        let mut legacy_saved = legacy6.body["settings"].clone();
        legacy_saved["locale"] = json!("en");
        legacy6.reply(200, json!({"settings":legacy_saved})).await;
        wait_until(|| {
            prefs6.poll();
            !prefs6.config.refreshing() && prefs6.transcript_error().is_none()
        })
        .await;
        assert_eq!(prefs6.transcript_mode(Row::Tool("read"), false), "expanded");

        // 8. Staging update feed after an SSE disconnect queues server revalidation GET so Info
        // never gets stuck disabled when HTTP still works.
        let (listener7, mut prefs7) = fixture().await;
        prefs7.mark_transport_lost();
        prefs7.stage_update_feed("preview");
        assert!(prefs7.poll());
        let srv_get = poll_next_request(&mut prefs7, &listener7).await;
        assert_eq!(
            srv_get.first,
            "GET /api/storage/config/server?authoritative=1 HTTP/1.1"
        );
        srv_get.reply(200, json!({"updateFeed":"stable"})).await;
        let srv_patch = poll_next_request(&mut prefs7, &listener7).await;
        assert_eq!(srv_patch.first, "PATCH /api/storage/config/server HTTP/1.1");
        assert_eq!(srv_patch.body, json!({"updateFeed":"preview"}));
        srv_patch.reply(200, json!({"updateFeed":"preview"})).await;
        wait_until(|| {
            prefs7.poll();
            !prefs7.update_feed_pending()
        })
        .await;
        assert!(!prefs7.update_feed_failed());

        // 9. General tab exposes transport_lost error and staging locale after SSE loss queues
        // revalidation GET so saves complete when HTTP still responds.
        let (listener8, mut prefs8) = fixture().await;
        prefs8.mark_transport_lost();
        assert_eq!(prefs8.general_error(), Some("rune.connect_error"));
        prefs8.set_locale("fr");
        assert!(prefs8.poll());
        let g8 = poll_next_request(&mut prefs8, &listener8).await;
        assert_eq!(
            g8.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        g8.reply(200, json!({"settings":{"locale":"en"}})).await;
        let p8 = loop {
            let req = poll_next_request(&mut prefs8, &listener8).await;
            if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                req.reply(200, json!({})).await;
            } else {
                break req;
            }
        };
        assert_eq!(p8.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(p8.body, json!({"settings":{"locale":"fr"}}));
        p8.reply(200, json!({"settings":{"locale":"fr"}})).await;
        wait_until(|| {
            prefs8.poll();
            prefs8.locale() == Some("fr") && !prefs8.config.refreshing()
        })
        .await;
        assert!(prefs8.general_error().is_none());

        // 10. Held 400 on `?conditional=atomic-v1` must NOT revoke a newer `/api/meta` attestation.
        let (listener9, mut prefs9) = fixture_atomic().await;
        let base9 = prefs9.backend.clone().unwrap();
        prefs9.set_transcript(Some(Row::Tool("read")), "expanded");
        assert!(prefs9.poll());
        let held_400 = request(&listener9).await;
        assert_eq!(
            held_400.first,
            "PATCH /api/storage/config/ui?conditional=atomic-v1 HTTP/1.1"
        );
        // Simulate a newer `/api/meta` probe advancing observed stamp before the old 400 arrives.
        base9.client.observe_atomic_settings_patches(true);
        held_400
            .reply(400, json!({"error":"Unknown conditional patch mode"}))
            .await;
        wait_until(|| {
            prefs9.poll();
            !prefs9.config.refreshing() && prefs9.transcript_error().is_some()
        })
        .await;
        assert!(
            base9.client.supports_atomic_settings_patches(),
            "stale 400 on atomic-v1 must not revoke a newer capability observation"
        );
        assert!(!base9.client.needs_capability_recheck());

        // 11. On a legacy (!atomic) server, editing a Chat tool row refreshes config/ui from disk
        // first so external config.yaml overrides (e.g. bash: hidden without SSE) are preserved.
        let (listener10, mut prefs10) = fixture().await;
        prefs10.set_transcript(Some(Row::Tool("read")), "hidden");
        assert!(prefs10.poll());
        let pre10 = request(&listener10).await;
        assert_eq!(
            pre10.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        pre10
            .reply(
                200,
                json!({"settings":{"locale":"en","toolCallExpansionDefaults":{"preset":"balanced","tools":{"bash":"hidden"}}}}),
            )
            .await;
        let patch10 = poll_next_request(&mut prefs10, &listener10).await;
        assert_eq!(patch10.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert!(
            patch10.body["settings"]["toolCallExpansionDefaults"]["tools"]
                .get("bash")
                .is_none(),
            "legacy tool materialization must omit bash so external config.yaml bash: hidden is not overwritten"
        );
        assert_eq!(
            patch10.body["settings"]["toolCallExpansionDefaults"]["tools"]["write"],
            "expanded"
        );
        assert_eq!(
            patch10.body["settings"]["toolCallExpansionDefaults"]["tools"]["read"],
            "hidden"
        );
        let mut saved10 = patch10.body["settings"].clone();
        saved10["locale"] = json!("en");
        saved10["toolCallExpansionDefaults"]["tools"]["bash"] = json!("hidden");
        patch10.reply(200, json!({"settings":saved10})).await;
        wait_until(|| {
            prefs10.poll();
            !prefs10.config.refreshing()
                && prefs10.transcript_mode(Row::Tool("read"), false) == "hidden"
        })
        .await;
        assert_eq!(prefs10.transcript_mode(Row::Tool("bash"), false), "hidden");

        // 12. Lost-receipt row edit confirmed during Retry GET is still preserved after the failed
        // Everything preset replays, instead of being overwritten back to expanded.
        let (listener11, mut prefs11) = fixture_atomic().await;
        prefs11.set_transcript(None, "everything");
        assert!(prefs11.poll());
        let p11 = request(&listener11).await;
        prefs11.set_transcript(Some(Row::Tool("read")), "hidden");
        p11.reply(503, json!({})).await;
        request(&listener11)
            .await
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;
        let r11 = poll_next_request(&mut prefs11, &listener11).await;
        drop(r11); // Server applied read=hidden, but receipt lost + first readback fails 503.
        request(&listener11).await.reply(503, json!({})).await;
        wait_until(|| {
            prefs11.poll();
            !prefs11.config.refreshing() && prefs11.transcript_error().is_some()
        })
        .await;
        prefs11.retry_transcript();
        let retry_get11 = poll_next_request(&mut prefs11, &listener11).await;
        retry_get11
            .reply(
                200,
                json!({"settings":{"locale":"en","toolCallExpansionDefaults":{"preset":"custom","tools":{"read":"hidden"}}}}),
            )
            .await;
        let rp11 = poll_next_request(&mut prefs11, &listener11).await;
        assert_eq!(
            rp11.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "everything"
        );
        let mut s11 = transcript_preset::patch("everything");
        s11["locale"] = json!("en");
        rp11.reply(200, json!({"settings":s11.clone()})).await;
        let rr11 = poll_next_request(&mut prefs11, &listener11).await;
        assert_eq!(
            rr11.body,
            json!({"settings":{"toolCallExpansionDefaults":{"preset":"custom","tools":{"read":"hidden"}}}})
        );
        s11["toolCallExpansionDefaults"]["preset"] = json!("custom");
        s11["toolCallExpansionDefaults"]["tools"]["read"] = json!("hidden");
        rr11.reply(200, json!({"settings":s11})).await;
        wait_until(|| {
            prefs11.poll();
            !prefs11.config.refreshing() && prefs11.transcript_error().is_none()
        })
        .await;
        assert_eq!(prefs11.transcript_mode(Row::Tool("read"), false), "hidden");
        assert_eq!(
            prefs11.transcript_mode(Row::Tool("write"), false),
            "expanded"
        );

        // 13. On a legacy (!atomic) server with an existing notificationRouting table, an SSE
        // storage.configChanged arriving between queued route edits must refresh first instead of
        // deadlocking the config/ui queue in Skip::Stale.
        {
            use crate::settings::notification_routing::{Category, Destination};
            let (listener12, mut prefs12) = fixture().await;
            let mut sse_tab12 = prefs12.backend.clone().unwrap();
            sse_tab12.client_id.push_str("-sse-nr");
            sse_tab12.workspace = "project".into();
            sse_tab12.session = "session-nr".into();
            let (o12, e12) = bounded(16);
            let (_c12, i12) = bounded(4);
            platform::spawn(async move {
                let _ = run_backend(sse_tab12, o12, i12, Arc::new(|| {})).await;
            });
            let mut sse12 = request(&listener12).await;
            sse12
                .socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            request(&listener12)
                .await
                .reply(200, json!({"status":"window","messages":[{"id":"r","type":"user","text":"r"}],"older":null,"newer":null,"latest":true}))
                .await;
            request(&listener12)
                .await
                .reply(200, json!({"data":{}}))
                .await;
            loop {
                if matches!(
                    timeout(Duration::from_secs(4), e12.recv())
                        .await
                        .unwrap()
                        .unwrap(),
                    Event::Sync(_)
                ) {
                    break;
                }
            }
            prefs12.refresh();
            let mut got_cfg12 = false;
            let mut got_state12 = false;
            while !got_cfg12 || !got_state12 {
                let req12 = poll_next_request(&mut prefs12, &listener12).await;
                if req12.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                    req12
                        .reply(
                            200,
                            json!({"settings":{"locale":"en","notificationRouting":{"needsInput":{"screen":true,"history":false}}}}),
                        )
                        .await;
                    got_cfg12 = true;
                } else {
                    req12.reply(200, json!({})).await;
                    got_state12 = true;
                }
            }
            wait_until(|| {
                prefs12.poll();
                !prefs12.config.refreshing()
                    && !prefs12.state.refreshing()
                    && prefs12.notification_route(Category::NeedsInput, Destination::Screen)
            })
            .await;
            prefs12.set_notification_route(Category::NeedsInput, Destination::History, true);
            assert!(prefs12.poll());
            let p12a = request(&listener12).await;
            assert_eq!(p12a.first, "PATCH /api/storage/config/ui HTTP/1.1");
            prefs12.set_notification_route(Category::NeedsInput, Destination::Screen, false);
            let rev12 = prefs12
                .backend
                .as_ref()
                .unwrap()
                .client
                .preferences_revision(Owner::Config);
            sse12
                .socket
                .write_all(b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\"}\n\n")
                .await
                .unwrap();
            wait_until(|| {
                prefs12
                    .backend
                    .as_ref()
                    .unwrap()
                    .client
                    .preferences_revision(Owner::Config)
                    > rev12
            })
            .await;
            p12a.reply(
                200,
                json!({"settings":{"locale":"en","notificationRouting":{"needsInput":{"screen":true,"history":true}}}}),
            )
            .await;
            let pre12 = poll_next_request(&mut prefs12, &listener12).await;
            assert_eq!(
                pre12.first,
                "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
            );
            pre12
                .reply(
                    200,
                    json!({"settings":{"locale":"en","notificationRouting":{"needsInput":{"screen":true,"history":true}}}}),
                )
                .await;
            let p12b = poll_next_request(&mut prefs12, &listener12).await;
            assert_eq!(p12b.first, "PATCH /api/storage/config/ui HTTP/1.1");
            p12b.reply(
                200,
                json!({"settings":{"locale":"en","notificationRouting":{"needsInput":{"screen":false,"history":true}}}}),
            )
            .await;
            wait_until(|| {
                prefs12.poll();
                !prefs12.config.refreshing()
                    && !prefs12.config.draining()
                    && !prefs12.notification_route(Category::NeedsInput, Destination::Screen)
            })
            .await;
        }

        // 14. On a legacy (!atomic) server, an explicit Preferences::refresh() while a legacy
        // materializing PATCH is paused at pre_patch_gate cancels that PATCH as stale, rereads
        // disk, and preserves external bash: hidden in the rebuilt PATCH.
        let (listener13, mut prefs13) = fixture().await;
        prefs13.set_transcript(Some(Row::Tool("read")), "hidden");
        assert!(prefs13.poll());
        let pre13a = request(&listener13).await;
        assert_eq!(
            pre13a.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        let (gate_tx13, gate_rx13) = bounded(1);
        prefs13.config.set_pre_patch_gate(gate_rx13);
        pre13a.reply(200, json!({"settings":{"locale":"en"}})).await;
        wait_until(|| {
            prefs13.poll();
            prefs13.config.refreshing()
        })
        .await;
        prefs13.refresh();
        let _ = gate_tx13.try_send(());
        let pre13b = loop {
            let req13 = poll_next_request(&mut prefs13, &listener13).await;
            if req13.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                req13.reply(200, json!({})).await;
                continue;
            }
            break req13;
        };
        assert_eq!(
            pre13b.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        pre13b
            .reply(
                200,
                json!({"settings":{"locale":"en","toolCallExpansionDefaults":{"preset":"balanced","tools":{"bash":"hidden"}}}}),
            )
            .await;
        let patch13 = loop {
            let req13 = poll_next_request(&mut prefs13, &listener13).await;
            if req13.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                req13.reply(200, json!({})).await;
                continue;
            }
            break req13;
        };
        assert_eq!(patch13.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert!(
            patch13.body["settings"]["toolCallExpansionDefaults"]["tools"]
                .get("bash")
                .is_none(),
            "explicit refresh before send must cancel stale legacy PATCH and preserve bash: hidden"
        );
        let mut saved13 = patch13.body["settings"].clone();
        saved13["locale"] = json!("en");
        saved13["toolCallExpansionDefaults"]["tools"]["bash"] = json!("hidden");
        patch13.reply(200, json!({"settings":saved13})).await;
        wait_until(|| {
            prefs13.poll();
            !prefs13.config.refreshing()
                && prefs13.transcript_mode(Row::Tool("read"), false) == "hidden"
        })
        .await;
        assert_eq!(prefs13.transcript_mode(Row::Tool("bash"), false), "hidden");

        // 15. On a legacy (!atomic) server, if a row PATCH is skipped as stale (`Skip::Stale`)
        // while a TranscriptPreset is already queued behind it, requeuing keeps the row edit
        // ahead of the preset so it still sends first and survives a subsequent preset 503.
        let (listener14, mut prefs14) = fixture().await;
        prefs14.set_transcript(Some(Row::Tool("read")), "hidden");
        assert!(prefs14.poll());
        let pre14a = request(&listener14).await;
        assert_eq!(
            pre14a.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        let (gate_tx14, gate_rx14) = bounded(1);
        prefs14.config.set_pre_patch_gate(gate_rx14);
        pre14a.reply(200, json!({"settings":{"locale":"en"}})).await;
        wait_until(|| {
            prefs14.poll();
            prefs14.config.refreshing()
        })
        .await;
        // Stage preset "everything" while `read` is paused at pre_patch_gate, then fire an
        // external invalidation so `read` skips as `Skip::Stale`.
        prefs14.set_transcript(None, "everything");
        prefs14.invalidate(Owner::Config);
        let _ = gate_tx14.try_send(());

        let pre14b = poll_next_request(&mut prefs14, &listener14).await;
        assert_eq!(
            pre14b.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        pre14b.reply(200, json!({"settings":{"locale":"en"}})).await;

        let read_patch14 = poll_next_request(&mut prefs14, &listener14).await;
        assert_eq!(read_patch14.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            read_patch14.body["settings"]["toolCallExpansionDefaults"]["tools"]["read"],
            json!("hidden"),
            "stale row edit must be requeued ahead of queued preset, not dropped"
        );
        assert_eq!(
            read_patch14.body["settings"]["toolCallExpansionDefaults"]["preset"],
            json!("custom")
        );
        let mut saved14 = read_patch14.body["settings"].clone();
        saved14["locale"] = json!("en");
        read_patch14
            .reply(200, json!({"settings":saved14.clone()}))
            .await;

        let preset_patch14 = poll_next_request(&mut prefs14, &listener14).await;
        assert_eq!(
            preset_patch14.first,
            "PATCH /api/storage/config/ui HTTP/1.1"
        );
        assert_eq!(
            preset_patch14.body["settings"]["toolCallExpansionDefaults"]["preset"],
            json!("everything")
        );
        preset_patch14.reply(503, json!({})).await;
        let readback14 = poll_next_request(&mut prefs14, &listener14).await;
        assert_eq!(
            readback14.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        readback14
            .reply(200, json!({"settings":saved14.clone()}))
            .await;
        wait_until(|| {
            prefs14.poll();
            prefs14.transcript_error().is_some()
        })
        .await;
        assert_eq!(
            prefs14.transcript_mode(Row::Tool("read"), false),
            "hidden",
            "requeued row edit must survive a 503 on the queued preset"
        );

        // 16. A healthy Missions PreferencesWatch stream counts as another healthy stream when
        // the sole background conversation stream drops, immediately triggering revalidation.
        let (listener15, mut prefs15) = fixture().await;
        let sse_wake15: rune::Waker = Arc::new(|| {});
        prefs15.watch_project(Some("proj-b"), &sse_wake15);
        let mut sse_req15 = request(&listener15).await;
        assert!(sse_req15.first.starts_with("GET /api/events?"));
        sse_req15
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        wait_until(|| {
            prefs15.poll();
            prefs15.has_healthy_watch_stream()
        })
        .await;
        // Drain the initial Opened(1) refresh so both owners are settled before simulating outage.
        let mut init_cfg15 = false;
        let mut init_state15 = false;
        while !(init_cfg15 && init_state15) {
            let req15 = poll_next_request(&mut prefs15, &listener15).await;
            if req15.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                init_cfg15 = true;
                req15.reply(200, json!({"settings":{"locale":"en"}})).await;
            } else if req15.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                init_state15 = true;
                req15.reply(200, json!({})).await;
            } else {
                panic!("unexpected request during watch startup: {}", req15.first);
            }
        }
        wait_until(|| {
            prefs15.poll();
            !prefs15.config.refreshing() && !prefs15.state.refreshing()
        })
        .await;
        // Simulate ConnectionLost on the sole background conversation stream while Missions watch
        // remains connected: Preferences must revalidate immediately and keep transcript_ready.
        let conv_id = "conv-bg-a".to_owned();
        prefs15.observe_conversation_clients(&[(conv_id.clone(), true)]);
        prefs15.note_client_outage(&conv_id);
        prefs15.mark_transport_lost();
        assert!(!prefs15.transcript_ready());
        assert!(prefs15.has_healthy_watch_stream());
        prefs15.revalidate_transport();
        prefs15.observe_conversation_clients(&[(conv_id.clone(), false)]);
        let mut saw_cfg15 = false;
        let mut saw_state15 = false;
        while !(saw_cfg15 && saw_state15) {
            let req15 = poll_next_request(&mut prefs15, &listener15).await;
            if req15.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                saw_cfg15 = true;
                req15.reply(200, json!({"settings":{"locale":"en"}})).await;
            } else if req15.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                saw_state15 = true;
                req15.reply(200, json!({})).await;
            } else {
                panic!(
                    "unexpected request during watch revalidation: {}",
                    req15.first
                );
            }
        }
        wait_until(|| {
            prefs15.poll();
            prefs15.transcript_ready()
        })
        .await;
        drop(sse_req15);
    });
}
