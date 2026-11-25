use super::*;
use crate::files::test_http::Http;
use codenomad_client::message_actions::{PruneKind, content_revision};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::{Value, json};

fn decode(rows: &[Value]) -> Vec<crate::history::Row> {
    rows.iter()
        .map(|row| crate::history::decode_message(row).unwrap().into())
        .collect()
}

fn state_with(backend: &Backend, rows: &[Value]) -> State {
    let mut s = crate::init();
    s.phase = Phase::Ready;
    s.transcript_display.messages.backend = Some(backend.clone());
    s.messages = decode(rows);
    s
}

fn runtime(s: State) -> Runtime<State> {
    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (1000.0, 900.0),
        Env::new(false, 1.0),
    );
    settle(&mut rt);
    rt
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..16 {
        rt.frame(0.02);
    }
}

fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(rt);
}

fn select_last(rt: &mut Runtime<State>, row: &str, item: &str) {
    rt.update(|_, tx| tx.focus(format!("message-actions-{row}:trigger"), true));
    settle(rt);
    rt.key(KeyEvent {
        key: Key::Up,
        mods: Mods::default(),
    });
    settle(rt);
    let key = format!("message-actions-{row}:item:{item}");
    assert!(
        rt.elements()
            .iter()
            .any(|e| e.focused && e.key.as_deref() == Some(key.as_str())),
        "expected focus on {key}"
    );
    rt.key(KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    });
    settle(rt);
}

async fn wait_for(rt: &mut Runtime<State>, name: &str, stop: impl Fn(&State) -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            rt.update_if(poll);
            rt.frame(0.02);
            if stop(&rt.state) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("missing {name}"));
}

