use super::{can_send, send};
use crate::{Phase, State, screen, strings::t};
use rune::{El, Key, KeyEvent, Tx, col, text};
use rune_theme_codenomad::{
    Space, field_kit,
    layout::{self, Layout},
};

pub fn view(s: &State) -> El {
    let scope = s.input_scope.clone();
    let edit_scope = scope.clone();
    let stop = s.phase == Phase::Streaming && s.agent.is_some();
    let editor = layout::composer_field(&s.draft)
        .label(t("rune.prompt"))
        .placeholder(t("promptInput.placeholder.default"))
        .on_edit(screen::edit(&scope, screen::Editor::Composer))
        .on_change(screen::action_tx(&scope, crate::workspace::draft_changed))
        .on_key(move |s: &mut State, event, tx| s.current_scope(&edit_scope) && key(s, event, tx))
        .build(field_kit(layout::dark()))
        .key("composer");
    let mut actions = layout::action_row().child(
        layout::button_tx(
            t("promptInput.overlay.send"),
            !can_send(s),
            screen::action_tx(&scope, |s, tx| send(s, tx, false)),
        )
        .key("send"),
    );
    if stop {
        actions = actions.child(
            layout::button(
                t("promptInput.stopSession.ariaLabel"),
                s.agent.as_ref().is_some_and(|a| a.stopping),
                screen::action(&scope, |s| {
                    if let Some(agent) = &mut s.agent {
                        agent.stop();
                    }
                }),
            )
            .key("composer-stop"),
        );
    }
    col()
        .key("session-composer")
        .role("group")
        .label(t("rune.prompt"))
        .full_width()
        .pad(Space::Md)
        .separate(Space::Sm)
        .child(col().content_direction().child(editor))
        .child(actions)
        .children(
            s.composer
                .send_error
                .then(|| text(t("rune.failed")).role("alert")),
        )
}

fn key(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if event.key == Key::Enter && event.mods == rune::Mods::default() {
        send(s, tx, false);
        true
    } else if event.key == Key::Enter
        && (event.mods.alt && !event.mods.ctrl && !event.mods.cmd && !event.mods.logo
            || event.mods.shift && event.mods.cmd && !event.mods.alt)
    {
        send(s, tx, true);
        true
    } else {
        false
    }
}
