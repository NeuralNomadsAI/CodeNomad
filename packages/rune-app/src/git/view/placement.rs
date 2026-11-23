use crate::{State, git, launcher, strings::t};
use rune::{El, Tx};

pub(crate) fn session_worktree(s: &State, overlays: &mut Vec<El>) -> El {
    let Some(ui) = s.git.owner.as_ref().filter(|ui| {
        ui.repository() == git::Repository::Git
            && crate::workspace::active_session(s) == Some(ui.backend.session.as_str())
    }) else {
        return rune::el();
    };
    let enabled = git::can_place(s);
    let open = enabled && ui.placement_picker.is_some();
    let choices = if open {
        ui.placement_picker.clone().unwrap_or_default()
    } else {
        super::worktree_choices(ui)
    };
    let labels: Vec<_> = choices.iter().map(|(label, _)| label.clone()).collect();
    let selected = choices
        .iter()
        .find(|(_, slug)| slug == &ui.session_slug)
        .map(|(label, _)| label.clone());
    let name = t("sessionList.sort.worktree");
    let toggle_scope = s.input_scope.clone();
    let close_scope = toggle_scope.clone();
    let choose_scope = toggle_scope.clone();
    rune_theme_codenomad::git_panel::session_worktree_picker(
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
                    ui.placement_picker = Some(super::worktree_choices(ui));
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
            if let Some(choices) = s
                .git
                .owner
                .as_mut()
                .and_then(|ui| ui.placement_picker.take())
                && let Some((_, slug)) = choices.into_iter().find(|(name, _)| name == label)
            {
                launcher::place(s, slug);
            }
            tx.instant();
        },
        overlays,
    )
}
