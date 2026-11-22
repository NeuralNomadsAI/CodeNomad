use codenomad_client::git::{Change, Section, Status};
use rune::edit::TextEdit;
use std::{collections::HashSet, rc::Rc};

pub(super) const ROW_LIMIT: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(super) struct Id {
    pub section: Section,
    pub path: String,
}

impl Id {
    pub(super) fn key(&self) -> String {
        self.action_key("file")
    }

    pub(super) fn action_key(&self, action: &str) -> String {
        format!("git-row-{}:{action}:{}", self.section.key(), self.path)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Row {
    pub id: Id,
    pub original_path: Option<String>,
    pub change: Change,
}

pub(super) struct Changes {
    inventory: Option<Vec<Status>>,
    count: usize,
    rows: Vec<Rc<Row>>,
    pub current: Option<Id>,
    pub bulk: HashSet<Id>,
    pub selection_revision: u64,
    anchor: Option<Id>,
    pins: HashSet<Id>,
    shown: [usize; 2],
    pub open: [bool; 2],
    pub draft: TextEdit,
}

impl Default for Changes {
    fn default() -> Self {
        Self {
            inventory: None,
            count: 0,
            rows: Vec::new(),
            current: None,
            bulk: HashSet::new(),
            selection_revision: 0,
            anchor: None,
            pins: HashSet::new(),
            shown: [ROW_LIMIT; 2],
            open: [true; 2],
            draft: TextEdit::new(""),
        }
    }
}

pub(super) const SECTIONS: [Section; 2] = [Section::Staged, Section::Unstaged];
pub(super) fn index(section: Section) -> usize {
    usize::from(section == Section::Unstaged)
}

impl Changes {
    pub fn replace(&mut self, entries: Vec<Status>, hide: bool) -> bool {
        if self.inventory.as_ref() == Some(&entries) {
            return false;
        }
        self.inventory = Some(entries);
        self.project(hide);
        true
    }

    pub fn project(&mut self, hide: bool) {
        let Some(entries) = &self.inventory else {
            return;
        };
        self.count = entries
            .iter()
            .filter(|entry| {
                entry.staged.is_some()
                    || entry.unstaged.is_some() && !(hide && entry.whitespace_only)
            })
            .count();
        let by_id: std::collections::HashMap<_, _> =
            self.rows.iter().map(|row| (&row.id, row)).collect();
        self.rows = SECTIONS
            .into_iter()
            .flat_map(|section| {
                entries.iter().filter_map(move |entry| {
                    let change = match section {
                        Section::Staged => entry.staged.as_ref(),
                        Section::Unstaged if !hide || !entry.whitespace_only => {
                            entry.unstaged.as_ref()
                        }
                        Section::Unstaged => None,
                    }?;
                    Some(Row {
                        id: Id {
                            section,
                            path: entry.path.clone(),
                        },
                        original_path: entry.original_path.clone(),
                        change: change.clone(),
                    })
                })
            })
            .map(|row| match by_id.get(&row.id) {
                Some(previous) if previous.as_ref() == &row => Rc::clone(previous),
                _ => Rc::new(row),
            })
            .collect();
        let valid: HashSet<_> = self.rows.iter().map(|row| &row.id).collect();
        self.pins.retain(|id| valid.contains(id));
        self.bulk.retain(|id| valid.contains(id));
        self.anchor = self.anchor.take().filter(|id| valid.contains(id));
        self.current = self
            .current
            .take()
            .and_then(|id| {
                self.find(&id)
                    .or_else(|| {
                        self.rows
                            .iter()
                            .find(|row| row.id.path == id.path)
                            .map(Rc::as_ref)
                    })
                    .map(|row| row.id.clone())
            })
            .or_else(|| {
                self.rows
                    .iter()
                    .filter(|row| row.change.kind != "deleted")
                    .max_by_key(|row| {
                        (
                            row.change.additions.saturating_add(row.change.deletions),
                            std::cmp::Reverse(&row.id),
                        )
                    })
                    .map(|row| row.id.clone())
            });
        if let Some(id) = &self.current {
            self.pins.insert(id.clone());
        }
    }

    pub fn find(&self, id: &Id) -> Option<&Row> {
        self.rows.iter().map(Rc::as_ref).find(|row| &row.id == id)
    }

    pub fn equivalent(&self, id: &Id) -> Option<&Row> {
        self.find(id).or_else(|| {
            self.rows
                .iter()
                .find(|row| row.id.path == id.path)
                .map(Rc::as_ref)
        })
    }

    pub fn ready(&self) -> bool {
        self.inventory.is_some()
    }

    pub fn count(&self) -> usize {
        self.count
    }

    pub fn section(&self, section: Section) -> impl Iterator<Item = &Row> {
        self.rows
            .iter()
            .filter(move |row| row.id.section == section)
            .map(Rc::as_ref)
    }

    pub fn visible(&self, section: Section) -> impl Iterator<Item = &Row> {
        self.section(section)
            .enumerate()
            .filter_map(move |(i, row)| {
                (i < self.shown[index(section)] || self.pins.contains(&row.id)).then_some(row)
            })
    }

    pub fn show_more(&mut self, section: Section) -> Option<Id> {
        let prefix = self.shown[index(section)];
        let mut hidden = self
            .section(section)
            .enumerate()
            .skip(prefix)
            .filter(|(_, row)| !self.pins.contains(&row.id));
        let (first_index, first) = hidden.next()?;
        let first = first.id.clone();
        self.shown[index(section)] = hidden
            .take(ROW_LIMIT - 1)
            .last()
            .map_or(first_index, |(i, _)| i)
            + 1;
        Some(first)
    }

    pub fn select(&mut self, id: Id, toggle: bool, range: bool) {
        if self.find(&id).is_none() {
            return;
        }
        self.selection_revision = self.selection_revision.wrapping_add(1);
        if range {
            let visible: Vec<_> = SECTIONS
                .into_iter()
                .flat_map(|section| self.visible(section))
                .map(|row| row.id.clone())
                .collect();
            let position = |id: &Id| visible.iter().position(|other| other == id);
            if let (Some(a), Some(b)) = (self.anchor.as_ref().and_then(position), position(&id)) {
                self.bulk
                    .extend(visible[a.min(b)..=a.max(b)].iter().cloned());
            } else {
                self.bulk.insert(id.clone());
            }
        } else if toggle {
            if !self.bulk.remove(&id) {
                self.bulk.insert(id.clone());
            }
            self.anchor = Some(id.clone());
        } else {
            self.current = Some(id.clone());
            self.anchor = Some(id.clone());
            self.bulk.clear();
        }
        self.pins.insert(id);
        self.pins.extend(self.bulk.iter().cloned());
    }

    pub fn finish_bulk(&mut self, revision: u64) {
        if self.selection_revision == revision {
            self.bulk.clear();
            self.anchor = None;
        }
    }

    pub fn keep_visible(&mut self, id: Id) {
        self.pins.insert(id);
    }

    pub fn is_selected(&self, id: &Id) -> bool {
        if self.bulk.is_empty() {
            self.current.as_ref() == Some(id)
        } else {
            self.bulk.contains(id)
        }
    }

    pub fn action_rows(&self, section: Section) -> Vec<&Row> {
        self.section(section)
            .filter(|row| self.is_selected(&row.id))
            .collect()
    }

    pub fn paths(&self, id: &Id) -> Vec<String> {
        if self.find(id).is_none() {
            Vec::new()
        } else if self.bulk.contains(id) {
            self.action_rows(id.section)
                .into_iter()
                .map(|row| row.id.path.clone())
                .collect()
        } else {
            vec![id.path.clone()]
        }
    }

    pub fn focus_order(&self, focus: Option<&str>) -> Option<(Vec<Id>, usize)> {
        let key = focus?;
        let rows: Vec<_> = SECTIONS
            .into_iter()
            .flat_map(|section| self.visible(section))
            .map(|row| row.id.clone())
            .collect();
        let index = rows.iter().position(|id| {
            ["file", "preview", "stage"]
                .into_iter()
                .any(|action| id.action_key(action) == key)
                || format!("{}:trigger", id.action_key("menu")) == key
                || format!("{}:item:stage", id.action_key("menu")) == key
        })?;
        Some((rows, index))
    }

    pub fn focus_after(
        &self,
        (previous, index): (Vec<Id>, usize),
        can_open_file: bool,
    ) -> Option<String> {
        let from = &previous[index];
        let visible = |id: &Id| {
            self.open[self::index(id.section)] && self.visible(id.section).any(|row| &row.id == id)
        };
        if visible(from) {
            return None;
        }
        if !can_open_file {
            return Some(format!("git-section-{}", from.section.key()));
        }
        if let Some(replacement) = self.equivalent(from)
            && visible(&replacement.id)
        {
            return Some(replacement.id.key());
        }
        if let Some(next) = previous[index + 1..]
            .iter()
            .take_while(|id| id.section == from.section)
            .find(|id| visible(id))
        {
            return Some(next.key());
        }
        if self.open[self::index(from.section)]
            && self.visible(from.section).count() < self.section(from.section).count()
        {
            return Some(format!("git-reveal-{}", from.section.key()));
        }
        if let Some(last) = previous[..index]
            .iter()
            .rev()
            .take_while(|id| id.section == from.section)
            .find(|id| visible(id))
        {
            return Some(last.key());
        }
        Some(format!("git-section-{}", from.section.key()))
    }
}
