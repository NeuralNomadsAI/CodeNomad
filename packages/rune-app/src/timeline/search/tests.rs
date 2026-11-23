use super::*;
use rune::{Cx, El, Env, Mods, Runtime};

fn view(s: &State, cx: &mut Cx<State>) -> El {
    rune_theme_codenomad::layout::render(cx, |_| {
        rune::col().children(trigger(s)).children(panel(s))
    })
}

#[test]
fn keyboard_opens_the_search_and_query_edits_revoke_obsolete_results() {
    let mut s = crate::init();
    let mut backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    backend.session = "test-session".into();
    backend.workspace = "test-workspace".into();
    super::super::observe(&mut s, &crate::transport::Event::Connected(backend));
    let mut rt = Runtime::new(s, view, (900.0, 600.0), Env::new(false, 1.0));
    rt.frame(0.016);
    rt.update(|s, tx| {
        assert!(keys(
            s,
            &KeyEvent {
                key: Key::Command('f'),
                mods: Mods {
                    ctrl: true,
                    ..Default::default()
                }
            },
            tx
        ));
    });
    rt.frame(0.016);
    assert!(
        rt.elements()
            .into_iter()
            .any(|el| el.path.contains(FIELD) && el.role == "textbox" && el.focused)
    );
    rt.update(|s, tx| {
        let model = state(s);
        model.query = TextEdit::new("ab");
        assert!(poll(s, 1.0, tx));
        assert!(state(s).due.is_none());
        let model = state(s);
        model.text = "obsolete".into();
        model.query = TextEdit::new("Été");
        let (signal, cancelled) = bounded(1);
        let (out, events) = bounded(1);
        model.flight = Some((signal, events));
        out.try_send(Message::Complete(Ok(Ranked::Unsupported)))
            .ok()
            .unwrap();
        assert!(poll(s, 2.0, tx));
        assert!(cancelled.is_closed() && state(s).results.is_none());
        assert_eq!(state(s).due, Some(2.25));
        assert!(keys(
            s,
            &KeyEvent {
                key: Key::Escape,
                mods: Mods::default()
            },
            tx
        ));
        assert!(!is_open(s));
    });
}
