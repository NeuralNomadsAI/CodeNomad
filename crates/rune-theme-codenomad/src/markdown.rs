use crate::{Space, TextRole, kit, layout::dark, tokens};
use pulldown_cmark::{Event, Options, Parser};
use rune::{El, ScrollSpec, rich};
use rune_kit::{CodeFrame, Markdown, MarkdownStyle, syntax};
use std::borrow::Cow;

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
    Markdown::new(literal_breaks(source).into_owned())
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

// Normalize only parsed HTML and soft breaks so fences, inline code and link URLs stay intact.
fn literal_breaks(source: &str) -> Cow<'_, str> {
    if !source.contains(['<', '\n']) {
        return Cow::Borrowed(source);
    }
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    let mut last = 0;
    let mut result = String::new();
    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        match event {
            Event::SoftBreak => {
                result.push_str(&source[last..range.start]);
                result.push_str("  \n");
            }
            Event::Html(raw) | Event::InlineHtml(raw) => {
                result.push_str(&source[last..range.start]);
                for c in raw.chars() {
                    match c {
                        '\n' => result.push_str("  \n"),
                        '\r' => {}
                        c if c.is_ascii_punctuation() => {
                            use std::fmt::Write;
                            let _ = write!(result, "&#{};", c as u32);
                        }
                        c => result.push(c),
                    }
                }
            }
            _ => continue,
        }
        last = range.end;
    }
    if last == 0 {
        return Cow::Borrowed(source);
    }
    result.push_str(&source[last..]);
    Cow::Owned(result)
}

pub fn language_for_path(path: &str) -> &str {
    syntax::lang_for_path(path).unwrap_or("text")
}

pub fn copy_button<S: 'static>(label: &str, copy: impl Fn(&mut S, &mut rune::Tx) + 'static) -> El {
    let kit = kit(dark());
    rune_kit::IconButton::new(kit.glyph.copy)
        .label(label)
        .help(label)
        .on_press_tx(copy)
        .build(kit)
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
    let dark = dark();
    let spans = if highlight {
        syntax::SyntaxTheme::from_kit(kit(dark))
            .spans(&syntax::highlight(Some(language), source), 0)
    } else {
        Vec::new()
    };
    code_body(rich(source, spans), wrap)
}

pub(crate) fn code_body(body: El, wrap: bool) -> El {
    use crate::layout::Layout;
    let body = body
        .font(tokens(dark()).text(TextRole::Mono))
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
