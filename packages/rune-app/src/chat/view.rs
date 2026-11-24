use crate::{State, agent_view, chat, composer, git, shell, transcript};
use rune::{Cx, El};
use rune_theme_codenomad::layout;

pub(crate) fn chat_view(s: &State, cx: &mut Cx<State>) -> El {
    let expanded = interruption_expanded(s);
    let mut overlays = Vec::new();
    let worktree = git::session_worktree(s, &mut overlays);
    let (more, menu) = composer::menu::view(s);
    overlays.extend(menu);
    overlays.extend(super::media::preview(s));
    super::message_actions::overlays(s, &mut overlays);
    let controls = (!git::has_preview(s) && !crate::files::has_preview(s)).then(|| {
        layout::action_row().child(crate::settings::transcript_filters::trigger(
            s,
            &mut overlays,
            cx.touch_controls(),
        ))
    });
    let body = rune_theme_codenomad::interruption::session_surface(expanded)
        .children(controls)
        .children(super::message_actions::restore(s))
        .child(shell::reader(s, || {
            let history = rune_theme_codenomad::interruption::history(expanded)
                .drawn_rect_into(&s.tool_diff_preferences.history_bounds)
                .children(super::receipts::session(s))
                .child(transcript::rows(s));
            crate::timeline::view(
                s,
                chat::reading::viewport(s, crate::timeline::watch(s, history)),
                expanded,
            )
        }))
        .child(agent_view::view(s, cx))
        .children(chat::attachments::error(s))
        .child(composer::view::view(s, expanded, Some(worktree), more));
    crate::timeline::search::overlay(s, cx, &mut overlays);
    if s.paging {
        overlays.push(rune_theme_codenomad::timeline::navigation_status(
            crate::strings::t("history.navigation.loading"),
        ));
    }
    overlays.extend(crate::timeline::preview_overlay(s));
    rune_theme_codenomad::layout::with_overlays(body, overlays).key(crate::timeline::search::HOST)
}

fn interruption_expanded(s: &State) -> bool {
    s.agent
        .as_ref()
        .is_some_and(|a| a.picker || !a.ids().is_empty())
}
