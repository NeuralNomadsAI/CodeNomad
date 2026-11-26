use crate::{
    Phase, chat::actions::Display, init, platform::storage::unix_millis, strings::with_locale,
};
use rune::{Env, Key, KeyEvent, Runtime};
use serde_json::json;

#[test]
fn specialized_titles_prose_and_header_controls() {
    let raw_skill = format!(
        "# Skill heading\n\n**Proof**\n\n```rust\nlet long = 1;\n```\n\n{}\n\nSKILL_TAIL",
        "line\n".repeat(10_001)
    );
    let row = crate::history::decode_message(&json!({
        "type":"assistant","id":"result","time":{"completed":10000},"content":[
            {"type":"tool","id":"fetch","name":"webfetch","time":{"created":1000,"ran":2000,"completed":5000},
             "state":{"status":"completed","input":{"url":"https://example.test/report"},
                      "content":[{"type":"text","text":"Fetched content"}]}},
            {"type":"tool","id":"fetch_bare","name":"webfetch","time":{"created":1000,"ran":2000,"completed":2400},
             "state":{"status":"completed","input":{},"content":[{"type":"text","text":"Short"}]}},
            {"type":"tool","id":"invalid","name":"invalid","state":{"status":"error","input":{"tool":"missing_custom"}}},
            {"type":"tool","id":"invalid_bash","name":"invalid","state":{"status":"error","input":{"tool":"bash"}}},
            {"type":"tool","id":"invalid_bare","name":"invalid","state":{"status":"error","input":{}}},
            {"type":"tool","id":"skill_running","name":"skill","state":{"status":"running","metadata":{"output":"partial"}}},
            {"type":"tool","id":"edit_running","name":"edit","state":{"status":"running","input":{"filePath":"a.rs"},
             "metadata":{"output":"--- a.rs\n+++ a.rs\n@@ -1 +1 @@\n-old\n+new"}}},
            {"type":"tool","id":"skill","name":"skill","state":{"status":"completed","content":[{"type":"text","text":raw_skill}]}}
        ]
    })).unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![row.into()];
    let mut rt = Runtime::new(
        state,
        |s, cx| {
            cx.web_focus();
            with_locale("en", || {
                rune::col().children(s.messages[0].parts.iter().filter_map(|part| {
                    let crate::content::Part::Tool(tool) = part else {
                        return None;
                    };
                    Some(super::view(s, "result", tool))
                }))
            })
        },
        (1160.0, 1400.0),
        Env::new(false, 1.0),
    );
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Fetch https://example.test/report"));
    assert!(
        tree.contains("\"name\":\"Invalid Missing_custom\"")
            && tree.contains("\"name\":\"Invalid Shell\"")
            && tree.contains("\"name\":\"Invalid\"")
    );
    assert!(tree.contains("\"3s\""));
    let skill_running_key = super::tool_key("result", "skill_running");
    assert!(
        rt.find(&format!("copy-{skill_running_key}-output"))
            .is_none()
    );
    let edit_running_key = super::tool_key("result", "edit_running");
    let (_, edit_toggle_y) = rt.find(&format!("toggle-{edit_running_key}")).unwrap();
    if !rt.accessibility_json().to_string().contains("+new") {
        let (x, y) = rt.find(&format!("toggle-{edit_running_key}")).unwrap();
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.01);
    }
    assert!(rt.accessibility_json().to_string().contains("+new"));
    let (_, edit_wrap_y) = rt.find(&format!("{edit_running_key}-wrap")).unwrap();
    assert!(
        edit_wrap_y > edit_toggle_y + 4.0,
        "running edit diff keeps wrap in body ({edit_wrap_y} <= {edit_toggle_y})"
    );
    let (x, y) = rt.find(&format!("toggle-{skill_running_key}")).unwrap();
    rt.pointer_move(x, y);
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.01);
    assert!(
        rt.find(&format!("copy-{skill_running_key}-output"))
            .is_none()
    );
    assert!(!rt.accessibility_json().to_string().contains("partial"));
    let fetch_key = super::tool_key("result", "fetch");
    let skill_key = super::tool_key("result", "skill");
    if rt.find(&format!("{fetch_key}-wrap")).is_none() {
        let (x, y) = rt.find(&format!("toggle-{fetch_key}")).unwrap();
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.01);
    }
    let wrap_key = format!("{fetch_key}-wrap");
    assert!(rt.find(&wrap_key).is_some(), "missing {wrap_key}");
    rt.update(|_, tx| tx.focus(&wrap_key, true));
    rt.frame(0.01);
    rt.key(KeyEvent {
        key: Key::Enter,
        mods: Default::default(),
    });
    rt.frame(0.01);
    assert!(rt.state.transcript_display.toggled(&wrap_key));
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Enable word wrap")
    );
    if !rt
        .accessibility_json()
        .to_string()
        .contains("Skill heading")
    {
        let (x, y) = rt.find(&format!("toggle-{skill_key}")).unwrap();
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.01);
    }
    assert!(rt.find(&format!("{skill_key}-wrap")).is_none());
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Skill heading") && tree.contains("Proof") && !tree.contains("SKILL_TAIL")
    );
    assert!(!tree.contains("# Skill heading"), "{tree}");
    let code_wrap = format!("{skill_key}-tool_output-code-0-wrap");
    let (x, y) = rt
        .find(&code_wrap)
        .unwrap_or_else(|| panic!("missing {code_wrap}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.01);
    assert!(
        rt.state
            .transcript_display
            .unwrapped(&format!("{skill_key}-tool_output"))
            .contains(&0)
    );
    let (x, y) = rt.find(&format!("copy-{skill_key}-output")).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.01);
    assert_eq!(
        clipboard.text().as_deref().map(String::as_str),
        Some(raw_skill.as_str())
    );
}

