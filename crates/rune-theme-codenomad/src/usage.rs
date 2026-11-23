//! Shared token and cost chips for the transcript and Status.
pub mod numbers;
use crate::{
    Length, Space, TextRole, kit,
    layout::{self, Layout},
    tokens,
};
use rune::{El, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant};

pub fn metric(label: &str, value: &str, full: &str) -> El {
    let theme = tokens(layout::dark());
    let caption = format!("{label}: {full}");
    row()
        .items_center()
        .gap(theme.space(Space::Xs).px())
        .px(theme.space(Space::Sm).px())
        .py(theme.space(Space::Xs).px())
        .radius(theme.length(Length::ChipRadius).px())
        .border(1.0, theme.color("border-base"))
        .label(caption.clone())
        .help(caption)
        .child(text(label).text_role(TextRole::Label))
        .child(text(value).text_role(TextRole::Label))
}

pub fn disclosure<S: 'static>(
    key: &str,
    label: &str,
    heading: Option<&str>,
    expanded: bool,
    items: impl IntoIterator<Item = El>,
    press: impl Fn(&mut S) + 'static,
) -> El {
    let kit = kit(layout::dark());
    let theme = tokens(layout::dark());
    let glyph = if expanded {
        &crate::git_panel::CHEVRON_DOWN
    } else {
        &crate::git_panel::CHEVRON_RIGHT
    };
    let button = if let Some(heading) = heading {
        Button::new(heading)
            .icon(glyph)
            .variant(ButtonVariant::GhostMuted)
            .control_size(ControlSize::Small)
            .expanded(expanded)
            .on_press(press)
            .build(kit)
            .label(label)
    } else {
        IconButton::new(glyph)
            .label(label)
            .variant(IconButtonVariant::GhostMuted)
            .control_size(ControlSize::Small)
            .expanded(expanded)
            .on_press(press)
            .build(kit)
    };
    let chips = row()
        .remaining()
        .min_w(0.0)
        .items_center()
        .gap(theme.space(Space::Xs).px());
    row()
        .full_width()
        .items_center()
        .gap(theme.space(Space::Xs).px())
        .child(button.key(format!("toggle-{key}")))
        .child(
            if expanded {
                chips.flex_wrap()
            } else {
                chips.clip_rounded(0.0)
            }
            .children(items),
        )
        .key(key)
}
