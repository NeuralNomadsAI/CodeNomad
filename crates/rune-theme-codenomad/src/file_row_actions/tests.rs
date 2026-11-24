use super::*;
use crate::action_menu;
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};

struct App {
    row: State,
    menus: action_menu::State<App>,
    actions: Rc<Actions<App>>,
    width: f32,
    events: Vec<&'static str>,
    coarse: bool,
    focus_within: bool,
    row_clicks: usize,
    rtl: bool,
}
fn at<'a>(s: &'a mut App, key: &str) -> Option<&'a mut State> {
    (key == "files").then_some(&mut s.row)
}
fn menu_at(s: &mut App) -> Option<&mut action_menu::State<App>> {
    Some(&mut s.menus)
}
fn actions() -> Rc<Actions<App>> {
    let mut pin = Item::new("pin", "Preview", |s: &mut App, _| s.events.push("pin"));
    pin.checked = Some(false);
    let open = Item::new("open", "Open", |s: &mut App, _| s.events.push("open"));
    let mut disabled = Item::new("disabled", "Disabled", |s: &mut App, _| {
        s.events.push("disabled")
    });
    disabled.disabled = true;
    Rc::new(Actions::new(Menu::new(
        "files",
        "Actions",
        vec![Rc::new(pin), Rc::new(open), Rc::new(disabled)],
    )))
}
fn update(s: &mut App, tx: &mut Tx) {
    let budget = Budget {
        available: s.width,
        required: 30.0 + natural_width(&s.actions),
    };
    sync(&mut s.row, &s.actions, s.menus.is_open("files"), budget, tx);
}
fn view_app(s: &App, cx: &mut Cx<App>) -> El {
    cx.web_focus();
    layout::render(cx, |_| {
        let (buttons, popup) = view(
            &s.row,
            at,
            &s.menus,
            menu_at,
            s.actions.clone(),
            Visibility {
                coarse_pointer: s.coarse,
                focus_within: s.focus_within,
            },
            400.0,
        );
        rune_kit::root(
            rune::col().w_full().h_full().child(
                rune::row()
                    .dir(if s.rtl {
                        rune::Direction::Rtl
                    } else {
                        rune::Direction::Ltr
                    })
                    .key("row")
                    .role("treeitem")
                    .label("File")
                    .w(s.width)
                    .h(30.0)
                    .hover_group()
                    .on_press(|s: &mut App| s.row_clicks += 1)
                    .child(rune::text("File").grow(1.0))
                    .child(buttons),
            ),
            popup,
        )
    })
}
fn runtime(width: f32) -> Runtime<App> {
    let mut rt = Runtime::new(
        App {
            row: State::default(),
            menus: action_menu::State::default(),
            actions: actions(),
            width,
            events: vec![],
            coarse: true,
            focus_within: false,
            row_clicks: 0,
            rtl: false,
        },
        view_app,
        (400.0, 180.0),
        Env::new(false, 1.0),
    );
    rt.update(update);
    rt.frame(0.0);
    rt
}
fn deliver(rt: &mut Runtime<App>) {
    rt.update(|s, tx| {
        action_menu::poll(s, menu_at, tx);
        update(s, tx)
    });
    rt.frame(0.0);
}
fn tap(rt: &mut Runtime<App>, key: &str) {
    let (x, y) = rt.find(key).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    deliver(rt)
}
fn focus(rt: &mut Runtime<App>, key: &str) {
    let key = key.to_owned();
    rt.update(move |_, tx| tx.focus(key, true));
    rt.frame(0.0);
    deliver(rt)
}
fn focused(rt: &Runtime<App>) -> Option<String> {
    rt.elements()
        .into_iter()
        .find(|e| e.focused)
        .and_then(|e| e.key)
}

#[test]
fn compact_file_overflow_opens_with_only_an_unavailable_action() {
    let mut rt = runtime(50.0);
    rt.update(|s, tx| {
        let actions = actions();
        let disabled = actions
            .menu
            .items
            .iter()
            .find(|item| item.disabled)
            .unwrap()
            .clone();
        s.actions = Rc::new(Actions::new(Menu::new("files", "Actions", vec![disabled])));
        update(s, tx);
    });
    focus(&mut rt, "files:trigger");
    for key in [Key::Enter, Key::Enter] {
        rt.key(KeyEvent {
            key,
            mods: Mods::default(),
        });
        rt.frame(0.0);
    }
    deliver(&mut rt);
    assert_eq!(focused(&rt).as_deref(), Some("files:item:disabled"));
    assert!(rt.state.menus.is_open("files"));
    assert!(rt.state.events.is_empty());
}

