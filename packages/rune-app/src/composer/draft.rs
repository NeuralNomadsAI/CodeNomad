use super::tokens::{mention, whitespace};
use codenomad_client::{
    content::{self, Part},
    prompt::{self, Delivery, Prompt},
};
use rune::edit::TextEdit;
use std::sync::Arc;

pub const MAX_FILE: usize = 5 * 1024 * 1024;
pub const MAX_FILES: usize = 10;
pub const MAX_TOTAL: usize = 20 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Attachment {
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

#[derive(Default)]
pub struct Draft {
    pub attachments: Vec<Attachment>,
}
impl Draft {
    pub fn remove(&mut self, edit: &mut TextEdit, index: usize) {
        let item = self.attachments.remove(index);
        let tokens = match item {
            Attachment::Agent(name) => vec![format!("@{name}")],
            Attachment::Project {
                path, directory, ..
            } => {
                let mut tokens = vec![format!("@{path}")];
                if directory && path != "./" {
                    tokens.push(format!("@{}/", path.strip_prefix("./").unwrap_or(&path)));
                }
                tokens
            }
            Attachment::Path(path) => vec![
                format!("@{path}"),
                format!("@{}/", path.strip_prefix("./").unwrap_or(&path)),
            ],
            Attachment::Device { token, .. } => token.into_iter().collect(),
            Attachment::Skill { .. } => vec![],
        };
        for token in tokens {
            let ranges: Vec<_> = edit
                .text
                .match_indices(&token)
                .filter_map(|(start, found)| {
                    let end = start + found.len();
                    edit.text[end..]
                        .chars()
                        .next()
                        .is_none_or(whitespace)
                        .then_some((start, end))
                })
                .collect();
            for (start, end) in ranges.into_iter().rev() {
                edit.set_selection(start, end);
                edit.insert("");
            }
        }
    }

    pub fn can_send(&self, edit: &TextEdit) -> bool {
        !edit.text.trim_matches(whitespace).is_empty() || !self.attachments.is_empty()
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

    pub fn resolve_text(&self, text: &str) -> String {
        let mut text = resolve_relative_paths(text.trim_matches(whitespace));
        for path in self.attachments.iter().filter_map(|item| match item {
            Attachment::Project { path, .. } | Attachment::Path(path) => Some(path),
            _ => None,
        }) {
            let path = path.strip_prefix("./").unwrap_or(path);
            if !path.is_empty() && path != "." {
                text = text.replacen(&format!("@{path}"), &format!("./{path}"), 1);
                text = text.replacen(&format!("@{path}/"), &format!("./{path}/"), 1);
            }
        }
        text
    }

    pub fn prepare(&self, text: &str, id: &str, delivery: Delivery) -> (Prompt, Vec<Part>) {
        let mut parts = Vec::new();
        let mut prompt = Prompt {
            id: Some(id.into()),
            text: self.resolve_text(text),
            resume: (delivery == Delivery::Queue).then_some(false),
            delivery: Some(delivery),
            ..Prompt::default()
        };
        for item in &self.attachments {
            match item {
                Attachment::Agent(name) => {
                    prompt.agents.push(prompt::Agent {
                        name: name.clone(),
                        mention: mention(&prompt.text, &format!("@{name}")),
                    });
                }
                Attachment::Skill { id: skill_id, name } => {
                    parts.push(Part::Skill(content::Skill {
                        id: format!("{id}-skill-{}", prompt.skills.len()),
                        skill_id: skill_id.clone(),
                        name: name.clone(),
                    }));
                    prompt.skills.push(prompt::Skill {
                        id: skill_id.clone(),
                        mention: None,
                    });
                }
                _ => {}
            }
        }
        for item in &self.attachments {
            let (name, uri, mime) = match item {
                Attachment::Device {
                    name, mime, bytes, ..
                } => (name, prompt::inline_uri(mime, bytes), mime.as_str()),
                Attachment::Project {
                    name,
                    uri,
                    directory,
                    ..
                } => (
                    name,
                    uri.clone(),
                    if *directory {
                        "inode/directory"
                    } else {
                        "text/plain"
                    },
                ),
                _ => continue,
            };
            parts.push(Part::File(content::File {
                id: format!("{id}-file-{}", prompt.files.len()),
                reference: None,
                mime: mime.into(),
                name: Some(name.clone()),
            }));
            prompt.files.push(prompt::File {
                uri,
                name: Some(name.clone()),
                ..prompt::File::default()
            });
        }
        (prompt, parts)
    }
}

fn resolve_relative_paths(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((before, after)) = rest.split_once("@.") {
        result.push_str(before);
        match after.as_bytes().first() {
            Some(b'.') => result.push_str("@."),
            Some(b'/') => result.push('.'),
            _ => result.push_str("./"),
        }
        rest = after;
    }
    result.push_str(rest);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let (prompt, parts) = draft.prepare(
            "  🦀 @reviewer @./a b#%.txt @./doc @..  ",
            "msg_test",
            Delivery::Queue,
        );
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
