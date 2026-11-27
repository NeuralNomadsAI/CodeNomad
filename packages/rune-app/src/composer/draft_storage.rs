use super::draft::{Attachment, Draft, MAX_PARTS};
use serde_json::{Value, json};
use std::ops::Range;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct SavedParts {
    complete: bool,
    parts: Vec<Part>,
    literal_spans: Vec<Range<usize>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Part {
    Pasted {
        id: u64,
        text: Arc<str>,
    },
    Project {
        name: String,
        path: String,
        uri: String,
        directory: bool,
    },
    Path {
        path: String,
    },
    Agent {
        name: String,
    },
    Skill {
        id: String,
        name: String,
    },
}

impl SavedParts {
    pub(crate) fn missing() -> Self {
        Self {
            complete: false,
            parts: Vec::new(),
            literal_spans: Vec::new(),
        }
    }

    pub(crate) fn mark_incomplete(&mut self) {
        self.complete = false;
    }

    pub(crate) fn fingerprint(&self) -> (usize, u64) {
        use std::hash::{DefaultHasher, Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        self.hash(&mut hasher);
        (self.parts.len(), hasher.finish())
    }
    pub(crate) fn encode(&self) -> Value {
        let parts: Vec<_> = self.parts.iter().map(|part| match part {
            Part::Project { name, path, uri, directory } => {
                json!({"type":"project","name":name,"path":path,"uri":uri,"directory":directory})
            }
            Part::Path { path } => json!({"type":"path","path":path}),
            Part::Agent { name } => json!({"type":"agent","name":name}),
            Part::Skill { id, name } => json!({"type":"skill","id":id,"name":name}),
            Part::Pasted { id, text } => json!({"type":"pasted","id":id.to_string(),"text":text.as_ref()}),
        }).collect();
        let mut value = json!({"complete":self.complete,"parts":parts});
        if !self.literal_spans.is_empty() {
            value["literalSpans"] = json!(
                self.literal_spans
                    .iter()
                    .map(|span| [span.start, span.end])
                    .collect::<Vec<_>>()
            );
        }
        value
    }

    pub(crate) fn decode(raw: &Value) -> Option<Self> {
        let literal = raw.get("literalSpans");
        if raw.as_object()?.len() != 2 + usize::from(literal.is_some()) {
            return None;
        }
        let complete = raw["complete"].as_bool()?;
        let rows = raw["parts"]
            .as_array()
            .filter(|rows| rows.len() <= MAX_PARTS)?;
        let parts = rows
            .iter()
            .map(|row| {
                let count = row.as_object()?.len();
                let field = |key| row.get(key)?.as_str().map(str::to_owned);
                Some(match (row["type"].as_str()?, count) {
                    ("project", 5) => Part::Project {
                        name: field("name")?,
                        path: field("path")?,
                        uri: field("uri")?,
                        directory: row["directory"].as_bool()?,
                    },
                    ("path", 2) => Part::Path {
                        path: field("path")?,
                    },
                    ("agent", 2) => Part::Agent {
                        name: field("name")?,
                    },
                    ("skill", 3) => Part::Skill {
                        id: field("id")?,
                        name: field("name")?,
                    },
                    ("pasted", 3) => Part::Pasted {
                        id: row["id"].as_str()?.parse().ok()?,
                        text: Arc::from(row["text"].as_str()?),
                    },
                    _ => return None,
                })
            })
            .collect::<Option<_>>()?;
        let literal_spans = if let Some(raw) = literal {
            raw.as_array()?
                .iter()
                .map(|span| {
                    let [a, b] = span.as_array()?.as_slice() else {
                        return None;
                    };
                    Some(usize::try_from(a.as_u64()?).ok()?..usize::try_from(b.as_u64()?).ok()?)
                })
                .collect::<Option<_>>()?
        } else {
            Vec::new()
        };
        Some(Self {
            complete,
            parts,
            literal_spans,
        })
    }

    pub(crate) fn capture(
        draft: &Draft,
        missing: bool,
        edit: &rune::edit::TextEdit,
    ) -> Option<Self> {
        let pasted = super::long_paste::active_tokens(edit)
            .map(|(_, id)| id)
            .collect::<std::collections::BTreeSet<_>>();
        let mut saved = Self {
            complete: !missing,
            parts: Vec::new(),
            literal_spans: super::literal::ranges(edit).collect(),
        };
        for part in &draft.attachments {
            saved.parts.push(match part {
                Attachment::Project {
                    name,
                    path,
                    uri,
                    directory,
                } => Part::Project {
                    name: name.clone(),
                    path: path.clone(),
                    uri: uri.clone(),
                    directory: *directory,
                },
                Attachment::Path(path) => Part::Path { path: path.clone() },
                Attachment::Agent(name) => Part::Agent { name: name.clone() },
                Attachment::Skill { id, name } => Part::Skill {
                    id: id.clone(),
                    name: name.clone(),
                },
                Attachment::Pasted { id, text } if pasted.contains(id) => Part::Pasted {
                    id: *id,
                    text: text.clone(),
                },
                Attachment::Pasted { .. } => continue,
                Attachment::Device { .. } => {
                    saved.complete = false;
                    continue;
                }
            });
        }
        (!saved.complete || !saved.parts.is_empty() || !saved.literal_spans.is_empty())
            .then_some(saved)
    }

    pub(crate) fn restore(&self) -> (Draft, bool) {
        let mut draft = Draft {
            literal_spans: self.literal_spans.clone(),
            ..Default::default()
        };
        for part in self.parts.clone() {
            draft.attach(match part {
                Part::Project {
                    name,
                    path,
                    uri,
                    directory,
                } => Attachment::Project {
                    name,
                    path,
                    uri,
                    directory,
                },
                Part::Path { path } => Attachment::Path(path),
                Part::Agent { name } => Attachment::Agent(name),
                Part::Skill { id, name } => Attachment::Skill { id, name },
                Part::Pasted { id, text } => Attachment::Pasted { id, text },
            });
        }
        (draft, !self.complete)
    }

    pub(crate) fn discard_pasted_text(&mut self) -> bool {
        let before = self.parts.len();
        self.parts
            .retain(|part| !matches!(part, Part::Pasted { .. }));
        if self.parts.len() == before {
            return false;
        }
        self.complete = false;
        true
    }

    pub(crate) fn valid(&self) -> bool {
        let label =
            |value: &str| !value.trim().is_empty() && value.len() <= 4096 && !value.contains('\0');
        let relative = |path: &str| {
            path == "./"
                || path.strip_prefix("./").is_some_and(|tail| {
                    label(tail)
                        && tail
                            .split('/')
                            .all(|segment| !matches!(segment, "" | "." | ".."))
                })
        };
        let mut pasted = std::collections::BTreeSet::new();
        let mut pasted_bytes = 0;
        self.parts.len() <= MAX_PARTS
            && (!self.complete || !self.parts.is_empty() || !self.literal_spans.is_empty())
            && self
                .literal_spans
                .iter()
                .all(|span| span.start < span.end && span.end <= 128 * 1024)
            && self
                .literal_spans
                .windows(2)
                .all(|pair| pair[0].end <= pair[1].start)
            && self.parts.iter().all(|part| match part {
                Part::Project {
                    name, path, uri, ..
                } => {
                    label(name)
                        && relative(path)
                        && uri.len() <= 16_384
                        && uri.starts_with("file:///")
                        && !uri.contains('\0')
                }
                Part::Path { path } => relative(path),
                Part::Agent { name } => label(name),
                Part::Skill { id, name } => label(id) && label(name),
                Part::Pasted { id, text } => {
                    pasted_bytes += text.len();
                    *id != 0
                        && !text.is_empty()
                        && pasted.insert(*id)
                        && pasted_bytes <= super::long_paste::MAX_BYTES
                }
            })
    }
}
