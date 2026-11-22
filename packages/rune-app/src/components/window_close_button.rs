//! CodeNomad shared dismissal control. The theme owns every visual decision.
use rune::{El, Tx};

#[derive(Default)]
pub struct WindowCloseState {
    hovered: bool,
}

pub fn close_button<S: 'static>(
    state: &WindowCloseState,
    key: &str,
    dark: bool,
    label: Option<&str>,
    lens: fn(&mut S) -> &mut WindowCloseState,
    on_close: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let label = label.unwrap_or(crate::strings::t("toastHistory.close"));
    let on_close = std::rc::Rc::new(on_close);
    let on_enter = on_close.clone();
    rune_theme_codenomad::window_control::close_button(dark, state.hovered)
        .key(key)
        .role("button")
        .label(label)
        .description(label)
        .help(label)
        .focusable(true)
        .on_hover_change(move |s: &mut S, hovered, _| lens(s).hovered = hovered)
        // HTML buttons activate on Enter. Rune's native button routing reserves
        // Return for a default action, so this shared control preserves Solid's contract.
        .on_key(move |s: &mut S, event, tx| {
            if event.key != rune::Key::Enter {
                return false;
            }
            on_enter(s, tx);
            true
        })
        .on_press_tx(move |s: &mut S, tx| on_close(s, tx))
}
