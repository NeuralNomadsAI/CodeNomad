use crate::{Space, TextRole, kit, layout::Layout, tokens};
use rune::{El, ScrollSpec};
use rune_kit::{Markdown, MarkdownStyle, syntax};

pub fn surface(dark: bool) -> El {
    rune::col()
        .w_full()
        .h_full()
        .min_h(0.0)
        .fill(tokens(dark).color("surface-canvas"))
        .color(tokens(dark).color("text-primary"))
}
pub fn pages(history: El, reader: Option<El>) -> El {
    rune::col()
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(reader.unwrap_or(history))
}
pub use crate::generated_layout::DRAWER_GEOMETRY;
pub fn split(main: El, tree: Option<El>, width: f32, expanded: bool) -> El {
    let minimum = crate::interruption::history_minimum(expanded);
    let main = main.grow(1.0).min_w(0.0).min_h(minimum);
    rune::row()
        .w_full()
        .h_full()
        .min_h(minimum)
        .grow(1.0)
        .child(main)
        .children(tree.map(|tree| rune::col().w(width).h_full().min_h(0.0).child(tree)))
}
pub fn image(image: &rune::Image, label: &str) -> El {
    let Some([width, height]) = image.size() else {
        return rune::el();
    };
    // Intrinsic SVG metadata: https://github.com/anomalyco/rune/issues/1361.
    rune::col()
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .padding(tokens(crate::layout::dark()).space(Space::Lg).px())
        .center()
        .child(
            rune::el()
                .pixels_fit(image.pixels(), rune::SurfaceFit::Fit)
                .aspect_fit(width as f32 / height as f32)
                .max_w(width as f32)
                .max_h(height as f32)
                .role("img")
                .label(label),
        )
}
pub fn header(title: &str, directory: &str, actions: Vec<El>) -> El {
    rune::row()
        .items_center()
        .gap(tokens(crate::layout::dark()).space(Space::Sm).px())
        .w_full()
        .flex_wrap()
        .pad(Space::Sm)
        .child(
            rune::col()
                .grow(1.0)
                .min_w(0.0)
                .child(rune::text(title).truncate().text_role(TextRole::Label))
                .child(rune::text(directory).truncate().text_role(TextRole::Small)),
        )
        .children(actions)
}
pub fn eye<S: 'static>(
    dark: bool,
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S) + 'static,
) -> El {
    rune_kit::IconButton::new(kit(dark).glyph.eye)
        .label(label)
        .disabled(disabled)
        .variant(rune_kit::IconButtonVariant::Ghost)
        .on_press(press)
        .build(kit(dark))
}
pub fn viewport(content: El, wrap: bool) -> El {
    let view = rune::col().w_full().grow(1.0).min_h(0.0);
    if wrap {
        view.scroll(ScrollSpec {
            stick_bottom: false,
        })
    } else {
        view.scroll_xy()
    }
    .child(content)
}
pub fn source(dark: bool, path: &str, text: &str, wrap: bool) -> El {
    let k = kit(dark);
    let spans = syntax::SyntaxTheme::from_kit(k)
        .spans(&syntax::highlight(syntax::lang_for_path(path), text), 0);
    let source = rune::rich(text, spans)
        .key("file-source-text")
        .selectable(true)
        .literal_direction()
        .text_role(TextRole::Mono);
    if wrap { source.w_full().wrap() } else { source }
}
pub fn markdown(dark: bool, text: &str, diagram_label: &'static str) -> El {
    Markdown::new(text)
        .tasks_read_only()
        .selectable(true)
        .scroll_wide(true)
        .diagram_frame(move |diagram, _| diagram.label(diagram_label))
        .build(kit(dark))
}
pub fn mermaid(dark: bool, text: &str) -> Option<El> {
    rune_kit::mermaid::render(text, &MarkdownStyle::from_kit(kit(dark)))
}
