//! Public Runtime observations; source parity is assessed from the phase receipts.
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime, TextEdit};
use rune_theme_codenomad::layout;
use serde_json::{Value, json};

#[derive(Default)]
struct State {
    web: bool,
    disabled: bool,
    consume_down: bool,
    consume_up: bool,
    default: bool,
    modal: bool,
    before: TextEdit,
    after: TextEdit,
    presses: usize,
    defaults: usize,
    submits: usize,
    modal_presses: usize,
    receipts: Vec<Value>,
}

fn view(s: &State, cx: &mut Cx<State>) -> El {
    if s.web {
        layout::render(cx, |_| body(s))
    } else {
        layout::with_appearance(cx.system_dark(), || body(s))
    }
}
fn body(s: &State) -> El {
    let mut action = rune_kit::Button::new("Action")
        .disabled(s.disabled)
        .on_press_tx(|s: &mut State, tx| {
            s.presses += 1;
            s.receipts
                .push(json!({"keys":tx.by_keys(),"repeat":tx.key_repeat(),"focused":tx.focused()}));
        })
        .build(&rune_theme_codenomad::kit(layout::dark()))
        .key("action");
    if s.consume_down {
        action = action.on_key(|_: &mut State, _, _| true);
    }
    if s.consume_up {
        action = action.on_key_up(|_: &mut State, _, _| true);
    }
    let mut root = rune::col()
        .key("root")
        .w_full()
        .h_full()
        .child(
            layout::input(&s.before)
                .single_line()
                .key("before")
                .label("Before")
                .on_edit(|s: &mut State| &mut s.before),
        )
        .child(action)
        .child(
            layout::button("Opt out", false, |_: &mut State| {})
                .key("opt-out")
                .focusable(false),
        )
        .child(
            layout::button("Disabled", true, |_: &mut State| panic!("disabled action"))
                .key("disabled"),
        )
        .child(
            layout::input(&s.after)
                .single_line()
                .key("after")
                .label("After")
                .on_edit(|s: &mut State| &mut s.after)
                .on_submit(|s: &mut State, _| s.submits += 1),
        );
    if s.default {
        root = root.child(
            layout::button("Default", false, |s: &mut State| s.defaults += 1)
                .key("default")
                .default_button(),
        );
    }
    if s.modal {
        root = root.child(
            rune::col()
                .key("modal")
                .size(200.0, 150.0)
                .absolute(100.0, 50.0)
                .modal(true, |s: &mut State| s.modal = false)
                .child(
                    layout::button("Modal action", false, |s: &mut State| s.modal_presses += 1)
                        .key("modal-action"),
                ),
        );
    }
    root
}

fn runtime(web: bool) -> Runtime<State> {
    let mut rt = Runtime::new(
        State {
            web,
            ..State::default()
        },
        view,
        (500.0, 400.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt
}
fn focus(rt: &mut Runtime<State>, key: &str) {
    rt.update(|_, tx| tx.focus(key, true));
    rt.frame(0.0);
}
fn focused(rt: &Runtime<State>) -> Option<String> {
    rt.elements()
        .into_iter()
        .find(|e| e.focused)
        .and_then(|e| e.key)
}
fn down(rt: &mut Runtime<State>, key: Key, mods: Mods) {
    rt.key(KeyEvent { key, mods });
    rt.frame(0.0);
}
fn up(rt: &mut Runtime<State>, key: Key, mods: Mods) {
    rt.key_up(KeyEvent { key, mods });
    rt.frame(0.0);
}
fn snap(rt: &Runtime<State>) -> Value {
    json!({"presses":rt.state.presses,"defaults":rt.state.defaults,"submits":rt.state.submits,
        "modal_presses":rt.state.modal_presses,"focused":focused(rt),"receipts":rt.state.receipts})
}
fn emit(web: bool, case: &str, phases: Value) {
    println!(
        "WEB_FOCUS {}",
        json!({"web":web,"case":case,"phases":phases})
    );
}
fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).expect("public element location");
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
}

