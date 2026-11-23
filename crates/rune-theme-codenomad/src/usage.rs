//! Shared token and cost chips for the transcript and Status.
use crate::{Length, Space, TextRole, layout::{self, Layout}, tokens};
use rune::{El, text};

pub fn metric(label: &str, value: &str, full: &str) -> El {
    let theme = tokens(layout::dark());
    let caption = format!("{label}: {full}");
    text(value)
        .text_role(TextRole::Label)
        .px(theme.space(Space::Sm).px())
        .radius(theme.length(Length::ChipRadius).px())
        .fill(theme.color("surface-inset"))
        .label(caption.clone())
        .help(caption)
}

pub fn metrics(expanded: bool, items: impl IntoIterator<Item = El>) -> El {
    let row = rune::row().w_full().items_center().gap(tokens(layout::dark()).space(Space::Sm).px());
    if expanded { row.flex_wrap() } else { row.clip() }.children(items)
}
