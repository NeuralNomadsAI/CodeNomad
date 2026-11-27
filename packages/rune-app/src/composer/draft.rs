mod submission;

use super::tokens::{mention_start, whitespace};
use rune::edit::TextEdit;
use std::{ops::Range, sync::Arc};

pub const MAX_FILE: usize = 5 * 1024 * 1024;
pub const MAX_FILES: usize = 10;
pub const MAX_TOTAL: usize = 20 * 1024 * 1024;
pub const MAX_PARTS: usize = 64;
const MAX_PASTE_HISTORY_ENTRIES: usize = 2 * MAX_PARTS;
const MAX_PASTE_HISTORY_BYTES: usize = 4 * super::long_paste::MAX_BYTES;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Attachment {
    Pasted {
        id: u64,
        text: Arc<str>,
    },
    Device {
        name: String,
        mime: String,
        bytes: Arc<[u8]>,
        token: Option<String>,
    },
    Project {
        name: String,
        path: String,
        uri: String,
        directory: bool,
    },
    Path(String),
    Agent(String),
    Skill {
        id: String,
        name: String,
    },
}

impl Attachment {
    fn tokens(&self) -> Vec<String> {
        match self {
            Self::Agent(name) => vec![format!("@{name}")],
            Self::Project {
                path, directory, ..
            } => {
                let mut tokens = vec![format!("@{path}")];
                if *directory && path != "./" {
                    tokens.push(format!("@{}/", path.strip_prefix("./").unwrap_or(path)));
                }
                tokens
            }
            Self::Path(path) => vec![
                format!("@{path}"),
                format!("@{}/", path.strip_prefix("./").unwrap_or(path)),
            ],
            Self::Device { token, .. } => token.iter().cloned().collect(),
            Self::Skill { .. } | Self::Pasted { .. } => vec![],
        }
    }
}

fn token_ranges<'a>(text: &'a str, token: &'a str) -> impl Iterator<Item = Range<usize>> + 'a {
    text.match_indices(token).filter_map(move |(start, found)| {
        let end = start + found.len();
        (mention_start(text, start) && text[end..].chars().next().is_none_or(whitespace))
            .then_some(start..end)
    })
}

#[derive(Clone, Default)]
pub struct Draft {
    pub attachments: Vec<Attachment>,
    pub(crate) literal_spans: Vec<Range<usize>>,
}
impl Draft {
    pub(crate) fn retained_bytes(&self, seen: &mut std::collections::HashSet<usize>) -> usize {
        self.attachments.iter().fold(0usize, |total, attachment| {
            let weight = match attachment {
                Attachment::Pasted { text, .. } => {
                    if seen.insert(Arc::as_ptr(text) as *const u8 as usize) {
                        text.len()
                    } else {
                        0
                    }
                }
                Attachment::Device {
                    name,
                    mime,
                    bytes,
                    token,
                } => {
                    let payload = if seen.insert(Arc::as_ptr(bytes) as *const u8 as usize) {
                        bytes.len()
                    } else {
                        0
                    };
                    payload
                        .saturating_add(name.len())
                        .saturating_add(mime.len())
                        .saturating_add(token.as_ref().map_or(0, String::len))
                }
                Attachment::Project {
                    name, path, uri, ..
                } => name
                    .len()
                    .saturating_add(path.len())
                    .saturating_add(uri.len()),
                Attachment::Path(path) | Attachment::Agent(path) => path.len(),
                Attachment::Skill { id, name } => id.len().saturating_add(name.len()),
            };
            total.saturating_add(weight)
        })
    }

    /// Bytes that dropping this `Draft` will actually release right now (counting shared `Arc`
    /// payloads only when this `Draft` holds every remaining strong reference to them).
    pub(crate) fn sole_owner_bytes(&self) -> usize {
        let mut counts = std::collections::HashMap::<usize, usize>::new();
        for attachment in &self.attachments {
            match attachment {
                Attachment::Pasted { text, .. } => {
                    *counts
                        .entry(Arc::as_ptr(text) as *const u8 as usize)
                        .or_insert(0) += 1;
                }
                Attachment::Device { bytes, .. } => {
                    *counts
                        .entry(Arc::as_ptr(bytes) as *const u8 as usize)
                        .or_insert(0) += 1;
                }
                _ => {}
            }
        }
        let mut credited = std::collections::HashSet::new();
        self.attachments.iter().fold(0usize, |total, attachment| {
            let weight = match attachment {
                Attachment::Pasted { text, .. } => {
                    let ptr = Arc::as_ptr(text) as *const u8 as usize;
                    if credited.insert(ptr)
                        && Arc::strong_count(text) == counts.get(&ptr).copied().unwrap_or(0)
                    {
                        text.len()
                    } else {
                        0
                    }
                }
                Attachment::Device {
                    name,
                    mime,
                    bytes,
                    token,
                } => {
                    let ptr = Arc::as_ptr(bytes) as *const u8 as usize;
                    let payload = if credited.insert(ptr)
                        && Arc::strong_count(bytes) == counts.get(&ptr).copied().unwrap_or(0)
                    {
                        bytes.len()
                    } else {
                        0
                    };
                    payload
                        .saturating_add(name.len())
                        .saturating_add(mime.len())
                        .saturating_add(token.as_ref().map_or(0, String::len))
                }
                Attachment::Project {
                    name, path, uri, ..
                } => name
                    .len()
                    .saturating_add(path.len())
                    .saturating_add(uri.len()),
                Attachment::Path(path) | Attachment::Agent(path) => path.len(),
                Attachment::Skill { id, name } => id.len().saturating_add(name.len()),
            };
            total.saturating_add(weight)
        })
    }