#[test]
fn enter_and_space_activate_independent_inline_buttons_once() {
    for (key, target, expected) in [
        (Key::Enter, "files:pinned:pin", "pin"),
        (Key::Text(" ".into()), "files:pinned:pin", "pin"),
        (Key::Enter, "files:inline:open", "open"),
    ] {
        let mut rt = runtime(220.0);
        focus(&mut rt, target);
        rt.key(KeyEvent {
            key: key.clone(),
            mods: Mods::default(),
        });
        rt.frame(0.0);
        rt.key_up(KeyEvent {
            key,
            mods: Mods::default(),
        });
        deliver(&mut rt);
        assert_eq!(rt.state.events, [expected], "{target}");
        assert_eq!(rt.state.row_clicks, 0);
    }
}

#[test]
fn false_toggle_is_pinned_and_natural_budget_ignores_empty_groups() {
    let mut rt = runtime(220.0);
    assert!(
        !rt.state.row.compact(),
        "width={},required={}",
        rt.state.width,
        30.0 + natural_width(&rt.state.actions)
    );
    assert_eq!(natural_width(&rt.state.actions), 76.0);
    tap(&mut rt, "files:pinned:pin");
    assert_eq!(rt.state.events, ["pin"]);
    assert_eq!(rt.state.row_clicks, 0);
    let row = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("files:actions"))
        .unwrap();
    let pin = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("files:pinned:pin"))
        .unwrap();
    rt.pointer_down(pin.rect[0] + pin.rect[2] + 1.0, row.rect[1] + 15.0);
    rt.pointer_up(pin.rect[0] + pin.rect[2] + 1.0, row.rect[1] + 15.0);
    rt.frame(0.0);
    assert_eq!(
        rt.state.row_clicks, 0,
        "Action group gaps consume the row activation"
    );
    let single = Actions::new(Menu::<App>::new(
        "one",
        "One",
        vec![Rc::new(Item::new("one", "One", |_, _| {}))],
    ));
    assert_eq!(
        natural_width(&single),
        24.0,
        "CSS measurement excludes empty group gaps"
    );
}
#[test]
fn focused_secondary_moves_to_trigger_and_back_while_pin_stays() {
    let mut rt = runtime(220.0);
    focus(&mut rt, "files:inline:open");
    rt.update(|s, tx| {
        s.width = 80.0;
        update(s, tx)
    });
    rt.frame(0.0);
    assert!(
        rt.state.row.compact(),
        "width={} rows={:?}",
        rt.state.width,
        rt.elements()
            .iter()
            .filter(|e| e.key.as_deref() == Some("row"))
            .map(|e| e.rect)
            .collect::<Vec<_>>()
    );
    assert_eq!(focused(&rt).as_deref(), Some("files:trigger"));
    rt.update(|s, tx| {
        s.width = 220.0;
        update(s, tx)
    });
    rt.frame(0.0);
    assert!(
        !rt.state.row.compact(),
        "width={},required={}",
        rt.state.width,
        30.0 + natural_width(&rt.state.actions)
    );
    assert_eq!(focused(&rt).as_deref(), Some("files:inline:open"));
    focus(&mut rt, "files:pinned:pin");
    rt.update(|s, tx| {
        s.width = 80.0;
        update(s, tx)
    });
    rt.frame(0.0);
    assert_eq!(focused(&rt).as_deref(), Some("files:pinned:pin"));
}
#[test]
fn compact_secondaries_keep_geometry_but_are_inert_and_hidden_from_accessibility() {
    let mut rt = runtime(80.0);
    assert!(
        rt.state.row.compact(),
        "width={}, required={}",
        rt.state.width,
        30.0 + natural_width(&rt.state.actions)
    );
    let hidden = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("files:inline:open"))
        .unwrap();
    assert_eq!(hidden.rect[2], 24.0);
    assert!(hidden.inert);
    assert!(
        !rt.accessibility_json()
            .to_string()
            .contains("\"name\":\"Open\"")
    );
    focus(&mut rt, "files:inline:open");
    assert_ne!(focused(&rt).as_deref(), Some("files:inline:open"));
    focus(&mut rt, "files:pinned:pin");
    rt.key(KeyEvent {
        key: Key::Tab,
        mods: Mods::default(),
    });
    rt.frame(0.0);
    assert_eq!(focused(&rt).as_deref(), Some("files:trigger"));
    assert!(!rt.state.events.contains(&"open"));
}
#[test]
fn menu_remains_open_on_resize_then_focus_returns_to_inline() {
    let mut rt = runtime(80.0);
    tap(&mut rt, "files:trigger");
    assert!(rt.state.menus.is_open("files"));
    focus(&mut rt, "files:item:open");
    rt.update(|s, tx| {
        s.width = 300.0;
        update(s, tx)
    });
    rt.frame(0.0);
    assert!(
        rt.state.row.compact(),
        "width={}, required={}",
        rt.state.width,
        30.0 + natural_width(&rt.state.actions)
    );
    assert!(rt.state.menus.is_open("files"));
    tap(&mut rt, "files:item:open");
    deliver(&mut rt);
    assert_eq!(rt.state.events, ["open"]);
    assert!(!rt.state.menus.is_open("files"));
    assert!(
        !rt.state.row.compact(),
        "width={},required={}",
        rt.state.width,
        30.0 + natural_width(&rt.state.actions)
    );
    assert_eq!(focused(&rt).as_deref(), Some("files:inline:open"));
}
#[test]
fn disabled_action_is_not_focusable_or_invoked_and_threshold_is_source_slop() {
    let mut rt = runtime(220.0);
    tap(&mut rt, "files:inline:disabled");
    assert!(!rt.state.events.contains(&"disabled"));
    assert!(
        rt.elements()
            .iter()
            .find(|e| e.key.as_deref() == Some("files:inline:disabled"))
            .is_some_and(|e| !e.focusable)
    );
    rt.update(|s, tx| {
        s.width = 105.5;
        update(s, tx)
    });
    rt.frame(0.0);
    assert!(
        !rt.state.row.compact(),
        "width={},required={}",
        rt.state.width,
        30.0 + natural_width(&rt.state.actions)
    );
    rt.update(|s, tx| {
        s.width = 105.49;
        update(s, tx)
    });
    rt.frame(0.0);
    assert!(
        rt.state.row.compact(),
        "width={}, required={}",
        rt.state.width,
        30.0 + natural_width(&rt.state.actions)
    );
}

