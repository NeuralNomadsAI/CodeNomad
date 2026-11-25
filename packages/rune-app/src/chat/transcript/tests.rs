use super::*;
use rune::{Env, Runtime};
use serde_json::json;

#[test]
fn live_permissions_and_forms_split_groups_but_pending_and_failed_calls_do_not() {
    let mut s = crate::init();
    let row = crate::history::decode_message(&json!({
        "id":"steps","type":"assistant","content":[
            {"type":"tool","id":"first","name":"read","state":{"status":"error","error":"failed"}},
            {"type":"tool","id":"middle","name":"read","state":{"status":"pending"}},
            {"type":"tool","id":"last","name":"read","state":{"status":"running"}}
        ]
    }))
    .unwrap();
    s.phase = crate::Phase::Ready;
    s.messages.push(row.into());
    let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:1").unwrap();
    s.agent = Some(crate::agent::Ui::new(crate::agent::start(
        backend,
        s.wake.clone(),
    )));
    let mut rt = Runtime::new(
        s,
        |s, _| crate::strings::with_locale("en", || message(s, 0)),
        (960.0, 800.0),
        Env::new(false, 1.0),
    );
    let group = "toggle-group-tool-steps:5:first";
    let target = "toggle-tool-steps:6:middle";
    rt.frame(0.02);
    assert!(
        rt.find(group).is_some(),
        "pending/error without an active request still group"
    );
    rt.update(|s, _| {
        s.agent.as_mut().unwrap().permissions = crate::agent_api::permissions(
            &json!({"data":[
                {"sessionID":"session","id":"allow","action":"read","resources":[],
                 "source":{"messageID":"steps","id":"middle"}}
            ]}),
            "session",
        )
        .unwrap();
    });
    rt.frame(0.02);
    assert!(rt.find(group).is_none());
    assert!(rt.find(target).is_some());
    rt.update(|s, _| {
        s.agent.as_mut().unwrap().permissions.clear();
        s.agent.as_mut().unwrap().forms = crate::agent_api::forms(
            &json!({"data":[
                {"sessionID":"session","id":"form","title":"Confirm","fields":[{"key":"a"}],
                 "metadata":{"tool":{"messageID":"steps","id":"middle"}}}
            ]}),
            "session",
        )
        .unwrap();
        crate::settings::fixture_transcript(
            s,
            json!({"toolCallExpansionDefaults":{"tools":{"read":"hidden"}}}),
        );
    });
    rt.frame(0.02);
    assert!(
        rt.find(target).is_some(),
        "active form beats tool visibility"
    );
    assert!(rt.find("toggle-tool-steps:5:first").is_none());
    rt.update(|s, _| s.agent.as_mut().unwrap().forms.clear());
    rt.frame(0.02);
    assert!(
        rt.find(target).is_none(),
        "settlement returns to the saved tool visibility"
    );
}

#[test]
fn enabling_tool_groups_anchors_the_collapsed_group_at_the_reading_offset() {
    let mut s = crate::init();
    s.phase = crate::Phase::Ready;
    let row = crate::history::decode_message(&json!({
        "id":"long","type":"assistant","time":{"completed":1},"content":[
            {"type":"text","text":"Prelude.\n\n".repeat(45)},
            {"type":"tool","name":"read","id":"one","state":{"status":"completed"}},
            {"type":"tool","name":"grep","id":"two","state":{"status":"completed"}},
            {"type":"text","text":"Afterwards.\n\n".repeat(60)}
        ]
    }))
    .unwrap();
    s.messages.push(row.into());
    crate::settings::fixture_transcript(&mut s, json!({"toolGroupVisibility":"hidden"}));
    let mut rt = Runtime::new(s, crate::view, (960.0, 800.0), Env::new(false, 1.0));
    let settle = |rt: &mut Runtime<State>| {
        for _ in 0..16 {
            rt.frame(0.016);
        }
    };
    rt.update(|s, tx| {
        crate::settings::poll(s, tx);
    });
    settle(&mut rt);
    rt.update(|_, tx| tx.scroll_key_to("long/tool-long:3:two", -8.0));
    settle(&mut rt);
    let y = |rt: &Runtime<State>, key: &str| {
        rt.elements()
            .into_iter()
            .find(|node| node.key.as_deref() == Some(key))
            .unwrap()
            .rect[1]
    };
    let before = y(&rt, "tool-long:3:two");
    rt.update(|s, tx| {
        crate::settings::fixture_transcript(s, json!({"toolGroupVisibility":"collapsed"}));
        crate::settings::poll(s, tx);
    });
    settle(&mut rt);
    assert!(rt.find("toggle-tool-long:3:two").is_none());
    let after = y(&rt, "group-tool-long:3:one");
    assert!((after - before).abs() < 1.0, "{before} -> {after}");
}

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

