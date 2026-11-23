use crate::{State, agent_view, chat, composer, git, shell, transcript};
use rune::{Cx, El};

pub(crate) fn chat_view(s: &State, cx: &mut Cx<State>) -> El {
    let expanded = interruption_expanded(s);
    let mut overlays = Vec::new();
    let worktree = git::session_worktree(s, &mut overlays);
    let body = rune_theme_codenomad::interruption::session_surface(expanded)
        .child(shell::reader(s, || {
            let history = rune_theme_codenomad::interruption::history(expanded)
                .drawn_rect_into(&s.tool_diff_preferences.history_bounds)
                .child(transcript::rows(s));
            crate::timeline::view(
                s,
                chat::reading::viewport(s, crate::timeline::watch(s, history)),
                expanded,
            )
        }))
        .child(agent_view::view(s, cx))
        .children(chat::attachments::error(s))
        .child(composer::view::view(s, expanded, Some(worktree)));
    overlays.extend(
        crate::timeline::search::panel(s).map(rune_theme_codenomad::timeline::search::floating),
    );
    if s.paging {
        overlays.push(rune_theme_codenomad::timeline::navigation_status(
            crate::strings::t("history.navigation.loading"),
        ));
    }
    rune_theme_codenomad::layout::with_overlays(body, overlays)
}

fn interruption_expanded(s: &State) -> bool {
    s.agent
        .as_ref()
        .is_some_and(|a| a.picker || !a.ids().is_empty())
}
