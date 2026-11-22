use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};
use rune_theme_codenomad::layout;

struct State {
    disabled: bool,
    transactional: bool,
    presses: usize,
}
fn view(s: &State, cx: &mut Cx<State>) -> El {
    layout::render(cx, |_| {
        let button = if s.transactional {
            layout::button_tx("Action", s.disabled, |s: &mut State, _| s.presses += 1)
        } else {
            layout::button("Action", s.disabled, |s: &mut State| s.presses += 1)
        }
        .key("action");
        rune::col().child(button)
    })
}
#[test]
fn disabled_actions_ignore_pointer_and_keyboard_while_enabled_actions_run_once() {
    for dark in [false, true] {
        for disabled in [true, false] {
            for transactional in [false, true] {
                for keyboard in [false, true] {
                    let mut rt = Runtime::new(
                        State {
                            disabled,
                            transactional,
                            presses: 0,
                        },
                        view,
                        (320.0, 180.0),
                        Env::new(dark, 1.0),
                    );
                    rt.frame(1.0);
                    let button = rt
                        .elements()
                        .into_iter()
                        .find(|node| node.key.as_deref() == Some("action"))
                        .unwrap();
                    assert_eq!(button.role, "button");
                    assert_eq!(button.label.as_deref(), Some("Action"));
                    assert_eq!(button.focusable, !disabled);
                    if keyboard {
                        rt.key(KeyEvent {
                            key: Key::Tab,
                            mods: Mods::default(),
                        });
                        rt.frame(0.02);
                        let event = KeyEvent {
                            key: Key::Text(" ".into()),
                            mods: Mods::default(),
                        };
                        rt.key(event.clone());
                        rt.frame(0.02);
                        rt.key_up(event);
                        rt.frame(0.02);
                    } else {
                        let (x, y) = rt.find("action").unwrap();
                        rt.pointer_down(x, y);
                        rt.pointer_up(x, y);
                        rt.frame(0.02);
                    }
                    assert_eq!(
                        rt.state.presses,
                        usize::from(!disabled),
                        "dark={dark}, disabled={disabled}, tx={transactional}, keyboard={keyboard}"
                    );
                }
            }
        }
    }
}
