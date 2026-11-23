use crate::{State, agent_view, chat, composer, shell, transcript};
use rune::{Cx, El};

pub(crate) fn chat_view(s: &State, cx: &mut Cx<State>) -> El {
    let expanded = interruption_expanded(s);
    rune_theme_codenomad::interruption::session_surface(expanded)
        .child(shell::reader(s, || {
            let history = rune_theme_codenomad::interruption::history(expanded)
                .drawn_rect_into(&s.tool_diff_preferences.history_bounds)
                .child(transcript::rows(s));
            chat::reading::viewport(s, history)
        }))
        .child(agent_view::view(s, cx))
        .children(chat::attachments::error(s))
        .child(composer::view::view(s, expanded))
}

fn interruption_expanded(s: &State) -> bool {
    s.agent
        .as_ref()
        .is_some_and(|a| a.picker || !a.ids().is_empty())
}
