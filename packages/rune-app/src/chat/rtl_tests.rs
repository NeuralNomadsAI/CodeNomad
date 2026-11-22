use crate::{CODE, Message, Phase, State, init, strings};
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};

fn english(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || crate::view(s, cx))
}
fn hebrew(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("he", || crate::view(s, cx))
}
fn runtime(render: fn(&State, &mut Cx<State>) -> El) -> Runtime<State> {
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![Message {
        completed: true,
        id: "rtl-code".into(),
        role: "assistant".into(),
        body: CODE.into(),
        parts: vec![],
    }];
    let mut runtime = Runtime::new(state, render, (1400.0, 900.0), Env::new(false, 1.0));
    for _ in 0..12 {
        runtime.frame(0.02);
    }
    runtime
}
#[test]
fn real_chat_controls_follow_the_explicit_catalogue_direction() {
    let en = runtime(english);
    let he = runtime(hebrew);
    assert!(en.find("older").unwrap().0 < en.find("latest").unwrap().0);
    assert!(he.find("older").unwrap().0 > he.find("latest").unwrap().0);
    assert!(
        en.accessibility_json()
            .to_string()
            .contains(strings::with_locale("en", || strings::t("rune.latest")))
    );
    assert!(
        he.accessibility_json()
            .to_string()
            .contains(strings::with_locale("he", || strings::t("rune.latest")))
    );
}
#[test]
fn rtl_chat_keeps_code_selectable_and_editor_paragraphs_in_their_own_direction() {
    let mut rt = runtime(hebrew);
    let body = rt
        .elements()
        .into_iter()
        .find(|e| e.path.ends_with("/body-rtl-code"))
        .unwrap();
    let [x, y, width, height] = body.rect;
    rt.pointer_down(x + 1.0, y + 3.0);
    rt.pointer_move(x + 20.0, y + 3.0);
    rt.pointer_up(x + 20.0, y + 3.0);
    rt.frame(0.0);
    let prefix = rt
        .selected_text()
        .expect("code starts at the left edge in RTL chrome");
    assert!(!prefix.is_empty() && CODE.starts_with(&prefix));
    rt.pointer_down(x + 1.0, y + 3.0);
    rt.pointer_move(x + width - 1.0, y + height - 2.0);
    rt.pointer_up(x + width - 1.0, y + height - 2.0);
    rt.frame(0.0);
    assert_eq!(rt.selected_text().as_deref(), Some(CODE));
    for (text, rtl) in [("C:/example/project", false), ("שלום", true)] {
        let mut rt = runtime(hebrew);
        let (x, y) = rt.find("composer").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.paste(text);
        rt.frame(0.0);
        let start = KeyEvent {
            key: Key::Home,
            mods: Mods {
                ctrl: true,
                ..Mods::default()
            },
        };
        rt.key(start.clone());
        rt.key_up(start);
        rt.frame(0.0);
        let first_element = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("composer"))
            .unwrap();
        assert_eq!(first_element.text.as_deref(), Some(text));
        assert_eq!(first_element.edit_range, Some([0, 0]));
        let first = first_element.caret.unwrap()[0];
        let end = KeyEvent {
            key: Key::End,
            mods: Mods {
                ctrl: true,
                ..Mods::default()
            },
        };
        rt.key(end.clone());
        rt.key_up(end);
        rt.frame(0.0);
        let last_element = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("composer"))
            .unwrap();
        assert_eq!(last_element.edit_range, Some([text.len(), text.len()]));
        let last = last_element.caret.unwrap()[0];
        assert_ne!(first, last, "both editor caret endpoints must be measured");
        assert_eq!(first > last, rtl, "editor paragraph direction for {text}");
    }
}
