use super::recall::Project;
use crate::{State, transport::PromptOutcome};
use std::collections::HashMap;

const MAX_UNCONFIRMED: usize = 100;

pub(super) type Target = (Project, String);

#[derive(Clone)]
pub(crate) struct CommandAttempt {
    pub(super) target: Target,
    pub(super) name: String,
    pub(super) args: String,
}

#[derive(Default)]
pub(crate) struct CommandReceipts(HashMap<String, CommandAttempt>);

impl CommandReceipts {
    pub(super) fn full(&self) -> bool {
        self.0.len() >= MAX_UNCONFIRMED
    }

    pub(super) fn hold(&mut self, id: String, attempt: CommandAttempt) {
        self.0.insert(id, attempt);
    }

    pub(super) fn settle(&mut self, id: &str, outcome: &PromptOutcome) {
        if !matches!(outcome, PromptOutcome::Unconfirmed) {
            self.0.remove(id);
        }
    }
}

pub(super) fn repeats(s: &State) -> bool {
    if s.command_receipts.0.is_empty() {
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
        .0
        .values()
        .any(|attempt| attempt.target == target && attempt.name == name && attempt.args == args)
}
