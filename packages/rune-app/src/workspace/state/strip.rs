use super::{State, Tab, busy, close, close_blocked, new_tab, select};
use crate::strings;
use rune::{Cx, El};

pub fn strip(s: &State, cx: &mut Cx<State>) -> El {
    let Some(ui) = &s.workspace else {
        return rune::el();
    };
    let titles: Vec<_> = ui
        .entries
        .iter()
        .map(|e| match &e.saved {
            Tab::Blank => strings::t("instanceTabs.new.ariaLabel"),
            Tab::Workspace(w) => w.folder.as_str(),
        })
        .collect();
    let tabs: Vec<_> = ui
        .entries
        .iter()
        .zip(&titles)
        .enumerate()
        .map(
            |(index, (entry, title))| rune_theme_codenomad::tabs::ProjectTab {
                id: &entry.key,
                title,
                status: if index == ui.active && !s.screen.is_launcher() {
                    super::super::cache::status(&s.phase, s.agent.as_ref())
                } else if let Some(cache) = &entry.cache {
                    cache.status()
                } else if entry.project.is_none() && matches!(entry.saved, Tab::Workspace(_)) {
                    Some(rune_theme_codenomad::tabs::Status::Unavailable)
                } else {
                    None
                },
                closable: !busy(s) && !close_blocked(s, index),
            },
        )
        .collect();
    let touch = cx.touch_controls();
    let actions = crate::settings::entries(touch)
        .into_iter()
        .chain(std::iter::once(crate::shell::notifications::history_entry(
            s, touch,
        )));
    let browse_shadows_new = crate::platform::folder_picker_available()
        && matches!(ui.entries[ui.active].saved, Tab::Blank)
        && {
            let new_key = crate::settings::shortcut_label(s, "new-instance");
            !new_key.is_empty() && new_key == crate::settings::shortcut_label(s, "browse-folder")
        };
    let new_help = if browse_shadows_new {
        strings::t("instanceTabs.new.title").to_owned()
    } else {
        crate::settings::with_shortcut_label(
            s,
            strings::t("instanceTabs.new.title"),
            "new-instance",
        )
    };
    let active_close_help = crate::settings::with_shortcut_label(
        s,
        strings::t("instanceTab.actions.close.ariaLabel"),
        "close-instance",
    );
    rune_theme_codenomad::tabs::strip_with_help(
        touch,
        strings::locale(),
        &tabs,
        ui.entries.get(ui.active).map(|e| e.key.as_str()),
        &new_help,
        &active_close_help,
        select,
        close,
        new_tab,
        actions,
    )
}