    pub fn remove(&mut self, edit: &mut TextEdit, index: usize) {
        if let Attachment::Pasted { id, .. } = &self.attachments[index] {
            let ranges: Vec<_> = super::long_paste::active_tokens(edit)
                .filter_map(|(range, token)| (token == *id).then_some(range))
                .collect();
            // The (bounded) payload stays available to the field's undo history.
            edit.undo_group(|edit| {
                for range in ranges.into_iter().rev() {
                    edit.set_selection(range.start, range.end);
                    edit.insert("");
                }
            });
            return;
        }
        let item = self.attachments.remove(index);
        for token in item.tokens() {
            let ranges: Vec<_> = token_ranges(&edit.text, &token).collect();
            for range in ranges.into_iter().rev() {
                edit.set_selection(range.start, range.end);
                edit.insert("");
            }
        }
    }

    pub fn delete_mention(&mut self, edit: &mut TextEdit, backwards: bool) -> bool {
        let (start, end) = edit.range();
        let selection = start < end;
        let mut deletion = None;
        self.attachments.retain(|item| {
            let matched = item.tokens().iter().find_map(|token| {
                token_ranges(&edit.text, token).find(|range| {
                    if selection {
                        start <= range.start && range.end <= end
                    } else if backwards {
                        start == range.end
                    } else {
                        start == range.start
                    }
                })
            });
            if let Some(range) = matched {
                deletion = Some(if selection { start..end } else { range });
                false
            } else {
                true
            }
        });
        let Some(range) = deletion else { return false };
        edit.set_selection(range.start, range.end);
        edit.insert("");
        true
    }

    pub fn can_send(&self, edit: &TextEdit) -> bool {
        let (count, bytes) = self.part_usage(Some(edit));
        count <= MAX_PARTS
            && bytes <= super::long_paste::MAX_BYTES
            && (!edit.text.trim_matches(whitespace).is_empty()
                || self.requires_attachment_support())
    }

    pub fn requires_attachment_support(&self) -> bool {
        self.attachments
            .iter()
            .any(|part| !matches!(part, Attachment::Pasted { .. }))
    }

    pub(crate) fn add_unique_inline_usage(
        &self,
        seen: &mut std::collections::HashSet<usize>,
    ) -> (usize, usize) {
        self.attachments
            .iter()
            .fold((0, 0), |(count, total), item| match item {
                Attachment::Device { bytes, .. } => {
                    let key = Arc::as_ptr(bytes) as *const u8 as usize;
                    if bytes.is_empty() || seen.insert(key) {
                        (count + 1, total.saturating_add(bytes.len()))
                    } else {
                        (count, total)
                    }
                }
                _ => (count, total),
            })
    }

    pub fn inline_usage(&self) -> (usize, usize) {
        self.attachments
            .iter()
            .fold((0, 0), |(count, total), item| match item {
                Attachment::Device { bytes, .. } => (count + 1, total + bytes.len()),
                _ => (count, total),
            })
    }

    pub fn attach(&mut self, item: Attachment) -> bool {
        self.attach_bounded(None, item)
    }

    pub fn attach_for(&mut self, edit: &TextEdit, item: Attachment) -> bool {
        self.attach_bounded(Some(edit), item)
    }

    pub fn active_count(&self, edit: &TextEdit) -> usize {
        self.part_usage(Some(edit)).0
    }

    fn part_usage(&self, edit: Option<&TextEdit>) -> (usize, usize) {
        let active = edit
            .filter(|_| {
                self.attachments
                    .iter()
                    .any(|part| matches!(part, Attachment::Pasted { .. }))
            })
            .map(|edit| {
                super::long_paste::active_tokens(edit)
                    .map(|(_, id)| id)
                    .collect::<std::collections::BTreeSet<_>>()
            });
        self.attachments
            .iter()
            .fold((0, 0), |(count, bytes), part| match part {
                Attachment::Pasted { id, text }
                    if active.as_ref().is_none_or(|ids| ids.contains(id)) =>
                {
                    (count + 1, bytes + text.len())
                }
                Attachment::Pasted { .. } => (count, bytes),
                _ => (count + 1, bytes),
            })
    }

