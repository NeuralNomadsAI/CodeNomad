use super::*;
use rune::{Env, Runtime};
use serde_json::json;

#[test]
fn a_group_spans_native_steps_without_renaming_its_tool_cards() {
    let decode = |id, name, call| {
        crate::history::decode_message(&json!({
            "id":id, "type":"assistant", "time":{"completed":1},
            "content":[{"type":"tool", "name":name, "id":call, "state":{"status":"completed"}}],
        }))
        .unwrap()
    };
    let mut s = crate::init();
    s.messages = [
        decode("read-turn", "read", "first"),
        decode("grep-turn", "grep", "second"),
        decode("shell-turn", "shell", "third"),
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    let mut rt = Runtime::new(
        s,
        |s, _| {
            crate::strings::with_locale("en", || {
                col().children((0..s.messages.len()).map(|i| message(s, i)))
            })
        },
        (960.0, 800.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.02);
    let group = "toggle-group-tool-read-turn:5:first";
    assert!(rt.find(group).is_some());
    assert!(rt.find("toggle-tool-read-turn:5:first").is_none());
    assert!(rt.find("toggle-tool-grep-turn:6:second").is_none());
    assert!(rt.find("toggle-tool-shell-turn:5:third").is_some());
    let (x, y) = rt.find(group).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(rt.find("toggle-tool-read-turn:5:first").is_some());
    assert!(rt.find("toggle-tool-grep-turn:6:second").is_some());

    rt.update(|s, _| {
        let separator = crate::history::decode_message(&json!({
            "id":"reply", "type":"assistant", "content":[{"type":"text", "text":"A reply."}],
        }))
        .unwrap();
        s.messages.insert(1, separator.into());
    });
    rt.frame(0.02);
    assert!(rt.find(group).is_none());
    assert!(rt.find("toggle-tool-grep-turn:6:second").is_some());
}

#[test]
fn system_context_uses_native_text_and_visibility_without_hiding_compaction() {
    let system = crate::history::decode_message(&json!({
        "type":"system", "id":"native", "text":"Context update *as written*"
    }))
    .unwrap();
    let compaction = crate::history::decode_message(&json!({
        "type":"compaction", "id":"compact", "summary":"Native compacted summary"
    }))
    .unwrap();
    let mut s = crate::init();
    s.messages = vec![system.into(), compaction.into()];
    let mut rt = Runtime::new(
        s,
        |s, _| {
            crate::strings::with_locale("en", || col().child(message(s, 0)).child(message(s, 1)))
        },
        (960.0, 800.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.02);
    assert!(rt.find("context-native").is_none());
    assert!(rt.find("context-compact").is_some());
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({"systemMessagesVisibility":"collapsed"}))
    });
    rt.frame(0.02);
    assert!(
        !rt.accessibility_json()
            .to_string()
            .contains("Context update *as written*")
    );
    let (x, y) = rt.find("toggle-context-native").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Context update *as written*") && tree.contains("Native compacted summary")
    );
}

#[test]
fn a_confirmed_tool_filter_keeps_the_passage_inside_a_virtual_row() {
    let row = crate::history::decode_message(&json!({
        "id":"long", "type":"assistant", "time":{"completed":1},
        "content":[
            {"type":"text", "text":"Before the tool\n\n".repeat(24)},
            {"type":"tool", "name":"bash", "id":"call", "state":{
                "status":"completed", "content":[{"type":"text","text":"Output line\n".repeat(12)}]
            }},
            {"type":"text", "text":format!("Current passage\n\n{}", "Following paragraph.\n\n".repeat(45))}
        ]
    })).unwrap();
    let mut s = crate::init();
    s.phase = crate::Phase::Ready;
    s.messages.push(row.into());
    let mut rt = Runtime::new(s, crate::view, (960.0, 800.0), Env::new(false, 1.0));
    let settle = |rt: &mut Runtime<State>| {
        for _ in 0..16 {
            rt.frame(1.0 / 60.0);
        }
    };
    rt.update(|s, tx| {
        crate::settings::poll(s, tx);
    });
    settle(&mut rt);
    rt.update(|_, tx| tx.scroll_key_to("long/fragment-long:1", -8.0));
    settle(&mut rt);
    let top = |rt: &Runtime<State>| {
        rt.elements()
            .iter()
            .find(|e| e.key.as_deref() == Some("fragment-long:1"))
            .unwrap()
            .rect[1]
    };
    let before = top(&rt);
    rt.update(|s, tx| {
        crate::settings::fixture_transcript(
            s,
            json!({"toolCallExpansionDefaults":{"tools":{"bash":"hidden"}}}),
        );
        crate::settings::poll(s, tx);
    });
    settle(&mut rt);
    assert!(
        (top(&rt) - before).abs() < 1.0,
        "passage moved from {before} to {}",
        top(&rt)
    );
    assert!(rt.find("toggle-tool-long:4:call").is_none());
}

#[test]
fn visibility_changes_keep_prose_and_explicit_card_disclosures() {
    let mut s = crate::init();
    let row = crate::history::decode_message(&json!({
        "id":"turn","type":"assistant","time":{"completed":1},
        "content":[
            {"type":"reasoning","text":"Private reasoning"},
            {"type":"tool","name":"read","id":"r","state":{"status":"completed","input":{"filePath":"project.txt"}}},
            {"type":"tool","name":"glob","id":"g","state":{"status":"completed","input":{"pattern":"src/*"}}},
            {"type":"text","text":"Public reply"}
        ]
    })).unwrap();
    s.messages.push(row.into());
    let mut rt = Runtime::new(
        s,
        |s, _| crate::strings::with_locale("en", || message(s, 0)),
        (960.0, 800.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.02);
    assert!(rt.find("group-tool-turn:1:r").is_some());
    assert!(rt.find("toggle-tool-turn:1:r").is_none());
    assert!(rt.find("reasoning-turn:0").is_none());

    rt.update(|s, _| {
        crate::settings::fixture_transcript(
            s,
            json!({
                "toolCallExpansionDefaults":{"preset":"everything"},
                "toolGroupVisibility":"expanded", "showThinkingBlocks":true,
                "thinkingBlocksExpansion":"expanded", "toolInputsVisibility":"expanded"
            }),
        );
    });
    rt.frame(0.02);
    assert!(rt.find("toggle-tool-turn:1:r").is_some());
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Private reasoning")
    );
    let (x, y) = rt.find("toggle-tool-turn:1:r").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(rt.find("toggle-tool-turn:1:r-tool_input").is_none());

    rt.update(|s, _| {
        crate::settings::fixture_transcript(
            s,
            json!({
                "toolCallExpansionDefaults":{"preset":"nothing"}
            }),
        )
    });
    rt.frame(0.02);
    assert!(rt.find("group-tool-turn:1:r").is_none());
    assert!(rt.find("reasoning-turn:0").is_none());
    assert!(rt.accessibility_json().to_string().contains("Public reply"));

    rt.update(|s, _| {
        crate::settings::fixture_transcript(
            s,
            json!({
                "toolCallExpansionDefaults":{"preset":"everything"},
                "toolGroupVisibility":"hidden"
            }),
        )
    });
    rt.frame(0.02);
    assert!(rt.find("group-tool-turn:1:r").is_none());
    assert!(rt.find("toggle-tool-turn:1:r").is_some());
    assert!(rt.find("toggle-tool-turn:1:r-tool_input").is_none());
    assert!(rt.find("toggle-tool-turn:1:g-tool_input").is_some());
}
