use super::recall::Project;
use crate::{State, transport::PromptOutcome};
use std::collections::HashMap;

const MAX_UNCONFIRMED: usize = 100;

pub(super) type Target = (Project, String);

pub(crate) enum CommandKind {
    Slash { name: String, args: String },
    Shell { command: String },
}

pub(crate) struct CommandAttempt {
    pub(super) target: Target,
    pub(super) kind: CommandKind,
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
    let Some(target) = super::recall::command_target(s) else {
        return false;
    };
    if s.composer.shell_mode {
        let Some(command) = s.composer.draft.resolve_shell(&s.draft) else {
            return false;
        };
        return s.command_receipts.0.values().any(|attempt| {
            attempt.target == target
                && matches!(&attempt.kind, CommandKind::Shell { command: held } if held == &command)
        });
    }
    let Some((name, args)) = super::picker::command_parts(&s.draft.text) else {
        return false;
    };
    let Some(args) = s.composer.draft.resolve_args(&s.draft, args) else {
        return false;
    };
    s.command_receipts.0.values().any(|attempt| {
        attempt.target == target
            && matches!(
                &attempt.kind,
                CommandKind::Slash {
                    name: held_name,
                    args: held_args
                } if held_name == name && held_args == &args
            )
    })
}