    fn attach_bounded(&mut self, edit: Option<&TextEdit>, item: Attachment) -> bool {
        let (count, active_paste_bytes) = self.part_usage(edit);
        if count >= MAX_PARTS {
            return false;
        }
        if let Attachment::Pasted { id, text } = &item {
            let mut history_bytes = text.len();
            let mut history_entries = 1;
            for part in &self.attachments {
                if let Attachment::Pasted { id: previous, text } = part {
                    if id == previous {
                        return false;
                    }
                    history_bytes += text.len();
                    history_entries += 1;
                }
            }
            if text.len() + active_paste_bytes > super::long_paste::MAX_BYTES
                || history_bytes > MAX_PASTE_HISTORY_BYTES
                || history_entries > MAX_PASTE_HISTORY_ENTRIES
            {
                return false;
            }
        }
        if let Attachment::Device { bytes, .. } = &item {
            let (count, total) = self.inline_usage();
            if bytes.len() > MAX_FILE || count >= MAX_FILES || total + bytes.len() > MAX_TOTAL {
                return false;
            }
        } else if self
            .attachments
            .iter()
            .any(|existing| match (existing, &item) {
                (
                    Attachment::Project {
                        path: a,
                        directory: da,
                        ..
                    },
                    Attachment::Project {
                        path: b,
                        directory: db,
                        ..
                    },
                ) => a == b && da == db,
                (Attachment::Skill { id: a, .. }, Attachment::Skill { id: b, .. }) => a == b,
                _ => existing == &item,
            })
        {
            return false;
        }
        self.attachments.push(item);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codenomad_client::{content::Part, prompt::Delivery};

    #[test]
    fn normalizing_a_selected_path_keeps_an_internal_at_sign() {
        let mut draft = Draft::default();
        draft.attach(Attachment::Path("./rapport@.txt".into()));
        assert_eq!(
            draft.resolve_text("@./rapport@.txt").as_deref(),
            Some("./rapport@.txt")
        );
    }

    #[test]
    fn separates_project_references_device_bytes_agents_and_skills() {
        let mut draft = Draft::default();
        let device = Attachment::Device {
            name: "device.txt".into(),
            mime: "text/plain".into(),
            bytes: Arc::from(&b"bytes"[..]),
            token: None,
        };
        let project = Attachment::Project {
            name: "a b#%.txt".into(),
            path: "./a b#%.txt".into(),
            uri: "file:///project/a%20b%23%25.txt".into(),
            directory: false,
        };
        let skill = Attachment::Skill {
            id: "opaque/skill".into(),
            name: "Review".into(),
        };
        for item in [
            device.clone(),
            project.clone(),
            skill.clone(),
            Attachment::Path("./doc".into()),
            Attachment::Agent("reviewer".into()),
        ] {
            assert!(draft.attach(item));
        }
        assert!(!draft.attach(project));
        assert!(!draft.attach(skill));
        assert!(draft.attach(device));
        let (prompt, parts) = draft
            .prepare(
                &TextEdit::new("  🦀 @reviewer @./a b#%.txt @./doc @..  "),
                "msg_test",
                Delivery::Queue,
            )
            .unwrap();
        assert_eq!(prompt.text, "🦀 @reviewer ./a b#%.txt ./doc @..");
        assert_eq!(prompt.resume, Some(false));
        assert_eq!(prompt.files.len(), 3);
        assert_eq!(prompt.files[0].uri, "data:text/plain;base64,Ynl0ZXM=");
        assert_eq!(prompt.files[1].uri, "file:///project/a%20b%23%25.txt");
        assert_eq!(prompt.files[2], prompt.files[0]);
        assert_eq!(prompt.agents[0].mention.as_ref().unwrap().start, 3);
        assert_eq!(prompt.skills[0].id, "opaque/skill");
        assert!(matches!(
            &parts[..],
            [Part::Skill(_), Part::File(_), Part::File(_), Part::File(_)]
        ));
    }

    #[test]
    fn rejected_bytes_do_not_reserve_slots_and_reference_files_cost_no_inline_budget() {
        let mut draft = Draft::default();
        let device = |bytes| Attachment::Device {
            name: "same.bin".into(),
            mime: "application/octet-stream".into(),
            bytes,
            token: None,
        };
        let full = device(Arc::from(vec![0; MAX_FILE]));
        let small = device(Arc::from([1]));
        assert!(!draft.attach(device(Arc::from(vec![0; MAX_FILE + 1]))));
        for _ in 0..4 {
            assert!(draft.attach(full.clone()));
        }
        assert!(!draft.attach(small.clone()));
        assert!(draft.attach(Attachment::Project {
            name: "doc".into(),
            path: "./doc".into(),
            uri: "file:///project/doc".into(),
            directory: false
        }));
        assert_eq!(draft.inline_usage(), (4, MAX_TOTAL));
        draft.attachments.clear();
        for _ in 0..MAX_FILES {
            assert!(draft.attach(small.clone()));
        }
        assert!(!draft.attach(small));
    }
}
