//! Passive, bounded Markdown overlay, anchored outside the scrolling rail.
use crate::{
    Space, kit,
    layout::{self, Layout},
    markdown, tokens,
};
use pulldown_cmark::{Event, Options, Parser, TagEnd};
use rune::{Align, El, ScrollSpec, Side};
use rune_kit::{Markdown, MarkdownStyle, popover};
use std::time::Duration;

pub const KEY: &str = "timeline-peek";
pub const OPEN_DELAY: Duration = Duration::from_millis(200);

pub fn marker_hover(button: El) -> El {
    button.hover_delays(OPEN_DELAY, Duration::ZERO)
}

pub fn description(text: &str) -> String {
    let source = markdown::literal_breaks(text);
    rendered_words(&source)
}

fn rendered_words(source: &str) -> String {
    let mut rendered = String::new();
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    for event in Parser::new_ext(source, options) {
        match event {
            Event::Text(text) | Event::Code(text) => rendered.push_str(&text),
            Event::SoftBreak
            | Event::HardBreak
            | Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::Item
                | TagEnd::CodeBlock
                | TagEnd::TableCell
                | TagEnd::TableHead
                | TagEnd::TableRow,
            ) => rendered.push(' '),
            _ => {}
        }
    }
    rendered.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn surface(
    marker: &str,
    text: &str,
    [width, height]: [f32; 2],
    on_scroll: impl Fn(rune::ScrollPos) + 'static,
) -> Option<El> {
    let w = 360.0_f32.min(width - 32.0);
    let h = 420.0_f32.min(height - 32.0);
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let dark = layout::dark();
    let t = tokens(dark);
    let k = &*kit(dark);
    let source = markdown::literal_breaks(text);
    // Rune caps names inferred from descendants; use the full bounded rendered text.
    let label = rendered_words(&source);
    let content = Markdown::new(source)
        .style(MarkdownStyle::from_kit(k).syntax_highlight(false))
        .images(|_| None)
        .tasks_read_only()
        .build(k);
    // Width and maximum height follow timeline-preview.css.
    Some(
        popover::raised(
            k,
            rune::col()
                .key(KEY)
                .role("tooltip")
                .label(label)
                .w(w)
                .max_h(h)
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .on_scroll_offset(on_scroll)
                .pad(Space::Md)
                .child(content),
            0.0,
        )
        .anchored_fit(marker, Side::Left, Align::Center, t.space(Space::Xs).px()),
    )
}
