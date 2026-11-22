use super::connection;
use crate::{State, strings::t};
use rune::{El, col, text};
use rune_theme_codenomad::{Space, layout::Layout, shell};

pub fn view(s: &State, touch: bool, floating: bool) -> El {
    let label = t("instanceShell.rightPanel.tabs.status");
    col()
        .full_width()
        .full_height()
        .child(shell::header(
            floating,
            true,
            touch,
            [shell::panel_title(label).role("heading")],
        ))
        .child(col().pad(Space::Md).child(text(connection(s))))
}
