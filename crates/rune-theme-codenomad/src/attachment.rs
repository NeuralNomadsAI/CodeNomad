//! Shared composer and transcript attachment chip.
use crate::{
    Length, Space,
    layout::{self, Layout},
    tokens,
};
use rune::{El, Icon, TextStyle, icon, row, text};

pub fn picture(
    image: Option<&rune::Image>,
    label: &str,
    mime: &str,
    error: Option<&str>,
    thumbnail: bool,
) -> El {
    let preview = image.and_then(|image| {
        let view = picture_pixels(image, label)?;
        if thumbnail {
            let edge = tokens(layout::dark()).length(Length::Icon).px();
            Some(view.max_w(edge).max_h(edge))
        } else {
            Some(view)
        }
    });
    rune::col()
        .full_width()
        .separate(Space::Xs)
        .children(preview)
        .children(error.map(|error| text(error).wrap().role("status")))
        .child(
            text(format!("{label} · {mime}"))
                .text_role(crate::TextRole::Label)
                .wrap(),
        )
}

fn picture_pixels(image: &rune::Image, label: &str) -> Option<El> {
    let [width, height] = image.size()?;
    Some(
        rune::el()
            .pixels_fit(image.pixels(), rune::SurfaceFit::Fit)
            .aspect_fit(width as f32 / height as f32)
            .max_w(width as f32)
            .max_h(512.0)
            .role("img")
            .label(label),
    )
}

pub fn decoded_size(image: &rune::Image) -> Option<[u32; 2]> {
    image.size()
}

pub fn picture_hover(image: &rune::Image, label: &str, anchor: &str) -> Option<El> {
    let image = picture_pixels(image, label)?.max_w(320.0).max_h(320.0);
    let dark = layout::dark();
    let theme = tokens(dark);
    let body = rune::col()
        .key("attachment-image-hover")
        .pad(Space::Sm)
        .fill(theme.color("surface-overlay"))
        .child(image)
        .a11y_hidden()
        .inert();
    Some(rune_kit::popover::anchored(
        &crate::kit(dark),
        body,
        anchor,
        rune_kit::Placement::TopStart,
        theme.space(Space::Sm).px(),
    ))
}

pub fn picture_preview<S: 'static>(
    image: &rune::Image,
    label: &str,
    close_label: &str,
    return_focus: &str,
    close: impl Fn(&mut S) + Clone + 'static,
) -> Option<El> {
    let preview = picture_pixels(image, label)?;
    let theme = tokens(layout::dark());
    Some(
        rune::col()
            .key("attachment-preview")
            .absolute(0.0, 0.0)
            .full_width()
            .full_height()
            .center()
            .pad(Space::Md)
            .fill(theme.color("surface-overlay"))
            .role("dialog")
            .label(label)
            .child(
                layout::action_row()
                    .child(text(label).text_role(crate::TextRole::Title))
                    .child(
                        layout::button(close_label, false, close.clone())
                            .key("close-attachment-preview")
                            .autofocus(),
                    ),
            )
            .child(preview)
            .focus_return(return_focus)
            .modal(true, close),
    )
}

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

pub fn status_badge(label: &str) -> El {
    let t = tokens(layout::dark());
    let size = t.number("font-size-xs").px();
    row()
        .center_y()
        .shrink()
        .min_w(0.0)
        .px(t.space(Space::Sm).px())
        .py(t.space(Space::Xs).px())
        .radius(t.length(Length::ChipRadius).px())
        .fill(t.color("badge-neutral-bg"))
        .role("status")
        .child(
            text(label)
                .font(TextStyle::new(size, t.number("font-weight-medium").px()))
                .color(t.color("text-secondary")),
        )
}
