use super::*;
use rune::{Cx, Env, Key, KeyEvent, Runtime};

const MARKER: &str = "message-0:Assistant:0:false";

fn marker(i: usize, kind: MarkerKind) -> Marker {
    Marker {
        id: format!("marker-{i}"),
        message: format!("message-{i}"),
        kind,
        ordinal: 0,
        continued: false,
        omitted_before: false,
        tool: None,
        pending: false,
    }
}

#[test]
fn a_target_precedes_nearby_unique_messages_and_recent_absences_are_cached() {
    let mut s = crate::init();
    let markers = (0..40)
        .map(|i| marker(i, MarkerKind::Assistant))
        .collect::<Vec<_>>();
    let scope = s.rail_excerpts.scope();
    owner(&mut s).previews.cache_scope = Some(scope);
    s.rail_excerpts
        .remember(scope, "message-1".into(), None, 10.0);
    let mut visible = vec![
        marker(0, MarkerKind::Reasoning),
        marker(2, MarkerKind::Tool),
    ];
    visible.extend(markers);
    let ids = candidates(&s, &visible, Some("marker-39"), 20.0);
    assert_eq!(ids[0], "message-39");
    assert_eq!(ids.len(), PREVIEW_BATCH);
    assert!(!ids.contains(&"message-1".into()));
    assert!(candidates(&s, &visible[..4], None, 41.0).contains(&"message-1".into()));
}

fn runtime(text: String, size: (f32, f32)) -> Runtime<State> {
    fn view(s: &State, cx: &mut Cx<State>) -> El {
        rune_theme_codenomad::layout::render(cx, |cx| crate::chat::view::chat_view(s, cx))
            .on_layout_tx(|s, [_, _, w, h], tx| {
                if !window_layout(s, [w, h]) {
                    tx.live_only();
                }
            })
    }
    let mut s = crate::init();
    let scope = s.rail_excerpts.scope();
    s.rail_excerpts.remember(
        scope,
        "message-0".into(),
        Some(Excerpt {
            id: "message-0".into(),
            text,
            tools: String::new(),
        }),
        0.0,
    );
    let t = owner(&mut s);
    t.width = size.0;
    t.previews.cache_scope = Some(scope);
    t.outline = Some(std::sync::Arc::new(super::super::Outline {
        entries: vec![
            serde_json::from_value(serde_json::json!({
                "id":"message-0","seq":1,"type":"assistant","tools":0,"reasoning":0,"text":1,
            }))
            .unwrap(),
        ],
        total: 1,
        cacheable: true,
        saved: None,
    }));
    t.index_changed = true;
    t.changed = true;
    let mut rt = Runtime::new(s, view, size, Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.on_key = Some(crate::shell::keys);
    settle(&mut rt);
    rt
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..30 {
        rt.frame(0.016);
    }
}

#[test]
fn focused_marker_opens_and_escape_keeps_the_same_focus() {
    let mut rt = runtime("**Cached rail excerpt**".into(), (800., 600.));
    rt.update(|_, tx| tx.focus_when_shown(MARKER, true));
    settle(&mut rt);
    assert!(rt.find("timeline-peek").is_some());
    rt.key(KeyEvent {
        key: Key::Escape,
        mods: Default::default(),
    });
    for _ in 0..6 {
        rt.frame(0.016);
    }
    assert!(rt.find("timeline-peek").is_none());
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.key.as_deref() == Some(MARKER) && el.focused)
    );
    let (x, y) = rt.find(MARKER).unwrap();
    rt.pointer_move(x, y);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    assert!(rt.find("timeline-peek").is_some());
    let (x, y) = rt.find("timeline-peek").unwrap();
    rt.pointer_move(x, y);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    assert!(rt.find("timeline-peek").is_some());
    rt.key(KeyEvent {
        key: Key::Escape,
        mods: Default::default(),
    });
    rt.frame(0.016);
    assert!(rt.find("timeline-peek").is_none());
    let (x, y) = rt.find(MARKER).unwrap();
    rt.pointer_move(x, y);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    assert!(rt.find("timeline-peek").is_some());
    rt.set_viewport((850., 600.), 1.);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    assert!(rt.find("timeline-peek").is_none());
}

