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

pub fn period(label: &str, picker: El, refresh: El) -> El {
    row()
        .full_width()
        .flex_wrap()
        .items_end()
        .separate(Space::Md)
        .child(
            col()
                .separate(Space::Xs)
                .child(caption(label))
                .child(picker),
        )
        .child(refresh)
}

pub fn metric_columns(width: f32) -> usize {
    let t = tokens(layout::dark());
    let wide = 5.0 * (8.0 * t.space(Space::Lg).px()) + 4.0 * t.space(Space::Sm).px();
    if width >= wide { 5 } else { 2 }
}

pub fn metrics(columns: usize, items: impl IntoIterator<Item = El>) -> El {
    col()
        .key("stats-metrics")
        .full_width()
        .equal_columns(columns)
        .separate(Space::Sm)
        .children(items)
}

pub fn metric(label: &str, value: String, info: Option<El>, detail: Option<El>) -> El {
    let t = tokens(layout::dark());
    col()
        .min_w(0.0)
        .pad(Space::Md)
        .separate(Space::Xs)
        .border(1.0, t.color("border-base"))
        .fill(t.color("surface-inset"))
        .child(
            row()
                .center_y()
                .flex_wrap()
                .separate(Space::Xs)
                .child(caption(label))
                .children(info),
        )
        .child(text(value).wrap().text_role(TextRole::Title))
        .children(detail)
}

pub fn model_row(cells: [String; 5], header: bool) -> El {
    let t = tokens(layout::dark());
    row()
        .role("row")
        .full_width()
        .separate(Space::Xs)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-base"))
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
                .py(t.space(Space::Sm).px())
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
                        .fill(t.color("status-success")),
                )
                .child(el().grow(1.0 - fraction)),
        )
        .child(caption(steps).a11y_hidden())
}

#[cfg(test)]
#[test]
fn metrics_share_tracks_and_reflow_when_the_panel_resizes() {
    fn view(_: &(), cx: &mut rune::Cx<()>) -> El {
        let columns = cx
            .window_layout_with("stats-metrics", |rect| metric_columns(rect[2]))
            .unwrap_or(2);
        metrics(
            columns,
            (0..12).map(|i| {
                metric(
                    if i == 0 {
                        "A much longer metric label"
                    } else {
                        "Metric"
                    },
                    i.to_string(),
                    None,
                    None,
                )
                .key(format!("metric-{i}"))
            }),
        )
    }
    let mut rt = rune::Runtime::new((), view, (1100.0, 900.0), rune::Env::new(false, 1.0));
    for (width, columns) in [(1100.0, 5), (390.0, 2), (1100.0, 5)] {
        rt.set_viewport((width, 900.0), 1.0);
        for _ in 0..3 {
            rt.frame(1.0 / 60.0);
        }
        let elements = rt.elements();
        let card = |i| {
            elements
                .iter()
                .find(|node| node.key.as_deref() == Some(&format!("metric-{i}")))
                .unwrap()
                .rect
        };
        let gap = tokens(false).space(Space::Sm).px();
        let expected = (width - (columns - 1) as f32 * gap) / columns as f32;
        for i in 0..12 {
            let [x, y, w, h] = card(i);
            let first = card(i / columns * columns);
            assert!(
                (w - expected).abs() <= 1.0,
                "{width}: card {i} is {w}, expected {expected}"
            );
            assert!((x - (i % columns) as f32 * (expected + gap)).abs() <= 1.0);
            assert_eq!([y, h], [first[1], first[3]]);
        }
        assert!(card(columns)[1] > card(0)[1]);
    }
}
