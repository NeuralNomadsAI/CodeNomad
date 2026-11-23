use super::*;
use codenomad_client::search::{Hit, Kind};
use rune::{Cx, El, Env, Mods, Runtime};

fn hit(session: &str, message: &str, kind: Kind, part: u64) -> Hit {
    Hit {
        session: session.into(),
        message: message.into(),
        role: "assistant".into(),
        kind,
        part,
        excerpt: "Technical needle".into(),
    }
}

#[test]
fn preview_selection_revokes_a_previous_distant_jump_and_keeps_the_broker_excerpt() {
    let mut s = crate::init();
    let mut backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    backend.session = "here".into();
    super::super::observe(&mut s, &crate::transport::Event::Connected(backend));
    s.transcript_display.timeline.online = true;
    let (out, commands) = bounded(1);
    s.commands = Some(out);
    let mut rt = Runtime::new(s, view, (900.0, 600.0), Env::new(false, 1.0));
    rt.update(|s, tx| {
        let m = state(s);
        m.open = true;
        m.results = Some(Ranked::Ranked {
            version: 1,
            capped: false,
            examined_before: 0,
            exclusions: vec![],
            page: Page {
                hits: vec![
                    hit("here", "old", Kind::Tool, 1),
                    hit("elsewhere", "other", Kind::Reasoning, 4),
                ],
                ..Page::default()
            },
        });
        select(s, 0, tx);
        let crate::transport::Command::Anchor(jump) = commands.try_recv().unwrap() else {
            panic!("expected jump")
        };
        select(s, 1, tx);
        assert!(jump.cancelled.is_closed() && !super::super::navigation::pending_search(s));
        assert!(s.transcript_display.search_highlight.is_none());
        assert_eq!(
            preview::blocks(
                &hit("elsewhere", "other", Kind::Tool, 1),
                &["Earlier preview prefix".into()]
            )
            .collect::<Vec<_>>(),
            ["Technical needle", "Earlier preview prefix"]
        );
    });
}

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
