use super::{actions::Display, reasoning, tools};
use crate::{
    State,
    content::{Part, Tool},
    history::Row,
    screen,
    settings::{TranscriptRow, transcript_mode},
    strings::locale,
};
use codenomad_client::search::Kind as SearchKind;
use rune::{El, col};
use rune_theme_codenomad::{Space, catalogue, layout::Layout, transcript};
use std::{
    collections::{HashMap, HashSet},
    rc::Rc,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Exploration,
    Shell,
    Reasoning,
}

fn kind(tool: &Tool) -> Option<Kind> {
    match tool.name.as_str() {
        "read" | "glob" | "grep" => Some(Kind::Exploration),
        "bash" | "shell" => Some(Kind::Shell),
        _ => None,
    }
}

struct Summary {
    key: String,
    keys: Vec<String>,
    message: String,
    kind: Kind,
    count: usize,
    reads: usize,
    duration_ms: u64,
    title: Option<String>,
    completed: bool,
    search_hit: bool,
}

struct Run {
    summary: Summary,
    chunks: Vec<(usize, std::ops::Range<usize>)>,
}

pub(super) struct Chunk {
    summary: Rc<Summary>,
    pub(super) end: usize,
    first: bool,
}

#[derive(Default)]
pub(super) struct Groups {
    chunks: HashMap<(usize, usize), Chunk>,
    waiting: HashMap<String, HashSet<String>>,
}

impl Groups {
    pub(super) fn project(s: &State) -> Self {
        Self::project_with_steps(
            s,
            s.transcript_display.messages.visible(&s.messages),
            !s.history_detached,
            None,
        )
    }

    pub(super) fn project_with_steps(
        s: &State,
        rows: &[Row],
        at_tail: bool,
        override_steps: Option<(usize, usize)>,
    ) -> Self {
        let mut index = Self {
            waiting: waiting(s, if at_tail { rows } else { &[] }),
            ..Self::default()
        };
        let group_tools = transcript_mode(s, TranscriptRow::Groups) != "hidden";
        let show_thinking = super::anchors::reasoning_visible(s);
        let mut run: Option<Run> = None;
        for (row, message) in rows.iter().enumerate() {
            if matches!(message.parts.as_slice(), [Part::SubagentReport(_)])
                || !super::anchors::context_visible(s, &message.role)
            {
                continue;
            }
            if message.role != "assistant"
                || message.parts.is_empty() && !message.body.trim().is_empty()
            {
                index.finish(run.take(), true);
                continue;
            }
            if message.parts.is_empty() {
                continue;
            }
            let steps = override_steps
                .filter(|(target, _)| *target == row)
                .map_or_else(
                    || {
                        s.transcript_display
                            .steps(&format!("parts-gap-{}", message.id))
                    },
                    |(_, steps)| steps,
                );
            let (head, tail) = super::transcript::part_window(message.parts.len(), steps);
            if !message.parts.iter().any(|part| match part {
                Part::Text(text) => !text.text.trim().is_empty(),
                Part::Reasoning(fragment) => show_thinking && fragment.visible(),
                Part::Tool(tool) => {
                    index.awaiting(&message.id, &tool.id) || tools::visible(s, &message.id, tool)
                }
                Part::SubagentReport(_) => false,
                _ => true,
            }) {
                if head < tail {
                    index.finish(run.take(), true);
                }
                continue;
            }
            for (part, content) in message.parts.iter().enumerate() {
                if part >= head && part < tail {
                    index.finish(run.take(), true);
                    continue;
                }
                match content {
                    Part::Text(text) if text.text.trim().is_empty() => (),
                    Part::Reasoning(fragment) if !fragment.visible() => (),
                    Part::Reasoning(_) if !show_thinking => index.finish(run.take(), true),
                    Part::Reasoning(fragment) => {
                        if run
                            .as_ref()
                            .is_some_and(|run| run.summary.kind != Kind::Reasoning)
                        {
                            index.finish(run.take(), true);
                        }
                        let member = reasoning::block_key(&message.id, fragment.ordinal);
                        let run = run.get_or_insert_with(|| Run {
                            summary: Summary {
                                key: member.clone(),
                                keys: Vec::new(),
                                message: message.id.clone(),
                                kind: Kind::Reasoning,
                                count: 0,
                                reads: 0,
                                duration_ms: 0,
                                title: None,
                                completed: false,
                                search_hit: false,
                            },
                            chunks: Vec::new(),
                        });
                        run.summary.keys.push(member);
                        run.summary.count += 1;
                        run.summary.duration_ms = run
                            .summary
                            .duration_ms
                            .saturating_add(reasoning::duration_ms(fragment));
                        run.summary.title = reasoning::extract_title(&fragment.text);
                        run.summary.completed = message.completed;
                        run.summary.search_hit |= super::search_hit::query(
                            s,
                            &message.id,
                            SearchKind::Reasoning,
                            fragment.part_index,
                        )
                        .is_some_and(|q| q.active);
                        match run.chunks.last_mut() {
                            Some((last, range)) if *last == row => range.end = part + 1,
                            _ => run.chunks.push((row, part..part + 1)),
                        }
                    }
                    Part::Tool(tool) if index.awaiting(&message.id, &tool.id) => {
                        index.finish(run.take(), true)
                    }
                    Part::Tool(tool) if !tools::visible(s, &message.id, tool) => (),
                    Part::Tool(tool) if group_tools && let Some(kind) = kind(tool) => {
                        if run.as_ref().is_some_and(|run| run.summary.kind != kind) {
                            index.finish(run.take(), true);
                        }
                        let member = format!("group-{}", tools::tool_key(&message.id, &tool.id));
                        let run = run.get_or_insert_with(|| Run {
                            summary: Summary {
                                key: member.clone(),
                                keys: Vec::new(),
                                message: message.id.clone(),
                                kind,
                                count: 0,
                                reads: 0,
                                duration_ms: 0,
                                title: None,
                                completed: false,
                                search_hit: false,
                            },
                            chunks: Vec::new(),
                        });
                        run.summary.keys.push(member);
                        run.summary.count += 1;
                        run.summary.reads += usize::from(tool.name == "read");
                        run.summary.completed = message.completed;
                        run.summary.search_hit |= super::search_hit::query(
                            s,
                            &message.id,
                            SearchKind::Tool,
                            tool.part_index,
                        )
                        .is_some_and(|q| q.active);
                        match run.chunks.last_mut() {
                            Some((last, range)) if *last == row => range.end = part + 1,
                            _ => run.chunks.push((row, part..part + 1)),
                        }
                    }
                    _ => index.finish(run.take(), true),
                }
            }
        }
        index.finish(run, false);
        index
    }

