use crate::{
    Space, TextRole,
    git_panel::{REFRESH_CW, icon_button},
    layout::{self, Layout},
    tokens,
};
use rune::{El, col, el, row, text};

pub fn caption(value: impl Into<String>) -> El {
    text(value.into()).wrap().text_role(TextRole::Small)
}

pub fn heading(value: &str) -> El {
    text(value)
        .wrap()
        .text_role(TextRole::Heading)
        .role("heading")
}

pub fn refresh<S: 'static>(
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    icon_button(&REFRESH_CW, label, disabled, None, press).key("stats-refresh")
}

pub fn metrics(items: impl IntoIterator<Item = El>) -> El {
    row()
        .full_width()
        .flex_wrap()
        .separate(Space::Sm)
        .children(items)
}

pub fn metric(label: &str, value: String, info: Option<El>, detail: Option<El>) -> El {
    let t = tokens(layout::dark());
    col()
        .min_w(t.space(Space::Xl).px() * 3.0)
        .px(t.space(Space::Sm).px())
        .py(t.space(Space::Xs).px())
        .border(1.0, t.color("border-base"))
        .fill(t.color("surface-inset"))
        .child(
            row()
                .center_y()
                .separate(Space::Xs)
                .child(caption(label))
                .children(info),
        )
        .child(text(value).text_role(TextRole::Title))
        .children(detail)
}

pub fn model_row(cells: [String; 5], header: bool) -> El {
    row()
        .role("row")
        .full_width()
        .separate(Space::Xs)
        .children(cells.into_iter().enumerate().map(|(i, value)| {
            let role = if header {
                "columnheader"
            } else if i == 0 {
                "rowheader"
            } else {
                "cell"
            };
            col()
                .role(role)
                .label(value.clone())
                .grow(if i == 0 { 2.0 } else { 1.0 })
                .min_w(0.0)
                .child(caption(value).a11y_hidden())
        }))
}

pub fn activity(date: &str, steps: String, fraction: f32, name: String) -> El {
    let t = tokens(layout::dark());
    row()
        .role("group")
        .label(name)
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .child(caption(date).a11y_hidden())
        .child(
            row()
                .remaining()
                .h(t.space(Space::Xs).px())
                .fill(t.color("border-base"))
                .a11y_hidden()
                .child(
                    el().grow(fraction)
                        .full_height()
                        .fill(t.color("accent-primary")),
                )
                .child(el().grow(1.0 - fraction)),
        )
        .child(caption(steps).a11y_hidden())
}
