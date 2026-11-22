use crate::{State, gallery::shell::fixture, init, strings};
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};

fn english(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || crate::view(s, cx))
}
fn hebrew(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("he", || crate::view(s, cx))
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
}

fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("{key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(rt);
}

#[test]
fn fixed_toggles_keep_their_positions_and_drawers_retrace_on_resize() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english, (1400.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    let left = rt.find("sessions-panel-toggle").unwrap();
    let right = rt.find("right-panel-toggle").unwrap();
    assert!(rt.find("session-session").is_some());
    assert!(rt.find("right-panel").is_some());
    click(&mut rt, "sessions-panel-toggle");
    assert!(rt.find("session-session").is_none());
    assert_eq!(rt.find("sessions-panel-toggle"), Some(left));
    assert_eq!(rt.find("right-panel-toggle"), Some(right));
    click(&mut rt, "sessions-panel-toggle");
    for (width, panels) in [
        (1000.0, [true, true]),
        (930.0, [true, true]),
        (929.0, [true, false]),
        (610.0, [true, false]),
        (609.0, [false, false]),
        (390.0, [false, false]),
        (610.0, [true, false]),
        (930.0, [true, true]),
        (1400.0, [true, true]),
    ] {
        rt.set_viewport((width, 900.0), 1.0);
        settle(&mut rt);
        assert_eq!(
            [
                rt.find("session-session").is_some(),
                rt.find("right-panel").is_some()
            ],
            panels,
            "width {width}"
        );
        assert_eq!(rt.find("sessions-panel-toggle"), Some(left));
        assert_eq!(
            rt.find("right-panel-toggle"),
            Some((right.0 + width - 1400.0, right.1))
        );
    }
}

#[test]
fn floating_drawers_are_exclusive_and_escape_leaves_the_docked_choice() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english, (390.0, 900.0), Env::new(true, 1.0));
    settle(&mut rt);
    click(&mut rt, "sessions-panel-toggle");
    assert!(rt.find("session-session").is_some());
    click(&mut rt, "right-panel-toggle");
    assert!(rt.find("session-session").is_none());
    assert!(rt.find("right-panel").is_some());
    rt.key(KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    });
    settle(&mut rt);
    assert!(rt.find("right-panel").is_none());
    rt.set_viewport((1400.0, 900.0), 1.0);
    settle(&mut rt);
    assert!(rt.find("session-session").is_some() && rt.find("right-panel").is_some());
}

#[test]
fn a_floating_right_panel_docks_when_the_left_panel_makes_room() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english, (800.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    click(&mut rt, "right-panel-toggle");
    assert!(rt.find("right-panel").is_some());
    assert!(rt.find("right-panel-resize").is_none());
    click(&mut rt, "sessions-panel-toggle");
    assert!(rt.find("sessions-panel").is_none());
    assert!(rt.find("right-panel-resize").is_some());
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("\"key\":\"composer\"")
    );
}

#[test]
fn both_grips_resize_in_the_correct_direction_in_both_locales() {
    for (render, rtl) in [
        (english as fn(&State, &mut Cx<State>) -> El, false),
        (hebrew, true),
    ] {
        let mut state = init();
        fixture(&mut state);
        let mut rt = Runtime::new(state, render, (1400.0, 900.0), Env::new(false, 1.0));
        settle(&mut rt);
        let x = |rt: &Runtime<State>, key| rt.find(key).unwrap().0;
        assert_eq!(
            x(&rt, "sessions-panel-toggle") > x(&rt, "right-panel-toggle"),
            rtl
        );
        for (panel, grip, left) in [
            ("sessions-panel", "sessions-panel-resize", true),
            ("right-panel", "right-panel-resize", false),
        ] {
            let width = |rt: &Runtime<State>| {
                rt.elements()
                    .into_iter()
                    .find(|e| e.key.as_deref() == Some(panel))
                    .unwrap()
                    .rect[2]
            };
            let before = width(&rt);
            let (x, y) = rt.find(grip).unwrap();
            if left {
                assert_eq!(x > 700.0, rtl);
            }
            let dx = if left != rtl { 100.0 } else { -100.0 };
            rt.pointer_down(x, y);
            settle(&mut rt);
            rt.pointer_move(x + dx, 20.0);
            settle(&mut rt);
            assert!((width(&rt) - before - 100.0).abs() < 1.0, "{panel}");
            rt.pointer_up(x + dx, 20.0);
            settle(&mut rt);
            assert!((width(&rt) - before - 100.0).abs() < 1.0);
        }
    }
}

#[test]
fn compressed_grip_starts_at_its_presented_width_and_accepts_keyboard() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english, (700.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    let width = |rt: &Runtime<State>| {
        rt.elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("sessions-panel"))
            .unwrap()
            .rect[2]
    };
    assert_eq!(width(&rt), 310.0);
    let (x, y) = rt.find("sessions-panel-resize").unwrap();
    rt.pointer_down(x, y);
    settle(&mut rt);
    rt.pointer_move(x - 20.0, y);
    settle(&mut rt);
    rt.pointer_up(x - 20.0, y);
    settle(&mut rt);
    assert_eq!(width(&rt), 290.0);
    rt.update(|_, tx| tx.focus("sessions-panel-resize", true));
    settle(&mut rt);
    rt.key(KeyEvent {
        key: Key::Left,
        mods: Mods::default(),
    });
    settle(&mut rt);
    assert!(width(&rt) < 290.0);
}
