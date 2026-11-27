mod commands;
mod lookup;
mod mentions;
pub(super) use commands::parts as command_parts;
#[cfg(test)]
mod tests;

use super::{
    draft::Draft,
    tokens::{Query, query},
};
use crate::{backend::Backend, platform::reads::Reads};
use codenomad_client::prompt_catalogue::{Named, ProjectMatch};
use rune::{Key, KeyEvent, Tx, Waker, edit::TextEdit};
use std::ops::Range;

#[derive(Default)]
pub struct Picker {
    backend: Option<Backend>,
    commands: commands::Commands,
    mentions: mentions::Mentions,
    dismissed: Option<usize>,
    dismissed_command: Option<String>,
    current: Option<(Query, String)>,
    completed: Option<(Range<usize>, String)>,
    pub entries: Vec<Item>,
    pub selected: usize,
    selection_moved: bool,
    attachments_supported: bool,
    pub generation: u64,
}

#[derive(Clone)]
pub enum Item {
    File(ProjectMatch),
    Agent(Named),
    Skill(Named),
    Command(Named),
}

impl Item {
    fn identity(&self) -> (std::mem::Discriminant<Self>, &str) {
        let id = match self {
            Self::File(item) => &item.path,
            Self::Agent(item) | Self::Skill(item) | Self::Command(item) => &item.id,
        };
        (std::mem::discriminant(self), id)
    }

    pub fn label(&self) -> &str {
        match self {
            Self::File(item) => &item.path,
            Self::Agent(item) | Self::Skill(item) | Self::Command(item) => &item.name,
        }
    }

    pub fn description(&self) -> &str {
        match self {
            Self::File(_) => "",
            Self::Agent(item) | Self::Skill(item) | Self::Command(item) => &item.description,
        }
    }
}

impl Picker {
    pub(crate) fn backend(&self) -> Option<&Backend> {
        self.backend.as_ref()
    }

    #[cfg(test)]
    pub(crate) fn add_test_command(&mut self, name: &str) {
        self.commands.items.push(Item::Command(Named {
            id: name.into(),
            name: name.into(),
            description: String::new(),
            primary: false,
        }));
    }

    pub fn bind(&mut self, backend: Backend) {
        let intent = self.commands.intent.take();
        *self = Self {
            backend: Some(backend),
            ..Self::default()
        };
        self.commands.intent = intent;
    }

    pub fn open(&self) -> bool {
        self.current.is_some()
    }

    pub fn slash(&self) -> bool {
        matches!(self.current, Some((Query::Command(_), _)))
    }

    pub fn attachments_supported(&self) -> bool {
        self.attachments_supported
    }

    pub fn set_attachments_supported(&mut self, supported: bool) {
        if self.attachments_supported != supported {
            self.attachments_supported = supported;
            if self.open() && !self.slash() {
                self.refresh_preserving_selection();
            }
        }
    }

    pub fn mentions_changed(&mut self, reads: &Reads, wake: &Waker) {
        if self.open() && !self.slash() {
            self.mentions
                .catalogue_changed(self.backend.as_ref(), reads, wake);
        }
    }

    pub fn loading(&self) -> bool {
        if self.slash() {
            self.commands.loading()
        } else {
            self.mentions.loading()
        }
    }

    pub fn error(&self) -> bool {
        if self.slash() {
            self.commands.error()
        } else {
            self.mentions.error()
        }
    }

    pub fn close(&mut self, text: &str) {
        let current = self.current.take();
        self.reset();
        match current {
            Some((Query::Mention(range), _)) => self.dismissed = Some(range.start),
            Some((Query::Command(_), _)) => self.dismissed_command = Some(text.into()),
            None => {}
        }
    }

    pub fn reset(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.current = None;
        self.completed = None;
        self.dismissed = None;
        self.dismissed_command = None;
        self.entries.clear();
        self.selection_moved = false;
        self.mentions.reset();
    }

    pub fn changed(&mut self, edit: &TextEdit, reads: &Reads, wake: &Waker) {
        self.commands.retain_intent(&edit.text);
        let Some(token) = self.token(edit) else {
            self.reset();
            return;
        };
        let range = match &token {
            Query::Command(range) | Query::Mention(range) => range,
        };
        if match token {
            Query::Mention(_) => self.dismissed == Some(range.start),
            Query::Command(_) => self.dismissed_command.as_deref() == Some(edit.text.as_str()),
        } {
            return;
        }
        self.dismissed = None;
        self.dismissed_command = None;
        let draft = edit.text[range.start + 1..range.end].to_owned();
        let slash = matches!(token, Query::Command(_));
        let same_mode = self.open() && slash == self.slash();
        if self
            .current
            .as_ref()
            .is_some_and(|(old, query)| old == &token && query == &draft)
        {
            return;
        }
        if !same_mode {
            self.reset();
        }
        if slash {
            if !same_mode {
                self.refresh_commands(reads, wake);
            }
        } else {
            self.mentions
                .search(self.backend.as_ref(), &draft, !same_mode, reads, wake);
        }
        self.current = Some((token, draft));
        self.selected = 0;
        self.selection_moved = false;
        self.refresh_entries();
    }

