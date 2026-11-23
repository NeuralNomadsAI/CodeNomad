//! A standalone rendering fixture using the production rail on both hosts.
use rune::{Cx, El, ScrollPos};
use rune_theme_codenomad::{layout, timeline};
use std::{cell::Cell, rc::Rc};

const COUNT: usize = 200_000;

struct Scene {
    width: f32,
    ids: Vec<String>,
    active: String,
    scroll: Rc<Cell<ScrollPos>>,
}

fn init() -> Scene {
    Scene {
        width: 0.0,
        ids: (0..COUNT).map(|i| format!("Message {i:05}")).collect(),
        active: String::new(),
        scroll: Default::default(),
    }
}

fn view(s: &Scene, cx: &mut Cx<Scene>) -> El {
    layout::render(cx, |_| {
        let mut conversation = rune::row()
            .w_full()
            .h_full()
            .fill(rune_theme_codenomad::tokens(layout::dark()).color("surface-canvas"))
            .on_layout(|s: &mut Scene, [_, _, width, _]| s.width = width)
            .child(
                rune::col()
                    .grow(1.0)
                    .child(rune::text(format!("Selection: {}", s.active)))
                    .child(
                        rune::row()
                            .role("button")
                            .focusable(true)
                            .label_static("Reveal last marker")
                            .child(rune::text("Reveal last marker"))
                            .on_press_tx(|s: &mut Scene, tx| {
                                timeline::show_marker(s.ids.len() - 1, tx)
                            }),
                    ),
            );
        if let Some(rail) = timeline::view(
            s.width,
            "en",
            s.ids.len(),
            0,
            |s: &Scene, i| s.ids[i].as_str().into(),
            |s: &Scene, i| timeline::Marker {
                label: s.ids[i].as_str().into(),
                current: "Current position",
                glyph: if i % 2 == 0 {
                    &timeline::icons::USER
                } else {
                    &timeline::icons::BOT
                },
                tone: if i % 2 == 0 {
                    "message-user-border"
                } else {
                    "message-assistant-border"
                },
                active: s.active == s.ids[i],
            },
            |s, key, _| s.active = key.into(),
            |_, _, button| button,
        ) {
            let scroll = s.scroll.clone();
            conversation = conversation.child(rail.on_scroll_offset(move |pos| scroll.set(pos)));
        }
        conversation
    })
}

fn main() {
    #[cfg(not(target_arch = "wasm32"))]
    if !std::env::args().any(|arg| arg == "--snap") {
        std::process::exit(2);
    }
    rune::App::new(layout::app_spec("History rail fixture", init, view)).run();
}

#[cfg(test)]
#[test]
fn fixed_geometry_virtualizes_and_activates_by_key() {
    use rune::{Env, Key, KeyEvent, Mods, Runtime};
    let mut rt = Runtime::new(init(), view, (420.0, 320.0), Env::new(false, 1.0));
    for _ in 0..8 {
        rt.frame(0.016);
    }
    let mounted = |rt: &Runtime<Scene>| {
        rt.elements()
            .into_iter()
            .filter(|node| {
                node.label
                    .as_deref()
                    .is_some_and(|n| n.starts_with("Message "))
            })
            .count()
    };
    assert!((10..256).contains(&mounted(&rt)));
    let scroll = rt.state.scroll.get();
    assert!(scroll.viewport[0] <= 40.0 && scroll.viewport[0] > 20.0);
    let expected = COUNT as f32 * 20.0 + (COUNT - 1) as f32 * 5.59375;
    assert!(
        (scroll.max[1] + scroll.viewport[1] - expected).abs() < 1.0,
        "{scroll:?}"
    );
    let (x, y) = rt.find("Message 00002").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.016);
    assert_eq!(rt.state.active, "Message 00002");
    rt.key(KeyEvent {
        key: Key::Tab,
        mods: Mods::default(),
    });
    rt.frame(0.016);
    let focused = rt.elements().into_iter().find(|node| node.focused);
    assert_eq!(
        focused.as_ref().and_then(|node| node.label.as_deref()),
        Some("Message 00003"),
        "{focused:?}"
    );
    rt.key(KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    });
    rt.frame(0.016);
    assert_eq!(rt.state.active, "Message 00003");
    rt.update(|_, tx| timeline::show_marker(COUNT - 1, tx));
    for _ in 0..8 {
        rt.frame(0.016);
    }
    let scroll = rt.state.scroll.get();
    assert!(
        (scroll.max[1] + scroll.viewport[1] - expected).abs() < 1.0,
        "{scroll:?}"
    );
    assert_eq!(scroll.offset[1], scroll.max[1]);
    assert!(rt.find("Message 199999").is_some());
    assert!(rt.find("Message 00000").is_none());
    rt.set_viewport((419.0, 320.0), 1.0);
    for _ in 0..4 {
        rt.frame(0.016);
    }
    assert!(rt.find(timeline::VIEWPORT).is_none());
}