fn preview_parts_for(row: &Value) -> Value {
    let parts: Vec<Value> = row["content"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter_map(|(index, part)| match part["type"].as_str() {
            Some("tool") => Some(json!({"index": index, "type": "tool", "bytes": 40})),
            Some("reasoning") => Some(json!({"index": index, "type": "reasoning", "bytes": 20})),
            _ => None,
        })
        .collect();
    Value::Array(parts)
}

async fn reply_preview_and_fresh(http: &Http, row: &Value) -> String {
    let id = row["id"].as_str().unwrap();
    let rev = content_revision(&row["content"]);
    let preview = http.accept().await;
    assert!(
        preview
            .header
            .starts_with("POST /api/workspaces/owned/session-pruning/preview ")
    );
    assert_eq!(preview.body, json!({"sessionID":"session","messageID":id}));
    preview
        .reply(
            200,
            json!({
                "status": "preview",
                "liveMutation": true,
                "revision": rev,
                "parts": preview_parts_for(row),
            }),
        )
        .await;
    let fresh = http.accept().await;
    assert!(fresh.header.starts_with(&format!(
        "GET /workspaces/owned/instance/api/session/session/message/{id} "
    )));
    fresh.reply(200, json!({"data": row})).await;
    rev
}

fn rev(ch: char) -> String {
    std::iter::repeat_n(ch, 64).collect()
}

#[test]
fn response_targets_respects_user_text_gap_filtered_and_empty_reasoning_boundaries() {
    let mut s = crate::init();
    crate::settings::fixture_transcript(
        &mut s,
        json!({
            "toolCallExpansionDefaults": {"preset": "custom", "tools": {"bash": "hidden"}},
            "showThinkingBlocks": true
        }),
    );
    s.messages = decode(&[
        json!({"id":"u1","type":"user","text":"Start"}),
        json!({"id":"s0","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"read","id":"t0","state":{"status":"completed"}}
        ]}),
        json!({"id":"mid","type":"assistant","time":{"completed":1},"content":[
            {"type":"text","text":"Earlier answer"}
        ]}),
        json!({"id":"s1","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"read","id":"t1","state":{"status":"completed"}},
            {"type":"reasoning","text":"Thinking"}
        ]}),
        json!({"id":"sys","type":"system","text":"Compaction note"}),
        json!({"id":"s2","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"bash","id":"t2","state":{"status":"completed"}}
        ]}),
        json!({"id":"ans","type":"assistant","time":{"completed":1},"content":[
            {"type":"reasoning","text":"   "},
            {"type":"text","text":"Final answer paragraph 1"},
            {"type":"tool","name":"bash","id":"hidden_between","state":{"status":"completed"}},
            {"type":"text","text":"Final answer paragraph 2"},
            {"type":"tool","name":"read","id":"after","state":{"status":"completed"}}
        ]}),
    ]);

    // Anchors at `Final answer paragraph 1` (stepping past filtered `hidden_between` while
    // retaining empty reasoning at index 0), skips transparent `sys`, stops at `mid`, and
    // excludes `after`.
    let targets = cleanup::response_targets(&s, "ans");
    assert_eq!(targets.len(), 3);
    assert_eq!(targets[0].message, "s1");
    assert_eq!(targets[0].parts.len(), 2);
    assert_eq!(targets[0].parts[0].index, 0);
    assert_eq!(targets[0].parts[0].kind, PruneKind::Tool);
    assert_eq!(targets[0].parts[1].index, 1);
    assert_eq!(targets[0].parts[1].kind, PruneKind::Reasoning);
    assert_eq!(targets[1].message, "s2");
    assert_eq!(targets[1].parts.len(), 1);
    assert_eq!(targets[1].parts[0].index, 0);
    assert_eq!(targets[2].message, "ans");
    assert_eq!(targets[2].parts.len(), 1);
    assert_eq!(targets[2].parts[0].index, 0);
    assert_eq!(targets[2].parts[0].kind, PruneKind::Reasoning);

    // With Thinking hidden, nonempty reasoning still splits the content row so
    // `[tool A, earlier prose, reasoning R, final prose]` selects R, not A.
    let mut hidden_thinking = crate::init();
    crate::settings::fixture_transcript(&mut hidden_thinking, json!({"showThinkingBlocks": false}));
    hidden_thinking.messages = decode(&[json!({
        "id": "m_hidden_r",
        "type": "assistant",
        "time": {"completed": 1},
        "content": [
            {"type":"tool","name":"read","id":"a","state":{"status":"completed"}},
            {"type":"text","text":"Earlier prose"},
            {"type":"reasoning","text":"Hidden reasoning"},
            {"type":"text","text":"Final prose"}
        ]
    })]);
    let split = cleanup::response_targets(&hidden_thinking, "m_hidden_r");
    assert_eq!(split.len(), 1);
    assert_eq!(split[0].parts.len(), 1);
    assert_eq!(split[0].parts[0].index, 2);
    assert_eq!(split[0].parts[0].kind, PruneKind::Reasoning);

    // An incomplete preceding step blocks the whole cleanup run.
    let mut incomplete = s.messages.clone();
    let mut step = (*incomplete[3]).clone();
    step.completed = false;
    incomplete[3] = std::sync::Arc::new(step);
    s.messages = incomplete;
    assert!(cleanup::response_targets(&s, "ans").is_empty());

    // User turn always forms a hard boundary.
    s.messages = decode(&[
        json!({"id":"s1","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"read","id":"t1","state":{"status":"completed"}}
        ]}),
        json!({"id":"u2","type":"user","text":"Next question"}),
        json!({"id":"ans2","type":"assistant","time":{"completed":1},"content":[
            {"type":"text","text":"Direct answer"}
        ]}),
    ]);
    assert!(cleanup::response_targets(&s, "ans2").is_empty());

    // When the final text sits inside an omitted-part gap, do NOT fall back to earlier head text.
    let mut gap_final = Vec::with_capacity(1050);
    gap_final
        .push(json!({"type":"tool","name":"read","id":"head_tool","state":{"status":"completed"}}));
    gap_final.push(json!({"type":"text","text":"Earlier head text"}));
    for i in 2..510 {
        gap_final.push(json!({"type":"tool","name":"read","id":format!("m{i}"),"state":{"status":"completed"}}));
    }
    gap_final.push(json!({"type":"text","text":"Final text hidden in gap"}));
    for i in 511..1050 {
        gap_final.push(json!({"type":"tool","name":"read","id":format!("t{i}"),"state":{"status":"completed"}}));
    }
    s.messages = decode(&[json!({
        "id": "gap_hidden",
        "type": "assistant",
        "time": {"completed": 1},
        "content": gap_final,
    })]);
    assert!(cleanup::response_targets(&s, "gap_hidden").is_empty());

    // Omitted-part gap before a visible final text stops cleanup until revealed.
    let mut big_parts = Vec::with_capacity(1051);
    for i in 0..1050 {
        big_parts.push(json!({"type":"tool","name":"read","id":format!("c{i}"),"state":{"status":"completed"}}));
    }
    big_parts.push(json!({"type":"text","text":"Done"}));
    s.messages = decode(&[json!({
        "id": "huge",
        "type": "assistant",
        "time": {"completed": 1},
        "content": big_parts,
    })]);
    let before = cleanup::response_targets(&s, "huge");
    assert_eq!(before.len(), 1);
    assert_eq!(before[0].parts.len(), 499);
    assert_eq!(before[0].parts[0].index, 551);
    super::super::actions::Display::reveal_next(&mut s, "parts-gap-huge");
    let after = cleanup::response_targets(&s, "huge");
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].parts.len(), 1050);
    assert_eq!(after[0].parts[0].index, 0);

    // Completed assistant message with a single tool and no prose keeps single-message cleanup.
    s.messages = decode(&[json!({
        "id": "solo",
        "type": "assistant",
        "time": {"completed": 1},
        "content": [{"type":"tool","name":"read","id":"only","state":{"status":"completed"}}]
    })]);
    assert!(cleanup::response_targets(&s, "solo").is_empty());
    let solo = cleanup::message_targets(&s, "solo");
    assert_eq!(solo.len(), 1);
    assert_eq!(solo[0].parts.len(), 1);
    assert_eq!(solo[0].parts[0].index, 0);
}