#[test]
fn running_tool_duration_ticks_through_view_memo_and_stops_when_settled() {
    let start = unix_millis().saturating_sub(65_000);
    let row = crate::history::decode_message(&json!({
        "type":"assistant","id":"live","content":[
            {"type":"tool","id":"cmd","name":"bash","time":{"ran":start},
             "state":{"status":"running","input":{"command":"sleep 90"},
                      "metadata":{"output":"LIVE_BASH_PREVIEW"}}}
        ]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Streaming;
    let key = super::tool_key("live", "cmd");
    crate::chat::actions::Display::set_expanded(&mut state, &key, true);
    state.messages = vec![row.into()];
    let mut rt = Runtime::new(
        state,
        |s, _| {
            with_locale("en", || {
                rune::col().children(s.messages.iter().flat_map(|row| {
                    row.parts.iter().filter_map(|part| {
                        let crate::content::Part::Tool(tool) = part else {
                            return None;
                        };
                        Some(super::view(s, &row.id, tool))
                    })
                }))
            })
        },
        (1160.0, 820.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("1m 0"), "{tree}");
    let mut ticked = false;
    rt.update(|s, tx| ticked = Display::poll(s, false, 0.01, tx));
    assert!(!ticked);
    assert!(rt.wake_deadline().is_some());
    let before = rt.state.transcript_display.tool_clock.epoch();
    rt.update(|s, tx| ticked = Display::poll(s, false, 0.5, tx));
    assert!(!ticked);
    assert_eq!(rt.state.transcript_display.tool_clock.epoch(), before);
    rt.update(|s, tx| ticked = Display::poll(s, false, 1.1, tx));
    assert!(ticked);
    assert!(rt.state.transcript_display.tool_clock.epoch() > before);
    rt.frame(1.1);
    let key = super::tool_key("live", "cmd");
    let toggle_key = format!("toggle-{key}");
    rt.update(|_, tx| tx.focus(&toggle_key, true));
    rt.frame(1.15);
    rt.update(|_, tx| assert_eq!(tx.focused(), Some(toggle_key.as_str())));
    // Speculative search probe for a completed version of the same tool must not retire the live clock.
    let completed_probe = crate::history::decode_message(&json!({
        "type":"assistant","id":"live","time":{"completed":start + 66_000},"content":[
            {"type":"tool","id":"cmd","name":"bash","time":{"ran":start,"completed":start + 66_000},
             "state":{"status":"completed","input":{"command":"sleep 90"}}}
        ]
    }))
    .unwrap();
    let crate::content::Part::Tool(probe_tool) = &completed_probe.parts[0] else {
        panic!("tool part");
    };
    let probe_hit = codenomad_client::search::Hit {
        session: "s".into(),
        message: "live".into(),
        role: "assistant".into(),
        part: 0,
        kind: codenomad_client::search::Kind::Tool,
        excerpt: String::new(),
    };
    let probe_search = crate::chat::search_hit::SearchHit::new(&probe_hit, "sleep", false);
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({"toolInputsVisibility":"hidden"}));
        let _ = super::match_hidden_by_inputs(
            s,
            "live",
            probe_tool,
            probe_search.query(Some((codenomad_client::search::Kind::Tool, 0))),
        );
    });
    rt.update(|s, tx| ticked = Display::poll(s, false, 2.2, tx));
    assert!(ticked);

    // SSE settlement sets ended before HTTP completes: freeze duration while keeping live output.
    rt.update(|s, _| {
        let row = std::sync::Arc::make_mut(&mut s.messages[0]);
        let crate::content::Part::Tool(tool) = &mut row.parts[0] else {
            panic!("tool part");
        };
        std::sync::Arc::make_mut(tool).ended = Some(start + 66_000);
    });
    rt.frame(3.5);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("1m 6s") && tree.contains("LIVE_BASH_PREVIEW"),
        "{tree}"
    );
    rt.update(|s, tx| ticked = Display::poll(s, false, 3.6, tx));
    assert!(!ticked);
    rt.frame(3.7);
    assert!(rt.wake_deadline().is_none());
    rt.update(|_, tx| assert_eq!(tx.focused(), Some(toggle_key.as_str())));
    rt.update(|s, _| {
        s.messages[0] = crate::history::decode_message(&json!({
            "type":"assistant","id":"live","time":{"completed":start + 67_000},"content":[
                {"type":"tool","id":"cmd","name":"bash","time":{"ran":start,"completed":start + 67_000},
                 "state":{"status":"completed","input":{"command":"sleep 90"}}}
            ]
        }))
        .unwrap()
        .into();
    });
    rt.frame(1.2);
    rt.update(|_, tx| assert_eq!(tx.focused(), Some(toggle_key.as_str())));
    let settled = rt.state.transcript_display.tool_clock.epoch();
    assert!(rt.accessibility_json().to_string().contains("1m 7s"));
    rt.update(|s, tx| ticked = Display::poll(s, false, 3.5, tx));
    assert!(!ticked);
    assert_eq!(rt.state.transcript_display.tool_clock.epoch(), settled);
    assert!(rt.wake_deadline().is_none());
}

