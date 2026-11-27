use super::recall::Project;
use crate::{State, transport::PromptOutcome};
use std::collections::{HashMap, HashSet};

const MAX_UNCONFIRMED: usize = 100;

pub(super) type Target = (Project, String);

#[derive(Clone)]
pub(crate) struct CommandAttempt {
    pub(super) target: Target,
    pub(super) name: String,
    pub(super) args: String,
}

#[derive(Default)]
pub(crate) struct CommandReceipts {
    held: HashMap<String, CommandAttempt>,
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

    pub(super) fn release_in_flight(&mut self, id: &str) {
        self.in_flight.remove(id);
    }

    pub(super) fn hold(&mut self, id: String, attempt: CommandAttempt) {
        self.in_flight.remove(&id);
        self.held.insert(id, attempt);
    }

    pub(super) fn settle(&mut self, id: &str, outcome: &PromptOutcome) {
        self.in_flight.remove(id);
        if !matches!(outcome, PromptOutcome::Unconfirmed) {
            self.held.remove(id);
        }
    }

    pub(crate) fn has_for_state(&self, s: &State) -> bool {
        let Some(target) = super::recall::command_target(s) else {
            return false;
        };
        self.held.values().any(|attempt| attempt.target == target)
    }

    pub(crate) fn has_for_session(&self, session_id: &str) -> bool {
        self.held
            .values()
            .any(|attempt| attempt.target.1 == session_id)
    }
}

pub(super) fn repeats(s: &State) -> bool {
    if s.command_receipts.held.is_empty() {
        return false;
    }
    let (Some(target), Some((name, args))) = (
        super::recall::command_target(s),
        super::picker::command_parts(&s.draft.text),
    ) else {
        return false;
    };
    let Some(args) = s.composer.draft.resolve_args(&s.draft, args) else {
        return false;
    };
    s.command_receipts
        .held
        .values()
        .any(|attempt| attempt.target == target && attempt.name == name && attempt.args == args)
}