#[test]
fn multi_message_response_cleanup_previews_confirms_prunes_and_rereads() {
    platform::block_on(async {
        let http = Http::new().await;
        let step1 = json!({"id":"step1","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"read","id":"c1","state":{"status":"completed"}},
            {"type":"reasoning","text":"Analyzing"}
        ]});
        let step2 = json!({"id":"step2","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"bash","id":"c2","state":{"status":"completed"}}
        ]});
        let rows = [
            json!({"id":"u1","type":"user","text":"Check"}),
            step1.clone(),
            step2.clone(),
            json!({"id":"answer","type":"assistant","time":{"completed":1},"content":[
                {"type":"text","text":"All set."}
            ]}),
        ];
        let (cmd_tx, cmd_rx) = bounded(1);
        let mut s = state_with(&http.backend, &rows);
        s.commands = Some(cmd_tx);
        let mut rt = runtime(s);

        select_last(&mut rt, "answer", "delete-technical-parts");
        wait_for(&mut rt, "multi preview dispatch", |s| {
            s.transcript_display.messages.pending()
        })
        .await;

        let rev1 = reply_preview_and_fresh(&http, &step1).await;
        let rev2 = reply_preview_and_fresh(&http, &step2).await;

        wait_for(&mut rt, "confirmation dialog", |s| {
            s.transcript_display
                .messages
                .confirmation_open(&s.input_scope)
        })
        .await;
        settle(&mut rt);
        assert!(
            rt.elements()
                .iter()
                .any(|e| { e.text.as_deref() == Some("Remove tools and reasoning?") })
        );
        assert!(rt.elements().iter().any(|e| {
            e.text.as_deref()
                == Some("Tool outputs: 2; reasoning blocks: 1. The final text will be preserved.")
        }));

        click(&mut rt, "file-decision-confirm");

        let d1 = http.accept().await;
        assert!(
            d1.header
                .starts_with("POST /api/workspaces/owned/session-pruning/prune ")
        );
        assert_eq!(
            d1.body,
            json!({"sessionID":"session","messageID":"step1","revision":rev1,"indexes":[0,1]})
        );
        d1.reply(
            200,
            json!({"status":"pruned","messageID":"step1","revision":rev('c'),"removedCount":2}),
        )
        .await;

        let d2 = http.accept().await;
        assert_eq!(
            d2.body,
            json!({"sessionID":"session","messageID":"step2","revision":rev2,"indexes":[0]})
        );
        d2.reply(
            200,
            json!({"status":"pruned","messageID":"step2","revision":rev('d'),"removedCount":1}),
        )
        .await;

        wait_for(&mut rt, "prune settled", |s| {
            !s.transcript_display.messages.pending()
        })
        .await;
        assert!(rt.state.transcript_display.messages.error.is_none());
        assert!(matches!(
            cmd_rx.try_recv(),
            Ok(crate::transport::Command::Latest)
        ));
        let boundary_read = http.accept().await;
        assert!(
            boundary_read
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session ")
        );
        boundary_read
            .reply(200, json!({"data":{"id":"session","revert":null}}))
            .await;
        http.quiet().await;
    });
}

