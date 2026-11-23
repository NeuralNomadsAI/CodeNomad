use super::*;

fn frames(rt: &mut Runtime<State>) {
    for _ in 0..90 {
        rt.frame(1.0 / 60.0);
    }
}
fn position(rt: &Runtime<State>) -> (String, f32) {
    let elements = rt.elements();
    let top = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("history"))
        .unwrap()
        .rect[1];
    elements
        .into_iter()
        .find(|n| {
            n.key.as_deref().is_some_and(|key| key.starts_with("body-")) && n.visible[3] > 0.0
        })
        .map(|n| (n.key.unwrap(), n.rect[1] - top))
        .unwrap()
}
fn history(rt: &mut Runtime<State>) {
    rt.update(|s, tx| {
        s.messages = crate::transport::synthetic();
        s.draft = rune::TextEdit::new("draft survives reader · été 🦀");
        s.revision += 1;
        tx.instant();
    });
    frames(rt);
}
fn arrived(rt: &mut Runtime<State>) {
    let (out, incoming) = crate::bounded(8);
    rt.state.incoming = Some(incoming);
    for event in [
        crate::transport::Event::Message(crate::Message {
            usage: None,
            id: "native-reader-arrival".into(),
            role: "assistant".into(),
            body: String::new(),
            parts: vec![],
            completed: false,
        }),
        crate::transport::Event::Text(
            "native-reader-arrival".into(),
            crate::content::TextEvent::Start { ordinal: Some(0) },
        ),
        crate::transport::Event::Text(
            "native-reader-arrival".into(),
            crate::content::TextEvent::Delta {
                ordinal: Some(0),
                text: "Streaming while reader is open · 🦀".into(),
            },
        ),
    ] {
        out.try_send(event).unwrap();
    }
    rt.update_if(|s, _| crate::poll_chat(s, 8));
    frames(rt);
    assert_eq!(rt.state.messages.len(), 10001);
    assert_eq!(
        rt.state.messages.last().unwrap().body,
        "Streaming while reader is open · 🦀"
    );
    assert!(
        !rt.elements()
            .iter()
            .any(|n| n.key.as_deref() == Some("history")
                || n.key.as_deref().is_some_and(|k| k.starts_with("body-")))
    );
}

#[test]
fn return_after_native_stream_and_resize_restores_anchor_on_every_frame() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "reader-resize-anchor"));
        history(&mut rt);
        rt.wheel(300.0, 300.0, 1200.0);
        frames(&mut rt);
        let before = position(&rt);
        open(&mut rt, &http, "main.rs", "Zm4gbWFpbigpIHt9").await;
        arrived(&mut rt);
        rt.set_viewport((620.0, 800.0), 1.0);
        frames(&mut rt);
        click(&mut rt, "file-close");
        for _ in 0..60 {
            let after = position(&rt);
            assert_eq!(after.0, before.0);
            assert!(
                (after.1 - before.1).abs() < 0.05,
                "before={before:?}, after={after:?}"
            );
            rt.frame(1.0 / 60.0);
        }
        assert_eq!(rt.state.draft.text, "draft survives reader · été 🦀");
        click(&mut rt, "latest");
        frames(&mut rt);
        assert!(rt.elements().iter().any(|n| n.text.as_deref()
            == Some("Streaming while reader is open · 🦀")
            && n.visible[3] > 0.0));
        http.quiet().await;
    });
}

#[test]
fn return_from_blank_message_padding_keeps_the_same_passage() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "reader-padding-anchor"));
        history(&mut rt);
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("synthetic-5000", 0.0);
        });
        frames(&mut rt);
        let row = rt
            .elements()
            .into_iter()
            .find(|n| n.key.as_deref() == Some("synthetic-5000"))
            .unwrap();
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("synthetic-5000", -(row.rect[3] - 2.0));
        });
        frames(&mut rt);
        let elements = rt.elements();
        let top = elements
            .iter()
            .find(|n| n.key.as_deref() == Some("history"))
            .unwrap()
            .rect[1];
        let row = elements
            .iter()
            .find(|n| n.key.as_deref() == Some("synthetic-5000"))
            .unwrap();
        let body = elements
            .iter()
            .find(|n| n.key.as_deref() == Some("body-synthetic-5000"))
            .unwrap();
        assert!(
            body.rect[1] + body.rect[3] < top && row.rect[1] + row.rect[3] > top,
            "top is in blank trailing padding"
        );
        let before = position(&rt);
        open(&mut rt, &http, "main.rs", "Zm4gbWFpbigpIHt9").await;
        arrived(&mut rt);
        click(&mut rt, "file-close");
        for _ in 0..60 {
            assert_eq!(position(&rt), before);
            rt.frame(1.0 / 60.0);
        }
        http.quiet().await;
    });
}

#[test]
fn return_to_following_bottom_includes_native_arrivals() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "reader-follow"));
        history(&mut rt);
        assert_eq!(rt.scroll_at_bottom("history"), Some(true));
        open(&mut rt, &http, "main.rs", "Zm4gbWFpbigpIHt9").await;
        arrived(&mut rt);
        rt.set_viewport((800.0, 760.0), 1.0);
        frames(&mut rt);
        click(&mut rt, "file-close");
        for _ in 0..60 {
            assert_eq!(rt.scroll_at_bottom("history"), Some(true));
            rt.frame(1.0 / 60.0);
        }
        assert_eq!(rt.state.draft.text, "draft survives reader · été 🦀");
        http.quiet().await;
    });
}
