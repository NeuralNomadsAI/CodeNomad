use super::*;
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
    let (out, incoming) = mpsc::sync_channel(64);
    rt.state.incoming = Some(incoming);
    rt.poll = Some(poll);
    out.send(Event::Delta(
        "synthetic-9999".into(),
        "\nstreamed while reading".into(),
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
fn multiline_input_submits_once_and_stream_preserves_unicode() {
    let mut rt = runtime();
    let (tx, commands) = mpsc::sync_channel(1);
    rt.state.commands = Some(tx);
    tap(&mut rt, "composer");
    rt.paste("Bonjour 🦀\nDeuxième ligne");
    rt.frame(0.0);
    assert_eq!(rt.state.draft.text, "Bonjour 🦀\nDeuxième ligne");
    tap(&mut rt, "send");
    assert!(
        matches!(commands.try_recv(), Ok(Command::Send(body)) if body == "Bonjour 🦀\nDeuxième ligne")
    );
    tap(&mut rt, "send");
    assert!(commands.try_recv().is_err());
    let (out, incoming) = mpsc::sync_channel(64);
    rt.state.incoming = Some(incoming);
    rt.poll = Some(poll);
    out.send(Event::Message(Message {
        id: "live".into(),
        role: "assistant".into(),
        body: "".into(),
    }))
    .unwrap();
    out.send(Event::Delta("live".into(), "été 🦀".into()))
        .unwrap();
    out.send(Event::Done).unwrap();
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.messages.last().unwrap().body, "été 🦀");
    assert!(rt.state.phase == Phase::Ready);
}
#[test]
fn consecutive_sends_keep_distinct_responses_and_reenable_send() {
    let mut rt = runtime();
    let (commands_out, commands) = mpsc::sync_channel(1);
    let (out, incoming) = mpsc::sync_channel(64);
    rt.state.commands = Some(commands_out);
    rt.state.incoming = Some(incoming);
    rt.poll = Some(poll);
    for turn in 1..=2 {
        let prompt = format!("Question {turn}");
        tap(&mut rt, "composer");
        rt.paste(prompt.clone());
        rt.frame(0.0);
        tap(&mut rt, "send");
        assert!(matches!(commands.try_recv(), Ok(Command::Send(body)) if body == prompt));
        assert!(rt.state.phase == Phase::Streaming);
        for (kind, fields) in [
            (
                "session.step.started",
                json!({"assistantMessageID":format!("reply-{turn}")}),
            ),
            (
                "session.text.delta",
                json!({"assistantMessageID":format!("reply-{turn}"),"delta":format!("Réponse {turn} 🦀")}),
            ),
            ("session.execution.succeeded", json!({})),
        ] {
            let mut data = fields;
            data["sessionID"] = "s".into();
            let envelope =
                json!({"type":"instance.event","instanceId":"w","event":{"type":kind,"data":data}});
            out.send(transport::decode_event(&envelope, "w", "s").unwrap())
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
        matches!(transport::decode_event(&v,"w","s"), Some(Event::Delta(id, text)) if id=="m" && text=="🦀")
    );
    assert!(transport::decode_event(&v, "other", "s").is_none());
    assert!(transport::decode_event(&v, "w", "other").is_none());
    v["event"]["type"] = "session.execution.succeeded".into();
    assert!(matches!(
        transport::decode_event(&v, "w", "s"),
        Some(Event::Done)
    ));
}
