//! Shared composer and transcript attachment chip.
use crate::{Length, Space, layout, tokens};
use rune::{El, Icon, TextStyle, icon, row, text};

pub fn chip(name: &str, glyph: Option<&'static Icon>, action: Option<El>) -> El {
    let t = tokens(layout::dark());
    let ink = t.color("attachment-chip-text");
    let size = t.number("font-size-xs").px();
    row()
        .center_y()
        .shrink()
        .min_w(0.0)
        .gap(t.space(Space::Xs).px())
        .px(t.space(Space::Sm).px())
        .py(t.space(Space::Xs).px())
        .radius(t.length(Length::ChipRadius).px())
        .fill(t.color("attachment-chip-bg"))
        .border(1.0, t.color("attachment-chip-ring"))
        .children(glyph.map(|glyph| icon(glyph, size).color(ink).a11y_hidden()))
        .child(
            text(name)
                .shrink()
                .min_w(0.0)
                .dir(rune::Direction::Auto)
                .wrap_anywhere()
                .font(TextStyle::new(size, t.number("font-weight-medium").px()))
                .color(ink),
        )
        .children(action)
}
