use super::{Marker, MarkerKind, owner};
use crate::{
    State,
    agent_api::ToolSource,
    content::Part,
    settings::{self, TranscriptRow},
};
use codenomad_client::timeline;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub(super) fn pending(s: &State) -> BTreeSet<ToolSource> {
    let Some(agent) = &s.agent else {
        return BTreeSet::new();
    };
    agent
        .permissions
        .iter()
        .filter_map(|r| r.tool.as_ref())
        .chain(agent.forms.iter().filter_map(|r| r.tool.as_ref()))
        .cloned()
        .collect()
}

pub(super) fn project(
    s: &State,
    markers: Vec<timeline::Marker<'_>>,
) -> (Vec<Marker>, HashMap<String, String>) {
    let mut modes = BTreeMap::new();
    let mut visible = Vec::<Marker>::new();
    let mut folded = HashMap::new();
    let mut requested: HashMap<&str, HashSet<&str>> = HashMap::new();
    for tool in &s.transcript_display.timeline.pending {
        requested
            .entry(&tool.message)
            .or_default()
            .insert(&tool.call);
    }
    let mut keep = HashSet::new();
    for row in &s.messages {
        if let Some(calls) = requested.get(row.id.as_str()) {
            for (ordinal, call) in row
                .parts
                .iter()
                .filter_map(|part| match part {
                    Part::Tool(call) => Some(call),
                    _ => None,
                })
                .enumerate()
            {
                if calls.contains(call.id.as_str()) {
                    keep.insert((row.id.as_str(), ordinal as u64));
                }
            }
        }
    }
    let mut message = None;
    let mut run = None;
    for marker in markers {
        if message != Some(marker.message) || marker.omitted_before {
            message = Some(marker.message);
            run = None;
        }
        let row = match marker.kind {
            MarkerKind::Reasoning => Some(TranscriptRow::Thinking),
            MarkerKind::System => Some(TranscriptRow::System),
            MarkerKind::Tool => Some(TranscriptRow::tool(marker.tool_name.unwrap_or_default())),
            _ => None,
        };
        let hidden = row.is_some_and(|row| {
            !*modes
                .entry(row)
                .or_insert_with(|| settings::transcript_mode(s, row) != "hidden")
        });
        if hidden
            && marker.kind == MarkerKind::Tool
            && !keep.contains(&(marker.message, marker.ordinal))
        {
            continue;
        }
        let kind = marker.kind;
        let row = matches!(kind, MarkerKind::Assistant | MarkerKind::Reasoning);
        if row && run == Some(kind) {
            if !hidden && let Some(first) = visible.last() {
                folded.insert(Marker::from(marker).id, first.id.clone());
            }
            continue;
        }
        run = row.then_some(kind);
        if !hidden || kind == MarkerKind::Tool {
            visible.push(Marker::from(marker));
        }
    }
    (visible, folded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn marker(kind: MarkerKind, ordinal: u64) -> timeline::Marker<'static> {
        timeline::Marker {
            message: "step",
            kind,
            ordinal,
            continued: false,
            omitted_before: false,
            tool_name: (kind == MarkerKind::Tool).then_some("read"),
        }
    }

    #[test]
    fn only_hidden_tools_leave_the_run_and_omissions_still_split_it() {
        use MarkerKind::{Assistant, Reasoning, System, Tool};
        let mut s = crate::init();
        settings::fixture_transcript(
            &mut s,
            json!({
                "showThinkingBlocks":false, "systemMessagesVisibility":"hidden",
                "toolCallExpansionDefaults":{"tools":{"read":"hidden"}}
            }),
        );
        let last = timeline::Marker {
            omitted_before: true,
            ..marker(Assistant, 4)
        };
        let items = vec![
            marker(Assistant, 0),
            marker(Tool, 0),
            marker(Assistant, 1),
            marker(Reasoning, 0),
            marker(Assistant, 2),
            marker(System, 0),
            marker(Assistant, 3),
            marker(Tool, 1),
            last,
        ];
        let (visible, folded) = project(&s, items);
        assert_eq!(
            visible.iter().map(|m| m.ordinal).collect::<Vec<_>>(),
            [0, 2, 3, 4]
        );
        assert_eq!(
            folded,
            HashMap::from([(
                "step:Assistant:1:false".into(),
                "step:Assistant:0:false".into()
            )])
        );
    }

    #[test]
    fn pending_tool_source_keeps_only_the_matching_native_call() {
        use MarkerKind::Tool;
        let mut s = crate::init();
        settings::fixture_transcript(
            &mut s,
            json!({"toolCallExpansionDefaults":{"tools":{"read":"hidden"}}}),
        );
        s.messages.push(crate::history::decode_message(&json!({
            "id":"step","type":"assistant","content":[
                {"type":"tool","id":"hidden","name":"read","state":{"status":"completed","input":{}}},
                {"type":"tool","id":"pending","name":"read","state":{"status":"running","input":{}}}
            ]
        })).unwrap().into());
        let native = json!({"data":[{"id":"form","sessionID":"session","title":"Question",
            "fields":[{"key":"answer","type":"string"}],
            "source":{"type":"tool","id":"pending","messageID":"step"}}]});
        let request = crate::agent_api::forms(&native, "session")
            .unwrap()
            .pop()
            .unwrap();
        owner(&mut s).pending.extend(request.tool);
        let (visible, _) = project(&s, vec![marker(Tool, 0), marker(Tool, 1)]);
        assert_eq!(visible.iter().map(|m| m.ordinal).collect::<Vec<_>>(), [1]);
    }
}

pub(super) fn reselect(s: &mut State) {
    let t = owner(s);
    if let Some(active) = &mut t.jump.active {
        if let Some(first) = t.folded.get(active) {
            active.clone_from(first);
        } else if !t.markers.iter().any(|marker| &marker.id == active) {
            t.jump.active = None;
            t.jump.unlock();
        }
    }
}
