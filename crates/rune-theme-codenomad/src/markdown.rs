use crate::{Space, TextRole, kit, layout::dark, tokens};
use rune::{El, ScrollSpec, rich};
use rune_kit::{CodeFrame, Markdown, MarkdownStyle, syntax};

pub fn prose<S: 'static>(
    source: &str,
    streaming: bool,
    highlight: bool,
    link: impl Fn(&mut S, &str, &mut rune::Tx) + 'static,
    wrapped: impl Fn(usize, &str) -> bool + 'static,
    frame: impl Fn(El, &CodeFrame<'_>) -> El + 'static,
) -> El {
    let kit = kit(dark());
    let style = MarkdownStyle::from_kit(kit)
        .code_block(kit.c.bg_deep, kit.c.border_base)
        .link(kit.c.text_accent)
        .syntax_highlight(highlight);
    Markdown::new(source)
        .style(style)
        .selectable(true)
        .tasks_read_only()
        .scroll_wide(true)
        .streaming(streaming)
        .on_link_tx(link)
        .code_wrap(wrapped)
        .code_frame(frame)
        .build(kit)
}

pub fn knows_language(language: &str) -> bool {
    syntax::known(language)
}

pub fn hold_frame(key: String, stamp: impl std::hash::Hash, build: impl FnOnce() -> El) -> El {
    rune::memo(key, stamp, build)
}

pub fn tool_pane(content: El, large: bool) -> El {
    let metrics = tokens(dark()).text(TextRole::Mono);
    // tool-call.css: --tool-call-line-unit and --tool-call-lines-{compact,large}.
    let max = if large { 30.0 } else { 15.0 } * 1.4 * metrics.size;
    rune::col()
        .w_full()
        .max_h(max)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(content)
}

pub fn code(source: &str, language: &str, highlight: bool, wrap: bool) -> El {
    use crate::layout::Layout;
    let dark = dark();
    let spans = if highlight {
        syntax::SyntaxTheme::from_kit(kit(dark))
            .spans(&syntax::highlight(Some(language), source), 0)
    } else {
        Vec::new()
    };
    let body = rich(source, spans)
        .font(tokens(dark).text(TextRole::Mono))
        .by_line()
        .selectable(true)
        .literal_direction();
    let viewport = if wrap {
        rune::col()
            .full_width()
            .child(body.full_width().wrap_anywhere())
    } else {
        rune::col().full_width().scroll_x().child(body)
    };
    rune::col()
        .full_width()
        .inset_surface()
        .pad(Space::Sm)
        .child(viewport)
}
