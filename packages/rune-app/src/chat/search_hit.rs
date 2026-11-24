use crate::{State, content::Part, history::Row};
use codenomad_client::search::{Hit, Kind};
use rune_theme_codenomad::timeline::search::{Query, terms};

pub(crate) enum Landing {
    Visible(String, usize),
    Filtered,
    Missing,
}

use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

static NEXT_SEARCH_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Hash)]
pub(crate) struct SearchHit {
    pub id: u64,
    pub message: String,
    terms: Vec<String>,
    ranked: bool,
    part: Option<(Kind, usize)>,
    pub restore_pending: bool,
}

impl SearchHit {
    pub(crate) fn new(hit: &Hit, text: &str, ranked: bool) -> Self {
        Self {
            id: NEXT_SEARCH_ID.fetch_add(1, Relaxed),
            message: hit.message.clone(),
            terms: if ranked {
                terms(text)
            } else {
                vec![text.into()]
            },
            ranked,
            part: usize::try_from(hit.part)
                .ok()
                .map(|index| (hit.kind, index)),
            restore_pending: false,
        }
    }

    pub(super) fn query(&self, part: Option<(Kind, usize)>) -> Query<'_> {
        Query {
            terms: &self.terms,
            ranked: self.ranked,
            active: part.is_some() && self.part == part,
            claimed: None,
        }
    }

    pub(super) fn text_query(&self, part_index: Option<usize>) -> Query<'_> {
        let active = match self.part {
            None => true,
            Some((Kind::Text, target)) => part_index.is_none_or(|idx| idx == target),
            Some(_) => false,
        };
        Query {
            terms: &self.terms,
            ranked: self.ranked,
            active,
            claimed: None,
        }
    }

    pub(crate) fn landing(&self, s: &State, row: &Row, steps: usize) -> Landing {
        if !super::anchors::context_visible(s, &row.role) {
            return Landing::Filtered;
        }
        if self.part.is_none_or(|(kind, _)| kind == Kind::Text) {
            if let Some((Kind::Text, target)) = self.part
                && row.role == "assistant"
                && !row.parts.is_empty()
            {
                let mut ordinal = 0usize;
                for (i, part) in row.parts.iter().enumerate() {
                    if let Part::Text(body) = part {
                        let frag = ordinal;
                        ordinal += 1;
                        if body.part_index == Some(target) {
                            if body.text.trim().is_empty() {
                                return Landing::Missing;
                            }
                            let (head, tail) =
                                super::transcript::part_window(row.parts.len(), steps);
                            let step = super::transcript::PART_LIMIT;
                            let reveal = if (head..tail).contains(&i) {
                                (i - step / 2) / step + 1
                            } else {
                                0
                            };
                            return Landing::Visible(format!("fragment-{}:{frag}", row.id), reveal);
                        }
                    }
                }
            }
            return Landing::Visible(
                super::anchors::context(row).map_or_else(|| row.id.clone(), |(key, _)| key),
                0,
            );
        }
        let Some((index, key, steps)) = self.technical_block(row, steps) else {
            return Landing::Missing;
        };
        if !super::anchors::part_visible(s, row, index) {
            return Landing::Filtered;
        }
        if let Part::Tool(tool) = &row.parts[index]
            && super::tools::match_hidden_by_inputs(s, &row.id, tool, self.query(self.part))
        {
            return Landing::Filtered;
        }
        Landing::Visible(key, steps)
    }

    #[cfg(test)]
    pub(crate) fn block(&self, row: &Row, steps: usize) -> Option<(String, usize)> {
        self.technical_block(row, steps)
            .map(|(_, key, steps)| (key, steps))
    }

    // The broker indexes the native array, including unrendered elements.
    fn technical_block(&self, row: &Row, steps: usize) -> Option<(usize, String, usize)> {
        let (kind, index) = self.part?;
        let (i, key) = row.parts.iter().enumerate().find_map(|(i, p)| match p {
            Part::Tool(tool) if kind == Kind::Tool && tool.part_index == Some(index) => {
                Some((i, super::tools::tool_key(&row.id, &tool.id)))
            }
            Part::Reasoning(part)
                if kind == Kind::Reasoning && part.part_index == Some(index) && part.visible() =>
            {
                Some((i, super::reasoning::block_key(&row.id, part.ordinal)))
            }
            _ => None,
        })?;
        let (head, tail) = super::transcript::part_window(row.parts.len(), steps);
        let step = super::transcript::PART_LIMIT;
        Some((
            i,
            key,
            if (head..tail).contains(&i) {
                (i - step / 2) / step + 1
            } else {
                0
            },
        ))
    }
}

pub(super) fn query<'a>(
    s: &'a State,
    message: &str,
    kind: Kind,
    index: Option<usize>,
) -> Option<Query<'a>> {
    s.transcript_display
        .search_highlight
        .as_ref()
        .filter(|hit| hit.message == message)
        .map(|hit| hit.query(index.map(|part| (kind, part))))
}
