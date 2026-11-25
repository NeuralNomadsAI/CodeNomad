use super::{
    Actions, Intent, PruneContext, PruneHover, available, cleanup, clear_prune_hover, empty_draft,
    set_prune_hover, start,
};
use crate::{
    Message, State,
    content::Part,
    screen,
    strings::{locale, t},
};
use codenomad_client::message_actions::PruneMessageTarget;
use rune::{El, Tx, text};
use rune_theme_codenomad::{
    action_menu::{self, Item, Menu},
    catalogue, document_reader, git_panel, layout, markdown,
};
use std::rc::Rc;

fn at(s: &mut State) -> Option<&mut action_menu::State<State>> {
    Some(&mut s.transcript_display.messages.menu)
}

fn lookup<'a>(s: &'a State, id: &str) -> Option<&'a Message> {
    s.transcript_display
        .messages
        .visible(&s.messages)
        .iter()
        .find(|message| message.id == id)
        .map(|row| row.as_ref())
}

fn raw(message: &Message) -> String {
    if message.role == "user" || message.parts.is_empty() {
        return message.body.clone();
    }
    message
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Text(part) if !part.text.trim().is_empty() => Some(part.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn copy(s: &State, id: &str) -> impl Fn(&mut State, &mut Tx) + 'static {
    let id = id.to_owned();
    screen::action_tx(&s.input_scope, move |s, tx| {
        if let Some(message) = lookup(s, &id) {
            let source = raw(message);
            if !source.trim().is_empty() {
                s.transcript_display.children.cancel_copy();
                tx.copy(source);
            }
        }
    })
}

fn controls(s: &State, message: &Message) -> Option<Rc<Menu<State>>> {
    let owner = &s.transcript_display.messages;
    let user = message.role == "user";
    let eligible = user || message.role == "assistant" && message.completed;
    let id = &message.id;
    let mut items = Vec::new();
    if !message.body.trim().is_empty() {
        items.push(Rc::new(Item::new(
            "copy",
            t("messageItem.actions.copy"),
            copy(s, id),
        )));
    }
    if eligible && owner.backend.is_some() {
        let mut fork = Item::new(
            "fork",
            t("messageItem.actions.forkTitle"),
            screen::action_tx(&s.input_scope, {
                let id = id.clone();
                move |s, _| {
                    if lookup(s, &id).is_some_and(|row| row.role == "user" || row.completed) {
                        start(s, Intent::Fork(id.clone()));
                    }
                }
            }),
        );
        fork.disabled = !available(s) || !crate::launcher::can_change_session(s);
        items.push(Rc::new(fork));
    }
    if user && owner.backend.is_some() {
        let mut edit = Item::new(
            "revert",
            t("messageItem.actions.revertTitle"),
            screen::action_tx(&s.input_scope, {
                let id = id.clone();
                move |s, _| {
                    if let Some(row) = lookup(s, &id).filter(|row| row.role == "user") {
                        start(
                            s,
                            Intent::Edit {
                                id: id.clone(),
                                text: row.body.clone(),
                            },
                        );
                    }
                }
            }),
        );
        edit.disabled = !available(s) || !empty_draft(s);
        items.push(Rc::new(edit));
    }
    if eligible && !user {
        let has_response = cleanup::has_response_part(message);
        let targets = if has_response {
            cleanup::response_targets(s, id)
        } else {
            cleanup::message_targets(s, id)
        };
        if !targets.is_empty() {
            let hover = if has_response {
                PruneHover::Response(id.clone())
            } else {
                PruneHover::Message(id.clone())
            };
            let mut prune = Item::new(
                "delete-technical-parts",
                t("messageItem.actions.deleteTechnicalParts"),
                screen::action_tx(&s.input_scope, {
                    let id = id.clone();
                    move |s, _| {
                        let Some(row) = lookup(s, &id) else {
                            return;
                        };
                        let targets = if cleanup::has_response_part(row) {
                            cleanup::response_targets(s, &id)
                        } else {
                            cleanup::message_targets(s, &id)
                        };
                        if !targets.is_empty() {
                            start(
                                s,
                                Intent::PreviewPrune {
                                    targets,
                                    context: PruneContext {
                                        group_key: None,
                                        summary_label: None,
                                        return_focus: Some((
                                            format!("message-actions-{id}:trigger"),
                                            None,
                                        )),
                                    },
                                },
                            );
                        }
                    }
                }),
            );
            prune.disabled = !available(s) || owner.backend.is_none();
            if owner.backend.is_none() {
                prune.description = Some(t("history.sessionUnavailable").into());
            } else {
                let enter_hover = hover.clone();
                let leave_hover = hover;
                prune.on_mouse_enter =
                    Some(Rc::new(screen::action_tx(&s.input_scope, move |s, _| {
                        set_prune_hover(s, enter_hover.clone());
                    })));
                prune.on_mouse_leave =
                    Some(Rc::new(screen::action_tx(&s.input_scope, move |s, _| {
                        clear_prune_hover(s, &leave_hover);
                    })));
            }
            items.push(Rc::new(prune));
        }
    }
    if items.is_empty() || items.len() == 1 && items[0].key == "copy" {
        return None;
    }
    let mut menu = Menu::new(
        &format!("message-actions-{id}"),
        t("messageItem.actions.more"),
        items,
    );
    let id = id.clone();
    let scope = s.input_scope.clone();
    menu.on_open_change = Some(Rc::new(move |s, open, _| {
        if s.current_scope(&scope) {
            s.transcript_display.messages.open_menu = open.then(|| id.clone());
        }
    }));
    Some(Rc::new(menu))
}

fn parts(s: &State, menu: Rc<Menu<State>>) -> (El, Option<El>) {
    let trigger = git_panel::overflow_trigger(&menu.label);
    action_menu::view(
        &s.transcript_display.messages.menu,
        at,
        menu,
        trigger,
        s.tool_diff_preferences.history_bounds.get()[2],
    )
}

pub(in crate::chat) fn header(s: &State, message: &Message, header: El) -> El {
    let id = &message.id;
    header
        .children((!message.body.trim().is_empty()).then(|| {
            markdown::copy_button(t("messageItem.actions.copy"), copy(s, id))
                .key(format!("copy-message-{id}"))
        }))
        .children(controls(s, message).map(|menu| parts(s, menu).0))
}

pub(in crate::chat) fn group_delete_button(
    s: &State,
    key: &str,
    summary_label: String,
    targets: &[PruneMessageTarget],
) -> El {
    let disabled = !available(s) || s.transcript_display.messages.backend.is_none();
    let click_targets = targets.to_vec();
    let group_key = key.to_owned();
    let hover = PruneHover::Group(key.to_owned());
    let hover_scope = s.input_scope.clone();
    let button = layout::button(
        t("messagePart.actions.delete"),
        disabled,
        screen::action(&s.input_scope, move |s| {
            start(
                s,
                Intent::PreviewPrune {
                    targets: click_targets.clone(),
                    context: PruneContext {
                        group_key: Some(group_key.clone()),
                        summary_label: Some(summary_label.clone()),
                        return_focus: Some((
                            format!("delete-group-{group_key}"),
                            Some(format!("toggle-{group_key}")),
                        )),
                    },
                },
            );
        }),
    )
    .key(format!("delete-group-{key}"));
    if disabled {
        button
    } else {
        button.on_hover_change(move |s: &mut State, inside, _| {
            if !s.current_scope(&hover_scope) {
                return;
            }
            if inside {
                set_prune_hover(s, hover.clone());
            } else {
                clear_prune_hover(s, &hover);
            }
        })
    }
}

pub(in crate::chat) fn overlays(s: &State, layers: &mut Vec<El>) {
    let owner = &s.transcript_display.messages;
    if let Some(menu) = owner
        .open_menu
        .as_deref()
        .and_then(|id| lookup(s, id))
        .and_then(|row| controls(s, row))
        && let Some(popup) = parts(s, menu).1
    {
        layers.push(popup);
    }
    if let Some((scope, preview, context)) = &owner.confirmation
        && scope.ptr_eq(&Rc::downgrade(&s.input_scope))
    {
        let owner_scope = scope.clone();
        let (tools, reasoning) = preview.counts();
        let (title, message, confirm_label) = if let Some(summary) = &context.summary_label {
            (
                t("messagePart.actions.delete"),
                summary.clone(),
                t("messagePart.actions.delete"),
            )
        } else {
            (
                t("messageItem.actions.deleteTechnicalParts.confirmTitle"),
                catalogue::format(
                    locale(),
                    "messageItem.actions.deleteTechnicalParts.confirmMessage",
                    &[
                        ("toolCount", &tools.to_string()),
                        ("reasoningCount", &reasoning.to_string()),
                    ],
                ),
                t("messageItem.actions.deleteTechnicalParts.confirmLabel"),
            )
        };
        layers.push(document_reader::editor::confirmation_titled(
            layout::dark(),
            title,
            &message,
            t("alertDialog.actions.cancel"),
            confirm_label,
            move |s: &mut State, accepted, tx| {
                if !owner_scope.ptr_eq(&Rc::downgrade(&s.input_scope)) {
                    return;
                }
                if let Some((_, preview, context)) =
                    s.transcript_display.messages.confirmation.take()
                {
                    if accepted {
                        start(s, Intent::Prune { preview, context });
                    } else if let Some((primary, fallback)) = context.return_focus {
                        let target = if let Some(group_key) = &context.group_key {
                            if super::super::tool_groups::Groups::project(s)
                                .group_delete_active(s, group_key)
                            {
                                Some(primary)
                            } else {
                                fallback
                            }
                        } else {
                            Some(primary)
                        };
                        if let Some(target) = target {
                            tx.return_focus(target, tx.focus_visible());
                        }
                    }
                }
            },
        ));
    }
}

pub(in crate::chat) fn restore(s: &State) -> impl Iterator<Item = El> {
    let owner = &s.transcript_display.messages;
    let restore = owner.boundary.is_some().then(|| {
        layout::button(
            t("commands.redoLastMessage.label"),
            !available(s) || !owner.can_restore(),
            screen::action(&s.input_scope, |s| start(s, Intent::Restore)),
        )
        .key("restore-message-history")
    });
    restore
        .into_iter()
        .chain(owner.error.map(|error| text(t(error)).role("alert").wrap()))
}

pub(super) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    if let Some(id) = s.transcript_display.messages.open_menu.clone()
        && lookup(s, &id).is_none()
    {
        action_menu::clear(s, at, &format!("message-actions-{id}"), tx);
        s.transcript_display.messages.open_menu = None;
    }
    action_menu::poll(s, at, tx)
}

pub(super) fn close(owner: &mut Actions) {
    owner.menu = Default::default();
    owner.open_menu = None;
    owner.confirmation = None;
    owner.prune_hover = None;
}
