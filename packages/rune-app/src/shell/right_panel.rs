use super::connection;
use crate::{
    State,
    strings::t,
    workspace::{self, RightPanelTab},
};
use rune::{El, col, text};
use rune_theme_codenomad::{Space, layout::Layout, shell};

pub(super) fn tab_focus_key(s: &State) -> String {
    let index = match workspace::right_panel_tab(s) {
        RightPanelTab::Status => 0,
        RightPanelTab::Files => 1,
        RightPanelTab::Missions if workspace::mission_supported(s) => 2,
        RightPanelTab::Missions => 0,
    };
    format!("right-panel-tab-{index}")
}

pub(super) fn last_focus_key(s: &State) -> Option<String> {
    match workspace::right_panel_tab(s) {
        RightPanelTab::Status => {
            if super::status_usage::has_section(s) {
                return (!super::status_usage::expanded(s)).then(|| "status-provider-usage".into());
            }
            if super::status_permissions::has_section(s) {
                return Some(if super::status_permissions::expanded(s) {
                    "permission-mode-info".into()
                } else {
                    "status-permissions".into()
                });
            }
            Some(tab_focus_key(s))
        }
        RightPanelTab::Files => {
            (s.git.owner.is_none() && s.files.is_none()).then(|| tab_focus_key(s))
        }
        RightPanelTab::Missions => None,
    }
}

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
    let chosen = workspace::right_panel_tab(s);
    let picker = shell::panel_tabs(
        t("window.menu.rightPanel"),
        &names[..rows],
        tabs.iter().position(|tab| *tab == chosen).unwrap_or(0),
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
    col()
        .full_width()
        .full_height()
        .child(shell::header(floating, true, touch, [picker]))
        .child(match chosen {
            RightPanelTab::Files => {
                crate::git::panel(s, width, crate::files::tree(s, width, touch)).remaining()
            }
            RightPanelTab::Missions => workspace::mission_panel(s).remaining(),
            RightPanelTab::Status => col()
                .remaining()
                .scroll(rune::ScrollSpec {
                    stick_bottom: false,
                })
                .child(
                    col()
                        .full_width()
                        .pad(Space::Md)
                        .separate(Space::Sm)
                        .child(text(connection(s)))
                        .children(crate::chat::usage::session(s))
                        .children(super::status_permissions::view(s))
                        .children(super::status_usage::section(s)),
                ),
        })
}