#[test]
fn collapsed_shell_group_exposes_background_action_in_its_header() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    crate::platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (req_tx, req_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let n = stream.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n])
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_owned();
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
                let _ = req_tx.send(head);
            }
        });

        let mut backend =
            crate::backend::Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
        backend.workspace = "ws".into();
        backend.session = "ses".into();

        let mut s = crate::init();
        crate::settings::fixture_transcript(&mut s, json!({"toolGroupVisibility": "collapsed"}));
        s.transcript_display.children.bind(backend);
        s.messages = [
            json!({"id":"m1","type":"assistant","content":[
                {"type":"tool","id":"s1","name":"bash","state":{"status":"completed","input":{"command":"echo 1"}}}
            ]}),
            json!({"id":"m2","type":"assistant","content":[
                {"type":"tool","id":"s2","name":"bash","state":{"status":"running","input":{"command":"sleep 10"}}}
            ]}),
            json!({"id":"m3","type":"assistant","content":[
                {"type":"tool","id":"r1","name":"read","state":{"status":"completed","input":{}}},
                {"type":"tool","id":"r2","name":"read","state":{"status":"running","input":{}}}
            ]}),
        ]
        .into_iter()
        .map(|value| crate::history::decode_message(&value).unwrap().into())
        .collect();

        let mut rt = Runtime::new(
            s,
            |s, _| {
                crate::strings::with_locale("en", || {
                    col()
                        .full_width()
                        .children((0..s.messages.len()).map(|i| message(s, i)))
                })
            },
            (960.0, 800.0),
            Env::new(false, 1.0),
        );
        rt.frame(0.016);

        let shell_toggle = "toggle-group-tool-m1:2:s1";
        let shell_bg = "background-group-tool-m1:2:s1";
        let read_bg = "background-group-tool-m3:2:r1";

        // Shell group stays collapsed while exposing the background button in its header.
        assert!(rt.find(shell_toggle).is_some());
        assert!(rt.find("tool-m1:2:s1").is_none());
        assert!(rt.find("tool-m2:2:s2").is_none());
        assert!(
            rt.find(shell_bg).is_some(),
            "collapsed shell group with a running call must expose background action in header"
        );
        // Exploration group with a running read call must not expose a background action.
        assert!(rt.find("toggle-group-tool-m3:2:r1").is_some());
        assert!(rt.find(read_bg).is_none());

        // Clicking the header background action triggers the session background endpoint.
        let (x, y) = rt.find(shell_bg).unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.016);

        let request_line = req_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("clicking shell group background button must POST session background");
        assert!(
            request_line.starts_with("POST /workspaces/ws/instance/api/session/ses/background "),
            "unexpected request line: {request_line}"
        );
        server.join().unwrap();

        // Once all shell calls in the group complete, the header background action disappears.
        rt.update(|s, _| {
            s.messages[1] = crate::history::decode_message(&json!({"id":"m2","type":"assistant","content":[
                {"type":"tool","id":"s2","name":"bash","state":{"status":"completed","input":{"command":"sleep 10"}}}
            ]}))
            .unwrap()
            .into();
        });
        rt.frame(0.016);
        assert!(rt.find(shell_toggle).is_some());
        assert!(rt.find(shell_bg).is_none());
    });
}
