use super::{
    Item, Picker,
    lookup::{Lookup, Read},
    replace,
};
use crate::{backend::Backend, platform::reads::Reads};
use codenomad_client::prompt_catalogue::Named;
use rune::{Waker, edit::TextEdit};

#[derive(Default)]
pub(super) struct Commands {
    pub(super) items: Vec<Item>,
    pub(super) read: Option<Read>,
    pub(super) dirty: bool,
    loaded: bool,
    failed: bool,
    pub(super) intent: Option<String>,
}

impl Commands {
    pub(super) fn loading(&self) -> bool {
        self.read.is_some()
    }

    pub(super) fn error(&self) -> bool {
        self.failed
    }

    pub(super) fn poll(&mut self, backend: Option<&Backend>, reads: &Reads, wake: &Waker) -> bool {
        let Some(reply) = Read::take(&mut self.read) else {
            return false;
        };
        if std::mem::take(&mut self.dirty) {
            self.refresh(backend, reads, wake);
        } else {
            self.loaded = true;
            self.failed = reply.error;
            if !reply.error {
                self.items = reply.items;
            }
        }
        true
    }

    pub(super) fn retain_intent(&mut self, text: &str) {
        if self.intent.as_deref() != parts(text).map(|(name, _)| name) {
            self.intent = None;
        }
    }

    pub(super) fn choose(&mut self, edit: &mut TextEdit, command: &Named) {
        self.intent = Some(command.name.clone());
        let end = edit
            .text
            .find(super::super::tokens::whitespace)
            .unwrap_or(edit.text.len());
        replace(edit, 0..end, &format!("/{} ", command.name));
    }

    fn refresh(&mut self, backend: Option<&Backend>, reads: &Reads, wake: &Waker) {
        if self.read.is_none()
            && let Some(backend) = backend
        {
            self.read = Some(Read::start(backend, None, Lookup::Commands, reads, wake));
        }
    }
}

impl Picker {
    pub fn remember_command(&mut self, name: &str) {
        self.commands.intent = Some(name.into());
    }

    pub fn selected_command<'a>(&self, text: &'a str) -> Option<(&'a str, &'a str)> {
        let (name, args) = parts(text)?;
        self.commands
            .items
            .iter()
            .any(|command| command.label() == name)
            .then_some((name, args))
    }

    pub fn commands_settled(&self) -> bool {
        self.commands.loaded && !self.commands.loading()
    }

    pub fn command_pending(&self, text: &str) -> bool {
        parts(text).is_some() && (self.commands.loading() || self.command_unavailable(text))
    }

    pub fn command_unavailable(&self, text: &str) -> bool {
        !self.commands.loading()
            && parts(text).is_some_and(|(name, _)| {
                self.commands.error()
                    || (self.commands.intent.as_deref() == Some(name)
                        && self.selected_command(text).is_none())
            })
    }

    pub fn refresh_commands(&mut self, reads: &Reads, wake: &Waker) {
        self.commands.refresh(self.backend.as_ref(), reads, wake);
    }

    pub fn reconnect_commands(&mut self, reads: &Reads, wake: &Waker) {
        self.commands.read = None;
        self.commands.dirty = false;
        self.refresh_commands(reads, wake);
    }

    pub fn commands_changed(&mut self, reads: &Reads, wake: &Waker) {
        if self.commands.loading() {
            self.commands.dirty = true;
        } else {
            self.refresh_commands(reads, wake);
        }
    }
}

pub(in crate::composer) fn parts(text: &str) -> Option<(&str, &str)> {
    use super::super::tokens::whitespace;
    let text = text.trim_matches(whitespace).strip_prefix('/')?;
    let (name, args) = text.split_once(' ').unwrap_or((text, ""));
    Some((name, args.trim_start_matches(whitespace)))
}
