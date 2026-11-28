use super::{Attachment, Draft};
use crate::composer::{
    literal, long_paste,
    tokens::{mention, mention_start, whitespace},
};
use codenomad_client::{
    content::{self, Part},
    prompt::{self, Delivery, Prompt},
};
use rune::edit::TextEdit;
use std::ops::Range;

impl Draft {
    #[cfg(test)]
    pub fn resolve_text(&self, text: &str) -> Option<String> {
        self.project(text, std::iter::empty()).map(|(text, _)| text)
    }

    pub fn resolve_args(&self, edit: &TextEdit, args: &str) -> Option<String> {
        if args.is_empty() {
            return Some(String::new());
        }
        // Args is a slice of the current editor, after the command name.
        let offset = args
            .as_ptr()
            .addr()
            .checked_sub(edit.text.as_ptr().addr())?;
        let end = offset + args.len();
        let literal = literal::ranges(edit).filter_map(|span| {
            let start = span.start.max(offset);
            let stop = span.end.min(end);
            (start < stop).then(|| start - offset..stop - offset)
        });
        self.project(args, literal).map(|(text, _)| text)
    }

    pub fn resolve_shell(&self, edit: &TextEdit) -> Option<String> {
        let max_bytes = codenomad_client::prompt_shell::MAX_SHELL_COMMAND_BYTES;
        let mut result = String::new();
        let mut cursor = 0;
        for literal in
            literal::ranges(edit).chain(std::iter::once(edit.text.len()..edit.text.len()))
        {
            let inline = edit.text.get(cursor..literal.start)?;
            let inline = if cursor == 0 {
                inline.trim_start_matches(whitespace)
            } else {
                inline
            };
            let inline = if literal.start == edit.text.len() {
                inline.trim_end_matches(whitespace)
            } else {
                inline
            };
            let remaining = max_bytes.checked_sub(result.len())?;
            let (inline, _) = long_paste::expand_bounded(inline, &self.attachments, remaining)?;
            result.push_str(&inline);
            if !literal.is_empty() {
                let literal_text = edit.text.get(literal.clone())?;
                if result.len().saturating_add(literal_text.len()) > max_bytes {
                    return None;
                }
                result.push_str(literal_text);
            }
            cursor = literal.end;
        }
        (!result.is_empty()).then_some(result)
    }

    fn project(
        &self,
        text: &str,
        literal: impl Iterator<Item = Range<usize>>,
    ) -> Option<(String, Vec<Range<usize>>)> {
        let mut result = String::new();
        let mut spans = Vec::new();
        let mut cursor = 0;
        for literal in literal.chain(std::iter::once(text.len()..text.len())) {
            let inline = text.get(cursor..literal.start)?;
            let inline = if cursor == 0 {
                inline.trim_start_matches(whitespace)
            } else {
                inline
            };
            let inline = if literal.start == text.len() {
                inline.trim_end_matches(whitespace)
            } else {
                inline
            };
            let (inline, expanded) =
                long_paste::expand(self.resolve_paths(inline), &self.attachments)?;
            spans.extend(
                expanded
                    .into_iter()
                    .map(|span| result.len() + span.start..result.len() + span.end),
            );
            result.push_str(&inline);
            if !literal.is_empty() {
                spans.push(result.len()..result.len() + literal.len());
                result.push_str(text.get(literal.clone())?);
            }
            cursor = literal.end;
            if result.len() > prompt::MAX_BODY_BYTES {
                return None;
            }
        }
        Some((result, spans))
    }

    fn resolve_paths(&self, text: &str) -> String {
        let mut text = resolve_relative_paths(text);
        for path in self.attachments.iter().filter_map(|item| match item {
            Attachment::Project { path, .. } | Attachment::Path(path) => Some(path),
            _ => None,
        }) {
            let path = path
                .strip_prefix("./")
                .unwrap_or(path)
                .trim_end_matches('/');
            if !path.is_empty() && path != "." {
                let token = format!("@{path}");
                let mut resolved = String::new();
                let mut offset = 0;
                for (start, matched) in text.match_indices(&token) {
                    let end = start + matched.len();
                    if mention_start(&text, start)
                        && text[end..]
                            .chars()
                            .next()
                            .is_none_or(|next| next == '/' || whitespace(next))
                    {
                        resolved.push_str(&text[offset..start]);
                        resolved.push_str("./");
                        resolved.push_str(path);
                        offset = end;
                    }
                }
                if offset != 0 {
                    resolved.push_str(&text[offset..]);
                    text = resolved;
                }
            }
        }
        text
    }

    pub fn prepare(
        &self,
        edit: &TextEdit,
        id: &str,
        delivery: Delivery,
    ) -> Option<(Prompt, Vec<Part>)> {
        let (text, pasted) = self.project(&edit.text, literal::ranges(edit))?;
        let mut parts = Vec::new();
        let mut prompt = Prompt {
            id: Some(id.into()),
            text,
            resume: (delivery == Delivery::Queue).then_some(false),
            delivery: Some(delivery),
            ..Prompt::default()
        };
        for item in &self.attachments {
            match item {
                Attachment::Agent(name) => {
                    prompt.agents.push(prompt::Agent {
                        name: name.clone(),
                        mention: mention(&prompt.text, &format!("@{name}"), &pasted),
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
                picture: None,
                mime: mime.into(),
                name: Some(name.clone()),
            }));
            prompt.files.push(prompt::File {
                uri,
                name: Some(name.clone()),
                ..prompt::File::default()
            });
        }
        Some((prompt, parts))
    }
}

fn resolve_relative_paths(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut prefix = 0;
    for (start, _) in text.match_indices("@.") {
        if mention_start(text, start) && text.as_bytes().get(start + 2) != Some(&b'.') {
            result.push_str(&text[prefix..start]);
            result.push_str(if text.as_bytes().get(start + 2) == Some(&b'/') {
                "."
            } else {
                "./"
            });
            prefix = start + 2;
        }
    }
    result.push_str(&text[prefix..]);
    result
}
