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

pub fn reading(label: &str, value: String, meter: Option<(String, f64)>) -> El {
    let dark = layout::dark();
    let mut row = col().full_width().separate(Space::Xs).child(
        layout::action_row()
            .justify_between()
            .child(text(label).wrap().text_role(TextRole::Small))
            .child(text(value).wrap_anywhere().text_role(TextRole::Small)),
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
