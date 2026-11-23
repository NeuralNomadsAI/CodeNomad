//! Passive, bounded Markdown overlay, anchored outside the scrolling rail.
use crate::{
    Space, kit,
    layout::{self, Layout},
    markdown, tokens,
};
use rune::{Align, El, ScrollSpec, Side};
use rune_kit::{Markdown, MarkdownStyle, popover};

pub const KEY: &str = "timeline-peek";

pub fn surface(marker: &str, text: &str) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let k = kit(dark);
    let content = Markdown::new(markdown::literal_breaks(text))
        .style(MarkdownStyle::from_kit(k).syntax_highlight(false))
        .images(|_| None)
        .tasks_read_only()
        .build(k);
    // Width and maximum height follow timeline-preview.css.
    popover::raised(
        k,
        rune::col()
            .key(KEY)
            .role("tooltip")
            .w(360.0)
            .max_h(420.0)
            .min_h(0.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .pad(Space::Md)
            .child(content),
        0.0,
    )
    .anchored_fit(marker, Side::Left, Align::Center, t.space(Space::Xs).px())
}