    fn finish(&mut self, run: Option<Run>, closed: bool) {
        let Some(Run {
            mut summary,
            chunks,
        }) = run.filter(|run| match run.summary.kind {
            Kind::Reasoning => run.summary.count > 0,
            Kind::Exploration | Kind::Shell => run.summary.count > 1,
        })
        else {
            return;
        };
        summary.completed |= closed;
        let summary = Rc::new(summary);
        for (i, (row, range)) in chunks.into_iter().enumerate() {
            self.chunks.insert(
                (row, range.start),
                Chunk {
                    summary: summary.clone(),
                    end: range.end,
                    first: i == 0,
                },
            );
        }
    }

    pub(super) fn get(&self, row: usize, start: usize) -> Option<&Chunk> {
        self.chunks.get(&(row, start))
    }

    pub(super) fn awaiting(&self, message: &str, call: &str) -> bool {
        self.waiting
            .get(message)
            .is_some_and(|calls| calls.contains(call))
    }

    pub(super) fn collapsed_target(
        &self,
        s: &State,
        row: usize,
        part: usize,
    ) -> Option<(String, String)> {
        let (_, chunk) = self
            .chunks
            .iter()
            .find(|((owner, start), chunk)| *owner == row && *start <= part && part < chunk.end)?;
        (!chunk.expanded(s)).then(|| (chunk.summary.message.clone(), chunk.summary.key.clone()))
    }

    fn chunk_for_part_key(&self, s: &State, message: &str, key: &str) -> Option<&Chunk> {
        if let Some((_, chunk)) = self
            .chunks
            .iter()
            .find(|(_, chunk)| chunk.summary.message == message && chunk.summary.key == key)
        {
            return Some(chunk);
        }
        let rows = s.transcript_display.messages.visible(&s.messages);
        let (row, current) = rows.iter().enumerate().find(|(_, row)| row.id == message)?;
        let part = current.parts.iter().position(|part| match part {
            Part::Tool(tool) => {
                tools::visible(s, message, tool) && tools::tool_key(message, &tool.id) == key
            }
            Part::Reasoning(fragment) => {
                fragment.visible() && reasoning::block_key(message, fragment.ordinal) == key
            }
            _ => false,
        })?;
        self.chunks
            .iter()
            .find(|((owner, start), chunk)| *owner == row && *start <= part && part < chunk.end)
            .map(|(_, chunk)| chunk)
    }

