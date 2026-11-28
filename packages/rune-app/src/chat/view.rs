use crate::{Phase, State, agent_view, chat, composer, git, shell, strings::t, transcript};
use rune::{Cx, El};
use rune_theme_codenomad::{
    empty_state::{self, EmptyStateCopy},
    interruption, layout,
};

const NARROW_EMPTY_WIDTH: f32 = 768.0;

fn branded_empty_state(s: &State, cx: &Cx<State>, no_session: bool) -> El {
    let width = cx
        .layout_size("session-stack")
        .map(|size| size[0])
        .filter(|w| w.is_finite() && *w > 0.0)
        .unwrap_or_else(|| s.shell.width());
    let narrow = width > 0.0 && width < NARROW_EMPTY_WIDTH;
    empty_state::branded(
        EmptyStateCopy {
            logo_alt: t("messageSection.empty.logoAlt"),
            brand_title: t("messageSection.empty.brandTitle"),
            title: t("messageSection.empty.title"),
            description: t(if no_session {
                "instanceShell.empty.description"
            } else {
                "messageSection.empty.description"
            }),
            tip_command_palette: t("messageSection.empty.tips.commandPalette"),
            tip_ask_about_codebase: t("messageSection.empty.tips.askAboutCodebase"),
            tip_attach_files_prefix: t("messageSection.empty.tips.attachFilesPrefix"),
        },
        narrow,
    )
}

fn session_is_empty(s: &State) -> bool {
    let failed = s.phase == Phase::Failed || {
        #[cfg(target_arch = "wasm32")]
        {
            matches!(s.phase, Phase::WorkspaceMissing | Phase::RestoreFailed)
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            false
        }
    };
    s.phase != Phase::Loading
        && !s.paging
        && !s.history_error
        && !failed
        && !s.can_older
        && !s.history_detached
        && s.reader.as_ref().is_none_or(|reader| !reader.can_retry())
        && s.transcript_display
            .messages
            .visible(&s.messages)
            .is_empty()
        && s.transcript_display.queue.items().is_empty()
}

pub(crate) fn no_session_view(s: &State, cx: &mut Cx<State>) -> El {
    let visible_viewport = cx
        .layout_size("session-shell")
        .or_else(|| cx.layout_size("session-stack"))
        .map(|size| size[1]);
    let reference_height =
        crate::platform::reference_viewport_height(visible_viewport, s.draft.focused);
    let layout = interruption::session_layout(
        cx,
        false,
        false,
        false,
        false,
        false,
        false,
        None,
        reference_height,
    );
    let (more, menu) = composer::menu::view(s);
    let mut overlays = Vec::new();
    overlays.extend(menu);
    let scroll_stack = layout.scrolls_stack();
    let (caret_pins, caret_probe) =
        chat::ToolDiffPreferences::composer_caret_plan(s, cx, scroll_stack);
    let body = interruption::session_surface(layout)
        .children(caret_probe)
        .child(
            interruption::scroll_region()
                .key("no-session-empty-viewport")
                .role("region")
                .label(t("settings.voice.conversation.title"))
                .child(branded_empty_state(s, cx, true)),
        )
        .child(composer::view::view(s, layout, caret_pins, None, more));
    layout::with_overlays(body, overlays)
}

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
    let mut overlays = Vec::new();
    let worktree = git::session_worktree(s, &mut overlays);
    overlays.extend(super::media::preview(s));
    super::message_actions::overlays(s, &mut overlays);
    let has_controls = !git::has_preview(s)
        && !crate::files::has_preview(s)
        && !crate::workspace::mission_has_reader(s);
    let controls = has_controls.then(|| {
        layout::action_row().key("transcript-controls").child(
            crate::settings::transcript_filters::trigger(s, &mut overlays, cx.touch_controls()),
        )
    });
    let restore: Vec<El> = super::message_actions::restore(s)
        .chain(super::queue::recovery(s))
        .chain(super::queue::error(s))
        .collect();
    let has_restore =
        s.transcript_display.messages.has_restore() || s.transcript_display.queue.has_saved_edit();
    let has_restore_error =
        s.transcript_display.messages.has_error() || s.transcript_display.queue.has_error();
    let timeline_notice = crate::timeline::notice_key(s);
    let layout = rune_theme_codenomad::interruption::session_layout(
        cx,
        expanded,
        s.agent.is_some(),
        s.attachments.error,
        has_controls,
        has_restore,
        has_restore_error,
        timeline_notice,
        reference_height,
    );
    let (more, menu) = composer::menu::view(s);
    overlays.extend(menu);
    let scroll_stack = layout.scrolls_stack();
    let stack_scroll = s.tool_diff_preferences.stack_scroll.clone();
    let (caret_pins, caret_probe) =
        chat::ToolDiffPreferences::composer_caret_plan(s, cx, scroll_stack);
    let surface = crate::chat::reading::track_other_scroller_hover(
        rune_theme_codenomad::interruption::session_surface(layout)
            .drawn_rect_into(s.transcript_display.tool_clock.stack_bounds())
            .on_scroll_offset(move |at| {
                stack_scroll.set((at.offset[1], at.max[1]));
            })
            .on_layout_tx(move |s: &mut State, rect, tx| {
                if !s.screen.is_launcher() {
                    chat::ToolDiffPreferences::stack_layout(s, rect, scroll_stack, tx);
                } else {
                    tx.live_only();
                }
            }),
        chat::reading::HOVER_SESSION_STACK,
    );
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
    let body = super::tools::duration::observe_clip(
        s,
        surface
            .children(caret_probe)
            .children(chat::ToolDiffPreferences::agent_focus_probe(
                s,
                cx,
                scroll_stack,
            ))
            .children(chat::reading::wheel_restore_probe(s, cx))
            .children(controls)
            .children(restore)
            .child(shell::reader(s, || {
                let empty = session_is_empty(s);
                let history = super::tools::duration::observe_clip(
                    s,
                    rune_theme_codenomad::interruption::history(layout)
                        .role("region")
                        .label(crate::strings::t("settings.voice.conversation.title"))
                        .drawn_rect_into(&s.tool_diff_preferences.history_bounds)
                        .children(super::receipts::session(s))
                        .child(transcript::rows(s))
                        .children(empty.then(|| branded_empty_state(s, cx, false))),
                );
                crate::timeline::view(
                    s,
                    cx,
                    chat::reading::viewport(s, history, scroll_stack),
                    layout,
                )
            }))
            .child(
                agent_view::view(s, cx, layout_viewport_height).on_layout_tx(
                    move |s: &mut State, rect, tx| {
                        if !s.screen.is_launcher() {
                            chat::ToolDiffPreferences::agent_panel_layout(
                                s,
                                rect,
                                scroll_stack,
                                tx,
                            );
                        } else {
                            tx.live_only();
                        }
                    },
                ),
            )
            .children(chat::attachments::error(s))
            .child(
                composer::view::view(s, layout, caret_pins, Some(worktree), more).on_layout_tx(
                    move |s: &mut State, _, tx| {
                        if !s.screen.is_launcher() {
                            chat::ToolDiffPreferences::composer_layout(s, scroll_stack, tx);
                        } else {
                            tx.live_only();
                        }
                    },
                ),
            ),
    );
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
