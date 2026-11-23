use crate::{State, content::Part, history::Row};
use codenomad_client::search::{Hit, Kind};
use rune_theme_codenomad::timeline::search::{Query, terms};

#[derive(Clone, Hash)]
pub(crate) struct SearchHit {
    pub message: String,
    terms: Vec<String>,
    ranked: bool,
    part: Option<(Kind, usize)>,
    pub restore_pending: bool,
}

impl SearchHit {
    pub(crate) fn new(hit: &Hit, text: &str, ranked: bool) -> Self {
        Self {
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

    // The broker indexes the native array, including unrendered elements.
    pub(crate) fn block(&self, row: &Row, steps: usize) -> Option<(String, usize)> {
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