    pub(super) fn collapsed_anchor(&self, s: &State, message: &str, key: &str) -> Option<String> {
        let chunk = self.chunk_for_part_key(s, message, key)?;
        (!chunk.expanded(s)).then(|| format!("{}/{}", chunk.summary.message, chunk.summary.key))
    }
}

fn waiting(s: &State, rows: &[Row]) -> HashMap<String, HashSet<String>> {
    let Some(agent) = &s.agent else {
        return HashMap::new();
    };
    let mut waiting: HashMap<String, HashSet<String>> = HashMap::new();
    for target in agent
        .permissions
        .iter()
        .filter_map(|req| req.tool.as_ref())
        .chain(agent.forms.iter().filter_map(|req| req.tool.as_ref()))
    {
        waiting
            .entry(target.message.clone())
            .or_default()
            .insert(target.call.clone());
    }
    if let Some((message, call)) = tools::inferred_websearch(s, rows) {
        waiting
            .entry(message.into())
            .or_default()
            .insert(call.into());
    }
    waiting
}

impl Chunk {
    fn expanded(&self, s: &State) -> bool {
        if self.summary.search_hit {
            let search_id = s
                .transcript_display
                .search_highlight
                .as_ref()
                .map_or(0, |hit| hit.id);
            return !s
                .transcript_display
                .group_search_collapsed(search_id, &self.summary.keys);
        }
        let default_row = match self.summary.kind {
            Kind::Reasoning => TranscriptRow::Thinking,
            Kind::Exploration | Kind::Shell => TranscriptRow::Groups,
        };
        let default = transcript_mode(s, default_row) == "expanded";
        s.transcript_display
            .group_expanded(&self.summary.keys)
            .unwrap_or(default)
    }

    pub(super) fn view<'a>(
        &self,
        s: &State,
        message: &'a str,
        message_completed: bool,
        parts: &[Part],
        start: usize,
        marker: &mut impl FnMut(Option<usize>) -> Option<codenomad_client::timeline::Marker<'a>>,
    ) -> Option<El> {
        let summary = &self.summary;
        let expanded = self.expanded(s);
        let search_id = summary
            .search_hit
            .then(|| {
                s.transcript_display
                    .search_highlight
                    .as_ref()
                    .map(|hit| hit.id)
            })
            .flatten();
        if summary.kind == Kind::Reasoning {
            return reasoning::view_chunk(
                s,
                message,
                parts,
                start,
                reasoning::GroupView {
                    key: &summary.key,
                    keys: &summary.keys,
                    count: summary.count,
                    duration_ms: summary.duration_ms,
                    title: summary.title.as_deref(),
                    completed: summary.completed,
                    message_completed,
                    expanded,
                    search_id,
                    first: self.first,
                },
                marker,
            );
        }
        let key = &summary.key;
        if !self.first && !expanded {
            return None;
        }
        let header = self.first.then(|| {
            let toggle = summary.keys.clone();
            transcript::group_header(
                format!("toggle-{key}"),
                &summary.label(),
                None,
                Vec::new(),
                expanded,
                false,
                screen::action(&s.input_scope, move |s| {
                    if let Some(id) = search_id {
                        Display::set_group_search_collapsed(s, id, &toggle, expanded);
                    } else {
                        Display::set_group_expanded(s, &toggle, !expanded);
                    }
                }),
            )
        });
        let mut body = col().full_width().separate(Space::Sm).children(header);
        if expanded {
            body = body.children(parts.iter().enumerate().filter_map(
                |(offset, part)| match part {
                    Part::Tool(tool) if tools::visible(s, message, tool) => {
                        Some(super::reading::passage(
                            s,
                            tools::view(s, message, tool),
                            message,
                            tools::tool_key(message, &tool.id),
                            Some(TranscriptRow::tool(&tool.name)),
                            marker(Some(start + offset)),
                        ))
                    }
                    _ => None,
                },
            ));
        }
        if self.first {
            body = super::reading::passage(
                s,
                body,
                message,
                key.clone(),
                Some(TranscriptRow::Groups),
                (!expanded).then(|| marker(Some(start))).flatten(),
            );
        }
        Some(body)
    }
}