#[test]
fn shifted_indices_never_delete_unselected_parts() {
    platform::block_on(async {
        let http = Http::new().await;
        // Displayed message has [hidden H0, read A, grep B, hidden H1].
        let displayed = json!({"id":"m1","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"edit","id":"h0","state":{"status":"completed"}},
            {"type":"tool","name":"read","id":"a","state":{"status":"completed"}},
            {"type":"tool","name":"grep","id":"b","state":{"status":"completed"}},
            {"type":"tool","name":"edit","id":"h1","state":{"status":"completed"}}
        ]});
        let mut s = state_with(&http.backend, std::slice::from_ref(&displayed));
        crate::settings::fixture_transcript(
            &mut s,
            json!({
                "toolGroupVisibility": "collapsed",
                "toolCallExpansionDefaults": {"preset": "custom", "tools": {"edit": "hidden"}}
            }),
        );
        let mut rt = runtime(s);

        // Case 1: Another client removed H0 before preview. Server now has [A(0), B(1), H1(2)].
        // Rune resolves stable tool IDs (A -> 0, B -> 1) and must NEVER target H1 at index 2.
        let shifted = json!({"id":"m1","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"read","id":"a","state":{"status":"completed"}},
            {"type":"tool","name":"grep","id":"b","state":{"status":"completed"}},
            {"type":"tool","name":"edit","id":"h1","state":{"status":"completed"}}
        ]});
        click(&mut rt, "delete-group-group-tool-m1:1:a");
        wait_for(&mut rt, "shifted preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let shifted_rev = reply_preview_and_fresh(&http, &shifted).await;
        wait_for(&mut rt, "shifted confirm", |s| {
            s.transcript_display
                .messages
                .confirmation_open(&s.input_scope)
        })
        .await;
        click(&mut rt, "file-decision-confirm");
        let prune = http.accept().await;
        assert_eq!(
            prune.body,
            json!({"sessionID":"session","messageID":"m1","revision":shifted_rev,"indexes":[0,1]})
        );
        prune
            .reply(
                200,
                json!({"status":"pruned","messageID":"m1","revision":rev('9'),"removedCount":2}),
            )
            .await;
        wait_for(&mut rt, "shifted prune done", |s| {
            !s.transcript_display.messages.pending()
        })
        .await;
        http.accept()
            .await
            .reply(200, json!({"data":{"id":"session","revert":null}}))
            .await;

        // Case 2: Another client removed A before preview. Server now has [B(0), H1(1)].
        // Because A no longer exists in the fresh message, Rune refuses with Conflict instead
        // of adopting the fresh revision and deleting H1.
        let missing_a = json!({"id":"m1","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"grep","id":"b","state":{"status":"completed"}},
            {"type":"tool","name":"edit","id":"h1","state":{"status":"completed"}}
        ]});
        click(&mut rt, "delete-group-group-tool-m1:1:a");
        wait_for(&mut rt, "conflict preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let _ = reply_preview_and_fresh(&http, &missing_a).await;
        wait_for(&mut rt, "conflict alert", |s| {
            s.transcript_display.messages.error == Some("session.pruning.conflict")
        })
        .await;
        assert!(
            !rt.state
                .transcript_display
                .messages
                .confirmation_open(&rt.state.input_scope)
        );

        // Case 3: Reasoning B shares text and timestamps with rendered reasoning A but has
        // different `native` provider state. Full native digest comparison refuses with Conflict.
        let r_displayed = json!({"id":"r1","type":"assistant","time":{"completed":1},"content":[
            {"type":"reasoning","text":"Same thought","time":{"created":10,"completed":20},"native":{"sig":"A"}},
            {"type":"text","text":"Reply"}
        ]});
        let r_mutated = json!({"id":"r1","type":"assistant","time":{"completed":1},"content":[
            {"type":"reasoning","text":"Same thought","time":{"created":10,"completed":20},"native":{"sig":"B"}},
            {"type":"text","text":"Reply"}
        ]});
        let mut rt_r = runtime(state_with(&http.backend, &[r_displayed]));
        select_last(&mut rt_r, "r1", "delete-technical-parts");
        wait_for(&mut rt_r, "native reasoning mismatch preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let _ = reply_preview_and_fresh(&http, &r_mutated).await;
        wait_for(&mut rt_r, "native reasoning mismatch conflict", |s| {
            s.transcript_display.messages.error == Some("session.pruning.conflict")
        })
        .await;
        assert!(
            !rt_r
                .state
                .transcript_display
                .messages
                .confirmation_open(&rt_r.state.input_scope)
        );
        http.quiet().await;
    });
}