#[test]
fn active_search_keeps_skill_prose_bounded_and_uses_prose_step() {
    let prefix = "a".repeat(270_000);
    let raw_skill = format!(
        "# Skill heading\n\nR&amp;D [Guide](https://example.test/LINK_URL_ONLY)\n\n{prefix}\nDEEP_SKILL_NEEDLE\n{}",
        "b".repeat(50_000)
    );
    let row = crate::history::decode_message(&json!({
        "type":"assistant","id":"msg","time":{"completed":10000},"content":[
            {"type":"tool","id":"sk","name":"skill",
             "state":{"status":"completed","input":{
                 "name":"demo",
                 "entity":"R&D",
                 "shared":"DEEP_SKILL_NEEDLE",
                 "link_only":"LINK_URL_ONLY",
                 "only_input":"INPUT_ONLY_NEEDLE"
             },
                      "content":[{"type":"text","text":raw_skill}]}}
        ]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    crate::settings::fixture_transcript(
        &mut state,
        json!({"toolCallExpansionDefaults":{"tools":{"other":"collapsed"}},"toolInputsVisibility":"hidden"}),
    );
    let hit = codenomad_client::search::Hit {
        session: "s".into(),
        message: "msg".into(),
        role: "assistant".into(),
        part: 0,
        kind: codenomad_client::search::Kind::Tool,
        excerpt: String::new(),
    };
    state.transcript_display.search_highlight = Some(crate::chat::search_hit::SearchHit::new(
        &hit,
        "DEEP_SKILL_NEEDLE",
        false,
    ));
    state.messages = vec![row.into()];
    let mut rt = Runtime::new(
        state,
        |s, cx| {
            cx.web_focus();
            with_locale("en", || {
                let crate::content::Part::Tool(tool) = &s.messages[0].parts[0] else {
                    panic!("tool part")
                };
                super::view(s, "msg", tool)
            })
        },
        (960.0, 820.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let skill_key = super::tool_key("msg", "sk");
    assert!(rt.find(&format!("{skill_key}-wrap")).is_none());
    assert!(rt.find("history-search-match").is_some());
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Skill heading") && !tree.contains("# Skill heading"));
    assert!(tree.contains("DEEP_SKILL_NEEDLE"));
    let crate::content::Part::Tool(tool) = &rt.state.messages[0].parts[0] else {
        panic!("tool part")
    };
    let output_hit = crate::chat::search_hit::SearchHit::new(&hit, "DEEP_SKILL_NEEDLE", false);
    assert!(!super::match_hidden_by_inputs(
        &rt.state,
        "msg",
        tool,
        output_hit.query(Some((codenomad_client::search::Kind::Tool, 0))),
    ));
    let link_url_hit = crate::chat::search_hit::SearchHit::new(&hit, "LINK_URL_ONLY", false);
    assert!(super::match_hidden_by_inputs(
        &rt.state,
        "msg",
        tool,
        link_url_hit.query(Some((codenomad_client::search::Kind::Tool, 0))),
    ));
    let entity_hit = crate::chat::search_hit::SearchHit::new(&hit, "R&D", false);
    assert!(!super::match_hidden_by_inputs(
        &rt.state,
        "msg",
        tool,
        entity_hit.query(Some((codenomad_client::search::Kind::Tool, 0))),
    ));
    let input_hit = crate::chat::search_hit::SearchHit::new(&hit, "INPUT_ONLY_NEEDLE", false);
    assert!(super::match_hidden_by_inputs(
        &rt.state,
        "msg",
        tool,
        input_hit.query(Some((codenomad_client::search::Kind::Tool, 0))),
    ));
    // Closing search preserves the revealed Skill prose step once expanded.
    rt.update(|s, _| {
        Display::set_expanded(s, &skill_key, true);
        s.transcript_display.mark_search_revealed(&skill_key);
        s.transcript_display.search_highlight = None;
    });
    rt.frame(0.01);
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("DEEP_SKILL_NEEDLE")
    );
}

#[test]
fn clock_stops_offscreen_or_on_session_change_and_rearms_after_same_session_suspend() {
    let start = unix_millis().saturating_sub(5_000);
    let row = crate::history::decode_message(&json!({
        "type":"assistant","id":"live","content":[
            {"type":"tool","id":"cmd","name":"bash","time":{"ran":start},
             "state":{"status":"running","input":{"command":"sleep 90"}}}
        ]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Streaming;
    state.messages = vec![row.into()];
    let mut rt = Runtime::new(
        state,
        |s, _| {
            with_locale("en", || {
                let Some(crate::content::Part::Tool(tool)) =
                    s.messages.first().and_then(|row| row.parts.first())
                else {
                    return rune::col();
                };
                let clip = s.transcript_display.tool_clock.clip_rect("test-clip");
                s.transcript_display.tool_clock.with_clip(&clip, || {
                    rune_theme_codenomad::markdown::tool_pane(
                        rune::col()
                            .child(super::view(s, "live", tool))
                            .children((0..40).map(|_| rune::text("spacer"))),
                        false,
                    )
                    .key("scroller")
                })
            })
        },
        (960.0, 200.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt.frame(0.0);
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 0.1, tx));
    });
    assert!(rt.wake_deadline().is_some());

    // Suspend rendered state while staying on the same session (reconnect / resume).
    rt.update(|s, _| s.transcript_display.suspend_rendered());
    rt.frame(0.2);
    rt.frame(0.2);
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 0.3, tx));
    });
    assert!(rt.wake_deadline().is_some());
    rt.update(|s, tx| {
        assert!(Display::poll(s, false, 1.4, tx));
    });

    let drain = |rt: &mut Runtime<crate::State>| {
        for _ in 0..30 {
            rt.frame(0.1);
        }
    };

    // Pause clock during disconnect (including detached history where phase stays Streaming).
    rt.update(|s, _| {
        s.history_detached = true;
        s.transcript_display.tool_clock.pause();
    });
    drain(&mut rt);
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 4.0, tx));
    });
    rt.frame(0.0);
    assert!(rt.wake_deadline().is_none());
    rt.update(|s, _| {
        s.history_detached = false;
        s.transcript_display.tool_clock.resume();
    });
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 4.1, tx));
    });
    rt.frame(0.0);
    assert!(rt.wake_deadline().is_some());

    // Clip header outside nested pane bounds (subagent steps) while still in transcript bounds.
    rt.state
        .transcript_display
        .tool_clock
        .clip_rect("test-clip")
        .set([0.0, 500.0, 960.0, 200.0]);
    drain(&mut rt);
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 6.0, tx));
    });
    rt.frame(0.0);
    assert!(rt.wake_deadline().is_none());
    rt.state
        .transcript_display
        .tool_clock
        .clip_rect("test-clip")
        .set([0.0, 0.0, 960.0, 200.0]);
    rt.frame(0.1);
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 6.2, tx));
    });
    rt.frame(0.0);
    assert!(rt.wake_deadline().is_some());

    // Clip header outside transcript history_bounds even while still mounted in the window.
    rt.update(|s, _| {
        s.tool_diff_preferences
            .history_bounds
            .set([0.0, 500.0, 960.0, 200.0]);
    });
    drain(&mut rt);
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 7.2, tx));
    });
    rt.frame(0.0);
    assert!(rt.wake_deadline().is_none());
    rt.update(|s, _| {
        s.tool_diff_preferences
            .history_bounds
            .set([0.0, 0.0, 960.0, 200.0]);
    });
    rt.frame(0.1);
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 7.4, tx));
    });
    rt.frame(0.0);
    assert!(rt.wake_deadline().is_some());

    // Scroll the running card off-screen so on_visible(false) stops the shared clock.
    rt.update(|_, tx| tx.scroll_to("scroller", 0.0, 600.0));
    drain(&mut rt);
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 10.5, tx));
    });
    rt.frame(0.0);
    assert!(rt.wake_deadline().is_none());

    // Bring back on screen, then switch session via bind() and verify clock stops.
    rt.update(|_, tx| tx.scroll_to("scroller", 0.0, 0.0));
    drain(&mut rt);
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 14.0, tx));
    });
    rt.frame(0.0);
    assert!(rt.wake_deadline().is_some());
    rt.update(|s, _| {
        s.transcript_display.bind("http://a", "ws", "other");
        s.messages.clear();
    });
    drain(&mut rt);
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 17.5, tx));
    });
    rt.frame(0.0);
    assert!(rt.wake_deadline().is_none());
}

