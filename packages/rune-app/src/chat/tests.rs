use crate::*;
use rune::edit::Mods;
use rune::{Env, Key, KeyEvent, Runtime};
use serde_json::json;

fn runtime() -> Runtime<State> {
    let mut s = init();
    s.messages = transport::synthetic();
    s.phase = Phase::Ready;
    let mut rt = Runtime::new(s, view, (960.0, 760.0), Env::new(true, 1.0));
    rt.frame(0.0);
    for _ in 0..10 {
        rt.frame(1.0 / 60.0);
    }
    rt
}
fn tap(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}
#[test]
fn opens_ten_thousand_rows_with_bounded_mounts_and_scrolls() {
    let mut rt = runtime();
    assert_eq!(rt.state.messages.len(), 10_000);
    assert!(
        rt.elements().len() < 250,
        "only visible rows mount: {}",
        rt.elements().len()
    );
    assert_eq!(rt.scroll_at_bottom("history"), Some(true));
    rt.wheel(400.0, 300.0, 1200.0);
    for _ in 0..90 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(rt.scroll_at_bottom("history"), Some(false));
    let (out, incoming) = bounded(64);
    rt.state.incoming = Some(incoming);
    rt.poll = Some(poll);
    out.send_blocking(Event::Message(Message {
        id: "streaming-reading".into(),
        role: "assistant".into(),
        body: String::new(),
        parts: vec![],
        completed: false,
    }))
    .unwrap();
    out.send_blocking(Event::Text(
        "streaming-reading".into(),
        content::TextEvent::Start { ordinal: Some(0) },
    ))
    .unwrap();
    out.send_blocking(Event::Text(
        "streaming-reading".into(),
        content::TextEvent::Delta {
            ordinal: Some(0),
            text: "\nstreamed while reading".into(),
        },
    ))
    .unwrap();
    rt.frame(1.0 / 60.0);
    assert_eq!(
        rt.scroll_at_bottom("history"),
        Some(false),
        "streaming preserves the reader's scroll position"
    );
    tap(&mut rt, "latest");
    for _ in 0..10 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(rt.scroll_at_bottom("history"), Some(true));
}
#[test]
fn long_realistic_paragraph_occupies_multiple_lines_in_the_transcript() {
    let mut state = init();
    state.messages = vec![Message {
        completed: true,
        parts: vec![],
        id: "long-paragraph".into(),
        role: "assistant".into(),
        body: "Un historique réel contient des paragraphes longs à lire intégralement. ".repeat(80),
    }];
    state.phase = Phase::Ready;
    let mut rt = Runtime::new(state, view, (960.0, 760.0), Env::new(true, 1.0));
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let body = rt
        .elements()
        .into_iter()
        .find(|e| e.path.ends_with("/body-long-paragraph"))
        .unwrap();
    assert!(
        body.rect[3] > 300.0,
        "paragraph must wrap rather than clip on a single line: {:?}",
        body.rect
    );
}
#[test]
fn multiline_input_submits_once_and_stream_preserves_unicode() {
    let mut rt = runtime();
    let (tx, commands) = bounded(1);
    rt.state.commands = Some(tx);
    tap(&mut rt, "composer");
    rt.paste("Bonjour 🦀\nDeuxième ligne");
    rt.frame(0.0);
    assert_eq!(rt.state.draft.text, "Bonjour 🦀\nDeuxième ligne");
    tap(&mut rt, "send");
    assert!(
        matches!(commands.try_recv(), Ok(Command::Prompt(body)) if body.text == "Bonjour 🦀\nDeuxième ligne")
    );
    tap(&mut rt, "send");
    assert!(commands.try_recv().is_err());
    let (out, incoming) = bounded(64);
    rt.state.incoming = Some(incoming);
    rt.poll = Some(poll);
    out.send_blocking(Event::Message(Message {
        completed: false,
        parts: vec![],
        id: "live".into(),
        role: "assistant".into(),
        body: "".into(),
    }))
    .unwrap();
    out.send_blocking(Event::Text(
        "live".into(),
        content::TextEvent::Start { ordinal: Some(0) },
    ))
    .unwrap();
    out.send_blocking(Event::Text(
        "live".into(),
        content::TextEvent::Delta {
            ordinal: Some(0),
            text: "été 🦀".into(),
        },
    ))
    .unwrap();
    out.send_blocking(Event::Done).unwrap();
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.messages.last().unwrap().body, "été 🦀");
    assert!(rt.state.phase == Phase::Ready);
}
#[test]
fn consecutive_sends_keep_distinct_responses_and_reenable_send() {
    let mut rt = runtime();
    let (commands_out, commands) = bounded(1);
    let (out, incoming) = bounded(64);
    rt.state.commands = Some(commands_out);
    rt.state.incoming = Some(incoming);
    rt.poll = Some(poll);
    for turn in 1..=2 {
        let prompt = format!("Question {turn}");
        tap(&mut rt, "composer");
        rt.paste(prompt.clone());
        rt.frame(0.0);
        tap(&mut rt, "send");
        let Ok(Command::Prompt(body)) = commands.try_recv() else {
            panic!("missing prompt")
        };
        assert_eq!(body.text, prompt);
        out.send_blocking(Event::PromptAcknowledged {
            attempted: body.id.unwrap(),
            outcome: crate::transport::PromptOutcome::Confirmed(format!("confirmed-{turn}")),
        })
        .unwrap();
        assert!(rt.state.phase == Phase::Streaming);
        for (kind, fields) in [
            (
                "session.step.started",
                json!({"assistantMessageID":format!("reply-{turn}")}),
            ),
            (
                "session.text.started",
                json!({"assistantMessageID":format!("reply-{turn}"),"ordinal":0}),
            ),
            (
                "session.text.delta",
                json!({"assistantMessageID":format!("reply-{turn}"),"ordinal":0,"delta":format!("Réponse {turn} 🦀")}),
            ),
            (
                "session.text.ended",
                json!({"assistantMessageID":format!("reply-{turn}"),"ordinal":0,"text":format!("Réponse {turn} 🦀")}),
            ),
            ("session.execution.succeeded", json!({})),
        ] {
            let mut data = fields;
            data["sessionID"] = "s".into();
            let envelope =
                json!({"type":"instance.event","instanceId":"w","event":{"type":kind,"data":data}});
            out.send_blocking(transport::decode_event(&envelope, "w", "s").unwrap())
                .unwrap();
        }
        rt.frame(1.0 / 60.0);
        assert!(rt.state.phase == Phase::Ready);
        assert_eq!(
            rt.state.messages.last().unwrap().body,
            format!("Réponse {turn} 🦀")
        );
    }
    let replies: Vec<_> = rt
        .state
        .messages
        .iter()
        .filter(|m| m.id.starts_with("reply-"))
        .collect();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0].body, "Réponse 1 🦀");
    assert_eq!(replies[1].body, "Réponse 2 🦀");
}
#[test]
fn selects_code_and_routes_copy_to_memory_clipboard() {
    let mut rt = runtime();
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    let body = rt
        .elements()
        .into_iter()
        .find(|e| e.path.ends_with("/body-synthetic-9999"))
        .expect("last code visible");
    let [x, y, _, h] = body.rect;
    rt.pointer_down(x + 1.0, y + 3.0);
    rt.pointer_move(x + 500.0, y + h - 2.0);
    rt.pointer_up(x + 500.0, y + h - 2.0);
    rt.frame(0.0);
    assert_eq!(rt.selected_text().as_deref(), Some(CODE));
    rt.key(KeyEvent {
        key: Key::Command('c'),
        mods: Mods {
            cmd: true,
            ctrl: true,
            ..Mods::default()
        },
    });
    rt.frame(0.0);
    assert_eq!(clipboard.text().as_deref().map(|s| s.as_str()), Some(CODE));
}
#[test]
fn v2_events_are_scoped_to_workspace_and_session() {
    let mut v = json!({"type":"instance.event","instanceId":"w","event":{"type":"session.text.delta", "data":{"sessionID":"s","assistantMessageID":"m","ordinal":0,"delta":"🦀"}}});
    assert!(
        matches!(transport::decode_event(&v,"w","s"), Some(Event::Text(id, content::TextEvent::Delta {ordinal:Some(0),text})) if id=="m" && text=="🦀")
    );
    assert!(transport::decode_event(&v, "other", "s").is_none());
    assert!(transport::decode_event(&v, "w", "other").is_none());
    v["event"]["type"] = "session.execution.succeeded".into();
    assert!(matches!(
        transport::decode_event(&v, "w", "s"),
        Some(Event::Done)
    ));
}
