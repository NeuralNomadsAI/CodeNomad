use super::{can_send, device, recall, send};
use crate::{State, platform, screen, strings::t};
use rune::{El, Tx};
use rune_theme_codenomad::{
    action_menu::{self, Item, Menu},
    file_row_actions::icons as file_icons,
    git_panel::{self, overflow_trigger},
    shell::icons as shell_icons,
    workspace_tree::{self, icons as tree_icons},
};
use std::rc::Rc;

const KEY: &str = "composer-more";
// The native menu tree carries the role and disabled rows. Rune's web projection
// tracks these missing semantics in https://github.com/anomalyco/rune/issues/1677.

fn state(s: &mut State) -> Option<&mut action_menu::State<State>> {
    s.composer_active().then_some(&mut s.composer.menu)
}

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    action_menu::poll(s, state, tx) | crate::chat::reading::poll_jump(s, tx)
}

fn can_queue(s: &State) -> bool {
    !s.screen.is_launcher()
        && !s.composer.shell_mode
        && s.phase.running()
        && s.composer.picker.selected_command(&s.draft.text).is_none()
        && can_send(s)
}

pub(crate) fn can_clear(s: &State) -> bool {
    !s.draft.text.is_empty() && !s.composer_editing_locked() && !s.composer.device.busy()
}

pub(crate) fn clear(s: &mut State, tx: &mut Tx) {
    if !can_clear(s) {
        return;
    }
    recall::clear_recalled(s);
    s.draft.undo_group(|edit| {
        edit.set_selection(0, edit.text.len());
        edit.insert("");
    });
    s.composer.picker.reset();
    super::view::changed(s, tx);
    tx.focus("composer", false);
}

pub(crate) fn jump_key(s: &mut State, event: &rune::KeyEvent, tx: &mut Tx) -> bool {
    use super::shortcuts::Action;
    [(Action::PreviousUser, true), (Action::NextUser, false)]
        .into_iter()
        .any(|(action, previous)| {
            action.matches(s, event, tx) && crate::chat::reading::jump_user(s, previous, tx)
        })
}