#[test]
fn task_duration_runs_for_foreground_and_follows_background_reports() {
    let start = unix_millis().saturating_sub(12_000);
    let fg_row = crate::history::decode_message(&json!({
        "type":"assistant","id":"fg","content":[
            {"type":"tool","id":"call","name":"task","time":{"ran":start},
             "state":{"status":"running","input":{"description":"Foreground"},
                      "metadata":{"status":"running"}}}
        ]
    }))
    .unwrap();
    let bg_row = crate::history::decode_message(&json!({
        "type":"assistant","id":"bg","time":{"completed":start + 500},"content":[
            {"type":"tool","id":"call","name":"subagent","time":{"ran":start,"completed":start + 500},
             "state":{"status":"completed","input":{"description":"Background"},
                      "metadata":{"sessionID":"child","status":"running"}}}
        ]
    }))
    .unwrap();
    let report = crate::history::decode_message(&json!({
        "type":"synthetic","id":"rep","time":{"created":start + 9_000},
        "text":"<subagent sessionID=\"child\" state=\"completed\">\nDone\n</subagent>"
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Streaming;
    state.messages = vec![fg_row.into(), bg_row.into()];
    let mut rt = Runtime::new(
        state,
        |s, _| {
            with_locale("en", || {
                rune::col().children(s.messages.iter().flat_map(|row| {
                    row.parts.iter().filter_map(|part| {
                        let crate::content::Part::Tool(tool) = part else {
                            return None;
                        };
                        Some(super::view(s, &row.id, tool))
                    })
                }))
            })
        },
        (960.0, 600.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("12s") || tree.contains("13s"), "{tree}");
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 0.1, tx));
    });
    assert!(rt.wake_deadline().is_some());
    // Add background report and complete foreground task: background settles at 9s.
    rt.update(|s, _| {
        s.messages[0] = crate::history::decode_message(&json!({
            "type":"assistant","id":"fg","time":{"completed":start + 4_000},"content":[
                {"type":"tool","id":"call","name":"task","time":{"ran":start,"completed":start + 4_000},
                 "state":{"status":"completed","input":{"description":"Foreground"}}}
            ]
        }))
        .unwrap()
        .into();
        s.messages.push(report.into());
    });
    rt.frame(0.2);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("\"4s\"") && tree.contains("\"9s\""), "{tree}");
    rt.update(|s, tx| {
        assert!(!Display::poll(s, false, 2.0, tx));
    });
    rt.frame(2.1);
    assert!(rt.wake_deadline().is_none());

    // Relaunching the same child with a <background-result kind="subagent"> report drives
    // both launch cards' status and end time from the newest round (TRANSCRIPT.md).
    let bg_second = crate::history::decode_message(&json!({
        "type":"assistant","id":"bg2","time":{"completed":start + 15_500},"content":[
            {"type":"tool","id":"call2","name":"subagent","time":{"ran":start + 15_000,"completed":start + 15_500},
             "state":{"status":"completed","input":{"description":"Second run"},
                      "metadata":{"sessionID":"child","status":"running"}}}
        ]
    }))
    .unwrap();
    let bg_second_report = crate::history::decode_message(&json!({
        "type":"synthetic","id":"rep2","time":{"created":start + 21_000},
        "text":"<background-result kind=\"subagent\" sessionID=\"child\" state=\"completed\">\nSecond done\n</background-result>"
    }))
    .unwrap();
    rt.update(|s, _| {
        s.messages.push(bg_second.into());
        s.messages.push(bg_second_report.into());
    });
    rt.frame(2.2);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("\"21s\"") && tree.contains("\"6s\""),
        "{tree}"
    );
}

