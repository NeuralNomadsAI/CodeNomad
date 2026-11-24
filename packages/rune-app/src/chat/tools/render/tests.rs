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
        tree.contains("Missing_custom")
            && tree.contains("\"name\":\"Shell\"")
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

    // Relaunching the same child with a <background-result kind="subagent"> report must keep the first launch's 9s duration.
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
        tree.contains("\"9s\"") && tree.contains("\"6s\"") && !tree.contains("\"21s\""),
        "{tree}"
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
}