impl Summary {
    fn label(&self) -> String {
        if self.kind == Kind::Shell {
            return catalogue::format(
                locale(),
                if self.completed {
                    "messageBlock.shell.completed"
                } else {
                    "messageBlock.shell.active"
                },
                &[("count", &self.count.to_string())],
            );
        }
        let details = [("read", self.reads), ("search", self.count - self.reads)]
            .into_iter()
            .filter(|(_, count)| *count > 0)
            .map(|(name, count)| {
                catalogue::format(
                    locale(),
                    &format!(
                        "messageBlock.exploration.{name}.{}",
                        if count == 1 { "one" } else { "other" }
                    ),
                    &[("count", &count.to_string())],
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        catalogue::format(
            locale(),
            if self.completed {
                "messageBlock.exploration.completed"
            } else {
                "messageBlock.exploration.active"
            },
            &[("tools", &details)],
        )
    }
}

#[cfg(test)]
#[test]
fn a_pending_tool_stays_out_of_both_collapsed_group_kinds() {
    use serde_json::json;
    crate::platform::block_on(async {
        let mut s = crate::init();
        crate::settings::fixture_transcript(&mut s, json!({"toolGroupVisibility":"collapsed"}));
        let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        let mut agent = crate::agent::Ui::new(crate::agent::start(backend, s.wake.clone()));
        agent.permissions = crate::agent_api::permissions(
            &json!({"data":[{
                "id":"permission","sessionID":"session","action":"read","resources":[],
                "source":{"type":"tool","id":"pending","messageID":"step"}
            }]}),
            "session",
        )
        .unwrap();
        s.agent = Some(agent);
        for name in ["bash", "read"] {
            let content = ["a", "b", "pending", "c", "d"].map(|id| {
                json!({"type":"tool","id":id,"name":name,"state":{"status":"completed","input":{}}})
            });
            let row: Row = crate::history::decode_message(
                &json!({"id":"step","type":"assistant","content":content}),
            )
            .unwrap()
            .into();
            let groups = Groups::project_with_steps(&s, std::slice::from_ref(&row), true, None);
            assert_eq!(
                groups
                    .collapsed_target(&s, 0, 0)
                    .as_ref()
                    .map(|(_, k)| k.as_str()),
                Some("group-tool-step:1:a")
            );
            assert!(groups.collapsed_target(&s, 0, 2).is_none());
            assert_eq!(
                groups
                    .collapsed_target(&s, 0, 4)
                    .as_ref()
                    .map(|(_, k)| k.as_str()),
                Some("group-tool-step:1:c")
            );
        }
    });
}

#[cfg(test)]
#[test]
fn a_hidden_message_with_parts_gap_splits_adjacent_groups() {
    use serde_json::json;
    let mut s = crate::init();
    crate::settings::fixture_transcript(
        &mut s,
        json!({
            "toolGroupVisibility": "collapsed",
            "toolCallExpansionDefaults": {"tools": {"grep": "hidden"}}
        }),
    );
    let hidden_parts: Vec<_> = (0..(super::transcript::PART_LIMIT + 10))
        .map(|i| json!({"type":"tool","id":format!("g{i}"),"name":"grep","state":{"status":"completed","input":{}}}))
        .collect();
    let rows: Vec<Row> = [
        json!({"id":"m0","type":"assistant","content":[
            {"type":"tool","id":"r0","name":"read","state":{"status":"completed","input":{}}}
        ]}),
        json!({"id":"m1","type":"assistant","content":hidden_parts}),
        json!({"id":"m2","type":"assistant","content":[
            {"type":"tool","id":"r1","name":"read","state":{"status":"completed","input":{}}}
        ]}),
    ]
    .into_iter()
    .map(|value| crate::history::decode_message(&value).unwrap().into())
    .collect();

    let groups = Groups::project_with_steps(&s, &rows, true, None);
    assert!(
        groups.collapsed_target(&s, 0, 0).is_none(),
        "visible parts-gap in m1 must break grouping between m0 and m2"
    );
    assert!(
        groups.collapsed_target(&s, 2, 0).is_none(),
        "visible parts-gap in m1 must prevent m2 from continuing m0's group"
    );

    // Positive control: once all hidden parts in m1 are revealed (head >= tail), the gap disappears
    // and the hidden-only message becomes transparent so m0 and m2 group together.
    let revealed = Groups::project_with_steps(&s, &rows, true, Some((1, 1)));
    assert_eq!(
        revealed
            .collapsed_target(&s, 2, 0)
            .as_ref()
            .map(|(m, k)| (m.as_str(), k.as_str())),
        Some(("m0", "group-tool-m0:2:r0"))
    );
}