#[test]
fn clipped_running_tool_inside_observe_clip_does_not_spin_wakes() {
    let start = unix_millis().saturating_sub(5_000);
    let row = crate::history::decode_message(&json!({
        "type":"assistant","id":"clipped","content":[
            {"type":"tool","id":"call","name":"bash","time":{"ran":start},
             "state":{"status":"running","input":{"command":"sleep 10"}}}
        ]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Streaming;
    state.messages = vec![row.into()];
    state
        .tool_diff_preferences
        .history_bounds
        .set([0.0, 500.0, 960.0, 200.0]);
    let mut rt = Runtime::new(
        state,
        |s, _| {
            with_locale("en", || {
                crate::chat::tools::duration::observe_clip(
                    s,
                    rune::col().children(s.messages[0].parts.iter().filter_map(|part| {
                        let crate::content::Part::Tool(tool) = part else {
                            return None;
                        };
                        Some(super::view(s, "clipped", tool))
                    })),
                )
            })
        },
        (960.0, 600.0),
        Env::new(false, 1.0),
    );
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    // Trigger an observe_clip relayout while the running tool is mounted but clipped out of bounds.
    rt.set_viewport((900.0, 600.0), 1.0);
    for _ in 0..10 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.wake_deadline().is_none(),
        "clipped running tool inside observe_clip must not spin wake_after(ZERO): {:?}",
        rt.wake_deadline()
    );
}

#[test]
fn skill_search_hit_inside_mermaid_fence_reveals_source_with_match_anchor() {
    let raw_skill = "```mermaid\nflowchart LR\n  %% MERMAID_SEARCH_NEEDLE\n  A --> B\n```";
    let row = crate::history::decode_message(&json!({
        "type":"assistant","id":"mmd","time":{"completed":10000},"content":[
            {"type":"tool","id":"sk","name":"skill",
             "state":{"status":"completed","input":{"name":"diagram"},
                      "content":[{"type":"text","text":raw_skill}]}}
        ]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    let hit = codenomad_client::search::Hit {
        session: "s".into(),
        message: "mmd".into(),
        role: "assistant".into(),
        part: 0,
        kind: codenomad_client::search::Kind::Tool,
        excerpt: String::new(),
    };
    state.transcript_display.search_highlight = Some(crate::chat::search_hit::SearchHit::new(
        &hit,
        "MERMAID_SEARCH_NEEDLE",
        false,
    ));
    state.messages = vec![row.into()];
    let mut rt = Runtime::new(
        state,
        |s, cx| {
            cx.web_focus();
            with_locale("en", || {
                let crate::content::Part::Tool(tool) = &s.messages[0].parts[0] else {
                    panic!("tool part")
                };
                super::view(s, "mmd", tool)
            })
        },
        (960.0, 820.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    assert!(rt.find("history-search-match").is_some());
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("MERMAID_SEARCH_NEEDLE")
    );
    let skill_key = super::tool_key("mmd", "sk");
    let toggle = format!("{skill_key}-tool_output-code-0-diagram-toggle");
    let (x, y) = rt.find(&toggle).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(
        rt.find(&format!("{skill_key}-tool_output-code-0-diagram"))
            .is_some()
    );
    // Re-running even the exact same search reveals the Mermaid source and anchor again.
    rt.update(|s, _| {
        s.transcript_display.search_highlight = Some(crate::chat::search_hit::SearchHit::new(
            &hit,
            "MERMAID_SEARCH_NEEDLE",
            false,
        ));
    });
    rt.frame(0.04);
    assert!(rt.find("history-search-match").is_some());
    assert!(
        rt.find(&format!("{skill_key}-tool_output-code-0-diagram"))
            .is_none()
    );
}

#[test]
fn nested_subagent_uses_parent_child_snapshot_reports_for_status_duration_and_output() {
    let start = unix_millis().saturating_sub(20_000);
    let parent_row = crate::history::decode_message(&json!({
        "type":"assistant","id":"root_msg","time":{"completed":start + 500},"content":[
            {"type":"tool","id":"outer","name":"subagent","time":{"ran":start,"completed":start + 500},
             "state":{"status":"completed","input":{"description":"Outer"},
                      "metadata":{"sessionID":"child_a","status":"running"}}}
        ]
    }))
    .unwrap();
    let child_page = crate::history::decode(json!({
        "status":"window","latest":true,"messages":[
            {"id":"c1","type":"assistant","time":{"completed":start + 1_500},"content":[
                {"type":"tool","id":"inner","name":"subagent","time":{"ran":start + 1_000,"completed":start + 1_500},
                 "state":{"status":"completed","input":{"description":"Inner"},
                          "metadata":{"sessionID":"grandchild","status":"running"}}}
            ]},
            {"id":"c2","type":"synthetic","time":{"created":start + 8_000},
             "text":"<background-result kind=\"subagent\" sessionID=\"grandchild\" state=\"completed\">\nNESTED_REPORT_BODY\n</background-result>"}
        ]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    let outer_key = super::tool_key("root_msg", "outer");
    Display::set_expanded(&mut state, &outer_key, true);
    state.messages = vec![parent_row.into()];
    let _lease = state
        .transcript_display
        .children
        .install("child_a", child_page);
    assert!(state.transcript_display.children.poll());
    let inner_key = super::tool_key(&format!("{outer_key}-task-steps-child:child_a:c1"), "inner");
    Display::set_expanded(&mut state, &inner_key, true);
    let mut rt = Runtime::new(
        state,
        |s, _| {
            with_locale("en", || {
                let crate::content::Part::Tool(tool) = &s.messages[0].parts[0] else {
                    panic!("tool part")
                };
                super::view(s, "root_msg", tool)
            })
        },
        (960.0, 820.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("NESTED_REPORT_BODY") && tree.contains("\"7s\""),
        "{tree}"
    );
}

#[test]
fn task_search_highlights_and_reveals_deep_prompt_matches() {
    let deep_prompt = format!("{}\nDEEP_TASK_PROMPT_NEEDLE", "p".repeat(30_000));
    let row = crate::history::decode_message(&json!({
        "type":"assistant","id":"task_msg","time":{"completed":10000},"content":[
            {"type":"tool","id":"t1","name":"task",
             "state":{"status":"completed","input":{"description":"Run","prompt":deep_prompt}}}
        ]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    crate::settings::fixture_transcript(&mut state, json!({"toolInputsVisibility":"hidden"}));
    let hit = codenomad_client::search::Hit {
        session: "s".into(),
        message: "task_msg".into(),
        role: "assistant".into(),
        part: 0,
        kind: codenomad_client::search::Kind::Tool,
        excerpt: String::new(),
    };
    let search = crate::chat::search_hit::SearchHit::new(&hit, "DEEP_TASK_PROMPT_NEEDLE", false);
    state.transcript_display.search_highlight = Some(search.clone());
    state.messages = vec![row.into()];
    let crate::content::Part::Tool(tool) = &state.messages[0].parts[0] else {
        panic!("tool part")
    };
    assert!(!super::match_hidden_by_inputs(
        &state,
        "task_msg",
        tool,
        search.query(Some((codenomad_client::search::Kind::Tool, 0))),
    ));
    let mut rt = Runtime::new(
        state,
        |s, _| {
            with_locale("en", || {
                let crate::content::Part::Tool(tool) = &s.messages[0].parts[0] else {
                    panic!("tool part")
                };
                super::view(s, "task_msg", tool)
            })
        },
        (960.0, 820.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    assert!(rt.find("history-search-match").is_some());
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("DEEP_TASK_PROMPT_NEEDLE")
    );
}

#[test]
fn webfetch_structured_output_execute_search_and_localized_patch_title() {
    let wf_row = crate::history::decode_message(&json!({
        "type":"assistant","id":"wf_msg","time":{"completed":10000},"content":[
            {"type":"tool","id":"wf1","name":"webfetch",
             "state":{"status":"running","input":{"url":"https://example.test"},
                      "metadata":{"output":{"status":200,"ok":true}}}},
            {"type":"tool","id":"ex1","name":"execute",
             "state":{"status":"completed","input":{"code":"const x = 1;"},
                      "metadata":{"toolCalls":[{"tool":"read","status":"completed","input":{"filePath":"EXEC_SEARCH_NEEDLE.rs"}}]}}},
            {"type":"tool","id":"ap1","name":"apply_patch",
             "state":{"status":"completed","metadata":{"files":[{"relativePath":"a.rs","diff":"@@ -1 +1 @@\n-a\n+b"}]}}}
        ]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    let wf_key = super::tool_key("wf_msg", "wf1");
    Display::set_expanded(&mut state, &wf_key, true);
    let hit = codenomad_client::search::Hit {
        session: "s".into(),
        message: "wf_msg".into(),
        role: "assistant".into(),
        part: 1,
        kind: codenomad_client::search::Kind::Tool,
        excerpt: String::new(),
    };
    state.transcript_display.search_highlight = Some(crate::chat::search_hit::SearchHit::new(
        &hit,
        "EXEC_SEARCH_NEEDLE",
        false,
    ));
    state.messages = vec![wf_row.into()];
    let mut rt = Runtime::new(
        state,
        |s, _| {
            with_locale("en", || {
                let mut col = rune::col();
                for part in &s.messages[0].parts {
                    if let crate::content::Part::Tool(tool) = part {
                        col = col.child(super::view(s, "wf_msg", tool));
                    }
                }
                col
            })
        },
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("\"status\": 200") || tree.contains("200"),
        "{tree}"
    );
    assert!(tree.contains("EXEC_SEARCH_NEEDLE.rs"), "{tree}");
    assert!(tree.contains("Apply patch (1 file)"), "{tree}");
    assert!(rt.find("history-search-match").is_some());
    let (cx, cy) = rt.find(&format!("copy-{wf_key}-output")).unwrap();
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    rt.frame(0.02);
    assert!(clipboard.text().unwrap().contains("\"status\": 200"));
}

#[test]
fn running_webfetch_plain_text_and_hidden_inputs_per_card_toggle() {
    let row = crate::history::decode_message(&json!({
        "type":"assistant","id":"wf_live","time":{},"content":[
            {"type":"tool","id":"wf_str","name":"webfetch",
             "state":{"status":"running","input":{"url":"https://plain.test"},
                      "metadata":{"output":"plain live body"}}}
        ]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    crate::settings::fixture_transcript(&mut state, json!({"toolInputsVisibility":"hidden"}));
    let wf_key = super::tool_key("wf_live", "wf_str");
    Display::set_expanded(&mut state, &wf_key, true);
    state.messages = vec![row.into()];
    let mut rt = Runtime::new(
        state,
        |s, _| {
            with_locale("en", || {
                let crate::content::Part::Tool(tool) = &s.messages[0].parts[0] else {
                    panic!("expected tool")
                };
                super::view(s, "wf_live", tool)
            })
        },
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("plain live body"), "{tree}");
    assert!(!tree.contains("\"url\""), "{tree}");
    let (cx, cy) = rt.find(&format!("copy-{wf_key}-output")).unwrap();
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    rt.frame(0.02);
    assert_eq!(clipboard.text().unwrap().as_str(), "plain live body");
    let (ix, iy) = rt.find(&format!("toggle-{wf_key}-tool_input")).unwrap();
    rt.pointer_down(ix, iy);
    rt.pointer_up(ix, iy);
    rt.frame(0.02);
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("https://plain.test")
    );
}
