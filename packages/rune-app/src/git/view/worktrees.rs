use super::{Ui, basename};
use crate::{State, git, launcher, strings::t};
use rune::{El, Tx};
use rune_theme_codenomad::git_panel as theme;

fn choices(ui: &Ui) -> Vec<(String, String)> {
    let mut seen = std::collections::HashSet::new();
    ui.inventory
        .iter()
        .flat_map(|list| &list.trees)
        .filter(|tree| !tree.missing)
        .map(|tree| {
            let name = basename(&tree.directory);
            let mut label = if ui.repository() == git::Repository::Git {
                format!(
                    "{name} · {}",
                    tree.branch
                        .as_deref()
                        .unwrap_or_else(|| t("gitPanel.detached"))
                )
            } else {
                name.into()
            };
            while !seen.insert(label.clone()) {
                label.push_str(" · ");
                label.push_str(&tree.slug);
            }
            (label, tree.slug.clone())
        })
        .collect()
}

pub(super) fn browse(ui: &Ui, width: f32, overlay: &mut Vec<El>) -> El {
    let choices = choices(ui);
    let labels: Vec<_> = choices.iter().map(|(label, _)| label.clone()).collect();
    let current = choices
        .iter()
        .find(|(_, slug)| slug == &ui.slug)
        .map(|(label, _)| label.clone());
    let local_scope = ui.scope.clone();
    let close_scope = local_scope.clone();
    let select = move |s: &mut State, label: &str, tx: &mut Tx| {
        if !s
            .git
            .owner
            .as_ref()
            .is_some_and(|ui| std::rc::Rc::ptr_eq(&local_scope, &ui.scope))
        {
            return;
        }
        let had_preview = git::has_preview(s);
        if let Some(ui) = &mut s.git.owner {
            ui.picker = false;
            if let Some((_, slug)) = choices.iter().find(|(v, _)| v == label) {
                ui.select_tree(slug.clone());
            }
        }
        git::binding::sync_files(s);
        git::restore_reading_if_closed(s, had_preview, tx);
    };
    theme::worktree_picker(
        &labels,
        current.as_deref(),
        t("gitPanel.worktree"),
        ui.tree().map(|tree| tree.directory.as_str()),
        width,
        ui.picker,
        labels.is_empty() || !ui.online,
        {
            let scope = ui.scope.clone();
            move |s: &mut State| {
                if let Some(ui) = &mut s.git.owner
                    && std::rc::Rc::ptr_eq(&scope, &ui.scope)
                {
                    ui.picker = !ui.picker;
                }
            }
        },
        move |s: &mut State| {
            if let Some(ui) = &mut s.git.owner
                && std::rc::Rc::ptr_eq(&close_scope, &ui.scope)
            {
                ui.picker = false;
            }
        },
        select,
        overlay,
    )
}

pub(crate) fn session_worktree(s: &State, overlays: &mut Vec<El>) -> El {
    let Some(ui) = s.git.owner.as_ref().filter(|ui| {
        ui.repository() == git::Repository::Git
            && crate::workspace::active_session(s) == Some(ui.backend.session.as_str())
    }) else {
        return rune::el();
    };
    let enabled = git::can_place(s);
    let open = enabled && ui.placement_picker.is_some();
    let entries = if open {
        ui.placement_picker.clone().unwrap_or_default()
    } else {
        choices(ui)
    };
    let labels: Vec<_> = entries.iter().map(|(label, _)| label.clone()).collect();
    let selected = entries
        .iter()
        .find(|(_, slug)| slug == &ui.session_slug)
        .map(|(label, _)| label.clone());
    let name = t("sessionList.sort.worktree");
    let toggle_scope = s.input_scope.clone();
    let close_scope = toggle_scope.clone();
    let choose_scope = toggle_scope.clone();
    theme::session_worktree_picker(
        &labels,
        selected.as_deref(),
        name,
        t("instanceShell.worktree.unavailable"),
        open,
        !enabled,
        move |s: &mut State| {
            if s.current_scope(&toggle_scope)
                && git::can_place(s)
                && let Some(ui) = &mut s.git.owner
            {
                if ui.placement_picker.take().is_none() {
                    ui.placement_picker = Some(choices(ui));
                    ui.dirty(&[git::Lane::Worktrees]);
                    ui.demand();
                }
            }
        },
        move |s: &mut State| {
            if s.current_scope(&close_scope)
                && let Some(ui) = &mut s.git.owner
            {
                ui.placement_picker = None;
            }
        },
        move |s: &mut State, label, tx: &mut Tx| {
            if !s.current_scope(&choose_scope) || !git::can_place(s) {
                return;
            }
            let chosen = s.git.owner.as_mut().and_then(|ui| {
                let current = ui.session_slug.clone();
                let list = ui.placement_picker.take().unwrap_or_else(|| choices(ui));
                list.into_iter()
                    .find(|(name, _)| name == label)
                    .map(|(_, slug)| slug)
                    .filter(|slug| *slug != current)
            });
            if let Some(slug) = chosen {
                launcher::place(s, slug);
            }
            tx.instant();
        },
        overlays,
    )
}
