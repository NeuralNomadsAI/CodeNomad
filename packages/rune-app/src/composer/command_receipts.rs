use super::recall::Project;
use crate::{State, transport::PromptOutcome};
use std::collections::HashMap;

const MAX_UNCONFIRMED: usize = 100;

pub(super) type Target = (Project, String);

#[derive(Clone)]
pub(crate) enum CommandKind {
    Slash { name: String, args: String },
    Shell { command: String },
}

#[derive(Clone)]
pub(crate) struct CommandAttempt {
    pub(super) target: Target,
    pub(super) kind: CommandKind,
}

struct Held {
    attempt: CommandAttempt,
    unconfirmed: bool,
}

#[derive(Default)]
pub(crate) struct CommandReceipts(HashMap<String, Held>);

impl CommandReceipts {
    pub(super) fn full(&self) -> bool {
        self.0.len() >= MAX_UNCONFIRMED
    }

    pub(super) fn reserve(&mut self, id: String, attempt: CommandAttempt) {
        self.0.insert(
            id,
            Held {
                attempt,
                unconfirmed: false,
            },
        );
    }

    pub(super) fn hold(&mut self, id: String, attempt: CommandAttempt) {
        self.0.insert(
            id,
            Held {
                attempt,
                unconfirmed: true,
            },
        );
    }

    pub(super) fn settle(&mut self, id: &str, outcome: &PromptOutcome) {
        if matches!(outcome, PromptOutcome::Unconfirmed) {
            if let Some(held) = self.0.get_mut(id) {
                held.unconfirmed = true;
            }
        } else {
            self.0.remove(id);
        }
    }

    pub(super) fn reconcile_shell(
        &mut self,
        target: Option<&Target>,
        messages: &[crate::history::Row],
    ) {
        let Some(target) = target else {
            return;
        };
        if self.0.is_empty() {
            return;
        }
        self.0.retain(|id, held| {
            !(held.attempt.target == *target
                && matches!(held.attempt.kind, CommandKind::Shell { .. })
                && messages.iter().any(|row| {
                    row.role == "shell" && row.id == *id && (held.unconfirmed || row.completed)
                }))
        });
    }
}

fn matches_held(s: &State, unconfirmed_only: bool) -> bool {
    if s.command_receipts.0.is_empty() {
        return false;
    }
    let Some(target) = super::recall::command_target(s) else {
        return false;
    };
    if s.composer.shell_mode {
        let Some(command) = s.composer.draft.resolve_shell(&s.draft) else {
            return false;
        };
        return s.command_receipts.0.values().any(|held| {
            (!unconfirmed_only || held.unconfirmed)
                && held.attempt.target == target
                && matches!(&held.attempt.kind, CommandKind::Shell { command: cmd } if cmd == &command)
        });
    }
    let Some((name, args)) = super::picker::command_parts(&s.draft.text) else {
        return false;
    };
    let Some(args) = s.composer.draft.resolve_args(&s.draft, args) else {
        return false;
    };
    s.command_receipts.0.values().any(|held| {
        (!unconfirmed_only || held.unconfirmed)
            && held.attempt.target == target
            && matches!(
                &held.attempt.kind,
                CommandKind::Slash {
                    name: held_name,
                    args: held_args
                } if held_name == name && held_args == &args
            )
    })
}

pub(super) fn repeats(s: &State) -> bool {
    matches_held(s, false)
}

pub(super) fn repeats_unconfirmed(s: &State) -> bool {
    matches_held(s, true)
}
