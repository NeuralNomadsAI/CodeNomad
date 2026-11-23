use crate::{State, agent_view, chat, composer, git, shell, transcript};
use rune::{Cx, El};

pub(crate) fn chat_view(s: &State, cx: &mut Cx<State>) -> El {
    let expanded = interruption_expanded(s);
    let mut overlays = Vec::new();
    let worktree = git::session_worktree(s, &mut overlays);
    overlays.extend(super::media::preview(s));
    let body = rune_theme_codenomad::interruption::session_surface(expanded)
        .child(shell::reader(s, || {
            let history = rune_theme_codenomad::interruption::history(expanded)
                .drawn_rect_into(&s.tool_diff_preferences.history_bounds)
                .children(super::receipts::session(s))
                .child(transcript::rows(s));
            chat::reading::viewport(s, history)
        }))
        .child(agent_view::view(s, cx))
        .children(chat::attachments::error(s))
        .child(composer::view::view(s, expanded, Some(worktree)));
    rune_theme_codenomad::git_panel::with_overlays(body, overlays)
}

fn interruption_expanded(s: &State) -> bool {
    s.agent
        .as_ref()
        .is_some_and(|a| a.picker || !a.ids().is_empty())
}
