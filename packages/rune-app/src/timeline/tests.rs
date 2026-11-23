use super::*;
use rune::{Cx, El, Env, Runtime};
use serde_json::json;

fn assistant(id: &str) -> crate::history::Row {
    crate::history::decode_message(&json!({
        "id":id,"type":"assistant","time":{"completed":1},
        "content":[{"type":"text","text":"Lead"},
            {"type":"tool","id":"inspect","name":"read","state":{"status":"completed","output":"OK"}},
            {"type":"text","text":"Exact destination"}]
    })).unwrap().into()
}

fn user(id: &str) -> crate::history::Row {
    crate::history::decode_message(&json!({
        "id":id,"type":"user","text":"Long transcript below this anchor.\n\n".repeat(10)
    }))
    .unwrap()
    .into()
}

fn view(s: &State, cx: &mut Cx<State>) -> El {
    rune_theme_codenomad::layout::render(cx, |cx| crate::chat::view::chat_view(s, cx))
}

#[test]
fn resident_click_aligns_the_block_and_never_dispatches_a_window() {
    let mut s = crate::init();
    s.messages = std::iter::once(assistant("anchored"))
        .chain((0..35).map(|i| user(&format!("new-{i}"))))
        .collect();
    let (send, commands) = bounded(1);
    s.commands = Some(send);
    owner(&mut s).width = 800.0;
    owner(&mut s).changed = true;
    let mut runtime = Runtime::new(s, view, (800.0, 600.0), Env::new(false, 1.0));
    runtime.frame(0.0);
    runtime.update(|s, tx| {
        assert!(poll(s, tx));
        rune_theme_codenomad::timeline::show_marker(0, tx);
    });
    for _ in 0..6 {
        runtime.frame(0.016);
    }
    let (x, y) = runtime.find("anchored:Assistant:1:false").unwrap();
    runtime.pointer_down(x, y);
    runtime.pointer_up(x, y);
    for _ in 0..6 {
        runtime.frame(0.016);
    }
    let history = runtime.presented("history").unwrap().0;
    let block = runtime.presented("fragment-anchored:1").unwrap().0;
    let row = runtime.presented("anchored").unwrap().0;
    assert!(
        (block[1] - history[1]).abs() < 2.0,
        "block {block:?}, history {history:?}"
    );
    assert!(row[1] < block[1]);
    assert!(commands.try_recv().is_err());
}

#[test]
fn a_resident_click_revokes_the_distant_request_and_failed_reads_preserve_rows() {
    let mut s = crate::init();
    s.messages.push(assistant("anchored"));
    let (send, rx) = bounded(1);
    s.commands = Some(send);
    let t = owner(&mut s);
    t.width = 800.0;
    t.online = true;
    t.changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 600.0), Env::new(false, 1.0));
    rt.update(|s, tx| {
        poll(s, tx);
        let distant = Marker::from(timeline::Marker {
            message: "distant",
            kind: MarkerKind::User,
            ordinal: 0,
            continued: false,
            omitted_before: false,
            tool_name: None,
        });
        owner(s).markers.insert(0, distant.clone());
        navigation::select(s, &distant.id, tx);
        let crate::transport::Command::Anchor(jump) = rx.try_recv().unwrap() else {
            panic!("expected a jump")
        };
        navigation::failed(s, jump.ticket);
        assert!(owner(s).jump.retry.is_some());
        assert_eq!(s.messages[0].id, "anchored");
        navigation::select(s, &distant.id, tx);
        let crate::transport::Command::Anchor(jump) = rx.try_recv().unwrap() else {
            panic!("expected a jump")
        };
        navigation::select(s, "anchored:Assistant:1:false", tx);
        assert!(jump.cancelled.is_closed());
        assert_eq!(s.messages[0].id, "anchored");
    });
}

#[test]
fn reasoning_uses_the_rendered_run_not_the_native_fragment_ordinal() {
    let row: crate::history::Row = crate::history::decode_message(&json!({
        "id":"think","type":"assistant","time":{"completed":1},
        "content":[{"type":"reasoning","text":""},
            {"type":"reasoning","text":"First reasoning"},
            {"type":"reasoning","text":"Still first"},
            {"type":"text","text":"First response"},
            {"type":"reasoning","text":"Second reasoning"}]
    }))
    .unwrap()
    .into();
    let blocks = crate::chat::anchors::blocks(&row, 0, false);
    let reasoning = blocks
        .iter()
        .filter(|b| b.marker.kind == MarkerKind::Reasoning)
        .map(|b| (b.marker.ordinal, b.key.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        reasoning,
        [(0, "reasoning-think:1"), (1, "reasoning-think:3")]
    );
    let mut state = crate::init();
    state.messages = std::iter::once(row.clone())
        .chain((0..35).map(|i| user(&format!("doc-{i}"))))
        .collect();
    let target = Marker::from(blocks.last().unwrap().marker);
    owner(&mut state).width = 800.0;
    owner(&mut state).changed = true;
    let mut runtime = Runtime::new(state, view, (800.0, 600.0), Env::new(false, 1.0));
    runtime.frame(0.0);
    runtime.update(|s, tx| {
        poll(s, tx);
        navigation::select(s, &target.id, tx);
    });
    runtime.frame(0.016);
    let top = runtime.presented("history").unwrap().0[1];
    let group = runtime.presented("reasoning-think:3").unwrap().0[1];
    assert!(
        (top - group).abs() < 2.0,
        "history top {top}, group top {group}"
    );
}