pub(crate) fn view(s: &State) -> (El, Option<El>) {
    let scope = &s.input_scope;
    let queues_follow_ups = crate::settings::queues_follow_ups(s);
    let mut queue = Item::new(
        "queue",
        t(if queues_follow_ups {
            "promptQueue.actions.steer"
        } else {
            "promptInput.send.queueAriaLabel"
        }),
        screen::action_tx(scope, |s, tx| {
            if can_queue(s) {
                send(s, tx, true);
            } else {
                super::actions::refuse_send(s, tx);
            }
        }),
    );
    let queue_glyph = if queues_follow_ups {
        &shell_icons::FORWARD
    } else {
        &git_panel::ROWS
    };
    queue.icon = Some(Rc::new(move || workspace_tree::action_glyph(queue_glyph)));
    queue.disabled = !can_queue(s);
    queue.description = (!s.composer.shell_mode)
        .then(|| super::shortcuts::Action::Alternate.label(s))
        .flatten();
    let device_busy = s.composer.device.busy();
    let mut attach = Item::new(
        "attach",
        t(if device_busy {
            "promptInput.attachFiles.reading"
        } else {
            "promptInput.attachFiles.title"
        }),
        screen::action_tx(scope, platform::device_picker::choose),
    );
    let attach_glyph = if device_busy {
        &shell_icons::HOURGLASS
    } else {
        &tree_icons::FILE
    };
    attach.icon = Some(Rc::new(move || workspace_tree::action_glyph(attach_glyph)));
    attach.disabled = !device::available(s) || device_busy;
    attach.description = Some(
        t(
            if s.composer.picker.attachments_supported() || s.no_session_composer_active() {
                "promptInput.attachFiles.help"
            } else {
                "rune.attachments_unavailable"
            },
        )
        .into(),
    );
    // Browser file selection must run in the original input gesture.
    attach.select_before_close = true;
    let mut items = vec![Rc::new(queue), Rc::new(attach)];
    for (previous, action, label) in [
        (
            true,
            super::shortcuts::Action::PreviousUser,
            "commands.previousUserMessage.label",
        ),
        (
            false,
            super::shortcuts::Action::NextUser,
            "commands.nextUserMessage.label",
        ),
    ] {
        let mut item = Item::new(
            action.id(),
            t(label),
            screen::action_tx(scope, move |s, tx| {
                crate::chat::reading::jump_user(s, previous, tx);
            }),
        );
        item.disabled = !crate::chat::reading::can_jump_user(s, previous);
        item.description = action.label(s);
        items.push(Rc::new(item));
    }
    if recall::available(s) || s.composer.recall.is_some() {
        items.extend([true, false].map(|older| {
            let (key, label) = if older {
                ("previous", "promptInput.history.previousAriaLabel")
            } else {
                ("next", "promptInput.history.nextAriaLabel")
            };
            let mut item = Item::new(
                key,
                t(label),
                screen::action_tx(scope, move |s, tx| {
                    recall::step(s, older, true, tx);
                }),
            );
            item.disabled = !recall::can_browse(s, older);
            item.description = if older {
                super::shortcuts::Action::PreviousPrompt
            } else {
                super::shortcuts::Action::NextPrompt
            }
            .label(s);
            // Keep editor focus in the selecting gesture. Mouse release in Rune's web
            // host updates the editing proxy without activating it (Rune #1713).
            item.select_before_close = true;
            Rc::new(item)
        }));
    }
    let mut clear = Item::new(
        "clear",
        t("promptInput.clear.title"),
        screen::action_tx(scope, clear),
    );
    clear.icon = Some(Rc::new(|| workspace_tree::action_glyph(&file_icons::TRASH)));
    clear.disabled = !can_clear(s);
    clear.description = super::shortcuts::Action::Clear.label(s);
    clear.select_before_close = true;
    items.push(Rc::new(clear));
    let label = t("messageItem.actions.more");
    action_menu::view(
        &s.composer.menu,
        state,
        Rc::new(Menu::new(KEY, label, items)),
        overflow_trigger(label),
        s.shell.width(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Phase;
    use crate::transport::Command;
    use rune::{Env, Key, KeyEvent, Runtime};

    fn click(rt: &mut Runtime<State>, key: &str) {
        let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        rt.frame(0.02);
    }

    fn key(rt: &mut Runtime<State>, key: Key) {
        let event: KeyEvent = key.into();
        rt.key(event.clone());
        rt.key_up(event);
        rt.frame(0.02);
    }

    fn focused(rt: &Runtime<State>) -> Option<String> {
        rt.elements()
            .into_iter()
            .find(|element| element.focused)
            .and_then(|element| element.key)
    }

    #[test]
    fn keyboard_menu_queues_while_running_and_escape_dismisses() {
        let (commands, received) = codenomad_client::bounded(1);
        let mut s = crate::init();
        s.phase = Phase::Streaming;
        s.commands = Some(commands);
        s.draft = rune::edit::TextEdit::new("follow-up");
        let mut rt = Runtime::new(s, crate::view, (960.0, 640.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        rt.frame(0.0);
        click(&mut rt, "composer-more:trigger");
        assert!(rt.find("composer-more:item:queue").is_some());
        key(&mut rt, Key::Escape);
        assert!(rt.find("composer-more:menu").is_none());
        assert!(received.try_recv().is_err());

        click(&mut rt, "composer-more:trigger");
        key(&mut rt, Key::Down);
        assert_eq!(focused(&rt).as_deref(), Some("composer-more:item:queue"));
        key(&mut rt, Key::Enter);
        assert!(!rt.state.composer.menu.is_open(KEY));
        rt.frame(0.02);
        let Command::Prompt(prompt) = received.try_recv().expect("queued prompt") else {
            panic!("expected prompt");
        };
        assert_eq!(prompt.text, "follow-up");
        assert_eq!(
            prompt.delivery,
            Some(codenomad_client::prompt::Delivery::Queue)
        );
        assert!(rt.state.messages.is_empty());
    }

    #[test]
    fn clearing_is_undoable_and_keeps_unrelated_attachments() {
        let mut s = crate::init();
        s.phase = Phase::Ready;
        s.draft = rune::edit::TextEdit::new("keep on undo");
        let file = super::super::draft::Attachment::Skill {
            id: "review".into(),
            name: "Review".into(),
        };
        assert!(s.composer.draft.attach(file.clone()));
        let mut rt = Runtime::new(s, crate::view, (960.0, 640.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        rt.frame(0.0);
        click(&mut rt, "composer-more:trigger");
        click(&mut rt, "composer-more:item:clear");
        assert!(rt.state.draft.text.is_empty());
        assert!(rt.state.draft.focused);
        assert_eq!(rt.state.composer.draft.attachments, [file]);
        rt.update(|s, _| {
            s.draft.undo();
        });
        assert_eq!(rt.state.draft.text, "keep on undo");
    }

    #[test]
    fn clear_during_recall_undoes_to_the_displayed_prompt_not_the_fresh_draft() {
        let mut s = crate::init();
        s.phase = Phase::Ready;
        s.draft = rune::edit::TextEdit::new("A");
        assert!(recall::record(&mut s, "A".into(), false));
        s.draft = rune::edit::TextEdit::new("B");
        let mut rt = Runtime::new(s, crate::view, (960.0, 640.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        rt.frame(0.0);
        click(&mut rt, "composer-more:trigger");
        click(&mut rt, "composer-more:item:previous");
        assert_eq!(rt.state.draft.text, "A");
        assert_eq!(rt.state.draft.range(), (1, 1));
        assert!(rt.state.draft.focused);
        click(&mut rt, "composer-more:trigger");
        click(&mut rt, "composer-more:item:clear");
        assert!(rt.state.draft.text.is_empty());
        assert!(rt.state.composer.recall.is_none());
        assert!(rt.state.draft.focused);
        rt.update(|s, _| {
            s.draft.undo();
        });
        assert_eq!(rt.state.draft.text, "A");
    }

    #[test]
    fn idle_menu_has_a_menu_role_and_an_inactive_queue_item() {
        fn node<'a>(tree: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
            if tree["key"] == key {
                return Some(tree);
            }
            tree["children"]
                .as_array()?
                .iter()
                .find_map(|child| node(child, key))
        }
        let mut s = crate::init();
        s.phase = Phase::Ready;
        s.draft = rune::edit::TextEdit::new("draft");
        let mut rt = Runtime::new(s, crate::view, (960.0, 640.0), Env::new(false, 1.0));
        rt.frame(0.0);
        click(&mut rt, "composer-more:trigger");
        let tree = rt.accessibility_json();
        assert_eq!(node(&tree, "composer-more:menu").unwrap()["role"], "menu");
        let queue = node(&tree, "composer-more:item:queue").unwrap();
        assert_eq!(queue["role"], "menu-item");
        assert!(
            queue["states"]
                .as_array()
                .unwrap()
                .iter()
                .any(|state| state == "disabled")
        );
    }
}
