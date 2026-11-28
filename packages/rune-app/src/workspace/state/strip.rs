use super::{State, Tab, busy, close, close_blocked, new_tab, select};
use crate::strings;
use rune::El;

fn fallback_status(
    entry: &super::Entry,
    clock: f64,
    keep_unseen: bool,
) -> Option<rune_theme_codenomad::tabs::Status> {
    if entry.idle_markers.any_working() {
        Some(rune_theme_codenomad::tabs::Status::Working)
    } else {
        entry
            .idle_markers
            .tab_idle_visible(clock, keep_unseen)
            .then_some(rune_theme_codenomad::tabs::Status::Idle)
    }
}

pub fn strip(s: &State, touch: bool, skip_tab: bool) -> El {
    let Some(ui) = &s.workspace else {
        return rune::el();
    };
    let titles: Vec<_> = ui
        .entries
        .iter()
        .map(|e| match &e.saved {
            Tab::Blank => strings::t("instanceTabs.new.ariaLabel"),
            Tab::Workspace(w) => w
                .project_name
                .as_deref()
                .filter(|name| !name.trim().is_empty())
                .unwrap_or(w.folder.as_str()),
        })
        .collect();
    let keep_unseen = crate::settings::keep_unseen_subagent_idle_status(s);
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
                        .or_else(|| fallback_status(entry, ui.clock, keep_unseen))
                } else if let Some(cache) = &entry.cache {
                    cache
                        .status()
                        .or_else(|| fallback_status(entry, ui.clock, keep_unseen))
                } else if entry.project.is_none() && matches!(entry.saved, Tab::Workspace(_)) {
                    Some(rune_theme_codenomad::tabs::Status::Unavailable)
                } else {
                    fallback_status(entry, ui.clock, keep_unseen)
                },
                closable: !busy(s) && !close_blocked(s, index),
                temporary: matches!(&entry.saved, Tab::Workspace(w) if w.temporary),
            },
        )
        .collect();
    let actions = crate::settings::entries(touch, skip_tab)
        .into_iter()
        .chain(std::iter::once(crate::shell::notifications::history_entry(
            s, touch, skip_tab,
        )))
        .chain(crate::shell::remote_control_entry(s, touch, skip_tab));
    let search_visible = crate::timeline::search::available(s);
    let (new_shadowed, close_shadowed): (&[&str], &[&str]) =
        if !crate::shell::launcher_replaces_project(s)
            && s.screen.launcher().is_some_and(|l| l.project.is_some())
        {
            if search_visible {
                (
                    &["session-search", "session-new"],
                    &["session-search", "session-new", "new-instance"],
                )
            } else {
                (&["session-new"], &["session-new", "new-instance"])
            }
        } else {
            (&[], &["new-instance"])
        };
    let new_help = crate::settings::with_shortcut_label_excluding(
        s,
        strings::t("instanceTabs.new.title"),
        "new-instance",
        new_shadowed,
    );
    let active_close_help = crate::settings::with_shortcut_label_excluding(
        s,
        strings::t("instanceTab.actions.close.ariaLabel"),
        "close-instance",
        close_shadowed,
    );
    rune_theme_codenomad::tabs::strip_with_help(
        touch,
        strings::locale(),
        &tabs,
        ui.entries.get(ui.active).map(|e| e.key.as_str()),
        &new_help,
        &active_close_help,
        skip_tab,
        select,
        close,
        new_tab,
        actions,
    )
}