#[test]
fn collapsed_tool_and_reasoning_groups_hover_dynamically_cancel_focus_and_prune_members() {
    platform::block_on(async {
        let http = Http::new().await;
        let g1 = json!({"id":"g1","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"read","id":"r1","state":{"status":"completed"}},
            {"type":"tool","name":"grep","id":"r2","state":{"status":"completed"}}
        ]});
        let g2 = json!({"id":"g2","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"read","id":"r3","state":{"status":"completed"}},
            {"type":"reasoning","text":"**Step 1**\n\nThought one"},
            {"type":"reasoning","text":"**Step 2**\n\nThought two"}
        ]});
        let mut s = state_with(&http.backend, &[g1.clone(), g2.clone()]);
        crate::settings::fixture_transcript(
            &mut s,
            json!({
                "toolGroupVisibility": "collapsed",
                "showThinkingBlocks": true,
                "thinkingBlocksExpansion": "collapsed"
            }),
        );
        let mut rt = runtime(s);

        // Hover preview resolves dynamically from the current transcript rather than a stale snapshot.
        let group_delete = "delete-group-group-tool-g1:2:r1";
        let (gx, gy) = rt
            .find(group_delete)
            .expect("exploration group delete button");
        rt.pointer_move(gx, gy);
        settle(&mut rt);
        let groups = super::super::tool_groups::Groups::project(&rt.state);
        let hi = active_highlight(&rt.state, &groups);
        assert!(part_highlighted(&hi, "g1", Some(0)));
        assert!(part_highlighted(&hi, "g2", Some(0)));
        assert!(!part_highlighted(&hi, "g2", Some(1)));

        // Refresh transcript while the pointer remains hovered: highlight tracks the new group.
        let g2_without_read = json!({"id":"g2","type":"assistant","time":{"completed":1},"content":[
            {"type":"reasoning","text":"**Step 1**\n\nThought one"},
            {"type":"reasoning","text":"**Step 2**\n\nThought two"}
        ]});
        rt.update(|s, _| {
            s.messages = decode(&[g1.clone(), g2_without_read]);
            s.revision += 1;
        });
        settle(&mut rt);
        let groups_after = super::super::tool_groups::Groups::project(&rt.state);
        let hi_after = active_highlight(&rt.state, &groups_after);
        assert!(part_highlighted(&hi_after, "g1", Some(0)));
        assert!(!part_highlighted(&hi_after, "g2", Some(0)));

        // Restore g2 and exercise keyboard focus return on Escape cancel.
        rt.update(|s, _| {
            s.messages = decode(&[g1.clone(), g2.clone()]);
            s.revision += 1;
        });
        settle(&mut rt);
        rt.update(|_, tx| tx.focus(group_delete, true));
        settle(&mut rt);
        rt.key(KeyEvent {
            key: Key::Enter,
            mods: Mods::default(),
        });
        settle(&mut rt);
        wait_for(&mut rt, "group preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let _ = reply_preview_and_fresh(&http, &g1).await;
        let _ = reply_preview_and_fresh(&http, &g2).await;
        wait_for(&mut rt, "group confirmation", |s| {
            s.transcript_display
                .messages
                .confirmation_open(&s.input_scope)
        })
        .await;
        settle(&mut rt);
        // Group dialog uses its localized title and group summary (no "final text" claim).
        assert!(
            !rt.elements()
                .iter()
                .any(|e| e.text.as_deref().is_some_and(|t| t.contains("final text")))
        );

        // Escape cancels and restores keyboard focus to the Delete opener.
        rt.key(KeyEvent {
            key: Key::Escape,
            mods: Mods::default(),
        });
        settle(&mut rt);
        assert!(
            rt.elements()
                .iter()
                .any(|e| e.focused && e.key.as_deref() == Some(group_delete))
        );

        // If the tool group collapses to a singleton while confirmation is open, Escape falls back
        // to the surviving message-actions trigger instead of losing keyboard focus.
        click(&mut rt, group_delete);
        wait_for(&mut rt, "singleton fallback preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let _ = reply_preview_and_fresh(&http, &g1).await;
        let _ = reply_preview_and_fresh(&http, &g2).await;
        wait_for(&mut rt, "singleton fallback confirm", |s| {
            s.transcript_display
                .messages
                .confirmation_open(&s.input_scope)
        })
        .await;
        let g1_singleton = json!({"id":"g1","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"read","id":"r1","state":{"status":"completed"}}
        ]});
        rt.update(|s, _| {
            s.messages = decode(&[g1_singleton]);
            s.revision += 1;
        });
        settle(&mut rt);
        rt.key(KeyEvent {
            key: Key::Escape,
            mods: Mods::default(),
        });
        settle(&mut rt);
        assert!(
            rt.elements()
                .iter()
                .any(|e| { e.focused && e.key.as_deref() == Some("message-actions-g1:trigger") })
        );

        // Restore g1+g2 so the collapsed reasoning group check runs next.
        rt.update(|s, _| {
            s.messages = decode(&[g1.clone(), g2.clone()]);
            s.revision += 1;
        });
        settle(&mut rt);

        // Collapsed multi-part reasoning group also exposes its delete action and prunes only [1, 2].
        let reasoning_delete = "delete-group-reasoning-g2:0";
        click(&mut rt, reasoning_delete);
        wait_for(&mut rt, "reasoning preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let rev_g2 = reply_preview_and_fresh(&http, &g2).await;
        wait_for(&mut rt, "reasoning confirmation", |s| {
            s.transcript_display
                .messages
                .confirmation_open(&s.input_scope)
        })
        .await;
        settle(&mut rt);
        click(&mut rt, "file-decision-confirm");
        let prune = http.accept().await;
        assert_eq!(
            prune.body,
            json!({"sessionID":"session","messageID":"g2","revision":rev_g2,"indexes":[1,2]})
        );
        prune
            .reply(
                200,
                json!({"status":"pruned","messageID":"g2","revision":rev('5'),"removedCount":2}),
            )
            .await;
        wait_for(&mut rt, "reasoning prune done", |s| {
            !s.transcript_display.messages.pending()
        })
        .await;
        http.accept()
            .await
            .reply(200, json!({"data":{"id":"session","revert":null}}))
            .await;
        http.quiet().await;
    });
}

