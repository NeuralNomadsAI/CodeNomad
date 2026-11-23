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
    assert!(rt.find("copy-tool-result:5:skill_running-output").is_none());
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
    assert!(ticked);
    let before = rt.state.transcript_display.tool_clock.epoch();
    rt.update(|s, tx| ticked = Display::poll(s, false, 0.5, tx));
    assert!(!ticked);
    assert_eq!(rt.state.transcript_display.tool_clock.epoch(), before);
    rt.update(|s, tx| ticked = Display::poll(s, false, 1.1, tx));
    assert!(ticked);
    assert!(rt.state.transcript_display.tool_clock.epoch() > before);
    rt.frame(1.1);
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
    let settled = rt.state.transcript_display.tool_clock.epoch();
    assert!(rt.accessibility_json().to_string().contains("1m 7s"));
    rt.update(|s, tx| ticked = Display::poll(s, false, 3.5, tx));
    assert!(!ticked);
    assert_eq!(rt.state.transcript_display.tool_clock.epoch(), settled);
}