#[test]
fn touch_never_opens_and_a_clicked_marker_does_not_keep_the_preview() {
    let mut rt = runtime("Touch fixture".into(), (800., 600.));
    let (x, y) = rt.find(MARKER).unwrap();
    rt.touch(1, rune::TouchPhase::Started, x, y, 1.);
    for _ in 0..34 {
        rt.frame(0.016);
        assert!(rt.find("timeline-peek").is_none());
    }
    rt.touch(1, rune::TouchPhase::Ended, x, y, 1.54);
    settle(&mut rt);
    assert!(rt.find("timeline-peek").is_none());
    let mut rt = runtime("Click fixture".into(), (800., 600.));
    let (x, y) = rt.find(MARKER).unwrap();
    rt.pointer_move(x, y);
    settle(&mut rt);
    assert!(rt.find("timeline-peek").is_some());
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    // Hold the marker's non-keyboard focus even when the fixture cannot resolve its jump.
    rt.update(|_, tx| tx.focus_when_shown(MARKER, false));
    settle(&mut rt);
    rt.pointer_move(10., y);
    settle(&mut rt);
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.key.as_deref() == Some(MARKER) && el.focused && !el.focus_visible)
    );
    assert!(rt.find("timeline-peek").is_none());
}

#[test]
fn short_window_scrolls_and_exposes_the_complete_rendered_description() {
    let text = format!(
        "**Beginning** [link](https://example.invalid)\n\n{}Final `token`",
        "Line of text.\n\n".repeat(80)
    );
    let mut rt = runtime(text, (800., 290.));
    rt.update(|_, tx| tx.focus_when_shown(MARKER, true));
    settle(&mut rt);
    let key = rune_theme_codenomad::timeline::preview::KEY;
    let [x, y, w, h] = rt.presented(key).unwrap().0;
    assert!(y >= 0. && y + h <= 290. && h <= 258.);
    fn named<'a>(node: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
        if node["key"] == key {
            Some(node)
        } else {
            node["children"]
                .as_array()?
                .iter()
                .find_map(|child| named(child, key))
        }
    }
    let tree = rt.accessibility_json();
    let button = named(&tree, MARKER).unwrap();
    assert_eq!(
        button["description"],
        format!("Beginning link {}Final token", "Line of text. ".repeat(80))
    );
    let tail = |rt: &Runtime<State>| {
        rt.elements()
            .into_iter()
            .find(|el| {
                el.path.contains(key)
                    && el
                        .text
                        .as_deref()
                        .is_some_and(|text| text.starts_with("Beginning"))
            })
            .map(|el| el.rect[1])
    };
    let before = tail(&rt).unwrap();
    rt.pointer_move(x + w / 2., y + h / 2.);
    rt.wheel(x + w / 2., y + h / 2., -3500.);
    settle(&mut rt);
    assert!(rt.find(key).is_some());
    assert!(tail(&rt).is_none_or(|y| y < before));
}

#[test]
fn excerpt_limit_is_shared_by_tab_caches_but_not_between_windows() {
    let mut s = crate::init();
    let tab = s.rail_excerpts.scope();
    owner(&mut s).previews.cache_scope = Some(tab);
    for i in 0..512 {
        s.rail_excerpts
            .remember(tab, format!("message-{i}"), None, 0.);
    }
    let display = std::mem::take(&mut s.transcript_display);
    let other = s.rail_excerpts.scope();
    s.rail_excerpts
        .remember(other, "message-0".into(), None, 1.);
    s.transcript_display = display;
    assert_eq!(s.rail_excerpts.order.len(), 512);
    let restored = owner(&mut s).previews.cache_scope;
    assert!(s.rail_excerpts.get(restored, "message-0").is_none());
    assert!(s.rail_excerpts.get(Some(other), "message-0").is_some());
    assert!(crate::init().rail_excerpts.order.is_empty());
}
