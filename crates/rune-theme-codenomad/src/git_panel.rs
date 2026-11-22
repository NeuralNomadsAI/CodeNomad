use crate::{
    Space, TextRole,
    layout::{Layout, dark},
    tokens,
};
use rune::{El, ScrollSpec, Tx, col, icon, row, text};
#[path = "git_panel_controls.rs"]
mod controls;
pub use controls::*;

pub use crate::workspace_tree::icons::{CHEVRON_DOWN, CHEVRON_RIGHT, EYE, REFRESH_CW};
#[path = "git_panel_icons.rs"]
mod icons;
pub use icons::{
    ARROW_LEFT, COLUMNS, FOLD_VERTICAL, GIT_BRANCH as BRANCH, GIT_COMMIT_HORIZONTAL as COMMIT,
    MINUS, PLUS, ROWS, UNFOLD_VERTICAL, WRAP_TEXT,
};

pub fn selector_width(panel: f32) -> f32 {
    panel - 2.0 * tokens(dark()).space(Space::Md).px()
}

pub fn panel() -> El {
    col()
        .full_height()
        .fill(tokens(dark()).color("surface-secondary"))
}

pub fn dock(panel: El, width: f32) -> El {
    panel.w(width).min_w(width).max_w(width)
}

pub fn conversation_column() -> El {
    col().remaining().shrink()
}

pub fn clipped(value: impl Into<String>, role: TextRole) -> El {
    text(value).text_role(role).truncate()
}

pub fn header() -> El {
    col().full_width().pad(Space::Md).separate(Space::Sm)
}

pub fn scroll() -> El {
    col().full_width().remaining().scroll(ScrollSpec {
        stick_bottom: false,
    })
}

pub fn section() -> El {
    col().full_width().items_stretch()
}

pub fn file_row(selected: bool) -> El {
    let body = row().full_width().items_center();
    if selected {
        body.fill(tokens(dark()).color("selection-neutral-bg"))
    } else {
        body
    }
}

pub fn history_row<S: 'static>(
    name: String,
    content: El,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + Clone + 'static,
) -> El {
    let t = tokens(dark());
    let body = row()
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .role("button")
        .label(name)
        .focusable(!disabled)
        .disabled(disabled)
        .child(
            icon(&COMMIT, t.length(crate::Length::Icon).px())
                .color(t.color("text-muted"))
                .a11y_hidden(),
        )
        .child(content.remaining().a11y_hidden());
    if disabled {
        body
    } else {
        let enter = press.clone();
        body.on_press_tx(press)
            .on_key(move |state: &mut S, key, tx| {
                if key.key != rune::Key::Enter {
                    return false;
                }
                enter(state, tx);
                true
            })
    }
}

pub fn branch(name: String) -> El {
    let t = tokens(dark());
    row()
        .remaining()
        .items_center()
        .separate(Space::Sm)
        .child(
            icon(&BRANCH, t.length(crate::Length::Icon).px())
                .color(t.color("text-muted"))
                .a11y_hidden(),
        )
        .child(text(name).text_role(TextRole::Small).truncate())
}

pub fn chrome() -> El {
    row()
        .full_width()
        .items_center()
        .flex_wrap()
        .separate(Space::Xs)
        .pad(Space::Sm)
        .fill(tokens(dark()).color("surface-secondary"))
}

pub fn note(label: impl Into<String>, role: &'static str) -> El {
    let token = if role == "alert" {
        "status-error"
    } else {
        "text-muted"
    };
    text(label)
        .role(role)
        .text_role(TextRole::Small)
        .color(tokens(dark()).color(token))
        .full_width()
        .pad(Space::Md)
        .wrap()
}

pub fn changes(additions: u64, deletions: u64) -> El {
    let t = tokens(dark());
    row()
        .separate(Space::Xs)
        .child(
            text(format!("+{additions}"))
                .text_role(TextRole::Label)
                .color(t.color("status-success")),
        )
        .child(
            text(format!("−{deletions}"))
                .text_role(TextRole::Label)
                .color(t.color("status-error")),
        )
}
