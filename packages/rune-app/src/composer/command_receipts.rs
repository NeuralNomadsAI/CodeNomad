use super::recall::Project;
use crate::{State, transport::PromptOutcome};
use std::collections::{HashMap, HashSet};

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
    observed: bool,
}

#[derive(Default)]
pub(crate) struct CommandReceipts {
    held: HashMap<String, Held>,
    in_flight: HashSet<String>,
}

impl CommandReceipts {
    pub(super) fn full(&self) -> bool {
        self.held.len().saturating_add(self.in_flight.len()) >= MAX_UNCONFIRMED
    }

    pub(super) fn reserve(&mut self, id: String) -> bool {
        if self.full() {
            return false;
        }
        self.in_flight.insert(id);
        true
    }

    pub(super) fn reserve_shell(&mut self, id: String, attempt: CommandAttempt) -> bool {
        if self.full() {
            return false;
        }
        self.held.insert(
            id,
            Held {
                attempt,
                unconfirmed: false,
                observed: false,
            },
        );
        true
    }

    pub(super) fn release_in_flight(&mut self, id: &str) {
        self.in_flight.remove(id);
        if self.held.get(id).is_some_and(|held| !held.unconfirmed) {
            self.held.remove(id);
        }
    }

    pub(super) fn hold(&mut self, id: String, attempt: CommandAttempt) {
        self.in_flight.remove(&id);
        self.held.insert(
            id,
            Held {
                attempt,
                unconfirmed: true,
                observed: false,
            },
        );
    }

    pub(super) fn target_matches(&self, id: &str, target: Option<&Target>) -> bool {
        target.is_some_and(|active| {
            self.held
                .get(id)
                .is_some_and(|held| held.attempt.target == *active)
        })
    }

    pub(super) fn settle(
        &mut self,
        id: &str,
        outcome: &PromptOutcome,
        messages: &[crate::history::Row],
        target_matches: bool,
    ) -> bool {
        self.in_flight.remove(id);
        let is_shell = self
            .held
            .get(id)
            .is_some_and(|held| matches!(held.attempt.kind, CommandKind::Shell { .. }));
        let observed = is_shell
            && (self.held.get(id).is_some_and(|held| held.observed)
                || (target_matches
                    && messages
                        .iter()
                        .any(|row| row.role == "shell" && row.id == id)));
        if matches!(outcome, PromptOutcome::Unconfirmed) {
            if observed {
                self.held.remove(id);
                return true;
            }
            if let Some(held) = self.held.get_mut(id) {
                held.unconfirmed = true;
            }
            return false;
        }
        self.held.remove(id);
        observed
    }

    pub(super) fn reconcile_shell(
        &mut self,
        target: Option<&Target>,
        messages: &[crate::history::Row],
    ) {
        let Some(target) = target else {
            return;
        };
        if self.held.is_empty() {
            return;
        }
        for (id, held) in &mut self.held {
            if held.attempt.target == *target
                && matches!(held.attempt.kind, CommandKind::Shell { .. })
                && messages
                    .iter()
                    .any(|row| row.role == "shell" && row.id == *id)
            {
                held.observed = true;
            }
        }
        self.held
            .retain(|_, held| !(held.unconfirmed && held.observed));
    }

    pub(crate) fn has_for_state(&self, s: &State) -> bool {
        let Some(target) = super::recall::command_target(s) else {
            return false;
        };
        self.held.values().any(|held| held.attempt.target == target)
    }

    pub(crate) fn has_for_session(&self, session_id: &str) -> bool {
        self.held
            .values()
            .any(|held| held.attempt.target.1 == session_id)
    }
}

fn matches_held(s: &State, unconfirmed_only: bool) -> bool {
    if s.command_receipts.held.is_empty() {
        return false;
    }
    let Some(target) = super::recall::command_target(s) else {
        return false;
    };
    if s.composer.shell_mode {
        let Some(command) = s.composer.draft.resolve_shell(&s.draft) else {
            return false;
        };
        return s.command_receipts.held.values().any(|held| {
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
    s.command_receipts.held.values().any(|held| {
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
