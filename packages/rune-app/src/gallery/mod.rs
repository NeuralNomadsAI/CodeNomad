//! Isolated scenes: no backend, host, file system or user configuration.
use crate::window_control::{WindowCloseState, close_button};
use rune::{Cx, El};
use rune_theme_codenomad::layout::Layout;
#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub mod action_menu;
#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub mod reader;
#[cfg(any(test, all(feature = "test-support", not(target_arch = "wasm32"))))]
pub mod shell;

#[derive(Default)]
pub struct Gallery {
    close: WindowCloseState,
    pub presses: usize,
}
pub fn view(s: &Gallery, cx: &mut Cx<Gallery>) -> El {
    rune_theme_codenomad::layout::render(cx, |cx| {
        rune_theme_codenomad::window_control::gallery_surface(
            cx.system_dark(),
            close_button(
                &s.close,
                "window-close",
                cx.system_dark(),
                None,
                |s: &mut Gallery| &mut s.close,
                |s, _| s.presses += 1,
            ),
        )
    })
    .locale_direction(crate::strings::locale())
}
pub fn run() {
    rune::run(rune_theme_codenomad::layout::app_spec(
        crate::strings::t("window.title.main"),
        Gallery::default,
        view,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Key, KeyEvent, Mods, Runtime};
    fn button(node: &serde_json::Value) -> Option<&serde_json::Value> {
        if node["key"] == "window-close" {
            return Some(node);
        }
        node["children"].as_array()?.iter().find_map(button)
    }
    #[test]
    fn close_pointer_and_keyboard_use_the_real_runtime() {
        for dark in [false, true] {
            let mut rt = Runtime::new(
                Gallery::default(),
                view,
                (100.0, 100.0),
                Env::new(dark, 1.0),
            );
            rt.frame(0.0);
            let tree = rt.accessibility_json();
            let accessible = button(&tree).expect("actual close button node");
            assert_eq!(accessible["role"], "button");
            assert_eq!(accessible["name"], crate::strings::t("toastHistory.close"));
            let (x, y) = rt.find("window-close").unwrap();
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            rt.frame(0.02);
            assert_eq!(rt.state.presses, 1);
            rt.key(KeyEvent {
                key: Key::Tab,
                mods: Mods::default(),
            });
            rt.frame(0.02);
            assert!(
                button(&rt.accessibility_json()).unwrap()["states"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v == "focused")
            );
            for key in [Key::Enter, Key::Text(" ".into())] {
                rt.key(KeyEvent {
                    key: key.clone(),
                    mods: Mods::default(),
                });
                rt.frame(0.02);
                rt.key_up(KeyEvent {
                    key,
                    mods: Mods::default(),
                });
                rt.frame(0.02);
            }
            assert_eq!(rt.state.presses, 3);
        }
    }
}