    pub fn poll(&mut self, reads: &Reads, wake: &Waker) -> bool {
        let commands = self.commands.poll(self.backend.as_ref(), reads, wake);
        let mentions = self.mentions.poll(self.backend.as_ref(), reads, wake);
        if self.open() && if self.slash() { commands } else { mentions } {
            self.refresh_preserving_selection();
        }
        commands || mentions
    }

    fn refresh_preserving_selection(&mut self) {
        let active = (self.slash() || self.selection_moved)
            .then(|| self.entries.get(self.selected).cloned())
            .flatten();
        self.refresh_entries();
        let active = active.and_then(|active| {
            self.entries
                .iter()
                .position(|item| item.identity() == active.identity())
        });
        self.selection_moved &= active.is_some();
        self.selected = active.unwrap_or(0);
    }

    fn token(&self, edit: &TextEdit) -> Option<Query> {
        let caret = edit.range().0;
        if let Some((range, prefix)) = &self.completed
            && edit.text.get(range.clone()) == Some(prefix.as_str())
            && super::tokens::mention_start(&edit.text, range.start)
            && edit
                .text
                .get(range.end..caret)
                .is_some_and(|tail| !tail.contains(super::tokens::whitespace))
        {
            return Some(Query::Mention(range.start..caret));
        }
        query(&edit.text, caret)
    }

    fn refresh_entries(&mut self) {
        let Some((token, text)) = &self.current else {
            return;
        };
        self.generation = self.generation.wrapping_add(1);
        self.entries.clear();
        if matches!(token, Query::Command(_)) {
            matching(&self.commands.items, text, &mut self.entries);
        } else {
            self.mentions.entries(text, &mut self.entries);
            if !self.attachments_supported {
                self.entries.retain(|item| !matches!(item, Item::Skill(_)));
            }
        }
    }

    pub fn key(&mut self, text: &str, event: &KeyEvent, tx: &mut Tx) -> bool {
        match event.key {
            Key::Up => self.selected = self.selected.saturating_sub(1),
            Key::Down => {
                self.selected = (self.selected + 1).min(self.entries.len().saturating_sub(1))
            }
            Key::Escape => {
                self.close(text);
                return true;
            }
            _ => return false,
        }
        if let Some(item) = self.entries.get(self.selected) {
            self.selection_moved = true;
            rune_theme_codenomad::layout::announce_polite(tx, item.label());
        }
        true
    }

    pub fn activate(&mut self, index: usize, generation: u64) {
        if generation == self.generation && index < self.entries.len() {
            self.selected = index;
            self.selection_moved = true;
        }
    }

    pub fn choose(
        &mut self,
        edit: &mut TextEdit,
        draft: &mut Draft,
        index: usize,
        tab: bool,
        path_only: bool,
    ) -> bool {
        let Some((token, _)) = self.current.as_ref() else {
            return false;
        };
        let Some(item) = self.entries.get(index) else {
            return false;
        };
        match (token, item) {
            (Query::Command(_), Item::Command(command)) => self.commands.choose(edit, command),
            (Query::Mention(range), _) if self.token(edit).as_ref() == Some(token) => {
                let mode = if !self.attachments_supported {
                    mentions::Mode::Text
                } else if path_only {
                    mentions::Mode::Path
                } else {
                    mentions::Mode::Attachment
                };
                let Some(keep_open) =
                    self.mentions
                        .choose(edit, draft, range.clone(), item, tab, mode)
                else {
                    return false;
                };
                if keep_open {
                    let completed = range.start..edit.range().0;
                    self.completed = edit
                        .text
                        .get(completed.clone())
                        .filter(|text| text.contains(super::tokens::whitespace))
                        .map(|text| (completed, text.to_owned()));
                    return true;
                }
            }
            _ => return false,
        }
        self.close(&edit.text);
        true
    }
}

fn matching(items: &[Item], text: &str, out: &mut Vec<Item>) {
    let query = text.trim().to_lowercase();
    out.extend(
        items
            .iter()
            .filter(|item| {
                item.label().to_lowercase().contains(&query)
                    || item.description().to_lowercase().contains(&query)
            })
            .cloned(),
    );
}

fn replace(edit: &mut TextEdit, range: Range<usize>, insertion: &str) {
    if edit.text.get(range.clone()).is_some() {
        edit.set_selection(range.start, range.end);
        edit.insert(insertion);
    }
}