#[test]
fn public_rune_hover_group_distinguishes_pointer_focus_from_keyboard_focus() {
    fn view(_: &(), _: &mut Cx<()>) -> El {
        rune::col().w_full().h_full().child(
            rune::row()
                .size(100.0, 30.0)
                .hover_group()
                .hover_motion(rune::Anim::INSTANT, rune::Anim::INSTANT)
                .child(
                    rune::el()
                        .key("revealed")
                        .size(24.0, 24.0)
                        .group_opacity(0.0, 1.0)
                        .child(
                            rune::el()
                                .key("button")
                                .role("button")
                                .label("Action")
                                .focusable(true)
                                .size(24.0, 24.0),
                        ),
                ),
        )
    }
    let mut rt = Runtime::new((), view, (300.0, 120.0), Env::new(false, 1.0));
    rt.frame(0.0);
    rt.pointer_move(250.0, 100.0);
    for (keyboard, expected) in [(false, 0.0), (true, 1.0)] {
        rt.update(move |_, tx| tx.focus("button", keyboard));
        rt.frame(0.0);
        assert_eq!(
            rt.elements()
                .iter()
                .find(|e| e.key.as_deref() == Some("revealed"))
                .unwrap()
                .opacity,
            expected
        );
    }
}

#[test]
fn explicit_focus_within_and_coarse_pointer_preserve_source_visibility() {
    let mut rt = runtime(220.0);
    rt.pointer_move(390.0, 150.0);
    let opacity = |rt: &Runtime<App>| {
        rt.elements()
            .iter()
            .find(|e| e.key.as_deref() == Some("files:actions"))
            .unwrap()
            .opacity
    };
    rt.update(|s, _| {
        s.coarse = false;
        s.focus_within = false
    });
    rt.frame(1.0);
    assert_eq!(opacity(&rt), 0.0);
    rt.update(|s, _| s.focus_within = true);
    rt.frame(0.0);
    assert_eq!(opacity(&rt), 1.0);
    rt.update(|s, _| {
        s.focus_within = false;
        s.coarse = true
    });
    rt.frame(0.0);
    assert_eq!(opacity(&rt), 1.0);
}

#[test]
fn inline_order_inherits_the_parent_direction() {
    for rtl in [false, true] {
        let mut rt = runtime(220.0);
        rt.update(move |s, _| s.rtl = rtl);
        rt.frame(0.0);
        let pin = rt.find("files:pinned:pin").unwrap().0;
        let open = rt.find("files:inline:open").unwrap().0;
        let disabled = rt.find("files:inline:disabled").unwrap().0;
        assert_eq!(pin < open && open < disabled, !rtl);
        assert_eq!(pin > open && open > disabled, rtl);
    }
}

#[test]
fn hot_buttons_preserve_the_source_transparent_background() {
    let mut rt = runtime(220.0);
    let (x, y) = rt.find("files:inline:open").unwrap();
    rt.pointer_move(x, y);
    deliver(&mut rt);
    focus(&mut rt, "files:inline:open");
    let open = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("files:inline:open"))
        .unwrap();
    assert_eq!(open.fill, rune::Color::TRANSPARENT);
    assert_eq!(open.opacity, 1.0);
}
