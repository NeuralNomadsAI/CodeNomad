pub(crate) mod diff;
pub(crate) mod window_close_button;

use crate::State;
use rune::{El, Tx};
use rune_theme_codenomad::layout;

pub(crate) fn button(
    key: &str,
    label: &str,
    disabled: bool,
    press: impl Fn(&mut State) + 'static,
) -> El {
    layout::button(label, disabled, press).key(key.to_string())
}
pub(crate) fn button_tx(
    key: &str,
    label: &str,
    disabled: bool,
    press: impl Fn(&mut State, &mut Tx) + 'static,
) -> El {
    layout::button_tx(label, disabled, press).key(key.to_string())
}
