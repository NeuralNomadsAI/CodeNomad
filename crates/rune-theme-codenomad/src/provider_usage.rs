use crate::{
    Space, TextRole, kit,
    layout::{self, Layout},
    tokens,
};
use rune::{El, col, text};

pub fn card(contents: impl IntoIterator<Item = El>) -> El {
    col()
        .full_width()
        .inset_surface()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .children(contents)
}

pub fn external_link(label: &str, url: &'static str) -> El {
    let t = tokens(layout::dark());
    let ink = t.color("accent-primary");
    rune::rich(label, vec![rune::Span::new(0, label.len()).underline(ink)])
        .color(ink)
        .text_role(TextRole::Small)
        .wrap()
        .href(url)
        .focusable(true)
}

pub fn reading(
    label: &str,
    value: String,
    reset: Option<String>,
    meter: Option<(String, f64)>,
) -> El {
    let dark = layout::dark();
    let mut row = col().full_width().separate(Space::Xs).child(
        layout::action_row()
            .justify_between()
            .child(text(label).wrap().text_role(TextRole::Small))
            .child(
                rune::row()
                    .flex_wrap()
                    .separate(Space::Xs)
                    .child(text(value).wrap_anywhere().text_role(TextRole::Small))
                    .children(reset.map(|value| {
                        text(value)
                            .wrap()
                            .text_role(TextRole::Small)
                            .color(tokens(dark).color("text-tertiary"))
                    })),
            ),
    );
    if let Some((name, percent)) = meter {
        let mut theme = kit(dark).clone();
        theme.c.border_active = tokens(dark).color(if percent >= 80.0 {
            "status-error"
        } else if percent >= 50.0 {
            "status-warning"
        } else {
            "status-success"
        });
        row = row.child(
            rune_kit::Progress::new(Some((percent.clamp(0.0, 100.0) / 100.0) as f32))
                .build(&theme)
                .label(name),
        );
    }
    row
}

#[cfg(test)]
#[test]
fn quota_help_uses_an_actual_web_link() {
    fn view(_: &(), _: &mut rune::Cx<()>) -> El {
        card([external_link("Usage", "https://chatgpt.com/settings/usage")])
    }
    let mut runtime = rune::Runtime::new((), view, (320.0, 150.0), rune::Env::new(false, 1.0));
    runtime.frame(0.0);
    let items: Vec<serde_json::Value> = serde_json::from_str(&runtime.a11y_json()).unwrap();
    assert!(
        items
            .iter()
            .any(|item| item["k"] == "link" && item["h"] == "https://chatgpt.com/settings/usage")
    );
}
