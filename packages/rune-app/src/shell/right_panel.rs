use super::connection;
use crate::{State, strings::t};
use rune::{El, col, text};
use rune_theme_codenomad::{Space, layout::Layout, shell};

pub fn view(s: &State, width: f32, touch: bool, floating: bool) -> El {
    let label = t("instanceShell.rightPanel.tabs.status");
    let names = [label, t("instanceShell.rightPanel.tabs.files")];
    let picker = rune_theme_codenomad::git_panel::modes(
        &names,
        t("window.menu.rightPanel"),
        Some(usize::from(crate::workspace::files_tab(s))),
        {
            let owner = s.input_scope.clone();
            move |s: &mut State, index, tx: &mut rune::Tx| {
                if s.current_scope(&owner) {
                    crate::workspace::set_files_tab(s, index == 1);
                    tx.instant();
                }
            }
        },
    )
    .key("right-panel-tabs");
    col()
        .full_width()
        .full_height()
        .child(shell::header(floating, true, touch, [picker]))
        .child(if crate::workspace::files_tab(s) {
            crate::git::panel(s, width, rune::el()).remaining()
        } else {
            col().pad(Space::Md).child(text(connection(s)))
        })
}
