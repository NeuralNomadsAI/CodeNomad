use crate::{State, agent_view, chat, composer, git, shell, transcript};
use rune::{Cx, El};

pub(crate) fn chat_view(s: &State, cx: &mut Cx<State>) -> El {
    let expanded = interruption_expanded(s);
    let visible_viewport = cx
        .layout_size("session-shell")
        .or_else(|| cx.layout_size("session-stack"))
        .map(|size| size[1]);
    let shell_height = cx.layout_size("application-shell").map(|size| size[1]);
    let editing = s.draft.focused || crate::agent::focused_field_key(s).is_some();
    let reference_height = crate::platform::reference_viewport_height(visible_viewport, editing);
    let layout_viewport_height = crate::platform::layout_viewport_height(shell_height);
    let layout = rune_theme_codenomad::interruption::session_layout(
        cx,
        expanded,
        s.agent.is_some(),
        s.attachments.error,
        reference_height,
    );
    let mut overlays = Vec::new();
    let worktree = git::session_worktree(s, &mut overlays);
    let scroll_stack = layout.scrolls_stack();
    let stack_scroll = s.tool_diff_preferences.stack_scroll.clone();
    let (caret_pins, caret_probe) =
        chat::ToolDiffPreferences::composer_caret_plan(s, cx, scroll_stack);
    let surface = rune_theme_codenomad::interruption::session_surface(layout)
        .on_scroll_offset(move |at| {
            stack_scroll.set((at.offset[1], at.max[1]));
        })
        .on_layout_tx(move |s: &mut State, rect, tx| {
            if !s.screen.is_launcher() {
                chat::ToolDiffPreferences::stack_layout(s, rect, scroll_stack, tx);
            } else {
                tx.live_only();
            }
        });
    chat::reading::probe_resuming_scroll(s, cx);
    let surface = if s.agent.is_some() {
        surface.on_key(|s: &mut State, event, tx| {
            if !s.screen.is_launcher()
                && event.key == rune::Key::Tab
                && !event.mods.ctrl
                && !event.mods.cmd
                && !event.mods.alt
            {
                tx.wake_after(std::time::Duration::ZERO);
            }
            false
        })
    } else {
        surface
    };
    let surface = if s
        .tool_diff_preferences
        .watch_stack_wheel(scroll_stack, s.revision)
    {
        surface.on_wheel(move |s: &mut State, ev, tx| {
            chat::ToolDiffPreferences::stack_wheel(s, ev.dy, tx)
        })
    } else {
        surface
    };
    let body = surface
        .children(caret_probe)
        .children(chat::ToolDiffPreferences::agent_focus_probe(
            s,
            cx,
            scroll_stack,
        ))
        .children(chat::reading::wheel_restore_probe(s, cx))
        .child(shell::reader(s, || {
            let history = rune_theme_codenomad::interruption::history(layout)
                .role("region")
                .label(crate::strings::t("settings.voice.conversation.title"))
                .drawn_rect_into(&s.tool_diff_preferences.history_bounds)
                .child(transcript::rows(s));
            chat::reading::viewport(s, history, scroll_stack)
        }))
        .child(
            agent_view::view(s, cx, layout_viewport_height).on_layout_tx(
                move |s: &mut State, rect, tx| {
                    if !s.screen.is_launcher() {
                        chat::ToolDiffPreferences::agent_panel_layout(s, rect, scroll_stack, tx);
                    } else {
                        tx.live_only();
                    }
                },
            ),
        )
        .children(chat::attachments::error(s))
        .child(
            composer::view::view(s, layout, caret_pins, Some(worktree)).on_layout_tx(
                move |s: &mut State, _, tx| {
                    if !s.screen.is_launcher() {
                        chat::ToolDiffPreferences::composer_layout(s, scroll_stack, tx);
                    } else {
                        tx.live_only();
                    }
                },
            ),
        );
    rune_theme_codenomad::git_panel::with_overlays(body, overlays)
}

fn interruption_expanded(s: &State) -> bool {
    s.agent
        .as_ref()
        .is_some_and(|a| a.picker || !a.ids().is_empty())
}
