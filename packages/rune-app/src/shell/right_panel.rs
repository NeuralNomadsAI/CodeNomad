use super::connection;
use crate::{
    State,
    strings::t,
    workspace::{self, RightPanelTab},
};
use rune::{El, col, text};
use rune_theme_codenomad::{Space, layout::Layout, shell};

pub fn view(s: &State, width: f32, touch: bool, floating: bool) -> El {
    let label = t("instanceShell.rightPanel.tabs.status");
    let names = [
        label,
        t("instanceShell.rightPanel.tabs.files"),
        t("instanceShell.rightPanel.tabs.missions"),
    ];
    let tabs = [
        RightPanelTab::Status,
        RightPanelTab::Files,
        RightPanelTab::Missions,
    ];
    let rows = if workspace::mission_supported(s) {
        3
    } else {
        2
    };
    let rtl = rune_theme_codenomad::catalogue::direction(crate::strings::locale()) == "rtl";
    let chosen = workspace::right_panel_tab(s);
    let picker = shell::panel_tabs_dir(
        t("instanceShell.rightPanel.tabs.ariaLabel"),
        &names[..rows],
        tabs.iter().position(|tab| *tab == chosen).unwrap_or(0),
        rtl,
        {
            let owner = s.input_scope.clone();
            move |s: &mut State, index, tx: &mut rune::Tx| {
                if s.current_scope(&owner)
                    && let Some(tab) = tabs.get(index).copied()
                {
                    workspace::set_right_panel_tab(s, tab);
                    tx.instant();
                }
            }
        },
    )
    .key("right-panel-tabs");
    crate::chat::reading::track_other_scroller_hover(
        col()
            .full_width()
            .full_height()
            .child(shell::right_panel_header(floating, true, touch, picker))
            .child(match chosen {
                RightPanelTab::Files => {
                    crate::git::panel(s, width, crate::files::tree(s, width, touch)).remaining()
                }
                RightPanelTab::Missions => workspace::mission_panel(s).remaining(),
                RightPanelTab::Status => {
                    let status_scroll = s.tool_diff_preferences.right_panel_status_scroll.clone();
                    col()
                        .remaining()
                        .scroll(rune::ScrollSpec {
                            stick_bottom: false,
                        })
                        .on_scroll_offset(move |at| {
                            status_scroll.set((at.offset[1], at.max[1]));
                        })
                        .child(
                            col()
                                .full_width()
                                .pad(Space::Md)
                                .separate(Space::Sm)
                                .child(text(connection(s)))
                                .children(crate::chat::usage::session(s))
                                .children(super::status_permissions::view(s))
                                .children(super::status_usage::section(s))
                                .children(super::status_services::view(s)),
                        )
                }
            }),
        crate::chat::reading::HOVER_RIGHT_PANEL,
    )
}
