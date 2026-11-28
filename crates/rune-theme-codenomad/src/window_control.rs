//! Shared dismissal geometry resolved from the actual Solid window primitive.
use crate::tokens;
use rune::{El, Icon, icon, row};

// Lucide X, the source used by components/window-close-button.tsx.
pub static CLOSE: Icon = Icon {
    name: "lucide-x",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></g>"#,
};

pub fn close_button(dark: bool, hovered: bool) -> El {
    let t = tokens(dark);
    row()
        .w(t.metric("windowIcon", "width").px())
        .h(t.metric("windowIcon", "height").px())
        .radius(t.metric("windowIcon", "borderRadius").px())
        .center()
        .fill(if hovered {
            t.color("surface-interactive-hover")
        } else {
            rune::Color::TRANSPARENT
        })
        .focus_ring(
            t.metric("windowIconFocus", "outlineWidth").px(),
            t.metric("windowIconFocus", "outlineOffset").px(),
            t.color("focus-ring-color"),
        )
        .child(
            icon(&CLOSE, t.metric("windowIconGlyph", "width").px())
                .color(t.color(if hovered {
                    "text-primary"
                } else {
                    "text-muted"
                }))
                .a11y_hidden(),
        )
}

/// An exact component crop: its CSS control dimensions also define the scene.
pub fn gallery_surface(dark: bool, control: El) -> El {
    row()
        .w_full()
        .h_full()
        .fill(tokens(dark).color("surface-overlay"))
        .child(control)
}