#[test]
fn public_runtime_observes_native_and_web_focus_without_keyboard_adapter() {
    for web in [false, true] {
        let mut rt = runtime(web);
        focus(&mut rt, "before");
        down(&mut rt, Key::Tab, Mods::default());
        if web {
            assert_eq!(focused(&rt).as_deref(), Some("action"));
        }
        emit(web, "tab-forward", snap(&rt));
        down(&mut rt, Key::Tab, Mods::default());
        if web {
            assert_eq!(focused(&rt).as_deref(), Some("after"));
        }
        assert_ne!(focused(&rt).as_deref(), Some("opt-out"));
        assert_ne!(focused(&rt).as_deref(), Some("disabled"));
        emit(web, "tab-skips-optout-disabled", snap(&rt));
        down(
            &mut rt,
            Key::Tab,
            Mods {
                shift: true,
                ..Mods::default()
            },
        );
        if web {
            assert_eq!(focused(&rt).as_deref(), Some("action"));
        }
        emit(web, "tab-reverse", snap(&rt));
        for (name, key) in [("Enter", Key::Enter), ("Space", Key::Text(" ".into()))] {
            let mut rt = runtime(web);
            focus(&mut rt, "action");
            down(&mut rt, key.clone(), Mods::default());
            let pressed = snap(&rt);
            up(&mut rt, key.clone(), Mods::default());
            if name == "Enter" {
                let expected = usize::from(web);
                assert_eq!(pressed["presses"], expected);
                assert_eq!(
                    rt.state.presses, expected,
                    "Return presses focused Kit button only under web_focus"
                );
            }
            emit(
                web,
                &format!("{name}-down-up"),
                json!({"down":pressed,"up":snap(&rt)}),
            );

            let mut rt = runtime(web);
            focus(&mut rt, "action");
            down(&mut rt, key.clone(), Mods::default());
            for _ in 0..2 {
                rt.repeat_key(KeyEvent {
                    key: key.clone(),
                    mods: Mods::default(),
                });
                rt.frame(0.0);
            }
            let pressed = snap(&rt);
            up(&mut rt, key.clone(), Mods::default());
            emit(
                web,
                &format!("{name}-repeat"),
                json!({"down":pressed,"up":snap(&rt)}),
            );

            let mut rt = runtime(web);
            focus(&mut rt, "action");
            down(&mut rt, key.clone(), Mods::default());
            focus(&mut rt, "after");
            up(&mut rt, key.clone(), Mods::default());
            emit(web, &format!("{name}-blur-before-release"), snap(&rt));

            for (modifier, mods) in [
                (
                    "Shift",
                    Mods {
                        shift: true,
                        ..Mods::default()
                    },
                ),
                (
                    "Control",
                    Mods {
                        ctrl: true,
                        cmd: true,
                        ..Mods::default()
                    },
                ),
                (
                    "Alt",
                    Mods {
                        alt: true,
                        ..Mods::default()
                    },
                ),
                (
                    "Meta",
                    Mods {
                        logo: true,
                        ..Mods::default()
                    },
                ),
            ] {
                let mut rt = runtime(web);
                focus(&mut rt, "action");
                down(&mut rt, key.clone(), mods);
                up(&mut rt, key.clone(), mods);
                emit(web, &format!("{modifier}+{name}"), snap(&rt));
            }

            let mut rt = runtime(web);
            rt.update(|s, _| s.consume_down = true);
            rt.frame(0.0);
            focus(&mut rt, "action");
            down(&mut rt, key.clone(), Mods::default());
            up(&mut rt, key.clone(), Mods::default());
            assert_eq!(
                rt.state.presses, 0,
                "element key handler consumes before activation"
            );
            emit(web, &format!("{name}-consumed-down"), snap(&rt));

            let mut rt = runtime(web);
            focus(&mut rt, "action");
            rt.update(|s, _| s.disabled = true);
            rt.frame(0.0);
            down(&mut rt, key.clone(), Mods::default());
            up(&mut rt, key.clone(), Mods::default());
            assert_eq!(rt.state.presses, 0);
            emit(web, &format!("{name}-disabled"), snap(&rt));

            let mut rt = runtime(web);
            focus(&mut rt, "after");
            down(&mut rt, key.clone(), Mods::default());
            up(&mut rt, key.clone(), Mods::default());
            assert_eq!(rt.state.presses, 0);
            emit(web, &format!("{name}-field-focused"), snap(&rt));
        }

        let mut rt = runtime(web);
        rt.update(|s, _| s.consume_up = true);
        rt.frame(0.0);
        focus(&mut rt, "action");
        down(&mut rt, Key::Text(" ".into()), Mods::default());
        up(&mut rt, Key::Text(" ".into()), Mods::default());
        emit(web, "Space-consumed-up", snap(&rt));

        let mut rt = runtime(web);
        focus(&mut rt, "action");
        down(&mut rt, Key::Text(" ".into()), Mods::default());
        rt.update(|s, _| s.disabled = true);
        rt.frame(0.0);
        up(&mut rt, Key::Text(" ".into()), Mods::default());
        emit(web, "Space-disable-before-release", snap(&rt));

        let mut rt = runtime(web);
        click(&mut rt, "action");
        assert_eq!(rt.state.presses, 1);
        emit(web, "pointer-focus", snap(&rt));
        down(&mut rt, Key::Tab, Mods::default());
        emit(web, "pointer-then-tab", snap(&rt));

        for target in ["action", "before", "after", "none"] {
            let mut rt = runtime(web);
            rt.update(|s, _| s.default = true);
            rt.frame(0.0);
            if target != "none" {
                focus(&mut rt, target);
            }
            down(&mut rt, Key::Enter, Mods::default());
            assert_eq!(rt.state.presses, usize::from(web && target == "action"));
            assert_eq!(
                rt.state.defaults,
                usize::from((!web || target != "action") && target != "after")
            );
            assert_eq!(rt.state.submits, usize::from(target == "after"));
            emit(web, &format!("Enter-default-focus-{target}"), snap(&rt));
        }

        let mut rt = runtime(web);
        rt.update(|s, _| s.default = true);
        rt.frame(0.0);
        down(&mut rt, Key::Enter, Mods::default());
        for _ in 0..2 {
            rt.repeat_key(KeyEvent {
                key: Key::Enter,
                mods: Mods::default(),
            });
            rt.frame(0.0);
        }
        up(&mut rt, Key::Enter, Mods::default());
        emit(web, "Enter-default-repeat", snap(&rt));

        let mut rt = runtime(web);
        focus(&mut rt, "action");
        rt.update(|s, _| s.modal = true);
        rt.frame(0.0);
        emit(web, "modal-open", snap(&rt));
        down(&mut rt, Key::Enter, Mods::default());
        emit(web, "modal-enter-at-rest", snap(&rt));
        down(&mut rt, Key::Tab, Mods::default());
        emit(web, "modal-tab", snap(&rt));
        click(&mut rt, "action");
        assert_eq!(
            rt.state.presses, 0,
            "background action stays outside modal scope"
        );
        emit(web, "modal-background-pointer", snap(&rt));
    }
}
