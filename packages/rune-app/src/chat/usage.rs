use crate::{
    Message, State,
    content::{Part, Usage},
    screen,
    strings::t,
};
use rune::El;
use rune_theme_codenomad::usage as theme;

fn text_part(part: &Part) -> bool {
    matches!(part, Part::Text(text) if !text.text.trim().is_empty())
}

fn boundary(part: &Part) -> bool {
    text_part(part) || matches!(part, Part::File(_))
}

pub(super) fn last_text(row: &Message) -> Option<usize> {
    (row.role == "assistant" && row.usage.is_some())
        .then(|| row.parts.iter().rposition(text_part))
        .flatten()
}

fn response_total(s: &State, index: usize, final_text: usize) -> Option<Usage> {
    let row = s.messages.get(index)?;
    let mut usage = row.usage?;
    for (i, row) in s.messages[..=index].iter().enumerate().rev() {
        if row.role == "user" {
            break;
        }
        let (head, tail) = super::transcript::part_window(
            row.parts.len(),
            s.transcript_display.steps(&format!("parts-gap-{}", row.id)),
        );
        let end = if i == index {
            final_text
        } else {
            row.parts.len()
        };
        let mut technical = false;
        let mut stop = false;
        for (at, part) in row.parts[..end].iter().enumerate().rev() {
            if (head..tail).contains(&at) || boundary(part) {
                stop = true;
                break;
            }
            technical |= matches!(part, Part::Tool(_) | Part::Reasoning(_));
        }
        if technical
            && i != index
            && let Some(previous) = row.usage
        {
            usage = usage.plus(previous);
        }
        if stop {
            break;
        }
    }
    Some(usage)
}

pub(super) fn message(s: &State, index: usize, final_text: usize) -> Option<El> {
    let visibility = crate::settings::message_usage_visibility(s);
    if visibility == "hidden" {
        return None;
    }
    let usage = response_total(s, index, final_text)?;
    let key = format!("message-usage-{}", s.messages[index].id);
    Some(disclosure(s, key, usage, false, visibility == "expanded"))
}

pub(crate) fn session(s: &State) -> Option<El> {
    let usage = s.agent.as_ref()?.usage?;
    Some(disclosure(s, "status-usage".into(), usage, true, false))
}

fn disclosure(s: &State, key: String, usage: Usage, session: bool, open: bool) -> El {
    let expanded = open ^ s.transcript_display.toggled(&key);
    let toggle = key.clone();
    let mut entries = vec![
        token("input", usage.input, session),
        token("output", usage.output, session),
    ];
    if expanded {
        entries.push(token("reasoning", usage.reasoning, session));
        if !session {
            entries.push(token("cacheRead", usage.cache_read, false));
            entries.push(token("cacheWrite", usage.cache_write, false));
        }
    }
    let cost = if session || usage.cost == 0.0 || usage.cost >= 0.01 {
        format!("${:.2}", usage.cost)
    } else {
        let decimals = (1.0 - usage.cost.log10().floor()).clamp(2.0, 12.0) as usize;
        format!("${:.*}", decimals, usage.cost)
    };
    entries.push((
        t(if session {
            "contextUsagePanel.labels.cost"
        } else {
            "messageBlock.usage.cost"
        }),
        cost.clone(),
        cost,
    ));
    let label = t(if expanded {
        "messageBlock.usage.collapseAriaLabel"
    } else {
        "messageBlock.usage.expandAriaLabel"
    });
    let title = session.then(|| t("instanceShell.rightPanel.sections.tokens"));
    let detail = entries
        .iter()
        .map(|(label, _, full)| format!("{label}: {full}"))
        .collect::<Vec<_>>()
        .join(", ");
    theme::disclosure(
        &key,
        &format!("{label}. {detail}"),
        title,
        expanded,
        entries
            .into_iter()
            .map(|(label, value, full)| theme::metric(label, &value, &full)),
        screen::action(&s.input_scope, move |s| {
            super::actions::Display::toggle(s, &toggle)
        }),
    )
}

fn token(kind: &str, count: u64, session: bool) -> (&'static str, String, String) {
    let prefix = if session && kind != "reasoning" {
        "contextUsagePanel.labels"
    } else {
        "messageBlock.usage"
    };
    let label = t(&format!("{prefix}.{kind}"));
    let compact = match count {
        1_000_000_000.. => format!("{:.1}B", count as f64 / 1e9),
        1_000_000.. => format!("{:.1}M", count as f64 / 1e6),
        1_000.. => format!("{}K", count.saturating_add(500) / 1000),
        _ => count.to_string(),
    };
    (label, compact, count.to_string())
}

#[cfg(test)]
#[test]
fn token_line_counts_distinct_technical_rows_and_precedes_trailing_tools() {
    use crate::{Phase, history, init};
    use rune::{Env, Runtime};
    use serde_json::{Value, json};

    let row = |id: &str, input, content: Value| {
        history::decode_message(&json!({
            "id":id,"type":"assistant","time":{"completed":1},
            "tokens":{"input":input,"output":10,"reasoning":9,"cache":{"read":8,"write":7}},
            "cost":0.004, "content":content,
        }))
        .unwrap()
        .into()
    };
    let tech = json!({"type":"tool","id":"work","name":"read","state":{
        "status":"completed","input":{"filePath":"trailing.txt"}
    }});
    let prose = |text: &str| json!({"type":"text","text":text});
    let user = history::decode_message(&json!({"id":"user","type":"user","text":"Ask"})).unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![
        row("old", 1000, json!([tech])),
        user.into(),
        row(
            "prior",
            20,
            json!([tech,{"type":"reasoning","text":"Thinking"}]),
        ),
        row("answer", 50, json!([prose("Answer text"), tech])),
    ];
    let total = response_total(&state, 3, 0).unwrap();
    assert_eq!((total.input, total.cache_read), (70, 16));
    assert_eq!(total.cost, 0.008);
    assert!(
        message(&state, 3, 0).is_none(),
        "default visibility is hidden"
    );

    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    rt.update(|s, _| crate::settings::fixture_message_usage(s, "collapsed"));
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    let usage = tree.find("Input: 70").expect("collapsed usage");
    assert!(
        tree.find("Answer text").unwrap() < usage && usage < tree.rfind("trailing.txt").unwrap()
    );
    assert!(!tree.contains("Reasoning: 18"));
    let (x, y) = rt.find("toggle-message-usage-answer").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Reasoning: 18")
    );
}
