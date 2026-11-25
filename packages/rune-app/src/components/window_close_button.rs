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
    scoped_close_button(state, key, dark, label, move |s| Some(lens(s)), on_close)
}

pub fn scoped_close_button<S: 'static>(
    state: &WindowCloseState,
    key: &str,
    dark: bool,
    label: Option<&str>,
    lens: impl Fn(&mut S) -> Option<&mut WindowCloseState> + 'static,
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
        .on_hover_change(move |s: &mut S, hovered, _| {
            if let Some(state) = lens(s) {
                state.hovered = hovered;
            }
        })
        // Preserve HTML's Shift+Enter and held-Enter activation before Rune's focus routing.
        .on_key(move |s: &mut S, event, tx| {
            if event.key != rune::Key::Enter
                || event.mods.cmd
                || event.mods.ctrl
                || event.mods.alt
                || event.mods.logo
            {
                return false;
            }
            on_enter(s, tx);
            true
        })
        .on_press_tx(move |s: &mut S, tx| on_close(s, tx))
}
