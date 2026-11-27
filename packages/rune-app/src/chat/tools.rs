use super::{
    actions::Display,
    document::{TOOL_LIMIT, window},
    tool_diff,
};
use crate::{
    State,
    content::{Part, Tool},
    history::Row,
    settings::{self, TranscriptRow},
};

mod apply_patch;
pub(crate) mod children;
mod clipboard;
mod diagnostics;
pub(super) mod duration;
mod edit;
mod execute;
mod format;
mod question;
mod read;
mod render;
mod search;
mod shell;
pub(super) mod task;
mod todo;
mod write;

use format::{bounded_json, error, input_json, output, string};
pub(super) use render::{match_hidden_by_inputs, view};

pub(super) fn visible(s: &State, message: &str, tool: &Tool) -> bool {
    settings::transcript_mode(s, TranscriptRow::tool(&tool.name)) != "hidden"
        || awaiting_input(s, message, tool)
}

pub(crate) fn inferred_websearch<'a>(s: &State, rows: &'a [Row]) -> Option<(&'a str, &'a str)> {
    let agent = s.agent.as_ref()?;
    if !agent
        .forms
        .iter()
        .any(|form| form.tool.is_none() && form.infer_websearch)
    {
        return None;
    }
    rows.iter().rev().find_map(|message| {
        message.parts.iter().rev().find_map(|part| match part {
            Part::Tool(tool) if tool.name == "websearch" => {
                Some((message.id.as_str(), tool.id.as_str()))
            }
            _ => None,
        })
    })
}

pub(super) fn visible_in_rows(s: &State, rows: &[Row], message: &str, tool: &Tool) -> bool {
    visible(s, message, tool) || inferred_websearch(s, rows) == Some((message, tool.id.as_str()))
}

pub(super) fn awaiting_input(s: &State, message: &str, tool: &Tool) -> bool {
    s.agent.as_ref().is_some_and(|agent| {
        agent
            .permissions
            .iter()
            .filter_map(|request| request.tool.as_ref())
            .chain(
                agent
                    .forms
                    .iter()
                    .filter_map(|request| request.tool.as_ref()),
            )
            .any(|source| source.message == message && source.call == tool.id)
    })
}

pub(crate) fn tool_key(message: &str, call: &str) -> String {
    let escaped = call.replace('%', "%25").replace('/', "%2F");
    format!("tool-{message}:{}:{escaped}", escaped.len())
}
