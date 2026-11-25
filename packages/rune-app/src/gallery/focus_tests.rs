use super::*;
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::json;

fn native_view(s: &Gallery, cx: &mut Cx<Gallery>) -> El {
    let dark = cx.system_dark();
    rune_theme_codenomad::layout::with_appearance(dark, || {
        rune_theme_codenomad::window_control::gallery_surface(
            dark,
            close_button(
                &s.close,
                "window-close",
                dark,
                None,
                |s: &mut Gallery| &mut s.close,
                |s, _| s.presses += 1,
            ),
        )
    })
    .locale_direction(crate::strings::locale())
}
fn runtime(web: bool) -> Runtime<Gallery> {
    let render = if web { view } else { native_view };
    let mut rt = Runtime::new(
        Gallery::default(),
        render,
        (100.0, 100.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt.update(|_, tx| tx.focus("window-close", true));
    rt.frame(0.0);
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.key.as_deref() == Some("window-close") && el.focused)
    );
    rt
}
#[test]
fn current_close_glue_observes_web_focus_without_removal() {
    for web in [false, true] {
        for (name, key) in [("Enter", Key::Enter), ("Space", Key::Text(" ".into()))] {
            for (modifier, mods) in [
                ("plain", Mods::default()),
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
                rt.key(KeyEvent {
                    key: key.clone(),
                    mods,
                });
                rt.frame(0.0);
                let down = rt.state.presses;
                rt.key_up(KeyEvent {
                    key: key.clone(),
                    mods,
                });
                rt.frame(0.0);
                if name == "Enter" {
                    assert_eq!(
                        down,
                        usize::from(modifier == "plain" || modifier == "Shift")
                    );
                    assert_eq!(rt.state.presses, down, "release adds no second activation");
                }
                println!(
                    "CLOSE_FOCUS {}",
                    json!({"explicitWeb":web,"key":name,"modifier":modifier,"down":down,"up":rt.state.presses})
                );
            }
            let mut rt = runtime(web);
            rt.key(KeyEvent {
                key: key.clone(),
                mods: Mods::default(),
            });
            rt.frame(0.0);
            for _ in 0..2 {
                rt.repeat_key(KeyEvent {
                    key: key.clone(),
                    mods: Mods::default(),
                });
                rt.frame(0.0);
            }
            rt.key_up(KeyEvent {
                key: key.clone(),
                mods: Mods::default(),
            });
            rt.frame(0.0);
            assert_eq!(rt.state.presses, if name == "Enter" { 3 } else { 1 });
            println!(
                "CLOSE_FOCUS {}",
                json!({"explicitWeb":web,"case":"repeat","key":name,"presses":rt.state.presses})
            );

            let mut rt = runtime(web);
            rt.key(KeyEvent {
                key: key.clone(),
                mods: Mods::default(),
            });
            rt.frame(0.0);
            rt.pointer_down(90.0, 90.0);
            rt.pointer_up(90.0, 90.0);
            rt.frame(0.0);
            assert!(!rt.elements().iter().any(|node| node.focused));
            rt.key_up(KeyEvent {
                key: key.clone(),
                mods: Mods::default(),
            });
            rt.frame(0.0);
            println!(
                "CLOSE_FOCUS {}",
                json!({"explicitWeb":web,"case":"blur-before-release","key":name,"presses":rt.state.presses})
            );
        }
    }
}
