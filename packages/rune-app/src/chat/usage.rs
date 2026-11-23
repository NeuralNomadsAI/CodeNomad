use crate::{Message, State, content::{Part, Usage}, screen, strings::t};
use rune::{El, col};
use rune_theme_codenomad::{Space, layout::{self, Layout}, usage as theme};

fn has_reply(row: &Message) -> bool {
    !row.body.trim().is_empty() || row.parts.iter().any(|part| matches!(part, Part::File(_)))
}

fn response_total(s: &State, index: usize) -> Option<Usage> {
    let row = s.messages.get(index)?;
    if row.role != "assistant" || !has_reply(row) {
        return None;
    }
    let mut usage = row.usage?;
    for prior in s.messages[..index].iter().rev() {
        if matches!(prior.parts.as_slice(), [Part::SubagentReport(_)]) {
            continue;
        }
        if prior.role != "assistant" || has_reply(prior) {
            break;
        }
        if let Some(previous) = prior.usage {
            usage = usage.plus(previous);
        }
    }
    Some(usage)
}

pub(super) fn message(s: &State, index: usize) -> Option<El> {
    let usage = response_total(s, index)?;
    let key = format!("message-usage-{}", s.messages[index].id);
    Some(disclosure(s, key, usage, false))
}

pub(crate) fn session(s: &State) -> Option<El> {
    let usage = s.agent.as_ref()?.usage?;
    Some(disclosure(s, "status-usage".into(), usage, true))
}

fn disclosure(s: &State, key: String, usage: Usage, session: bool) -> El {
    let expanded = s.transcript_display.toggled(&key);
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
    entries.push((t(if session { "contextUsagePanel.labels.cost" } else { "messageBlock.usage.cost" }), cost.clone(), cost));
    let label = t(if expanded { "messageBlock.usage.collapseAriaLabel" } else { "messageBlock.usage.expandAriaLabel" });
    let title = if session { t("instanceShell.rightPanel.sections.tokens") } else { label };
    let detail = entries.iter().map(|(label, _, full)| format!("{label}: {full}")).collect::<Vec<_>>().join(", ");
    col().key(key.clone()).full_width().separate(Space::Xs)
        .child(layout::button(title, false, screen::action(&s.input_scope, move |s| {
            super::actions::Display::toggle(s, &toggle);
        })).key(format!("toggle-{key}")).label(format!("{label}. {detail}")).expanded(expanded))
        .child(theme::metrics(expanded, entries.into_iter().map(|(label, value, full)| theme::metric(label, &value, &full))))
}

fn token(kind: &str, count: u64, session: bool) -> (&'static str, String, String) {
    let prefix = if session && kind != "reasoning" { "contextUsagePanel.labels" } else { "messageBlock.usage" };
    let label = t(&format!("{prefix}.{kind}"));
    let compact = match count {
        1_000_000_000.. => format!("{:.1}B", count as f64 / 1e9),
        1_000_000.. => format!("{:.1}M", count as f64 / 1e6),
        1_000.. => format!("{}K", count.saturating_add(500) / 1000),
        _ => count.to_string(),
    };
    (label, compact, count.to_string())
}
