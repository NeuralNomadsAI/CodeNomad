use super::*;
use crate::files::test_http::Http;
use codenomad_client::message_actions::{PruneKind, PruneMessageTarget, PrunePartTarget};
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

fn rev(ch: char) -> String {
    std::iter::repeat_n(ch, 64).collect()
}

#[test]
fn response_targets_respects_user_text_gap_and_completion_boundaries() {
    let mut s = crate::init();
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
            {"type":"reasoning","text":"Final check"},
            {"type":"text","text":"Final answer paragraph 1"},
            {"type":"reasoning","text":"   "},
            {"type":"text","text":"Final answer paragraph 2"},
            {"type":"tool","name":"read","id":"after","state":{"status":"completed"}}
        ]}),
    ]);

    // Multi-message run stops at `mid`, skips transparent `sys`, rewinds across the empty
    // reasoning inside the final text block, and excludes the trailing tool after the answer.
    let targets = cleanup::response_targets(&s, "ans");
    assert_eq!(
        targets,
        vec![
            PruneMessageTarget {
                message: "s1".into(),
                parts: vec![
                    PrunePartTarget {
                        index: 0,
                        kind: PruneKind::Tool,
                    },
                    PrunePartTarget {
                        index: 1,
                        kind: PruneKind::Reasoning,
                    },
                ],
            },
            PruneMessageTarget {
                message: "s2".into(),
                parts: vec![PrunePartTarget {
                    index: 0,
                    kind: PruneKind::Tool,
                }],
            },
            PruneMessageTarget {
                message: "ans".into(),
                parts: vec![PrunePartTarget {
                    index: 0,
                    kind: PruneKind::Reasoning,
                }],
            },
        ]
    );

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

    // Omitted-part gap stops cleanup until revealed.
    let mut big_parts = Vec::with_capacity(1050);
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
}

