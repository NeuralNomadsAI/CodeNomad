use super::*;
use rune::{Cx, Env, Key, KeyEvent, Mods, Runtime};
use rune_kit::{Button, ButtonVariant};

#[derive(Default)]
struct App {
    menu: State<App>,
    events: Vec<String>,
    replacement: bool,
    owner_removed: bool,
    gesture: bool,
    focus_target: bool,
    inline_target: bool,
    many: bool,
    all_disabled: bool,
    hidden: bool,
    dialog: bool,
}
fn at(s: &mut App) -> Option<&mut State<App>> {
    Some(&mut s.menu)
}
fn descriptor(s: &App) -> Rc<Menu<App>> {
    let mut item = Item::new("open", "Open", |s: &mut App, tx| {
        s.events.push(format!("select:{:?}", tx.focused()));
        s.dialog = !s.inline_target;
    });
    item.description = Some("Details".into());
    item.disabled = s.all_disabled;
    item.checked = Some(true);
    item.select_before_close = s.gesture;
    if s.focus_target {
        item.focus_after_select = Some(Rc::new(|_| Some("accept".into())));
    }
    item.on_mouse_enter = Some(Rc::new(|s, _| s.events.push("enter".into())));
    item.on_mouse_leave = Some(Rc::new(|s, _| s.events.push("leave".into())));
    if s.replacement {
        item.on_select = Rc::new(|s, _| s.events.push("replacement".into()));
    }
    let mut disabled = Item::new("disabled", "Disabled", |s: &mut App, _| {
        s.events.push("disabled".into())
    });
    disabled.disabled = true;
    disabled.description = Some("Unavailable while busy".into());
    let mut items = vec![Rc::new(item), Rc::new(disabled)];
    if s.many {
        items.push(Rc::new(Item::new("last", "Last", |_, _| {})));
    }
    if s.hidden {
        items.clear();
    }
    let mut menu = Menu::new("actions", "Actions", items);
    menu.on_open_change = Some(Rc::new(|s, open, _| s.events.push(format!("open:{open}"))));
    menu.on_focus_restored = Some(Rc::new(|s, tx| {
        s.events.push(format!("restored:{:?}", tx.focused()))
    }));
    Rc::new(menu)
}
fn view_app(s: &App, cx: &mut Cx<App>) -> El {
    layout::render(cx, |_| {
        if s.owner_removed {
            return rune::el();
        }
        let trigger = Button::new("Actions")
            .variant(ButtonVariant::Ghost)
            .build(&kit(layout::dark()));
        let (trigger, surface) = view(&s.menu, at, descriptor(s), trigger, 500.0);
        let mut layers: Vec<_> = surface.into_iter().collect();
        if s.dialog {
            layers.push(
                rune::col()
                    .key("dialog")
                    .absolute(150.0, 150.0)
                    .role("dialog")
                    .modal(true, |s: &mut App| s.dialog = false)
                    .child(
                        Button::new("Cancel")
                            .on_press(|s: &mut App| s.dialog = false)
                            .build(&kit(layout::dark()))
                            .key("cancel")
                            .autofocus(),
                    )
                    .child(
                        Button::new("Accept")
                            .build(&kit(layout::dark()))
                            .key("accept"),
                    ),
            );
        }
        rune_kit::root(
            rune::col()
                .w_full()
                .h_full()
                .child(trigger)
                .children(s.inline_target.then(|| {
                    Button::new("Accept")
                        .build(&kit(layout::dark()))
                        .key("accept")
                })),
            layers,
        )
    })
}
fn runtime() -> Runtime<App> {
    let mut rt = Runtime::new(
        App::default(),
        view_app,
        (500.0, 400.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt
}
fn tap(rt: &mut Runtime<App>, key: &str) {
    let (x, y) = rt.find(key).expect(key);
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
}
fn key(rt: &mut Runtime<App>, key: Key) {
    rt.key(KeyEvent {
        key,
        mods: Mods::default(),
    });
    rt.frame(0.0);
}
fn deliver(rt: &mut Runtime<App>) {
    rt.update(|s, tx| {
        poll(s, at, tx);
    });
    rt.frame(0.0);
}
fn focused(rt: &Runtime<App>) -> Option<String> {
    rt.elements()
        .into_iter()
        .find(|e| e.focused)
        .and_then(|e| e.key)
}
#[test]
fn pointer_opened_container_admits_the_first_keyboard_arrow() {
    let mut rt = runtime();
    tap(&mut rt, "actions:trigger");
    let container = rt
        .elements()
        .into_iter()
        .find(|node| node.key.as_deref() == Some("actions:menu"))
        .unwrap();
    println!(
        "MENU_FOCUS opened focused={:?} focusable={}",
        focused(&rt),
        container.focusable
    );
    assert_eq!(focused(&rt).as_deref(), Some("actions:menu"));
    assert!(container.focusable);
    key(&mut rt, Key::Down);
    println!("MENU_FOCUS down focused={:?}", focused(&rt));
    assert_eq!(focused(&rt).as_deref(), Some("actions:item:open"));
    key(&mut rt, Key::Enter);
    assert!(!rt.state.menu.is_open("actions"));
    deliver(&mut rt);
    assert!(
        rt.state
            .events
            .iter()
            .any(|event| event.starts_with("select:"))
    );
}
#[test]
fn pointer_container_admits_home_end_and_typeahead() {
    for (entry, target) in [
        (Key::Home, "open"),
        (Key::End, "last"),
        (Key::PageUp, "open"),
        (Key::PageDown, "last"),
        (Key::Text("l".into()), "last"),
    ] {
        let mut rt = runtime();
        rt.state.many = true;
        tap(&mut rt, "actions:trigger");
        assert_eq!(focused(&rt).as_deref(), Some("actions:menu"));
        key(&mut rt, entry);
        assert_eq!(focused(&rt), Some(format!("actions:item:{target}")));
        // Container tab_index(-1) keeps it out of Tab cycling inside the open menu.
        key(&mut rt, Key::Tab);
        assert_eq!(focused(&rt), Some(format!("actions:item:{target}")));
    }
    // Tab directly from the pointer-focused container enters the first item, not the container.
    let mut rt = runtime();
    rt.state.many = true;
    tap(&mut rt, "actions:trigger");
    assert_eq!(focused(&rt).as_deref(), Some("actions:menu"));
    key(&mut rt, Key::Tab);
    assert_eq!(focused(&rt).as_deref(), Some("actions:item:open"));
}
#[test]
fn selection_runs_after_actual_focus_return_and_captures_original_descriptor() {
    let mut rt = runtime();
    tap(&mut rt, "actions:trigger");
    key(&mut rt, Key::Down);
    key(&mut rt, Key::Enter);
    assert!(!rt.state.menu.is_open("actions"));
    assert_eq!(focused(&rt).as_deref(), Some("actions:trigger"));
    assert!(!rt.state.events.iter().any(|e| e.starts_with("select:")));
    rt.state.replacement = true;
    deliver(&mut rt);
    assert!(
        rt.state
            .events
            .contains(&"select:Some(\"actions:trigger\")".into())
    );
    assert!(!rt.state.events.contains(&"replacement".into()));
    assert_eq!(focused(&rt).as_deref(), Some("cancel"));
    deliver(&mut rt);
    let select = rt
        .state
        .events
        .iter()
        .position(|e| e.starts_with("select:"))
        .unwrap();
    let restored = rt
        .state
        .events
        .iter()
        .position(|e| e.starts_with("restored:"))
        .unwrap();
    assert!(select < restored);
    assert!(
        rt.state
            .events
            .contains(&"restored:Some(\"cancel\")".into())
    );
    // Advance past frame 0 of the dialog's entrance fade so its Cancel button is hittable.
    rt.frame(0.016);
    tap(&mut rt, "cancel");
    assert_eq!(focused(&rt).as_deref(), Some("actions:trigger"));
}
#[test]
fn immediate_action_keeps_gesture_and_precedes_close() {
    let mut rt = runtime();
    rt.state.gesture = true;
    tap(&mut rt, "actions:trigger");
    key(&mut rt, Key::Down);
    key(&mut rt, Key::Enter);
    let select = rt
        .state
        .events
        .iter()
        .position(|e| e.starts_with("select:"))
        .unwrap();
    let close = rt
        .state
        .events
        .iter()
        .position(|e| e == "open:false")
        .unwrap();
    assert!(select < close);
    assert_eq!(focused(&rt).as_deref(), Some("cancel"));
    deliver(&mut rt);
    assert!(rt.state.events.iter().any(|e| e.starts_with("restored:")));
}
#[test]
fn gesture_target_preserves_dialog_focus_but_moves_returned_trigger_focus() {
    for inline in [false, true] {
        let mut rt = runtime();
        rt.state.gesture = true;
        rt.state.focus_target = true;
        rt.state.inline_target = inline;
        tap(&mut rt, "actions:trigger");
        key(&mut rt, Key::Down);
        key(&mut rt, Key::Enter);
        deliver(&mut rt);
        deliver(&mut rt);
        let target = if inline { "accept" } else { "cancel" };
        assert_eq!(focused(&rt).as_deref(), Some(target));
        assert!(
            rt.state
                .events
                .contains(&format!("restored:Some({target:?})"))
        );
    }
}
#[test]
fn trigger_arrows_open_at_edges_and_keep_menu_navigation() {
    let mut rt = runtime();
    rt.state.many = true;
    key(&mut rt, Key::Tab);
    key(&mut rt, Key::Up);
    assert_eq!(focused(&rt).as_deref(), Some("actions:item:last"));
    key(&mut rt, Key::Home);
    assert_eq!(focused(&rt).as_deref(), Some("actions:item:open"));
    key(&mut rt, Key::Text("l".into()));
    assert_eq!(focused(&rt).as_deref(), Some("actions:item:last"));
    key(&mut rt, Key::Escape);
    deliver(&mut rt);
    key(&mut rt, Key::Down);
    assert_eq!(focused(&rt).as_deref(), Some("actions:item:open"));
    key(&mut rt, Key::Escape);
    deliver(&mut rt);
    key(&mut rt, Key::Enter);
    assert_eq!(focused(&rt).as_deref(), Some("actions:item:open"));
    key(&mut rt, Key::Escape);
    deliver(&mut rt);
    key(&mut rt, Key::Text(" ".into()));
    assert!(rt.state.menu.is_open("actions"));
    assert_eq!(focused(&rt).as_deref(), Some("actions:item:open"));
    assert_eq!(
        rt.state.events.iter().filter(|e| *e == "open:true").count(),
        4
    );
}
#[test]
fn dropping_below_minimum_releases_hover_and_restores_closed() {
    let mut rt = runtime();
    tap(&mut rt, "actions:trigger");
    let (x, y) = rt.find("actions:item:open").unwrap();
    rt.pointer_move(x, y);
    rt.frame(0.0);
    rt.update(|s, tx| {
        s.hidden = true;
        sync(s, at, &descriptor(s), tx);
    });
    rt.frame(0.0);
    deliver(&mut rt);
    assert!(!rt.state.menu.is_open("actions"));
    assert!(rt.state.events.contains(&"leave".into()));
    assert!(rt.state.events.contains(&"restored:None".into()));
    assert!(!rt.state.events.contains(&"open:false".into()));
    rt.update(|s, tx| {
        s.hidden = false;
        sync(s, at, &descriptor(s), tx);
    });
    rt.frame(0.0);
    assert!(rt.find("actions:trigger").is_some());
    assert!(rt.find("actions:item:open").is_none());
}
#[test]
fn escape_and_outside_dismiss_with_hover_cleanup() {
    let mut rt = runtime();
    tap(&mut rt, "actions:trigger");
    let (x, y) = rt.find("actions:item:open").unwrap();
    rt.pointer_move(x, y);
    rt.frame(0.0);
    assert!(rt.state.events.contains(&"enter".into()));
    key(&mut rt, Key::Escape);
    deliver(&mut rt);
    assert!(!rt.state.menu.is_open("actions"));
    let leave = rt.state.events.iter().position(|e| e == "leave").unwrap();
    let close = rt
        .state
        .events
        .iter()
        .position(|e| e == "open:false")
        .unwrap();
    assert!(leave < close);
    tap(&mut rt, "actions:trigger");
    rt.pointer_down(450.0, 350.0);
    rt.pointer_up(450.0, 350.0);
    rt.frame(0.0);
    assert!(!rt.state.menu.is_open("actions"));
}
#[test]
fn disabled_checked_and_description_match_accessible_contract() {
    let mut rt = runtime();
    tap(&mut rt, "actions:trigger");
    let mirror: Vec<serde_json::Value> = serde_json::from_str(&rt.a11y_json()).unwrap();
    assert!(
        mirror.iter().any(|e| e["o"] == "menuitemcheckbox"
            && e["t"] == "Open"
            && e["c"] == "true"
            && e["d"] == "Details"),
        "{}",
        rt.a11y_json()
    );
    let elements = rt.elements();
    assert!(
        elements
            .iter()
            .find(|e| e.key.as_deref() == Some("actions:item:disabled"))
            .unwrap()
            .focusable
    );
    assert!(
        !elements
            .iter()
            .any(|e| e.text.as_deref() == Some("Details"))
    );
    tap(&mut rt, "actions:item:disabled");
    deliver(&mut rt);
    assert!(rt.state.menu.is_open("actions"));
    assert!(!rt.state.events.contains(&"disabled".into()));
}
#[test]
fn all_disabled_actions_remain_reachable_and_inert() {
    let mut rt = runtime();
    rt.update(|s, _| s.all_disabled = true);
    key(&mut rt, Key::Tab);
    key(&mut rt, Key::Enter);
    assert_eq!(focused(&rt).as_deref(), Some("actions:item:open"));
    key(&mut rt, Key::Down);
    assert_eq!(focused(&rt).as_deref(), Some("actions:item:disabled"));
    assert!(
        rt.elements()
            .iter()
            .any(|e| e.focused && e.help.as_deref() == Some("Unavailable while busy"))
    );
    let mirror: serde_json::Value = serde_json::from_str(&rt.a11y_json()).unwrap();
    assert!(
        mirror
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["t"] == "Disabled" && e["d"] == "Unavailable while busy"),
        "{mirror}"
    );
    assert!(
        rt.accessibility_tree()
            .nodes
            .iter()
            .any(|(_, node)| node.label() == Some("Disabled") && node.is_disabled())
    );
    key(&mut rt, Key::Enter);
    key(&mut rt, Key::Text(" ".into()));
    deliver(&mut rt);
    assert!(rt.state.menu.is_open("actions"));
    assert_eq!(rt.state.events, ["open:true"]);
    key(&mut rt, Key::Escape);
    assert_eq!(focused(&rt).as_deref(), Some("actions:trigger"));
}
#[test]
fn removing_visible_owner_preserves_the_admitted_selection() {
    let mut rt = runtime();
    tap(&mut rt, "actions:trigger");
    key(&mut rt, Key::Down);
    key(&mut rt, Key::Enter);
    rt.update(|s, tx| {
        clear(s, at, "actions", tx);
        s.owner_removed = true;
    });
    rt.frame(0.0);
    deliver(&mut rt);
    deliver(&mut rt);
    assert!(rt.state.events.iter().any(|e| e.starts_with("select:")));
    assert!(rt.state.events.iter().any(|e| e.starts_with("restored:")));
}
