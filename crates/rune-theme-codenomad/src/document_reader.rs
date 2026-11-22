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
pub fn split(main: El, tree: Option<El>) -> El {
    let main = main.grow(1.0).min_w(0.0);
    let Some(tree) = tree else {
        return main;
    };
    let width = crate::document()["layout"]["rightDrawerWidth"]
        .as_f64()
        .expect("generated reader width") as f32;
    rune::row()
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(main)
        .child(rune::col().w(width).h_full().min_h(0.0).child(tree))
}
pub fn image(image: &rune::Image, label: &str, svg: bool) -> El {
    let Some([width, height]) = image.size() else {
        return rune::el();
    };
    // Rune's intrinsic SVG loader rasterizes at twice the document's dimensions.
    let scale = if svg { 0.5 } else { 1.0 };
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
                .max_w(width as f32 * scale)
                .max_h(height as f32 * scale)
                .role("img")
                .label(label),
        )
}
pub fn header(title: &str, directory: &str, actions: El) -> El {
    actions_row()
        .w_full()
        .pad(Space::Md)
        .child(
            rune::col()
                .grow(1.0)
                .min_w(0.0)
                .child(rune::text(title).truncate().text_role(TextRole::Label))
                .child(rune::text(directory).truncate().text_role(TextRole::Small)),
        )
        .child(actions)
}
pub fn actions_row() -> El {
    rune::row()
        .items_center()
        .gap(tokens(crate::layout::dark()).space(Space::Sm).px())
}
pub fn eye(dark: bool, label: &str, disabled: bool) -> El {
    rune_kit::IconButton::new(kit(dark).glyph.eye)
        .label(label)
        .disabled(disabled)
        .variant(rune_kit::IconButtonVariant::Ghost)
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