#[test]
fn multi_message_response_cleanup_previews_confirms_prunes_and_rereads() {
    platform::block_on(async {
        let http = Http::new().await;
        let rows = [
            json!({"id":"u1","type":"user","text":"Check"}),
            json!({"id":"step1","type":"assistant","time":{"completed":1},"content":[
                {"type":"tool","name":"read","id":"c1","state":{"status":"completed"}},
                {"type":"reasoning","text":"Analyzing"}
            ]}),
            json!({"id":"step2","type":"assistant","time":{"completed":1},"content":[
                {"type":"tool","name":"bash","id":"c2","state":{"status":"completed"}}
            ]}),
            json!({"id":"answer","type":"assistant","time":{"completed":1},"content":[
                {"type":"text","text":"All set."}
            ]}),
        ];
        let mut rt = runtime(state_with(&http.backend, &rows));
        select_last(&mut rt, "answer", "delete-technical-parts");
        wait_for(&mut rt, "multi preview dispatch", |s| {
            s.transcript_display.messages.pending()
        })
        .await;

        let p1 = http.accept().await;
        assert!(
            p1.header
                .starts_with("POST /api/workspaces/owned/session-pruning/preview ")
        );
        assert_eq!(p1.body, json!({"sessionID":"session","messageID":"step1"}));
        p1.reply(
            200,
            json!({
                "status": "preview",
                "liveMutation": true,
                "revision": rev('a'),
                "parts": [
                    {"index": 0, "type": "tool", "bytes": 40},
                    {"index": 1, "type": "reasoning", "bytes": 20}
                ]
            }),
        )
        .await;

        let p2 = http.accept().await;
        assert_eq!(p2.body, json!({"sessionID":"session","messageID":"step2"}));
        p2.reply(
            200,
            json!({
                "status": "preview",
                "liveMutation": true,
                "revision": rev('b'),
                "parts": [{"index": 0, "type": "tool", "bytes": 30}]
            }),
        )
        .await;

        wait_for(&mut rt, "confirmation dialog", |s| {
            s.transcript_display
                .messages
                .confirmation_open(&s.input_scope)
        })
        .await;
        settle(&mut rt);
        assert!(rt.elements().iter().any(|e| {
            e.text.as_deref()
                == Some("Tool outputs: 2; reasoning blocks: 1. The final text will be preserved.")
        }));

        // Confirm removal via the dialog's accept button.
        click(&mut rt, "file-decision-confirm");

        let d1 = http.accept().await;
        assert!(
            d1.header
                .starts_with("POST /api/workspaces/owned/session-pruning/prune ")
        );
        assert_eq!(
            d1.body,
            json!({"sessionID":"session","messageID":"step1","revision":rev('a'),"indexes":[0,1]})
        );
        d1.reply(
            200,
            json!({"status":"pruned","messageID":"step1","revision":rev('c'),"removedCount":2}),
        )
        .await;

        let d2 = http.accept().await;
        assert_eq!(
            d2.body,
            json!({"sessionID":"session","messageID":"step2","revision":rev('b'),"indexes":[0]})
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
fn collapsed_tool_and_reasoning_groups_prune_only_their_members() {
    platform::block_on(async {
        let http = Http::new().await;
        let rows = [
            json!({"id":"g1","type":"assistant","time":{"completed":1},"content":[
                {"type":"tool","name":"read","id":"r1","state":{"status":"completed"}},
                {"type":"tool","name":"grep","id":"r2","state":{"status":"completed"}}
            ]}),
            json!({"id":"g2","type":"assistant","time":{"completed":1},"content":[
                {"type":"tool","name":"read","id":"r3","state":{"status":"completed"}},
                {"type":"reasoning","text":"**Step 1**\n\nThought one"},
                {"type":"reasoning","text":"**Step 2**\n\nThought two"}
            ]}),
        ];
        let mut s = state_with(&http.backend, &rows);
        crate::settings::fixture_transcript(
            &mut s,
            json!({
                "toolGroupVisibility": "collapsed",
                "showThinkingBlocks": true,
                "thinkingBlocksExpansion": "collapsed"
            }),
        );
        let mut rt = runtime(s);

        // Hover preview highlights targeted group and clears on leave.
        let group_delete = "delete-group-group-tool-g1:2:r1";
        let (gx, gy) = rt
            .find(group_delete)
            .expect("exploration group delete button");
        rt.pointer_move(gx, gy);
        settle(&mut rt);
        assert!(part_highlighted(&rt.state, "g1", Some(0)));
        assert!(part_highlighted(&rt.state, "g2", Some(0)));
        assert!(!part_highlighted(&rt.state, "g2", Some(1)));

        // Click deletes only the 3 exploration tools (g1:[0,1], g2:[0]), leaving g2 reasoning untouched.
        click(&mut rt, group_delete);
        wait_for(&mut rt, "group preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;

        let p1 = http.accept().await;
        assert_eq!(p1.body, json!({"sessionID":"session","messageID":"g1"}));
        p1.reply(
            200,
            json!({
                "status": "preview",
                "liveMutation": true,
                "revision": rev('1'),
                "parts": [
                    {"index": 0, "type": "tool", "bytes": 10},
                    {"index": 1, "type": "tool", "bytes": 10}
                ]
            }),
        )
        .await;

        let p2 = http.accept().await;
        assert_eq!(p2.body, json!({"sessionID":"session","messageID":"g2"}));
        p2.reply(
            200,
            json!({
                "status": "preview",
                "liveMutation": true,
                "revision": rev('2'),
                "parts": [
                    {"index": 0, "type": "tool", "bytes": 10},
                    {"index": 1, "type": "reasoning", "bytes": 10},
                    {"index": 2, "type": "reasoning", "bytes": 10}
                ]
            }),
        )
        .await;

        wait_for(&mut rt, "group confirmation", |s| {
            s.transcript_display
                .messages
                .confirmation_open(&s.input_scope)
        })
        .await;
        settle(&mut rt);
        assert!(rt.elements().iter().any(|e| {
            e.text.as_deref()
                == Some("Tool outputs: 3; reasoning blocks: 0. The final text will be preserved.")
        }));

        click(&mut rt, "file-decision-confirm");

        let d1 = http.accept().await;
        assert_eq!(
            d1.body,
            json!({"sessionID":"session","messageID":"g1","revision":rev('1'),"indexes":[0,1]})
        );
        d1.reply(
            200,
            json!({"status":"pruned","messageID":"g1","revision":rev('3'),"removedCount":2}),
        )
        .await;
        let d2 = http.accept().await;
        assert_eq!(
            d2.body,
            json!({"sessionID":"session","messageID":"g2","revision":rev('2'),"indexes":[0]})
        );
        d2.reply(
            200,
            json!({"status":"pruned","messageID":"g2","revision":rev('4'),"removedCount":1}),
        )
        .await;
        wait_for(&mut rt, "group prune done", |s| {
            !s.transcript_display.messages.pending()
        })
        .await;
        let boundary = http.accept().await;
        boundary
            .reply(200, json!({"data":{"id":"session","revert":null}}))
            .await;

        // Collapsed multi-part reasoning group also exposes its delete action.
        let reasoning_delete = "delete-group-reasoning-g2:0";
        click(&mut rt, reasoning_delete);
        wait_for(&mut rt, "reasoning preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let pr = http.accept().await;
        assert_eq!(pr.body, json!({"sessionID":"session","messageID":"g2"}));
        pr.reply(
            200,
            json!({
                "status": "preview",
                "liveMutation": true,
                "revision": rev('4'),
                "parts": [
                    {"index": 1, "type": "reasoning", "bytes": 10},
                    {"index": 2, "type": "reasoning", "bytes": 10}
                ]
            }),
        )
        .await;
        wait_for(&mut rt, "reasoning confirmation", |s| {
            s.transcript_display
                .messages
                .confirmation_open(&s.input_scope)
        })
        .await;
        settle(&mut rt);
        assert!(rt.elements().iter().any(|e| {
            e.text.as_deref()
                == Some("Tool outputs: 0; reasoning blocks: 2. The final text will be preserved.")
        }));
        http.quiet().await;
    });
}

#[test]
fn blocked_conflict_partial_failure_and_scope_cancellation_are_handled_safely() {
    platform::block_on(async {
        let http = Http::new().await;
        let rows = [
            json!({"id":"s1","type":"assistant","time":{"completed":1},"content":[
                {"type":"tool","name":"read","id":"c1","state":{"status":"completed"}}
            ]}),
            json!({"id":"s2","type":"assistant","time":{"completed":1},"content":[
                {"type":"tool","name":"read","id":"c2","state":{"status":"completed"}}
            ]}),
            json!({"id":"ans","type":"assistant","time":{"completed":1},"content":[
                {"type":"text","text":"Answer"}
            ]}),
        ];
        let mut rt = runtime(state_with(&http.backend, &rows));

        // 1. Server block reason maps to its localized session.pruning.* alert.
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

        // 2. Partial failure on 2nd prune reports conflict and still triggers authoritative reread.
        select_last(&mut rt, "ans", "delete-technical-parts");
        wait_for(&mut rt, "second preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let p1 = http.accept().await;
        p1.reply(
            200,
            json!({"status":"preview","liveMutation":true,"revision":rev('a'),"parts":[{"index":0,"type":"tool"}]}),
        )
        .await;
        let p2 = http.accept().await;
        p2.reply(
            200,
            json!({"status":"preview","liveMutation":true,"revision":rev('b'),"parts":[{"index":0,"type":"tool"}]}),
        )
        .await;
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
        let boundary = http.accept().await;
        assert!(
            boundary
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session ")
        );
        boundary
            .reply(200, json!({"data":{"id":"session","revert":null}}))
            .await;

        // 3. Suspending scope mid-preview cancels remaining message requests and suppresses confirmation.
        select_last(&mut rt, "ans", "delete-technical-parts");
        wait_for(&mut rt, "cancel preview", |s| {
            s.transcript_display.messages.pending()
        })
        .await;
        let c1 = http.accept().await;
        rt.state.transcript_display.messages.suspend();
        c1.reply(
            200,
            json!({"status":"preview","liveMutation":true,"revision":rev('e'),"parts":[{"index":0,"type":"tool"}]}),
        )
        .await;
        wait_for(&mut rt, "cancelled job settled", |s| {
            !s.transcript_display.messages.pending()
        })
        .await;
        assert!(
            !rt.state
                .transcript_display
                .messages
                .confirmation_open(&rt.state.input_scope)
        );
        http.quiet().await;
    });
}
