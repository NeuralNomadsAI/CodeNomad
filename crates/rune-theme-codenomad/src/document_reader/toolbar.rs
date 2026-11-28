use super::*;

// Lucide glyphs, the source of the Files controls.
const WRAP: Icon = Icon {
    name: "lucide-wrap-text",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h15a3 3 0 1 1 0 6h-4m2-2-2 2 2 2M3 18h7"/></g>"#,
};
pub fn wrap_button<S: 'static>(
    dark: bool,
    label: &str,
    active: bool,
    press: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let t = tokens(dark);
    let side = t.length(Length::IconButton).px();
    let outline = t.metric("windowIconFocus", "outlineWidth").px();
    let press = std::rc::Rc::new(press);
    let enter = press.clone();
    rune::row()
        .size(side, side)
        .center()
        .role("button")
        .label(label)
        .help(label)
        .focusable(true)
        .checked(active)
        .fill(t.color(if active {
            "icon-toggle-active-bg"
        } else {
            "surface-canvas"
        }))
        .border(outline, t.color("border-base"))
        .focus_ring(
            outline,
            t.metric("windowIconFocus", "outlineOffset").px(),
            t.color("focus-ring-color"),
        )
        .child(
            rune::icon(&WRAP, t.length(Length::Icon).px())
                .color(t.color(if active {
                    "text-primary"
                } else {
                    "icon-button-color"
                }))
                .a11y_hidden(),
        )
        .hover(if active {
            t.color("icon-toggle-active-bg").alpha(0.15)
        } else {
            t.color("surface-hover")
        })
        .on_key(move |s: &mut S, key, tx| {
            if key.key != rune::Key::Enter || key.mods != rune::Mods::default() {
                return false;
            }
            if !tx.key_repeat() {
                enter(s, tx);
            }
            true
        })
        .on_press_tx(move |s: &mut S, tx| press(s, tx))
}