#[test]
fn blocked_partial_failure_full_queue_and_scope_rotation_are_handled_safely() {
    platform::block_on(async {
        let http = Http::new().await;
        let s1 = json!({"id":"s1","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"read","id":"c1","state":{"status":"completed"}}
        ]});
        let s2 = json!({"id":"s2","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","name":"read","id":"c2","state":{"status":"completed"}}
        ]});
        let ans = json!({"id":"ans","type":"assistant","time":{"completed":1},"content":[
            {"type":"text","text":"Answer"}
        ]});
        let (cmd_tx, cmd_rx) = bounded(1);
        let mut s = state_with(&http.backend, &[s1.clone(), s2.clone(), ans]);
        s.commands = Some(cmd_tx.clone());
        let mut rt = runtime(s);

        // 1. Server block reason maps to its localized session.pruning.* alert without GET /message.
        select_last(&mut rt, "ans", "delete-technical-parts");
        wait_for(&mut rt, "blocked preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let p = http.accept().await;
        p.reply(
            200,
            json!({"status":"blocked","reason":"maintenance_required"}),
        )
        .await;
        wait_for(&mut rt, "blocked error", |s| {
            s.transcript_display.messages.error.is_some()
        })
        .await;
        assert_eq!(
            rt.state.transcript_display.messages.error,
            Some("session.pruning.maintenance_required")
        );

        // 2. Partial failure on 2nd prune with a full command queue keeps pending() true until
        // Command::Latest is actually admitted.
        cmd_tx
            .try_send(crate::transport::Command::Latest)
            .expect("occupy command queue");
        select_last(&mut rt, "ans", "delete-technical-parts");
        wait_for(&mut rt, "second preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let _ = reply_preview_and_fresh(&http, &s1).await;
        let _ = reply_preview_and_fresh(&http, &s2).await;
        wait_for(&mut rt, "confirm open", |s| {
            s.transcript_display
                .messages
                .confirmation_open(&s.input_scope)
        })
        .await;
        settle(&mut rt);
        click(&mut rt, "file-decision-confirm");

        let d1 = http.accept().await;
        d1.reply(
            200,
            json!({"status":"pruned","messageID":"s1","revision":rev('c'),"removedCount":1}),
        )
        .await;
        let d2 = http.accept().await;
        d2.reply(200, json!({"status":"blocked","reason":"conflict"}))
            .await;
        wait_for(&mut rt, "partial failure alert", |s| {
            s.transcript_display.messages.error == Some("session.pruning.conflict")
        })
        .await;
        // Command queue is still full, so pending() remains true until the reload is admitted.
        assert!(rt.state.transcript_display.messages.pending());
        assert!(cmd_rx.try_recv().is_ok());
        wait_for(&mut rt, "reload admitted", |s| {
            !s.transcript_display.messages.pending()
        })
        .await;
        assert!(matches!(
            cmd_rx.try_recv(),
            Ok(crate::transport::Command::Latest)
        ));
        http.accept()
            .await
            .reply(200, json!({"data":{"id":"session","revert":null}}))
            .await;

        // 3. Rotating input_scope via renew_scope() while a confirmation is open clears pending().
        select_last(&mut rt, "ans", "delete-technical-parts");
        wait_for(&mut rt, "third preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let _ = reply_preview_and_fresh(&http, &s1).await;
        let _ = reply_preview_and_fresh(&http, &s2).await;
        wait_for(&mut rt, "third confirm", |s| {
            s.transcript_display
                .messages
                .confirmation_open(&s.input_scope)
        })
        .await;
        rt.update(|s, _| s.renew_scope());
        settle(&mut rt);
        assert!(!rt.state.transcript_display.messages.pending());

        // 4. Rotating input_scope during the 1st prune cancels the 2nd prune and still reconciles.
        select_last(&mut rt, "ans", "delete-technical-parts");
        wait_for(&mut rt, "fourth preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let _ = reply_preview_and_fresh(&http, &s1).await;
        let _ = reply_preview_and_fresh(&http, &s2).await;
        wait_for(&mut rt, "fourth confirm", |s| {
            s.transcript_display
                .messages
                .confirmation_open(&s.input_scope)
        })
        .await;
        click(&mut rt, "file-decision-confirm");
        let first_prune = http.accept().await;
        rt.update(|s, _| s.renew_scope());
        first_prune
            .reply(
                200,
                json!({"status":"pruned","messageID":"s1","revision":rev('e'),"removedCount":1}),
            )
            .await;
        wait_for(&mut rt, "rotated prune reconciled", |s| {
            !s.transcript_display.messages.pending()
        })
        .await;
        assert!(matches!(
            cmd_rx.try_recv(),
            Ok(crate::transport::Command::Latest)
        ));
        http.accept()
            .await
            .reply(200, json!({"data":{"id":"session","revert":null}}))
            .await;

        // 5. Dropping the direct transport receiver during a prune releases pending() instead
        // of stalling forever and carries the reload onto the replacement transport on bind().
        drop(cmd_rx);
        select_last(&mut rt, "ans", "delete-technical-parts");
        wait_for(&mut rt, "closed transport preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let _ = reply_preview_and_fresh(&http, &s1).await;
        let _ = reply_preview_and_fresh(&http, &s2).await;
        wait_for(&mut rt, "closed transport confirm", |s| {
            s.transcript_display
                .messages
                .confirmation_open(&s.input_scope)
        })
        .await;
        click(&mut rt, "file-decision-confirm");
        http.accept()
            .await
            .reply(
                200,
                json!({"status":"pruned","messageID":"s1","revision":rev('f'),"removedCount":1}),
            )
            .await;
        http.accept()
            .await
            .reply(
                200,
                json!({"status":"pruned","messageID":"s2","revision":rev('0'),"removedCount":1}),
            )
            .await;
        wait_for(&mut rt, "closed queue releases pending", |s| {
            !s.transcript_display.messages.pending()
        })
        .await;
        http.accept()
            .await
            .reply(200, json!({"data":{"id":"session","revert":null}}))
            .await;
        wait_for(&mut rt, "boundary read settled", |s| {
            s.transcript_display.messages.read.is_none()
        })
        .await;
        let (new_tx, new_rx) = bounded(1);
        rt.update(|s, _| {
            s.commands = Some(new_tx);
            s.transcript_display.messages.bind(http.backend.clone());
        });
        wait_for(&mut rt, "replacement transport reloaded", |s| {
            !s.transcript_display.messages.pending()
        })
        .await;
        assert!(matches!(
            new_rx.try_recv(),
            Ok(crate::transport::Command::Latest)
        ));
        http.accept()
            .await
            .reply(200, json!({"data":{"id":"session","revert":null}}))
            .await;
        http.quiet().await;
    });
}
